// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CryptoKit
import Foundation

/// What a `serve` request asks for in `text_record` (TODO-038 T1): the mode and the `--baseline-ignore` patterns.
public struct TextRecordJob {
    public var mode: String // full | digest
    public var ignore: [NSRegularExpression] = []
    public var ignoreDigest: String? = nil // sha256 of the ignore file, recorded so a comparison can see a different one

    public init(mode: String, ignore: [NSRegularExpression] = [], ignoreDigest: String? = nil) {
        self.mode = mode
        self.ignore = ignore
        self.ignoreDigest = ignoreDigest
    }
}

/// The text record of an envelope (TODO-038 T1): normalized lines, the sorted comparison tokens and their digest.
/// Equality is the R7 rule measured in T0 (D1): lines joined, clocks masked, punctuation dropped, diacritics folded.
public struct TextRecord: Encodable, Equatable {
    public static let algo = 1
    public var tokens: [String]?
    public var lines: [String]?
    public var digest: String
    public var ignore: String?

    enum K: String, CodingKey { case algo, tokens, lines, digest, ignore }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(TextRecord.algo, forKey: .algo)
        try c.encodeIfPresent(tokens, forKey: .tokens)
        if tokens != nil { try c.encode(lines, forKey: .lines) }
        try c.encode(digest, forKey: .digest)
        try c.encode(ignore, forKey: .ignore)
    }

    // Python's `\b\d{1,2}:\d{2}(\s?[ap]m)?\b` of the T0 script, so the gate measures the same mask.
    static let clock = try! NSRegularExpression(pattern: #"\b\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?\b"#)

    static func replace(_ re: NSRegularExpression, in s: String) -> String {
        re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "#")
    }

    /// Latin, Greek and Cyrillic letters: the scripts whose diacritic jitter T0 measured (D2).
    static func foldsMarks(_ u: Unicode.Scalar) -> Bool {
        switch u.value {
        case 0x41...0x24F, 0x1E00...0x1EFF, 0x2C60...0x2C7F, 0xA720...0xA7FF, 0x370...0x3FF, 0x1F00...0x1FFF, 0x400...0x52F: return true
        default: return false
        }
    }

    /// Diacritics folded: canonical decomposition, then a combining mark (nonzero combining class, Python's
    /// `unicodedata.combining` as T0 measured) dropped only after a Latin, Greek or Cyrillic letter; kana voicing
    /// marks, Thai tone marks and Indic virama and nukta change the word, so they stay (review fix), recomposed.
    static func foldMarks(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        var base: Unicode.Scalar? = nil
        for u in s.decomposedStringWithCanonicalMapping.unicodeScalars {
            if u.properties.canonicalCombiningClass.rawValue == 0 { base = u } else if let b = base, foldsMarks(b) { continue }
            out.append(u)
        }
        return String(out).precomposedStringWithCanonicalMapping
    }

    static func isWord(_ u: Unicode.Scalar) -> Bool {
        if u == "#" { return true }
        switch u.properties.generalCategory {
        case .currencySymbol: return true // a $ to € swap is a localization bug, not reading jitter (review fix)
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber, .nonspacingMark, .spacingMark, .enclosingMark:
            return true
        default:
            return false
        }
    }

    /// The normalized lines: `TextMatch.normalize`, clocks masked, then each ignore pattern match replaced by `#`.
    public static func lines(_ raw: [String], locale: String, ignore: [NSRegularExpression] = []) -> [String] {
        raw.compactMap { r in
            var t = replace(clock, in: TextMatch.normalize(r, locale: locale, apostrophes: false))
            for re in ignore { t = replace(re, in: t) }
            return t.isEmpty ? nil : t
        }
    }

    /// The comparison tokens, sorted by scalar values. Spaced scripts: the words of all lines joined; ja, ko, zh,
    /// yue and th: one token per line, since no word split exists.
    public static func tokens(_ lines: [String], locale: String) -> [String] {
        func words(_ s: String) -> [String] {
            var out: [String] = [], cur = String.UnicodeScalarView()
            for u in foldMarks(s).unicodeScalars {
                if isWord(u) { cur.append(u) } else if !cur.isEmpty { out.append(String(cur)); cur = String.UnicodeScalarView() }
            }
            if !cur.isEmpty { out.append(String(cur)) }
            return out
        }
        let t: [String] = TextMatch.isUnspaced(locale)
            ? lines.map { words($0).joined() }.filter { !$0.isEmpty }
            : words(lines.joined(separator: " "))
        // Only masked text (a clock, or an ignore pattern that matched everything) is no text: it needs review.
        if t.allSatisfy({ $0.allSatisfy { $0 == "#" } }) { return [] }
        return t.sorted { $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars) }
    }

    public static func digest(_ tokens: [String]) -> String {
        "sha256:" + SHA256.hash(data: Data(tokens.joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func make(_ raw: [String], locale: String, job: TextRecordJob) -> TextRecord {
        let l = lines(raw, locale: locale, ignore: job.ignore)
        let t = tokens(l, locale: locale)
        let full = job.mode == "full"
        return TextRecord(tokens: full ? t : nil, lines: full ? l : nil, digest: digest(t), ignore: job.ignoreDigest)
    }
}
