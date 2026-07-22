// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Branchdeck",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "WorkbenchCore", targets: ["WorkbenchCore"]),
    .executable(name: "Branchdeck", targets: ["BranchdeckApp"]),
  ],
  targets: [
    .target(name: "WorkbenchCore"),
    .executableTarget(
      name: "BranchdeckApp",
      dependencies: ["WorkbenchCore"]
    ),
    .testTarget(
      name: "WorkbenchCoreTests",
      dependencies: ["WorkbenchCore"]
    ),
  ]
)
