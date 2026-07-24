// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Silvic",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "WorkbenchCore", targets: ["WorkbenchCore"]),
    .executable(name: "Silvic", targets: ["SilvicApp"]),
  ],
  targets: [
    .target(name: "WorkbenchCore"),
    .executableTarget(
      name: "SilvicApp",
      dependencies: ["WorkbenchCore"],
      path: "Sources/SilvicApp"
    ),
    .testTarget(
      name: "WorkbenchCoreTests",
      dependencies: ["WorkbenchCore"]
    ),
  ]
)
