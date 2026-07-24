import Foundation
import Testing

@testable import WorkbenchCore

@Suite("Project grove layout")
struct ProjectGroveLayoutTests {
  @Test("the primary checkout becomes the trunk")
  func primaryCheckoutIsTrunk() {
    let repository = makeRepository(
      workspaces: [
        makeWorkspace(name: "feature", path: "/repo-feature", kind: .gitWorktree),
        makeWorkspace(name: "main", path: "/repo", kind: .gitCheckout),
      ])

    let layout = ProjectGroveLayout(repository: repository)

    #expect(layout.primaryWorkspaceID == repository.workspaces[1].id)
    #expect(layout.nodes.first(where: { $0.workspaceID == repository.workspaces[1].id })?.role == .trunk)
  }

  @Test("recorded lineage is solid and imported lineage remains inferred")
  func lineageEvidenceIsHonest() {
    let trunk = makeWorkspace(name: "main", path: "/repo", kind: .gitCheckout)
    let recorded = makeWorkspace(
      name: "recorded",
      path: "/repo-recorded",
      kind: .gitWorktree,
      parentID: trunk.id
    )
    let imported = makeWorkspace(name: "imported", path: "/repo-imported", kind: .gitWorktree)
    let layout = ProjectGroveLayout(
      repository: makeRepository(workspaces: [trunk, recorded, imported])
    )

    #expect(layout.edge(to: recorded.id)?.lineage == .recorded)
    #expect(layout.edge(to: recorded.id)?.sourceWorkspaceID == trunk.id)
    #expect(layout.edge(to: imported.id)?.lineage == .inferred)
    #expect(layout.edge(to: imported.id)?.sourceWorkspaceID == trunk.id)
  }

  @Test("nested recorded workspaces occupy deeper columns")
  func nestedLineageUsesDepth() {
    let trunk = makeWorkspace(name: "main", path: "/repo", kind: .gitCheckout)
    let child = makeWorkspace(
      name: "child",
      path: "/repo-child",
      kind: .gitWorktree,
      parentID: trunk.id
    )
    let grandchild = makeWorkspace(
      name: "grandchild",
      path: "/repo-grandchild",
      kind: .gitWorktree,
      parentID: child.id
    )
    let layout = ProjectGroveLayout(
      repository: makeRepository(workspaces: [grandchild, trunk, child])
    )

    let trunkNode = layout.node(for: trunk.id)
    let childNode = layout.node(for: child.id)
    let grandchildNode = layout.node(for: grandchild.id)
    #expect(trunkNode != nil)
    #expect(childNode != nil)
    #expect(grandchildNode != nil)
    #expect(childNode!.position.x > trunkNode!.position.x)
    #expect(grandchildNode!.position.x > childNode!.position.x)
  }

  @Test("layout order is stable regardless of discovery order")
  func layoutIsDeterministic() {
    let trunk = makeWorkspace(name: "main", path: "/repo", kind: .gitCheckout)
    let alpha = makeWorkspace(name: "alpha", path: "/repo-alpha", kind: .gitWorktree)
    let beta = makeWorkspace(name: "beta", path: "/repo-beta", kind: .gitWorktree)

    let forward = ProjectGroveLayout(
      repository: makeRepository(workspaces: [trunk, alpha, beta])
    )
    let reversed = ProjectGroveLayout(
      repository: makeRepository(workspaces: [beta, alpha, trunk])
    )

    #expect(forward.node(for: alpha.id)?.position == reversed.node(for: alpha.id)?.position)
    #expect(forward.node(for: beta.id)?.position == reversed.node(for: beta.id)?.position)
  }

  private func makeRepository(workspaces: [WorkspaceSnapshot]) -> RepositorySnapshot {
    RepositorySnapshot(
      name: "repo",
      rootPath: "/repo",
      origin: "git@github.com:example/repo.git",
      workspaces: workspaces
    )
  }

  private func makeWorkspace(
    name: String,
    path: String,
    kind: WorkspaceLocationKind,
    parentID: WorkspaceID? = nil
  ) -> WorkspaceSnapshot {
    WorkspaceSnapshot(
      record: WorkspaceRecord(
        id: WorkspaceID(rawValue: name),
        displayName: name,
        parentWorkspaceID: parentID,
        location: WorkspaceLocation(path: path, kind: kind)
      ),
      repositoryName: "repo",
      git: GitStatus(branch: name)
    )
  }
}
