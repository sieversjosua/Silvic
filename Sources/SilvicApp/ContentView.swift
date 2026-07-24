import AppKit
import SwiftUI
import WorkbenchCore

struct ContentView: View {
  @EnvironmentObject private var store: WorkspaceStore

  @State private var projectID: String?
  @State private var query = ""
  @State private var zoom = 0.9
  @State private var hideQuietEnvironments = false
  @State private var showingNewEnvironment = false

  var body: some View {
    NavigationSplitView {
      projectSidebar
        .navigationSplitViewColumnWidth(min: 205, ideal: 230, max: 280)
    } detail: {
      HStack(spacing: 0) {
        projectRoom
          .frame(minWidth: 570, maxWidth: .infinity, maxHeight: .infinity)

        Divider()

        inspector
          .frame(minWidth: 350, idealWidth: 410, maxWidth: 475, maxHeight: .infinity)
      }
      .background(Color(nsColor: .windowBackgroundColor))
    }
    .tint(SilvicTheme.accent)
    .onChange(of: store.selection) { _, _ in
      Task { await store.loadChanges() }
    }
    .onChange(of: store.snapshot.repositories.map(\.id)) { _, ids in
      guard !ids.isEmpty else {
        projectID = nil
        return
      }
      if let projectID, ids.contains(projectID) { return }
      projectID = ids.first
    }
    .sheet(isPresented: $showingNewEnvironment) {
      if let repository = selectedRepository, let parent = selectedParent {
        NewEnvironmentSheet(repository: repository, parent: parent)
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

  private var projectSidebar: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "tree")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(SilvicTheme.accent)
          .frame(width: 32, height: 32)
          .background(SilvicTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
        VStack(alignment: .leading, spacing: 1) {
          Text("Silvic")
            .font(.headline)
          Text("Project grove")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Spacer()
      }
      .padding(.horizontal, 14)
      .padding(.top, 14)
      .padding(.bottom, 18)

      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          sidebarSection("Projects") {
            ForEach(store.snapshot.repositories) { repository in
              ProjectSidebarRow(
                repository: repository,
                isSelected: effectiveProjectID == repository.id
              ) {
                selectProject(repository)
              }
            }

            Button {
              store.chooseAndAddRoot()
            } label: {
              Label("Add project…", systemImage: "plus")
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
          }

          sidebarSection("Locations") {
            ForEach(store.roots, id: \.self) { root in
              HStack(spacing: 8) {
                Image(systemName: "folder")
                  .frame(width: 17)
                  .foregroundStyle(.secondary)
                Text(URL(fileURLWithPath: root).lastPathComponent)
                  .lineLimit(1)
                Spacer()
              }
              .padding(.horizontal, 9)
              .padding(.vertical, 5)
              .help(root)
              .contextMenu {
                Button("Show in Finder") { store.openInFinder(root) }
                Divider()
                Button("Remove", role: .destructive) { store.removeRoot(root) }
              }
            }
          }

          if !store.snapshot.warnings.isEmpty {
            sidebarSection("Needs attention") {
              ForEach(store.snapshot.warnings, id: \.self) { warning in
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                  .font(.caption)
                  .foregroundStyle(.orange)
                  .fixedSize(horizontal: false, vertical: true)
                  .padding(.horizontal, 9)
              }
            }
          }
        }
        .padding(.horizontal, 9)
        .padding(.bottom, 18)
      }

      Divider()
      githubFooter
        .padding(12)
    }
    .background(.regularMaterial)
  }

  @ViewBuilder private var projectRoom: some View {
    if store.isRefreshing && store.snapshot.repositories.isEmpty {
      VStack(spacing: 12) {
        ProgressView()
        Text("Discovering projects…")
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if let repository = selectedRepository {
      VStack(spacing: 0) {
        ProjectHeader(
          repository: repository,
          query: $query,
          isRefreshing: store.isRefreshing,
          onNewEnvironment: { showingNewEnvironment = true },
          onRefresh: {
            Task {
              await store.refreshGitHubAuth()
              await store.refresh()
            }
          }
        )
        Divider()
        ProjectGroveView(
          repository: repository,
          selection: store.selection,
          query: query,
          zoom: $zoom,
          hideQuietEnvironments: $hideQuietEnvironments,
          onSelect: { store.selectWorkspace($0) },
          onPrimaryAction: { store.performPrimaryAction(for: $0) },
          onNewEnvironment: { workspace in
            store.selectWorkspace(workspace)
            showingNewEnvironment = true
          },
          onOpenInApplication: { application, workspace in
            store.openInApplication(named: application, path: workspace.path)
          },
          onOpenCommandLineHarness: { harness, workspace in
            store.openCommandLineHarness(harness, path: workspace.path)
          },
          onOpenTerminal: { store.openTerminal($0.path) },
          onOpenFinder: { store.openInFinder($0.path) }
        )
      }
    } else {
      ContentUnavailableView {
        Label("No project selected", systemImage: "tree")
      } description: {
        Text("Add a Git repository or a folder containing repositories.")
      } actions: {
        Button("Add project…") { store.chooseAndAddRoot() }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  @ViewBuilder private var inspector: some View {
    if let workspace = store.selectedWorkspace,
      selectedRepository?.workspaces.contains(where: { $0.id == workspace.id }) == true
    {
      WorkspaceDetailView(workspace: workspace)
        .id(workspace.id)
    } else {
      VStack(spacing: 14) {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .font(.system(size: 34))
          .foregroundStyle(.tertiary)
        Text("Select a task environment")
          .font(.headline)
        Text("Git, runtime, environment, review, and harness details will appear here.")
          .font(.callout)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 280)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .windowBackgroundColor))
    }
  }

  private var effectiveProjectID: String? {
    projectID ?? store.snapshot.repositories.first?.id
  }

  private var selectedRepository: RepositorySnapshot? {
    guard let effectiveProjectID else { return nil }
    return store.snapshot.repositories.first { $0.id == effectiveProjectID }
  }

  private var selectedParent: WorkspaceSnapshot? {
    guard let repository = selectedRepository else { return nil }
    if let selected = store.selectedWorkspace,
      repository.workspaces.contains(where: { $0.id == selected.id })
    {
      return selected
    }
    let primaryID = ProjectGroveLayout(repository: repository).primaryWorkspaceID
    return repository.workspaces.first { $0.id == primaryID } ?? repository.workspaces.first
  }

  private func selectProject(_ repository: RepositorySnapshot) {
    projectID = repository.id
    query = ""
    let primaryID = ProjectGroveLayout(repository: repository).primaryWorkspaceID
    if let workspace = repository.workspaces.first(where: { $0.id == primaryID })
      ?? repository.workspaces.first
    {
      store.selectWorkspace(workspace)
    }
  }

  private func sidebarSection<Content: View>(
    _ title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title.uppercased())
        .font(.system(size: 10, weight: .semibold))
        .tracking(0.7)
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 9)
      content()
    }
  }

  @ViewBuilder private var githubFooter: some View {
    if store.isGitHubLoginInProgress {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Waiting for GitHub…").font(.caption)
        Spacer()
        Button("Cancel") { store.cancelGitHubLoginWait() }
          .buttonStyle(.plain)
          .font(.caption)
      }
    } else {
      switch store.githubAuthStatus {
      case .authenticated(let username):
        HStack(spacing: 8) {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(.green)
          Text("@\(username)")
            .font(.caption)
            .lineLimit(1)
          Spacer()
          Button {
            Task { await store.refreshGitHubAuth() }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .buttonStyle(.plain)
          .help("Refresh GitHub account")
        }
      case .unauthenticated:
        Button {
          store.beginGitHubBrowserLogin()
        } label: {
          Label("Connect GitHub", systemImage: "person.crop.circle.badge.plus")
            .font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
      case .unavailable:
        Label("GitHub CLI unavailable", systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.secondary)
      case nil:
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Checking GitHub…").font(.caption)
        }
      }
    }
  }
}

private struct ProjectSidebarRow: View {
  let repository: RepositorySnapshot
  let isSelected: Bool
  let action: () -> Void

  private var attentionCount: Int {
    repository.workspaces.filter { $0.operationalSummary.state == .needsAttention }.count
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 9) {
        Image(systemName: isSelected ? "shippingbox.fill" : "shippingbox")
          .frame(width: 18)
          .foregroundStyle(isSelected ? SilvicTheme.accent : .secondary)
        VStack(alignment: .leading, spacing: 2) {
          Text(repository.name)
            .fontWeight(isSelected ? .semibold : .regular)
            .lineLimit(1)
          Text("\(repository.workspaces.count) environment\(repository.workspaces.count == 1 ? "" : "s")")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if attentionCount > 0 {
          Text("\(attentionCount)")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.red, in: Capsule())
        }
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 7)
      .background(
        isSelected ? SilvicTheme.accent.opacity(0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 8)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

private struct ProjectHeader: View {
  let repository: RepositorySnapshot
  @Binding var query: String
  let isRefreshing: Bool
  let onNewEnvironment: () -> Void
  let onRefresh: () -> Void

  var body: some View {
    HStack(spacing: 16) {
      VStack(alignment: .leading, spacing: 3) {
        Text(repository.name)
          .font(.system(size: 25, weight: .semibold, design: .rounded))
        HStack(spacing: 8) {
          Label(
            "\(repository.workspaces.count) environment\(repository.workspaces.count == 1 ? "" : "s")",
            systemImage: "point.3.connected.trianglepath.dotted"
          )
          if let origin = repository.origin {
            Text(origin)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      .layoutPriority(1)

      Spacer()

      TextField("Find in project", text: $query)
        .textFieldStyle(.roundedBorder)
        .frame(width: 180)

      Button(action: onNewEnvironment) {
        Label("New environment", systemImage: "plus")
      }
      .buttonStyle(.borderedProminent)

      if isRefreshing {
        ProgressView().controlSize(.small)
      }

      Button(action: onRefresh) {
        Image(systemName: "arrow.clockwise")
      }
      .help("Refresh project")
      .disabled(isRefreshing)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 15)
    .background(Color(nsColor: .windowBackgroundColor))
  }
}
