// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-074 rendered positives: a UI-test-only bundle (no target app) that launches any installed app by bundle id,
// walks the steps of a job file and writes, per shot, the screenshot and `XCUIApplication.debugDescription` (the
// XCUITest dump `catscan boxes xcuitest` converts; docs/truncation-capture.md). bench/wrapping/rendered.mjs passes
// the job file as TEST_RUNNER_WRAP_JOBS (xcodebuild hands TEST_RUNNER_-prefixed variables to the runner).
import XCTest

final class WrapDump: XCTestCase {
    struct Step: Decodable { let tap: String?; let wait: String?; let shot: String? }
    struct Job: Decodable { let bundle: String; let args: [String]; let out: String; let steps: [Step] }

    func testDump() throws {
        guard let p = ProcessInfo.processInfo.environment["WRAP_JOBS"] else { throw XCTSkip("WRAP_JOBS is not set") }
        let jobs = try JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(fileURLWithPath: p)))
        for j in jobs {
            let app = XCUIApplication(bundleIdentifier: j.bundle)
            app.launchArguments = j.args
            app.launch()
            let out = URL(fileURLWithPath: j.out)
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            for s in j.steps {
                if let id = s.wait { XCTAssertTrue(app.descendants(matching: .any)[id].waitForExistence(timeout: 20), "no \(id)") }
                if let id = s.tap {
                    let e = app.descendants(matching: .any)[id]
                    XCTAssertTrue(e.waitForExistence(timeout: 20), "no \(id)")
                    e.tap()
                }
                if let name = s.shot {
                    Thread.sleep(forTimeInterval: 1.5) // let transitions settle
                    try XCUIScreen.main.screenshot().pngRepresentation.write(to: out.appendingPathComponent("\(name).png"))
                    try app.debugDescription.write(to: out.appendingPathComponent("\(name).xcui.txt"), atomically: true, encoding: .utf8)
                }
            }
            app.terminate()
        }
    }
}
