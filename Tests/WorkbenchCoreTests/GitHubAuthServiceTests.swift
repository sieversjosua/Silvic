import Testing

@testable import WorkbenchCore

@Suite("GitHub authentication")
struct GitHubAuthServiceTests {
  @Test("authenticated status includes the active GitHub username")
  func authenticatedUser() async {
    let runner = RecordingGitHubRunner(
      result: CommandResult(exitCode: 0, standardOutput: "octocat\n", standardError: ""))
    let service = GitHubAuthService(runner: runner)

    let status = await service.status()

    #expect(status == .authenticated(username: "octocat"))
    #expect(
      await runner.requests == [
        CommandRequest(
          executable: "gh",
          arguments: ["api", "--hostname", "github.com", "user", "--jq", ".login"]
        )
      ])
  }

  @Test("missing authentication is distinct from a missing CLI")
  func unauthenticatedUser() async {
    let service = GitHubAuthService(runner: UnauthenticatedGitHubRunner())

    let status = await service.status()

    guard case .unauthenticated(let message) = status else {
      Issue.record("Expected unauthenticated status")
      return
    }
    #expect(message.contains("not logged"))
  }

  @Test("a missing GitHub CLI is reported as unavailable")
  func missingCLI() async {
    let service = GitHubAuthService(runner: MissingGitHubRunner())

    let status = await service.status()

    guard case .unavailable(let message) = status else {
      Issue.record("Expected unavailable status")
      return
    }
    #expect(message.contains("not available"))
  }

  @Test("browser login script delegates OAuth and credential storage to GitHub CLI")
  func browserLoginScript() {
    let script = GitHubAuthService.browserLoginScript()

    #expect(script.contains("gh auth login"))
    #expect(script.contains("--web"))
    #expect(script.contains("--hostname github.com"))
    #expect(script.contains("--skip-ssh-key") == false)
    #expect(script.contains("token") == false)
    #expect(script.contains("--git-protocol") == false)
    #expect(script.contains("export PATH=\"$PATH:"))
  }
}

private actor RecordingGitHubRunner: CommandRunning {
  let result: CommandResult
  private(set) var requests: [CommandRequest] = []

  init(result: CommandResult) {
    self.result = result
  }

  func run(_ request: CommandRequest) async throws -> CommandResult {
    requests.append(request)
    return result
  }
}

private struct UnauthenticatedGitHubRunner: CommandRunning {
  func run(_ request: CommandRequest) async throws -> CommandResult {
    CommandResult(
      exitCode: 1,
      standardOutput: "",
      standardError: "You are not logged into any GitHub hosts"
    )
  }
}

private struct MissingGitHubRunner: CommandRunning {
  func run(_ request: CommandRequest) async throws -> CommandResult {
    CommandResult(
      exitCode: 127,
      standardOutput: "",
      standardError: "env: gh: No such file or directory"
    )
  }
}
