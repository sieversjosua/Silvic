import Foundation

public enum AIServiceError: LocalizedError, Sendable {
  case noChanges
  case generationFailed(String)
  case emptyResponse

  public var errorDescription: String? {
    switch self {
    case .noChanges: "There are no changes to describe."
    case .generationFailed(let message): "AI generation failed: \(message)"
    case .emptyResponse: "The AI returned an empty response."
    }
  }
}

public struct AIService: Sendable {
  private let runner: any CommandRunning
  private let git: GitClient

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
    self.git = GitClient(runner: runner)
  }

  public func generateCommitMessage(worktreePath: String) async throws -> String {
    let context = try await changeContext(worktreePath: worktreePath)
    let prompt = """
      Write one precise Conventional Commit subject for the changes below.
      Output exactly one line, without quotes, markdown, explanation, or a trailing period.
      Do not modify files or run commands.

      \(context)
      """
    let response = try await generate(prompt: prompt, worktreePath: worktreePath)
    guard let firstLine = response.split(whereSeparator: \.isNewline).first else {
      throw AIServiceError.emptyResponse
    }
    return String(firstLine).trimmingCharacters(in: CharacterSet(charactersIn: "\"' `"))
  }

  public func generatePullRequestDraft(worktreePath: String, base: String = "main") async throws
    -> String
  {
    let commits = (try? await git.log(worktreePath: worktreePath, base: base)) ?? ""
    let diff = (try? await git.diff(worktreePath: worktreePath, fromBase: base)) ?? ""
    guard
      !commits.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { throw AIServiceError.noChanges }
    let prompt = """
      Draft a concise GitHub pull request in Markdown for the changes below.
      Use exactly these headings: Summary, Testing, Risks. Do not modify files or run commands.

      Commits:
      \(commits)

      Changes:
      \(String(diff.prefix(80_000)))
      """
    return try await generate(prompt: prompt, worktreePath: worktreePath)
  }

  private func changeContext(worktreePath: String) async throws -> String {
    let staged = try await git.diff(worktreePath: worktreePath, staged: true)
    let unstaged = try await git.diff(worktreePath: worktreePath)
    let status = try await git.shortStatus(worktreePath: worktreePath)
    let untracked = try await git.untrackedFileContents(worktreePath: worktreePath)
    let combined =
      "Status:\n\(status)\n\nStaged diff:\n\(staged)\n\nUnstaged diff:\n\(unstaged)\n\nUntracked files:\n\(untracked)"
    guard !status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw AIServiceError.noChanges
    }
    return String(combined.prefix(80_000))
  }

  private func generate(prompt: String, worktreePath: String) async throws -> String {
    let result = try await runner.run(
      CommandRequest(
        executable: "codex",
        arguments: ["exec", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-"],
        currentDirectory: worktreePath,
        standardInput: prompt
      ))
    guard result.exitCode == 0 else {
      let error = result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
      throw AIServiceError.generationFailed(error)
    }
    let response = result.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !response.isEmpty else { throw AIServiceError.emptyResponse }
    return response
  }
}
