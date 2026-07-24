import Foundation

public enum GroveNodeRole: String, Sendable {
  case trunk
  case taskEnvironment
}

public enum GroveLineage: String, Sendable {
  case recorded
  case inferred
}

public struct GrovePoint: Sendable, Equatable {
  public let x: Double
  public let y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public struct ProjectGroveNode: Sendable, Identifiable, Equatable {
  public var id: WorkspaceID { workspaceID }
  public let workspaceID: WorkspaceID
  public let role: GroveNodeRole
  public let position: GrovePoint

  public init(workspaceID: WorkspaceID, role: GroveNodeRole, position: GrovePoint) {
    self.workspaceID = workspaceID
    self.role = role
    self.position = position
  }
}

public struct ProjectGroveEdge: Sendable, Identifiable, Equatable {
  public var id: String { "\(sourceWorkspaceID.rawValue):\(targetWorkspaceID.rawValue)" }
  public let sourceWorkspaceID: WorkspaceID
  public let targetWorkspaceID: WorkspaceID
  public let lineage: GroveLineage

  public init(
    sourceWorkspaceID: WorkspaceID,
    targetWorkspaceID: WorkspaceID,
    lineage: GroveLineage
  ) {
    self.sourceWorkspaceID = sourceWorkspaceID
    self.targetWorkspaceID = targetWorkspaceID
    self.lineage = lineage
  }
}

public struct ProjectGroveLayout: Sendable, Equatable {
  public let primaryWorkspaceID: WorkspaceID?
  public let nodes: [ProjectGroveNode]
  public let edges: [ProjectGroveEdge]
  public let canvasWidth: Double
  public let canvasHeight: Double

  public init(repository: RepositorySnapshot) {
    let sorted = repository.workspaces.sorted(by: Self.workspaceOrder)
    guard let primary = Self.primaryWorkspace(in: sorted, rootPath: repository.rootPath) else {
      primaryWorkspaceID = nil
      nodes = []
      edges = []
      canvasWidth = 1_100
      canvasHeight = 650
      return
    }

    primaryWorkspaceID = primary.id
    let byID = Dictionary(uniqueKeysWithValues: sorted.map { ($0.id, $0) })
    var resolvedParents: [WorkspaceID: (WorkspaceID, GroveLineage)] = [:]

    for workspace in sorted where workspace.id != primary.id {
      if let parentID = workspace.record.parentWorkspaceID,
        Self.reachesPrimary(
          from: parentID,
          primaryID: primary.id,
          workspaces: byID,
          visited: [workspace.id]
        )
      {
        resolvedParents[workspace.id] = (parentID, .recorded)
      } else {
        resolvedParents[workspace.id] = (primary.id, .inferred)
      }
    }

    var children: [WorkspaceID: [WorkspaceID]] = [:]
    for (child, parent) in resolvedParents {
      children[parent.0, default: []].append(child)
    }
    for parent in children.keys {
      children[parent]?.sort {
        guard let lhs = byID[$0], let rhs = byID[$1] else {
          return $0.rawValue < $1.rawValue
        }
        return Self.workspaceOrder(lhs, rhs)
      }
    }

    var positions: [WorkspaceID: GrovePoint] = [:]
    var nextTaskRow = 0
    var maximumDepth = 0

    func placeDescendants(of workspaceID: WorkspaceID, depth: Int) {
      for childID in children[workspaceID] ?? [] {
        maximumDepth = max(maximumDepth, depth)
        positions[childID] = GrovePoint(
          x: 430 + Double(depth) * 360,
          y: 110 + Double(nextTaskRow) * 190
        )
        nextTaskRow += 1
        placeDescendants(of: childID, depth: depth + 1)
      }
    }

    positions[primary.id] = GrovePoint(x: 430, y: 110)
    placeDescendants(of: primary.id, depth: 1)

    nodes = sorted.compactMap { workspace in
      guard let position = positions[workspace.id] else { return nil }
      return ProjectGroveNode(
        workspaceID: workspace.id,
        role: workspace.id == primary.id ? .trunk : .taskEnvironment,
        position: position
      )
    }
    edges = resolvedParents
      .map { child, parent in
        ProjectGroveEdge(
          sourceWorkspaceID: parent.0,
          targetWorkspaceID: child,
          lineage: parent.1
        )
      }
      .sorted { $0.id < $1.id }
    canvasWidth = max(1_100, 760 + Double(maximumDepth) * 360)
    canvasHeight = max(650, 220 + Double(max(nextTaskRow, 1) - 1) * 190)
  }

  public func node(for workspaceID: WorkspaceID) -> ProjectGroveNode? {
    nodes.first { $0.workspaceID == workspaceID }
  }

  public func edge(to workspaceID: WorkspaceID) -> ProjectGroveEdge? {
    edges.first { $0.targetWorkspaceID == workspaceID }
  }

  private static func primaryWorkspace(
    in workspaces: [WorkspaceSnapshot],
    rootPath: String
  ) -> WorkspaceSnapshot? {
    let normalizedRoot = WorkspaceLocation.normalize(rootPath)
    return workspaces.first {
      WorkspaceLocation.normalize($0.path) == normalizedRoot
        && $0.location.kind == .gitCheckout
    }
      ?? workspaces.first { $0.location.kind == .gitCheckout }
      ?? workspaces.first
  }

  private static func reachesPrimary(
    from candidateID: WorkspaceID,
    primaryID: WorkspaceID,
    workspaces: [WorkspaceID: WorkspaceSnapshot],
    visited: Set<WorkspaceID>
  ) -> Bool {
    if candidateID == primaryID { return true }
    guard !visited.contains(candidateID), let candidate = workspaces[candidateID] else {
      return false
    }
    guard let parent = candidate.record.parentWorkspaceID else { return false }
    return reachesPrimary(
      from: parent,
      primaryID: primaryID,
      workspaces: workspaces,
      visited: visited.union([candidateID])
    )
  }

  private static func workspaceOrder(
    _ lhs: WorkspaceSnapshot,
    _ rhs: WorkspaceSnapshot
  ) -> Bool {
    let nameOrder = lhs.record.displayName.localizedStandardCompare(rhs.record.displayName)
    if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
    return lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
  }
}
