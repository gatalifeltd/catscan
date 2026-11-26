// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-036 check 1 (T1): `truncated` reason `overflow`, a line drawn past its element with no ellipsis.
final class OverflowTests: XCTestCase {
    typealias El = TruncationJob.Element
    let W = 1000.0, H = 2000.0
    let lh = 40.0 // line height in px

    func run(_ lines: [RecognizedLine], _ elements: [El], reasons: [String]? = nil, allow: [String] = [], locale: String = "de") -> [Finding] {
        var j = TruncationJob()
        j.boxes = .init(width: W, height: H, elements: elements)
        if let reasons { j.reasons = Set(reasons) }
        j.allow = allow
        return Truncation.evaluate(j, lines: lines, width: Int(W), height: Int(H), locale: locale)
    }

    /// A line from x0 to x1 px at y 200 px.
    func line(_ t: String, _ x0: Double, _ x1: Double) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x0 / W, y: 200 / H, width: (x1 - x0) / W, height: lh / H), confidence: 0.9)
    }

    /// An element from x0 to x1 px around that line.
    func el(_ x0: Double, _ x1: Double, text: String? = "Jetzt kostenlos testen", clips: Bool = true, offscreen: Bool = false, id: String = "cta") -> El {
        El(id: id, rect: CGRect(x: x0 / W, y: 190 / H, width: (x1 - x0) / W, height: 60 / H), text: text, clips: clips, offscreen: offscreen)
    }

    /// The line runs 100..700 px; the element ends `past` line heights before the line's end.
    func trailing(_ past: Double, clips: Bool = true) -> [Finding] {
        run([line("Jetzt kostenlos testen", 100, 700)], [el(80, 700 - past * lh, clips: clips)])
    }

    func testFiresFromOneLineHeightPastTheTrailingEdge() {
        let f = trailing(1.4)
        XCTAssertEqual(f.map(\.reason), ["overflow"])
        XCTAssertEqual(f[0].overflow, 1.4)
        XCTAssertEqual(f[0].element?.id, "cta")
        XCTAssertEqual(f[0].expected, "Jetzt kostenlos testen")
        XCTAssertEqual(trailing(1.0).map(\.reason), ["overflow"])
        XCTAssertEqual(trailing(4).first?.overflow, 4)
    }

    func testSilentBetweenTheEdgeBandAndOneLineHeight() {
        // D3: spec 06 D68 measured valid iOS text overhanging native frames by 0.42-0.63 line heights.
        for past in [0.2, 0.42, 0.63, 0.99] { XCTAssertEqual(trailing(past), [], "\(past)") }
    }

    func testExclusiveWithEdge() {
        // Within 0.15 line heights is edge (a cut line, D78); at least 1.0 past is overflow; never both.
        let cut = line("Jetzt kostenlos tes", 100, 700)
        XCTAssertEqual(run([cut], [el(80, 700 - 0.1 * lh)], reasons: ["edge", "overflow"]).map(\.reason), ["edge"])
        XCTAssertEqual(trailing(0.1), [])
        XCTAssertEqual(trailing(1.2).map(\.reason), ["overflow"])
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 700)], [el(80, 700 - 1.2 * lh)], reasons: ["edge"]), [])
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 700)], [el(80, 700 - 1.2 * lh)], reasons: ["ellipsis", "prefix", "edge", "screen-edge"]), [])
    }

    func testEllipsisLineIsNotOverflow() {
        let f = run([line("Jetzt kostenlos te…", 100, 700)], [el(80, 600)])
        XCTAssertEqual(f.map(\.reason), ["ellipsis"])
    }

    func testClipsFalseFiresToo() {
        XCTAssertEqual(trailing(2, clips: false).map(\.reason), ["overflow"])
    }

    func testOffscreenAndWholeScreenElementsAreSkipped() {
        let l = line("Jetzt kostenlos testen", 100, 700)
        XCTAssertEqual(run([l], [el(80, 600, offscreen: true)]), [])
        let screen = El(id: "root", rect: CGRect(x: 0, y: 0, width: 1, height: 1), text: "Jetzt kostenlos testen")
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 1000)], [screen]), [])
    }

    func testCenteredTextPastBothEnds() {
        // Both ends 1.5 line heights past: either side counts.
        let f = run([line("Jetzt kostenlos testen", 100, 700)], [el(160, 640)])
        XCTAssertEqual(f.map(\.reason), ["overflow"])
        XCTAssertEqual(f[0].overflow, 1.5)
        // Both ends past by less than a line height: silent.
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 700)], [el(120, 680)]), [])
        // An icon read into the line's start: 1.5 line heights past the leading edge, the trailing end only padded
        // (0.2 past): not centered overflow.
        XCTAssertEqual(run([line("• Jetzt kostenlos testen", 100, 700)], [el(160, 692)]), [])
        // Past the leading edge only (the trailing end inside): not overflow.
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 700)], [el(200, 720)]), [])
    }

    func testCenteredFallbackWhenTheStartIsOutside() {
        // D22: line 100..700 (center 400), element 300..500: under 80% inside and its start outside, centered on it.
        let l = line("Jetzt kostenlos testen", 100, 700)
        let f = run([l], [el(300, 500)])
        XCTAssertEqual(f.map(\.reason), ["overflow"])
        XCTAssertEqual(f[0].overflow, 5)
        // Near miss: the element's center 1.25 line heights off the line's center.
        XCTAssertEqual(run([l], [el(350, 550)]), [])
        // Near miss: a short line (60..180) whose element reaches past its span (40..200) is not centered overflow.
        XCTAssertNil(Truncation.assignCentered(line("Weiter", 60, 180), [el(40, 200, text: "Weiter")], W: W, H: H))
        // Near miss: the element covers under 80% of the line's height.
        let thin = El(id: "cta", rect: CGRect(x: 300 / W, y: 215 / H, width: 200 / W, height: 20 / H), text: "Jetzt kostenlos testen")
        XCTAssertEqual(run([l], [thin]), [])
    }

    func testRightToLeftTrailingEdgeIsTheLeftOne() {
        let ar = "ابدأ التجربة المجانية الآن"
        let l = line(ar, 100, 700)
        let f = run([l], [el(100 + 2 * lh, 720, text: ar)], locale: "ar")
        XCTAssertEqual(f.map(\.reason), ["overflow"])
        XCTAssertEqual(f[0].overflow, 2)
        // Past the right (leading) end only: silent.
        XCTAssertEqual(run([l], [el(80, 700 - 2 * lh, text: ar)], locale: "ar"), [])
    }

    func testStartAnchoredAssignmentOnlyForLinesNoElementHolds() {
        // Line 100..700, button 80..300: under 80% inside, so the element holding its start ("Jet") takes it.
        let l = line("Jetzt kostenlos testen", 100, 700)
        let f = run([l], [el(80, 300)])
        XCTAssertEqual(f.map(\.reason), ["overflow"])
        XCTAssertEqual(f[0].overflow, 10)
        // A whole-screen root holding it at 80% does not stop the fallback.
        let root = El(id: "root", rect: CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertEqual(run([l], [root, el(80, 300)]).map(\.reason), ["overflow"])
        // A textless card holding the line at 80% does not take it from its label (TODO-044 D8 reopens D3).
        let card = El(id: "card", rect: CGRect(x: 50 / W, y: 150 / H, width: 900 / W, height: 200 / H))
        XCTAssertEqual(run([l], [card, el(80, 300)]).map(\.element?.id), ["cta"])
        // The start outside every element: nothing.
        XCTAssertEqual(run([l], [el(400, 650)]), [])
        // Unspaced scripts anchor on 2 characters.
        XCTAssertEqual(Truncation.assignStart(line("今すぐ無料で試す", 100, 500), [el(90, 210, text: "今すぐ無料で試す")], rtl: false, locale: "ja"), 0)
    }

    /// TODO-044: an element whose `text` does not hold the line never takes it from the line's own element.
    func testTextlessOrOtherTextElementsDoNotTakeTheLine() {
        let l = line("Jetzt kostenlos testen", 100, 700)
        let label = el(80, 300) // holds the start ("Jet"), under 80% of the line
        let around = CGRect(x: 50 / W, y: 150 / H, width: 900 / W, height: 200 / H)
        // 80% owner step: a card with no text, or with another string.
        XCTAssertEqual(run([l], [El(id: "card", rect: around), label]).map(\.element?.id), ["cta"])
        XCTAssertEqual(run([l], [El(id: "card", rect: around, text: "Abbrechen"), label]).map(\.element?.id), ["cta"])
        // Start step: a smaller textless icon over the line's first characters.
        let icon = El(id: "icon", rect: CGRect(x: 90 / W, y: 190 / H, width: 110 / W, height: 60 / H))
        let f = run([l], [icon, label])
        XCTAssertEqual(f.map(\.element?.id), ["cta"])
        XCTAssertEqual(f[0].overflow, 10)
        // Centered step (D22): a textless icon under a centered line's center.
        let dot = El(id: "icon", rect: CGRect(x: 370 / W, y: 190 / H, width: 60 / W, height: 60 / H))
        XCTAssertEqual(run([l], [dot, el(300, 500)]).map(\.element?.id), ["cta"])
        // D5 gap: a container whose text merges the label's holds the line and keeps it, so no finding.
        XCTAssertEqual(run([l], [El(id: "cell", rect: around, text: "Jetzt kostenlos testen, Mehr erfahren"), label]), [])
        // An overhang under 1.0 line height stays silent with a card around it.
        XCTAssertEqual(run([l], [El(id: "card", rect: around), el(80, 690)]), [])
    }

    // Value: protects=TODO-044 assignOverflow: a whole-screen element whose text holds the line does not end the
    // start/centered fallback; fails_when=the wholeScreen check on the 80% owner is dropped (the root takes the line and
    // overflow() skips it, silent); why_new=testStartAnchored's root has no text, so ownText already filters it;
    // seam=none; no_claim=real dumps whose root carries the screen's text (synthetic boxes only)
    func testWholeScreenElementWithTheLinesTextDoesNotStopTheFallback() {
        let l = line("Jetzt kostenlos testen", 100, 700)
        let root = El(id: "root", rect: CGRect(x: 0, y: 0, width: 1, height: 1), text: "Jetzt kostenlos testen")
        let f = run([l], [root, el(80, 300)])
        XCTAssertEqual(f.map(\.element?.id), ["cta"])
        XCTAssertEqual(f.first?.overflow, 10)
    }

    /// TODO-044 D8: a symbol read into the line (a chevron after it, a bullet before it) is not overflow.
    func testSymbolsReadIntoTheLineDoNotCount() {
        // 24 characters over 600 px: the chevron's share is the last 50 px. Untrimmed 1.5 line heights past, trimmed 0.25.
        XCTAssertEqual(run([line("Jetzt kostenlos testen ›", 100, 700)], [el(80, 640)]), [])
        // The same line with its text really past: still overflow, measured without the chevron.
        let f = run([line("Jetzt kostenlos testen ›", 100, 700)], [el(80, 450)])
        XCTAssertEqual(f.map(\.reason), ["overflow"])
        XCTAssertEqual(f[0].overflow, 5)
        // Right to left the line's start is its right end: a bullet there is trimmed from the right.
        let ar = "ابدأ التجربة المجانية الآن"
        XCTAssertEqual(run([line("• " + ar, 100, 700)], [el(130, 650, text: ar)], locale: "ar"), [])
        XCTAssertEqual(Truncation.wordSpan(line("• " + ar, 100, 700), rtl: true).maxX * W, 700 - 600 * 2 / 28, accuracy: 0.01)
        // A symbol of the element's own text is text: a price running past its frame keeps its currency sign.
        let price = run([line("Jetzt 9,99 €", 100, 700)], [el(80, 450, text: "Jetzt 9,99 €")])
        XCTAssertEqual(price.first?.overflow, 6.25)
        // Only a symbol at the same end of the element's text stays: a merged "()" before "Konto (privat)" is trimmed.
        XCTAssertEqual(Truncation.wordSpan(line("() Konto (privat)", 100, 700), rtl: false, text: "Konto (privat)").minX * W, 100 + 600.0 * 3 / 17, accuracy: 0.01)
        // Compared after the fold: a fullwidth "％" in the element's text keeps Vision's "%".
        XCTAssertEqual(Truncation.wordSpan(line("Rabatt 50%", 100, 700), rtl: false, text: "Rabatt 50％").maxX * W, 700, accuracy: 0.01)
        // An offscreen element with the line's text (a hidden carousel page) does not take it from the visible label.
        let hidden = el(80, 720, offscreen: true, id: "hidden")
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 700)], [hidden, el(80, 300)]).map(\.element?.id), ["cta"])
        // A symbol after the text right to left sits at the left end: trimmed from the left.
        XCTAssertEqual(Truncation.wordSpan(line(ar + " ‹", 100, 700), rtl: true).minX * W, 100 + 600 * 2 / 28, accuracy: 0.01)
    }

    func testOnlyTheElementsOwnText() {
        // A neighbouring label drawn into the frame is not overflow.
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 700)], [el(80, 600, text: "Abbrechen")]), [])
        // No text in the element: nothing to match.
        XCTAssertEqual(run([line("Jetzt kostenlos testen", 100, 700)], [el(80, 600, text: nil)]), [])
        // A line that is part of the text still matches.
        XCTAssertEqual(run([line("Jetzt kostenlos", 100, 500)], [el(80, 400)]).map(\.reason), ["overflow"])
    }

    func testAllowListAndNoBoxes() {
        let l = line("Jetzt kostenlos testen", 100, 700)
        XCTAssertEqual(run([l], [el(80, 600)], allow: ["Jetzt kostenlos testen"]), [])
        // Without boxes there is no container: no overflow rule.
        let r = Truncation.evaluate(TruncationJob(), lines: [l], width: Int(W), height: Int(H), locale: "de")
        XCTAssertFalse(r.contains { $0.reason == "overflow" })
    }

    func testFindingEncodesOverflow() throws {
        let f = trailing(1.4)[0]
        let o = try JSONSerialization.jsonObject(with: JSONLine.encode(f)) as! [String: Any]
        XCTAssertEqual(Set(o.keys), ["kind", "box", "line", "reason", "element", "expected", "confidence", "overflow"])
        XCTAssertEqual(o["overflow"] as? Double, 1.4)
    }

    func testFallbackReaderWarnsOnlyWhenOverflowRan() {
        var j = TruncationJob()
        XCTAssertNil(Truncation.unmeasuredOnFallback(j)) // no boxes: the rule did not run
        j.boxes = .init(width: W, height: H, elements: [])
        let d = Truncation.unmeasuredOnFallback(j)
        XCTAssertEqual(d?.code, "rule-unmeasured-reader")
        XCTAssertEqual(d?.hint, "--reasons ellipsis,prefix,edge,screen-edge to skip it")
        j.reasons = ["edge"]
        XCTAssertNil(Truncation.unmeasuredOnFallback(j))
    }

    func testServeAcceptsTheReason() {
        guard case .success(let j) = Server.truncationJob(["reasons": ["overflow"]]) else { return XCTFail() }
        XCTAssertEqual(j.reasons, ["overflow"])
    }
}
