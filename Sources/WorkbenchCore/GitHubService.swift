import Foundation

public struct GitHubService: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func pullRequest(in worktreePath: String) async -> PullRequestSummary? {
    guard
      let result = try? await runner.run(
        CommandRequest(
          executable: "gh",
          arguments: ["pr", "view", "--json", "number,title,state,isDraft,url,statusCheckRollup"],
          currentDirectory: worktreePath
        )), result.exitCode == 0,
      let response = try? JSONDecoder().decode(
        GHPullRequest.self, from: Data(result.standardOutput.utf8))
    else { return nil }

    return PullRequestSummary(
      number: response.number,
      title: response.title,
      state: response.state,
      isDraft: response.isDraft,
      url: response.url,
      checks: response.checkSummary
    )
  }
}

private struct GHPullRequest: Decodable {
  struct Check: Decodable {
    let status: String?
    let conclusion: String?
  }

  let number: Int
  let title: String
  let state: String
  let isDraft: Bool
  let url: String
  let statusCheckRollup: [Check]

  var checkSummary: PullRequestSummary.Checks {
    guard !statusCheckRollup.isEmpty else { return .unknown }
    let failing = Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"])
    if statusCheckRollup.contains(where: { failing.contains($0.conclusion ?? "") }) {
      return .failure
    }
    if statusCheckRollup.contains(where: {
      $0.status != "COMPLETED" || ($0.conclusion ?? "").isEmpty
    }) {
      return .pending
    }
    return .success
  }
}
