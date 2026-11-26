// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-074: the `wrapped` and `orphan` reasons of `fit` on synthetic lines and elements (no Vision). Rows are 0.03
/// tall at y 0.40 and 0.44 (and 0.48); elements are normalized boxes.
final class WrappingTests: XCTestCase {
    func line(_ t: String, _ x: Double, _ y: Double, _ w: Double, h: Double = 0.03, conf: Double = 0.9) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: w, height: h), confidence: conf)
    }

    func el(_ id: String?, _ text: String?, _ r: [Double], control: Bool = false, maxLines: Int? = nil, offscreen: Bool = false) -> TruncationJob.Element {
        TruncationJob.Element(id: id, rect: CGRect(x: r[0], y: r[1], width: r[2], height: r[3]), text: text, offscreen: offscreen, control: control, maxLines: maxLines)
    }

    func job(_ elements: [TruncationJob.Element], reasons: Set<String> = ["wrapped"], base: [WrapJob.BaseRow]? = nil) -> FitJob {
        var j = FitJob()
        j.reasons = reasons
        j.boxes = TruncationJob.Boxes(width: 100, height: 200, elements: elements)
        j.wrap.base = base
        j.wrap.basePath = base == nil ? nil : "shots/en/paywall.png"
        return j
    }

    func run(_ j: FitJob, _ lines: [RecognizedLine], locale: String = "de") -> Fit.Outcome {
        Fit.evaluate(j, lines: lines, width: 100, height: 200, path: "s.png", locale: locale)
    }

    /// "Jetzt kostenlos / testen" in a 0.08-tall button.
    var cta: [RecognizedLine] { [line("Jetzt kostenlos", 0.30, 0.40, 0.40), line("testen", 0.40, 0.44, 0.20, conf: 0.8)] }
    func ctaEl(control: Bool = false, maxLines: Int? = nil, id: String? = "cta-trial") -> TruncationJob.Element {
        el(id, "Jetzt kostenlos testen", [0.25, 0.39, 0.50, 0.09], control: control, maxLines: maxLines)
    }

    func testRows() {
        // Value: protects="Rows of an element" (merge, symbol rows, own text only, text-only owner); fails_when=one row split in two counts twice, a "•" row counts, a neighbor's line is joined, or a textless container takes the lines; why_new=new rule; seam=Wrapping.judge; no_claim=Vision's line splitting
        // Two observations on one row merge (Vision splits a row at a wide gap).
        let split = [line("Jetzt", 0.30, 0.40, 0.10), line("kostenlos", 0.42, 0.405, 0.20), line("testen", 0.40, 0.44, 0.20)]
        XCTAssertEqual(Wrapping.judge([ctaEl()], lines: split, locale: "de").first?.rows.count, 2)
        // A symbol-only row is dropped.
        XCTAssertEqual(Wrapping.judge([ctaEl()], lines: cta + [line("•", 0.45, 0.47, 0.02, h: 0.01)], locale: "de").first?.rows.count, 2)
        // Rows that do not join to the element text: not judged (a truncation, a neighbor's line, an OCR error).
        XCTAssertTrue(Wrapping.judge([ctaEl()], lines: [line("Jetzt kostenlos", 0.30, 0.40, 0.40), line("tes...", 0.40, 0.44, 0.10)], locale: "de").isEmpty)
        XCTAssertTrue(Wrapping.judge([ctaEl()], lines: cta + [line("Abbrechen", 0.30, 0.455, 0.30, h: 0.02)], locale: "de").isEmpty)
        // A textless container never takes a label's lines; the label element does.
        let els = [el("card", nil, [0, 0.3, 1, 0.3]), ctaEl()]
        XCTAssertEqual(Wrapping.judge(els, lines: cta, locale: "de").map(\.index), [1])
        // A break inside an unspaced script compares equal (spaces ignored).
        let ja = [el("t", "設定を保存する", [0.2, 0.39, 0.3, 0.09])]
        XCTAssertEqual(Wrapping.judge(ja, lines: [line("設定を保存", 0.22, 0.40, 0.25), line("する", 0.22, 0.44, 0.10)], locale: "ja").first?.rows.count, 2)
    }

    func testWrappedEvidenceOrder() {
        // Value: protects=wrapped evidence order declared > base > control, base 2 rows not flagged, control only without a base element (D2, D12); fails_when=an evidence is skipped, reordered, or a design wrap is flagged; why_new=new rule; seam=Wrapping.evaluate; no_claim=real dumps
        // declared wins over everything, even a base with two rows.
        let d = run(job([ctaEl(maxLines: 1)], base: [.init(id: "cta-trial", text: "Start free trial now", rows: 2, orphan: false)]), cta)
        XCTAssertEqual(d.findings.map(\.evidence), ["declared"])
        // base: one row on en, short string.
        let b = run(job([ctaEl(control: true)], base: [.init(id: "cta-trial", text: "Start free trial", rows: 1, orphan: false)]), cta)
        XCTAssertEqual(b.findings.map(\.evidence), ["base"])
        XCTAssertEqual(b.findings.first?.baseRows, 1)
        XCTAssertEqual(b.findings.first?.basePath, "shots/en/paywall.png")
        // base with two rows: the design wraps; control is not consulted when a base element is found.
        XCTAssertTrue(run(job([ctaEl(control: true)], base: [.init(id: "cta-trial", text: "Start free trial", rows: 2, orphan: false)]), cta).findings.isEmpty)
        // control: no base element (none in the run, or none paired).
        XCTAssertEqual(run(job([ctaEl(control: true)]), cta).findings.map(\.evidence), ["control"])
        XCTAssertEqual(run(job([ctaEl(control: true)], base: [.init(id: "other", text: "x", rows: 1, orphan: false)]), cta).findings.map(\.evidence), ["control"])
        // No evidence at all: a plain label that wraps is not flagged.
        XCTAssertTrue(run(job([ctaEl()]), cta).findings.isEmpty)
        // An evidence type that missed its gate is not used (D20).
        var j = job([ctaEl(control: true)])
        j.wrap.evidence = ["declared", "base"]
        XCTAssertTrue(run(j, cta).findings.isEmpty)
        // One row: never wrapped.
        XCTAssertTrue(run(job([ctaEl(maxLines: 1)]), [line("Jetzt kostenlos testen", 0.27, 0.40, 0.46)]).findings.isEmpty)
    }

    func testShortBaseBound() {
        // Value: protects=D5's short-text bound at 4 words and 32 characters, 12 unspaced; fails_when=the bound is off by one either way; why_new=new rule; seam=Wrapping.short; no_claim=none
        XCTAssertTrue(Wrapping.short("Start your free trial", locale: "en"))
        XCTAssertFalse(Wrapping.short("Start your free trial today", locale: "en")) // 5 words
        XCTAssertTrue(Wrapping.short(String(repeating: "a", count: 32), locale: "en"))
        XCTAssertFalse(Wrapping.short(String(repeating: "a", count: 33), locale: "en"))
        XCTAssertTrue(Wrapping.short(String(repeating: "字", count: 12), locale: "ja"))
        XCTAssertFalse(Wrapping.short(String(repeating: "字", count: 13), locale: "ja"))
        // A long base string that fits one row may wrap in a translation by design.
        let long = run(job([ctaEl(control: true)], base: [.init(id: "cta-trial", text: "Start your free trial today and save", rows: 1, orphan: false)]), cta)
        XCTAssertTrue(long.findings.isEmpty)
    }

    func testControlEvidence() {
        // Value: protects=D12's control: by flag, by a 90%-inside control of at most 4 line heights holding no other text; fails_when=a card, a chip with a subtitle or a tall row counts as a control; why_new=new rule; seam=Wrapping.controlLabel; no_claim=converter control flags
        let label = el("l", "Jetzt kostenlos testen", [0.28, 0.395, 0.44, 0.08])
        // A 0.10-tall button around the label (median line height 0.03: 3.3 heights).
        let button = el("b", nil, [0.25, 0.39, 0.50, 0.10], control: true)
        XCTAssertEqual(run(job([button, label]), cta).findings.map(\.evidence), ["control"])
        // A button whose own text is the label (XCUITest: Button "x" > StaticText "x") is still the only label.
        let same = el("b", "Jetzt kostenlos testen", [0.25, 0.39, 0.50, 0.10], control: true)
        XCTAssertEqual(run(job([same, label]), cta).findings.map(\.evidence), ["control"])
        // A tall tappable card (0.30 = 10 line heights) is not a control.
        let card = el("card", nil, [0.1, 0.35, 0.8, 0.30], control: true)
        XCTAssertTrue(run(job([card, label]), cta).findings.isEmpty)
        // A chip with a subtitle: another text element inside the control.
        let sub = el("s", "7 Tage gratis", [0.3, 0.47, 0.3, 0.015])
        XCTAssertTrue(run(job([button, label, sub]), cta + [line("7 Tage gratis", 0.3, 0.47, 0.3, h: 0.015)]).findings.isEmpty)
        // A label only half inside the control is not its label.
        let off = el("b", nil, [0.25, 0.43, 0.50, 0.08], control: true)
        XCTAssertTrue(run(job([off, label]), cta).findings.isEmpty)
    }

    func testSkips() {
        // Value: protects="Not flagged": offscreen, --allow by id and by text; fails_when=a skipped element is reported; why_new=new rule; seam=Wrapping.evaluate; no_claim=none
        XCTAssertTrue(run(job([el("cta-trial", "Jetzt kostenlos testen", [0.25, 0.39, 0.50, 0.09], maxLines: 1, offscreen: true)]), cta).findings.isEmpty)
        var j = job([ctaEl(maxLines: 1)])
        j.allow = ["cta-trial"]
        XCTAssertTrue(run(j, cta).findings.isEmpty)
        j.allow = ["jetzt kostenlos testen"]
        XCTAssertTrue(run(j, cta).findings.isEmpty)
    }

    func testOrphan() {
        // Value: protects=orphan rule (D6): 2-3 rows, one word, a third of the widest row, numbers, base orphan; fails_when=4 rows flagged, a wide or two-word last row flagged, a price flagged; why_new=new rule; seam=Wrapping.orphanWord; no_claim=Vision's row boxes
        let title = el("title", "Ihre persönlichen Einstellungen für Benachrichtigungen ändern", [0.1, 0.39, 0.8, 0.14])
        let three = [line("Ihre persönlichen Einstellungen", 0.12, 0.40, 0.70), line("für Benachrichtigungen", 0.12, 0.44, 0.55), line("ändern", 0.12, 0.48, 0.15)]
        let r = run(job([title], reasons: ["orphan"]), three)
        XCTAssertEqual(r.findings.map(\.orphan), ["ändern"])
        XCTAssertEqual(r.findings.first?.rows, 3)
        XCTAssertEqual(r.findings.first?.line, "Ihre persönlichen Einstellungen / für Benachrichtigungen / ändern")
        XCTAssertEqual(r.findings.first?.confidence, 0.9)
        // 4 rows: body text.
        let body = el("p", "eins zwei drei vier fünf sechs sieben acht neun", [0.1, 0.39, 0.8, 0.2])
        XCTAssertTrue(run(job([body], reasons: ["orphan"]), [line("eins zwei drei", 0.1, 0.40, 0.7), line("vier fünf sechs", 0.1, 0.44, 0.7), line("sieben acht", 0.1, 0.48, 0.7), line("neun", 0.1, 0.52, 0.1)]).findings.isEmpty)
        // Wider than a third of the widest row (0.24 > 0.70 / 3).
        XCTAssertTrue(run(job([title], reasons: ["orphan"]), [three[0], three[1], line("ändern", 0.12, 0.48, 0.24)]).findings.isEmpty)
        // At exactly a third: flagged.
        XCTAssertEqual(run(job([title], reasons: ["orphan"]), [line("Ihre persönlichen Einstellungen", 0.12, 0.40, 0.75), three[1], line("ändern", 0.12, 0.48, 0.25)]).findings.count, 1)
        // Two words in the last row.
        let two = el("t", "Konto jetzt endgültig löschen", [0.1, 0.39, 0.8, 0.09])
        XCTAssertTrue(run(job([two], reasons: ["orphan"]), [line("Konto jetzt endgültig", 0.1, 0.40, 0.7), line("lö schen", 0.1, 0.44, 0.2)]).findings.isEmpty)
        // A price or a time alone.
        let price = el("p", "Jahresabo für nur 9,99 €", [0.1, 0.39, 0.8, 0.09])
        XCTAssertTrue(run(job([price], reasons: ["orphan"]), [line("Jahresabo für nur", 0.1, 0.40, 0.7), line("9,99 €", 0.1, 0.44, 0.15)]).findings.isEmpty)
        // The base's last row is also one word: the design accepts it.
        var j = job([title], reasons: ["orphan"], base: [.init(id: "title", text: "Change your notification settings", rows: 2, orphan: true)])
        XCTAssertTrue(run(j, three).findings.isEmpty)
        j.wrap.base = [.init(id: "title", text: "Change your notification settings", rows: 1, orphan: false)]
        XCTAssertEqual(run(j, three).findings.count, 1)
        // orphan is not wrapped: only the named reasons run.
        XCTAssertEqual(run(job([title], reasons: ["orphan"]), three).findings.map(\.reason), ["orphan"])
    }

    func testTokenizerPerScript() {
        // Value: protects=one word per NLTokenizer in spaced and unspaced scripts (recorded tokens on this OS); fails_when=a script's segmentation changes the orphan count; why_new=new dependency; seam=Wrapping.words; no_claim=NLTokenizer on other OS builds
        XCTAssertEqual(Wrapping.words("testen.", locale: "de"), ["testen"])
        XCTAssertEqual(Wrapping.words("удалить", locale: "ru"), ["удалить"])
        XCTAssertEqual(Wrapping.words("الإعدادات", locale: "ar"), ["الإعدادات"])
        XCTAssertEqual(Wrapping.words("설정", locale: "ko"), ["설정"])
        XCTAssertEqual(Wrapping.words("設定", locale: "ja").count, 1)
        XCTAssertEqual(Wrapping.words("设置", locale: "zh-Hans").count, 1)
        XCTAssertEqual(Wrapping.words("การตั้งค่า", locale: "th").count, 1)
        XCTAssertGreaterThan(Wrapping.words("ภาษาไทยง่าย", locale: "th").count, 1)
        XCTAssertEqual(Wrapping.words("Konto löschen", locale: "de").count, 2)
    }

    func testUnspacedExtras() {
        // Value: protects=ja/zh/yue extras: a last row of at most 2 characters and a closing-punctuation row whatever its width; fails_when=a stranded kanji or "。" row is missed, or the extra leaks into ko/th; why_new=new rule; seam=Wrapping.orphanWord; no_claim=kinsoku rules
        let t = el("t", "通知設定を変更する", [0.1, 0.39, 0.8, 0.09])
        // "する" is 2 characters; the tokenizer may call it one word anyway.
        XCTAssertEqual(run(job([t], reasons: ["orphan"]), [line("通知設定を変更", 0.1, 0.40, 0.6), line("する", 0.1, 0.44, 0.1)], locale: "ja").findings.count, 1)
        let p = el("t", "通知設定を変更する。", [0.1, 0.39, 0.8, 0.09])
        let punct = [line("通知設定を変更する", 0.1, 0.40, 0.6), line("。", 0.1, 0.44, 0.3)]
        XCTAssertEqual(run(job([p], reasons: ["orphan"]), punct, locale: "ja").findings.map(\.orphan), ["。"])
        // In ko the closing-punctuation extra does not apply (and a punctuation row has no word).
        XCTAssertTrue(run(job([p], reasons: ["orphan"]), punct, locale: "ko").findings.isEmpty)
    }

    func testRightToLeft() {
        // Value: protects=RTL rows ordered top to bottom, lines in a row right to left; width bound and token count as in LTR; fails_when=an ar or he row joins in the wrong order or the orphan differs; why_new=new rule; seam=Wrapping.rows; no_claim=bidi layout
        // ar: one row split by Vision in two observations, right part first in reading order.
        let ar = el("t", "تغيير إعدادات الإشعارات الخاصة بك", [0.1, 0.39, 0.8, 0.09])
        let lines = [line("الإشعارات الخاصة", 0.10, 0.40, 0.35), line("تغيير إعدادات", 0.50, 0.40, 0.35), line("بك", 0.70, 0.44, 0.08)]
        let r = run(job([ar], reasons: ["orphan"]), lines, locale: "ar")
        XCTAssertEqual(r.findings.first?.line, "تغيير إعدادات الإشعارات الخاصة / بك")
        XCTAssertEqual(r.findings.first?.orphan, "بك")
        let he = el("t", "שנה את ההגדרות שלך", [0.1, 0.39, 0.8, 0.09])
        XCTAssertEqual(run(job([he], reasons: ["orphan"]), [line("שנה את ההגדרות", 0.2, 0.40, 0.7), line("שלך", 0.7, 0.44, 0.1)], locale: "he").findings.map(\.orphan), ["שלך"])
    }

    func testCatalogPairing() {
        // Value: protects=D3 and D13: pairing by id first, then by catalog key after normalization; a string shared by two keys pairs by none; key and catalog on the finding (D18); fails_when=a duplicated string pairs, or normalization stops pairing; why_new=new rule; seam=Wrapping.base; no_claim=catalog parsing (Node)
        var j = job([ctaEl(id: nil)], base: [.init(id: nil, text: "Start free trial", rows: 1, orphan: false)])
        j.wrap.pairs = [.init(key: "cta.trial", target: "Jetzt  kostenlos TESTEN", base: "Start free trial"), .init(key: "other", target: "Abbrechen", base: "Cancel")]
        j.wrap.catalog = "de.lproj/Localizable.strings"
        let r = run(j, cta)
        XCTAssertEqual(r.findings.map(\.evidence), ["base"])
        XCTAssertEqual(r.findings.first?.key, "cta.trial")
        XCTAssertEqual(r.findings.first?.catalog, "de.lproj/Localizable.strings")
        // The same target string under two keys pairs by none.
        j.wrap.pairs.append(.init(key: "cta.trial2", target: "Jetzt kostenlos testen", base: "Try it free"))
        XCTAssertTrue(run(j, cta).findings.isEmpty)
        // id wins, and carries no key.
        var k = job([ctaEl()], base: [.init(id: "cta-trial", text: "Start free trial", rows: 1, orphan: false)])
        k.wrap.pairs = [.init(key: "cta.trial", target: "Jetzt kostenlos testen", base: "Start free trial")]
        XCTAssertNil(run(k, cta).findings.first?.key)
    }

    func testAssignmentBoundaryAndTruncatedOwnerUntouched() {
        // Value: protects=wrap rows use the text-elements-only owner; spec 06's owner (Truncation.assign over all elements) is unchanged; fails_when=a textless container wins in wrap or the truncated owner changes; why_new=new caller; seam=Wrapping.judge, Truncation.assign; no_claim=goldens (test/golden)
        let els = [el("row", nil, [0.25, 0.39, 0.50, 0.09]), el("l", "Jetzt kostenlos testen", [0.20, 0.38, 0.60, 0.11])]
        // spec 06: the smallest element holding 80% of the line is the textless row.
        XCTAssertEqual(Truncation.assign(cta[0].rect, els), 0)
        // wrap: only elements with text own lines.
        XCTAssertEqual(Wrapping.judge(els, lines: cta, locale: "de").map(\.index), [1])
    }

    func testOutputAndElementRowsAndServe() throws {
        // Value: protects=finding fields, element_rows only when asked, serve fit.wrap parsing and pairs digest cache, max_lines parsing; fails_when=a field drifts or a bad request passes; why_new=new fields; seam=Finding.encode, Envelope, Server.fitJob, Server.boxesField; no_claim=none
        var j = job([ctaEl(maxLines: 1)])
        let r = run(j, cta)
        let o = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r.findings[0])) as! [String: Any]
        XCTAssertEqual(Set(o.keys), ["kind", "box", "line", "reason", "element", "rows", "base_rows", "evidence", "base_path", "confidence"])
        XCTAssertEqual(o["line"] as? String, "Jetzt kostenlos / testen")
        XCTAssertEqual(o["confidence"] as? Double, 0.8)
        XCTAssertTrue(o["base_rows"] is NSNull)
        XCTAssertNil(r.elementRows)
        XCTAssertEqual(r.reasonsRun, ["wrapped"])
        var orphan = Finding(kind: "fit", box: [0, 0, 1, 1], line: "a / b")
        orphan.reason = "orphan"
        orphan.orphan = "b"
        let p = try JSONSerialization.jsonObject(with: JSONEncoder().encode(orphan)) as! [String: Any]
        XCTAssertEqual(Set(p.keys), ["kind", "box", "line", "reason", "element", "rows", "orphan", "evidence", "confidence"])
        j.wrap.elementRows = true
        XCTAssertEqual(run(j, cta).elementRows, [ElementRows(id: "cta-trial", text: "Jetzt kostenlos testen", rows: 2, orphan: true)])
        // No boxes: the wrap reasons are skipped with a cause.
        var nb = FitJob()
        nb.reasons = ["wrapped"]
        XCTAssertEqual(run(nb, cta).reasonsSkipped, [SkippedReason(reason: "wrapped", cause: "boxes-missing")])
        // serve
        guard case .success(let f) = Server.fitJob(["reasons": ["wrapped", "orphan"], "wrap": ["evidence": ["declared"], "element_rows": true, "base_path": "en/a.png", "base_locale": "en",
                                                                                              "base": [["id": "x", "text": "Go", "rows": 1, "orphan": false]],
                                                                                              "pairs": ["digest": "d1", "entries": [["k", "Los", "Go"]], "catalog": "de.json"]]]) else { return XCTFail() }
        XCTAssertEqual(f.wrap.evidence, ["declared"])
        XCTAssertEqual(f.wrap.base, [.init(id: "x", text: "Go", rows: 1, orphan: false)])
        guard case .success(let g) = Server.fitJob(["wrap": ["pairs": ["digest": "d1"]]]) else { return XCTFail("cached by digest") }
        XCTAssertEqual(g.wrap.pairs, [.init(key: "k", target: "Los", base: "Go")])
        XCTAssertEqual(g.wrap.catalog, "de.json")
        guard case .failure = Server.fitJob(["wrap": ["pairs": ["digest": "unknown"]]]) else { return XCTFail() }
        guard case .failure = Server.fitJob(["wrap": ["evidence": ["catalog"]]]) else { return XCTFail() }
        // Every malformed wrap field is an invalid request, never a silent default.
        let bads: [[String: Any]] = [["base": [["rows": 0]]], ["base": [["rows": true]]], ["base": ["x"]], ["base": [["rows": 1, "id": 3]]],
                                     ["pairs": ["entries": [["k", "t", "b"]]]], ["pairs": ["digest": "d2", "entries": [["k"]]]],
                                     ["base_locale": ""], ["element_rows": 1], ["base_path": 2]]
        for w in bads { guard case .failure = Server.fitJob(["wrap": w]) else { return XCTFail("\(w)") } }
        guard case .failure = Server.fitJob(["wrap": "x"]) else { return XCTFail("wrap must be an object") }
        guard case .failure = Server.fitJob(["reasons": ["wrap"]]) else { return XCTFail() }
        let box: [String: Any] = ["image": ["width": 100, "height": 200], "elements": [["box": [0.1, 0.1, 0.2, 0.2], "max_lines": 1]]]
        guard case .success(let b) = Server.boxesField(box, field: "fit") else { return XCTFail() }
        XCTAssertEqual(b.elements[0].maxLines, 1)
        let bad: [String: Any] = ["image": ["width": 100, "height": 200], "elements": [["box": [0.1, 0.1, 0.2, 0.2], "max_lines": 0]]]
        guard case .failure = Server.boxesField(bad, field: "fit") else { return XCTFail() }
    }
}
