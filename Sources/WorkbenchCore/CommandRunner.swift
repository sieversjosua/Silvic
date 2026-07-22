import Foundation

public struct CommandRequest: Sendable, Equatable {
  public let executable: String
  public let arguments: [String]
  public let currentDirectory: String?
  public let standardInput: String?
  public let environment: [String: String]

  public init(
    executable: String,
    arguments: [String] = [],
    currentDirectory: String? = nil,
    standardInput: String? = nil,
    environment: [String: String] = [:]
  ) {
    self.executable = executable
    self.arguments = arguments
    self.currentDirectory = currentDirectory
    self.standardInput = standardInput
    self.environment = environment
  }
}

public struct CommandResult: Sendable, Equatable {
  public let exitCode: Int32
  public let standardOutput: String
  public let standardError: String

  public init(exitCode: Int32, standardOutput: String, standardError: String) {
    self.exitCode = exitCode
    self.standardOutput = standardOutput
    self.standardError = standardError
  }
}

public enum CommandError: LocalizedError, Sendable {
  case couldNotLaunch(String)

  public var errorDescription: String? {
    switch self {
    case .couldNotLaunch(let description): description
    }
  }
}

public protocol CommandRunning: Sendable {
  func run(_ request: CommandRequest) async throws -> CommandResult
}

public struct LocalCommandRunner: CommandRunning {
  public init() {}

  public func run(_ request: CommandRequest) async throws -> CommandResult {
    try await Task.detached(priority: .userInitiated) {
      let process = Process()
      let stdout = Pipe()
      let stderr = Pipe()
      let stdin = request.standardInput.map { _ in Pipe() }

      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = [request.executable] + request.arguments
      process.standardOutput = stdout
      process.standardError = stderr
      process.standardInput = stdin
      if let directory = request.currentDirectory {
        process.currentDirectoryURL = URL(fileURLWithPath: directory)
      }
      var environment = ProcessInfo.processInfo.environment
      let home = FileManager.default.homeDirectoryForCurrentUser.path
      let fallbackPaths = [
        "\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin",
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
      ]
      let existingPaths = environment["PATH", default: ""].split(separator: ":").map(String.init)
      environment["PATH"] = Array(Set(existingPaths + fallbackPaths)).joined(separator: ":")
      environment.merge(request.environment) { _, new in new }
      process.environment = environment

      do {
        try process.run()
      } catch {
        throw CommandError.couldNotLaunch(error.localizedDescription)
      }

      if let input = request.standardInput, let stdin {
        stdin.fileHandleForWriting.write(Data(input.utf8))
        try? stdin.fileHandleForWriting.close()
      }

      let outputTask = Task.detached { stdout.fileHandleForReading.readDataToEndOfFile() }
      let errorTask = Task.detached { stderr.fileHandleForReading.readDataToEndOfFile() }
      process.waitUntilExit()

      let outputData = await outputTask.value
      let errorData = await errorTask.value
      return CommandResult(
        exitCode: process.terminationStatus,
        standardOutput: String(decoding: outputData, as: UTF8.self),
        standardError: String(decoding: errorData, as: UTF8.self)
      )
    }.value
  }
}
