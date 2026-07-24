import AppKit
import SwiftUI
import WorkbenchCore

struct ContentView: View {
  @EnvironmentObject private var store: WorkspaceStore

  @State private var scope: WorkspaceScope = .all
  @State private var repositoryID: String?
  @State private var query = ""

  var body: some View {
    NavigationSplitView {
      sidebar
        .navigationSplitViewColumnWidth(min: 210, ideal: 232, max: 270)
    } detail: {
      HStack(spacing: 0) {
        operationsBoard
          .frame(minWidth: 500, maxWidth: .infinity, maxHeight: .infinity)

        Divider()

        inspector
          .frame(minWidth: 365, idealWidth: 420, maxWidth: 480, maxHeight: .infinity)
      }
      .background(Color(nsColor: .windowBackgroundColor))
    }
    .tint(SilvicTheme.accent)
    .onChange(of: store.selection) { _, _ in
      Task { await store.loadChanges() }
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

  private var sidebar: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(SilvicTheme.accent)
          .frame(width: 30, height: 30)
          .background(SilvicTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        VStack(alignment: .leading, spacing: 1) {
          Text("Silvic")
            .font(.headline)
          Text("Workspace operations")
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
          sidebarSection("Operations") {
            ForEach(WorkspaceScope.allCases) { candidate in
              SidebarButton(
                title: candidate.title,
                systemImage: candidate.systemImage,
                count: globalCount(for: candidate),
                isSelected: scope == candidate && repositoryID == nil
              ) {
                scope = candidate
                repositoryID = nil
              }
            }
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

          sidebarSection("Repositories") {
            ForEach(store.snapshot.repositories) { repository in
              SidebarButton(
                title: repository.name,
                systemImage: "shippingbox",
                count: repository.workspaces.count,
                isSelected: repositoryID == repository.id
              ) {
                repositoryID = repository.id
                scope = .all
              }
            }

            Button {
              store.chooseAndAddRoot()
            } label: {
              Label("Add repository…", systemImage: "plus")
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
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

  private var operationsBoard: some View {
    VStack(spacing: 0) {
      boardHeader
      Divider()

      if store.isRefreshing && store.snapshot.workspaces.isEmpty {
        VStack(spacing: 12) {
          ProgressView()
          Text("Mapping your workspaces…")
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if visibleWorkspaces.isEmpty {
        ContentUnavailableView {
          Label(emptyTitle, systemImage: "square.stack.3d.up.slash")
        } description: {
          Text(emptyDescription)
        } actions: {
          if store.roots.isEmpty {
            Button("Add repository…") { store.chooseAndAddRoot() }
          } else if !query.isEmpty {
            Button("Clear search") { query = "" }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVStack(spacing: 22) {
            ForEach(visibleGroups, id: \.state) { group in
              WorkspaceBoardSection(
                state: group.state,
                workspaces: group.workspaces,
                selection: store.selection,
                onSelect: { store.selectWorkspace($0) },
                onAction: { store.performPrimaryAction(for: $0) }
              )
            }
          }
          .padding(20)
        }
      }
    }
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.42))
  }

  private var boardHeader: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 16) {
        VStack(alignment: .leading, spacing: 3) {
          Text(boardTitle)
            .font(.system(size: 26, weight: .semibold, design: .rounded))
          Text("\(visibleWorkspaces.count) workspace\(visibleWorkspaces.count == 1 ? "" : "s")")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .layoutPriority(1)

        Spacer()

        TextField("Search workspaces", text: $query)
          .textFieldStyle(.roundedBorder)
          .frame(width: 160)

        if store.isRefreshing {
          ProgressView()
            .controlSize(.small)
        }

        Button {
          Task {
            await store.refreshGitHubAuth()
            await store.refresh()
          }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .help("Refresh")
        .disabled(store.isRefreshing)
      }

      HStack(spacing: 8) {
        SummaryPill(
          title: "Attention",
          count: count(for: .attention),
          tint: WorkspaceOperationalState.needsAttention.tint
        )
        SummaryPill(
          title: "Active",
          count: count(for: .active),
          tint: WorkspaceOperationalState.active.tint
        )
        SummaryPill(
          title: "Changed",
          count: count(for: .changed),
          tint: WorkspaceOperationalState.changed.tint
        )
        SummaryPill(
          title: "Ready",
          count: count(for: .ready),
          tint: WorkspaceOperationalState.readyToLand.tint
        )
      }
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 18)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  @ViewBuilder private var inspector: some View {
    if let workspace = store.selectedWorkspace {
      WorkspaceDetailView(workspace: workspace)
        .id(workspace.id)
    } else {
      VStack(spacing: 14) {
        Image(systemName: "cursorarrow.click.2")
          .font(.system(size: 34))
          .foregroundStyle(.tertiary)
        Text("Select a workspace")
          .font(.headline)
        Text("Its code, runtime, environment, review, and sessions will appear here.")
          .font(.callout)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 280)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .windowBackgroundColor))
    }
  }

  @ViewBuilder private var githubFooter: some View {
    if store.isGitHubLoginInProgress {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Waiting for GitHub…")
          .font(.caption)
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

  private var baseWorkspaces: [WorkspaceSnapshot] {
    if let repositoryID,
      let repository = store.snapshot.repositories.first(where: { $0.id == repositoryID })
    {
      return repository.workspaces
    }
    return store.snapshot.workspaces
  }

  private var visibleWorkspaces: [WorkspaceSnapshot] {
    baseWorkspaces
      .filter { scope.includes($0.operationalSummary.state) }
      .filter { workspace in
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
          return true
        }
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).localizedLowercase
        let haystack = [
          workspace.record.displayName,
          workspace.repositoryName,
          workspace.git.branch,
          workspace.path,
          workspace.pullRequest?.title ?? "",
          workspace.runtimes.map(\.name).joined(separator: " "),
          workspace.runtimes.compactMap(\.url).joined(separator: " "),
          workspace.convexDeployments.map(\.name).joined(separator: " "),
          workspace.convexDeployments.compactMap(\.url).joined(separator: " "),
          workspace.codexThreads.map(\.title).joined(separator: " "),
        ].joined(separator: " ").localizedLowercase
        return haystack.contains(normalizedQuery)
      }
      .sorted { lhs, rhs in
        let leftState = lhs.operationalSummary.state
        let rightState = rhs.operationalSummary.state
        if leftState.priority != rightState.priority {
          return leftState.priority < rightState.priority
        }
        return lhs.record.displayName.localizedStandardCompare(rhs.record.displayName)
          == .orderedAscending
      }
  }

  private var visibleGroups: [(state: WorkspaceOperationalState, workspaces: [WorkspaceSnapshot])] {
    WorkspaceOperationalState.allCases.compactMap { state in
      let workspaces = visibleWorkspaces.filter { $0.operationalSummary.state == state }
      return workspaces.isEmpty ? nil : (state, workspaces)
    }
  }

  private func count(for candidate: WorkspaceScope) -> Int {
    baseWorkspaces.filter { candidate.includes($0.operationalSummary.state) }.count
  }

  private func globalCount(for candidate: WorkspaceScope) -> Int {
    store.snapshot.workspaces.filter { candidate.includes($0.operationalSummary.state) }.count
  }

  private var boardTitle: String {
    if let repositoryID,
      let repository = store.snapshot.repositories.first(where: { $0.id == repositoryID })
    {
      return repository.name
    }
    return scope.title
  }

  private var emptyTitle: String {
    if store.roots.isEmpty { return "No repositories connected" }
    if !query.isEmpty { return "No matching workspaces" }
    return "Nothing in \(boardTitle.lowercased())"
  }

  private var emptyDescription: String {
    if store.roots.isEmpty {
      return "Add a repository or a folder containing repositories to begin."
    }
    if !query.isEmpty {
      return "Try another name, branch, repository, path, or pull request."
    }
    return "Silvic found no workspaces for this view."
  }
}

private enum WorkspaceScope: String, CaseIterable, Identifiable {
  case all
  case attention
  case active
  case changed
  case waiting
  case ready
  case unknown

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: "All workspaces"
    case .attention: "Needs attention"
    case .active: "Active now"
    case .changed: "Changes"
    case .waiting: "Waiting"
    case .ready: "Ready to land"
    case .unknown: "Status unknown"
    }
  }

  var systemImage: String {
    switch self {
    case .all: "square.stack.3d.up"
    case .attention: "exclamationmark.triangle"
    case .active: "play.circle"
    case .changed: "pencil.and.list.clipboard"
    case .waiting: "clock"
    case .ready: "checkmark.seal"
    case .unknown: "questionmark.diamond"
    }
  }

  func includes(_ state: WorkspaceOperationalState) -> Bool {
    switch self {
    case .all: true
    case .attention: state == .needsAttention
    case .active: state == .active
    case .changed: state == .changed
    case .waiting: state == .waiting
    case .ready: state == .readyToLand
    case .unknown: state == .unknown
    }
  }
}

private struct SidebarButton: View {
  let title: String
  let systemImage: String
  let count: Int
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Image(systemName: systemImage)
          .frame(width: 17)
          .foregroundStyle(isSelected ? SilvicTheme.accent : .secondary)
        Text(title)
          .lineLimit(1)
        Spacer()
        Text("\(count)")
          .font(.caption.monospacedDigit())
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background(
        isSelected ? SilvicTheme.accent.opacity(0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 7)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

private struct SummaryPill: View {
  let title: String
  let count: Int
  let tint: Color

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(tint)
        .frame(width: 6, height: 6)
      Text("\(count)")
        .fontWeight(.semibold)
        .monospacedDigit()
      Text(title)
        .foregroundStyle(.secondary)
    }
    .font(.caption)
    .padding(.horizontal, 9)
    .padding(.vertical, 5)
    .background(Color(nsColor: .controlBackgroundColor), in: Capsule())
    .overlay(Capsule().stroke(.quaternary))
  }
}

private struct WorkspaceBoardSection: View {
  let state: WorkspaceOperationalState
  let workspaces: [WorkspaceSnapshot]
  let selection: WorkspaceID?
  let onSelect: (WorkspaceSnapshot) -> Void
  let onAction: (WorkspaceSnapshot) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 7) {
        Image(systemName: state.systemImage)
          .foregroundStyle(state.tint)
        Text(state.title.uppercased())
          .font(.system(size: 11, weight: .semibold))
          .tracking(0.6)
        Text("\(workspaces.count)")
          .font(.caption.monospacedDigit())
          .foregroundStyle(.tertiary)
        Spacer()
      }
      .padding(.horizontal, 2)

      VStack(spacing: 7) {
        ForEach(workspaces) { workspace in
          WorkspaceBoardRow(
            workspace: workspace,
            isSelected: selection == workspace.id,
            onSelect: { onSelect(workspace) },
            onAction: { onAction(workspace) }
          )
        }
      }
    }
  }
}

private struct WorkspaceBoardRow: View {
  let workspace: WorkspaceSnapshot
  let isSelected: Bool
  let onSelect: () -> Void
  let onAction: () -> Void

  @State private var isHovering = false

  private var summary: WorkspaceOperationalSummary { workspace.operationalSummary }

  var body: some View {
    HStack(spacing: 0) {
      RoundedRectangle(cornerRadius: 2)
        .fill(summary.state.tint)
        .frame(width: 3)
        .padding(.vertical, 8)

      HStack(spacing: 10) {
        Button(action: onSelect) {
          HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
              Text(workspace.record.displayName)
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(1)
              HStack(spacing: 5) {
                Text(workspace.repositoryName)
                Text("·")
                Text(workspace.git.branch)
                  .font(.caption.monospaced())
              }
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)

              if !workspace.convexDeployments.isEmpty || !workspace.codexThreads.isEmpty {
                HStack(spacing: 8) {
                  if let deployment = workspace.convexDeployments.first {
                    Label(deployment.name, systemImage: "cloud")
                      .lineLimit(1)
                  }
                  if !workspace.codexThreads.isEmpty {
                    Label(
                      "\(workspace.codexThreads.count) Codex",
                      systemImage: "bubble.left.and.bubble.right"
                    )
                    .lineLimit(1)
                  }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
              }
            }
            .frame(minWidth: 100, maxWidth: .infinity, alignment: .leading)

            BoardMetric(
              icon: workspace.git.isClean ? "checkmark.circle" : "circle.dotted",
              value: workspace.git.isClean
                ? "Clean"
                : "\(workspace.git.changeCount) changed"
            )
            .frame(width: 68, alignment: .leading)

            BoardMetric(
              icon: activeRuntime == nil ? "stop.circle" : "network",
              value: runtimeValue
            )
            .frame(width: 68, alignment: .leading)

            BoardMetric(
              icon: reviewIcon,
              value: reviewValue
            )
            .frame(width: 48, alignment: .leading)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        VStack(alignment: .trailing, spacing: 5) {
          Text(summary.message)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Button(action: onAction) {
            Label(summary.action.title, systemImage: summary.action.systemImage)
              .font(.caption.weight(.medium))
          }
          .buttonStyle(.borderless)
        }
        .frame(width: 88, alignment: .trailing)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity)
    }
    .background(
      isSelected
        ? SilvicTheme.accent.opacity(0.11)
        : (isHovering ? Color.primary.opacity(0.045) : Color(nsColor: .windowBackgroundColor)),
      in: RoundedRectangle(cornerRadius: 9)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 9)
        .stroke(isSelected ? SilvicTheme.accent.opacity(0.35) : Color.primary.opacity(0.07))
    )
    .onHover { isHovering = $0 }
  }

  private var reviewIcon: String {
    guard let pullRequest = workspace.pullRequest else { return "arrow.triangle.pull" }
    return switch pullRequest.checks {
    case .success: "checkmark.seal"
    case .failure: "xmark.octagon"
    case .pending: "clock"
    case .unknown: "questionmark.circle"
    }
  }

  private var activeRuntime: LocalRuntime? {
    workspace.runtimes.first(where: \.isActive)
  }

  private var runtimeValue: String {
    if let url = workspace.runtimes.first(where: { $0.isActive && $0.url != nil })?.url {
      return url
    }
    return activeRuntime?.status.capitalized
      ?? workspace.runtimes.first?.status.capitalized
      ?? "Stopped"
  }

  private var reviewValue: String {
    guard let pullRequest = workspace.pullRequest else { return "No PR" }
    return "#\(pullRequest.number)"
  }
}

private struct BoardMetric: View {
  let icon: String
  let value: String

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: icon)
        .foregroundStyle(.secondary)
      Text(value)
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .font(.caption)
  }
}

enum SilvicTheme {
  static let accent = Color(red: 0.93, green: 0.42, blue: 0.18)
}

extension WorkspaceOperationalState {
  var systemImage: String {
    switch self {
    case .needsAttention: "exclamationmark.triangle.fill"
    case .active: "play.circle.fill"
    case .changed: "pencil.and.list.clipboard"
    case .waiting: "clock.fill"
    case .readyToLand: "checkmark.seal.fill"
    case .unknown: "questionmark.diamond.fill"
    case .quiet: "pause.circle"
    }
  }

  var tint: Color {
    switch self {
    case .needsAttention: .red
    case .active: .green
    case .changed: .orange
    case .waiting: .blue
    case .readyToLand: .mint
    case .unknown: .yellow
    case .quiet: .secondary
    }
  }
}

extension WorkspacePrimaryAction {
  var systemImage: String {
    switch self {
    case .inspect: "arrow.right"
    case .openRuntime: "safari"
    case .reviewChanges: "doc.text.magnifyingglass"
    case .reviewStatus: "questionmark.diamond"
    case .push: "arrow.up"
    case .openPullRequest: "arrow.up.right.square"
    case .resume: "play.fill"
    }
  }
}
