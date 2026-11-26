// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-101: a row whose end cannot be a line break inside the catalog string is no prefix cut.
extension TruncationTests {
    private func prefix(_ t: String, _ strings: [String], x: Double = 0.1, w: Double = 0.2, locale: String = "en") -> [Finding] {
        let p = strings.map { TruncationJob.Prefix(text: $0, alternatives: [[$0]]) }
        return run([line(t, x, 0.5, w)], prefixes: p, reasons: ["prefix"], locale: locale)
    }

    func testNoBreakPunctuationAfterRowIsNoCut() {
        XCTAssertEqual(prefix("Enter", ["Enter: go to what needs you"]), [])
        XCTAssertEqual(prefix("Enter", ["Enter: к тому, что ждёт решения"], locale: "ru"), [])
        // Evidence of a cut still reports: the screen's trailing edge, an ellipsis.
        XCTAssertEqual(reasons(prefix("Enter", ["Enter: go to what needs you"], x: 0.9, w: 0.0995)), ["prefix:Enter"])
        XCTAssertEqual(reasons(prefix("Enter...", ["Enter: go to what needs you"])).count, 1)
        // A space after the row is a break: unchanged (a list clipped by its scroll viewport).
        XCTAssertEqual(reasons(prefix("They did", ["They did warn you"])), ["prefix:They did"])
        XCTAssertEqual(reasons(prefix("Play", ["Play on"])), ["prefix:Play"])
        // A textless container's trailing edge is evidence too.
        let p = [TruncationJob.Prefix(text: "Enter: go to what needs you", alternatives: [["Enter: go to what needs you"]])]
        for (right, n) in [(0.3, 1), (0.5, 0)] {
            let box = El(id: "box", rect: CGRect(x: 0.05, y: 0.45, width: right - 0.05, height: 0.1))
            XCTAssertEqual(run([line("Enter", 0.1, 0.5, 0.2)], elements: [box], prefixes: p, reasons: ["prefix"], locale: "en").count, n)
        }
        // A `.` inside a token is no break mark.
        XCTAssertEqual(reasons(prefix("Version 1", ["Version 1.0.5 is out"])), ["prefix:Version 1"])
        // An apostrophe is inside the word.
        XCTAssertEqual(reasons(prefix("Didn", ["Didn't stop"])), ["prefix:Didn"])
    }

    func testOwnTrailingPunctuationIsNoCut() {
        XCTAssertEqual(prefix("меньше.", ["Меньше соперников"], locale: "ru"), [])
        XCTAssertEqual(prefix("Wait, no!", ["Wait, no more turns"]), [])
        // A hyphen is added by hyphenation; punctuation the string has there is the string's own.
        XCTAssertEqual(reasons(prefix("Hütchen -", ["Hütchen-Bowling am Kreisel"], locale: "de")), ["prefix:Hütchen -"])
        XCTAssertEqual(reasons(prefix("ПРЕДУ-", ["Предупреждали"], locale: "ru")), ["prefix:ПРЕДУ-"])
        XCTAssertEqual(reasons(prefix("Wait,", ["Wait, no more turns"])), ["prefix:Wait,"])
    }

    func testCandidateOrder() {
        // A label end (no-break mark) clears the row, like a whole string; own punctuation clears one candidate only.
        for strings in [["Enter: go to what needs you", "Entertainment center"], ["Entertainment center", "Enter: go to what needs you"]] {
            XCTAssertEqual(prefix("Enter", strings), [], "\(strings)")
        }
        for strings in [["Pannenauto: andere Spur", "Pannenauto gerammt"], ["Pannenauto gerammt", "Pannenauto: andere Spur"]] {
            let f = prefix("PANNENAUTO", strings, locale: "de")
            XCTAssertEqual(f.first?.expected, "Pannenauto gerammt", "\(strings)")
        }
        for strings in [["Wait no more turns", "Wait, no more turns"], ["Wait, no more turns", "Wait no more turns"]] {
            let f = prefix("Wait,", strings)
            XCTAssertEqual(reasons(f), ["prefix:Wait,"], "\(strings)")
            XCTAssertEqual(f.first?.expected, "Wait, no more turns")
        }
    }

    // Ship review: a misread chevron or bullet at the row's end is no punctuation of its own; French spacing before a
    // colon still ends a label; the coverage gaps (RTL edge, a sentence mark before a space, `/`, U+2212).
    func testBoundaryReviewCases() {
        for t in ["Einstellun \u{203A}", "Einstellun \u{2022}", "Einstellun \u{00BB}"] {
            XCTAssertEqual(prefix(t, ["Einstellungen"], locale: "de").count, 1, t)
        }
        XCTAssertEqual(prefix("Entrer", ["Entrer : aller \u{E0} ce qui attend", "Entreprises"], locale: "fr"), [])
        XCTAssertEqual(prefix("Entrer", ["Entrer\u{00A0}: aller", "Entreprises"], locale: "fr"), [])
        XCTAssertEqual(prefix("\u{05E9}\u{05DE}\u{05D5}\u{05E8}", ["\u{05E9}\u{05DE}\u{05D5}\u{05E8}: \u{05D4}\u{05DB}\u{05DC}"], x: 0.6, locale: "he"), [])
        XCTAssertEqual(prefix("\u{05E9}\u{05DE}\u{05D5}\u{05E8}", ["\u{05E9}\u{05DE}\u{05D5}\u{05E8}: \u{05D4}\u{05DB}\u{05DC}"], x: 0.0003, locale: "he").count, 1)
        XCTAssertEqual(prefix("Done", ["Done. Next step"]), [])
        XCTAssertEqual(prefix("Save", ["Save/Load game"]).count, 1)
        // Round 2: the string's own marks after a quote still match; closing brackets and Arabic marks count.
        XCTAssertEqual(prefix("Ваш город строит «Воинов»;", ["Ваш город строит «Воинов»; чтобы сменить постройку"], locale: "ru").count, 1)
        XCTAssertEqual(prefix("Fast (x)", ["Fast (xy) mode"]), [])
        XCTAssertEqual(prefix("\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}\u{060C}", ["\u{0645}\u{0631}\u{062D}\u{0628}\u{0627} \u{0628}\u{0643}"], locale: "ar"), [])
        XCTAssertEqual(prefix("H\u{00FC}tchen \u{2212}", ["H\u{00FC}tchen-Bowling am Kreisel"], locale: "de").count, 1)
    }
}
