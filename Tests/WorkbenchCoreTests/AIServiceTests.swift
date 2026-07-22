import Foundation
import Testing

@testable import WorkbenchCore

@Suite("AI context generation")
struct AIServiceTests {
  @Test("pull-request generation uses committed changes on a clean worktree")
  func pullRequestFromCommittedChanges() async throws {
    let runner = PullRequestRunner()
    let service = AIService(runner: runner)

    let response = try await service.generatePullRequestDraft(
      worktreePath: "/repo/feature", base: "main")

    #expect(response.contains("## Summary"))
    let requests = await runner.requests
    #expect(requests.contains { $0.arguments.contains("main...HEAD") })
    #expect(requests.contains { $0.executable == "codex" })
  }

  @Test("untracked inspection includes source but excludes environment secrets")
  func safeUntrackedContent() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try Data("let answer = 42\n".utf8).write(to: directory.appendingPathComponent("New.swift"))
    try Data("API_SECRET=do-not-send\n".utf8).write(
      to: directory.appendingPathComponent(".env.local"))
    try Data("// token = embedded-do-not-send\n".utf8).write(
      to: directory.appendingPathComponent("Token.swift"))
    try Data("registry_token=also-secret\n".utf8).write(
      to: directory.appendingPathComponent(".npmrc"))
    let runner = UntrackedFilesRunner()

    let context = try await GitClient(runner: runner).untrackedFileContents(
      worktreePath: directory.path)

    #expect(context.contains("New.swift"))
    #expect(context.contains("let answer = 42"))
    #expect(context.contains("do-not-send") == false)
    #expect(context.contains("embedded-do-not-send") == false)
    #expect(context.contains("also-secret") == false)
    #expect(context.contains("[REDACTED SENSITIVE LINE]"))
  }
}

private actor PullRequestRunner: CommandRunning {
  private(set) var requests: [CommandRequest] = []

  func run(_ request: CommandRequest) async throws -> CommandResult {
    requests.append(request)
    if request.executable == "codex" {
      return CommandResult(
        exitCode: 0, standardOutput: "## Summary\nAdds checkout", standardError: "")
    }
    if request.arguments.first == "log" {
      return CommandResult(exitCode: 0, standardOutput: "abc123 feat: checkout", standardError: "")
    }
    if request.arguments.first == "diff" {
      return CommandResult(exitCode: 0, standardOutput: "diff --git a/a b/a", standardError: "")
    }
    return CommandResult(exitCode: 1, standardOutput: "", standardError: "unexpected command")
  }
}

private actor UntrackedFilesRunner: CommandRunning {
  func run(_ request: CommandRequest) async throws -> CommandResult {
    CommandResult(
      exitCode: 0,
      standardOutput: "New.swift\n.env.local\nToken.swift\n.npmrc\n",
      standardError: ""
    )
  }
}
