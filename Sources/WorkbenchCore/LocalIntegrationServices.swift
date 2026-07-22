import Foundation

public struct WorkCLIService: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func commands() async -> [WorkCLICommand] {
    guard
      let result = try? await runner.run(
        CommandRequest(executable: "work", arguments: ["status", "-a"])),
      result.exitCode == 0
    else { return [] }
    return WorkCLIParser.parseStatus(result.standardOutput)
  }
}

public struct ConvexDiscovery: Sendable {
  public init() {}

  public func deployments(in worktreePath: String, maximumDepth: Int = 4) async
    -> [ConvexDeployment]
  {
    await Task.detached(priority: .utility) {
      let root = URL(fileURLWithPath: worktreePath).standardizedFileURL
      let manager = FileManager.default
      let ignored = Set([".git", ".build", "node_modules", ".next", "vendor"])
      var deployments: [ConvexDeployment] = []

      if let deployment = readDeployment(
        at: root.appendingPathComponent(".env.local"), relativeTo: root)
      {
        deployments.append(deployment)
      }
      guard
        let enumerator = manager.enumerator(
          at: root,
          includingPropertiesForKeys: [.isDirectoryKey],
          options: [.skipsPackageDescendants]
        )
      else { return deployments }

      for case let url as URL in enumerator {
        let depth = url.pathComponents.count - root.pathComponents.count
        if depth > maximumDepth {
          enumerator.skipDescendants()
          continue
        }
        if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
          ignored.contains(url.lastPathComponent)
        {
          enumerator.skipDescendants()
          continue
        }
        guard url.lastPathComponent == ".env.local",
          url != root.appendingPathComponent(".env.local")
        else { continue }
        if let deployment = readDeployment(at: url, relativeTo: root) {
          deployments.append(deployment)
        }
      }
      return Array(Set(deployments.map { $0.id })).compactMap { id in
        deployments.first { $0.id == id }
      }
    }.value
  }
}

private func readDeployment(at url: URL, relativeTo root: URL) -> ConvexDeployment? {
  guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return nil }
  let source = url.path.replacingOccurrences(of: root.path + "/", with: "")
  return EnvironmentFileParser.convexDeployment(from: contents, source: source)
}

public struct CodexThreadService: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func activeThreads() async -> [CodexThread] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let candidates = [
      home.appendingPathComponent(".codex/state_5.sqlite"),
      home.appendingPathComponent(".codex/sqlite/state_5.sqlite"),
    ]
    guard
      let database = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) })
    else { return [] }
    let query = """
      SELECT id, cwd, COALESCE(NULLIF(title, ''), 'Untitled') AS title,
             COALESCE(updated_at_ms, updated_at * 1000) AS updatedAtMilliseconds
      FROM threads
      WHERE archived = 0 AND cwd <> ''
      ORDER BY updatedAtMilliseconds DESC
      LIMIT 500;
      """
    guard
      let result = try? await runner.run(
        CommandRequest(
          executable: "sqlite3",
          arguments: ["-json", database.path, query]
        )), result.exitCode == 0
    else { return [] }
    return (try? JSONDecoder().decode([CodexThread].self, from: Data(result.standardOutput.utf8)))
      ?? []
  }
}

public struct ListeningProcess: Sendable, Equatable {
  public let processID: Int
  public let name: String
  public let cwd: String
  public let url: String
}

public struct ListeningProcessService: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func listeners() async -> [ListeningProcess] {
    guard
      let result = try? await runner.run(
        CommandRequest(
          executable: "lsof",
          arguments: ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]
        ))
    else { return [] }

    let seeds = parseListenerSeeds(result.standardOutput)
    return await withTaskGroup(of: ListeningProcess?.self) { group in
      for seed in seeds {
        group.addTask {
          guard let cwd = await cwd(for: seed.processID, runner: runner) else { return nil }
          return ListeningProcess(
            processID: seed.processID, name: seed.name, cwd: cwd, url: seed.url)
        }
      }
      var listeners: [ListeningProcess] = []
      for await listener in group {
        if let listener { listeners.append(listener) }
      }
      return listeners
    }
  }
}

private struct ListenerSeed: Sendable, Hashable {
  let processID: Int
  let name: String
  let url: String
}

private func parseListenerSeeds(_ output: String) -> [ListenerSeed] {
  var processID: Int?
  var name = "process"
  var seeds = Set<ListenerSeed>()
  for line in output.split(whereSeparator: \.isNewline).map(String.init) {
    guard let marker = line.first else { continue }
    let value = String(line.dropFirst())
    switch marker {
    case "p": processID = Int(value)
    case "c": name = value
    case "n":
      guard let processID,
        let portField = value.split(separator: ":").last,
        let port = Int(portField.prefix { $0.isNumber })
      else { continue }
      seeds.insert(ListenerSeed(processID: processID, name: name, url: "http://localhost:\(port)"))
    default: continue
    }
  }
  return Array(seeds)
}

private func cwd(for processID: Int, runner: any CommandRunning) async -> String? {
  guard
    let result = try? await runner.run(
      CommandRequest(
        executable: "lsof",
        arguments: ["-a", "-p", String(processID), "-d", "cwd", "-Fn"]
      ))
  else { return nil }
  return result.standardOutput
    .split(whereSeparator: \.isNewline)
    .map(String.init)
    .first(where: { $0.hasPrefix("n/") })
    .map { String($0.dropFirst()) }
}
