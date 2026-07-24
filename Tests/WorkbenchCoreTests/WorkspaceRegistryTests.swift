import Foundation
import Testing

@testable import WorkbenchCore

@Suite("Workspace registry")
struct WorkspaceRegistryTests {
  @Test("reconciliation preserves a durable identity for the same location")
  func preservesIdentity() async throws {
    let fixture = try Fixture()
    defer { fixture.remove() }
    let registry = WorkspaceRegistry(fileURL: fixture.registryURL)
    let discovered = DiscoveredWorkspace(
      displayName: "feature",
      repositoryRoot: fixture.root.appendingPathComponent("repo").path,
      location: WorkspaceLocation(
        path: fixture.root.appendingPathComponent("feature").path,
        kind: .gitWorktree
      )
    )

    let first = try await registry.reconcile(
      discovered: [discovered],
      at: Date(timeIntervalSince1970: 10)
    )
    let second = try await registry.reconcile(
      discovered: [discovered],
      at: Date(timeIntervalSince1970: 20)
    )
    let path = WorkspaceLocation.normalize(discovered.location.path)

    #expect(first[path]?.id == second[path]?.id)
    #expect(second[path]?.createdAt == Date(timeIntervalSince1970: 10))
    #expect(second[path]?.lastSeenAt == Date(timeIntervalSince1970: 20))
  }

  @Test("location inference keeps normal checkouts independent from worktrees")
  func infersLocationKinds() {
    let repository = "/tmp/example"

    #expect(
      WorkspaceLocation.inferred(path: repository, repositoryRoot: repository).kind
        == .gitCheckout)
    #expect(
      WorkspaceLocation.inferred(path: "/tmp/example-feature", repositoryRoot: repository).kind
        == .gitWorktree)
    #expect(
      WorkspaceLocation(path: "/tmp/clone", kind: .gitCheckout).kind == .gitCheckout)
  }

  @Test("records persist on disk")
  func persistsRecords() async throws {
    let fixture = try Fixture()
    defer { fixture.remove() }
    let candidate = DiscoveredWorkspace(
      displayName: "main",
      repositoryRoot: fixture.root.appendingPathComponent("repo").path,
      location: WorkspaceLocation(
        path: fixture.root.appendingPathComponent("repo").path,
        kind: .gitCheckout
      )
    )
    let firstRegistry = WorkspaceRegistry(fileURL: fixture.registryURL)
    _ = try await firstRegistry.reconcile(discovered: [candidate])

    let reopenedRegistry = WorkspaceRegistry(fileURL: fixture.registryURL)
    let records = try await reopenedRegistry.allRecords()

    #expect(records.count == 1)
    #expect(records[0].displayName == "main")
    #expect(records[0].location.kind == .gitCheckout)
  }

  @Test("created environment metadata records purpose and parent lineage")
  func recordsCreatedEnvironmentMetadata() async throws {
    let fixture = try Fixture()
    defer { fixture.remove() }
    let childPath = fixture.root.appendingPathComponent("feature").path
    let registry = WorkspaceRegistry(fileURL: fixture.registryURL)
    _ = try await registry.reconcile(
      discovered: [
        DiscoveredWorkspace(
          displayName: "agent/auth",
          repositoryRoot: fixture.root.path,
          location: WorkspaceLocation(path: childPath, kind: .gitWorktree)
        )
      ])
    let parentID = WorkspaceID(rawValue: "parent")

    try await registry.updateMetadata(
      atPath: childPath,
      displayName: "Authentication",
      purpose: "Fix the sign-in race",
      parentWorkspaceID: parentID
    )
    let record = try #require(try await registry.allRecords().first)

    #expect(record.displayName == "Authentication")
    #expect(record.purpose == "Fix the sign-in race")
    #expect(record.parentWorkspaceID == parentID)
  }

  @Test("creation metadata is upserted before discovery can race")
  func upsertsCreationMetadata() async throws {
    let fixture = try Fixture()
    defer { fixture.remove() }
    let childPath = fixture.root.appendingPathComponent("new-worktree").path
    try FileManager.default.createDirectory(
      atPath: childPath,
      withIntermediateDirectories: true
    )
    let registry = WorkspaceRegistry(fileURL: fixture.registryURL)
    let parentID = WorkspaceID(rawValue: "parent")

    try await registry.upsertMetadata(
      atPath: childPath,
      locationKind: .gitWorktree,
      repositoryRoot: fixture.root.path,
      displayName: "Payments",
      purpose: "Fix payments",
      parentWorkspaceID: parentID
    )
    let record = try #require(try await registry.allRecords().first)

    #expect(record.displayName == "Payments")
    #expect(record.location.kind == .gitWorktree)
    #expect(record.parentWorkspaceID == parentID)
  }

  @Test("creation at a reused path receives a fresh workspace identity")
  func upsertRejectsStalePathIdentity() async throws {
    let fixture = try Fixture()
    defer { fixture.remove() }
    let child = fixture.root.appendingPathComponent("task", isDirectory: true)
    try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
    let registry = WorkspaceRegistry(fileURL: fixture.registryURL)
    let discovered = DiscoveredWorkspace(
      displayName: "old",
      repositoryRoot: fixture.root.path,
      location: WorkspaceLocation(path: child.path, kind: .gitWorktree)
    )
    let first = try await registry.reconcile(discovered: [discovered])
    let oldID = try #require(first[child.path]?.id)

    try FileManager.default.removeItem(at: child)
    try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
    try await registry.upsertMetadata(
      atPath: child.path,
      locationKind: .gitWorktree,
      repositoryRoot: fixture.root.path,
      displayName: "new",
      purpose: nil,
      parentWorkspaceID: nil
    )

    let records = try await registry.allRecords()
    let replacement = try #require(records.last { $0.displayName == "new" })
    #expect(replacement.id != oldID)
  }

  @Test("filesystem identity follows a moved checkout without reusing its old path")
  func followsMovesAndRejectsPathReuse() async throws {
    let fixture = try Fixture()
    defer { fixture.remove() }
    let original = fixture.root.appendingPathComponent("original", isDirectory: true)
    let moved = fixture.root.appendingPathComponent("moved", isDirectory: true)
    try FileManager.default.createDirectory(at: original, withIntermediateDirectories: true)
    let registry = WorkspaceRegistry(fileURL: fixture.registryURL)
    let firstCandidate = DiscoveredWorkspace(
      displayName: "main",
      repositoryRoot: original.path,
      location: WorkspaceLocation(path: original.path, kind: .gitCheckout)
    )
    let first = try await registry.reconcile(discovered: [firstCandidate])
    let firstID = try #require(first[original.path]?.id)

    try FileManager.default.moveItem(at: original, to: moved)
    try FileManager.default.createDirectory(at: original, withIntermediateDirectories: true)
    let movedCandidate = DiscoveredWorkspace(
      displayName: "main",
      repositoryRoot: moved.path,
      location: WorkspaceLocation(path: moved.path, kind: .gitCheckout)
    )
    let replacementCandidate = DiscoveredWorkspace(
      displayName: "replacement",
      repositoryRoot: original.path,
      location: WorkspaceLocation(path: original.path, kind: .gitCheckout)
    )
    let second = try await registry.reconcile(
      discovered: [movedCandidate, replacementCandidate])

    #expect(second[moved.path]?.id == firstID)
    #expect(second[original.path]?.id != firstID)
  }

  @Test("malformed storage is quarantined instead of crashing")
  func recoversMalformedStorage() async throws {
    let fixture = try Fixture()
    defer { fixture.remove() }
    try Data("not json".utf8).write(to: fixture.registryURL)
    let registry = WorkspaceRegistry(fileURL: fixture.registryURL)

    let records = try await registry.allRecords()
    let warnings = await registry.consumeWarnings()
    let files = try FileManager.default.contentsOfDirectory(
      at: fixture.root,
      includingPropertiesForKeys: nil
    )

    #expect(records.isEmpty)
    #expect(warnings.count == 1)
    #expect(files.contains { $0.lastPathComponent.hasPrefix("workspaces-invalid-") })
  }

  @Test("legacy checkout kinds migrate to the unified checkout location")
  func migratesLegacyLocationKind() throws {
    let data = Data(
      #"{"path":"/tmp/repo","kind":"primaryCheckout"}"#.utf8
    )

    let location = try JSONDecoder().decode(WorkspaceLocation.self, from: data)

    #expect(location.kind == .gitCheckout)
  }
}

private struct Fixture {
  let root: URL
  let registryURL: URL

  init() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    registryURL = root.appendingPathComponent("workspaces.json")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  func remove() {
    try? FileManager.default.removeItem(at: root)
  }
}
