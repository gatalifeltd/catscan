// swift-tools-version:6.0
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import PackageDescription

let package = Package(
    name: "catscan-core",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "catscan-core", targets: ["catscan-core"])],
    targets: [
        .target(name: "CatscanCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "catscan-core", dependencies: ["CatscanCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "CatscanCoreTests", dependencies: ["CatscanCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
