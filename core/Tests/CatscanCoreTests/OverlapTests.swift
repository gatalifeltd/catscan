// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// Spec 12 "Rule" and D2-D4, D7, D21: the core's half of `overlap`, on synthetic recognized lines.
/// The image is 1000 x 1000 px, so a normalized 0.001 is 1 px.
final class OverlapTests: XCTestCase {
    func line(_ t: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double = 0.02, conf: Double = 0.95) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: w, height: h), confidence: conf)
    }

    func run(_ lines: [RecognizedLine], min: Double = 0.2) -> [Finding] {
        Overlap.evaluate(OverlapJob(minOverlap: min), lines: lines, width: 1000, height: 1000, locale: "de")
    }

    func testBoxesShareOfTheSmallerBoxAtTheThreshold() {
        // Value: protects=rule 1 and D4 (intersection over the smaller box, >= min); fails_when=the share uses the union or the larger box, or > instead of >=; why_new=new; seam=none; no_claim=Vision boxes (bench/overlap.js)
        let a = line("Kontoeinstellungen", 0.1, 0.30, 0.4) // 20 px tall
        // b starts 4 px into a: 4/20 of the smaller box when b is at least as wide.
        let b = line("Benachrichtigungen", 0.1, 0.316, 0.4)
        let f = run([b, a])
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f[0].kind, "overlap")
        XCTAssertEqual(f[0].signal, "boxes")
        XCTAssertEqual(f[0].overlap, 0.2)
        XCTAssertEqual(f[0].a?.text, "Kontoeinstellungen") // the upper line first, whatever the input order
        XCTAssertEqual(f[0].b?.text, "Benachrichtigungen")
        XCTAssertEqual(f[0].line, "Kontoeinstellungen / Benachrichtigungen")
        XCTAssertEqual(f[0].box, [0.1, 0.3, 0.4, 0.036]) // the union of both boxes
        XCTAssertEqual(f[0].a?.confidence, 0.95)
        // Just under the threshold, and at a higher one.
        XCTAssertTrue(run([a, line("Benachrichtigungen", 0.1, 0.317, 0.4)]).isEmpty)
        XCTAssertTrue(run([a, b], min: 0.25).isEmpty)
        // The upper line comes first even when it starts further right (pieces are sorted by x before pairing).
        let g = run([line("Unten", 0.1, 0.31, 0.3), line("Oben", 0.2, 0.30, 0.3)])
        XCTAssertEqual(g.first?.a?.text, "Oben")
        XCTAssertEqual(g.first?.line, "Oben / Unten")
    }

    func testDisjointAndTouchingLinesPass() {
        // Value: protects=no finding without an intersection, and 1 px is enough at a low threshold; fails_when=touching edges count as an overlap or a 1 px intersection is dropped; why_new=new; seam=none; no_claim=none beyond protects
        let a = line("Titel", 0.1, 0.30, 0.3)
        XCTAssertTrue(run([a, line("Untertitel", 0.1, 0.32, 0.3)], min: 0.0001).isEmpty, "touching")
        XCTAssertEqual(run([a, line("Untertitel", 0.1, 0.319, 0.3)], min: 0.04).first?.overlap, 0.05, "1 px of 20")
        XCTAssertTrue(run([a, line("Untertitel", 0.1, 0.33, 0.3)]).isEmpty, "a gap")
        XCTAssertTrue(run([a, line("Rechts", 0.5, 0.30, 0.2)]).isEmpty, "same row, apart")
    }

    func testPiecesOfOneLineMergeButACollisionOnOneRowIsAPair() {
        // Value: protects=D2 (gap from -0.1 to +0.5 line heights merges; a deeper overlap is a pair); fails_when=the merge takes any negative gap and hides a same-row collision, or split pieces pair; why_new=new; seam=none; no_claim=how often Vision splits or merges (bench/overlap.js)
        let left = line("Konto", 0.1, 0.30, 0.1)
        XCTAssertTrue(run([left, line("einstellungen", 0.206, 0.30, 0.2)]).isEmpty, "a 6 px gap: one line")
        XCTAssertTrue(run([left, line("einstellungen", 0.199, 0.301, 0.2)]).isEmpty, "1 px into it, slack: one line")
        // 30 px deep on a 20 px line: two labels, sharing 30% of the smaller box.
        let f = run([left, line("Benachrichtigungen", 0.17, 0.30, 0.3)])
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f.first?.a?.text, "Konto")
        // A different baseline never merges, even when the gap is small.
        XCTAssertEqual(run([left, line("Mitteilung", 0.18, 0.312, 0.2)], min: 0.05).count, 1)
    }

    func testMergedPiecesStillPairWithAThirdLine() {
        // Value: protects=a merged line keeps its union box for pairing; fails_when=only the first piece is compared; why_new=new; seam=none; no_claim=none beyond protects
        let f = run([line("Konto", 0.1, 0.30, 0.1), line("einstellungen", 0.205, 0.30, 0.2), line("Mitteilungen", 0.25, 0.31, 0.2)])
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f.first?.a?.text, "Konto einstellungen")
    }

    func testATextReadTwiceIsOneLine() {
        // Value: protects=D3 (equal text, IoU > 0.5: one line); fails_when=an outline or shadow pass pairs with itself; why_new=new; seam=none; no_claim=none beyond protects
        XCTAssertTrue(run([line("Weiter", 0.1, 0.3, 0.2), line("Weiter", 0.102, 0.302, 0.2)]).isEmpty)
        // Different text in the same place is an overlap.
        XCTAssertEqual(run([line("Weiter", 0.1, 0.3, 0.2), line("Zurück", 0.102, 0.302, 0.2)]).count, 1)
    }

    func testATallLineAloneIsNotAFinding() {
        // Value: protects=D21 (the garbled signal is dropped: a merged-looking line alone never fires); fails_when=the signal comes back without a measurement; why_new=new; seam=none; no_claim=none beyond protects
        let normal = [line("Eins", 0.1, 0.1, 0.2), line("Zwei", 0.1, 0.2, 0.2), line("Drei", 0.1, 0.3, 0.2)]
        XCTAssertTrue(run(normal + [line("Kopenachst", 0.1, 0.5, 0.3, 0.04, conf: 0.2)]).isEmpty)
    }

    func testFindingsInReadingOrderAndEncoding() throws {
        // Value: protects=D7 wire shape (a, b, overlap, signal always present); fails_when=a field is dropped or renamed; why_new=new; seam=none; no_claim=the schema file (packages/core-js/test/overlap.test.js)
        // The upper pair sits further right, so only the final sort puts it first.
        let f = run([line("Unten", 0.1, 0.80, 0.3), line("Mitte", 0.1, 0.81, 0.3), line("Oben", 0.5, 0.10, 0.3), line("Auch", 0.5, 0.11, 0.3)])
        XCTAssertEqual(f.map(\.line), ["Oben / Auch", "Unten / Mitte"])
        let json = try JSONSerialization.jsonObject(with: JSONLine.encode(f[0])) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["kind", "box", "line", "a", "b", "overlap", "signal"])
    }

    func testServeOverlapField() {
        // Value: protects=D1 request validation as invalid-request; fails_when=a malformed min_overlap reaches the rule; why_new=new; seam=none; no_claim=the serve loop (test/overlap.test.js drives it)
        func job(_ v: Any) -> OverlapJob? { try? Server.overlapJob(v).get() }
        XCTAssertNil(job([:])?.minOverlap ?? nil) // the reader's default (TODO-046 D17)
        XCTAssertEqual(job(["min_overlap": 0.35])?.minOverlap, 0.35)
        XCTAssertEqual(job(["min_overlap": 1])?.minOverlap, 1) // a JSON 1 is a number, not true
        for bad: Any in [["min_overlap": 0], ["min_overlap": 1.5], ["min_overlap": true], ["min_overlap": "0.2"], "x"] {
            XCTAssertNil(job(bad), "\(bad)")
        }
        XCTAssertEqual(serveProtocol, 23)
    }
}
