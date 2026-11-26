// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation
import ImageIO
import Vision

/// One unit of work: the same fields as a `serve` request.
public struct Job {
    public var command: String // check | read | untranslated | video
    public var path: String?
    public var image: Data?
    public var name: String? // what the envelope reports as `path` (for stdin input: "-")
    public var present: [String] = []
    public var absent: [String] = []
    public var catalog: [CatalogCheck] = [] // @key checks, after the literal ones (spec 02)
    public var inventory: [CatalogCheck]? = nil // --all-keys (spec 02 D10)
    public var untranslated: UntranslatedJob? = nil // spec 17
    public var truncated: TruncationJob? = nil // spec 06
    public var overlap: OverlapJob? = nil // spec 12
    public var locale: String? // nil: not given, so catscan may pick one from the check text's script
    public var fallback: String? // tesseract | none; nil: tesseract when installed (spec 03)
    public var video: VideoOptions? = nil // spec 07
    public var textRecord: TextRecordJob? = nil // TODO-038 T1
    public var pseudo: PseudoJob? = nil // TODO-039 T2
    public var uncatalogued: UncataloguedJob? = nil // TODO-036 T4
    public var formats: FormatsJob? = nil // TODO-036 T3
    public var glyphs: GlyphsJob? = nil // TODO-036 T5
    public var fit: FitJob? = nil // TODO-073
    public var contrast: ContrastJob? = nil // TODO-054

    public init(command: String) { self.command = command }
}

public final class Engine {
    public static let maxPixels = 100_000_000
    public let revision: Int
    /// Vision language codes, in Vision's order.
    public let visionLanguages: [String]
    /// The same languages as catscan locale codes ("de", "pt-BR", "zh-Hans").
    public let locales: [String]
    public let host: HostInfo
    /// Why `supportedRecognitionLanguages()` failed; every job is then `vision-languages-failed` (TODO-003 D9).
    public let languagesError: String?
    /// The Tesseract fallback, probed on first use (spec 03); `true` asks for a fresh probe (TODO-065 D5). Tests replace it.
    var tesseract: (_ refresh: Bool) -> Tesseract.Install? = { Tesseract.installed(refresh: $0) }
    /// TODO-032: how long one image (all its tiles, or one video frame) may take in Vision.
    public var visionTimeout: TimeInterval = Engine.visionTimeout(ProcessInfo.processInfo.environment)
    /// Runs one Vision request; tests replace it with one that never returns (TODO-032).
    var perform: (VNRecognizeTextRequest, CGImage) throws -> Void = { r, img in
        try VNImageRequestHandler(cgImage: img, options: [:]).perform([r])
    }
    /// Waits for one Vision request until the image's deadline. Tests replace it to see the deadline each tile waits
    /// on, or to time out a tile without racing the clock (TODO-047).
    var waitForVision: (DispatchSemaphore, DispatchTime) -> DispatchTimeoutResult = { $0.wait(timeout: $1) }

    public static let defaultVisionTimeout: TimeInterval = 60

    /// `CATSCAN_VISION_TIMEOUT` in seconds; anything but a positive finite number keeps the default.
    public static func visionTimeout(_ env: [String: String]) -> TimeInterval {
        guard let s = env["CATSCAN_VISION_TIMEOUT"], let v = Double(s), v.isFinite, v > 0 else { return defaultVisionTimeout }
        return v
    }

    public convenience init() {
        let r = VNRecognizeTextRequest()
        r.recognitionLevel = .accurate
        r.revision = VNRecognizeTextRequestRevision3
        self.init(languages: Result { try r.supportedRecognitionLanguages() })
    }

    /// `languages` is what Vision listed; tests pass a reduced, extended or failed list.
    init(languages: Result<[String], Error>) {
        revision = VNRecognizeTextRequestRevision3
        switch languages {
        case .success(let l): visionLanguages = l; languagesError = nil
        case .failure(let e): visionLanguages = []; languagesError = e.localizedDescription
        }
        locales = visionLanguages.map(Languages.locale(forVision:))
        host = Host.info(visionRevision: revision)
    }

    public var engineName: String { "vision-accurate-rev\(revision)" }

    /// The Vision language for a catscan locale or any BCP 47 tag (spec 04 "Mapping"), nil when unsupported.
    public func resolve(_ locale: String) -> Languages.Resolution? {
        Languages.resolve(locale, supported: visionLanguages)
    }

    public func run(_ job: Job) -> Envelope {
        let t0 = DispatchTime.now().uptimeNanoseconds
        var env = Envelope(
            command: job.command, path: job.name ?? job.path, verdict: "pass", engine: engineName,
            locale: job.locale ?? "en", image: nil, host: host)
        env.textAsked = job.textRecord != nil
        var locale = job.locale ?? "en"
        // A Vision language newer than the table has no script metadata, so script rules cannot judge it.
        let known = resolve(locale)?.inTable ?? true

        // Locale and script: warn when a check string uses a script the locale cannot read.
        let ranges = job.video?.ranges ?? []
        let texts = job.present + job.absent + job.catalog.map(Checks.scriptText)
            + ranges.flatMap { $0.present + $0.absent + $0.catalog.map(Checks.scriptText) }
        for text in texts where known && languagesError == nil {
            for sc in Scripts.scripts(in: text) where !Scripts.readable(locale).contains(sc) {
                let cands = Scripts.candidates(for: sc, supported: locales)
                if job.locale == nil && cands.count == 1 {
                    env.warnings.append(Diagnostic(
                        "locale-script-mismatch",
                        "The check text is \(sc.rawValue) but the locale is \(locale); using \(cands[0]).",
                        hint: "--locale \(cands[0])"))
                    locale = cands[0]
                } else if !env.warnings.contains(where: { $0.code == "locale-script-mismatch" }) {
                    // A script only a fallback locale reads is hinted, never picked (spec 03 D4).
                    let hints = cands.isEmpty ? Scripts.candidates(for: sc, supported: Tesseract.locales) : cands
                    env.warnings.append(Diagnostic(
                        "locale-script-mismatch",
                        "The check text is \(sc.rawValue) but the locale is \(locale).",
                        hint: hints.isEmpty ? nil : hints.map { "--locale \($0)" }.joined(separator: " or ")))
                }
            }
        }
        env.locale = locale

        func finish(_ e: inout Envelope) {
            e.ms = Int((Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6).rounded())
        }

        if job.command == "video" { return runVideo(job, env: env, locale: locale, finish: finish) }

        // Decoded first: an unreadable input (exit 4) outranks an unsupported locale (exit 3).
        let decoded = decode(job)
        guard case .success(let img) = decoded else {
            if case .failure(let d) = decoded { env.error = d }
            env.verdict = "error"
            finish(&env)
            return env
        }
        env.image = ImageSize(width: img.width, height: img.height)
        if let b = job.truncated?.boxes ?? (job.command == "overlap" ? job.overlap?.boxes : nil) ?? (job.command == "glyphs" ? job.glyphs?.boxes : nil)
            ?? (job.command == "fit" ? job.fit?.boxes : nil) ?? (job.command == "contrast" ? job.contrast?.boxes : nil),
           let d = Truncation.mismatch(b, width: img.width, height: img.height) {
            env.verdict = "error"
            env.error = d
            finish(&env)
            return env
        }

        // TODO-073: a given profile that does not fit the image fails before the Vision read.
        if job.command == "fit", let p = job.fit?.profile, let d = Fit.mismatch(p, width: img.width, height: img.height, path: env.path) {
            env.verdict = "error"
            env.error = d
            finish(&env)
            return env
        }

        if job.command == "overlap", let looked = job.overlap?.noBoxes {
            env.verdict = "error"
            env.error = Overlap.noBoxes(looked, path: env.path)
            finish(&env)
            return env
        }
        if let why = languagesError {
            env.verdict = "error"
            env.error = Diagnostic(
                "vision-languages-failed", "Vision could not list its recognition languages: \(why)",
                hint: "rerun; if it persists, report it with the output of catscan --version")
            finish(&env)
            return env
        }
        guard let resolved = resolve(locale) else {
            let fix = Languages.corrections[locale.lowercased()].map { "--locale \($0)" }
            if let langs = Tesseract.pack(for: locale) {
                // TODO-065: a locale catscan reads with Tesseract is never "unsupported"; without a working
                // Tesseract it is needs-reader (D1), and the hint is the fix for this Mac's setup (D6).
                let need = langs.split(separator: "+").map(String.init) + ["eng"] // Tesseract runs <pack>+eng
                let lacking = { (i: Tesseract.Install?) in i.map { i in need.filter { !i.packs.contains($0) } } ?? need }
                var install = tesseract(false)
                if lacking(install).isEmpty == false { install = tesseract(true) } // D5: installed since the last probe?
                let missing = install == nil ? [] : lacking(install)
                let pe = ProcessInfo.processInfo.environment
                let installFix = Tesseract.fix(missing: missing, install: install, env: pe)
                if job.fallback != "none", let install, missing.isEmpty {
                    return fallback(job, img: img, install: install, langs: langs, env: env, finish: finish)
                }
                var message: String
                var hint: String
                if job.fallback == "none" {
                    message = "catscan reads the locale \(locale) with Tesseract; --fallback none turned it off."
                    hint = install != nil && missing.isEmpty ? "drop --fallback none" : "\(installFix); drop --fallback none"
                } else if let install {
                    let dir = install.tessdata ?? "its tessdata directory"
                    message = "catscan reads the locale \(locale) with Tesseract, but Tesseract \(install.version) has no \(missing.joined(separator: ", ")) language data in \(dir)."
                    hint = installFix
                    env.warnings.append(Diagnostic("fallback-pack-missing", "Tesseract \(install.version) has no \(missing.joined(separator: ", ")) language data for \(locale) in \(dir).", hint: hint))
                } else {
                    let looked = Tesseract.candidates(env: pe).joined(separator: ", ")
                    message = "catscan reads the locale \(locale) with Tesseract, which is not installed on this Mac (looked at \(looked))."
                    hint = installFix
                    if job.fallback == "tesseract" {
                        env.warnings.append(Diagnostic(
                            "fallback-unavailable", "--fallback tesseract was given, but no Tesseract was found (looked at \(looked)).",
                            hint: hint))
                    }
                }
                env.verdict = "needs-reader"
                env.error = Diagnostic("reader-missing", message, hint: hint)
                env.checks = checkSkeleton(job, verdict: "needs-reader")
                finish(&env)
                return env
            }
            env.verdict = "unsupported"
            env.error = Diagnostic(
                "unsupported-language", "Vision on this Mac cannot read the locale \(locale).",
                hint: fix ?? "catscan languages lists the locales this Mac reads")
            env.checks = checkSkeleton(job, verdict: "unsupported")
            finish(&env)
            return env
        }
        let language = resolved.vision
        if !resolved.exact {
            env.warnings.append(Diagnostic(
                "locale-fallback",
                "The locale \(locale) is not in the language table; reading it as \(resolved.locale) (Vision \(language)).",
                hint: "--locale \(resolved.locale)"))
        }
        if !resolved.inTable {
            env.warnings.append(Diagnostic(
                "language-not-in-table",
                "Vision reads \(language), which this catscan does not know; checks in its script are not guarded.",
                hint: "upgrade catscan for its script rules"))
        }

        let lines: [RecognizedLine]
        var uncorrected: [RecognizedLine]? = nil
        // TODO-067 D2: both reads share one image deadline, so the client's stall watchdog (vision timeout + slack) holds.
        let deadline = DispatchTime.now() + visionTimeout
        do {
            lines = try recognize(img, languages: [language, "en-US"], locale: locale, deadline: deadline)
        } catch {
            env.verdict = "error"
            env.error = error as? Diagnostic ?? Diagnostic("recognition-failed", "Vision failed: \(error.localizedDescription)")
            finish(&env)
            return env
        }
        // TODO-067 D5: the second read runs only when stacked text is asked for; its failure costs only the stacked
        // check (D15: a warning, never a silent pass), not the other readers' findings.
        if job.command == "overlap", job.overlap?.stacked == true {
            do {
                uncorrected = try recognize(img, languages: [language, "en-US"], locale: locale, correction: false, deadline: deadline)
            } catch let d as Diagnostic where d.code == "vision-timeout" {
                // TODO-032: the abandoned call may hold its thread; the error is what makes the client replace the core.
                env.verdict = "error"
                env.error = d
                finish(&env)
                return env
            } catch {
                // D35: the dictionary evidence reads the first read only, so it still runs; the correction evidence cannot.
                let code = (error as? Diagnostic)?.code ?? "recognition-failed"
                uncorrected = []
                env.warnings.append(Diagnostic(
                    "stacked-unchecked", "stacked text only partly checked: the second Vision read failed (\(code)), so only the dictionary rule ran",
                    hint: "rerun to check stacked text fully"))
            }
        }

        evaluate(job, lines: lines, uncorrected: uncorrected, locale: locale, guardScripts: resolved.inTable, image: img, env: &env)
        finish(&env)
        return env
    }

    /// Reads an unsupported locale with Tesseract (spec 03); the check rules are the same as for Vision.
    func fallback(
        _ job: Job, img: CGImage, install: Tesseract.Install, langs: String, env e: Envelope,
        finish: (inout Envelope) -> Void
    ) -> Envelope {
        var env = e
        env.engine = install.engineName
        let at = env.warnings.count
        var read = "read it"
        do {
            let l = "\(langs)+eng"
            var lines = try Tesseract.recognize(img, install: install, langs: l)
            // TODO-020: Tesseract reads tall text best unscaled, so only short text is read again, scaled up.
            let heights = lines.map { Double($0.rect.height) * Double(img.height) }
            let f = Tesseract.scale(lineHeights: heights, width: img.width, height: img.height)
            if f > 1, let up = Engine.scale(img, by: f) {
                lines = try Tesseract.recognize(up, install: install, langs: l)
                read = heights.isEmpty
                    ? "found no text unscaled and read it again at \(Geometry.round2(f))x"
                    : "read its short text (median line \(Int(Tesseract.median(heights).rounded())) px) again at \(Geometry.round2(f))x"
            }
            lines = Geometry.readingOrder(lines, rtl: TextMatch.isRightToLeft(env.locale))
            evaluate(job, lines: lines, locale: env.locale, guardScripts: true, image: img, env: &env)
            if job.command == "truncated", let w = Truncation.unmeasuredOnFallback(job.truncated ?? TruncationJob()) { env.warnings.append(w) }
            if job.command == "overlap", job.overlap?.stacked == true { // TODO-067 D15: never a silent pass
                if job.overlap?.boxes == nil && job.overlap?.geometry == false {
                    // D35: plain overlap on a Tesseract read ran no reader at all, so it is no pass.
                    env.verdict = "unsupported"
                    env.findings = []
                    env.error = Diagnostic(
                        "overlap-unchecked", "overlap without boxes checks stacked text on Vision reads only, and Tesseract read this image",
                        hint: "give --boxes to check element overlap here, or --experimental for the OCR-only reader; catscan languages lists the locales Vision reads")
                } else {
                    env.warnings.append(Diagnostic(
                        "stacked-unchecked", "stacked text not checked: Tesseract read this image and stacked runs on Vision reads only",
                        hint: "catscan languages lists the locales Vision reads; the other overlap readers still ran"))
                }
            }
            if job.command == "contrast" { // TODO-054: the estimator and its bench ran on Vision line boxes only
                env.warnings.append(Diagnostic(
                    "rule-unmeasured-reader", "contrast is measured on Vision only; Tesseract read this image, so its line boxes and findings are unmeasured",
                    hint: "check the flagged lines by eye"))
            }
            if job.command == "formats" {
                env.warnings.append(Diagnostic(
                    "rule-unmeasured-reader", "formats is measured on Vision only; Tesseract read this image, so its findings are unmeasured",
                    hint: "check the flagged tokens by eye"))
            }
            if job.command == "untranslated", job.uncatalogued != nil, job.untranslated?.kinds?.contains("uncatalogued") ?? false {
                env.warnings.append(Diagnostic(
                    "rule-unmeasured-reader", "uncatalogued is measured on Vision only; Tesseract read this image, so its uncatalogued findings are unmeasured",
                    hint: "check the flagged lines by eye"))
            }
            if job.command == "untranslated", let u = job.untranslated, u.wrongLanguage != nil, u.kinds?.contains("wrong-language") ?? true {
                env.warnings.append(Diagnostic(
                    "rule-unmeasured-reader", "wrong-language is measured on Vision only; Tesseract read this image, so its wrong-language findings are unmeasured",
                    hint: "--kinds untranslated,raw-key,placeholder to skip it"))
            }
        } catch {
            env.verdict = "error"
            env.error = error as? Diagnostic ?? Diagnostic("fallback-failed", "\(error)", hint: "catscan doctor")
        }
        // Inserted after the read so it can say whether a second, scaled read happened; it stays first.
        env.warnings.insert(Diagnostic(
            "fallback-engine",
            "Vision cannot read the locale \(env.locale); Tesseract \(install.version) \(read) (-l \(langs)+eng), slower and less accurate on stylized text.",
            hint: "--fallback none to skip it"), at: at)
        finish(&env)
        return env
    }

    /// `check --pseudo`: the matched line as recognized, found by its box (one line; a joined pair keeps the fold).
    static func unfolded(_ line: String, box: [Double]?, _ raw: [RecognizedLine]) -> String {
        raw.first { Geometry.box($0.rect) == box }?.text ?? line
    }

    /// The lines a finding already covers: the line's center lies in the finding's box.
    static func reported(_ findings: [Finding], _ lines: [RecognizedLine]) -> Set<Int> {
        let boxes = findings.compactMap { f in f.box.map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) } }
        return Set(lines.indices.filter { i in
            let c = CGPoint(x: lines[i].rect.midX, y: lines[i].rect.midY)
            return boxes.contains { $0.insetBy(dx: -0.0001, dy: -0.0001).contains(c) }
        })
    }

    /// Adds per-line findings in reading order: each goes before the first existing finding on a later line.
    static func merge(_ findings: [Finding], _ add: [(line: Int, finding: Finding)], _ lines: [RecognizedLine]) -> [Finding] {
        guard !add.isEmpty else { return findings }
        let lineOf = { (f: Finding) -> Int in
            guard let b = f.box else { return Int.max }
            let r = CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
            return lines.indices.first { r.insetBy(dx: -0.0001, dy: -0.0001).contains(CGPoint(x: lines[$0].rect.midX, y: lines[$0].rect.midY)) } ?? Int.max
        }
        var all = findings.enumerated().map { (lineOf($0.element), 0, $0.offset, $0.element) }
        all += add.enumerated().map { ($0.element.line, 1, $0.offset, $0.element.finding) }
        return all.sorted { ($0.0, $0.1, $0.2) < ($1.0, $1.1, $1.2) }.map(\.3)
    }

    func evaluate(_ job: Job, lines: [RecognizedLine], uncorrected: [RecognizedLine]? = nil, locale: String, guardScripts: Bool, image: CGImage? = nil, env: inout Envelope) {
        // TODO-038 T1: built from the lines every command already read; no extra Vision call.
        if let t = job.textRecord, job.command != "video" { env.text = TextRecord.make(lines.map(\.text), locale: locale, job: t) }
        if job.command == "read" {
            env.lines = lines.map {
                LineOut(text: $0.text, box: Geometry.box($0.rect), confidence: Geometry.round2($0.confidence))
            }
        } else if job.command == "truncated" {
            let t = job.truncated ?? TruncationJob()
            env.findings = Truncation.evaluate(t, lines: lines, width: env.image?.width ?? 0, height: env.image?.height ?? 0, locale: locale)
            if let p = job.pseudo {
                // Existing reasons win on the same line (TODO-039 T2).
                let r = Pseudo.evaluate(p, lines: lines, locale: locale, skip: Engine.reported(env.findings, lines), cuts: t.reasons.contains("pseudo-cut"), hardcoded: false)
                env.findings = Engine.merge(env.findings, r.cuts, lines)
                if let n = r.notApplied { env.findings.insert(n, at: 0) }
                env.pseudo = true
            }
            if !env.findings.isEmpty { env.verdict = "fail" }
        } else if job.command == "fit" {
            let r = Fit.evaluate(job.fit ?? FitJob(), lines: lines, width: env.image?.width ?? 0, height: env.image?.height ?? 0, path: env.path, locale: locale)
            if let e = r.error {
                env.error = e
                env.verdict = "error"
                return
            }
            env.findings = r.findings
            env.warnings += r.warnings
            env.deviceProfile = r.deviceProfile
            env.reasonsRun = r.reasonsRun
            env.reasonsSkipped = r.reasonsSkipped
            env.elementRows = r.elementRows
            if !env.findings.isEmpty { env.verdict = "fail" }
        } else if job.command == "contrast", let img = image {
            // TODO-054: the pixels under the line boxes Vision already returned; no second read (spec "Scope").
            let r = Contrast.evaluate(job.contrast ?? ContrastJob(), lines: lines, image: img, locale: locale)
            env.lines = r.lines
            env.findings = r.findings
            env.warnings += r.warnings
            if !env.findings.isEmpty { env.verdict = "fail" }
        } else if job.command == "glyphs" {
            let g = job.glyphs ?? GlyphsJob()
            env.findings = Glyphs.evaluate(g, lines: lines, width: env.image?.width ?? 0, height: env.image?.height ?? 0, locale: locale, guardScripts: guardScripts)
            if g.lines { env.lines = lines.map { LineOut(text: $0.text, box: Geometry.box($0.rect), confidence: Geometry.round2($0.confidence)) } }
            if !env.findings.isEmpty { env.verdict = "fail" }
        } else if job.command == "formats" {
            let f = job.formats ?? FormatsJob()
            let r = Formats.evaluate(f, lines: lines, locale: locale)
            env.findings = r.findings
            env.priceExempt = r.priceExempt
            // D17: the currency rules need the storefront's currency; say so in every envelope.
            if f.currency == nil, !f.rules.isDisjoint(with: ["currency", "price"]) {
                env.warnings.append(Diagnostic(
                    "currency-unchecked", "No expected currency, so the currency and price rules did not run",
                    hint: "--storefront DE or --currency EUR"))
            }
            if !env.findings.isEmpty { env.verdict = "fail" }
        } else if job.command == "overlap" {
            let o = job.overlap ?? OverlapJob()
            env.findings = o.boxes == nil && !o.geometry ? []
                : Overlap.evaluate(o, lines: lines, width: env.image?.width ?? 0, height: env.image?.height ?? 0, locale: locale)
            if o.stacked, let u = uncorrected { // TODO-067: beside the other reader, never twice on one region
                var st = Stacked.evaluate(corrected: lines, uncorrected: u, locale: locale, allow: o.allow)
                if let b = o.boxes { st = Stacked.dropAllowed(st, elements: b.elements, allow: o.allow, locale: locale) }
                env.findings = Stacked.merge(env.findings, st)
            }
            if !env.findings.isEmpty { env.verdict = "fail" }
        } else if job.command == "untranslated" {
            let (f, w) = Untranslated.evaluate(
                job.untranslated ?? UntranslatedJob(baseLocale: "en"), lines: lines, locale: locale, guardScripts: guardScripts,
                aspect: env.image.map { $0.height > 0 ? Double($0.width) / Double($0.height) : 1 } ?? 1)
            env.findings = f
            env.warnings += w
            // TODO-036 T2: wrong-language after the spec 17 rules; a line they reported is never reported again (D5).
            if let u = job.untranslated, let wl = u.wrongLanguage, u.kinds?.contains("wrong-language") ?? true {
                let r = WrongLanguage.evaluate(
                    wl, main: u, lines: lines, locale: locale, guardScripts: guardScripts,
                    aspect: env.image.map { $0.height > 0 ? Double($0.width) / Double($0.height) : 1 } ?? 1,
                    reported: f)
                let kept = f.enumerated().filter { !r.drop.contains($0.offset) }.map(\.element)
                env.findings = Engine.merge(kept, r.add, lines)
            }
            if var p = job.pseudo {
                // Boxes for another screen size mark no element here (spec 06 D7, as for truncated).
                if let s = p.rectsSize, !p.guards.rects.isEmpty, let img = env.image,
                   let d = Truncation.mismatch(TruncationJob.Boxes(width: s.width, height: s.height, elements: []), width: img.width, height: img.height) {
                    p.guards.rects = []
                    env.warnings.append(d)
                }
                // TODO-039 T2: `raw-key` and `placeholder` win over `hardcoded` on the same line.
                let r = Pseudo.evaluate(p, lines: lines, locale: locale, skip: Engine.reported(f, lines), cuts: false, hardcoded: true)
                env.findings = Engine.merge(env.findings, r.hardcoded, lines)
                if let n = r.notApplied { env.findings.insert(n, at: 0) }
                env.pseudo = true
            }
            // TODO-036 T4 (D52): after every other rule; a line any of them reported is never uncatalogued.
            if var uj = job.uncatalogued, job.untranslated?.kinds?.contains("uncatalogued") ?? false {
                if let s = uj.rectsSize, !uj.guards.rects.isEmpty, let img = env.image,
                   let d = Truncation.mismatch(TruncationJob.Boxes(width: s.width, height: s.height, elements: []), width: img.width, height: img.height) {
                    uj.guards.rects = []
                    env.warnings.append(d)
                }
                let r = Uncatalogued.evaluate(
                    uj, lines: lines, locale: locale, aspect: env.image.map { $0.height > 0 ? Double($0.width) / Double($0.height) : 1 } ?? 1,
                    skip: Engine.reported(Uncatalogued.shadowing(env.findings, kinds: job.untranslated?.kinds), lines))
                env.findings = Engine.merge(env.findings, r, lines)
            }
            if let k = job.untranslated?.kinds { env.findings.removeAll { $0.kind != "pseudo-not-applied" && !k.contains($0.kind) } }
            if !env.findings.isEmpty { env.verdict = "fail" }
        } else {
            func unreadable(_ t: String) -> Bool {
                guardScripts && Scripts.scripts(in: t).contains(where: { !Scripts.readable(locale).contains($0) })
            }
            // TODO-039 D8: `check --pseudo` matches on the reads with markers stripped and accents folded on both sides.
            let raw = lines
            let pseudo = job.pseudo != nil
            let fold = { (t: String) in pseudo ? Pseudo.fold(t, locale: locale) : t }
            let lines = pseudo ? lines.map { RecognizedLine(text: Pseudo.plain($0.text, locale: locale), rect: $0.rect, confidence: $0.confidence) } : lines
            env.pseudo = pseudo
            for (kind, texts) in [("present", job.present), ("absent", job.absent)] {
                for t in texts {
                    // The engine cannot output a script the locale does not read, so such a check proves nothing:
                    // an absent check would always pass. It is unsupported, never pass or fail.
                    if unreadable(t) {
                        env.checks.append(CheckResult(kind: kind, text: t, verdict: "unsupported"))
                        continue
                    }
                    var (r, w) = Checks.evaluate(kind: kind, text: fold(t), lines: lines, locale: locale)
                    if pseudo { r.text = t; r.line = r.line.map { Engine.unfolded($0, box: r.box, raw) } }
                    env.checks.append(r)
                    for d in w where !env.warnings.contains(d) { env.warnings.append(d) }
                }
            }
            let windows = Checks.Windows(lines, locale: locale)
            for c in job.catalog {
                // The script guard reads every alternative (spec 02 D7).
                if c.reason == nil && unreadable(Checks.scriptText(c)) {
                    env.checks.append(Checks.skeleton(c, verdict: "unsupported"))
                    continue
                }
                var c = c
                if pseudo { c.alternatives = c.alternatives.map { $0.map(fold) } }
                var (r, w) = Checks.evaluate(c, windows: windows, lines: lines, locale: locale)
                if pseudo { r.line = r.line.map { Engine.unfolded($0, box: r.box, raw) } }
                env.checks.append(r)
                for d in w where !env.warnings.contains(d) { env.warnings.append(d) }
            }
            if let inv = job.inventory {
                env.inventory = Checks.inventory(inv, windows: windows, lines: lines, locale: locale) {
                    unreadable(Checks.scriptText($0))
                }
                // Skipped inventory keys are named once, so --quiet never hides them (spec 02 D22, D27).
                for (code, why) in [("catalog-missing", "have no string for the locale \(locale)"),
                                    ("catalog-string-capped", "expand past the fragment or nesting caps"),
                                    ("catalog-value-dynamic", "are not plain strings in their code catalog")] {
                    let n = env.inventory!.skipped.filter { $0.reason == code }.count
                    if n > 0 {
                        env.warnings.append(Diagnostic(code, "\(n) catalog key\(n == 1 ? "" : "s") \(why); the inventory skips \(n == 1 ? "it" : "them")."))
                    }
                }
            }
            if env.checks.contains(where: { $0.verdict == "unsupported" }) {
                env.verdict = "unsupported"
                env.error = Diagnostic(
                    "unsupported-script", "A check text uses a script the locale \(locale) cannot read.",
                    hint: env.warnings.first(where: { $0.code == "locale-script-mismatch" })?.hint)
            } else if env.checks.contains(where: { $0.verdict == "fail" }) {
                env.verdict = "fail"
            }
        }
    }

    func checkSkeleton(_ job: Job, verdict: String) -> [CheckResult] {
        func group(_ p: [String], _ a: [String], _ c: [CatalogCheck], range: String?) -> [CheckResult] {
            (p.map { CheckResult(kind: "present", text: $0, verdict: verdict) }
                + a.map { CheckResult(kind: "absent", text: $0, verdict: verdict) }
                + c.map { Checks.skeleton($0, verdict: verdict) }).map {
                    var r = $0
                    r.video = job.command == "video"
                    r.range = range
                    return r
                }
        }
        return group(job.present, job.absent, job.catalog, range: nil)
            + (job.video?.ranges ?? []).flatMap { group($0.present, $0.absent, $0.catalog, range: $0.key) }
    }

    func decode(_ job: Job) -> Result<CGImage, Diagnostic> {
        let src: CGImageSource?
        if let data = job.image {
            src = CGImageSourceCreateWithData(data as CFData, nil)
        } else if let path = job.path {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else {
                return .failure(Diagnostic("input-not-found", "No such file: \(path)"))
            }
            if isDir.boolValue {
                return .failure(Diagnostic(
                    "no-images", "The folder has no readable PNG, JPEG or HEIC images: \(path)",
                    hint: "check the path"))
            }
            // stat follows symlinks: a FIFO or device behind an image name would block the read forever.
            var st = stat()
            if stat(path, &st) == 0, st.st_mode & S_IFMT != S_IFREG {
                return .failure(Diagnostic("input-unreadable", "Not a regular file: \(path)"))
            }
            src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)
        } else {
            return .failure(Diagnostic("input-missing", "The request has neither image nor path."))
        }
        guard let src, CGImageSourceGetCount(src) > 0,
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
            let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int
        else {
            // A video passed to check or read names the command that reads it (spec 07 D20).
            let ext = job.path.map { ($0 as NSString).pathExtension.lowercased() } ?? ""
            return .failure(Diagnostic(
                "input-unreadable", "Not a readable PNG, JPEG or HEIC image.",
                hint: ["mp4", "mov"].contains(ext) ? "catscan video \(job.path!)" : nil))
        }
        // Checked before decoding, so a decompression bomb never allocates its pixels.
        if w * h > Engine.maxPixels {
            return .failure(Diagnostic(
                "image-too-large", "The image is \(w)x\(h), over the limit of 100 megapixels."))
        }
        // Vision reads pixels as stored; a rotated JPEG or HEIC must be turned upright first.
        let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
        let decoded = orientation == 1
            ? CGImageSourceCreateImageAtIndex(src, 0, nil)
            : CGImageSourceCreateThumbnailAtIndex(src, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: max(w, h),
            ] as CFDictionary)
        guard let img = decoded else {
            return .failure(Diagnostic("input-unreadable", "The image could not be decoded."))
        }
        return .success(img)
    }

    /// Recognition defaults (spec 00) plus tiling for images longer than 4096 px (spec 01).
    /// `correction: false` is TODO-067's second read (D2): same tiling, merge and languages, and the caller passes the
    /// first read's `deadline`.
    func recognize(_ original: CGImage, languages: [String], locale: String, correction: Bool = true, deadline given: DispatchTime? = nil) throws -> [RecognizedLine] {
        var img = original
        let deadline = given ?? DispatchTime.now() + visionTimeout // one per image, shared by its tiles (TODO-032)
        // The upscaled image must stay under the decode cap too.
        if img.width < 1000, img.width * img.height * 4 <= Engine.maxPixels, let up = Engine.scale(img, by: 2) {
            img = up
        }
        let longIsHeight = img.height >= img.width
        let long = longIsHeight ? img.height : img.width
        let starts = Geometry.tileStarts(length: long)
        var all: [RecognizedLine] = []
        for s in starts {
            let span = min(4096, long)
            let crop = longIsHeight
                ? CGRect(x: 0, y: s, width: img.width, height: span)
                : CGRect(x: s, y: 0, width: span, height: img.height)
            guard let tile = starts.count == 1 ? img : img.cropping(to: crop) else { continue }
            // Tile-normalized, top-left origin -> full-image normalized.
            let toImage = { (r: CGRect) -> CGRect in
                longIsHeight
                    ? CGRect(x: r.minX, y: (r.minY * CGFloat(span) + CGFloat(s)) / CGFloat(long),
                             width: r.width, height: r.height * CGFloat(span) / CGFloat(long))
                    : CGRect(x: (r.minX * CGFloat(span) + CGFloat(s)) / CGFloat(long), y: r.minY,
                             width: r.width * CGFloat(span) / CGFloat(long), height: r.height)
            }
            for l in try recognizeOne(tile, languages: languages, deadline: deadline, correction: correction) {
                let ranges = l.rangeBox
                all.append(RecognizedLine(
                    text: l.text, rect: toImage(l.rect), confidence: l.confidence,
                    rangeBox: ranges.map { f in { f($0).map(toImage) } }))
            }
        }
        if starts.count > 1 { all = Geometry.mergeTiles(all, locale: locale) }
        return Geometry.readingOrder(all, rtl: TextMatch.isRightToLeft(locale))
    }

    func recognizeOne(_ img: CGImage, languages: [String], deadline: DispatchTime, correction: Bool = true) throws -> [RecognizedLine] {
        let r = VNRecognizeTextRequest()
        r.recognitionLevel = .accurate
        r.revision = VNRecognizeTextRequestRevision3
        r.usesLanguageCorrection = correction
        var langs: [String] = []
        for l in languages where !langs.contains(l) { langs.append(l) }
        r.recognitionLanguages = langs
        // TODO-032: a Vision request that never returns once hung a run for 10+ minutes. It runs on its own
        // thread; past the deadline it is cancelled and abandoned, and the client replaces this process.
        let box = Video.Box<Void>()
        let done = DispatchSemaphore(value: 0)
        let perform = self.perform
        DispatchQueue.global().async {
            let res = Result { try perform(r, img) }
            box.lock.withLock { box.value = res }
            done.signal()
        }
        if waitForVision(done, deadline) == .timedOut {
            r.cancel()
            throw Diagnostic(
                "vision-timeout", "Vision did not finish reading the image in \(Video.fmt(visionTimeout)) s.",
                hint: "rerun; on a slow host raise CATSCAN_VISION_TIMEOUT (seconds)")
        }
        try box.lock.withLock { box.value! }.get()
        return (r.results ?? []).compactMap { o in
            guard let c = o.topCandidates(1).first else { return nil }
            // TODO-046 D4: character ranges of a merged line, for the overlap elements reader.
            return RecognizedLine(
                text: c.string, rect: Geometry.fromVision(o.boundingBox), confidence: Double(c.confidence),
                rangeBox: { r in (try? c.boundingBox(for: r)).map { Geometry.fromVision($0.boundingBox) } })
        }
    }

    static func scale(_ img: CGImage, by f: Double) -> CGImage? {
        guard let ctx = CGContext(
            data: nil, width: Int((Double(img.width) * f).rounded()), height: Int((Double(img.height) * f).rounded()), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: ctx.width, height: ctx.height))
        return ctx.makeImage()
    }
}

public enum Host {
    static func sysctl(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
        return String(cString: buf)
    }

    static func sysctlInt(_ name: String) -> Int32? {
        var v: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname(name, &v, &size, nil, 0) == 0 ? v : nil
    }

    public static func macOS() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion == 0 ? "\(v.majorVersion).\(v.minorVersion)" : "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    public static func macOSBuild() -> String { sysctl("kern.osversion") ?? "unknown" }

    public static func info(visionRevision: Int) -> HostInfo {
        HostInfo(
            chip: sysctl("machdep.cpu.brand_string") ?? "unknown",
            arch: sysctl("hw.machine") ?? "unknown",
            host_class: sysctlInt("kern.hv_vmm_present") == 1 ? "vm" : "physical",
            macos: "\(macOS()) (\(macOSBuild()))", vision_revision: visionRevision)
    }
}
