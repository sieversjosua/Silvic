import Foundation

public enum ProjectGrouping {
  public static func identity(origin: String?, rootPath: String) -> String {
    guard let origin, !origin.isEmpty else {
      return WorkspaceLocation.normalize(rootPath)
    }
    var value = origin.trimmingCharacters(in: .whitespacesAndNewlines)
    if let url = URL(string: value), url.isFileURL {
      return WorkspaceLocation.normalize(url.path)
    }
    if value.contains("://"), let url = URL(string: value), let host = url.host {
      let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      let host = host.lowercased()
      let authority = url.port.map { "\(host):\($0)" } ?? host
      value = "\(authority)/\(normalizedRemotePath(path, host: host))"
    } else if let colon = value.firstIndex(of: ":"),
      value[..<colon].contains("@")
    {
      let hostPart = value[..<colon]
      let host = hostPart.split(separator: "@").last.map(String.init) ?? String(hostPart)
      let path = value[value.index(after: colon)...]
      value = "\(host.lowercased())/\(normalizedRemotePath(String(path), host: host))"
    } else if value.hasPrefix("/") || value.hasPrefix("~") {
      return WorkspaceLocation.normalize(
        NSString(string: value).expandingTildeInPath
      )
    }
    if value.hasSuffix(".git") { value.removeLast(4) }
    return value
  }

  private static func normalizedRemotePath(_ path: String, host: String) -> String {
    var path = path
    if path.hasSuffix(".git") { path.removeLast(4) }
    let caseInsensitiveHosts = Set(["github.com", "gitlab.com", "bitbucket.org"])
    return caseInsensitiveHosts.contains(host.lowercased()) ? path.lowercased() : path
  }

  public static func merge(_ repositories: [RepositorySnapshot]) -> [RepositorySnapshot] {
    guard !repositories.isEmpty else { return [] }
    var parents = Array(repositories.indices)

    func root(of index: Int) -> Int {
      var current = index
      while parents[current] != current {
        current = parents[current]
      }
      return current
    }

    func union(_ first: Int, _ second: Int) {
      let firstRoot = root(of: first)
      let secondRoot = root(of: second)
      if firstRoot != secondRoot {
        parents[secondRoot] = firstRoot
      }
    }

    var ownerByIdentity: [String: Int] = [:]
    var ownerByWorkspaceID: [WorkspaceID: Int] = [:]
    for index in repositories.indices {
      if let existing = ownerByIdentity[repositories[index].id] {
        union(existing, index)
      } else {
        ownerByIdentity[repositories[index].id] = index
      }
      for workspace in repositories[index].workspaces {
        ownerByWorkspaceID[workspace.id] = index
      }
    }

    for index in repositories.indices {
      for workspace in repositories[index].workspaces {
        if let parentID = workspace.record.parentWorkspaceID,
          let parentOwner = ownerByWorkspaceID[parentID]
        {
          union(parentOwner, index)
        }
      }
    }

    let components = Dictionary(grouping: repositories.indices, by: root)
    return components.values.map { indices in
      let candidates = indices.map { repositories[$0] }
      let ordered = candidates.sorted {
        if ($0.origin == nil) != ($1.origin == nil) {
          return $0.origin == nil
        }
        return $0.rootPath.localizedStandardCompare($1.rootPath) == .orderedAscending
      }
      let preferred =
        ordered.first {
          $0.workspaces.contains {
            $0.location.kind == .gitCheckout
              && ["main", "master"].contains($0.git.branch)
          }
        }
        ?? ordered[0]
      var seen = Set<WorkspaceID>()
      let workspaces = ordered
        .flatMap(\.workspaces)
        .filter { seen.insert($0.id).inserted }
      return RepositorySnapshot(
        name: preferred.name,
        rootPath: preferred.rootPath,
        origin: preferred.origin,
        workspaces: workspaces
      )
    }
    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }
}
