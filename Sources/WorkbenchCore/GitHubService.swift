import Foundation

public struct GitHubService: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func pullRequest(in worktreePath: String) async -> GitHubPullRequestLookup {
    let result: CommandResult
    do {
      result = try await runner.run(
        CommandRequest(
          executable: "gh",
          arguments: ["pr", "view", "--json", "number,title,state,isDraft,url,statusCheckRollup"],
          currentDirectory: worktreePath
        ))
    } catch {
      return .unavailable(error.localizedDescription)
    }
    guard result.exitCode == 0 else {
      let message = result.standardError.isEmpty ? result.standardOutput : result.standardError
      let normalized = message.lowercased()
      if normalized.contains("no pull request")
        || normalized.contains("could not resolve to a pullrequest")
      {
        return .none
      }
      return .unavailable(message.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    guard
      let response = try? JSONDecoder().decode(
        GHPullRequest.self, from: Data(result.standardOutput.utf8))
    else { return .unavailable("GitHub returned an unreadable pull-request response.") }

    return .found(
      PullRequestSummary(
        number: response.number,
        title: response.title,
        state: response.state,
        isDraft: response.isDraft,
        url: response.url,
        checks: response.checkSummary
      ))
  }
}

private struct GHPullRequest: Decodable {
  struct Check: Decodable {
    let status: String?
    let conclusion: String?
    let state: String?
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
    if statusCheckRollup.contains(where: {
      failing.contains($0.conclusion ?? "") || failing.contains($0.state ?? "")
    }) {
      return .failure
    }
    let pending = Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"])
    if statusCheckRollup.contains(where: {
      pending.contains($0.status ?? "") || pending.contains($0.state ?? "")
    }) {
      return .pending
    }
    let successful = Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
    if statusCheckRollup.allSatisfy({ check in
      successful.contains(check.conclusion ?? "") || successful.contains(check.state ?? "")
    }) {
      return .success
    }
    return .unknown
  }
}
