// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import CoreML
import CoreText
import Foundation
import Vision

/// The fields `catscan-core doctor` adds for spec 08 (D3): Neural Engine, Vision languages and a self-test.
public enum Doctor {
    /// spec 15 D5: `present` when Core ML lists a Neural Engine, `absent` when it lists other devices only,
    /// `unknown` when it lists no device at all.
    public static func neuralEngine() -> String {
        let devices = MLComputeDevice.allComputeDevices
        if devices.isEmpty { return "unknown" }
        return devices.contains { if case .neuralEngine = $0 { return true } else { return false } } ? "present" : "absent"
    }

    /// The languages the fast recognition level reads; nil when Vision cannot list them.
    public static func fastLanguages() -> [String]? {
        let r = VNRecognizeTextRequest()
        r.recognitionLevel = .fast
        r.revision = VNRecognizeTextRequestRevision3
        return try? r.supportedRecognitionLanguages()
    }

    public static let selfTestWord = "Continue"

    /// Renders `selfTestWord` into an in-memory image and reads it with the accurate request: no fixture ships (D3).
    public static func selfTest(_ e: Engine) -> (ms: Int, pass: Bool) {
        let start = DispatchTime.now().uptimeNanoseconds
        let lines = render(selfTestWord).flatMap { try? e.recognizeOne($0, languages: ["en-US"], deadline: .now() + e.visionTimeout) } ?? []
        let ms = Int((DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        return (ms, lines.contains { $0.text.lowercased().contains(selfTestWord.lowercased()) })
    }

    /// TODO-065 T3: one word per Tesseract locale, with the letters Vision drops or cannot read, for
    /// `doctor --expect-locales`. A missing entry is a test failure (DoctorTests), never a silent skip.
    public static let localeWords: [String: String] = [
        "el": "Ρυθμίσεις", "he": "הגדרות", "bg": "Настройки", "sr": "Подешавања", "sr-Latn": "Podešavanja",
        "hu": "Beállítások", "fa": "حساب کاربری", "ka": "პარამეტრები", "hy": "Կարգավորումներ", "hr": "Uključeno",
        "sk": "Ďalšie", "sl": "Počisti", "lt": "Įjungta", "lv": "Iestatījumi", "mt": "Għajnuna", "ga": "Fáilte",
        "is": "Þjónusta", "mk": "Поставки", "bs": "Uključeno", "be": "Налады", "et": "Tühista", "cy": "Gosodiadau",
        "sq": "Cilësimet",
    ]
    /// The doctor self-tests share one budget well inside the 60 s the Node launcher waits for `doctor` (D13 of
    /// the TODO-065 DX review): a locale past it gets its own failed row instead of the whole doctor timing out.
    public static let localeBudget: TimeInterval = 40
    public static let localeTimeout: TimeInterval = 15
    /// A self-test with less time left than this is skipped, not run: a 1 s timeout would read as a broken Tesseract.
    public static let localeMinimum: TimeInterval = 5

    public struct LocaleTest { public let ms: Int; public let pass: Bool; public let error: Diagnostic? }

    /// Renders the locale's word and reads it with Tesseract, as a check would (TODO-065 T3).
    /// `langs` is the pack a check in the requested locale runs (sr-Cyrl: srp); the word comes from its base row.
    public static func localeSelfTest(_ locale: String, langs: String? = nil, install: Tesseract.Install, timeout: TimeInterval) -> LocaleTest {
        let start = DispatchTime.now().uptimeNanoseconds
        let ms = { Int((DispatchTime.now().uptimeNanoseconds - start) / 1_000_000) }
        guard let word = localeWords[locale], let langs = langs ?? Tesseract.pack(for: locale), let img = render(word) else {
            return LocaleTest(ms: 0, pass: false, error: Diagnostic("self-test-failed", "doctor has no self-test word for \(locale)."))
        }
        do {
            let lines = try Tesseract.recognize(img, install: install, langs: "\(langs)+eng", timeout: timeout)
            let r = Checks.evaluate(kind: "present", text: word, lines: lines, locale: locale).0
            if r.verdict == "pass" { return LocaleTest(ms: ms(), pass: true, error: nil) }
            let read = lines.map(\.text).joined(separator: " ")
            return LocaleTest(ms: ms(), pass: false, error: Diagnostic(
                "self-test-failed", "Tesseract \(install.version) read \"\(read)\" instead of \"\(word)\" for \(locale).",
                hint: "check the \(langs) language data in \(install.tessdata ?? "its tessdata directory"); reinstall it if it is damaged"))
        } catch let d as Diagnostic {
            return LocaleTest(ms: ms(), pass: false, error: d)
        } catch {
            return LocaleTest(ms: ms(), pass: false, error: Diagnostic("fallback-failed", "\(error)"))
        }
    }

    /// Black text on white, 48 pt, sRGB.
    static func render(_ text: String) -> CGImage? {
        let width = 480, height = 120
        guard let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let font = CTFontCreateWithName("Helvetica" as CFString, 48, nil)
        let attrs: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1),
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
        ctx.textPosition = CGPoint(x: 40, y: 42)
        CTLineDraw(line, ctx)
        return ctx.makeImage()
    }
}
