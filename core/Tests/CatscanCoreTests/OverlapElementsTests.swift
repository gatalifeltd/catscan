// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-046 "Rule": the `elements` reader on synthetic elements and recognized lines, no Vision.
/// The image is 1000 x 1000 px, so a normalized 0.001 is 1 px; three 20 px distractor lines set the median line height.
final class OverlapElementsTests: XCTestCase {
    typealias El = TruncationJob.Element
    func el(_ id: String?, _ text: String?, _ x: Double, _ y: Double, _ w: Double, _ h: Double, graphic: Bool = false, offscreen: Bool = false) -> El {
        El(id: id, rect: CGRect(x: x, y: y, width: w, height: h), text: text, offscreen: offscreen, graphic: graphic)
    }
    func line(_ t: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double = 0.02) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: w, height: h), confidence: 0.9)
    }
    let distractors = [
        RecognizedLine(text: "Start", rect: CGRect(x: 0.1, y: 0.05, width: 0.1, height: 0.02), confidence: 0.99),
        RecognizedLine(text: "Optionen", rect: CGRect(x: 0.1, y: 0.10, width: 0.15, height: 0.02), confidence: 0.99),
        RecognizedLine(text: "Hilfe", rect: CGRect(x: 0.1, y: 0.90, width: 0.1, height: 0.02), confidence: 0.99),
    ]
    func run(_ els: [El], _ lines: [RecognizedLine], min: Double? = nil, allow: [String] = []) -> [Finding] {
        Overlap.evaluate(OverlapJob(minOverlap: min, boxes: TruncationJob.Boxes(width: 1000, height: 1000, elements: els), allow: allow),
                         lines: distractors + lines, width: 1000, height: 1000, locale: "de")
    }
    /// Two labels whose frames intersect by 0.02 of 0.06 tall boxes, and one garbled line Vision read across both.
    var stack: ([El], [RecognizedLine]) {
        ([el("a", "Einstellungen", 0.1, 0.30, 0.4, 0.06), el("b", "Benachrichtigungen", 0.1, 0.34, 0.4, 0.06)],
         [line("Eisenach Ehtigungen", 0.1, 0.33, 0.4)])
    }

    func testCandidatesByElementShare() {
        // Value: protects=step 2 (element-box share of the smaller box, >= --min-overlap; disjoint and touching never pair); fails_when=the share uses the union, > instead of >=, or touching boxes pair; why_new=new reader; seam=none; no_claim=Vision reads (test/overlap.test.js)
        let (els, lines) = stack
        XCTAssertEqual(run(els, lines, min: 0.33).count, 1) // 0.02 x 0.4 over 0.06 x 0.4: one third
        XCTAssertEqual(run(els, lines, min: 0.34).count, 0)
        XCTAssertEqual(run(els, lines).count, 1) // the elements default (D17)
        let touching = [el("a", "Einstellungen", 0.1, 0.30, 0.4, 0.04), el("b", "Benachrichtigungen", 0.1, 0.34, 0.4, 0.04)]
        XCTAssertEqual(run(touching, lines).count, 0)
        XCTAssertEqual(run([els[0], el("b", "Benachrichtigungen", 0.1, 0.5, 0.4, 0.04)], lines).count, 0)
    }

    func testElementsOutOfPlay() {
        // Value: protects=step 1 and step 2 skips (offscreen, unlabeled container, D2 containment, same id, same text); fails_when=any of them forms a pair; why_new=new; seam=none; no_claim=none beyond protects
        let (els, lines) = stack
        XCTAssertEqual(run([els[0], el("b", "Benachrichtigungen", 0.1, 0.34, 0.4, 0.06, offscreen: true)], lines).count, 0)
        XCTAssertEqual(run([els[0], el("box", nil, 0.1, 0.34, 0.4, 0.06)], lines).count, 0) // a container never pairs
        XCTAssertEqual(run([els[0], el("box", "", 0.1, 0.34, 0.4, 0.06)], lines).count, 0)
        // An icon 90% inside its labeled button is nesting, not collision.
        let button = el("ok", "Weiter", 0.1, 0.30, 0.4, 0.06)
        XCTAssertEqual(run([button, el("icon", nil, 0.12, 0.31, 0.04, 0.04, graphic: true)], [line("Weiter", 0.11, 0.31, 0.3)]).count, 0)
        XCTAssertEqual(run([els[0], el("a", "Benachrichtigungen", 0.1, 0.34, 0.4, 0.06)], lines).count, 0) // same id
        XCTAssertEqual(run([els[0], el("b", "Einstellungen", 0.1, 0.34, 0.4, 0.06)], lines).count, 0) // same text
        // Two graphics never pair: no text, so no localization defect.
        XCTAssertEqual(run([el("i1", nil, 0.1, 0.3, 0.1, 0.1, graphic: true), el("i2", nil, 0.15, 0.3, 0.1, 0.1, graphic: true)], lines).count, 0)
    }

    func testSheetsStackedOverEachOther() throws {
        // Value: protects=TODO-072 D1, D2 (a contained pair of unrelated texts of one line height, confirmed by a garbled shared line, is `sheets`; nesting and an undrawn or hidden page are not); fails_when=the D2 gate drops the stack again, the text or height guard lets nesting through, or the box alone confirms; why_new=new rule; seam=none; no_claim=real recall (bench/overlap-sheets.js)
        let wide = el("p1", "Bonusbild freigeschaltet", 0.2, 0.50, 0.6, 0.04), narrow = el("p2", "Neue Abzeichen", 0.3, 0.50, 0.4, 0.04)
        let garbled = line("BonNeubild fAbzeichaltet", 0.21, 0.51, 0.58)
        let f = try XCTUnwrap(run([wide, narrow], [garbled]).first)
        XCTAssertEqual(f.signal, "sheets")
        XCTAssertEqual(f.overlap, 1)
        XCTAssertEqual([f.a?.element?.id, f.b?.element?.id].compactMap { $0 }.sorted(), ["p1", "p2"])
        // Vision reads the top page cleanly and nothing of the other: hidden or undrawn, no finding.
        XCTAssertEqual(run([wide, narrow], [line("Bonusbild freigeschaltet", 0.21, 0.51, 0.58)]).count, 0)
        // Nesting stays skipped: a title in its button (the button's text holds it), a label in a card twice its height.
        XCTAssertEqual(run([el("btn", "Weiter, Schritt 2", 0.2, 0.5, 0.6, 0.04), el("t", "Weiter", 0.3, 0.5, 0.3, 0.04)], [garbled]).count, 0)
        XCTAssertEqual(run([el("card", "Angebot des Tages", 0.2, 0.48, 0.6, 0.08), narrow], [garbled]).count, 0)
        // D11: the height guard is 0.9. An undrawn segmented-control label 0.86 of its segment's height is nesting; a
        // page at 0.95 of the other's height is a sheet.
        XCTAssertEqual(run([el("seg", "Gewichtseinheit", 0.2, 0.50, 0.6, 0.04), el("s1", "Optionsfeld, aktiv", 0.3, 0.503, 0.4, 0.0344)], [garbled]).count, 0)
        XCTAssertEqual(run([wide, el("p2", "Neue Abzeichen", 0.3, 0.501, 0.4, 0.038)], [garbled]).first?.signal, "sheets")
        // A text of punctuation only folds to nothing, and a graphic is not text: neither pairs as a sheet.
        XCTAssertEqual(run([wide, el("dots", "...", 0.3, 0.50, 0.4, 0.04)], [garbled]).count, 0)
        XCTAssertEqual(run([wide, el("icon", nil, 0.3, 0.50, 0.4, 0.04, graphic: true)], [garbled]).count, 0)
        // The same text drawn twice at one place is invisible: no finding.
        XCTAssertEqual(run([wide, el("p3", "Bonusbild freigeschaltet", 0.2, 0.50, 0.6, 0.04)], [garbled]).count, 0)
    }

    func testPaddedFramesWithOwnedLinesPass() {
        // Value: protects=step 3 owned lines and step 4 (frames that intersect with ink apart give no finding); fails_when=frame intersection alone or the typographic pad confirms; why_new=new; seam=none; no_claim=real padding (bench/overlap-elements.js)
        let (els, _) = stack
        XCTAssertEqual(run(els, [line("Einstellungen", 0.12, 0.31, 0.3), line("Benachrichtigungen", 0.12, 0.37, 0.35)]).count, 0)
        // The same two lines 4 px into each other confirm.
        XCTAssertEqual(run(els, [line("Einstellungen", 0.12, 0.33, 0.3), line("Benachrichtigungen", 0.12, 0.346, 0.35)]).count, 1)
    }

    func testSharedLines() {
        // Value: protects=D4 and D17 on a line the pair shares: a garbled stack confirms, a clean merged row splits into adjacent runs, a garbled junction confirms, one side's clean read joins the other only as a tall stack; fails_when=a merged row of adjacent labels confirms or a garbled collision is lost; why_new=new; seam=none; no_claim=Vision's range boxes (the fallback by character share runs here)
        let (els, lines) = stack
        let f = run(els, lines)
        XCTAssertEqual(f.map(\.line), ["Einstellungen / Benachrichtigungen"])
        let row = [el("a", "Einstellungen", 0.1, 0.30, 0.2, 0.03), el("b", "Hilfe", 0.28, 0.30, 0.2, 0.03)]
        XCTAssertEqual(run(row, [line("Einstellungen Hilfe", 0.11, 0.305, 0.36)]).count, 0)
        XCTAssertEqual(run(row, [line("Einstellungehlilfe", 0.11, 0.305, 0.36)]).count, 1)
        // A line that reads as one side, shared by the other's padded frame: that side's ink only, unless it is a tall stack
        // that spills past that side's own frame (D17); a taller font alone is not a stack.
        XCTAssertEqual(run(els, [line("Einstellungen", 0.12, 0.335, 0.3)]).count, 0)
        XCTAssertEqual(run(els, [line("Einstellungen", 0.12, 0.33, 0.3, 0.03)]).count, 0)
        XCTAssertEqual(run(els, [line("Einstellungen", 0.12, 0.30, 0.3, 0.07)]).count, 1)
    }

    func testTextOnGraphic() {
        // Value: protects=step 4 text-graphic depth and the D4 range of a shared text-graphic line; fails_when=a graze confirms, a deep run onto the icon is missed, or the whole merged line stands in for the text side; why_new=new pair type; seam=none; no_claim=real icon padding (bench/overlap-elements.js)
        let label = el("title", "Angebote", 0.1, 0.3, 0.2, 0.03)
        let icon = el("bell", nil, 0.28, 0.3, 0.05, 0.03, graphic: true)
        XCTAssertEqual(run([label, icon], [line("Angebote", 0.1, 0.305, 0.17)]).count, 0) // ends 10 px before the icon
        let f = run([icon, label], [line("Angebote", 0.1, 0.305, 0.19)])
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f.first?.line, "Angebote / [bell]") // the text side first
        // "Hilfe Kontakt": Vision joined the label with a word past the icon; only "Hilfe" is the label's ink.
        let t = el("help", "Hilfe", 0.1, 0.3, 0.12, 0.03), g = el(nil, nil, 0.21, 0.3, 0.1, 0.03, graphic: true)
        XCTAssertEqual(run([t, g], [line("Hilfe Kontakt", 0.105, 0.305, 0.26)]).count, 0)
        XCTAssertEqual(run([t, g], [line("Hilfe Kontakt", 0.105, 0.305, 0.4)]).map(\.line), ["Hilfe / [graphic]"])
        // D17: Vision read the start of the label; the rest is under the picture drawn over it.
        let pic = el("hero", nil, 0.3, 0.2, 0.3, 0.2, graphic: true)
        XCTAssertEqual(run([el("on", "Online", 0.2, 0.3, 0.11, 0.03), pic], [line("Onlin", 0.2, 0.305, 0.095)]).count, 1)
        XCTAssertEqual(run([el("on", "Online", 0.2, 0.3, 0.11, 0.03), pic], [line("Online", 0.2, 0.305, 0.095)]).count, 0)
    }

    func testNoInkNoFinding() throws {
        // Value: protects=spec 06 "No OCR text, no finding" for the reader; fails_when=element boxes alone report; why_new=new; seam=none; no_claim=none beyond protects
        XCTAssertEqual(run(stack.0, []).count, 0)
    }

    func testOutputShape() throws {
        // Value: protects=the TODO-046 Output contract (signal elements, ink boxes, element ids and boxes, union box, overlap share, null text and confidence for a graphic); fails_when=a field is missing, renamed or not null; why_new=new wire shape; seam=none; no_claim=the schema file (packages/core-js/test/overlap.test.js)
        let (els, lines) = stack
        let f = try XCTUnwrap(run(els, lines).first)
        XCTAssertEqual(f.signal, "elements")
        XCTAssertEqual(f.overlap, 0.33)
        XCTAssertEqual(f.a?.element, Finding.Element(id: "a", box: [0.1, 0.3, 0.4, 0.06]))
        XCTAssertEqual(f.b?.element?.id, "b")
        XCTAssertEqual(f.a?.text, "Einstellungen") // the element text, not the read
        XCTAssertEqual(f.a?.confidence, 0.9)
        let json = try JSONSerialization.jsonObject(with: JSONLine.encode(f)) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["kind", "box", "line", "a", "b", "overlap", "signal"])
        XCTAssertEqual(Set((json["a"] as! [String: Any]).keys), ["text", "box", "confidence", "element"])
        let g = try XCTUnwrap(run([el("title", "Angebote", 0.1, 0.3, 0.2, 0.03), el("bell", nil, 0.28, 0.3, 0.05, 0.03, graphic: true)],
                                  [line("Angebote", 0.1, 0.305, 0.19)]).first)
        let b = (try JSONSerialization.jsonObject(with: JSONLine.encode(g)) as! [String: Any])["b"] as! [String: Any]
        XCTAssertTrue(b["text"] is NSNull)
        XCTAssertTrue(b["confidence"] is NSNull)
        XCTAssertEqual(b["box"] as? [Double], [0.28, 0.3, 0.05, 0.03]) // a graphic's box is its element box
        // The union of the text's ink (its line, padded to the typographic box) and the icon's box.
        XCTAssertEqual(g.box, [0.099, 0.3, 0.231, 0.03])
        // The OCR reader's sides keep their shape: no element key.
        let ocr = Overlap.evaluate(OverlapJob(minOverlap: 0.2), lines: [line("Kontoeinstellungen", 0.1, 0.30, 0.4), line("Benachrichtigungen", 0.1, 0.316, 0.4)],
                                   width: 1000, height: 1000, locale: "de")
        let a = (try JSONSerialization.jsonObject(with: JSONLine.encode(ocr[0])) as! [String: Any])["a"] as! [String: Any]
        XCTAssertEqual(Set(a.keys), ["text", "box", "confidence"])
    }

    func testReadingOrderAndAllow() {
        // Value: protects=findings in reading order of `a` and D10 (--allow by element id or text); fails_when=the order follows the input or allow misses a side; why_new=new; seam=none; no_claim=the allow file parsing (packages/core-js/test/overlap.test.js)
        let lower = [el("c", "Unten", 0.1, 0.70, 0.4, 0.06), el("d", "Mitte", 0.1, 0.74, 0.4, 0.06)]
        let lowerLines = [line("Untxen Mitzte", 0.1, 0.73, 0.4)]
        let (els, lines) = stack
        XCTAssertEqual(run(lower + els, lowerLines + lines).map(\.line), ["Einstellungen / Benachrichtigungen", "Unten / Mitte"])
        XCTAssertEqual(run(lower + els, lowerLines + lines, allow: ["b"]).map(\.line), ["Unten / Mitte"])
        XCTAssertEqual(run(lower + els, lowerLines + lines, allow: ["unten"]).map(\.line), ["Einstellungen / Benachrichtigungen"])
    }

    func testWithBoxesOnlyTheElementsReaderRuns() {
        // Value: protects=D3 (with boxes, no OCR-geometry finding); fails_when=both readers run on one image; why_new=new; seam=none; no_claim=the OCR reader (OverlapTests stays green)
        let ocrPair = [line("Kontoeinstellungen", 0.1, 0.30, 0.4), line("Benachrichtigungen", 0.1, 0.316, 0.4)]
        XCTAssertEqual(Overlap.evaluate(OverlapJob(minOverlap: 0.2), lines: ocrPair, width: 1000, height: 1000, locale: "de").map(\.signal), ["boxes"])
        XCTAssertEqual(run([el("far", "Weit", 0.6, 0.6, 0.1, 0.03)], ocrPair, min: 0.2), [])
    }

    func testServeOverlapBoxes() throws {
        // Value: protects=the serve contract (protocol 11, overlap.boxes as truncated, graphic a boolean, allow, no_boxes) and the D12 overlap-no-boxes text; fails_when=a malformed field reaches the rule or the message drifts; why_new=new fields; seam=none; no_claim=the serve loop (test/overlap.test.js)
        func job(_ v: Any) -> Result<OverlapJob, Diagnostic> { Server.overlapJob(v) }
        let boxes: [String: Any] = ["image": ["width": 1170, "height": 2532], "elements": [["id": "bell", "box": [0.1, 0.1, 0.1, 0.1], "graphic": true], ["text": "Hi", "box": [0.2, 0.1, 0.1, 0.1]]]]
        let ok = try job(["boxes": boxes, "allow": ["bell"]]).get()
        XCTAssertEqual(ok.boxes?.elements.map(\.graphic), [true, false])
        XCTAssertEqual(ok.allow, ["bell"])
        var bad = boxes
        bad["elements"] = [["box": [0.1, 0.1, 0.1, 0.1], "graphic": 1]]
        guard case .failure(let d) = job(["boxes": bad]) else { return XCTFail("graphic 1 accepted") }
        XCTAssertEqual(d.code, "invalid-request")
        XCTAssertEqual(d.message, "overlap.boxes.elements[0].graphic must be true or false.")
        guard case .failure(let e) = job(["boxes": ["image": ["width": 0, "height": 1], "elements": []]]) else { return XCTFail() }
        XCTAssertEqual(e.message, "overlap.boxes.image must be {width, height} above 0.")
        guard case .failure = job(["allow": "x"]) else { return XCTFail("allow string accepted") }
        guard case .failure = job(["no_boxes": [:]]) else { return XCTFail("no_boxes without looked accepted") }
        XCTAssertEqual(try job(["no_boxes": ["looked": "shots/de/shop.boxes.json"]]).get().noBoxes, "shots/de/shop.boxes.json")
        // The truncated field keeps its own prefix and now takes graphic too.
        guard case .success(let t) = Server.truncationJob(["boxes": boxes]) else { return XCTFail() }
        XCTAssertEqual(t.boxes?.elements.first?.graphic, true)
        let n = Overlap.noBoxes("shots/de/shop.boxes.json", path: "shots/de/shop.png")
        XCTAssertEqual(n.code, "overlap-no-boxes")
        XCTAssertEqual(n.message, "no boxes for shots/de/shop.png (looked for shots/de/shop.boxes.json); element overlap needs its boxes")
        XCTAssertEqual(n.hint, "catscan boxes <source> <dump> --image shots/de/shop.png > shots/de/shop.boxes.json, or add --experimental for the OCR-only check")
        XCTAssertEqual(serveProtocol, 23)
    }

    func testTruncationIgnoresTextlessGraphics() {
        // Value: protects=T2 (a textless graphic never takes a line from its label in truncated); fails_when=the icon, the smallest element holding the line, owns it and the finding loses its label; why_new=graphics are new in the boxes; seam=none; no_claim=the truncation gate numbers (bench/truncation.js rerun)
        var job = TruncationJob()
        job.boxes = TruncationJob.Boxes(width: 1000, height: 1000, elements: [
            el("label", "Weiter zur Kasse", 0.1, 0.3, 0.4, 0.04), el("chip", nil, 0.1, 0.3, 0.2, 0.04, graphic: true),
        ])
        let f = Truncation.evaluate(job, lines: [line("Weiter…", 0.11, 0.31, 0.15)], width: 1000, height: 1000, locale: "de")
        XCTAssertEqual(f.map(\.reason), ["ellipsis"])
        XCTAssertEqual(f.first?.element?.id, "label")
    }
}
