// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-104: Vision reads a Ukrainian apostrophe as U+02BC; matching treats it as `’`, records keep it (D1-D4).
final class ApostropheTests: XCTestCase {
    func n(_ s: String) -> String { TextMatch.normalize(s, locale: "uk") }

    func testModifierLetterApostropheMatchesAsApostrophe() {
        XCTAssertEqual(n("УБ\u{02BC}Є"), n("УБ\u{2019}Є"))
        XCTAssertEqual(n("ТАМ ЖЕ НАПИСАНО: УБ\u{02BC}Є"), n("ТАМ ЖЕ НАПИСАНО: УБ\u{2019}Є"))
        // D3: the word-boundary rule of `’` applies unchanged.
        for a in ["\u{02BC}", "\u{2019}"] {
            XCTAssertTrue(TextMatch.contains(n("УБ\(a)Є"), n("УБ"), wordBounded: true), a)
        }
    }

    func testRecordPathsKeepTheModifierLetter() {
        // D1: baseline tokens and tile merges are unchanged, so saved records do not drift.
        let rec = TextRecord.make(["УБ\u{02BC}Є"], locale: "uk", job: TextRecordJob(mode: "full"))
        XCTAssertEqual(rec.tokens, ["уб\u{02BC}є"])
        let r = CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.05)
        let merged = Geometry.mergeTiles([RecognizedLine(text: "УБ\u{02BC}Є", rect: r, confidence: 0.9),
                                          RecognizedLine(text: "УБ\u{2019}Є", rect: r, confidence: 0.8)], locale: "uk")
        XCTAssertEqual(merged.count, 2)
    }

    func testTruncationKeyAndPrefixTreatBothApostrophesAlike() {
        // D4.
        XCTAssertEqual(Truncation.key("УБ\u{02BC}Є"), Truncation.key("УБ\u{2019}Є"))
    }
}

extension TruncationTests {
    func testApostropheFormsGiveTheSamePrefixResult() {
        let p = [TruncationJob.Prefix(text: "УБ\u{2019}Є ЗАВЖДИ", alternatives: [["УБ\u{2019}Є ЗАВЖДИ"]])]
        let run1 = { (a: String) in self.reasons(self.run([self.line("УБ\(a)Є", 0.1, 0.5, 0.2)], prefixes: p, reasons: ["prefix"], locale: "uk")).count }
        XCTAssertEqual(run1("\u{02BC}"), run1("\u{2019}"))
    }
}
