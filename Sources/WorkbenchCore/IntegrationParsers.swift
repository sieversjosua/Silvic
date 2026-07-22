import Foundation

public enum WorkCLIParser {
  public static func parseStatus(_ output: String) -> [WorkCLICommand] {
    output
      .split(whereSeparator: \.isNewline)
      .map(String.init)
      .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
      .filter { !$0.lowercased().hasPrefix("status ") }
      .compactMap(parseRow)
  }

  private static func parseRow(_ row: String) -> WorkCLICommand? {
    let columns = row.split(whereSeparator: \.isWhitespace).map(String.init)
    guard columns.count >= 5 else { return nil }
    let scope = columns[1].split(separator: "/", maxSplits: 1).map(String.init)
    guard scope.count == 2 else { return nil }
    return WorkCLICommand(
      status: columns[0],
      project: scope[0],
      workspace: scope[1],
      command: columns[2],
      runner: columns[3],
      handle: columns[4],
      url: columns.count > 5 ? columns[5] : nil
    )
  }
}

public enum EnvironmentFileParser {
  public static func convexDeployment(from contents: String, source: String) -> ConvexDeployment? {
    let values = parse(contents)
    guard let identifier = values["CONVEX_DEPLOYMENT"], !identifier.isEmpty else { return nil }
    let parts = identifier.split(separator: ":", maxSplits: 1).map(String.init)
    let kind = parts.count == 2 ? parts[0] : "unknown"
    let name = parts.count == 2 ? parts[1] : parts[0]
    return ConvexDeployment(kind: kind, name: name, url: values["CONVEX_URL"], source: source)
  }

  private static func parse(_ contents: String) -> [String: String] {
    var result: [String: String] = [:]
    for rawLine in contents.split(whereSeparator: \.isNewline) {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      guard !line.hasPrefix("#"), let separator = line.firstIndex(of: "=") else { continue }
      let key = String(line[..<separator]).trimmingCharacters(in: .whitespaces)
      var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
      if value.count >= 2,
        value.hasPrefix("\"") && value.hasSuffix("\"")
          || value.hasPrefix("'") && value.hasSuffix("'")
      {
        value.removeFirst()
        value.removeLast()
      }
      result[key] = value
    }
    return result
  }
}
