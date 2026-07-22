import Foundation

public struct WorkflowStep: Sendable, Equatable, Identifiable {
  public let id: UUID
  public let summary: String
  public let command: CommandRequest

  public init(id: UUID = UUID(), summary: String, command: CommandRequest) {
    self.id = id
    self.summary = summary
    self.command = command
  }
}

public struct GitWorkflowPlan: Sendable, Equatable, Identifiable {
  public let id: UUID
  public let title: String
  public let steps: [WorkflowStep]
  public let warnings: [String]

  public init(id: UUID = UUID(), title: String, steps: [WorkflowStep], warnings: [String] = []) {
    self.id = id
    self.title = title
    self.steps = steps
    self.warnings = warnings
  }
}

public enum GitWorkflowError: Error, Equatable, LocalizedError, Sendable {
  case confirmationRequired
  case commandFailed(step: String, message: String)

  public var errorDescription: String? {
    switch self {
    case .confirmationRequired:
      "The workflow must be explicitly confirmed."
    case .commandFailed(let step, let message):
      "\(step) failed: \(message)"
    }
  }
}

public struct GitWorkflowService: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func commitAndPushPlan(
    worktreePath: String,
    message: String,
    stageAll: Bool,
    push: Bool,
    setUpstreamFor branch: String? = nil
  ) -> GitWorkflowPlan {
    var steps: [WorkflowStep] = []
    if stageAll {
      steps.append(
        WorkflowStep(
          summary: "Stage all changes",
          command: CommandRequest(
            executable: "git",
            arguments: ["add", "--all"],
            currentDirectory: worktreePath
          )
        ))
    }
    steps.append(
      WorkflowStep(
        summary: "Commit: \(message)",
        command: CommandRequest(
          executable: "git",
          arguments: ["commit", "-m", message],
          currentDirectory: worktreePath
        )
      ))
    if push {
      steps.append(pushStep(worktreePath: worktreePath, setUpstreamFor: branch))
    }
    return GitWorkflowPlan(title: "Commit changes", steps: steps)
  }

  public func pushPlan(worktreePath: String, setUpstreamFor branch: String? = nil)
    -> GitWorkflowPlan
  {
    return GitWorkflowPlan(
      title: "Push branch",
      steps: [pushStep(worktreePath: worktreePath, setUpstreamFor: branch)]
    )
  }

  public func pullRequestPlan(
    worktreePath: String,
    title: String,
    body: String,
    base: String,
    draft: Bool,
    pushFirst: Bool = false,
    branch: String? = nil
  ) -> GitWorkflowPlan {
    var steps: [WorkflowStep] = []
    if pushFirst {
      steps.append(pushStep(worktreePath: worktreePath, setUpstreamFor: branch))
    }
    var arguments = ["pr", "create", "--title", title, "--body", body, "--base", base]
    if draft { arguments.append("--draft") }
    steps.append(
      WorkflowStep(
        summary: draft ? "Create draft pull request" : "Create pull request",
        command: CommandRequest(
          executable: "gh", arguments: arguments, currentDirectory: worktreePath)
      ))
    return GitWorkflowPlan(title: "Create GitHub pull request", steps: steps)
  }

  @discardableResult
  public func execute(_ plan: GitWorkflowPlan, confirmed: Bool) async throws -> [CommandResult] {
    guard confirmed else { throw GitWorkflowError.confirmationRequired }
    var results: [CommandResult] = []
    for step in plan.steps {
      let result = try await runner.run(step.command)
      guard result.exitCode == 0 else {
        let stderr = result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
        let stdout = result.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = stderr.isEmpty ? stdout : stderr
        throw GitWorkflowError.commandFailed(step: step.summary, message: message)
      }
      results.append(result)
    }
    return results
  }

  private func pushStep(worktreePath: String, setUpstreamFor branch: String?) -> WorkflowStep {
    let arguments = branch.map { ["push", "--set-upstream", "origin", $0] } ?? ["push"]
    return WorkflowStep(
      summary: "Push current branch",
      command: CommandRequest(
        executable: "git", arguments: arguments, currentDirectory: worktreePath)
    )
  }
}
