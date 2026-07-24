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

  @Test("worktree creation is represented as one confirmable Git operation")
  func createsWorktreePlan() {
    let service = GitWorkflowService(runner: RecordingCommandRunner())

    let plan = service.createWorktreePlan(
      repositoryPath: "/projects/app",
      destinationPath: "/projects/app-auth",
      branch: "agent/auth",
      base: "main"
    )

    #expect(plan.title == "Create task environment")
    #expect(plan.steps.count == 1)
    #expect(plan.steps[0].command.executable == "git")
    #expect(
      plan.steps[0].command.arguments
        == ["worktree", "add", "-b", "agent/auth", "/projects/app-auth", "main"])
    #expect(plan.steps[0].command.currentDirectory == "/projects/app")
  }

  @Test("independent clone creation preserves the real origin and creates a task branch")
  func createsIndependentClonePlan() {
    let service = GitWorkflowService(runner: RecordingCommandRunner())

    let plan = service.createClonePlan(
      sourceRepositoryPath: "/projects/app",
      origin: "git@github.com:example/app.git",
      destinationPath: "/projects/app-auth",
      branch: "agent/auth",
      base: "main"
    )

    #expect(plan.steps.map(\.command.arguments) == [
      ["clone", "--no-checkout", "/projects/app", "/projects/app-auth"],
      ["remote", "set-url", "origin", "git@github.com:example/app.git"],
      ["switch", "-c", "agent/auth", "main"],
    ])
    #expect(plan.steps[1].command.currentDirectory == "/projects/app-auth")
    #expect(plan.steps[2].command.currentDirectory == "/projects/app-auth")
  }

  @Test("local branch preflight distinguishes free and occupied names")
  func checksLocalBranchExistence() async throws {
    let occupiedRunner = RecordingCommandRunner(exitCode: 0)
    let freeRunner = RecordingCommandRunner(exitCode: 1)

    #expect(
      try await GitClient(runner: occupiedRunner).localBranchExists(
        worktreePath: "/projects/app",
        branch: "agent/auth"
      ))
    #expect(
      try await !GitClient(runner: freeRunner).localBranchExists(
        worktreePath: "/projects/app",
        branch: "agent/auth"
      ))
    let request = try #require(await occupiedRunner.requests.first)
    #expect(
      request.arguments
        == ["show-ref", "--verify", "--quiet", "refs/heads/agent/auth"])
    #expect(request.currentDirectory == "/projects/app")
  }

  @Test(
    "branch validation rejects refs Git cannot create",
    arguments: [
      "foo..bar", ".bad", "foo.lock", "feature/@{bad", "has space", "@", "trailing/",
      "foo/.bar", "foo/bar.lock/baz", "-danger",
    ]
  )
  func rejectsInvalidBranchNames(_ branch: String) {
    #expect(!GitReference.isValidBranchName(branch))
    #expect(GitReference.isValidBranchName("agent/fix-payments"))
  }
}

private actor RecordingCommandRunner: CommandRunning {
  private(set) var requests: [CommandRequest] = []
  private let exitCode: Int32

  init(exitCode: Int32 = 0) {
    self.exitCode = exitCode
  }

  func run(_ request: CommandRequest) async throws -> CommandResult {
    requests.append(request)
    return CommandResult(exitCode: exitCode, standardOutput: "", standardError: "")
  }
}
