import Foundation

public struct WorkspaceService: Sendable {
  private let discovery: RepositoryDiscovery
  private let git: GitClient
  private let workCLI: WorkCLIService
  private let processes: ListeningProcessService
  private let convex: ConvexDiscovery
  private let codex: CodexThreadService
  private let github: GitHubService

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.discovery = RepositoryDiscovery(runner: runner)
    self.git = GitClient(runner: runner)
    self.workCLI = WorkCLIService(runner: runner)
    self.processes = ListeningProcessService(runner: runner)
    self.convex = ConvexDiscovery()
    self.codex = CodexThreadService(runner: runner)
    self.github = GitHubService(runner: runner)
  }

  public func refresh(roots: [String]) async -> WorkspaceSnapshot {
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
      for worktree in repositories.flatMap(\.worktrees) {
        group.addTask {
          async let deployments = convex.deployments(in: worktree.path)
          async let pullRequest = github.pullRequest(in: worktree.path)
          return (worktree.path, await deployments, await pullRequest)
        }
      }
      var integrations: [String: ([ConvexDeployment], GitHubPullRequestLookup)] = [:]
      for await value in group { integrations[value.0] = (value.1, value.2) }

      for repositoryIndex in repositories.indices {
        for worktreeIndex in repositories[repositoryIndex].worktrees.indices {
          var worktree = repositories[repositoryIndex].worktrees[worktreeIndex]
          worktree.runtimes = runtimes(for: worktree, commands: commands, listeners: listeners)
          worktree.codexThreads = threads.filter { path($0.cwd, belongsTo: worktree.path) }
          if let integration = integrations[worktree.path] {
            worktree.convexDeployments = integration.0
            worktree.github = integration.1
          }
          repositories[repositoryIndex].worktrees[worktreeIndex] = worktree
        }
      }
    }

    repositories.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    return WorkspaceSnapshot(repositories: repositories)
  }

  private func loadRepository(at path: String) async -> RepositorySnapshot? {
    guard let registrations = try? await git.worktrees(repositoryPath: path) else { return nil }
    let name = URL(fileURLWithPath: path).lastPathComponent
    async let origin = git.origin(worktreePath: path)
    let worktrees = await withTaskGroup(of: WorktreeSnapshot?.self) { group in
      for registration in registrations where !registration.isBare {
        group.addTask {
          guard let status = try? await git.status(worktreePath: registration.path) else {
            return nil
          }
          return WorktreeSnapshot(
            repositoryName: name,
            path: registration.path,
            registration: registration,
            git: status
          )
        }
      }
      var values: [WorktreeSnapshot] = []
      for await worktree in group {
        if let worktree { values.append(worktree) }
      }
      return values.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }
    return RepositorySnapshot(
      name: name, rootPath: path, origin: await origin, worktrees: worktrees)
  }

  private func runtimes(
    for worktree: WorktreeSnapshot,
    commands: [WorkCLICommand],
    listeners: [ListeningProcess]
  ) -> [LocalRuntime] {
    var runtimes =
      commands
      .filter { command in
        guard let workspacePath = command.workspacePath else { return false }
        return path(workspacePath, belongsTo: worktree.path)
      }
      .map {
        LocalRuntime(name: $0.command, url: $0.url, status: $0.status, source: .workCLI)
      }
    runtimes.append(
      contentsOf:
        listeners
        .filter { path($0.cwd, belongsTo: worktree.path) }
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
