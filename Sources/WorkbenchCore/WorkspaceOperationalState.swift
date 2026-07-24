import Foundation

public enum WorkspaceOperationalState: String, CaseIterable, Sendable, Identifiable {
  case needsAttention
  case active
  case changed
  case waiting
  case readyToLand
  case unknown
  case quiet

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .needsAttention: "Needs attention"
    case .active: "Active"
    case .changed: "Changes to review"
    case .waiting: "Waiting"
    case .readyToLand: "Ready to land"
    case .unknown: "Status unknown"
    case .quiet: "Ready to resume"
    }
  }

  public var priority: Int {
    switch self {
    case .needsAttention: 0
    case .active: 1
    case .changed: 2
    case .waiting: 3
    case .readyToLand: 4
    case .unknown: 5
    case .quiet: 6
    }
  }
}

public enum WorkspacePrimaryAction: String, Sendable {
  case inspect
  case openRuntime
  case reviewChanges
  case reviewStatus
  case push
  case openPullRequest
  case resume

  public var title: String {
    switch self {
    case .inspect: "Inspect"
    case .openRuntime: "Open app"
    case .reviewChanges: "Review"
    case .reviewStatus: "Review status"
    case .push: "Push"
    case .openPullRequest: "Open PR"
    case .resume: "Resume"
    }
  }

}

public struct WorkspaceOperationalSummary: Sendable, Equatable {
  public let state: WorkspaceOperationalState
  public let message: String
  public let action: WorkspacePrimaryAction

  public init(
    state: WorkspaceOperationalState,
    message: String,
    action: WorkspacePrimaryAction
  ) {
    self.state = state
    self.message = message
    self.action = action
  }
}

extension WorkspaceSnapshot {
  public var operationalSummary: WorkspaceOperationalSummary {
    if git.conflicted > 0 {
      return WorkspaceOperationalSummary(
        state: .needsAttention,
        message: "\(git.conflicted) merge conflict\(git.conflicted == 1 ? "" : "s")",
        action: .inspect
      )
    }

    if let pullRequest, pullRequest.state.uppercased() == "OPEN",
      pullRequest.checks == .failure
    {
      return WorkspaceOperationalSummary(
        state: .needsAttention,
        message: "PR #\(pullRequest.number) checks failed",
        action: .openPullRequest
      )
    }

    let activeRuntimes = runtimes.filter(\.isActive)
    if !activeRuntimes.isEmpty {
      let runtimeMessage = activeRuntimes.first?.url ?? activeRuntimes.first?.name
      return WorkspaceOperationalSummary(
        state: .active,
        message: runtimeMessage ?? "Local runtime is active",
        action: activeRuntimes.contains(where: { $0.url != nil }) ? .openRuntime : .resume
      )
    }

    if !git.isClean {
      return WorkspaceOperationalSummary(
        state: .changed,
        message: "\(git.changeCount) uncommitted change\(git.changeCount == 1 ? "" : "s")",
        action: .reviewChanges
      )
    }

    if git.ahead > 0 {
      return WorkspaceOperationalSummary(
        state: .changed,
        message: "\(git.ahead) commit\(git.ahead == 1 ? "" : "s") ready to push",
        action: .push
      )
    }

    if let pullRequest, pullRequest.state.uppercased() != "OPEN" {
      return WorkspaceOperationalSummary(
        state: .quiet,
        message: "PR #\(pullRequest.number) is \(pullRequest.state.lowercased())",
        action: .openPullRequest
      )
    }

    if let pullRequest, pullRequest.isDraft {
      return WorkspaceOperationalSummary(
        state: .waiting,
        message: "Draft PR #\(pullRequest.number)",
        action: .openPullRequest
      )
    }

    if let pullRequest, pullRequest.checks == .pending {
      return WorkspaceOperationalSummary(
        state: .waiting,
        message: "PR #\(pullRequest.number) checks running",
        action: .openPullRequest
      )
    }

    if let pullRequest, pullRequest.checks == .success {
      return WorkspaceOperationalSummary(
        state: .readyToLand,
        message: "PR #\(pullRequest.number) is green",
        action: .openPullRequest
      )
    }

    if let pullRequest {
      return WorkspaceOperationalSummary(
        state: .unknown,
        message: "PR #\(pullRequest.number) checks unknown",
        action: .openPullRequest
      )
    }

    if case .unavailable = github {
      return WorkspaceOperationalSummary(
        state: .unknown,
        message: "GitHub status unavailable",
        action: .reviewStatus
      )
    }

    if !codexThreads.isEmpty {
      return WorkspaceOperationalSummary(
        state: .quiet,
        message: "\(codexThreads.count) resumable Codex task\(codexThreads.count == 1 ? "" : "s")",
        action: .resume
      )
    }

    return WorkspaceOperationalSummary(
      state: .quiet,
      message: "Clean and ready to resume",
      action: .resume
    )
  }
}
