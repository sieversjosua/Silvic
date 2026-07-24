import Foundation

public enum WorkspaceLocationKind: String, Codable, CaseIterable, Sendable {
  case gitCheckout
  case gitWorktree

  public var displayName: String {
    switch self {
    case .gitCheckout: "Git checkout"
    case .gitWorktree: "Git worktree"
    }
  }

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    switch value {
    case Self.gitCheckout.rawValue, "primaryCheckout", "existingFolder", "fullClone":
      self = .gitCheckout
    case Self.gitWorktree.rawValue:
      self = .gitWorktree
    default:
      throw DecodingError.dataCorruptedError(
        in: try decoder.singleValueContainer(),
        debugDescription: "Unknown Workspace location kind: \(value)"
      )
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public struct WorkspaceID: RawRepresentable, Codable, Hashable, Sendable {
  public let rawValue: String

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public init() {
    self.rawValue = UUID().uuidString
  }

  public init(from decoder: Decoder) throws {
    rawValue = try decoder.singleValueContainer().decode(String.self)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public struct WorkspaceLocation: Codable, Equatable, Sendable {
  public let path: String
  public let kind: WorkspaceLocationKind
  public let fileSystemIdentifier: String?

  public init(
    path: String,
    kind: WorkspaceLocationKind,
    fileSystemIdentifier: String? = nil
  ) {
    self.path = Self.normalize(path)
    self.kind = kind
    self.fileSystemIdentifier =
      fileSystemIdentifier ?? Self.fileSystemIdentifier(for: self.path)
  }

  public static func inferred(path: String, repositoryRoot: String) -> WorkspaceLocation {
    let normalizedPath = normalize(path)
    let normalizedRoot = normalize(repositoryRoot)
    return WorkspaceLocation(
      path: normalizedPath,
      kind: normalizedPath == normalizedRoot ? .gitCheckout : .gitWorktree
    )
  }

  public static func normalize(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.path
  }

  private static func fileSystemIdentifier(for path: String) -> String? {
    guard
      let attributes = try? FileManager.default.attributesOfItem(atPath: path),
      let device = attributes[.systemNumber] as? NSNumber,
      let inode = attributes[.systemFileNumber] as? NSNumber,
      let creationDate = attributes[.creationDate] as? Date
    else { return nil }
    return
      "\(device.uint64Value):\(inode.uint64Value):\(creationDate.timeIntervalSinceReferenceDate)"
  }
}

public struct WorkspaceRecord: Codable, Equatable, Identifiable, Sendable {
  public let id: WorkspaceID
  public var displayName: String
  public var purpose: String?
  public var parentWorkspaceID: WorkspaceID?
  public var repositoryRoot: String?
  public var location: WorkspaceLocation
  public let createdAt: Date
  public var lastSeenAt: Date

  public init(
    id: WorkspaceID = WorkspaceID(),
    displayName: String,
    purpose: String? = nil,
    parentWorkspaceID: WorkspaceID? = nil,
    repositoryRoot: String? = nil,
    location: WorkspaceLocation,
    createdAt: Date = Date(),
    lastSeenAt: Date = Date()
  ) {
    self.id = id
    self.displayName = displayName
    self.purpose = purpose
    self.parentWorkspaceID = parentWorkspaceID
    self.repositoryRoot = repositoryRoot.map(WorkspaceLocation.normalize)
    self.location = location
    self.createdAt = createdAt
    self.lastSeenAt = lastSeenAt
  }
}

struct DiscoveredWorkspace: Sendable {
  let displayName: String
  let repositoryRoot: String
  let location: WorkspaceLocation
}

public actor WorkspaceRegistry {
  private struct Storage: Codable {
    var version: Int
    var workspaces: [WorkspaceRecord]
  }

  private let fileURL: URL
  private var recoveryWarnings: [String] = []

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  func reconcile(
    discovered: [DiscoveredWorkspace],
    at date: Date = Date()
  ) throws -> [String: WorkspaceRecord] {
    var storage = try loadStorage()
    var indexByPath: [String: Int] = [:]
    var indexByFileSystemIdentifier: [String: Int] = [:]
    for index in storage.workspaces.indices {
      let record = storage.workspaces[index]
      indexByPath[WorkspaceLocation.normalize(record.location.path)] = index
      if let identifier = record.location.fileSystemIdentifier {
        indexByFileSystemIdentifier[identifier] = index
      }
    }
    var result: [String: WorkspaceRecord] = [:]

    for candidate in discovered {
      let path = WorkspaceLocation.normalize(candidate.location.path)
      let fingerprintMatch = candidate.location.fileSystemIdentifier.flatMap {
        indexByFileSystemIdentifier[$0]
      }
      let pathMatch = indexByPath[path].flatMap { index -> Int? in
        let existingIdentifier = storage.workspaces[index].location.fileSystemIdentifier
        guard identifiersReferToSameFile(
          existingIdentifier,
          candidate.location.fileSystemIdentifier
        )
        else { return nil }
        return index
      }
      if let index = fingerprintMatch ?? pathMatch {
        storage.workspaces[index].lastSeenAt = date
        storage.workspaces[index].repositoryRoot = WorkspaceLocation.normalize(
          candidate.repositoryRoot)
        storage.workspaces[index].location = candidate.location
        indexByPath[path] = index
        if let identifier = candidate.location.fileSystemIdentifier {
          indexByFileSystemIdentifier[identifier] = index
        }
        result[path] = storage.workspaces[index]
      } else {
        let record = WorkspaceRecord(
          displayName: candidate.displayName,
          repositoryRoot: candidate.repositoryRoot,
          location: candidate.location,
          createdAt: date,
          lastSeenAt: date
        )
        storage.workspaces.append(record)
        indexByPath[path] = storage.workspaces.index(before: storage.workspaces.endIndex)
        result[path] = record
      }
    }

    try save(storage)
    return result
  }

  public func allRecords() throws -> [WorkspaceRecord] {
    try loadStorage().workspaces
  }

  public func updateMetadata(
    atPath path: String,
    displayName: String? = nil,
    purpose: String? = nil,
    parentWorkspaceID: WorkspaceID? = nil
  ) throws {
    var storage = try loadStorage()
    let normalizedPath = WorkspaceLocation.normalize(path)
    guard
      let index = storage.workspaces.firstIndex(where: {
        WorkspaceLocation.normalize($0.location.path) == normalizedPath
      })
    else { return }
    if let displayName { storage.workspaces[index].displayName = displayName }
    if let purpose { storage.workspaces[index].purpose = purpose }
    storage.workspaces[index].parentWorkspaceID = parentWorkspaceID
    try save(storage)
  }

  public func upsertMetadata(
    atPath path: String,
    locationKind: WorkspaceLocationKind,
    repositoryRoot: String,
    displayName: String,
    purpose: String?,
    parentWorkspaceID: WorkspaceID?
  ) throws {
    var storage = try loadStorage()
    let location = WorkspaceLocation(path: path, kind: locationKind)
    let normalizedPath = location.path
    if let index = storage.workspaces.firstIndex(where: {
      WorkspaceLocation.normalize($0.location.path) == normalizedPath
        && identifiersReferToSameFile(
          $0.location.fileSystemIdentifier,
          location.fileSystemIdentifier
        )
    }) {
      storage.workspaces[index].displayName = displayName
      storage.workspaces[index].purpose = purpose
      storage.workspaces[index].parentWorkspaceID = parentWorkspaceID
      storage.workspaces[index].repositoryRoot = WorkspaceLocation.normalize(repositoryRoot)
      storage.workspaces[index].location = location
    } else {
      storage.workspaces.append(
        WorkspaceRecord(
          displayName: displayName,
          purpose: purpose,
          parentWorkspaceID: parentWorkspaceID,
          repositoryRoot: repositoryRoot,
          location: location
        )
      )
    }
    try save(storage)
  }

  func consumeWarnings() -> [String] {
    defer { recoveryWarnings.removeAll() }
    return recoveryWarnings
  }

  private func identifiersReferToSameFile(_ existing: String?, _ candidate: String?) -> Bool {
    guard let existing else { return true }
    guard let candidate else { return false }
    if existing == candidate { return true }

    // Version 1 initially stored only device and inode. At the same path, allow
    // that legacy value to acquire the creation-date component once.
    let existingParts = existing.split(separator: ":")
    let candidateParts = candidate.split(separator: ":")
    return existingParts.count == 2
      && candidateParts.count == 3
      && existingParts[0] == candidateParts[0]
      && existingParts[1] == candidateParts[1]
  }

  private func loadStorage() throws -> Storage {
    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      return Storage(version: 1, workspaces: [])
    }
    let data = try Data(contentsOf: fileURL)
    do {
      let storage = try JSONDecoder().decode(Storage.self, from: data)
      guard storage.version == 1 else {
        throw CocoaError(.fileReadCorruptFile)
      }
      return storage
    } catch {
      let quarantineURL = fileURL.deletingLastPathComponent().appendingPathComponent(
        "\(fileURL.deletingPathExtension().lastPathComponent)-invalid-\(UUID().uuidString).json"
      )
      try FileManager.default.moveItem(at: fileURL, to: quarantineURL)
      recoveryWarnings.append(
        "The Workspace registry was unreadable. Silvic preserved it as "
          + "\(quarantineURL.lastPathComponent) and rebuilt the registry."
      )
      return Storage(version: 1, workspaces: [])
    }
  }

  private func save(_ storage: Storage) throws {
    try FileManager.default.createDirectory(
      at: fileURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(storage).write(to: fileURL, options: .atomic)
  }
}
