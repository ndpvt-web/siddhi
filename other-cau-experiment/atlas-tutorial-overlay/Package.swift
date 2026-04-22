// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "AtlasTutorialOverlay",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "AtlasTutorialOverlay",
            path: "Sources",
            swiftSettings: [
                .unsafeFlags(["-framework", "AVFoundation"], .when(platforms: [.macOS]))
            ]
        )
    ]
)
