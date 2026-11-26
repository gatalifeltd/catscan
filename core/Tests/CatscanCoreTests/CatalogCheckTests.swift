// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// Spec 02 "Rule" steps 4-6 and D2, D6, D7, D10: the core's half of a catalog check.
final class CatalogCheckTests: XCTestCase {
    let lines = [
        RecognizedLine(text: "Welcome back, Ann!", rect: CGRect(x: 0.1, y: 0.1, width: 0.5, height: 0.03), confidence: 0.97),
        RecognizedLine(text: "You have 3 new", rect: CGRect(x: 0.1, y: 0.2, width: 0.4, height: 0.03), confidence: 0.9),
        RecognizedLine(text: "messages today", rect: CGRect(x: 0.1, y: 0.24, width: 0.4, height: 0.03), confidence: 0.8),
        RecognizedLine(text: "設定を開く", rect: CGRect(x: 0.1, y: 0.4, width: 0.3, height: 0.03), confidence: 0.9),
    ]

    func check(_ kind: String, _ alts: [[String]], locale: String = "en", reason: String? = nil) -> (CheckResult, [Diagnostic]) {
        let c = CatalogCheck(kind: kind, key: "k", catalog: "en.json", text: "raw", alternatives: alts, reason: reason)
        return Checks.evaluate(c, windows: Checks.Windows(lines, locale: locale), lines: lines, locale: locale)
    }

    func testFragmentsInOrderOnOneLine() {
        let (r, _) = check("present", [["Welcome back,", "!"]])
        XCTAssertEqual(r.verdict, "pass")
        XCTAssertEqual(r.line, "Welcome back, Ann!")
        XCTAssertEqual(r.key, "k")
        XCTAssertEqual(r.catalog, "en.json")
    }

    func testFragmentsAcrossTwoLines() {
        let (r, _) = check("present", [["You have", "new messages"]])
        XCTAssertEqual(r.verdict, "pass")
        XCTAssertEqual(r.line, "You have 3 new messages today")
    }

    func testOutOfOrderAndOverlapFail() {
        XCTAssertEqual(check("present", [["new messages", "You have"]]).0.verdict, "fail")
        // Each search starts after the previous match: one "Welcome" cannot satisfy two fragments.
        XCTAssertEqual(check("present", [["Welcome", "Welcome"]]).0.verdict, "fail")
    }

    func testShortFragmentsDroppedByLocale() {
        // "!" and "Ann" are under 4 characters: only "Welcome back," is checked.
        XCTAssertEqual(check("present", [["Welcome back,", "Ann", "!"]]).0.verdict, "pass")
        XCTAssertEqual(check("present", [["Bye", "!"]]).0.reason, "no-checkable-text")
        // ja keeps fragments of 2 or more.
        XCTAssertEqual(check("present", [["設定", "開く"]], locale: "ja").0.verdict, "pass")
        XCTAssertEqual(check("present", [["設定", "開く"]], locale: "en").0.reason, "no-checkable-text")
    }

    func testAbsentUsesTheLongestFragment() {
        // "messages today" is absent from no line, so the absent check fails; "zzzz" alone would pass.
        let (r, _) = check("absent", [["zzzz", "messages today"]])
        XCTAssertEqual(r.verdict, "fail")
        XCTAssertEqual(r.line, "messages today")
        XCTAssertEqual(check("absent", [["messages", "zzzz zzzz zzzz"]]).0.verdict, "pass")
    }

    func testAlternatives() {
        XCTAssertEqual(check("present", [["nothing like it"], ["Welcome back,"]]).0.verdict, "pass")
        let (f, _) = check("present", [["nothing like it"], ["not here either"]])
        XCTAssertEqual(f.verdict, "fail")
        XCTAssertNotNil(f.closest)
        XCTAssertEqual(check("absent", [["nothing like it"], ["Welcome back,"]]).0.verdict, "fail")
    }

    func testMixedAlternativesD7() {
        // A checkable alternative that matches decides; otherwise an uncheckable one leaves it unknown.
        XCTAssertEqual(check("present", [["OK"], ["Welcome back,"]]).0.verdict, "pass")
        XCTAssertEqual(check("present", [["OK"], ["not here either"]]).0.reason, "no-checkable-text")
        XCTAssertEqual(check("absent", [["OK"], ["Welcome back,"]]).0.verdict, "fail")
        XCTAssertEqual(check("absent", [["OK"], ["not here either"]]).0.reason, "no-checkable-text")
    }

    func testNothingCheckableAndReasons() {
        let (r, w) = check("present", [[]])
        XCTAssertEqual(r.verdict, "skipped")
        XCTAssertEqual(r.reason, "no-checkable-text")
        XCTAssertEqual(w.first?.code, "no-checkable-text")
        XCTAssertEqual(check("present", []).0.reason, "no-checkable-text")
        let (m, mw) = check("present", [], reason: "catalog-missing")
        XCTAssertEqual(m.verdict, "skipped")
        XCTAssertEqual(m.reason, "catalog-missing")
        XCTAssertEqual(mw.map(\.code), ["catalog-missing"]) // printed even under --quiet (D22)
        // TODO-092 D6: a dynamic code-catalog value says so, not "no string for the locale".
        let (d, dw) = check("present", [], reason: "catalog-value-dynamic")
        XCTAssertEqual([d.verdict, d.reason], ["skipped", "catalog-value-dynamic"])
        XCTAssertEqual(dw.map(\.code), ["catalog-value-dynamic"])
        XCTAssertTrue(dw[0].message.contains("is not a plain string in its code catalog"), dw[0].message)
        XCTAssertTrue((dw[0].hint ?? "").hasPrefix("write the string as a literal"))
    }

    func testInventorySortedFoundNotFoundSkipped() {
        let entries = [
            CatalogCheck(kind: "present", key: "z.welcome", text: "", alternatives: [["Welcome back,"]]),
            CatalogCheck(kind: "present", key: "a.missing", text: "", alternatives: [["Not on screen"]]),
            CatalogCheck(kind: "present", key: "m.short", text: "", alternatives: [["OK"]]),
            CatalogCheck(kind: "present", key: "b.capped", text: "", alternatives: [], reason: "catalog-string-capped"),
            CatalogCheck(kind: "present", key: "c.cyrillic", text: "", alternatives: [["Настройки"]]),
        ]
        let inv = Checks.inventory(entries, windows: Checks.Windows(lines, locale: "en"), lines: lines, locale: "en") {
            Scripts.scripts(in: Checks.scriptText($0)).contains(.cyrillic)
        }
        XCTAssertEqual(inv.found.map(\.key), ["z.welcome"])
        XCTAssertEqual(inv.found.first?.line, "Welcome back, Ann!")
        XCTAssertEqual(inv.not_found, ["a.missing"])
        XCTAssertEqual(inv.skipped, [
            .init(key: "b.capped", reason: "catalog-string-capped"), .init(key: "c.cyrillic", reason: "unsupported-script"),
            .init(key: "m.short", reason: "no-checkable-text"),
        ])
    }

    func testServeParsesCatalogEntries() {
        XCTAssertNil(Server.catalogCheck(["key": "k", "text": "t"], kind: "present"))
        XCTAssertNil(Server.catalogCheck(["key": "k", "text": "t", "alternatives": [["a"]], "reason": 3], kind: "present"))
        XCTAssertNotNil(Server.catalogCheck(["key": "k", "text": "t", "alternatives": [], "catalog": NSNull()], kind: "present"))
        let c = Server.catalogCheck(["key": "k", "text": "t", "alternatives": [["a", "b"]], "catalog": "x.json"], kind: "absent")
        XCTAssertEqual(c?.kind, "absent")
        XCTAssertEqual(c?.alternatives, [["a", "b"]])
        XCTAssertEqual(c?.catalog, "x.json")
    }

    func testCheckJSONCarriesKeyAndCatalog() throws {
        let (r, _) = check("present", [["Welcome back,"]])
        let s = String(data: try JSONEncoder().encode(r), encoding: .utf8)!
        XCTAssertTrue(s.contains("\"key\":\"k\""))
        XCTAssertTrue(s.contains("\"catalog\":\"en.json\""))
    }
}
