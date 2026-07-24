import Foundation

public enum GitHubAuthenticationStatus: Sendable, Equatable {
  case authenticated(username: String)
  case unauthenticated(message: String)
  case unavailable(message: String)
}

public struct GitHubAuthService: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func status() async -> GitHubAuthenticationStatus {
    let result: CommandResult
    do {
      result = try await runner.run(
        CommandRequest(
          executable: "gh",
          arguments: ["api", "--hostname", "github.com", "user", "--jq", ".login"]
        ))
    } catch {
      return .unavailable(message: "GitHub CLI is not available: \(error.localizedDescription)")
    }

    guard result.exitCode == 0 else {
      let output =
        result.standardError.isEmpty
        ? result.standardOutput : result.standardError
      let message = output.trimmingCharacters(in: .whitespacesAndNewlines)
      if result.exitCode == 127 || message.localizedCaseInsensitiveContains("no such file") {
        return .unavailable(message: "GitHub CLI is not available. Install `gh` to sign in.")
      }
      return .unauthenticated(message: message.isEmpty ? "Not signed in to GitHub." : message)
    }

    let username = result.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    return .authenticated(username: username.isEmpty ? "GitHub" : username)
  }

  public func createBrowserLoginCommand(in directory: URL) throws -> URL {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let commandURL = directory.appendingPathComponent("github-login.command")
    try Data(Self.browserLoginScript().utf8).write(to: commandURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: commandURL.path)
    return commandURL
  }

  public static func browserLoginScript() -> String {
    """
    #!/bin/zsh
    export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    clear
    echo "Silvic — Sign in to GitHub"
    echo
    gh auth login --hostname github.com --web
    result=$?
    echo
    if [[ $result -eq 0 ]]; then
      echo "GitHub sign-in completed. You can close this window."
    else
      echo "GitHub sign-in did not complete. Exit code: $result"
    fi
    echo
    read -k 1 "?Press any key to close…"
    exit $result
    """
  }
}
