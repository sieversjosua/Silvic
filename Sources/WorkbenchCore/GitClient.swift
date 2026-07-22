import Foundation

public enum GitClientError: LocalizedError, Sendable {
  case commandFailed(String)

  public var errorDescription: String? {
    switch self {
    case .commandFailed(let message): message
    }
  }
}

public struct GitClient: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func worktrees(repositoryPath: String) async throws -> [WorktreeRegistration] {
    let output = try await git(["worktree", "list", "--porcelain"], at: repositoryPath)
    return GitPorcelainParser.parseWorktrees(output)
  }

  public func status(worktreePath: String) async throws -> GitStatus {
    let output = try await git(["status", "--porcelain=v2", "--branch"], at: worktreePath)
    return GitPorcelainParser.parseStatus(output)
  }

  public func origin(worktreePath: String) async -> String? {
    try? await git(["remote", "get-url", "origin"], at: worktreePath)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public func diff(worktreePath: String, staged: Bool = false) async throws -> String {
    var arguments = ["diff"]
    if staged { arguments.append("--cached") }
    arguments.append(contentsOf: ["--", "."])
    return try await git(arguments, at: worktreePath)
  }

  public func diff(worktreePath: String, fromBase base: String) async throws -> String {
    try await git(["diff", "\(base)...HEAD", "--", "."], at: worktreePath)
  }

  public func untrackedFiles(worktreePath: String) async throws -> [String] {
    let output = try await git(["ls-files", "--others", "--exclude-standard"], at: worktreePath)
    return output.split(whereSeparator: \.isNewline).map(String.init)
  }

  public func untrackedFileContents(
    worktreePath: String,
    maximumFileBytes: Int = 24_000,
    maximumTotalBytes: Int = 60_000
  ) async throws -> String {
    let files = try await untrackedFiles(worktreePath: worktreePath)
    return await Task.detached(priority: .utility) {
      let root = URL(fileURLWithPath: worktreePath).standardizedFileURL.resolvingSymlinksInPath()
      var remainingBytes = maximumTotalBytes
      var previews: [String] = []
      let sensitiveFragments = [".env", "credential", "secret", "private-key", "private_key"]

      for relativePath in files where remainingBytes > 0 {
        let lowercasedPath = relativePath.lowercased()
        guard !sensitiveFragments.contains(where: lowercasedPath.contains) else { continue }
        let url = root.appendingPathComponent(relativePath).standardizedFileURL
          .resolvingSymlinksInPath()
        guard url.path.hasPrefix(root.path + "/"),
          let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
          values.isRegularFile == true,
          let fileSize = values.fileSize,
          fileSize <= maximumFileBytes,
          let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
          String(data: data, encoding: .utf8) != nil
        else { continue }
        let allowedBytes = min(remainingBytes, data.count)
        let bounded = String(decoding: data.prefix(allowedBytes), as: UTF8.self)
        previews.append("New file: \(relativePath)\n\(bounded)")
        remainingBytes -= allowedBytes
      }
      return previews.joined(separator: "\n\n")
    }.value
  }

  public func shortStatus(worktreePath: String) async throws -> String {
    try await git(["status", "--short"], at: worktreePath)
  }

  public func log(worktreePath: String, base: String = "main", limit: Int = 30) async throws
    -> String
  {
    try await git(
      ["log", "--format=%h %s", "--max-count=\(limit)", "\(base)..HEAD"],
      at: worktreePath
    )
  }

  private func git(_ arguments: [String], at path: String) async throws -> String {
    let result = try await runner.run(
      CommandRequest(
        executable: "git",
        arguments: arguments,
        currentDirectory: path,
        environment: ["GIT_OPTIONAL_LOCKS": "0"]
      ))
    guard result.exitCode == 0 else {
      let message = result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
      throw GitClientError.commandFailed(
        message.isEmpty ? "git exited with \(result.exitCode)" : message)
    }
    return result.standardOutput
  }
}
