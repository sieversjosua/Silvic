import Testing

@testable import WorkbenchCore

@Suite("GitHub pull-request lookup")
struct GitHubServiceTests {
  @Test("legacy successful status contexts are reported as successful")
  func legacyStatusSuccess() async {
    let json = """
      {"number":42,"title":"Feature","state":"OPEN","isDraft":false,
       "url":"https://github.com/acme/repo/pull/42","statusCheckRollup":[{"state":"SUCCESS"}]}
      """
    let lookup = await GitHubService(runner: FixedRunner(output: json)).pullRequest(in: "/repo")

    guard case .found(let pullRequest) = lookup else {
      Issue.record("Expected a pull request")
      return
    }
    #expect(pullRequest.checks == .success)
  }

  @Test("authentication errors remain distinguishable from no pull request")
  func unavailableGitHub() async {
    let lookup = await GitHubService(
      runner: FixedRunner(exitCode: 1, error: "authentication failed")
    ).pullRequest(in: "/repo")

    guard case .unavailable(let message) = lookup else {
      Issue.record("Expected an unavailable result")
      return
    }
    #expect(message == "authentication failed")
  }
}

private struct FixedRunner: CommandRunning {
  let exitCode: Int32
  let output: String
  let error: String

  init(exitCode: Int32 = 0, output: String = "", error: String = "") {
    self.exitCode = exitCode
    self.output = output
    self.error = error
  }

  func run(_ request: CommandRequest) async throws -> CommandResult {
    CommandResult(exitCode: exitCode, standardOutput: output, standardError: error)
  }
}
