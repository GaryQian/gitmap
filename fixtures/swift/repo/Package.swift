// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Shop",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "Core", targets: ["Core"]),
        .library(name: "Storefront", targets: ["Storefront"]),
    ],
    targets: [
        .target(name: "Core"),
        // The storefront sources predate the rename and still live in Sources/App.
        // .target(name: "Storefront", path: "Sources/Storefront"),
        .target(
            name: "Storefront",
            dependencies: [.target(name: "Core")],
            path: "Sources/App"
        ),
        .testTarget(name: "CoreTests", dependencies: ["Core"]),
    ]
)
