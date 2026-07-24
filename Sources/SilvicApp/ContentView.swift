import AppKit
import SwiftUI
import WorkbenchCore

struct ContentView: View {
  @EnvironmentObject private var store: WorkspaceStore

  var body: some View {
    NavigationSplitView {
      List {
        if !store.snapshot.warnings.isEmpty {
          Section("Needs attention") {
            ForEach(store.snapshot.warnings, id: \.self) { warning in
              Label(warning, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            }
          }
        }
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
      workspaceList
        .navigationSplitViewColumnWidth(min: 360, ideal: 450)
    } detail: {
      if let workspace = store.selectedWorkspace {
        WorkspaceDetailView(workspace: workspace)
          .id(workspace.id)
      } else {
        ContentUnavailableView(
          "No Workspace Selected",
          systemImage: "arrow.triangle.branch",
          description: Text(
            store.roots.isEmpty
              ? "Add a repository root to begin."
              : "No Git workspaces were found in the selected roots.")
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
      "Silvic",
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

  private var workspaceList: some View {
    List(selection: $store.selection) {
      ForEach(store.snapshot.repositories) { repository in
        Section {
          ForEach(repository.workspaces) { workspace in
            WorkspaceRow(workspace: workspace)
              .tag(workspace.id)
          }
        } header: {
          HStack {
            Text(repository.name)
            Spacer()
            Text("\(repository.workspaces.count)")
          }
        }
      }
    }
    .onChange(of: store.selection) { _, _ in Task { await store.loadChanges() } }
    .overlay {
      if store.roots.isEmpty {
        ContentUnavailableView("Add a repository root", systemImage: "folder.badge.plus")
      } else if store.snapshot.workspaces.isEmpty && !store.isRefreshing {
        ContentUnavailableView(
          "No repositories found", systemImage: "externaldrive.badge.questionmark")
      }
    }
  }
}

private struct WorkspaceRow: View {
  let workspace: WorkspaceSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Image(systemName: workspace.runtimes.isEmpty ? "circle" : "play.circle.fill")
          .foregroundStyle(workspace.runtimes.isEmpty ? Color.secondary : Color.green)
        Text(workspace.record.displayName).fontWeight(.medium)
        Spacer()
        if !workspace.git.isClean {
          Text("\(workspace.git.changeCount) changes").foregroundStyle(.orange)
        }
        if let pullRequest = workspace.pullRequest {
          Text("PR #\(pullRequest.number)").foregroundStyle(color(for: pullRequest.checks))
        }
      }
      HStack(spacing: 10) {
        Text(workspace.location.kind.displayName)
        if workspace.record.displayName != workspace.git.branch {
          Text(workspace.git.branch)
        }
        if let runtime = workspace.runtimes.first {
          Text(runtime.url ?? runtime.name)
        }
        if workspace.git.ahead > 0 { Text("↑\(workspace.git.ahead)") }
        if workspace.git.behind > 0 { Text("↓\(workspace.git.behind)") }
        if !workspace.codexThreads.isEmpty { Text("Codex \(workspace.codexThreads.count)") }
        if !workspace.convexDeployments.isEmpty { Text("Convex") }
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
