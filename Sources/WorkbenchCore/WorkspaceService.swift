import Foundation

public struct WorkspaceService: Sendable {
  private let discovery: RepositoryDiscovery
  private let git: GitClient
  private let workCLI: WorkCLIService
  private let processes: ListeningProcessService
  private let convex: ConvexDiscovery
  private let codex: CodexThreadService
  private let github: GitHubService
  private let registry: WorkspaceRegistry?

  public init(
    runner: any CommandRunning = LocalCommandRunner(),
    registry: WorkspaceRegistry? = nil
  ) {
    self.discovery = RepositoryDiscovery(runner: runner)
    self.git = GitClient(runner: runner)
    self.workCLI = WorkCLIService(runner: runner)
    self.processes = ListeningProcessService(runner: runner)
    self.convex = ConvexDiscovery()
    self.codex = CodexThreadService(runner: runner)
    self.github = GitHubService(runner: runner)
    self.registry = registry
  }

  public func refresh(roots: [String]) async -> WorkspaceOverview {
    async let repositoryPaths = discovery.findRepositories(in: roots)
    async let workCommands = workCLI.commands()
    async let listeningProcesses = processes.listeners()
    async let codexThreads = codex.activeThreads()

    let paths = await repositoryPaths
    let commands = await workCommands
    let listeners = await listeningProcesses
    let threads = await codexThreads

    var repositories = await withTaskGroup(of: RepositorySnapshot?.self) { group in
      for path in paths {
        group.addTask { await loadRepository(at: path) }
      }
      var values: [RepositorySnapshot] = []
      for await repository in group {
        if let repository { values.append(repository) }
      }
      return values
    }

    await withTaskGroup(of: (String, [ConvexDeployment], GitHubPullRequestLookup).self) { group in
      for workspace in repositories.flatMap(\.workspaces) {
        group.addTask {
          async let deployments = convex.deployments(in: workspace.path)
          async let pullRequest = github.pullRequest(in: workspace.path)
          return (workspace.path, await deployments, await pullRequest)
        }
      }
      var integrations: [String: ([ConvexDeployment], GitHubPullRequestLookup)] = [:]
      for await value in group { integrations[value.0] = (value.1, value.2) }

      for repositoryIndex in repositories.indices {
        for workspaceIndex in repositories[repositoryIndex].workspaces.indices {
          var workspace = repositories[repositoryIndex].workspaces[workspaceIndex]
          workspace.runtimes = runtimes(
            for: workspace,
            commands: commands,
            listeners: listeners
          )
          workspace.codexThreads = threads.filter { path($0.cwd, belongsTo: workspace.path) }
          if let integration = integrations[workspace.path] {
            workspace.convexDeployments = integration.0
            workspace.github = integration.1
          }
          repositories[repositoryIndex].workspaces[workspaceIndex] = workspace
        }
      }
    }

    var warnings: [String] = []
    if let registry {
      do {
        let discovered = repositories.flatMap { repository in
          repository.workspaces.map { workspace in
            DiscoveredWorkspace(
              displayName: workspace.record.displayName,
              repositoryRoot: repository.rootPath,
              location: workspace.location
            )
          }
        }
        let records = try await registry.reconcile(discovered: discovered)
        warnings.append(contentsOf: await registry.consumeWarnings())
        for repositoryIndex in repositories.indices {
          for workspaceIndex in repositories[repositoryIndex].workspaces.indices {
            let workspace = repositories[repositoryIndex].workspaces[workspaceIndex]
            if let record = records[WorkspaceLocation.normalize(workspace.path)] {
              repositories[repositoryIndex].workspaces[workspaceIndex].record = record
            }
          }
        }
      } catch {
        warnings.append("Workspace identities could not be saved: \(error.localizedDescription)")
      }
    }

    repositories.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    return WorkspaceOverview(repositories: repositories, warnings: warnings)
  }

  private func loadRepository(at path: String) async -> RepositorySnapshot? {
    guard let registrations = try? await git.worktrees(repositoryPath: path) else { return nil }
    let name = URL(fileURLWithPath: path).lastPathComponent
    async let origin = git.origin(worktreePath: path)
    let workspaces = await withTaskGroup(of: WorkspaceSnapshot?.self) { group in
      for registration in registrations where !registration.isBare {
        group.addTask {
          guard let status = try? await git.status(worktreePath: registration.path) else {
            return nil
          }
          let location = WorkspaceLocation.inferred(
            path: registration.path,
            repositoryRoot: path
          )
          let record = WorkspaceRecord(
            id: WorkspaceID(rawValue: "discovered:\(location.path)"),
            displayName: status.branch == "(detached)"
              ? URL(fileURLWithPath: location.path).lastPathComponent
              : status.branch,
            repositoryRoot: path,
            location: location
          )
          return WorkspaceSnapshot(
            record: record,
            repositoryName: name,
            git: status
          )
        }
      }
      var values: [WorkspaceSnapshot] = []
      for await workspace in group {
        if let workspace { values.append(workspace) }
      }
      return values.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }
    return RepositorySnapshot(
      name: name, rootPath: path, origin: await origin, workspaces: workspaces)
  }

  private func runtimes(
    for workspace: WorkspaceSnapshot,
    commands: [WorkCLICommand],
    listeners: [ListeningProcess]
  ) -> [LocalRuntime] {
    var runtimes =
      commands
      .filter { command in
        guard let workspacePath = command.workspacePath else { return false }
        return path(workspacePath, belongsTo: workspace.path)
      }
      .map {
        LocalRuntime(name: $0.command, url: $0.url, status: $0.status, source: .workCLI)
      }
    runtimes.append(
      contentsOf:
        listeners
        .filter { path($0.cwd, belongsTo: workspace.path) }
        .map {
          LocalRuntime(
            name: $0.name, processID: $0.processID, url: $0.url, status: "listening",
            source: .process)
        })
    var seen = Set<String>()
    return runtimes.filter { seen.insert($0.url ?? $0.id).inserted }
  }
}

private func path(_ candidate: String, belongsTo root: String) -> Bool {
  let candidateURL = URL(fileURLWithPath: candidate).standardizedFileURL.path
  let rootURL = URL(fileURLWithPath: root).standardizedFileURL.path
  return candidateURL == rootURL || candidateURL.hasPrefix(rootURL + "/")
}
