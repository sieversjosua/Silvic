// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WorktreePilot",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "WorkbenchCore", targets: ["WorkbenchCore"]),
    .executable(name: "WorktreePilot", targets: ["WorktreePilotApp"]),
  ],
  targets: [
    .target(name: "WorkbenchCore"),
    .executableTarget(
      name: "WorktreePilotApp",
      dependencies: ["WorkbenchCore"]
    ),
    .testTarget(
      name: "WorkbenchCoreTests",
      dependencies: ["WorkbenchCore"]
    ),
  ]
)
