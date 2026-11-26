// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-039 D10 (TODO-036 check 4): the shared dynamic-text guards.
final class DynamicTextTests: XCTestCase {
    let mid = CGRect(x: 0.1, y: 0.5, width: 0.5, height: 0.03)

    func testEachGuard() throws {
        let g = try DynamicText(
            patterns: ["Hi, \\w+!", "@[a-z0-9_]+"], rects: [CGRect(x: 0, y: 0.6, width: 1, height: 0.1)], allow: ["Acme Cloud Pro"])
        XCTAssertEqual(g.guarded("Acme Cloud", rect: mid, locale: "en"), "allow")
        XCTAssertEqual(g.guarded("Carrier Wi-Fi", rect: CGRect(x: 0.1, y: 0.005, width: 0.3, height: 0.02), locale: "en"), "status-bar")
        XCTAssertEqual(g.guarded("Anna Smith posted", rect: CGRect(x: 0.1, y: 0.62, width: 0.5, height: 0.03), locale: "en"), "dynamic-element")
        XCTAssertEqual(g.guarded("Hi, Anna!", rect: mid, locale: "en"), "dynamic-pattern")
        XCTAssertEqual(g.guarded("@anna_smith", rect: mid, locale: "en"), "dynamic-pattern")
        XCTAssertNil(g.guarded("Say hi, Anna! today", rect: mid, locale: "en"), "anchored: the pattern must cover the line")
        XCTAssertEqual(g.guarded("$4.99", rect: mid, locale: "en"), "formatted")
        XCTAssertEqual(g.guarded("Shop", rect: mid, locale: "en"), "short")
        XCTAssertNil(g.guarded("Daily reward", rect: mid, locale: "en"))
        XCTAssertNil(g.guarded("Notifications", rect: mid, locale: "en"), "8 letters in one word is enough")
    }

    func testFormattedValues() {
        for s in ["12", "$4.99", "4,99 €", "EUR 12.00", "75%", "10:45 PM", "Mar 3, 2026", "3/12/2026", "1,250 / 3,000", "Lv 12", "x3", "12 of 40", "+250 XP"] {
            XCTAssertTrue(DynamicText.isFormatted(s), s)
        }
        for s in ["Daily reward", "12 coins left", "Level up", "Top 10 players"] { XCTAssertFalse(DynamicText.isFormatted(s), s) }
    }

    func testInvalidPatternThrows() {
        XCTAssertThrowsError(try DynamicText(patterns: ["(unclosed"]))
    }
}
