// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation
import ImageIO
import XCTest

@testable import CatscanCore

/// Spec 18 D6: the `thumbnail` serve request. The video frame case runs in test/report.test.js on real videos.
final class ThumbnailTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("catscan-thumb-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    func write(_ name: String, type: String, width: Int, height: Int, orientation: Int = 1) -> String {
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let url = dir.appendingPathComponent(name)
        let dest = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest), name)
        return url.path
    }

    func thumb(_ path: String, edge: Int = 100) -> Result<(Int, Int, Data), Diagnostic> {
        Thumbnail.make(ThumbnailJob(path: path, maxEdge: edge, quality: 0.7, t: nil))
    }

    func testFormatsScaleToTheLongEdge() throws {
        for (name, type) in [("a.png", "public.png"), ("a.jpg", "public.jpeg"), ("a.heic", "public.heic")] {
            let p = write(name, type: type, width: 400, height: 800)
            guard case .success(let (w, h, jpeg)) = thumb(p) else { return XCTFail(name) }
            XCTAssertEqual([w, h], [50, 100], name)
            XCTAssertEqual(Array(jpeg.prefix(2)), [0xFF, 0xD8], "\(name): a JPEG")
        }
    }

    func testOrientationIsApplied() {
        let p = write("r.jpg", type: "public.jpeg", width: 800, height: 400, orientation: 6)
        guard case .success(let (w, h, _)) = thumb(p) else { return XCTFail("thumbnail failed") }
        XCTAssertEqual([w, h], [50, 100])
    }

    func testNeverScaledUp() {
        let p = write("s.png", type: "public.png", width: 40, height: 20)
        guard case .success(let (w, h, _)) = thumb(p, edge: 800) else { return XCTFail("thumbnail failed") }
        XCTAssertEqual([w, h], [40, 20])
    }

    func testMissingAndUnreadable() throws {
        guard case .failure(let d) = thumb(dir.appendingPathComponent("none.png").path) else { return XCTFail() }
        XCTAssertEqual(d.code, "input-not-found")
        let txt = dir.appendingPathComponent("x.png")
        try Data("not an image".utf8).write(to: txt)
        guard case .failure(let u) = thumb(txt.path) else { return XCTFail() }
        XCTAssertEqual(u.code, "input-unreadable")
    }

    func testParse() {
        func parse(_ o: [String: Any]) -> String? {
            switch Thumbnail.parse(o) { case .success: return nil; case .failure(let d): return d.message }
        }
        XCTAssertNil(parse(["path": "a.png", "max_edge": 800, "quality": 0.7]))
        XCTAssertNil(parse(["path": "a.mp4", "max_edge": 800, "quality": 0.7, "t": 1.5]))
        XCTAssertNotNil(parse(["image": "AA==", "max_edge": 800, "quality": 0.7]))
        XCTAssertNotNil(parse(["path": "a.png", "max_edge": 0, "quality": 0.7]))
        XCTAssertNotNil(parse(["path": "a.png", "max_edge": 1.5, "quality": 0.7]))
        XCTAssertNotNil(parse(["path": "a.png", "max_edge": 800, "quality": 2]))
        XCTAssertNotNil(parse(["path": "a.png", "max_edge": 800, "quality": 0.7, "t": -1]))
    }

    func testReadyLineCarriesTheServeProtocol() throws {
        let s = String(decoding: JSONLine.encode(ReadyLine(visionTimeout: 60, engine: "e", host: Host.info(visionRevision: 3))), as: UTF8.self)
        XCTAssertTrue(s.contains("\"protocol\":\(serveProtocol)"), s)
    }
}
