// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-036 check 3 (T5): `missing-glyphs` on synthetic recognized lines; the read texts are what Vision returned in
/// the T0 spike (`results/spike-tofu-langid.txt`).
final class GlyphsTests: XCTestCase {
    func chars(_ expected: String, _ read: String, _ locale: String = "ru", fragment: Bool = false) -> [String]? {
        Glyphs.judge(expected: expected, read: read, locale: locale, fragment: fragment)?.chars
    }

    func testMissingRun() {
        XCTAssertEqual(chars("Price: Цена", "Price:"), ["Ц", "е", "н", "а"]) // Last Resort boxes dropped
        XCTAssertEqual(chars("Price: Цена", "Price: 1"), ["Ц", "е", "н", "а"]) // .notdef read as a digit
        XCTAssertEqual(chars("Цена: Pro", "Pro"), ["Ц", "е", "н", "а"])
    }

    func testGarbledRun() {
        XCTAssertEqual(chars("Price: Цена", "Price: OO0D"), ["Ц", "е", "н", "а"])
        XCTAssertEqual(chars("Größe", "Gr 3 ße", "de"), ["ö"])
        XCTAssertEqual(chars("Zażółć", "Za0000", "pl"), ["ż", "ó", "ł", "ć"])
        XCTAssertNil(chars("Zażółć", "Za00ć", "pl")) // `ć` drawn proves Latin Extended-A, so a lost `ł` is an OCR drop
    }

    func testDiacriticMisreadNotFlagged() {
        XCTAssertNil(chars("Größe", "Grose", "de")) // `ö` read as `o`, `ß` as `s`
        XCTAssertNil(chars("Größe", "Große", "de").flatMap { $0.isEmpty ? nil : $0 })
        XCTAssertNil(chars("Ölwechsel", "Olwechsel", "de"))
        XCTAssertNil(chars("Große", "GroBe", "zh-Hans")) // cross-script misread (T0, zh recognition)
    }

    func testFontProvesCoverage() {
        XCTAssertNil(chars("Настройки профиля", "Настройки")) // same script read: an OCR drop or a cut
        XCTAssertNil(chars("Settings 2026", "Settings")) // digits are in every font
        XCTAssertNil(chars("Settings", "Settings 1")) // read text the expected text lacks
        XCTAssertNil(chars("Price: Цена", "Price: Lena")) // letters, not box shapes
    }

    func testScriptReadable() {
        // en recognition cannot read Cyrillic: its absence is no evidence (D13 control).
        XCTAssertNil(chars("Price: Цена", "Price:", "en"))
        XCTAssertNotNil(chars("Price: Цена", "Price:", "ru"))
    }

    func testCurrencyAndQuotesNeedLetters() {
        // Vision reads clean rare signs as other shapes (T5a: `₹` as `{` or `7`, `₪` as `D`), so a sign alone is no evidence.
        XCTAssertNil(chars("Total: ₹499", "Total: {499", "en"))
        XCTAssertNil(chars("₪39.90 per month", "D39.90 per month", "en"))
        XCTAssertNil(chars("Delete “Photo”", "Delete 0Photo0", "en"))
        // Beside missing letters, a sign is reported with them.
        XCTAssertEqual(chars("Цена: ₽", "OOOO 0"), ["Ц", "е", "н", "а", "₽"])
    }

    func testT5aDevMisses() {
        XCTAssertNotNil(chars("Профиль Google Play", "OOOOOOO Google Play", "uk")) // `о` matched to a box proves nothing
        XCTAssertNotNil(chars("Συνδρομή VIP", "ΠΗΠΠΗΠΠΗ VIP", "el"))
        XCTAssertNil(chars("Mở khóa", "MO khUa", "vi")) // `ở` read as its base `o`: indistinguishable from a misread
        XCTAssertNil(chars("Ayarları güncelle", "Ayarlar g celle", "tr", fragment: true)) // `n` lost too: an OCR drop
        XCTAssertNotNil(chars("Ayarları güncelle", "Ayarlar gncelle", "tr", fragment: true))
        XCTAssertNotNil(chars("取消 订阅 Plus", "PIus", "zh-Hans", fragment: true))
        XCTAssertNotNil(chars("Bluetooth ยกเลิก สมาชิก", "Bluetooth OOOOD 0O0000", "th", fragment: true))
    }

    func testWholeLine() {
        XCTAssertEqual(chars("Цена", "OO0D"), ["Ц", "е", "н", "а"])
        XCTAssertNil(chars("Цена", "100 Pro"))
        XCTAssertNil(chars("Price", "OO0D", "en")) // Latin: a font always has it
    }

    func testFragmentNeedsIntactParts() {
        XCTAssertNil(chars("Gr Цена ße", "Gr ße", fragment: true)) // no intact stretch of 4
        XCTAssertNotNil(chars("Price: Цена", "Price:", fragment: true))
    }

    func line(_ t: String, _ r: CGRect, conf: Double = 0.95) -> RecognizedLine { RecognizedLine(text: t, rect: r, confidence: conf) }

    func testBoxesAndTruncationPrecedence() {
        var j = GlyphsJob()
        let e = CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.05)
        j.boxes = TruncationJob.Boxes(width: 1000, height: 1000, elements: [TruncationJob.Element(id: "price", rect: e, text: "Price: Цена")])
        // Line ends far short of the element's edge: glyphs.
        var f = Glyphs.evaluate(j, lines: [line("Price:", CGRect(x: 0.12, y: 0.11, width: 0.2, height: 0.03))], width: 1000, height: 1000, locale: "ru")
        XCTAssertEqual(f.map(\.kind), ["missing-glyphs"])
        XCTAssertEqual(f.first?.element?.id, "price")
        XCTAssertEqual(f.first?.chars, ["Ц", "е", "н", "а"])
        // Line reaches the element's edge: truncation's, not glyphs (D13).
        f = Glyphs.evaluate(j, lines: [line("Price:", CGRect(x: 0.12, y: 0.11, width: 0.77, height: 0.03))], width: 1000, height: 1000, locale: "ru")
        XCTAssertTrue(f.isEmpty)
        // Below confidence 0.3: nothing compared; no line: no finding.
        f = Glyphs.evaluate(j, lines: [line("Price:", CGRect(x: 0.12, y: 0.11, width: 0.2, height: 0.03), conf: 0.2)], width: 1000, height: 1000, locale: "ru")
        XCTAssertTrue(f.isEmpty)
        XCTAssertTrue(Glyphs.evaluate(j, lines: [], width: 1000, height: 1000, locale: "ru").isEmpty)
        // A trailing Latin diacritic dropped: its script is in the read part, so truncation keeps it.
        j.boxes = TruncationJob.Boxes(width: 1000, height: 1000, elements: [TruncationJob.Element(id: "x", rect: e, text: "Café")])
        f = Glyphs.evaluate(j, lines: [line("Caf", CGRect(x: 0.12, y: 0.11, width: 0.1, height: 0.03))], width: 1000, height: 1000, locale: "fr")
        XCTAssertTrue(f.isEmpty)
    }

    func testRightToLeftTruncationPrecedence() {
        // Value: protects=D13 on right-to-left screens (the trailing edge is the left one); fails_when=the rtl gap sign or edge inverts and truncated ar lines become glyph findings; why_new=only ltr rows existed; seam=none; no_claim=real layouts
        var j = GlyphsJob()
        j.boxes = TruncationJob.Boxes(width: 1000, height: 1000, elements: [TruncationJob.Element(id: "p", rect: CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.05), text: "Pro السعر")])
        let short = Glyphs.evaluate(j, lines: [line("Pro", CGRect(x: 0.7, y: 0.11, width: 0.18, height: 0.03))], width: 1000, height: 1000, locale: "ar")
        XCTAssertEqual(short.first?.element?.id, "p")
        let edge = Glyphs.evaluate(j, lines: [line("Pro", CGRect(x: 0.105, y: 0.11, width: 0.78, height: 0.03))], width: 1000, height: 1000, locale: "ar")
        XCTAssertTrue(edge.isEmpty) // the line reaches the left (trailing) edge: truncation's
    }

    func testRightToLeftVisualOrder() {
        XCTAssertNotNil(chars("Plus: السعر", "DDDDPIus:", "ar"))
        XCTAssertNotNil(chars("تسجيل الدخول VIP", "VIPODDDDD DODDD", "ar"))
        XCTAssertNil(chars("Plus: السعر", "DDDDPIus:", "en")) // only right-to-left locales
    }

    func testWholeLineInElement() {
        var j = GlyphsJob()
        j.boxes = TruncationJob.Boxes(width: 1000, height: 1000, elements: [TruncationJob.Element(id: "t", rect: CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.05), text: "สมาชิก")])
        let f = Glyphs.evaluate(j, lines: [line("COUDD", CGRect(x: 0.11, y: 0.11, width: 0.28, height: 0.03))], width: 1000, height: 1000, locale: "th")
        XCTAssertEqual(f.first?.chars?.count, 5) // grapheme clusters: `ชิ` is one
    }

    func testCatalogGreek() {
        var j = GlyphsJob()
        j.expected = ["Συνδρομή VIP", "Συνδρομή Premium", "Συνδρομή", "VIP Ρυθμίσεις"].map { .init(key: nil, text: $0) }
        let r = CGRect(x: 0.1, y: 0.1, width: 0.4, height: 0.03)
        XCTAssertEqual(Glyphs.evaluate(j, lines: [line("ΠΗΠΠΗΠΠΗ Premium", r)], width: 1000, height: 1000, locale: "el").first?.expected, "Συνδρομή Premium")
        // `VIP` is 3 characters: no intact fragment of 4 locates the catalog string.
        XCTAssertTrue(Glyphs.evaluate(j, lines: [line("ΠΗΠΠΗΠΠΗ VIP", r)], width: 1000, height: 1000, locale: "el").isEmpty)
    }

    func testCatalog() {
        var j = GlyphsJob()
        j.expected = [.init(key: "price", text: "Price: Цена"), .init(key: "pro", text: "Pro")]
        let r = CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.03)
        var f = Glyphs.evaluate(j, lines: [line("Price:", r)], width: 1000, height: 1000, locale: "ru")
        XCTAssertEqual(f.first?.key, "price")
        // The line is a catalog string itself.
        f = Glyphs.evaluate(j, lines: [line("Pro", r)], width: 1000, height: 1000, locale: "ru")
        XCTAssertTrue(f.isEmpty)
        // The missing letters sit on another line: split by Vision, not lost.
        f = Glyphs.evaluate(j, lines: [line("Price:", r), line("Цена", r.offsetBy(dx: 0.4, dy: 0))], width: 1000, height: 1000, locale: "ru")
        XCTAssertTrue(f.isEmpty)
    }

    func testServeGlyphsJob() throws {
        // Value: protects=serve glyphs field parsing and its invalid-request errors; fails_when=a malformed expected, lines or boxes value reaches the rule; why_new=no test called Server.glyphsJob; seam=none; no_claim=the serve loop (bench/glyphs.js)
        func obj(_ json: String) -> Any { try! JSONSerialization.jsonObject(with: Data(json.utf8)) }
        let ok = try Server.glyphsJob(obj(#"{"expected":[{"key":"k","text":"Цена"},{"text":"Pro"}],"lines":true,"boxes":{"image":{"width":10,"height":10},"elements":[{"id":"e","box":[0,0,0.5,0.5],"text":"Цена"}]}}"#)).get()
        XCTAssertEqual(ok.expected, [.init(key: "k", text: "Цена"), .init(key: nil, text: "Pro")])
        XCTAssertTrue(ok.lines)
        XCTAssertEqual(ok.boxes?.elements.first?.text, "Цена")
        for (json, field) in [(#"[]"#, "glyphs must"), (#"{"expected":"x"}"#, "expected must"), (#"{"expected":[{"key":1,"text":"x"}]}"#, "expected[0]"),
                              (#"{"expected":[{"key":"k"}]}"#, "expected[0]"), (#"{"lines":1}"#, "lines"), (#"{"boxes":{"elements":[]}}"#, "boxes")] {
            guard case .failure(let d) = Server.glyphsJob(obj(json)) else { return XCTFail(json) }
            XCTAssertEqual(d.code, "invalid-request", json)
            XCTAssertTrue(d.message.contains(field), "\(json): \(d.message)")
        }
    }

    func testFindingEncoding() throws {
        // Value: protects=the missing-glyphs wire keys, with element and key null when absent; fails_when=a key is dropped or renamed; why_new=no encoder test for the kind; seam=none; no_claim=consumers (the bench reads it)
        var f = Finding(kind: "missing-glyphs", box: [0, 0, 1, 1], line: "Price:")
        f.expected = "Price: Цена"
        f.chars = ["Ц"]
        let o = try JSONSerialization.jsonObject(with: JSONEncoder().encode(f)) as! [String: Any]
        XCTAssertEqual(Set(o.keys), ["kind", "box", "line", "expected", "chars", "element", "key"])
        XCTAssertTrue(o["element"] is NSNull && o["key"] is NSNull)
        XCTAssertEqual(o["chars"] as? [String], ["Ц"])
    }
}
