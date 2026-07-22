import Foundation

public struct RepositoryDiscovery: Sendable {
  public init() {}

  public func findRepositories(in roots: [String], maximumDepth: Int = 4) async -> [String] {
    await Task.detached(priority: .userInitiated) {
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
          if relativeDepth > maximumDepth {
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
  }
}
