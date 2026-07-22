import Foundation

public enum GitPorcelainParser {
  public static func parseStatus(_ output: String) -> GitStatus {
    var status = GitStatus()

    for line in output.split(whereSeparator: \.isNewline).map(String.init) {
      if line.hasPrefix("# branch.oid ") {
        status.revision = String(line.dropFirst("# branch.oid ".count))
      } else if line.hasPrefix("# branch.head ") {
        status.branch = String(line.dropFirst("# branch.head ".count))
      } else if line.hasPrefix("# branch.upstream ") {
        status.upstream = String(line.dropFirst("# branch.upstream ".count))
      } else if line.hasPrefix("# branch.ab ") {
        parseTracking(String(line.dropFirst("# branch.ab ".count)), into: &status)
      } else if line.hasPrefix("? ") {
        status.untracked += 1
      } else if line.hasPrefix("u ") {
        status.conflicted += 1
      } else if line.hasPrefix("1 ") || line.hasPrefix("2 ") {
        let fields = line.split(separator: " ", maxSplits: 2)
        guard fields.count > 1 else { continue }
        countXY(String(fields[1]), into: &status)
      }
    }

    return status
  }

  public static func parseWorktrees(_ output: String) -> [WorktreeRegistration] {
    output
      .components(separatedBy: "\n\n")
      .compactMap(parseWorktreeBlock)
  }

  private static func parseWorktreeBlock(_ block: String) -> WorktreeRegistration? {
    var path: String?
    var head: String?
    var branch: String?
    var isBare = false
    var isDetached = false
    var isLocked = false
    var isPrunable = false

    for line in block.split(whereSeparator: \.isNewline).map(String.init) {
      if line.hasPrefix("worktree ") {
        path = String(line.dropFirst("worktree ".count))
      } else if line.hasPrefix("HEAD ") {
        head = String(line.dropFirst("HEAD ".count))
      } else if line.hasPrefix("branch ") {
        let reference = String(line.dropFirst("branch ".count))
        branch =
          reference.hasPrefix("refs/heads/")
          ? String(reference.dropFirst("refs/heads/".count))
          : reference
      } else if line == "bare" {
        isBare = true
      } else if line == "detached" {
        isDetached = true
      } else if line.hasPrefix("locked") {
        isLocked = true
      } else if line.hasPrefix("prunable") {
        isPrunable = true
      }
    }

    guard let path else { return nil }
    return WorktreeRegistration(
      path: path,
      head: head,
      branch: branch,
      isBare: isBare,
      isDetached: isDetached,
      isLocked: isLocked,
      isPrunable: isPrunable
    )
  }

  private static func parseTracking(_ value: String, into status: inout GitStatus) {
    for token in value.split(separator: " ") {
      if token.first == "+" {
        status.ahead = Int(token.dropFirst()) ?? 0
      } else if token.first == "-" {
        status.behind = Int(token.dropFirst()) ?? 0
      }
    }
  }

  private static func countXY(_ xy: String, into status: inout GitStatus) {
    guard xy.count >= 2 else { return }
    let index = xy.index(after: xy.startIndex)
    if xy[xy.startIndex] != "." { status.staged += 1 }
    if xy[index] != "." { status.unstaged += 1 }
  }
}
