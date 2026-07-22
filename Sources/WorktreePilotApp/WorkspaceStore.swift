import AppKit
import Foundation
import SwiftUI
import WorkbenchCore

@MainActor
final class WorkspaceStore: ObservableObject {
  @Published var snapshot = WorkspaceSnapshot(repositories: [])
  @Published var roots: [String]
  @Published var selection: String?
  @Published var isRefreshing = false
  @Published var isWorking = false
  @Published var errorMessage: String?
  @Published var changes = ""
  @Published var pendingPlan: GitWorkflowPlan?
  @Published var githubAuthStatus: GitHubAuthenticationStatus?
  @Published var isGitHubLoginInProgress = false

  private let workspace = WorkspaceService()
  private let git = GitClient()
  private let ai = AIService()
  private let workflow = GitWorkflowService()
  private let githubAuth = GitHubAuthService()
  private let defaultsKey = "repositoryRoots"
  private var githubLoginPollingTask: Task<Void, Never>?

  init() {
    if let stored = UserDefaults.standard.stringArray(forKey: defaultsKey), !stored.isEmpty {
      roots = stored
    } else {
      let home = FileManager.default.homeDirectoryForCurrentUser
      let candidates = [
        home.appendingPathComponent("01_Local_Workspace").path,
        home.appendingPathComponent("Developer").path,
        home.appendingPathComponent("Projects").path,
      ]
      roots = candidates.filter { FileManager.default.fileExists(atPath: $0) }
    }
  }

  var selectedWorktree: WorktreeSnapshot? {
    guard let selection else { return nil }
    return snapshot.worktrees.first { $0.path == selection }
  }

  func refresh() async {
    guard !isRefreshing else { return }
    isRefreshing = true
    let updated = await workspace.refresh(roots: roots)
    snapshot = updated
    if selection == nil || !updated.worktrees.contains(where: { $0.path == selection }) {
      selection = updated.worktrees.first?.path
    }
    isRefreshing = false
    await loadChanges()
  }

  func refreshGitHubAuth() async {
    githubAuthStatus = await githubAuth.status()
  }

  func beginGitHubBrowserLogin() {
    githubLoginPollingTask?.cancel()
    do {
      let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask
      ).first!.appendingPathComponent("WorktreePilot", isDirectory: true)
      let commandURL = try githubAuth.createBrowserLoginCommand(in: applicationSupport)
      guard NSWorkspace.shared.open(commandURL) else {
        errorMessage = "Could not open the GitHub login in Terminal."
        return
      }
      isGitHubLoginInProgress = true
      githubLoginPollingTask = Task { [weak self] in
        guard let self else { return }
        for _ in 0..<120 {
          if Task.isCancelled { return }
          try? await Task.sleep(for: .seconds(2))
          await refreshGitHubAuth()
          if case .authenticated = githubAuthStatus {
            isGitHubLoginInProgress = false
            await refresh()
            return
          }
        }
        isGitHubLoginInProgress = false
      }
    } catch {
      errorMessage = "Could not prepare GitHub login: \(error.localizedDescription)"
    }
  }

  func chooseAndAddRoot() {
    let panel = NSOpenPanel()
    panel.title = "Choose a repository or a folder containing repositories"
    panel.prompt = "Add Root"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = true
    guard panel.runModal() == .OK else { return }
    for url in panel.urls where !roots.contains(url.path) { roots.append(url.path) }
    roots.sort()
    UserDefaults.standard.set(roots, forKey: defaultsKey)
    Task { await refresh() }
  }

  func removeRoot(_ root: String) {
    roots.removeAll { $0 == root }
    UserDefaults.standard.set(roots, forKey: defaultsKey)
    Task { await refresh() }
  }

  func loadChanges() async {
    guard let worktree = selectedWorktree else {
      changes = ""
      return
    }
    let requestedPath = worktree.path
    do {
      async let status = git.shortStatus(worktreePath: worktree.path)
      async let diff = git.diff(worktreePath: worktree.path)
      async let staged = git.diff(worktreePath: worktree.path, staged: true)
      async let untracked = git.untrackedFileContents(worktreePath: worktree.path)
      let loadedChanges =
        "Status\n\(try await status)\n\nStaged diff\n\(try await staged)\n\nUnstaged diff\n\(try await diff)\n\nUntracked files\n\(try await untracked)"
      guard selection == requestedPath else { return }
      changes = loadedChanges
    } catch {
      guard selection == requestedPath else { return }
      errorMessage = error.localizedDescription
    }
  }

  func generateCommitMessage() async -> String? {
    guard let worktree = selectedWorktree else { return nil }
    return await performAI {
      let context = try await ai.commitMessageContext(worktreePath: worktree.path)
      guard confirmAIContext(context, title: "Send commit context to Codex?") else { return "" }
      return try await ai.generateCommitMessage(worktreePath: worktree.path, context: context)
    }.flatMap { $0.isEmpty ? nil : $0 }
  }

  func generatePullRequestBody(base: String) async -> String? {
    guard let worktree = selectedWorktree else { return nil }
    return await performAI {
      let context = try await ai.pullRequestContext(worktreePath: worktree.path, base: base)
      guard confirmAIContext(context, title: "Send pull-request context to Codex?") else {
        return ""
      }
      return try await ai.generatePullRequestDraft(worktreePath: worktree.path, context: context)
    }.flatMap { $0.isEmpty ? nil : $0 }
  }

  func prepareCommit(message: String, stageAll: Bool, push: Bool) {
    guard let worktree = selectedWorktree else { return }
    guard !push || worktree.git.branch != "(detached)" else {
      errorMessage = "A detached HEAD cannot be pushed without choosing a branch."
      return
    }
    pendingPlan = workflow.commitAndPushPlan(
      worktreePath: worktree.path,
      message: message,
      stageAll: stageAll,
      push: push,
      setUpstreamFor: push && worktree.git.upstream == nil ? worktree.git.branch : nil
    )
  }

  func preparePush() {
    guard let worktree = selectedWorktree else { return }
    guard worktree.git.branch != "(detached)" else {
      errorMessage = "A detached HEAD cannot be pushed without choosing a branch."
      return
    }
    let branch = worktree.git.upstream == nil ? worktree.git.branch : nil
    pendingPlan = workflow.pushPlan(worktreePath: worktree.path, setUpstreamFor: branch)
  }

  func preparePullRequest(title: String, body: String, base: String, draft: Bool) {
    guard let worktree = selectedWorktree else { return }
    guard worktree.git.branch != "(detached)" else {
      errorMessage = "Create a branch before opening a pull request."
      return
    }
    pendingPlan = workflow.pullRequestPlan(
      worktreePath: worktree.path,
      title: title,
      body: body,
      base: base,
      draft: draft,
      pushFirst: worktree.git.upstream == nil || worktree.git.ahead > 0,
      branch: worktree.git.upstream == nil ? worktree.git.branch : nil
    )
  }

  func executePendingPlan() async {
    guard let pendingPlan else { return }
    isWorking = true
    defer { isWorking = false }
    do {
      _ = try await workflow.execute(pendingPlan, confirmed: true)
      self.pendingPlan = nil
      await refresh()
    } catch {
      self.pendingPlan = nil
      await refresh()
      errorMessage = error.localizedDescription
    }
  }

  func openInBrowser(_ value: String) {
    guard let url = URL(string: value) else { return }
    NSWorkspace.shared.open(url)
  }

  func openInFinder(_ path: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }

  func openTerminal(_ path: String) {
    Task {
      _ = try? await LocalCommandRunner().run(
        CommandRequest(
          executable: "open",
          arguments: ["-a", "Terminal", path]
        ))
    }
  }

  private func performAI(_ operation: () async throws -> String) async -> String? {
    guard !isWorking else { return nil }
    isWorking = true
    defer { isWorking = false }
    do {
      return try await operation()
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  private func confirmAIContext(_ context: String, title: String) -> Bool {
    let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    textView.string = context
    textView.isEditable = false
    textView.isSelectable = true
    textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    let scrollView = NSScrollView(frame: textView.frame)
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.documentView = textView

    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText =
      "Review the exact sanitized context below. Nothing is sent unless you confirm."
    alert.accessoryView = scrollView
    alert.addButton(withTitle: "Send to Codex")
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }
}
