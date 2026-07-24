import AppKit
import Foundation
import SwiftUI
import WorkbenchCore

@MainActor
final class WorkspaceStore: ObservableObject {
  @Published var snapshot = WorkspaceOverview(repositories: [])
  @Published var roots: [String]
  @Published var selection: WorkspaceID?
  @Published var inspectorTab: InspectorTab = .overview
  @Published var isRefreshing = false
  @Published var isWorking = false
  @Published var errorMessage: String?
  @Published var changes = ""
  @Published var pendingPlan: GitWorkflowPlan?
  @Published var githubAuthStatus: GitHubAuthenticationStatus?
  @Published var isGitHubLoginInProgress = false

  private let workspace: WorkspaceService
  private let registry: WorkspaceRegistry
  private let git = GitClient()
  private let ai = AIService()
  private let workflow = GitWorkflowService()
  private let githubAuth = GitHubAuthService()
  private let defaultsKey = "repositoryRoots"
  private var githubLoginPollingTask: Task<Void, Never>?
  private var pendingEnvironmentCreation: PendingEnvironmentCreation?
  private var refreshAgain = false
  private var refreshWaiters: [CheckedContinuation<Void, Never>] = []

  init() {
    let applicationSupport = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first!.appendingPathComponent("Silvic", isDirectory: true)
    let registry = WorkspaceRegistry(
      fileURL: applicationSupport.appendingPathComponent("workspaces.json")
    )
    self.registry = registry
    workspace = WorkspaceService(registry: registry)
    let stored =
      UserDefaults.standard.stringArray(forKey: defaultsKey)
      ?? UserDefaults(suiteName: "de.josuasievers.branchdeck")?.stringArray(
        forKey: defaultsKey)
      ?? UserDefaults(suiteName: "de.josuasievers.worktreepilot")?.stringArray(
        forKey: defaultsKey)
    if let stored, !stored.isEmpty {
      roots = stored
      UserDefaults.standard.set(stored, forKey: defaultsKey)
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

  var selectedWorkspace: WorkspaceSnapshot? {
    guard let selection else { return nil }
    return snapshot.workspaces.first { $0.id == selection }
  }

  func selectWorkspace(_ workspace: WorkspaceSnapshot) {
    if selection != workspace.id {
      inspectorTab = .overview
    }
    selection = workspace.id
  }

  func performPrimaryAction(for workspace: WorkspaceSnapshot) {
    let wasSelected = selection == workspace.id
    selection = workspace.id
    switch workspace.operationalSummary.action {
    case .inspect, .reviewChanges:
      inspectorTab = .changes
      if wasSelected {
        Task { await loadChanges() }
      }
    case .openRuntime:
      if let url = workspace.runtimes.first(where: { $0.isActive && $0.url != nil })?.url {
        openInBrowser(url)
      } else {
        openTerminal(workspace.path)
      }
    case .reviewStatus:
      inspectorTab = .ship
    case .push:
      inspectorTab = .ship
      preparePush()
    case .openPullRequest:
      if let url = workspace.pullRequest?.url {
        openInBrowser(url)
      }
    case .resume:
      openTerminal(workspace.path)
    }
  }

  func refresh() async {
    if isRefreshing {
      refreshAgain = true
      await withCheckedContinuation { continuation in
        refreshWaiters.append(continuation)
      }
      return
    }
    isRefreshing = true
    repeat {
      refreshAgain = false
      let updated = await workspace.refresh(roots: roots)
      snapshot = updated
      if selection == nil || !updated.workspaces.contains(where: { $0.id == selection }) {
        selection = updated.workspaces.first?.id
      }
    } while refreshAgain
    isRefreshing = false
    await loadChanges()
    let waiters = refreshWaiters
    refreshWaiters.removeAll()
    waiters.forEach { $0.resume() }
  }

  func refreshGitHubAuth() async {
    githubAuthStatus = await githubAuth.status()
  }

  func beginGitHubBrowserLogin() {
    githubLoginPollingTask?.cancel()
    do {
      let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask
      ).first!.appendingPathComponent("Silvic", isDirectory: true)
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

  func cancelGitHubLoginWait() {
    githubLoginPollingTask?.cancel()
    githubLoginPollingTask = nil
    isGitHubLoginInProgress = false
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
    guard let workspace = selectedWorkspace else {
      changes = ""
      return
    }
    let requestedID = workspace.id
    do {
      async let status = git.shortStatus(worktreePath: workspace.path)
      async let diff = git.diff(worktreePath: workspace.path)
      async let staged = git.diff(worktreePath: workspace.path, staged: true)
      async let untracked = git.untrackedFileContents(worktreePath: workspace.path)
      let loadedChanges =
        "Status\n\(try await status)\n\nStaged diff\n\(try await staged)\n\nUnstaged diff\n\(try await diff)\n\nUntracked files\n\(try await untracked)"
      guard selection == requestedID else { return }
      changes = loadedChanges
    } catch {
      guard selection == requestedID else { return }
      errorMessage = error.localizedDescription
    }
  }

  func generateCommitMessage() async -> String? {
    guard let workspace = selectedWorkspace else { return nil }
    return await performAI {
      let context = try await ai.commitMessageContext(worktreePath: workspace.path)
      guard confirmAIContext(context, title: "Send commit context to Codex?") else { return "" }
      return try await ai.generateCommitMessage(worktreePath: workspace.path, context: context)
    }.flatMap { $0.isEmpty ? nil : $0 }
  }

  func generatePullRequestBody(base: String) async -> String? {
    guard let workspace = selectedWorkspace else { return nil }
    return await performAI {
      let context = try await ai.pullRequestContext(worktreePath: workspace.path, base: base)
      guard confirmAIContext(context, title: "Send pull-request context to Codex?") else {
        return ""
      }
      return try await ai.generatePullRequestDraft(worktreePath: workspace.path, context: context)
    }.flatMap { $0.isEmpty ? nil : $0 }
  }

  func prepareCommit(message: String, stageAll: Bool, push: Bool) {
    pendingEnvironmentCreation = nil
    guard let workspace = selectedWorkspace else { return }
    guard !push || workspace.git.branch != "(detached)" else {
      errorMessage = "A detached HEAD cannot be pushed without choosing a branch."
      return
    }
    pendingPlan = workflow.commitAndPushPlan(
      worktreePath: workspace.path,
      message: message,
      stageAll: stageAll,
      push: push,
      setUpstreamFor: push && workspace.git.upstream == nil ? workspace.git.branch : nil
    )
  }

  func preparePush() {
    pendingEnvironmentCreation = nil
    guard let workspace = selectedWorkspace else { return }
    guard workspace.git.branch != "(detached)" else {
      errorMessage = "A detached HEAD cannot be pushed without choosing a branch."
      return
    }
    let branch = workspace.git.upstream == nil ? workspace.git.branch : nil
    pendingPlan = workflow.pushPlan(worktreePath: workspace.path, setUpstreamFor: branch)
  }

  func preparePullRequest(title: String, body: String, base: String, draft: Bool) {
    pendingEnvironmentCreation = nil
    guard let workspace = selectedWorkspace else { return }
    guard workspace.git.branch != "(detached)" else {
      errorMessage = "Create a branch before opening a pull request."
      return
    }
    pendingPlan = workflow.pullRequestPlan(
      worktreePath: workspace.path,
      title: title,
      body: body,
      base: base,
      draft: draft,
      pushFirst: workspace.git.upstream == nil || workspace.git.ahead > 0,
      branch: workspace.git.upstream == nil ? workspace.git.branch : nil
    )
  }

  func executePendingPlan(expectedID: UUID) async {
    guard !isWorking, let pendingPlan, pendingPlan.id == expectedID else { return }
    let environmentCreation =
      pendingEnvironmentCreation?.planID == expectedID
      ? pendingEnvironmentCreation : nil
    self.pendingPlan = nil
    pendingEnvironmentCreation = nil
    isWorking = true
    defer { isWorking = false }
    do {
      _ = try await workflow.execute(pendingPlan, confirmed: true)
      if let environmentCreation {
        try await registry.upsertMetadata(
          atPath: environmentCreation.destinationPath,
          locationKind: environmentCreation.locationKind,
          repositoryRoot: environmentCreation.repositoryRoot,
          displayName: environmentCreation.displayName,
          purpose: environmentCreation.purpose,
          parentWorkspaceID: environmentCreation.parentWorkspaceID
        )
        if environmentCreation.locationKind == .gitCheckout {
          addManagedRootIfNeeded(environmentCreation.destinationPath)
        }
        await refresh()
        if let created = snapshot.workspaces.first(where: {
          WorkspaceLocation.normalize($0.path)
            == WorkspaceLocation.normalize(environmentCreation.destinationPath)
        }) {
          selectWorkspace(created)
        }
      } else {
        await refresh()
      }
    } catch {
      await refresh()
      errorMessage = error.localizedDescription
    }
  }

  func cancelPendingPlan(expectedID: UUID) {
    guard pendingPlan?.id == expectedID else { return }
    pendingEnvironmentCreation = nil
    pendingPlan = nil
  }

  func prepareEnvironmentCreation(
    in repository: RepositorySnapshot,
    from parent: WorkspaceSnapshot,
    displayName: String,
    purpose: String,
    branch: String,
    destinationPath: String,
    strategy: WorkspaceCreationStrategy
  ) async {
    let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedPurpose = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
    let expandedDestination = NSString(
      string: destinationPath.trimmingCharacters(in: .whitespacesAndNewlines)
    ).expandingTildeInPath
    let normalizedDestination = WorkspaceLocation.normalize(expandedDestination)
    guard !trimmedName.isEmpty else {
      errorMessage = "Give the task environment a name."
      return
    }
    guard GitReference.isValidBranchName(trimmedBranch) else {
      errorMessage = "Choose a valid Git branch name."
      return
    }
    guard parent.git.branch == "(detached)" || trimmedBranch != parent.git.branch else {
      errorMessage = "Choose a new branch name for this task environment."
      return
    }
    do {
      if try await git.localBranchExists(
        worktreePath: parent.path,
        branch: trimmedBranch
      ) {
        errorMessage = "That branch already exists in this Git repository."
        return
      }
    } catch {
      errorMessage = "Could not validate the branch: \(error.localizedDescription)"
      return
    }
    guard !FileManager.default.fileExists(atPath: normalizedDestination) else {
      errorMessage = "The destination already exists."
      return
    }
    let base =
      parent.git.branch == "(detached)"
      ? (parent.git.revision ?? "HEAD")
      : parent.git.branch
    let parentRepositoryRoot = parent.record.repositoryRoot ?? parent.path
    let plan: GitWorkflowPlan
    switch strategy {
    case .linkedWorktree:
      plan = workflow.createWorktreePlan(
        repositoryPath: parent.path,
        destinationPath: normalizedDestination,
        branch: trimmedBranch,
        base: base
      )
    case .independentClone:
      plan = workflow.createClonePlan(
        sourceRepositoryPath: parent.path,
        origin: repository.origin,
        destinationPath: normalizedDestination,
        branch: trimmedBranch,
        base: base
      )
    }
    pendingPlan = plan
    pendingEnvironmentCreation = PendingEnvironmentCreation(
      planID: plan.id,
      destinationPath: normalizedDestination,
      locationKind: strategy == .linkedWorktree ? .gitWorktree : .gitCheckout,
      repositoryRoot: strategy == .linkedWorktree ? parentRepositoryRoot : normalizedDestination,
      displayName: trimmedName,
      purpose: trimmedPurpose.isEmpty ? nil : trimmedPurpose,
      parentWorkspaceID: parent.id
    )
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

  func openInApplication(named applicationName: String, path: String) {
    Task {
      do {
        let result = try await LocalCommandRunner().run(
          CommandRequest(
            executable: "open",
            arguments: ["-a", applicationName, path]
          ))
        if result.exitCode != 0 {
          errorMessage = "\(applicationName) could not be opened."
        }
      } catch {
        errorMessage = "\(applicationName) could not be opened."
      }
    }
  }

  func openCommandLineHarness(_ harness: CommandLineHarness, path: String) {
    do {
      let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first!.appendingPathComponent("Silvic/Launchers", isDirectory: true)
      try FileManager.default.createDirectory(
        at: applicationSupport,
        withIntermediateDirectories: true
      )
      let launcher = applicationSupport.appendingPathComponent(
        "open-\(harness.rawValue)-\(UUID().uuidString).command"
      )
      let script = """
        #!/bin/zsh
        rm -- "$0"
        cd -- \(shellQuote(path)) || exit
        exec \(harness.executable)
        """
      try Data(script.utf8).write(to: launcher, options: .atomic)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o700],
        ofItemAtPath: launcher.path
      )
      guard NSWorkspace.shared.open(launcher) else {
        errorMessage = "\(harness.title) could not be opened."
        return
      }
    } catch {
      errorMessage = "\(harness.title) could not be opened."
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

  private func shellQuote(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
  }

  private func addManagedRootIfNeeded(_ path: String) {
    let normalizedPath = WorkspaceLocation.normalize(path)
    guard !roots.contains(where: { WorkspaceLocation.normalize($0) == normalizedPath }) else {
      return
    }
    roots.append(normalizedPath)
    roots.sort()
    UserDefaults.standard.set(roots, forKey: defaultsKey)
  }
}

private struct PendingEnvironmentCreation {
  let planID: UUID
  let destinationPath: String
  let locationKind: WorkspaceLocationKind
  let repositoryRoot: String
  let displayName: String
  let purpose: String?
  let parentWorkspaceID: WorkspaceID
}

enum CommandLineHarness: String {
  case claude
  case opencode

  var title: String {
    switch self {
    case .claude: "Claude Code"
    case .opencode: "OpenCode"
    }
  }

  var executable: String { rawValue }
}
