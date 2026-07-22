import Foundation
import Testing

@testable import WorkbenchCore

@Suite("Repository discovery")
struct RepositoryDiscoveryTests {
  @Test("linked worktrees collapse to one canonical repository")
  func deduplicatesLinkedWorktrees() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let main = root.appendingPathComponent("main", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let runner = LocalCommandRunner()

    try await runGit(["init", "-b", "main", main.path], at: root.path, runner: runner)
    try await runGit(["config", "user.email", "test@example.com"], at: main.path, runner: runner)
    try await runGit(["config", "user.name", "Test"], at: main.path, runner: runner)
    try await runGit(["commit", "--allow-empty", "-m", "Initial"], at: main.path, runner: runner)
    try await runGit(
      ["worktree", "add", root.appendingPathComponent("feature").path, "-b", "feature"],
      at: main.path,
      runner: runner
    )

    let repositories = await RepositoryDiscovery(runner: runner).findRepositories(in: [root.path])

    #expect(repositories == [main.path])
  }

  private func runGit(_ arguments: [String], at path: String, runner: LocalCommandRunner)
    async throws
  {
    let result = try await runner.run(
      CommandRequest(executable: "git", arguments: arguments, currentDirectory: path))
    guard result.exitCode == 0 else {
      throw TestCommandError.failed(result.standardError)
    }
  }
}

private enum TestCommandError: Error {
  case failed(String)
}
