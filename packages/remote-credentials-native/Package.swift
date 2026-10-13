// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "JokoRemoteCredentials",
  platforms: [.macOS(.v12), .iOS(.v16)],
  products: [
    .library(name: "JokoRemoteCredentials", targets: ["JokoRemoteCredentials"]),
    .executable(name: "joko-macos-remote-credentials", targets: ["CredentialHost"])
  ],
  dependencies: [.package(url: "https://github.com/airsidemobile/JOSESwift.git", exact: "3.0.0")],
  targets: [
    .target(name: "DesktopNativeCaller"),
    .executableTarget(name: "CredentialHost", dependencies: ["JokoRemoteCredentials", "DesktopNativeCaller"]),
    .target(name: "JokoRemoteCredentials", dependencies: ["JOSESwift"], resources: [.process("Resources")])
  ]
)
