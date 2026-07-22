import Foundation

public enum AIContextSanitizer {
  private static let allowedSourceExtensions = Set([
    "c", "cc", "cpp", "css", "go", "h", "hpp", "html", "java", "js", "jsx", "kt", "kts",
    "m", "md", "mm", "php", "py", "rb", "rs", "scss", "sh", "sql", "swift", "txt", "ts",
    "tsx", "vue",
  ])
  private static let deniedNames = Set([
    ".npmrc", ".pypirc", "auth.json", "credentials", "credentials.json", "id_dsa", "id_ecdsa",
    "id_ed25519", "id_rsa", "secrets.json",
  ])
  private static let sensitiveFragments = [
    ".env", "credential", "secret", "private-key", "private_key", "keystore", "keychain",
  ]
  private static let sensitiveLineMarkers = [
    "api_key", "apikey", "authorization", "client_secret", "deploy_key", "password", "private_key",
    "privatekey", "refresh_token", "secret", "token",
  ]

  public static func allowsUntrackedFile(_ relativePath: String) -> Bool {
    let lowercasedPath = relativePath.lowercased()
    let name = URL(fileURLWithPath: lowercasedPath).lastPathComponent
    guard !deniedNames.contains(name),
      !sensitiveFragments.contains(where: lowercasedPath.contains),
      !name.hasSuffix(".key"), !name.hasSuffix(".pem"), !name.hasSuffix(".p12"),
      !name.hasSuffix(".mobileprovision")
    else { return false }
    return allowedSourceExtensions.contains(URL(fileURLWithPath: name).pathExtension)
  }

  public static func redact(_ text: String) -> String {
    var insidePrivateKey = false
    var output: [String] = []
    for line in text.components(separatedBy: .newlines) {
      let lowercased = line.lowercased()
      if lowercased.contains("begin ") && lowercased.contains("private key") {
        insidePrivateKey = true
        output.append("[REDACTED PRIVATE KEY]")
        continue
      }
      if insidePrivateKey {
        if lowercased.contains("end ") && lowercased.contains("private key") {
          insidePrivateKey = false
        }
        continue
      }
      let looksLikeAssignment = line.contains("=") || line.contains(":")
      if looksLikeAssignment && sensitiveLineMarkers.contains(where: lowercased.contains) {
        output.append("[REDACTED SENSITIVE LINE]")
      } else {
        output.append(line)
      }
    }
    return output.joined(separator: "\n")
  }
}
