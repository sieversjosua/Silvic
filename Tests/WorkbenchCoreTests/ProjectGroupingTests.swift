import Testing

@testable import WorkbenchCore

@Suite("Project grouping")
struct ProjectGroupingTests {
  @Test("independent clones with the same origin become one project")
  func groupsIndependentClones() {
    let first = repository(
      name: "app",
      root: "/projects/app",
      origin: "git@github.com:Example/App.git",
      branch: "main"
    )
    let clone = repository(
      name: "app-copy",
      root: "/projects/app-copy",
      origin: "https://github.com/example/app.git",
      branch: "agent/auth"
    )

    let projects = ProjectGrouping.merge([clone, first])

    #expect(projects.count == 1)
    #expect(projects[0].workspaces.count == 2)
    #expect(projects[0].id == "github.com/example/app")
  }

  @Test("repositories without a remote remain independent projects")
  func keepsLocalRepositoriesSeparate() {
    let projects = ProjectGrouping.merge([
      repository(name: "one", root: "/projects/one", origin: nil, branch: "main"),
      repository(name: "two", root: "/projects/two", origin: nil, branch: "main"),
    ])

    #expect(projects.count == 2)
  }

  @Test("recorded lineage keeps a local independent clone in its project")
  func groupsLocalCloneByLineage() {
    let parentID = WorkspaceID(rawValue: "parent")
    let first = repository(
      name: "local-app",
      root: "/projects/local-app",
      origin: nil,
      branch: "main",
      id: parentID
    )
    let clone = repository(
      name: "local-app-task",
      root: "/projects/local-app-task",
      origin: "/projects/local-app",
      branch: "agent/task",
      id: WorkspaceID(rawValue: "child"),
      parentID: parentID
    )

    let projects = ProjectGrouping.merge([clone, first])

    #expect(projects.count == 1)
    #expect(projects[0].rootPath == "/projects/local-app")
    #expect(projects[0].workspaces.count == 2)
  }

  @Test("self-hosted ports and case-sensitive paths remain distinct")
  func preservesSelfHostedIdentity() {
    #expect(
      ProjectGrouping.identity(
        origin: "https://git.example.com:8443/Team/App.git",
        rootPath: "/unused"
      ) == "git.example.com:8443/Team/App"
    )
    #expect(
      ProjectGrouping.identity(
        origin: "https://git.example.com:9443/team/app.git",
        rootPath: "/unused"
      ) == "git.example.com:9443/team/app"
    )
  }

  private func repository(
    name: String,
    root: String,
    origin: String?,
    branch: String,
    id: WorkspaceID? = nil,
    parentID: WorkspaceID? = nil
  ) -> RepositorySnapshot {
    RepositorySnapshot(
      name: name,
      rootPath: root,
      origin: origin,
      workspaces: [
        WorkspaceSnapshot(
          record: WorkspaceRecord(
            id: id ?? WorkspaceID(rawValue: root),
            displayName: branch,
            parentWorkspaceID: parentID,
            location: WorkspaceLocation(path: root, kind: .gitCheckout)
          ),
          repositoryName: name,
          git: GitStatus(branch: branch)
        )
      ]
    )
  }
}
