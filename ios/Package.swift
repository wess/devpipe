// swift-tools-version:5.9
import PackageDescription

// The parts of the client that are arithmetic rather than UIKit: key encoding,
// pointer encoding, gesture classification, colour packing.
//
// They get a package of their own because they are exactly where silent bugs
// live. A wrong escape sequence does not crash and does not warn — the key
// simply does nothing, inside one program, in one mode, and finding out why
// costs an afternoon. `ESC O A` versus `ESC [ A` has cost this project one
// already.
//
//   cd ios && swift test
let package = Package(
    name: "DevpipeLogic",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "DevpipeLogic",
            path: "Sources/Core",
            sources: ["Keys.swift", "Modes.swift", "Mouse.swift", "Gestures.swift", "Theme.swift"]
        ),
        .testTarget(name: "DevpipeLogicTests", dependencies: ["DevpipeLogic"], path: "Tests/LogicTests"),
    ]
)
