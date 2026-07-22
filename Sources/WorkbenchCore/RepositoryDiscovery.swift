import Foundation

public struct RepositoryDiscovery: Sendable {
  private let runner: any CommandRunning

  public init(runner: any CommandRunning = LocalCommandRunner()) {
    self.runner = runner
  }

  public func findRepositories(in roots: [String], maximumDepth: Int? = nil) async -> [String] {
    let candidates = await Task.detached(priority: .userInitiated) {
      var repositories = Set<String>()
      let manager = FileManager.default
      let ignored = Set([
        ".git", ".build", "node_modules", "DerivedData", "Pods", "vendor", ".next",
      ])

      for root in roots {
        let rootURL = URL(fileURLWithPath: root).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: rootURL.path, isDirectory: &isDirectory),
          isDirectory.boolValue
        else { continue }

        if manager.fileExists(atPath: rootURL.appendingPathComponent(".git").path) {
          repositories.insert(rootURL.path)
          continue
        }

        guard
          let enumerator = manager.enumerator(
            at: rootURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
          )
        else { continue }

        for case let url as URL in enumerator {
          let relativeDepth = url.pathComponents.count - rootURL.pathComponents.count
          if let maximumDepth, relativeDepth > maximumDepth {
            enumerator.skipDescendants()
            continue
          }
          guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
            continue
          }
          if ignored.contains(url.lastPathComponent) {
            enumerator.skipDescendants()
            continue
          }
          if manager.fileExists(atPath: url.appendingPathComponent(".git").path) {
            repositories.insert(url.standardizedFileURL.path)
            enumerator.skipDescendants()
          }
        }
      }
      return repositories.sorted()
    }.value
    return await canonicalize(candidates)
  }

  private func canonicalize(_ candidates: [String]) async -> [String] {
    await withTaskGroup(of: (String, String).self) { group in
      for candidate in candidates {
        group.addTask {
          let result = try? await runner.run(
            CommandRequest(
              executable: "git",
              arguments: [
                "-C", candidate, "rev-parse", "--path-format=absolute", "--git-common-dir",
              ]
            ))
          guard let result, result.exitCode == 0 else { return (candidate, candidate) }
          let commonDirectory = result.standardOutput.trimmingCharacters(
            in: .whitespacesAndNewlines)
          guard !commonDirectory.isEmpty else { return (candidate, candidate) }
          let commonURL = URL(fileURLWithPath: commonDirectory).standardizedFileURL
          let repositoryPath =
            commonURL.lastPathComponent == ".git"
            ? commonURL.deletingLastPathComponent().path : candidate
          return (commonURL.path, repositoryPath)
        }
      }

      var repositoriesByCommonDirectory: [String: String] = [:]
      for await (commonDirectory, repositoryPath) in group {
        repositoriesByCommonDirectory[commonDirectory] = repositoryPath
      }
      return repositoriesByCommonDirectory.values.sorted()
    }
  }
}
