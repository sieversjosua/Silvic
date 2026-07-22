import Foundation

public struct GitStatus: Sendable, Equatable, Codable {
  public var branch: String
  public var upstream: String?
  public var revision: String?
  public var ahead: Int
  public var behind: Int
  public var staged: Int
  public var unstaged: Int
  public var untracked: Int
  public var conflicted: Int

  public init(
    branch: String = "unknown",
    upstream: String? = nil,
    revision: String? = nil,
    ahead: Int = 0,
    behind: Int = 0,
    staged: Int = 0,
    unstaged: Int = 0,
    untracked: Int = 0,
    conflicted: Int = 0
  ) {
    self.branch = branch
    self.upstream = upstream
    self.revision = revision
    self.ahead = ahead
    self.behind = behind
    self.staged = staged
    self.unstaged = unstaged
    self.untracked = untracked
    self.conflicted = conflicted
  }

  public var isClean: Bool {
    staged == 0 && unstaged == 0 && untracked == 0 && conflicted == 0
  }

  public var changeCount: Int {
    staged + unstaged + untracked + conflicted
  }
}

public struct WorktreeRegistration: Sendable, Equatable {
  public let path: String
  public let head: String?
  public let branch: String?
  public let isBare: Bool
  public let isDetached: Bool
  public let isLocked: Bool
  public let isPrunable: Bool

  public init(
    path: String,
    head: String? = nil,
    branch: String? = nil,
    isBare: Bool = false,
    isDetached: Bool = false,
    isLocked: Bool = false,
    isPrunable: Bool = false
  ) {
    self.path = path
    self.head = head
    self.branch = branch
    self.isBare = isBare
    self.isDetached = isDetached
    self.isLocked = isLocked
    self.isPrunable = isPrunable
  }
}
