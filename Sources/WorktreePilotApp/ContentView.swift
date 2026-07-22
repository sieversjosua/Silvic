import AppKit
import SwiftUI
import WorkbenchCore

struct ContentView: View {
  @EnvironmentObject private var store: WorkspaceStore

  var body: some View {
    NavigationSplitView {
      List {
        Section("GitHub") {
          githubAuthentication
        }
        Section("Repository roots") {
          ForEach(store.roots, id: \.self) { root in
            Text(URL(fileURLWithPath: root).lastPathComponent)
              .help(root)
              .contextMenu {
                Button("Show in Finder") { store.openInFinder(root) }
                Divider()
                Button("Remove", role: .destructive) { store.removeRoot(root) }
              }
          }
          Button("Add Root…", systemImage: "plus") { store.chooseAndAddRoot() }
        }
      }
      .navigationSplitViewColumnWidth(min: 180, ideal: 220)
    } content: {
      worktreeList
        .navigationSplitViewColumnWidth(min: 360, ideal: 450)
    } detail: {
      if let worktree = store.selectedWorktree {
        WorktreeDetailView(worktree: worktree)
          .id(worktree.id)
      } else {
        ContentUnavailableView(
          "No Worktree Selected",
          systemImage: "arrow.triangle.branch",
          description: Text(
            store.roots.isEmpty
              ? "Add a repository root to begin."
              : "No Git worktrees were found in the selected roots.")
        )
      }
    }
    .toolbar {
      ToolbarItemGroup {
        if store.isRefreshing { ProgressView().controlSize(.small) }
        Button("Refresh", systemImage: "arrow.clockwise") {
          Task {
            await store.refreshGitHubAuth()
            await store.refresh()
          }
        }
        .disabled(store.isRefreshing)
      }
    }
    .sheet(item: $store.pendingPlan) { plan in
      PlanConfirmationView(plan: plan)
    }
    .alert(
      "WorktreePilot",
      isPresented: Binding(
        get: { store.errorMessage != nil },
        set: { if !$0 { store.errorMessage = nil } }
      )
    ) {
      Button("OK") { store.errorMessage = nil }
    } message: {
      Text(store.errorMessage ?? "Unknown error")
    }
  }

  @ViewBuilder private var githubAuthentication: some View {
    if store.isGitHubLoginInProgress {
      HStack {
        ProgressView().controlSize(.small)
        Text("Waiting for browser login…")
      }
      Button("Check again") { Task { await store.refreshGitHubAuth() } }
      Button("Stop waiting") { store.cancelGitHubLoginWait() }
    } else {
      switch store.githubAuthStatus {
      case .authenticated(let username):
        Label("@\(username)", systemImage: "checkmark.circle.fill")
          .foregroundStyle(.green)
        Button("Refresh account") { Task { await store.refreshGitHubAuth() } }
      case .unauthenticated(let message):
        Label("Not signed in", systemImage: "person.crop.circle.badge.xmark")
        Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(3)
        Button("Sign in with GitHub…") { store.beginGitHubBrowserLogin() }
      case .unavailable(let message):
        Label("GitHub CLI unavailable", systemImage: "exclamationmark.triangle")
          .foregroundStyle(.orange)
        Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(3)
      case nil:
        HStack {
          ProgressView().controlSize(.small)
          Text("Checking…")
        }
      }
    }
  }

  private var worktreeList: some View {
    List(selection: $store.selection) {
      ForEach(store.snapshot.repositories) { repository in
        Section {
          ForEach(repository.worktrees) { worktree in
            WorktreeRow(worktree: worktree)
              .tag(worktree.path)
          }
        } header: {
          HStack {
            Text(repository.name)
            Spacer()
            Text("\(repository.worktrees.count)")
          }
        }
      }
    }
    .onChange(of: store.selection) { _, _ in Task { await store.loadChanges() } }
    .overlay {
      if store.roots.isEmpty {
        ContentUnavailableView("Add a repository root", systemImage: "folder.badge.plus")
      } else if store.snapshot.worktrees.isEmpty && !store.isRefreshing {
        ContentUnavailableView(
          "No repositories found", systemImage: "externaldrive.badge.questionmark")
      }
    }
  }
}

private struct WorktreeRow: View {
  let worktree: WorktreeSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Image(systemName: worktree.runtimes.isEmpty ? "circle" : "play.circle.fill")
          .foregroundStyle(worktree.runtimes.isEmpty ? Color.secondary : Color.green)
        Text(worktree.git.branch).fontWeight(.medium)
        Spacer()
        if !worktree.git.isClean {
          Text("\(worktree.git.changeCount) changes").foregroundStyle(.orange)
        }
        if let pullRequest = worktree.pullRequest {
          Text("PR #\(pullRequest.number)").foregroundStyle(color(for: pullRequest.checks))
        }
      }
      HStack(spacing: 10) {
        if let runtime = worktree.runtimes.first {
          Text(runtime.url ?? runtime.name)
        }
        if worktree.git.ahead > 0 { Text("↑\(worktree.git.ahead)") }
        if worktree.git.behind > 0 { Text("↓\(worktree.git.behind)") }
        if !worktree.codexThreads.isEmpty { Text("Codex \(worktree.codexThreads.count)") }
        if !worktree.convexDeployments.isEmpty { Text("Convex") }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      .lineLimit(1)
    }
    .padding(.vertical, 3)
  }

  private func color(for checks: PullRequestSummary.Checks) -> Color {
    switch checks {
    case .success: .green
    case .failure: .red
    case .pending: .orange
    case .unknown: .secondary
    }
  }
}
