// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-049 rule: text cut off by a panel, on synthetic elements and recognized lines, no Vision.
/// The image is 1000 x 1000 px; three 20 px distractor lines set the median line height (0.02), so the edge tolerance is 10 px.
final class OcclusionTests: XCTestCase {
    typealias El = TruncationJob.Element
    func el(_ id: String?, _ text: String?, _ x: Double, _ y: Double, _ w: Double, _ h: Double,
            panel: Bool = false, scrolls: Bool = false, graphic: Bool = false) -> El {
        El(id: id, rect: CGRect(x: x, y: y, width: w, height: h), text: text, graphic: graphic, panel: panel, scrolls: scrolls)
    }
    func line(_ t: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double = 0.02) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: w, height: h), confidence: 0.9)
    }
    let distractors = [
        RecognizedLine(text: "Start", rect: CGRect(x: 0.1, y: 0.05, width: 0.1, height: 0.02), confidence: 0.99),
        RecognizedLine(text: "Optionen", rect: CGRect(x: 0.1, y: 0.10, width: 0.15, height: 0.02), confidence: 0.99),
        RecognizedLine(text: "Hilfe", rect: CGRect(x: 0.1, y: 0.15, width: 0.1, height: 0.02), confidence: 0.99),
    ]
    func run(_ els: [El], _ lines: [RecognizedLine], occlusion: Bool = true, min: Double? = nil, allow: [String] = []) -> [Finding] {
        var job = OverlapJob(minOverlap: min, boxes: TruncationJob.Boxes(width: 1000, height: 1000, elements: els), allow: allow)
        job.occlusion = occlusion
        return Overlap.evaluate(job, lines: distractors + lines, width: 1000, height: 1000, locale: "de")
    }
    // A toast on the right: the label runs under it from the left; Vision reads its start up to the toast's edge.
    let toast = TruncationJob.Element(id: "toast", rect: CGRect(x: 0.6, y: 0.4, width: 0.4, height: 0.1), panel: true)
    let label = TruncationJob.Element(id: "notify", rect: CGRect(x: 0.3, y: 0.42, width: 0.5, height: 0.03), text: "Benachrichtigungen aktivieren")
    var cutRead: RecognizedLine { line("Benachrichtigungen", 0.3, 0.425, 0.302) } // 2 px past the edge

    func testPartialReadAtThePanelEdgeIsAFinding() {
        // Value: protects=rule steps 2-5 (a strict start of the text read up to the panel edge confirms; output shape); fails_when=the edge test, the head match or the output fields break; why_new=new rule; seam=none; no_claim=Vision reads (test/overlap.test.js)
        let f = run([label, toast], [cutRead])
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f[0].kind, "occluded")
        XCTAssertEqual(f[0].signal, "elements")
        XCTAssertEqual(f[0].line, "Benachrichtigungen aktivieren / [toast]")
        XCTAssertEqual(f[0].a?.text, "Benachrichtigungen aktivieren")
        XCTAssertNil(f[0].b?.text)
        XCTAssertEqual(f[0].b?.element?.id, "toast")
        XCTAssertEqual(f[0].overlap, 0.4) // 0.2 of the label's 0.5 width under the toast
        // A panel with no id is named [panel].
        XCTAssertEqual(run([label, el(nil, nil, 0.6, 0.4, 0.4, 0.1, panel: true)], [cutRead]).first?.line, "Benachrichtigungen aktivieren / [panel]")
    }

    func testTheInkDecidesWhichSideIsOnTop() {
        // Value: protects=D2, D3 (a read inside the panel means see-through or on top; a read ending early is not cut there; no ink, no finding); fails_when=the deep test or the edge tolerance is dropped; why_new=new; seam=none; no_claim=none beyond protects
        XCTAssertEqual(run([label, toast], [line("Benachrichtigungen aktivieren", 0.3, 0.425, 0.48)]).count, 0) // read whole through it
        XCTAssertEqual(run([label, toast], [line("Benachrichtigungen", 0.3, 0.425, 0.2)]).count, 0) // ends 100 px before the edge
        XCTAssertEqual(run([label, toast], [line("Benachrichtigungen aktivieren", 0.3, 0.425, 0.31)]).count, 0) // whole, 10 px past: on top
        XCTAssertEqual(run([label, toast], [line("Benachrichtigungen akt", 0.3, 0.425, 0.31)]).count, 0) // 10 px past: past the reach
        XCTAssertEqual(run([label, toast], []).count, 0) // nothing read: D3
        // A read of another element's text inside the label's box is not its ink.
        XCTAssertEqual(run([label, toast, el("x", "Start", 0.0, 0.0, 0.05, 0.02)], [line("Start", 0.3, 0.425, 0.302)]).count, 0)
    }

    func testCutAcrossItsHeightByAFooter() {
        // Value: protects=D12 height cut (a line whose lower half is under a footer reads short and ends at the footer's top); fails_when=the vertical edge or the cut constant breaks; why_new=new; seam=none; no_claim=how Vision reads half glyphs (bench)
        let footer = el("footer", nil, 0, 0.8, 1, 0.2, panel: true)
        let total = el(nil, "Gesamtsumme inklusive Versand", 0.1, 0.78, 0.6, 0.04)
        XCTAssertEqual(run([total, footer], [line("Gesamtsumme inklusive Versand", 0.1, 0.79, 0.55, 0.012)]).count, 1)
        // A full-height line ending at the footer is not cut, and the text read whole is not a part.
        XCTAssertEqual(run([total, footer], [line("Gesamtsumme inklusive Versand", 0.1, 0.78, 0.55, 0.02)]).count, 0)
    }

    func testWrappedParagraphCutAfterItsFirstLines() {
        // Value: protects=D12 joined reads (the lines read before the edge are a strict start of the paragraph; a paragraph read whole is not cut); fails_when=only the edge line is matched or wrapped lines count as cut; why_new=Codex finding (element-wide partial); seam=none; no_claim=none beyond protects
        let footer = el("footer", nil, 0, 0.8, 1, 0.2, panel: true)
        let p = el("p", "Eins zwei drei vier fünf sechs sieben", 0.1, 0.72, 0.4, 0.12)
        let first = [line("Eins zwei drei", 0.1, 0.735, 0.3), line("vier fünf", 0.1, 0.782, 0.2)]
        XCTAssertEqual(run([p, footer], first).count, 1)
        // Read whole (all three lines above the footer, the element box only padding into it): not cut.
        let whole = el("p", "Eins zwei drei vier fünf sechs sieben", 0.1, 0.70, 0.4, 0.105)
        let all = [line("Eins zwei drei", 0.1, 0.70, 0.3), line("vier fünf", 0.1, 0.735, 0.2), line("sechs sieben", 0.1, 0.775, 0.25)]
        XCTAssertEqual(run([whole, footer], all).count, 0)
    }

    func testOutOfPlay() {
        // Value: protects=rule steps 1-2 skips (gate off, scrolls, graphic, 90% inside, panel inside text, under --min-overlap, same id, allow by text and both ids); fails_when=any skip is lost; why_new=new; seam=none; no_claim=none beyond protects
        XCTAssertEqual(run([label, toast], [cutRead], occlusion: false).count, 0) // D6: only with --experimental
        XCTAssertEqual(run([el("notify", "Benachrichtigungen aktivieren", 0.3, 0.42, 0.5, 0.03, scrolls: true), toast], [cutRead]).count, 0)
        XCTAssertEqual(run([el("notify", "Benachrichtigungen aktivieren", 0.3, 0.42, 0.5, 0.03, graphic: true), toast], [cutRead]).count, 0)
        // Its content: 93% of the text is under the toast, read up to the toast's edge.
        let content = el("x", "Benachrichtigungen aktivieren", 0.58, 0.42, 0.3, 0.03)
        XCTAssertEqual(run([content, toast], [line("Benach", 0.58, 0.425, 0.022)]).count, 0)
        // A panel 91% inside the text, crossing its right edge: the text is read up to the panel's edge.
        let small = el("small", nil, 0.75, 0.42, 0.055, 0.03, panel: true)
        XCTAssertEqual(run([label, small], [line("Benachrichtigungen akti", 0.3, 0.425, 0.452)]).count, 0)
        XCTAssertEqual(run([label, toast], [cutRead], min: 0.5).count, 0)
        XCTAssertEqual(run([label, el("notify", nil, 0.6, 0.4, 0.4, 0.1, panel: true)], [cutRead]).count, 0)
        for a in ["notify", "toast", "Benachrichtigungen aktivieren"] { XCTAssertEqual(run([label, toast], [cutRead], allow: [a]).count, 0, a) }
        // D25: `panel` leaves the TODO-046 rule as it was: a fixed icon button pairs as a graphic, a fixed label as text.
        let title = el("title", "Angebote", 0.1, 0.3, 0.2, 0.03), read = line("Angebote", 0.1, 0.305, 0.19)
        XCTAssertEqual(run([title, el("bell", nil, 0.28, 0.3, 0.05, 0.03, panel: true, graphic: true)], [read], occlusion: false).map(\.kind), ["overlap"])
        XCTAssertEqual(run([el("title", "Angebote", 0.1, 0.3, 0.2, 0.03, panel: true), el("bell", nil, 0.28, 0.3, 0.05, 0.03, graphic: true)], [read], occlusion: false).map(\.kind), ["overlap"])
        // D25: a line beside the panel on the other axis has no glyph under it (a short line in a full-width box).
        let wide = el("help", "Hilfe und Kontakt", 0.0, 0.42, 1.0, 0.03), short = line("Hilfe", 0.02, 0.425, 0.08)
        XCTAssertEqual(run([wide, el("chat", nil, 0.8, 0.443, 0.15, 0.2, panel: true)], [short]).count, 0)
        XCTAssertEqual(run([wide, el("bar", nil, 0.0, 0.443, 0.95, 0.2, panel: true)], [short]).count, 1)
    }

    func testServeParsesTheNewFields() {
        // Value: protects=D2, D11 wire contract (panel and scrolls booleans; overlap.occlusion boolean); fails_when=a field is dropped or a non-boolean is accepted; why_new=new fields; seam=none; no_claim=none beyond protects
        let el: [String: Any] = ["box": [0.1, 0.1, 0.2, 0.2], "panel": true, "scrolls": true]
        guard case .success(let j) = Server.overlapJob(["boxes": ["image": ["width": 10, "height": 10], "elements": [el]], "occlusion": true]) else { return XCTFail() }
        XCTAssertTrue(j.occlusion)
        XCTAssertEqual(j.boxes?.elements.first?.panel, true)
        XCTAssertEqual(j.boxes?.elements.first?.scrolls, true)
        guard case .failure(let d) = Server.overlapJob(["occlusion": "yes"]) else { return XCTFail() }
        XCTAssertEqual(d.message, "overlap.occlusion must be true or false.")
        guard case .failure(let e) = Server.overlapJob(["boxes": ["image": ["width": 10, "height": 10], "elements": [["box": [0.1, 0.1, 0.2, 0.2], "panel": 1]]]]) else { return XCTFail() }
        XCTAssertEqual(e.message, "overlap.boxes.elements[0].panel must be true or false.")
    }
}
