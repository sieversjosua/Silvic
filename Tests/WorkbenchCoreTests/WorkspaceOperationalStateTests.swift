import Foundation
import Testing

@testable import WorkbenchCore

@Suite("Workspace operational state")
struct WorkspaceOperationalStateTests {
  @Test("conflicts take priority over every other state")
  func conflictsNeedAttention() {
    let workspace = makeWorkspace(
      git: GitStatus(branch: "feature", unstaged: 2, conflicted: 1),
      runtimes: [
        LocalRuntime(
          name: "dev",
          url: "http://localhost:3000",
          status: "running",
          source: .process
        )
      ]
    )

    #expect(workspace.operationalSummary.state == .needsAttention)
    #expect(workspace.operationalSummary.action == .inspect)
  }

  @Test("running environments are active")
  func runtimeIsActive() {
    let workspace = makeWorkspace(
      runtimes: [
        LocalRuntime(
          name: "dev",
          url: "http://localhost:4312",
          status: "running",
          source: .process
        )
      ]
    )

    #expect(workspace.operationalSummary.state == .active)
    #expect(workspace.operationalSummary.action == .openRuntime)
  }

  @Test("stopped commands and resumable sessions are not reported as active")
  func inactiveResourcesAreNotActive() {
    let workspace = makeWorkspace(
      runtimes: [
        LocalRuntime(name: "dev", status: "stopped", source: .workCLI)
      ],
      codexThreads: [
        CodexThread(id: "thread", cwd: "/tmp/workspace", title: "Old task", updatedAtMilliseconds: 0)
      ]
    )

    #expect(workspace.operationalSummary.state == .quiet)
    #expect(workspace.operationalSummary.message == "1 resumable Codex task")
  }

  @Test("local changes are ready for review")
  func changesNeedReview() {
    let workspace = makeWorkspace(
      git: GitStatus(branch: "feature", staged: 1, untracked: 2)
    )

    #expect(workspace.operationalSummary.state == .changed)
    #expect(workspace.operationalSummary.message == "3 uncommitted changes")
  }

  @Test(
    "pull request check states map to attention waiting and ready",
    arguments: [
      (PullRequestSummary.Checks.failure, WorkspaceOperationalState.needsAttention),
      (.pending, .waiting),
      (.success, .readyToLand),
    ])
  func pullRequestStates(
    checks: PullRequestSummary.Checks,
    expected: WorkspaceOperationalState
  ) {
    let pullRequest = PullRequestSummary(
      number: 42,
      title: "Feature",
      state: "OPEN",
      isDraft: false,
      url: "https://github.com/example/repo/pull/42",
      checks: checks
    )

    #expect(makeWorkspace(github: .found(pullRequest)).operationalSummary.state == expected)
  }

  @Test("draft, closed and unverifiable pull requests are never ready to land")
  func pullRequestReadinessRequiresOpenNondraftVerifiedPR() {
    let draft = pullRequest(state: "OPEN", isDraft: true, checks: .success)
    let closed = pullRequest(state: "CLOSED", checks: .success)
    let unknown = pullRequest(state: "OPEN", checks: .unknown)

    #expect(makeWorkspace(github: .found(draft)).operationalSummary.state == .waiting)
    #expect(makeWorkspace(github: .found(closed)).operationalSummary.state == .quiet)
    #expect(makeWorkspace(github: .found(unknown)).operationalSummary.state == .unknown)
    let unavailable = makeWorkspace(github: .unavailable("offline")).operationalSummary
    #expect(unavailable.state == .unknown)
    #expect(unavailable.action == .reviewStatus)
  }

  @Test("a clean inactive checkout is ready to resume")
  func cleanIsQuiet() {
    let summary = makeWorkspace().operationalSummary

    #expect(summary.state == .quiet)
    #expect(summary.action == .resume)
  }

  private func makeWorkspace(
    git: GitStatus = GitStatus(branch: "main"),
    runtimes: [LocalRuntime] = [],
    codexThreads: [CodexThread] = [],
    github: GitHubPullRequestLookup = .none
  ) -> WorkspaceSnapshot {
    WorkspaceSnapshot(
      record: WorkspaceRecord(
        displayName: "Workspace",
        location: WorkspaceLocation(path: "/tmp/workspace", kind: .gitCheckout)
      ),
      repositoryName: "repo",
      git: git,
      runtimes: runtimes,
      codexThreads: codexThreads,
      github: github
    )
  }

  private func pullRequest(
    state: String,
    isDraft: Bool = false,
    checks: PullRequestSummary.Checks
  ) -> PullRequestSummary {
    PullRequestSummary(
      number: 42,
      title: "Feature",
      state: state,
      isDraft: isDraft,
      url: "https://github.com/example/repo/pull/42",
      checks: checks
    )
  }
}
