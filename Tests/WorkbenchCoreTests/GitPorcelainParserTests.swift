import Testing

@testable import WorkbenchCore

@Suite("Git porcelain v2 parser")
struct GitPorcelainParserTests {
  @Test("parses branch tracking and every change category")
  func parsesStatus() throws {
    let raw = """
      # branch.oid 0123456789abcdef
      # branch.head feature/checkout
      # branch.upstream origin/feature/checkout
      # branch.ab +2 -3
      1 M. N... 100644 100644 100644 abc def Sources/App.swift
      1 .M N... 100644 100644 100644 abc def README.md
      2 R. N... 100644 100644 100644 abc def R100 new.txt\told.txt
      u UU N... 100644 100644 100644 100644 abc def ghi conflict.txt
      ? notes.txt
      """

    let status = GitPorcelainParser.parseStatus(raw)

    #expect(status.branch == "feature/checkout")
    #expect(status.upstream == "origin/feature/checkout")
    #expect(status.ahead == 2)
    #expect(status.behind == 3)
    #expect(status.staged == 2)
    #expect(status.unstaged == 1)
    #expect(status.untracked == 1)
    #expect(status.conflicted == 1)
    #expect(status.isClean == false)
  }

  @Test("parses detached head and clean status")
  func parsesDetachedCleanStatus() {
    let raw = """
      # branch.oid abcdef
      # branch.head (detached)
      """

    let status = GitPorcelainParser.parseStatus(raw)

    #expect(status.branch == "(detached)")
    #expect(status.isClean)
  }
}
