import Foundation
import Testing

@testable import WorkbenchCore

@Suite("Confirmed Git workflows")
struct GitWorkflowTests {
  @Test("a plan is inert until explicitly confirmed")
  func requiresConfirmation() async throws {
    let runner = RecordingCommandRunner()
    let service = GitWorkflowService(runner: runner)
    let plan = service.commitAndPushPlan(
      worktreePath: "/repo/feature",
      message: "fix: preserve checkout",
      stageAll: true,
      push: true
    )

    #expect(
      plan.steps.map(\.summary) == [
        "Stage all changes",
        "Commit: fix: preserve checkout",
        "Push current branch",
      ])

    await #expect(throws: GitWorkflowError.confirmationRequired) {
      try await service.execute(plan, confirmed: false)
    }
    #expect(await runner.requests.isEmpty)

    _ = try await service.execute(plan, confirmed: true)

    let requests = await runner.requests
    #expect(
      requests.map(\.arguments) == [
        ["add", "--all"],
        ["commit", "-m", "fix: preserve checkout"],
        ["push"],
      ])
    #expect(requests.allSatisfy { $0.currentDirectory == "/repo/feature" })
  }

  @Test("commit and push configures the upstream for a new branch")
  func configuresUpstream() {
    let service = GitWorkflowService(runner: RecordingCommandRunner())

    let plan = service.commitAndPushPlan(
      worktreePath: "/repo/feature",
      message: "feat: add checkout",
      stageAll: true,
      push: true,
      setUpstreamFor: "feature/checkout"
    )

    #expect(
      plan.steps.last?.command.arguments
        == ["push", "--set-upstream", "origin", "feature/checkout"])
  }
}

private actor RecordingCommandRunner: CommandRunning {
  private(set) var requests: [CommandRequest] = []

  func run(_ request: CommandRequest) async throws -> CommandResult {
    requests.append(request)
    return CommandResult(exitCode: 0, standardOutput: "", standardError: "")
  }
}
