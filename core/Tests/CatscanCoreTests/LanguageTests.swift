// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import ImageIO
import XCTest

@testable import CatscanCore

/// Spec 04 / TODO-003: the language table, resolution, the per-OS live check and the script rules.
final class LanguageTests: XCTestCase {
    let all = Languages.expected[27]!

    func r(_ tag: String) -> Languages.Resolution? { Languages.resolve(tag, supported: all) }

    func testEveryOSRowIsInTheTable() {
        // TODO-004: the 15 and 26 rows were measured on CI runners; a typo there would only show on that OS.
        for (major, row) in Languages.expected {
            XCTAssertEqual(Set(row).count, row.count, "macOS \(major): duplicate code")
            for v in row { XCTAssertTrue(all.contains(v), "macOS \(major): \(v) is not in the language table") }
        }
    }

    func testEveryTableRowResolvesExactly() {
        // Spec 04 table: locale -> Vision code, one case per row and alias.
        let rows: [String: String] = [
            "en": "en-US", "fr": "fr-FR", "it": "it-IT", "de": "de-DE", "es": "es-ES", "tr": "tr-TR",
            "id": "id-ID", "cs": "cs-CZ", "da": "da-DK", "nl": "nl-NL", "ms": "ms-MY", "pl": "pl-PL",
            "ro": "ro-RO", "sv": "sv-SE", "fi": "fi-FI", "vi": "vi-VT",
            "pt-BR": "pt-BR", "pt": "pt-BR", "no": "no-NO", "nb": "nb-NO", "nn": "nn-NO",
            "ru": "ru-RU", "uk": "uk-UA",
            "zh-Hans": "zh-Hans", "zh-CN": "zh-Hans", "zh-Hant": "zh-Hant", "zh-TW": "zh-Hant", "zh-HK": "zh-Hant",
            "zh-SG": "zh-Hans", "zh-MO": "zh-Hant", "yue-CN": "yue-Hans", "yue-HK": "yue-Hant", "yue-MO": "yue-Hant",
            "yue-Hans": "yue-Hans", "yue-Hant": "yue-Hant", "ja": "ja-JP", "ko": "ko-KR", "th": "th-TH",
            "ar": "ar-SA", "ars": "ars-SA", "hi": "hi-IN", "mr": "mr-IN",
        ]
        for (tag, vision) in rows {
            XCTAssertEqual(r(tag), Languages.Resolution(
                locale: Languages.locale(forVision: vision), vision: vision, exact: true, inTable: true), tag)
            XCTAssertEqual(r(tag.uppercased())?.vision, vision, "case-insensitive: \(tag)")
        }
        XCTAssertEqual(Set(rows.values), Set(all), "every Vision language has a row")
        XCTAssertEqual(Languages.catalog.count, 38)
    }

    func testReadWithAListedModel() {
        // TODO-037: a language Vision does not list resolves exactly to its own row, read with a listed model.
        let want = ["ca": "es-ES", "eu": "es-ES", "gl": "es-ES", "lb": "de-DE", "fil": "en-US", "tl": "en-US"]
        for (tag, v) in want {
            XCTAssertEqual(r(tag)?.vision, v, tag)
            XCTAssertEqual(r(tag)?.exact, true, tag)
        }
        XCTAssertEqual(r("tl")?.locale, "fil")
        XCTAssertEqual(r("ca-ES"), .init(locale: "ca", vision: "es-ES", exact: false, inTable: true))
        // The model's own code still maps to its own row.
        XCTAssertEqual(r("es-ES")?.locale, "es")
        XCTAssertEqual(Languages.locale(forVision: "en-US"), "en")
        // Unsupported where the model is not listed.
        XCTAssertNil(Languages.resolve("lb", supported: ["en-US"]))
        // Languages whose letters Vision drops are not rows: they go to the Tesseract fallback.
        for l in ["et", "cy", "sq", "hr", "lt"] { XCTAssertNil(r(l), l) }
    }

    func testVisionCodeIsExact() {
        XCTAssertEqual(r("fr-FR"), .init(locale: "fr", vision: "fr-FR", exact: true, inTable: true))
        XCTAssertEqual(r("ja-JP"), .init(locale: "ja", vision: "ja-JP", exact: true, inTable: true))
    }

    func testFallbackToShorterTagOrLanguage() {
        XCTAssertEqual(r("en-GB"), .init(locale: "en", vision: "en-US", exact: false, inTable: true))
        XCTAssertEqual(r("pt-PT"), .init(locale: "pt-BR", vision: "pt-BR", exact: false, inTable: true))
        XCTAssertEqual(r("zh-Hant-TW"), .init(locale: "zh-Hant", vision: "zh-Hant", exact: false, inTable: true))
        XCTAssertEqual(r("de-CH"), .init(locale: "de", vision: "de-DE", exact: false, inTable: true))
        XCTAssertEqual(r("zh"), .init(locale: "zh-Hans", vision: "zh-Hans", exact: false, inTable: true))
        XCTAssertEqual(r("yue"), .init(locale: "yue-Hant", vision: "yue-Hant", exact: false, inTable: true))
        XCTAssertEqual(r("YUE")?.vision, "yue-Hant")
    }

    func testUnsupported() {
        XCTAssertNil(r("he"))
        XCTAssertNil(r("xx-YY"))
        // A row Vision on this Mac does not list does not resolve.
        XCTAssertNil(Languages.resolve("ja", supported: ["en-US"]))
    }

    func testVisionLanguageNewerThanTheTable() {
        // Spec 04: the live list is the source of truth, so a new Vision language works without a release.
        let live = all + ["he-IL"]
        XCTAssertEqual(Languages.resolve("he", supported: live), .init(locale: "he-IL", vision: "he-IL", exact: false, inTable: false))
        XCTAssertEqual(Languages.resolve("he-IL", supported: live)?.exact, true)
        XCTAssertEqual(Languages.compare(live, macOSMajor: 27)?.added, ["he-IL"])
        XCTAssertEqual(Languages.compare(["en-US"], macOSMajor: 27)?.removed.count, 32)
        XCTAssertNil(Languages.compare(live, macOSMajor: 14))
    }

    func testLiveVisionListMatchesThisMacOSRow() {
        // Spec 04 "Live check": a difference fails with the added and removed languages.
        let live = Engine().visionLanguages
        let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        guard let diff = Languages.compare(live, macOSMajor: major) else {
            return XCTFail("Languages.expected has no row for macOS \(major); add Languages.expected[\(major)] in core/Sources/CatscanCore/Languages.swift from this run; measured list: \(live)")
        }
        XCTAssertTrue(diff.added.isEmpty && diff.removed.isEmpty,
                      "macOS \(major): added \(diff.added), removed \(diff.removed); update Languages.expected[\(major)] in core/Sources/CatscanCore/Languages.swift; measured list: \(live)")
        for v in live { XCTAssertNotNil(Languages.resolve(Languages.locale(forVision: v), supported: live), v) }
    }

    func testFallbackWarningOnEnvelope() throws {
        var job = Job(command: "check")
        job.image = blankPNG()
        job.absent = ["nothing here"]
        job.locale = "en-GB"
        let env = Engine().run(job)
        XCTAssertEqual(env.verdict, "pass")
        XCTAssertEqual(env.locale, "en-GB")
        XCTAssertEqual(env.warnings.map(\.code), ["locale-fallback"])
        XCTAssertEqual(env.warnings.first?.hint, "--locale en")
        job.locale = "zh-TW"
        XCTAssertEqual(Engine().run(job).warnings, [])
    }

    func testScriptFlags() {
        for l in ["ja", "ko", "zh-Hans", "zh-TW", "yue-Hant", "th"] { XCTAssertTrue(TextMatch.isUnspaced(l), l) }
        for l in ["en", "ru", "ar", "hi", "vi", "nb"] { XCTAssertFalse(TextMatch.isUnspaced(l), l) }
        for l in ["ar", "ars"] { XCTAssertTrue(TextMatch.isRightToLeft(l), l) }
        for l in ["en", "ja", "hi", "th"] { XCTAssertFalse(TextMatch.isRightToLeft(l), l) }
    }

    func testNoSpaceScriptsShortThreshold() {
        // Two characters are enough in no-space scripts, and no word boundary applies.
        let line = [RecognizedLine(text: "設定を開く", rect: .zero, confidence: 1)]
        let (res, w) = Checks.evaluate(kind: "present", text: "設定", lines: line, locale: "ja")
        XCTAssertEqual(res.verdict, "pass")
        XCTAssertTrue(w.isEmpty)
        XCTAssertTrue(TextMatch.isShort("ข", locale: "th"))
        XCTAssertFalse(TextMatch.isShort("ถัด", locale: "th"))
    }

    func testGraphemeClustersNeverSplit() {
        // Spec 04: a match never splits a conjunct or a nukta from its letter.
        let n = { (s: String) in TextMatch.normalize(s, locale: "hi") }
        XCTAssertFalse(TextMatch.contains(n("फ़ोन"), n("फ"), wordBounded: false)) // pha + nukta
        XCTAssertFalse(TextMatch.contains(n("क्षमा"), n("क"), wordBounded: false)) // ka + virama + ssa
        XCTAssertTrue(TextMatch.contains(n("फ़ोन चालू"), n("फ़ोन"), wordBounded: false))
        XCTAssertTrue(TextMatch.contains(n("सेटिंग्स खोलें"), n("खोलें"), wordBounded: false))
        // Thai: a vowel mark stays with its consonant.
        XCTAssertFalse(TextMatch.contains("กี", "ก", wordBounded: false))
    }

    func testArabicLogicalOrder() {
        // Vision returns logical order; normalization never reverses it.
        XCTAssertEqual(TextMatch.normalize("متابعة  الآن", locale: "ar"), "متابعة الآن")
        let a = RecognizedLine(text: "يمين", rect: CGRect(x: 0.6, y: 0.1, width: 0.3, height: 0.05), confidence: 1)
        let b = RecognizedLine(text: "يسار", rect: CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.05), confidence: 1)
        for l in ["ar", "ars"] {
            XCTAssertEqual(Geometry.readingOrder([b, a], rtl: TextMatch.isRightToLeft(l)).map(\.text), ["يمين", "يسار"])
        }
    }

    func testFallbackNeverChangesScript() {
        // TODO-003 D8: a row this Mac does not list is unsupported, never read as its sibling script.
        let noHant = all.filter { $0 != "zh-Hant" }
        XCTAssertNil(Languages.resolve("zh-Hant", supported: noHant))
        XCTAssertNil(Languages.resolve("zh-TW", supported: noHant))
        XCTAssertNil(Languages.resolve("zh-Hant-TW", supported: noHant))
        XCTAssertNil(Languages.resolve("zh", supported: all.filter { $0 != "zh-Hans" }))
        XCTAssertNil(Languages.resolve("ja", supported: all.filter { $0 != "ja-JP" }))
        // D14: a script subtag is never stripped.
        XCTAssertNil(r("ru-Latn"))
        XCTAssertNil(r("zh-Latn"))
        XCTAssertNil(r("sr-Cyrl"))
        XCTAssertEqual(r("ru-Cyrl"), .init(locale: "ru", vision: "ru-RU", exact: false, inTable: true))
        XCTAssertEqual(r("zh-Hans-SG")?.vision, "zh-Hans")
    }

    func testTableAgreesWithScriptRules() {
        // TODO-003 D6: the catalog scripts and the TextMatch flags are one table (spec 04).
        let script: [String: Scripts.Script] = [
            "Latin": .latin, "Cyrillic": .cyrillic, "Han": .han, "Japanese": .kana, "Hangul": .hangul,
            "Thai": .thai, "Arabic": .arabic, "Devanagari": .devanagari,
        ]
        for row in Languages.catalog {
            guard let sc = script[row.script] else { return XCTFail("unmapped script \(row.script)") }
            XCTAssertTrue(Scripts.readable(row.locale).contains(sc), row.locale)
        }
        let unspaced = Set(Languages.catalog.filter { TextMatch.isUnspaced($0.locale) }.map(\.locale))
        XCTAssertEqual(unspaced, ["zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant", "ja", "ko", "th"])
        XCTAssertEqual(Set(Languages.catalog.filter { TextMatch.isRightToLeft($0.locale) }.map(\.locale)), ["ar", "ars"])
    }

    func check(_ engine: Engine, locale: String, absent: String = "nothing here") -> Envelope {
        var job = Job(command: "check")
        job.image = blankPNG()
        job.absent = [absent]
        job.locale = locale
        return engine.run(job)
    }

    func testUnsupportedHintNamesTheFix() {
        // TODO-003 D10: a country code gets its locale; anything else points at catscan languages.
        let e = Engine(languages: .success(all))
        e.tesseract = { _ in nil }
        let jp = check(e, locale: "jp")
        XCTAssertEqual(jp.verdict, "unsupported")
        XCTAssertEqual(jp.error?.code, "unsupported-language")
        XCTAssertEqual(jp.error?.hint, "--locale ja")
        XCTAssertEqual(check(e, locale: "sw").error?.hint, "catscan languages lists the locales this Mac reads")
        // TODO-065 D1: a locale catscan reads with Tesseract is needs-reader, never unsupported, with the fix (D6).
        let he = check(e, locale: "he")
        XCTAssertEqual(he.verdict, "needs-reader")
        XCTAssertEqual(he.error?.code, "reader-missing")
        XCTAssertTrue(he.error!.message.hasPrefix("catscan reads the locale he with Tesseract, which is not installed on this Mac (looked at "))
        XCTAssertEqual(he.error?.hint, "brew install tesseract tesseract-lang (about 650 MB), then rerun the same command")
        XCTAssertTrue(he.checks.allSatisfy { $0.verdict == "needs-reader" })
        var none = Job(command: "check")
        none.image = blankPNG()
        none.absent = ["x"]
        none.locale = "he"
        none.fallback = "none"
        // --fallback none: still needs-reader, never unsupported; the hint installs first when nothing is installed.
        XCTAssertEqual(e.run(none).verdict, "needs-reader")
        XCTAssertEqual(e.run(none).error?.message, "catscan reads the locale he with Tesseract; --fallback none turned it off.")
        XCTAssertEqual(e.run(none).error?.hint, "brew install tesseract tesseract-lang (about 650 MB), then rerun the same command; drop --fallback none")
        e.tesseract = { _ in Tesseract.Install(path: "/bin/false", version: "5.5.3", packs: ["heb", "eng"], tessdata: nil) }
        XCTAssertEqual(e.run(none).error?.hint, "drop --fallback none")
        // --fallback none with the pack missing: the pack first, then drop it.
        none.locale = "el"
        XCTAssertEqual(e.run(none).error?.hint, "add script/Greek.traineddata to the tessdata directory of /bin/false, then rerun the same command; drop --fallback none")
        XCTAssertFalse(e.run(none).warnings.contains { $0.code == "fallback-pack-missing" })
        // eng is required too: Tesseract runs <pack>+eng (red-team review).
        e.tesseract = { _ in Tesseract.Install(path: "/bin/false", version: "5.5.3", packs: ["heb"], tessdata: "/t/") }
        let noEng = check(e, locale: "he")
        XCTAssertEqual(noEng.verdict, "needs-reader")
        XCTAssertEqual(noEng.warnings.first?.message, "Tesseract 5.5.3 has no eng language data for he in /t/.")
        XCTAssertEqual(noEng.error?.message, "catscan reads the locale he with Tesseract, but Tesseract 5.5.3 has no eng language data in /t/.")
        XCTAssertEqual(noEng.warnings.first?.hint, "add eng.traineddata to /t/, then rerun the same command")
        e.tesseract = { _ in Tesseract.Install(path: "/opt/homebrew/bin/tesseract", version: "5.5.3", packs: ["heb", "eng"], tessdata: "/opt/homebrew/share/tessdata/") }
        let missing = check(e, locale: "el")
        XCTAssertEqual(missing.verdict, "needs-reader")
        XCTAssertEqual(missing.warnings.first?.code, "fallback-pack-missing")
        XCTAssertEqual(missing.error?.hint, "brew install tesseract-lang (about 650 MB), then rerun the same command")
        XCTAssertEqual(check(e, locale: "ru-Latn").verdict, "unsupported")
    }

    func testLanguageNotInTable() {
        // TODO-003 D7: no script metadata, so a check in its script is run, not unsupported.
        // Bengali: Scripts.readable("bn") is Latin only, so only the inTable gates keep this check runnable.
        let e = Engine(languages: .success(all + ["bn-IN"]))
        let env = check(e, locale: "bn", absent: "সেটিংস খুলুন")
        XCTAssertEqual(env.verdict, "pass")
        XCTAssertEqual(env.checks.map(\.verdict), ["pass"])
        XCTAssertEqual(env.warnings.map(\.code), ["locale-fallback", "language-not-in-table"])
    }

    func testLanguageQueryFailure() {
        // TODO-003 D9: a failed query is an internal error, never "unsupported" with an empty list.
        struct Boom: Error, LocalizedError { var errorDescription: String? { "boom" } }
        let env = check(Engine(languages: .failure(Boom())), locale: "en")
        XCTAssertEqual(env.verdict, "error")
        XCTAssertEqual(env.error?.code, "vision-languages-failed")
        XCTAssertEqual(env.error?.message, "Vision could not list its recognition languages: boom")
        // No script warning points at the locale when Vision itself failed (red team).
        XCTAssertEqual(check(Engine(languages: .failure(Boom())), locale: "en", absent: "Настройки").warnings, [])
    }

    // TODO-065 D5
    func testEngineAsksForAFreshProbeOnlyWhenTheReaderIsMissing() {
        let e = Engine(languages: .success(["en-US"]))
        var asked: [Bool] = []
        e.tesseract = { r in asked.append(r); return nil }
        var j = Job(command: "check")
        j.image = blankPNG()
        j.present = ["x"]
        j.locale = "he"
        XCTAssertEqual(e.run(j).verdict, "needs-reader")
        XCTAssertEqual(asked, [false, true])
    }

    func blankPNG() -> Data {
        let ctx = CGContext(
            data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
        CGImageDestinationFinalize(dest)
        return data as Data
    }
}
