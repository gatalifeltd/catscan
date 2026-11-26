// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import Foundation

/// Text normalization and matching shared by every command (spec 00, "Text matching").
public enum TextMatch {
    /// Locales whose text has no spaces between words.
    static let unspaced: Set<String> = ["ja", "ko", "zh", "yue", "th"]
    /// Locales that are not written in Latin script. Everything else counts as Latin.
    static let nonLatin: Set<String> = [
        "ja", "ko", "zh", "yue", "th", "ar", "ars", "he", "fa", "ur", "hi", "mr", "el",
        "ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn", "ka", "hy", "bn", "ta", "te",
        "gu", "kn", "ml", "pa", "si", "my", "km", "lo", "am",
    ]
    /// Locales written right to left: Vision returns logical order; only `read` row order changes.
    static let rightToLeft: Set<String> = ["ar", "ars", "he", "fa", "ur"]
    static let cyrillicFold: Set<String> = ["ru", "uk"]
    static let homoglyphs: [Unicode.Scalar: Unicode.Scalar] = [
        "а": "a", "в": "b", "о": "o", "е": "e", "р": "p", "с": "c", "х": "x",
    ]
    static let quotes: Set<Unicode.Scalar> = [
        "'", "\"", "`", "\u{00B4}", "\u{2018}", "\u{2019}", "\u{201A}", "\u{201B}", "\u{201C}", "\u{201D}",
        "\u{201E}", "\u{201F}", "\u{2032}", "\u{2033}", "\u{00AB}", "\u{00BB}", "\u{2039}", "\u{203A}",
    ]
    /// TODO-104 D1, D2: Vision reads a Ukrainian apostrophe as U+02BC, a modifier letter. Matching folds it with the
    /// quotes; text records keep it (`apostrophes: false`), so baseline tokens and digests stay those of algo 1.
    static let modifierApostrophe: Unicode.Scalar = "\u{02BC}"
    static let dashes: Set<Unicode.Scalar> = [
        "\u{2010}", "\u{2011}", "\u{2012}", "\u{2013}", "\u{2014}", "\u{2015}", "\u{2212}", "\u{FE58}", "\u{FE63}",
    ]

    /// Base language of a BCP 47 code: "pt-BR" -> "pt".
    public static func base(_ locale: String) -> String {
        locale.split(separator: "-").first.map { $0.lowercased() } ?? ""
    }

    public static func isUnspaced(_ locale: String) -> Bool { unspaced.contains(base(locale)) }

    public static func isRightToLeft(_ locale: String) -> Bool { rightToLeft.contains(base(locale)) }

    /// Invisible marks: bidi marks, embeddings and isolates, zero-width space, word joiner, BOM (spec 06 D40), and a
    /// soft hyphen, drawn only at a line break (TODO-099 D1).
    static let invisible: Set<Unicode.Scalar> = [
        "\u{00AD}", "\u{200B}", "\u{200E}", "\u{200F}", "\u{061C}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}",
        "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}", "\u{2060}", "\u{FEFF}",
    ]
    /// Disclosure glyphs dropped at the end (trailing) or start (leading) of a string, after NFKC (spec 06 D41, D48).
    static let trailingGlyphs: Set<Unicode.Scalar> = [
        ">", "\u{203A}", "\u{00BB}", "\u{3009}", "\u{232A}", "\u{27E9}", "\u{276F}", "\u{2192}", "\u{25B8}", "\u{25B6}",
    ]
    static let leadingGlyphs: Set<Unicode.Scalar> = [
        "<", "\u{2039}", "\u{00AB}", "\u{3008}", "\u{2329}", "\u{27E8}", "\u{276E}", "\u{2190}", "\u{25C2}", "\u{25C0}",
    ]

    /// Spec 06 D48 steps before spec 00's ellipsis removal: invisible marks gone, `⋯`/`‥` as "...", NFKC, lowercase,
    /// no space after `¿`/`¡`, disclosure glyphs and their whitespace dropped at the ends. Keeps the ellipsis, so the
    /// ellipsis rule and D4's comparison read the same text `normalize` starts from (D49).
    public static func fold(_ s: String) -> String {
        var pre = String.UnicodeScalarView()
        for u in s.unicodeScalars where !invisible.contains(u) {
            if u == "\u{22EF}" || u == "\u{2025}" { pre.append(contentsOf: "...".unicodeScalars) } else { pre.append(u) }
        }
        var t = Array(String(pre).precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars)
        // TODO-008: Vision on macOS 26 reads "¿ Olvidaste".
        var i = 0
        while i < t.count {
            if t[i] == "\u{00BF}" || t[i] == "\u{00A1}" {
                while i + 1 < t.count, t[i + 1].properties.isWhitespace { t.remove(at: i + 1) }
            }
            i += 1
        }
        // TODO-019: "Nutzungsbedingungen  >" is drawn and read as "Nutzungsbedingungen ›".
        while true {
            while let l = t.last, l.properties.isWhitespace { t.removeLast() }
            guard let l = t.last, trailingGlyphs.contains(l) else { break }
            t.removeLast()
        }
        while true {
            while let f = t.first, f.properties.isWhitespace { t.removeFirst() }
            guard let f = t.first, leadingGlyphs.contains(f) else { break }
            t.removeFirst()
        }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: t)
        return String(out)
    }

    public static func normalize(_ s: String, locale: String, apostrophes: Bool = true) -> String {
        let b = base(locale)
        // 0. Spec 06 D48 (fold). 1. NFKC, lowercase. 2. Ellipsis removed (NFKC turns "…" into "...").
        let t = fold(s).replacingOccurrences(of: "...", with: "")
        let fold = cyrillicFold.contains(b) || !nonLatin.contains(b)
        var out = String.UnicodeScalarView()
        for u in t.unicodeScalars {
            var c = u
            if quotes.contains(c) || (apostrophes && c == modifierApostrophe) { c = "'" }
            else if dashes.contains(c) { c = "-" }
            else if c == "_" { c = " " } // 4. "_" read as a space.
            if fold, let f = homoglyphs[c] { c = f } // 5. homoglyph fold.
            out.append(c)
        }
        // 3. Whitespace collapsed, or removed for ja, ko, zh and th.
        let words = String(out).split(whereSeparator: { $0.isWhitespace })
        return words.joined(separator: unspaced.contains(b) ? "" : " ")
    }

    /// A normalized check string this short matches only on word boundaries (spaced scripts).
    public static func isShort(_ normalized: String, locale: String) -> Bool {
        normalized.count < minLength(unspaced: isUnspaced(locale))
    }

    static func minLength(unspaced: Bool) -> Int { unspaced ? 2 : 4 }

    /// Whether `needle` occurs in `hay` (both normalized). Word boundaries apply when `wordBounded`.
    /// Compares whole grapheme clusters, so a match never splits a Devanagari conjunct, a nukta
    /// or a Thai mark from its base letter (spec 04 "Script rules").
    public static func contains(_ hay: String, _ needle: String, wordBounded: Bool) -> Bool {
        let h = Array(hay), n = Array(needle)
        if n.isEmpty || n.count > h.count { return false }
        for i in 0...(h.count - n.count) where h[i..<(i + n.count)].elementsEqual(n) {
            if !wordBounded { return true }
            let before = i == 0 ? nil : h[i - 1]
            let after = i + n.count == h.count ? nil : h[i + n.count]
            if !isWordChar(before) && !isWordChar(after) { return true }
        }
        return false
    }

    static func isWordChar(_ c: Character?) -> Bool {
        guard let c else { return false }
        return c.isLetter || c.isNumber
    }

    /// Levenshtein distance over characters.
    public static func editDistance(_ a: String, _ b: String) -> Int {
        let x = Array(a), y = Array(b)
        if x.isEmpty { return y.count }
        if y.isEmpty { return x.count }
        var prev = Array(0...y.count)
        var cur = [Int](repeating: 0, count: y.count + 1)
        for i in 1...x.count {
            cur[0] = i
            for j in 1...y.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
            }
            swap(&prev, &cur)
        }
        return prev[y.count]
    }
}
