import Foundation

public struct WorkspaceSnapshot: Sendable {
  public let repositories: [RepositorySnapshot]
  public let refreshedAt: Date
  public let warnings: [String]

  public init(
    repositories: [RepositorySnapshot], refreshedAt: Date = Date(), warnings: [String] = []
  ) {
    self.repositories = repositories
    self.refreshedAt = refreshedAt
    self.warnings = warnings
  }

  public var worktrees: [WorktreeSnapshot] { repositories.flatMap(\.worktrees) }
}

public struct RepositorySnapshot: Sendable, Identifiable {
  public var id: String { rootPath }
  public let name: String
  public let rootPath: String
  public let origin: String?
  public var worktrees: [WorktreeSnapshot]

  public init(name: String, rootPath: String, origin: String?, worktrees: [WorktreeSnapshot]) {
    self.name = name
    self.rootPath = rootPath
    self.origin = origin
    self.worktrees = worktrees
  }
}

public struct WorktreeSnapshot: Sendable, Identifiable {
  public var id: String { path }
  public let repositoryName: String
  public let path: String
  public let registration: WorktreeRegistration
  public let git: GitStatus
  public var runtimes: [LocalRuntime]
  public var convexDeployments: [ConvexDeployment]
  public var codexThreads: [CodexThread]
  public var github: GitHubPullRequestLookup

  public var pullRequest: PullRequestSummary? {
    guard case .found(let pullRequest) = github else { return nil }
    return pullRequest
  }

  public init(
    repositoryName: String,
    path: String,
    registration: WorktreeRegistration,
    git: GitStatus,
    runtimes: [LocalRuntime] = [],
    convexDeployments: [ConvexDeployment] = [],
    codexThreads: [CodexThread] = [],
    github: GitHubPullRequestLookup = .none
  ) {
    self.repositoryName = repositoryName
    self.path = path
    self.registration = registration
    self.git = git
    self.runtimes = runtimes
    self.convexDeployments = convexDeployments
    self.codexThreads = codexThreads
    self.github = github
  }
}

public struct LocalRuntime: Sendable, Hashable, Identifiable {
  public enum Source: String, Sendable { case workCLI, process }

  public var id: String { "\(source.rawValue):\(processID ?? -1):\(url ?? name)" }
  public let name: String
  public let processID: Int?
  public let url: String?
  public let status: String
  public let source: Source

  public init(
    name: String, processID: Int? = nil, url: String? = nil, status: String, source: Source
  ) {
    self.name = name
    self.processID = processID
    self.url = url
    self.status = status
    self.source = source
  }
}

public struct WorkCLICommand: Sendable, Equatable {
  public let status: String
  public let project: String
  public let workspace: String
  public let command: String
  public let runner: String
  public let handle: String
  public let url: String?

  public init(
    status: String, project: String, workspace: String, command: String, runner: String,
    handle: String, url: String?
  ) {
    self.status = status
    self.project = project
    self.workspace = workspace
    self.command = command
    self.runner = runner
    self.handle = handle
    self.url = url
  }
}

public struct ConvexDeployment: Sendable, Equatable, Identifiable {
  public var id: String { "\(source):\(kind):\(name)" }
  public let kind: String
  public let name: String
  public let url: String?
  public let source: String

  public init(kind: String, name: String, url: String?, source: String) {
    self.kind = kind
    self.name = name
    self.url = url
    self.source = source
  }
}

public struct CodexThread: Sendable, Equatable, Identifiable, Codable {
  public let id: String
  public let cwd: String
  public let title: String
  public let updatedAtMilliseconds: Int64

  public init(id: String, cwd: String, title: String, updatedAtMilliseconds: Int64) {
    self.id = id
    self.cwd = cwd
    self.title = title
    self.updatedAtMilliseconds = updatedAtMilliseconds
  }
}

public struct PullRequestSummary: Sendable, Equatable {
  public enum Checks: String, Sendable { case success, failure, pending, unknown }
  public let number: Int
  public let title: String
  public let state: String
  public let isDraft: Bool
  public let url: String
  public let checks: Checks

  public init(number: Int, title: String, state: String, isDraft: Bool, url: String, checks: Checks)
  {
    self.number = number
    self.title = title
    self.state = state
    self.isDraft = isDraft
    self.url = url
    self.checks = checks
  }
}

public enum GitHubPullRequestLookup: Sendable, Equatable {
  case found(PullRequestSummary)
  case none
  case unavailable(String)
}
