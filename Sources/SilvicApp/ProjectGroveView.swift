import SwiftUI
import WorkbenchCore

struct ProjectGroveView: View {
  let repository: RepositorySnapshot
  let selection: WorkspaceID?
  let query: String
  @Binding var zoom: Double
  @Binding var hideQuietEnvironments: Bool
  let onSelect: (WorkspaceSnapshot) -> Void
  let onPrimaryAction: (WorkspaceSnapshot) -> Void
  let onNewEnvironment: (WorkspaceSnapshot) -> Void
  let onOpenInApplication: (String, WorkspaceSnapshot) -> Void
  let onOpenCommandLineHarness: (CommandLineHarness, WorkspaceSnapshot) -> Void
  let onOpenTerminal: (WorkspaceSnapshot) -> Void
  let onOpenFinder: (WorkspaceSnapshot) -> Void

  private var visibleRepository: RepositorySnapshot {
    let isSearching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let primaryID = ProjectGroveLayout(repository: repository).primaryWorkspaceID
    let byID = Dictionary(uniqueKeysWithValues: repository.workspaces.map { ($0.id, $0) })
    var includedIDs = Set(
      repository.workspaces.filter {
        $0.id == primaryID
          || $0.id == selection
          || !hideQuietEnvironments
          || isSearching
          || $0.operationalSummary.state != .quiet
      }.map(\.id)
    )
    var parentsToVisit = includedIDs.compactMap { byID[$0]?.record.parentWorkspaceID }
    while let parentID = parentsToVisit.popLast() {
      guard includedIDs.insert(parentID).inserted else { continue }
      if let nextParent = byID[parentID]?.record.parentWorkspaceID {
        parentsToVisit.append(nextParent)
      }
    }
    let workspaces = repository.workspaces.filter { includedIDs.contains($0.id) }
    return RepositorySnapshot(
      name: repository.name,
      rootPath: repository.rootPath,
      origin: repository.origin,
      workspaces: workspaces
    )
  }

  var body: some View {
    let currentLayout = ProjectGroveLayout(repository: visibleRepository)
    let workspaceIndex = Dictionary(
      uniqueKeysWithValues: repository.workspaces.map { ($0.id, $0) }
    )
    let lineageByTarget = Dictionary(
      uniqueKeysWithValues: currentLayout.edges.map { ($0.targetWorkspaceID, $0.lineage) }
    )

    GeometryReader { geometry in
      ZStack(alignment: .topLeading) {
        ScrollView([.horizontal, .vertical]) {
          ZStack(alignment: .topLeading) {
            GroveConnections(layout: currentLayout)

            if let primaryID = currentLayout.primaryWorkspaceID,
              let primaryNode = currentLayout.node(for: primaryID)
            {
              RepositoryRootNode(repository: repository)
                .position(x: 135, y: primaryNode.position.y)
            }

            ForEach(currentLayout.nodes) { node in
              if let workspace = workspaceIndex[node.workspaceID] {
                GroveWorkspaceNode(
                  workspace: workspace,
                  role: node.role,
                  lineage: lineageByTarget[workspace.id],
                  isSelected: selection == workspace.id,
                  isDimmed: isDimmed(workspace),
                  onSelect: { onSelect(workspace) },
                  onPrimaryAction: { onPrimaryAction(workspace) },
                  onNewEnvironment: { onNewEnvironment(workspace) },
                  onOpenInApplication: { onOpenInApplication($0, workspace) },
                  onOpenCommandLineHarness: {
                    onOpenCommandLineHarness($0, workspace)
                  },
                  onOpenTerminal: { onOpenTerminal(workspace) },
                  onOpenFinder: { onOpenFinder(workspace) }
                )
                .position(x: node.position.x, y: node.position.y)
              }
            }
          }
          .frame(width: currentLayout.canvasWidth, height: currentLayout.canvasHeight)
          .scaleEffect(zoom, anchor: .topLeading)
          .frame(
            width: currentLayout.canvasWidth * zoom,
            height: currentLayout.canvasHeight * zoom,
            alignment: .topLeading
          )
        }
        .background(SilvicTheme.canvas)

        HStack(spacing: 8) {
          Button {
            zoom = max(0.2, zoom - 0.1)
          } label: {
            Image(systemName: "minus.magnifyingglass")
          }
          Button {
            zoom = min(1.35, zoom + 0.1)
          } label: {
            Image(systemName: "plus.magnifyingglass")
          }
          Button("Fit") {
            let horizontal = (geometry.size.width - 24) / currentLayout.canvasWidth
            let vertical = (geometry.size.height - 24) / currentLayout.canvasHeight
            zoom = max(0.2, min(1, horizontal, vertical))
          }

          Divider().frame(height: 18)

          Toggle("Hide quiet", isOn: $hideQuietEnvironments)
            .toggleStyle(.checkbox)

          Divider().frame(height: 18)

          HStack(spacing: 5) {
            LineageSample(isDashed: true)
            Text("Imported lineage")
          }
          .foregroundStyle(.secondary)
        }
        .font(.caption)
        .buttonStyle(.borderless)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(.quaternary))
        .padding(12)
      }
    }
  }

  private func isDimmed(_ workspace: WorkspaceSnapshot) -> Bool {
    let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).localizedLowercase
    if !normalizedQuery.isEmpty {
      let haystack = [
        workspace.record.displayName,
        workspace.record.purpose ?? "",
        workspace.git.branch,
        workspace.path,
        workspace.runtimes.compactMap(\.url).joined(separator: " "),
        workspace.convexDeployments.map(\.name).joined(separator: " "),
        workspace.codexThreads.map(\.title).joined(separator: " "),
        workspace.pullRequest?.title ?? "",
      ].joined(separator: " ").localizedLowercase
      if !haystack.contains(normalizedQuery) { return true }
    }
    return false
  }
}

private struct GroveConnections: View {
  let layout: ProjectGroveLayout

  var body: some View {
    let nodeIndex = Dictionary(uniqueKeysWithValues: layout.nodes.map { ($0.workspaceID, $0) })
    Canvas { context, size in
      drawGrid(context: &context, size: size)
      guard let primaryID = layout.primaryWorkspaceID,
        let primary = layout.node(for: primaryID)
      else { return }

      var trunk = Path()
      trunk.move(to: CGPoint(x: 245, y: primary.position.y))
      trunk.addCurve(
        to: CGPoint(x: primary.position.x - 151, y: primary.position.y),
        control1: CGPoint(x: 310, y: primary.position.y),
        control2: CGPoint(x: 340, y: primary.position.y)
      )
      context.stroke(
        trunk,
        with: .color(SilvicTheme.accent.opacity(0.65)),
        style: StrokeStyle(lineWidth: 3, lineCap: .round)
      )

      for edge in layout.edges {
        guard let source = nodeIndex[edge.sourceWorkspaceID],
          let target = nodeIndex[edge.targetWorkspaceID]
        else { continue }
        var path = Path()
        let start = CGPoint(x: source.position.x + 151, y: source.position.y)
        let end = CGPoint(x: target.position.x - 151, y: target.position.y)
        let midpoint = (start.x + end.x) / 2
        path.move(to: start)
        path.addCurve(
          to: end,
          control1: CGPoint(x: midpoint, y: start.y),
          control2: CGPoint(x: midpoint, y: end.y)
        )
        context.stroke(
          path,
          with: .color(
            edge.lineage == .recorded
              ? SilvicTheme.accent.opacity(0.62)
              : Color.secondary.opacity(0.35)
          ),
          style: StrokeStyle(
            lineWidth: edge.lineage == .recorded ? 2.5 : 1.5,
            lineCap: .round,
            dash: edge.lineage == .recorded ? [] : [7, 6]
          )
        )
      }
    }
  }

  private func drawGrid(context: inout GraphicsContext, size: CGSize) {
    var grid = Path()
    let spacing: CGFloat = 28
    var x: CGFloat = 0
    while x <= size.width {
      var y: CGFloat = 0
      while y <= size.height {
        grid.addEllipse(in: CGRect(x: x, y: y, width: 1.2, height: 1.2))
        y += spacing
      }
      x += spacing
    }
    context.fill(grid, with: .color(Color.secondary.opacity(0.10)))
  }
}

private struct RepositoryRootNode: View {
  let repository: RepositorySnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Image(systemName: "shippingbox.fill")
          .foregroundStyle(SilvicTheme.accent)
        Text("PROJECT")
          .font(.system(size: 10, weight: .bold))
          .tracking(0.8)
          .foregroundStyle(.secondary)
      }
      Text(repository.name)
        .font(.system(size: 18, weight: .semibold, design: .rounded))
        .lineLimit(2)
      Text(
        "\(repository.workspaces.count) environment\(repository.workspaces.count == 1 ? "" : "s")"
      )
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(16)
    .frame(width: 220, alignment: .leading)
    .background(
      LinearGradient(
        colors: [SilvicTheme.accent.opacity(0.16), SilvicTheme.accent.opacity(0.07)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      ),
      in: RoundedRectangle(cornerRadius: 15)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 15)
        .stroke(SilvicTheme.accent.opacity(0.35), lineWidth: 1.5)
    )
  }
}

private struct GroveWorkspaceNode: View {
  let workspace: WorkspaceSnapshot
  let role: GroveNodeRole
  let lineage: GroveLineage?
  let isSelected: Bool
  let isDimmed: Bool
  let onSelect: () -> Void
  let onPrimaryAction: () -> Void
  let onNewEnvironment: () -> Void
  let onOpenInApplication: (String) -> Void
  let onOpenCommandLineHarness: (CommandLineHarness) -> Void
  let onOpenTerminal: () -> Void
  let onOpenFinder: () -> Void

  @State private var isHovering = false

  private var summary: WorkspaceOperationalSummary { workspace.operationalSummary }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 8) {
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(role == .trunk ? "PRIMARY CHECKOUT" : "TASK ENVIRONMENT")
              .font(.system(size: 9, weight: .bold))
              .tracking(0.65)
              .foregroundStyle(role == .trunk ? SilvicTheme.accent : .secondary)
            if lineage == .inferred {
              Text("IMPORTED")
                .font(.system(size: 8, weight: .bold))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.secondary.opacity(0.10), in: Capsule())
                .foregroundStyle(.secondary)
            }
          }
          Text(workspace.record.displayName)
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .lineLimit(1)
          Text(workspace.record.purpose ?? workspace.git.branch)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer()
        Circle()
          .fill(summary.state.tint)
          .frame(width: 9, height: 9)
          .padding(.top, 3)
      }

      HStack(spacing: 6) {
        GroveResourceChip(
          icon: workspace.git.isClean ? "checkmark.circle" : "circle.dotted",
          value: workspace.git.isClean ? "Clean" : "\(workspace.git.changeCount) changed",
          tint: workspace.git.isClean ? .secondary : .orange
        )
        runtimeChip
        if let deployment = workspace.convexDeployments.first {
          GroveResourceChip(icon: "cloud", value: deployment.name, tint: .purple)
        }
      }

      HStack(spacing: 6) {
        if !workspace.codexThreads.isEmpty {
          GroveResourceChip(
            icon: "bubble.left.and.bubble.right",
            value: "\(workspace.codexThreads.count) Codex",
            tint: .indigo
          )
        }
        if let pullRequest = workspace.pullRequest {
          GroveResourceChip(
            icon: pullRequest.checks.systemImage,
            value: "#\(pullRequest.number)",
            tint: pullRequest.checks.tint
          )
        }
        if workspace.codexThreads.isEmpty && workspace.pullRequest == nil {
          Text(summary.message)
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
        Spacer()
      }

      HStack(spacing: 7) {
        Button(action: onPrimaryAction) {
          Label(summary.action.title, systemImage: summary.action.systemImage)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)

        Menu {
          Button("Codex", systemImage: "sparkles") { onOpenInApplication("Codex") }
          Button("T3 Code", systemImage: "chevron.left.forwardslash.chevron.right") {
            onOpenInApplication("T3 Code")
          }
          Button("Claude Code", systemImage: "terminal") {
            onOpenCommandLineHarness(.claude)
          }
          Button("OpenCode", systemImage: "terminal") {
            onOpenCommandLineHarness(.opencode)
          }
          Divider()
          Button("Terminal", systemImage: "terminal") { onOpenTerminal() }
          Button("Finder", systemImage: "folder") { onOpenFinder() }
        } label: {
          Label("Open in", systemImage: "arrow.up.forward.app")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()

        Spacer()

        Button(action: onNewEnvironment) {
          Image(systemName: "plus")
        }
        .buttonStyle(.borderless)
        .help("Branch a new task environment from here")
      }
    }
    .padding(14)
    .frame(width: 302)
    .frame(minHeight: 168, alignment: .topLeading)
    .background(
      isSelected
        ? SilvicTheme.accent.opacity(0.13)
        : Color(nsColor: .windowBackgroundColor),
      in: RoundedRectangle(cornerRadius: 13)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 13)
        .stroke(
          isSelected ? SilvicTheme.accent : summary.state.tint.opacity(0.48),
          lineWidth: isSelected ? 2.2 : 1.2
        )
    )
    .shadow(
      color: .black.opacity(isSelected || isHovering ? 0.10 : 0.045),
      radius: isSelected ? 10 : 5,
      y: 2
    )
    .opacity(isDimmed ? 0.25 : 1)
    .contentShape(RoundedRectangle(cornerRadius: 13))
    .onTapGesture(perform: onSelect)
    .focusable()
    .onKeyPress(.return) {
      onSelect()
      return .handled
    }
    .accessibilityElement(children: .contain)
    .accessibilityHidden(isDimmed)
    .accessibilityLabel(
      "\(workspace.record.displayName), \(role == .trunk ? "primary checkout" : "task environment")"
    )
    .accessibilityValue(
      "\(isSelected ? "Selected. " : "")\(summary.state.title). \(summary.message)"
    )
    .accessibilityAddTraits(.isButton)
    .accessibilityAction(named: "Select") { onSelect() }
    .onHover { isHovering = $0 }
  }

  @ViewBuilder private var runtimeChip: some View {
    if let runtime = workspace.runtimes.first(where: \.isActive) {
      GroveResourceChip(
        icon: "network",
        value: runtime.url.flatMap(shortRuntimeLabel) ?? runtime.status.capitalized,
        tint: .green
      )
    } else if let runtime = workspace.runtimes.first {
      GroveResourceChip(
        icon: "stop.circle",
        value: runtime.status.capitalized,
        tint: .secondary
      )
    }
  }

  private func shortRuntimeLabel(_ value: String) -> String? {
    guard let url = URL(string: value) else { return value }
    if let port = url.port { return ":\(port)" }
    return url.host()
  }
}

private struct GroveResourceChip: View {
  let icon: String
  let value: String
  let tint: Color

  var body: some View {
    Label(value, systemImage: icon)
      .font(.caption2)
      .foregroundStyle(tint)
      .lineLimit(1)
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(tint.opacity(0.09), in: Capsule())
  }
}

private struct LineageSample: View {
  let isDashed: Bool

  var body: some View {
    Canvas { context, size in
      var path = Path()
      path.move(to: CGPoint(x: 0, y: size.height / 2))
      path.addLine(to: CGPoint(x: size.width, y: size.height / 2))
      context.stroke(
        path,
        with: .color(Color.secondary.opacity(0.6)),
        style: StrokeStyle(lineWidth: 1.5, dash: isDashed ? [4, 3] : [])
      )
    }
    .frame(width: 24, height: 8)
  }
}

private extension PullRequestSummary.Checks {
  var systemImage: String {
    switch self {
    case .success: "checkmark.seal"
    case .failure: "xmark.octagon"
    case .pending: "clock"
    case .unknown: "questionmark.circle"
    }
  }

  var tint: Color {
    switch self {
    case .success: .green
    case .failure: .red
    case .pending: .orange
    case .unknown: .secondary
    }
  }
}
