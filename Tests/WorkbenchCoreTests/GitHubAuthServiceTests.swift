import Testing

@testable import WorkbenchCore

@Suite("GitHub authentication")
struct GitHubAuthServiceTests {
  @Test("authenticated status includes the active GitHub username")
  func authenticatedUser() async {
    let service = GitHubAuthService(runner: AuthenticatedGitHubRunner())

    let status = await service.status()

    #expect(status == .authenticated(username: "octocat"))
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

  @Test("browser login script delegates OAuth and credential storage to GitHub CLI")
  func browserLoginScript() {
    let script = GitHubAuthService.browserLoginScript()

    #expect(script.contains("gh auth login"))
    #expect(script.contains("--web"))
    #expect(script.contains("--hostname github.com"))
    #expect(script.contains("--skip-ssh-key"))
    #expect(script.contains("token") == false)
  }
}

private actor AuthenticatedGitHubRunner: CommandRunning {
  private var callCount = 0

  func run(_ request: CommandRequest) async throws -> CommandResult {
    callCount += 1
    if callCount == 1 {
      return CommandResult(exitCode: 0, standardOutput: "", standardError: "Logged in")
    }
    return CommandResult(exitCode: 0, standardOutput: "octocat\n", standardError: "")
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
