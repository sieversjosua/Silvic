import Testing

@testable import WorkbenchCore

@Suite("Git worktree porcelain parser")
struct GitWorktreeParserTests {
  @Test("parses regular, detached, locked and prunable worktrees")
  func parsesWorktrees() {
    let raw = """
      worktree /Users/me/project
      HEAD 1111111
      branch refs/heads/main

      worktree /Users/me/project-feature
      HEAD 2222222
      detached
      locked in use

      worktree /Users/me/old
      HEAD 3333333
      branch refs/heads/old
      prunable gitdir file points to non-existent location

      """

    let worktrees = GitPorcelainParser.parseWorktrees(raw)

    #expect(worktrees.count == 3)
    #expect(worktrees[0].path == "/Users/me/project")
    #expect(worktrees[0].branch == "main")
    #expect(worktrees[1].isDetached)
    #expect(worktrees[1].isLocked)
    #expect(worktrees[2].isPrunable)
  }
}
