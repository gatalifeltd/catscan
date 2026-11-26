// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The `check` rule: present / absent over recognized lines in reading order (spec 01).
public enum Checks {
    struct Hit {
        var line: String
        var rect: CGRect
        var confidence: Double
    }

    /// One line, or two consecutive lines joined with a space (wrapped text).
    static func find(_ needle: String, in lines: [RecognizedLine], locale: String) -> Hit? {
        let short = TextMatch.isShort(needle, locale: locale) && !TextMatch.isUnspaced(locale)
        let norm = lines.map { TextMatch.normalize($0.text, locale: locale) }
        for (i, l) in lines.enumerated() where TextMatch.contains(norm[i], needle, wordBounded: short) {
            return Hit(line: l.text, rect: l.rect, confidence: l.confidence)
        }
        if lines.count < 2 { return nil }
        for i in 0..<(lines.count - 1) {
            let joined = TextMatch.normalize(lines[i].text + " " + lines[i + 1].text, locale: locale)
            if TextMatch.contains(joined, needle, wordBounded: short) {
                return Hit(
                    line: lines[i].text + " " + lines[i + 1].text, rect: lines[i].rect.union(lines[i + 1].rect),
                    confidence: min(lines[i].confidence, lines[i + 1].confidence))
            }
        }
        return nil
    }

    public static func evaluate(
        kind: String, text: String, lines: [RecognizedLine], locale: String
    ) -> (CheckResult, [Diagnostic]) {
        var r = CheckResult(kind: kind, text: text, verdict: "pass")
        var warnings: [Diagnostic] = []
        let needle = TextMatch.normalize(text, locale: locale)
        if needle.isEmpty {
            r.verdict = "skipped"
            r.reason = "no-checkable-text"
            warnings.append(Diagnostic(
                "no-checkable-text", "The check text \"\(text)\" has nothing left to match after normalization; it was skipped.",
                hint: "use the visible text"))
            return (r, warnings)
        }
        if TextMatch.isShort(needle, locale: locale) {
            warnings.append(Diagnostic(
                "short-check-text",
                "The check text \"\(text)\" is short; it matches whole words only.",
                hint: "use a longer string"))
        }
        let hit = find(needle, in: lines, locale: locale)
        if let hit {
            r.box = Geometry.box(hit.rect)
            r.line = hit.line
            r.confidence = Geometry.round2(hit.confidence)
        }
        switch kind {
        case "present":
            if hit == nil {
                r.verdict = "fail"
                r.closest = closest(needle, lines: lines, locale: locale)
            }
        default:
            if hit != nil { r.verdict = "fail" }
        }
        return (r, warnings)
    }

    /// The recognized line with the smallest edit distance to the expected text; the first one wins ties.
    static func closest(_ needle: String, lines: [RecognizedLine], locale: String) -> Closest? {
        var best: (Int, RecognizedLine)?
        for l in lines {
            let d = TextMatch.editDistance(needle, TextMatch.normalize(l.text, locale: locale))
            if best == nil || d < best!.0 { best = (d, l) }
        }
        return best.map { Closest(line: $0.1.text, box: Geometry.box($0.1.rect), distance: $0.0) }
    }
}

/// Which scripts a locale can read, and the locale-script-mismatch warning (spec 00, "Locale and script").
public enum Scripts {
    public enum Script: String, CaseIterable {
        case latin = "Latin", cyrillic = "Cyrillic", greek = "Greek", han = "Han", kana = "Kana",
            hangul = "Hangul", thai = "Thai", arabic = "Arabic", hebrew = "Hebrew", devanagari = "Devanagari",
            georgian = "Georgian", armenian = "Armenian" // read only through the Tesseract fallback (spec 03)
        // Any other letter (Bengali, Tamil...): no locale reads it, so a check in it is unsupported.
        case other = "in another script"
    }

    static func script(of u: Unicode.Scalar) -> Script? {
        guard u.properties.isAlphabetic else { return nil }
        switch u.value {
        case 0x41...0x36F, 0x1E00...0x1EFF, 0x2070...0x209F, 0x2100...0x218F, 0x24B6...0x24E9, 0x2C60...0x2C7F,
            0xA720...0xA7FF, 0xAB30...0xAB6F, 0xFB00...0xFB06, 0xFF21...0xFF3A, 0xFF41...0xFF5A:
            return .latin
        case 0x370...0x3FF, 0x1F00...0x1FFF: return .greek
        case 0x400...0x52F, 0x1C80...0x1C8F, 0x2DE0...0x2DFF, 0xA640...0xA69F: return .cyrillic
        case 0x590...0x5FF, 0xFB1D...0xFB4F: return .hebrew
        case 0x600...0x6FF, 0x750...0x77F, 0x8A0...0x8FF, 0xFB50...0xFDFF, 0xFE70...0xFEFF: return .arabic
        case 0x900...0x97F, 0xA8E0...0xA8FF: return .devanagari
        case 0xE00...0xE7F: return .thai
        case 0x10A0...0x10FF, 0x1C90...0x1CBF, 0x2D00...0x2D2F: return .georgian
        case 0x531...0x58F, 0xFB13...0xFB17: return .armenian
        case 0x3040...0x30FF, 0x31F0...0x31FF, 0xFF66...0xFF9F: return .kana
        case 0x1100...0x11FF, 0x3130...0x318F, 0xA960...0xA97F, 0xAC00...0xD7FF, 0xFFA0...0xFFDC: return .hangul
        case 0x2E80...0x2FDF, 0x3005...0x3007, 0x3021...0x3029, 0x3038...0x303B, 0x3400...0x4DBF, 0x4E00...0x9FFF,
            0xF900...0xFAFF, 0x20000...0x323AF:
            return .han
        default: return .other
        }
    }

    public static func scripts(in s: String) -> [Script] {
        var seen = Set<Script>()
        var out: [Script] = []
        for u in s.unicodeScalars {
            if let sc = script(of: u), seen.insert(sc).inserted { out.append(sc) }
        }
        return out
    }

    /// Scripts a locale reads. Latin is always readable: en-US is always in the recognition languages.
    public static func readable(_ locale: String) -> Set<Script> {
        // Serbian Latin is read by the srp_latn pack, which cannot output Cyrillic (spec 03).
        if TextMatch.base(locale) == "sr", locale.lowercased().split(separator: "-").contains("latn") { return [.latin] }
        switch TextMatch.base(locale) {
        case "ru", "uk", "be", "bg", "sr", "mk", "kk": return [.latin, .cyrillic]
        case "el": return [.latin, .greek]
        case "ja": return [.latin, .han, .kana]
        case "zh", "yue": return [.latin, .han]
        case "ko": return [.latin, .hangul, .han]
        case "th": return [.latin, .thai]
        case "ar", "ars", "fa", "ur": return [.latin, .arabic]
        case "he": return [.latin, .hebrew]
        case "hi", "mr": return [.latin, .devanagari]
        case "ka": return [.latin, .georgian]
        case "hy": return [.latin, .armenian]
        default: return [.latin]
        }
    }

    /// Supported locales (catscan codes) that read `script`, in a stable order.
    public static func candidates(for script: Script, supported: [String]) -> [String] {
        supported.filter { readable($0).contains(script) && !readable($0).isSubset(of: [.latin]) }
    }
}

/// `@key` checks and the `--all-keys` inventory (spec 02, "Rule"; D2, D6, D7).
extension Checks {
    /// Every recognized line and every pair of consecutive lines joined with a space, normalized once per image.
    public struct Windows {
        struct Window {
            var hay: [Character]
            var line: String
            var rect: CGRect
            var confidence: Double
        }
        var all: [Window] = []

        public init(_ lines: [RecognizedLine], locale: String) {
            for l in lines {
                all.append(Window(hay: Array(TextMatch.normalize(l.text, locale: locale)), line: l.text, rect: l.rect, confidence: l.confidence))
            }
            if lines.count < 2 { return }
            for i in 0..<(lines.count - 1) {
                let a = lines[i], b = lines[i + 1]
                all.append(Window(
                    hay: Array(TextMatch.normalize(a.text + " " + b.text, locale: locale)), line: a.text + " " + b.text,
                    rect: a.rect.union(b.rect), confidence: min(a.confidence, b.confidence)))
            }
        }

        /// The first window holding every fragment in order, without overlap.
        func find(_ fragments: [[Character]]) -> Window? {
            all.first { w in
                var from = 0
                for f in fragments {
                    guard let i = Windows.index(of: f, in: w.hay, from: from) else { return false }
                    from = i + f.count
                }
                return true
            }
        }

        static func index(of n: [Character], in h: [Character], from: Int) -> Int? {
            if n.isEmpty || from + n.count > h.count { return nil }
            for i in from...(h.count - n.count) where h[i..<(i + n.count)].elementsEqual(n) { return i }
            return nil
        }
    }

    /// The text the script rules read: every fragment of every alternative.
    public static func scriptText(_ c: CatalogCheck) -> String {
        c.alternatives.flatMap { $0 }.joined(separator: " ")
    }

    public static func skeleton(_ c: CatalogCheck, verdict: String) -> CheckResult {
        var r = CheckResult(kind: c.kind, text: c.text, verdict: verdict)
        r.key = c.key
        r.catalog = c.catalog
        return r
    }

    /// Normalized fragments per alternative, with the short ones dropped (4, or 2 for ja/ko/zh/th).
    static func checkable(_ c: CatalogCheck, locale: String) -> [[[Character]]] {
        c.alternatives.map { alt in
            alt.map { TextMatch.normalize($0, locale: locale) }.filter { !TextMatch.isShort($0, locale: locale) }.map { Array($0) }
        }
    }

    static func longest(_ alt: [[Character]]) -> [Character] {
        alt.reduce([]) { $1.count > $0.count ? $1 : $0 }
    }

    enum Outcome {
        case hit(Windows.Window)
        case miss
        case uncheckable
    }

    /// D7: a checkable alternative that matches decides; otherwise an uncheckable alternative makes the result unknown.
    static func outcome(_ alts: [[[Character]]], kind: String, windows: Windows) -> Outcome {
        for alt in alts where !alt.isEmpty {
            if let w = windows.find(kind == "absent" ? [longest(alt)] : alt) { return .hit(w) }
        }
        return alts.isEmpty || alts.contains(where: { $0.isEmpty }) ? .uncheckable : .miss
    }

    public static func evaluate(
        _ c: CatalogCheck, windows: Windows, lines: [RecognizedLine], locale: String
    ) -> (CheckResult, [Diagnostic]) {
        var r = skeleton(c, verdict: "pass")
        if let reason = c.reason {
            // The skip is in the envelope's warnings too, so --quiet never hides it (spec 02 D22).
            r.verdict = "skipped"
            r.reason = reason
            // TODO-092 D6: a code catalog value that is not a plain string (a call, a template with ${}) has no text.
            let why = reason == "catalog-string-capped" ? "expands past 256 fragments or 4 nested plurals"
                : reason == "catalog-value-dynamic" ? "is not a plain string in its code catalog (a call, a template with ${...} or other code)"
                : "has no string for the locale \(locale)"
            let hint = reason == "catalog-missing" ? "add the translation or the catalog file for this locale"
                : reason == "catalog-value-dynamic" ? "write the string as a literal in the catalog, or check it with --present and the shown text"
                : "check it with --present and the shown text"
            return (r, [Diagnostic(reason, "The catalog key @\(c.key) \(why); its check was skipped.", hint: hint)])
        }
        let alts = checkable(c, locale: locale)
        switch outcome(alts, kind: c.kind, windows: windows) {
        case .hit(let w):
            r.box = Geometry.box(w.rect)
            r.line = w.line
            r.confidence = Geometry.round2(w.confidence)
            if c.kind == "absent" { r.verdict = "fail" }
        case .uncheckable:
            r.verdict = "skipped"
            r.reason = "no-checkable-text"
            return (r, [Diagnostic(
                "no-checkable-text",
                "The catalog string @\(c.key) has no part long enough to match once its placeholders are removed; it was skipped.",
                hint: "check it with --present and the text the screen shows")])
        case .miss:
            if c.kind == "present" {
                r.verdict = "fail"
                let needle = String(longest(alts.first(where: { !$0.isEmpty }) ?? []))
                r.closest = closest(needle, lines: lines, locale: locale)
            }
        }
        return (r, [])
    }

    public static func inventory(
        _ entries: [CatalogCheck], windows: Windows, lines: [RecognizedLine], locale: String,
        unreadable: (CatalogCheck) -> Bool
    ) -> Inventory {
        var inv = Inventory()
        for c in entries.sorted(by: { $0.key < $1.key }) {
            if let reason = c.reason {
                inv.skipped.append(.init(key: c.key, reason: reason))
                continue
            }
            if unreadable(c) {
                inv.skipped.append(.init(key: c.key, reason: "unsupported-script"))
                continue
            }
            switch outcome(checkable(c, locale: locale), kind: "present", windows: windows) {
            case .hit(let w): inv.found.append(.init(key: c.key, line: w.line, box: Geometry.box(w.rect)))
            case .miss: inv.not_found.append(c.key)
            case .uncheckable: inv.skipped.append(.init(key: c.key, reason: "no-checkable-text"))
            }
        }
        return inv
    }
}
