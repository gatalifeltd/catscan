// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import ImageIO
import Vision
import XCTest

@testable import CatscanCore

final class NormalizationTests: XCTestCase {
    func n(_ s: String, _ l: String = "en") -> String { TextMatch.normalize(s, locale: l) }

    func testNFKCAndLowercase() {
        XCTAssertEqual(n("ＣＯＮＴＩＮＵＥ"), "continue") // full width
        XCTAssertEqual(n("ﬁle"), "file") // ligature
        XCTAssertEqual(n("Weiter"), "weiter")
    }

    func testEllipsisRemoved() {
        XCTAssertEqual(n("Loading…"), "loading")
        XCTAssertEqual(n("Loading..."), "loading")
    }

    func testQuotesAndDashesUnified() {
        XCTAssertEqual(n("It’s “ok” «da» x"), "it's 'ok' 'da' x") // at an end, « and » are disclosure glyphs (spec 06 D41)
        XCTAssertEqual(n("a–b—c−d‐e"), "a-b-c-d-e")
    }

    func testWhitespace() {
        XCTAssertEqual(n("  Tap \t to\n continue  "), "tap to continue")
        XCTAssertEqual(n("続 け る", "ja"), "続ける")
        XCTAssertEqual(n("다 음", "ko"), "다음")
        XCTAssertEqual(n("下 一步", "zh-Hans"), "下一步")
        XCTAssertEqual(n("ถัด ไป", "th"), "ถัดไป")
    }

    // Spec 06 D40-D42, D48: the normalization table, one case per row and glyph.
    func testDisclosureGlyphsDropOnlyAtTheEnds() {
        for g in [">", "›", "»", "〉", "〉", "⟩", "❯", "→", "▸", "▶", "＞"] {
            XCTAssertEqual(n("Nutzungsbedingungen  \(g)", "de"), "nutzungsbedingungen", g)
        }
        for g in ["<", "‹", "«", "〈", "〈", "⟨", "❮", "←", "◂", "◀"] {
            XCTAssertEqual(n("\(g) Back"), "back", g)
        }
        XCTAssertEqual(n("Settings › ›"), "settings") // repeated
        XCTAssertEqual(n("A > B"), "a > b") // inside a string it stays
        XCTAssertEqual(n("Sett"), "sett")
    }

    func testEllipsisVariants() {
        XCTAssertEqual(n("设置⋯", "zh-Hans"), "设置")
        XCTAssertEqual(n("設定‥", "ja"), "設定")
        XCTAssertEqual(n("1..10"), "1..10") // two ASCII dots stay
    }

    func testSpacesAndInvisibleMarks() {
        XCTAssertEqual(n("Tap\u{00A0}\u{00A0}to\u{202F}go\u{3000}now"), "tap to go now")
        XCTAssertEqual(n("\u{200F}הגדרות\u{200E}", "he"), "הגדרות")
        XCTAssertEqual(n("\u{2067}إعدادات\u{2069}\u{061C}", "ar"), "إعدادات")
        XCTAssertEqual(n("Wei\u{200B}ter\u{FEFF}\u{2060}"), "weiter")
    }

    func testFullWidthAndHalfWidthForms() {
        XCTAssertEqual(n("設定（Ａ）！", "ja"), "設定(a)!")
        XCTAssertEqual(n("ｶﾞｲﾄﾞ", "ja"), "ガイド")
    }

    func testNoSpaceAfterInvertedMarks() {
        // TODO-008: Vision on macOS 26 reads "¿ Olvidaste".
        XCTAssertEqual(n("¿ Olvidaste tu contraseña?", "es"), n("¿Olvidaste tu contraseña?", "es"))
        XCTAssertEqual(n("¡  Hola!", "es"), "¡hola!")
    }

    func testFoldKeepsTheEllipsis() {
        XCTAssertEqual(TextMatch.fold("Einstellun… ›"), "einstellun...")
        XCTAssertEqual(TextMatch.fold("\u{200F}⋯الإعدادات"), "...الإعدادات")
    }

    // TODO-099 D1: a soft hyphen is dropped everywhere; ZWNJ and ZWJ shape text, so fold keeps them.
    func testFoldDropsTheSoftHyphen() {
        XCTAssertEqual(TextMatch.fold("Gegen\u{00AD}verkehr"), "gegenverkehr")
        XCTAssertEqual(TextMatch.fold("می\u{200C}خواهم"), "می\u{200C}خواهم")
    }

    func testUnderscoreIsSpace() {
        XCTAssertEqual(n("onboarding_next_button"), "onboarding next button")
    }

    func testHomoglyphsFoldedForCyrillicAndLatinOnly() {
        // Cyrillic "Сара" vs Latin "Capa": equal for ru and for Latin-script locales.
        XCTAssertEqual(n("Сара", "ru"), n("Capa", "ru"))
        XCTAssertEqual(n("Сара", "en"), n("Capa", "en"))
        XCTAssertEqual(n("ВОХ", "uk"), "box")
        // Not folded for other scripts.
        XCTAssertNotEqual(n("Сара", "ja"), n("Capa", "ja"))
        XCTAssertNotEqual(n("Сара", "el"), n("Capa", "el"))
    }

    func testShortRule() {
        XCTAssertTrue(TextMatch.isShort("ok", locale: "en"))
        XCTAssertFalse(TextMatch.isShort("next", locale: "en"))
        XCTAssertTrue(TextMatch.isShort("次", locale: "ja"))
        XCTAssertFalse(TextMatch.isShort("次へ", locale: "ja"))
        XCTAssertFalse(TextMatch.contains("book", "ok", wordBounded: true))
        XCTAssertTrue(TextMatch.contains("tap ok now", "ok", wordBounded: true))
        XCTAssertTrue(TextMatch.contains("ok", "ok", wordBounded: true))
        XCTAssertTrue(TextMatch.contains("book", "ok", wordBounded: false))
    }

    func testEditDistance() {
        XCTAssertEqual(TextMatch.editDistance("weiter", "weitr"), 1)
        XCTAssertEqual(TextMatch.editDistance("", "abc"), 3)
        XCTAssertEqual(TextMatch.editDistance("kitten", "sitting"), 3)
    }
}

final class GeometryTests: XCTestCase {
    func testVisionBoxToTopLeft() {
        let r = Geometry.fromVision(CGRect(x: 0.31, y: 0.09, width: 0.38, height: 0.03))
        XCTAssertEqual(Geometry.box(r), [0.31, 0.88, 0.38, 0.03])
    }

    func testRounding() {
        XCTAssertEqual(Geometry.box(CGRect(x: 0.123456, y: 0.5, width: 0.000049, height: 1)), [0.1235, 0.5, 0, 1])
        XCTAssertEqual(Geometry.round2(0.987), 0.99)
    }

    func testTileStarts() {
        XCTAssertEqual(Geometry.tileStarts(length: 2796), [0])
        XCTAssertEqual(Geometry.tileStarts(length: 4096), [0])
        XCTAssertEqual(Geometry.tileStarts(length: 5000), [0, 904])
        XCTAssertEqual(Geometry.tileStarts(length: 9000), [0, 3840, 4904])
    }

    func testTileMergeKeepsHigherConfidence() {
        let a = RecognizedLine(text: "Weiter", rect: CGRect(x: 0.1, y: 0.5, width: 0.2, height: 0.02), confidence: 0.5)
        let b = RecognizedLine(text: "weiter", rect: CGRect(x: 0.1, y: 0.501, width: 0.2, height: 0.02), confidence: 0.9)
        let c = RecognizedLine(text: "Weiter", rect: CGRect(x: 0.6, y: 0.5, width: 0.2, height: 0.02), confidence: 0.4)
        let m = Geometry.mergeTiles([a, b, c], locale: "de")
        XCTAssertEqual(m.count, 2)
        XCTAssertEqual(m[0].confidence, 0.9)
    }

    func testReadingOrder() {
        func l(_ t: String, _ x: CGFloat, _ y: CGFloat) -> RecognizedLine {
            RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: 0.1, height: 0.02), confidence: 1)
        }
        let lines = [l("c", 0.1, 0.5), l("b", 0.6, 0.101), l("a", 0.1, 0.1)]
        XCTAssertEqual(Geometry.readingOrder(lines, rtl: false).map(\.text), ["a", "b", "c"])
        XCTAssertEqual(Geometry.readingOrder(lines, rtl: true).map(\.text), ["b", "a", "c"])
    }
}

final class CheckTests: XCTestCase {
    let lines = [
        RecognizedLine(text: "Jetzt testen", rect: CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.02), confidence: 0.98),
        RecognizedLine(text: "Tap to", rect: CGRect(x: 0.1, y: 0.2, width: 0.2, height: 0.02), confidence: 0.9),
        RecognizedLine(text: "continue", rect: CGRect(x: 0.1, y: 0.23, width: 0.2, height: 0.02), confidence: 0.8),
        RecognizedLine(text: "BOOK", rect: CGRect(x: 0.1, y: 0.4, width: 0.2, height: 0.02), confidence: 0.7),
    ]

    func testPresentPass() {
        let (r, w) = Checks.evaluate(kind: "present", text: "jetzt TESTEN", lines: lines, locale: "de")
        XCTAssertEqual(r.verdict, "pass")
        XCTAssertEqual(r.line, "Jetzt testen")
        XCTAssertEqual(r.box, [0.1, 0.1, 0.3, 0.02])
        XCTAssertEqual(r.confidence, 0.98)
        XCTAssertTrue(w.isEmpty)
    }

    func testWrappedLines() {
        let (r, _) = Checks.evaluate(kind: "present", text: "Tap to continue", lines: lines, locale: "en")
        XCTAssertEqual(r.verdict, "pass")
        XCTAssertEqual(r.line, "Tap to continue")
        XCTAssertEqual(r.confidence, 0.8)
        XCTAssertEqual(r.box, [0.1, 0.2, 0.2, 0.05])
    }

    func testPresentFailHasClosest() {
        let (r, _) = Checks.evaluate(kind: "present", text: "Jetzt testn", lines: lines, locale: "de")
        XCTAssertEqual(r.verdict, "fail")
        XCTAssertNil(r.box)
        XCTAssertEqual(r.closest?.line, "Jetzt testen")
        XCTAssertEqual(r.closest?.distance, 1)
    }

    func testAbsent() {
        XCTAssertEqual(Checks.evaluate(kind: "absent", text: "onboarding.next", lines: lines, locale: "en").0.verdict, "pass")
        let (r, _) = Checks.evaluate(kind: "absent", text: "continue", lines: lines, locale: "en")
        XCTAssertEqual(r.verdict, "fail")
        XCTAssertEqual(r.box, [0.1, 0.23, 0.2, 0.02])
    }

    func testShortCheckText() {
        let (r, w) = Checks.evaluate(kind: "present", text: "OK", lines: lines, locale: "en")
        XCTAssertEqual(r.verdict, "fail") // "BOOK" does not match "OK"
        XCTAssertEqual(w.map(\.code), ["short-check-text"])
    }

    func testSkippedWhenNothingCheckable() {
        let (r, _) = Checks.evaluate(kind: "present", text: "…", lines: lines, locale: "en")
        XCTAssertEqual(r.verdict, "skipped")
        XCTAssertEqual(r.reason, "no-checkable-text")
    }

    func testScripts() {
        XCTAssertEqual(Scripts.scripts(in: "Привет OK"), [.cyrillic, .latin])
        XCTAssertEqual(Scripts.candidates(for: .cyrillic, supported: ["en", "ru", "uk", "de"]), ["ru", "uk"])
        XCTAssertEqual(Scripts.candidates(for: .hangul, supported: ["en", "ko", "ja"]), ["ko"])
        // Outside review: a letter in an unmapped script is "other", which no locale reads.
        XCTAssertEqual(Scripts.scripts(in: "বাংলা"), [.other])
        // Armenian and Georgian are named since spec 03: the Tesseract fallback reads them.
        XCTAssertEqual(Scripts.scripts(in: "Բարեւ"), [.armenian])
        XCTAssertEqual(Scripts.scripts(in: "გამარჯობა"), [.georgian])
        XCTAssertFalse(Scripts.readable("en").contains(.other))
        XCTAssertEqual(Scripts.scripts(in: "ＣＯＮＴＩＮＵＥ ʼn ﬁ Ⓐ"), [.latin])
        XCTAssertEqual(Scripts.scripts(in: "𠀀々"), [.han])
        XCTAssertEqual(Scripts.scripts(in: "ﺍﻟﻌﺮﺑﻴﺔ"), [.arabic])
    }

    func testDecodeAppliesExifOrientation() throws {
        // Outside review: a JPEG stored 200x100 with orientation 6 (rotate 90) must reach Vision as 100x200.
        let ctx = CGContext(
            data: nil, width: 200, height: 100, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: 200, height: 100))
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, [kCGImagePropertyOrientation: 6] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        var job = Job(command: "read")
        job.image = data as Data
        guard case .success(let img) = Engine().decode(job) else { return XCTFail("decode failed") }
        XCTAssertEqual([img.width, img.height], [100, 200])
    }

    func testEnvelopeEncodingIsSortedAndKeepsNulls() throws {
        let (r, _) = Checks.evaluate(kind: "present", text: "nope nope", lines: [], locale: "en")
        let s = String(decoding: JSONLine.encode(r), as: UTF8.self)
        XCTAssertEqual(
            s,
            "{\"box\":null,\"closest\":null,\"confidence\":null,\"kind\":\"present\",\"line\":null,\"text\":\"nope nope\",\"verdict\":\"fail\"}\n")
    }
}

/// TODO-032: a Vision request that never returns ends in `vision-timeout` and the engine keeps working.
final class DeadlineTests: XCTestCase {
    func png(_ img: CGImage) -> Data {
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, img, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return data as Data
    }

    /// Blocks its thread for good, like the hung `VNCRImageReaderDetector` queue; it ignores cancel.
    static let never: (VNRecognizeTextRequest, CGImage) throws -> Void = { _, _ in
        DispatchSemaphore(value: 0).wait()
    }

    func testHungRequestIsVisionTimeoutAndTheNextRunPasses() throws {
        let e = Engine()
        let img = try XCTUnwrap(Doctor.render(Doctor.selfTestWord))
        var job = Job(command: "check")
        job.image = png(img)
        job.name = "hung.png"
        job.present = [Doctor.selfTestWord]
        let real = e.perform
        e.perform = DeadlineTests.never
        e.visionTimeout = 0.2
        let t0 = Date()
        let env = e.run(job)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 3)
        XCTAssertEqual(env.verdict, "error")
        XCTAssertEqual(env.path, "hung.png")
        XCTAssertEqual(env.error?.code, "vision-timeout")
        XCTAssertEqual(env.error?.message, "Vision did not finish reading the image in 0.2 s.")
        XCTAssertEqual(env.error?.hint, "rerun; on a slow host raise CATSCAN_VISION_TIMEOUT (seconds)")
        // The run goes on: the same engine reads the next image.
        e.perform = real
        e.visionTimeout = 60
        XCTAssertEqual(e.run(job).verdict, "pass")
    }

    func testStackedSecondReadTimeoutErrorsOtherFailureWarns() throws {
        // Value: protects=TODO-067 D29 (a hung second read errors the image so the client replaces the core, TODO-032; any other second-read failure warns stacked-unchecked and keeps the first read); fails_when=the timeout becomes a warning (hung thread in a live core) or another failure errors the image or passes silently; why_new=new branch; seam=perform (existing); no_claim=Vision's real failures
        let e = Engine()
        let img = try XCTUnwrap(Doctor.render(Doctor.selfTestWord))
        var job = Job(command: "overlap")
        job.image = png(img)
        job.name = "stacked.png"
        var o = OverlapJob()
        o.stacked = true
        job.overlap = o
        let real = e.perform
        e.perform = { r, i in r.usesLanguageCorrection ? try real(r, i) : try DeadlineTests.never(r, i) }
        e.visionTimeout = 3
        let hung = e.run(job)
        XCTAssertEqual(hung.verdict, "error")
        XCTAssertEqual(hung.error?.code, "vision-timeout")
        struct Failed: Error {}
        e.perform = { r, i in if r.usesLanguageCorrection { try real(r, i) } else { throw Failed() } }
        e.visionTimeout = 60
        let failed = e.run(job)
        XCTAssertEqual(failed.verdict, "pass")
        XCTAssertNil(failed.error)
        XCTAssertEqual(failed.warnings.map(\.code), ["stacked-unchecked"])
    }

    /// 1000 x 10000 px: three tiles (spec 01), no upscale.
    static func tall() throws -> CGImage {
        try XCTUnwrap(CGContext(
            data: nil, width: 1000, height: 10000, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
    }

    /// The real wait, bounded so a perform that never signals fails the test instead of hanging the run.
    static func finished(_ done: DispatchSemaphore, tile: Int) -> DispatchTimeoutResult {
        let r = done.wait(timeout: .now() + 30)
        XCTAssertEqual(r, .success, "tile \(tile)'s perform never signalled")
        return r
    }

    // TODO-047: no wall-clock race. Both tests observe or drive the wait at its boundary, so a slow host cannot
    // change the outcome; the real semaphore timeout is covered by testHungRequestIsVisionTimeoutAndTheNextRunPasses.
    func testTilesShareOneDeadline() throws {
        let e = Engine()
        e.perform = { _, _ in }
        e.visionTimeout = 60
        var deadlines: [DispatchTime] = []
        e.waitForVision = { done, d in deadlines.append(d); return DeadlineTests.finished(done, tile: deadlines.count) }
        XCTAssertEqual(Geometry.tileStarts(length: 10000).count, 3)
        let before = DispatchTime.now()
        _ = try e.recognize(DeadlineTests.tall(), languages: ["en-US"], locale: "en")
        let after = DispatchTime.now()
        XCTAssertEqual(deadlines.count, 3)
        XCTAssertEqual(Set(deadlines.map(\.uptimeNanoseconds)).count, 1, "every tile of one image waits on the same deadline")
        // Taken once, when the image starts: visionTimeout after a moment inside this recognize call.
        let d = try XCTUnwrap(deadlines.first)
        XCTAssertGreaterThanOrEqual(d, before + e.visionTimeout)
        XCTAssertLessThanOrEqual(d, after + e.visionTimeout)
    }

    func testTimeoutOnATileSkipsTheRestOfTheImage() throws {
        let e = Engine()
        var performs = 0
        let lock = NSLock()
        e.perform = { _, _ in lock.withLock { performs += 1 } }
        e.visionTimeout = 0.5
        var waits = 0
        // Tile 2 reports a timeout at once, as a wait past the deadline would.
        e.waitForVision = { done, _ in
            waits += 1
            return waits == 2 ? .timedOut : DeadlineTests.finished(done, tile: waits)
        }
        XCTAssertThrowsError(try e.recognize(DeadlineTests.tall(), languages: ["en-US"], locale: "en")) { err in
            XCTAssertEqual((err as? Diagnostic)?.code, "vision-timeout")
            XCTAssertEqual((err as? Diagnostic)?.message, "Vision did not finish reading the image in 0.5 s.")
        }
        XCTAssertEqual(waits, 2, "tile 3 never runs once the image is past its deadline")
        XCTAssertLessThanOrEqual(lock.withLock { performs }, 2, "tile 3's Vision request is never started")
    }

    func testVisionTimeoutFromEnvironment() {
        XCTAssertEqual(Engine.visionTimeout([:]), 60)
        XCTAssertEqual(Engine.visionTimeout(["CATSCAN_VISION_TIMEOUT": "120"]), 120)
        XCTAssertEqual(Engine.visionTimeout(["CATSCAN_VISION_TIMEOUT": "0.5"]), 0.5)
        for bad in ["0", "-3", "abc", "", "inf", "nan"] {
            XCTAssertEqual(Engine.visionTimeout(["CATSCAN_VISION_TIMEOUT": bad]), 60, bad)
        }
    }
}
