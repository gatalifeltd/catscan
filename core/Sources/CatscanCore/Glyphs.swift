// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// TODO-036 check 3 (T5): expected text per element (`boxes`) or catalog strings (`expected`); `lines` copies the
/// recognized lines into the envelope, so the bench can judge eligibility without a second Vision read.
public struct GlyphsJob {
    public struct Expected: Equatable {
        public var key: String?
        public var text: String
        public init(key: String?, text: String) { self.key = key; self.text = text }
    }
    public var boxes: TruncationJob.Boxes? = nil
    public var expected: [Expected] = []
    public var lines = false
    public init() {}
}

/// `missing-glyphs`: Vision never reads a tofu box as a box (T0 spike), so a missing glyph shows only as expected
/// text that comes back with runs dropped or read as digit and box-like shapes. A run counts only when the rest of
/// the line proves the font covers what was read and not what is missing (TODO-036 check 3).
public enum Glyphs {
    /// What Vision reads a tofu box as (T0: `1`, `11`, `3`, `OO0D`, `666`; T5a: `ΠΗΠΠ`, `口`): digits, punctuation,
    /// symbols and these closed or upright letter shapes of each recognition script.
    static let boxLetters: Set<String> = [
        "o", "d", "q", "i", "l", "u", "c", "π", "η", "ο", "δ", "о", "п", "н", "д", "ם", "ס", "ח", "口", "囗", "日", "田", "ロ", "ㅁ",
    ]
    /// Vision swaps these upright strokes freely (`Plus` read as `PIus`); they match one another.
    static let strokes: Set<String> = ["i", "l", "1", "|"]
    static func same(_ a: Char, _ b: Char) -> Bool { a.key == b.key || strokes.contains(a.key) && strokes.contains(b.key) }
    /// Typographic punctuation a Latin UI font may lack. The ellipsis is left out: a missing one is truncation's.
    static let typographic: Set<Unicode.Scalar> = [
        "\u{201C}", "\u{201D}", "\u{201E}", "\u{201F}", "\u{2018}", "\u{2019}", "\u{201A}", "\u{201B}", "\u{00AB}", "\u{00BB}",
        "\u{2039}", "\u{203A}", "\u{2013}", "\u{2014}", "\u{2015}", "\u{2032}", "\u{2033}", "\u{2022}", "\u{00B7}",
    ]
    /// Line confidence below which nothing is compared (TODO-036 check 3).
    static let minConfidence = 0.3

    struct Char { let c: Character; let key: String }

    /// One aligned character of the expected text: matched to the read text or missing.
    struct Alignment {
        var matched: [Bool]
        /// Read characters inserted before expected index i (index count: after the last).
        var inserted: [Int: [Character]]
    }

    static func key(_ c: Character) -> String {
        var out = String.UnicodeScalarView()
        for u in String(c).precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars {
            out.append(TextMatch.homoglyphs[u] ?? u)
        }
        return String(out)
    }

    /// Characters OCR never reports (emoji, icons, private-use glyphs) and whitespace leave the comparison.
    static func visible(_ s: String) -> [Char] {
        s.precomposedStringWithCanonicalMapping.compactMap { c -> Char? in
            if c.isWhitespace { return nil }
            guard let u = c.unicodeScalars.first else { return nil }
            switch u.properties.generalCategory {
            case .otherSymbol, .privateUse, .format, .control, .nonspacingMark, .enclosingMark: return nil
            default: break
            }
            if u.properties.isEmojiPresentation { return nil }
            return Char(c: c, key: key(c))
        }
    }

    static func boxLike(_ c: Char) -> Bool {
        c.c.isNumber || c.c.isPunctuation || c.c.isSymbol || boxLetters.contains(c.key)
    }

    /// The alignment with the most matched expected characters in which every unmatched read character is box-like;
    /// nil when no such alignment exists (the read text holds something the expected text does not).
    static func align(_ e: [Char], _ l: [Char]) -> Alignment? {
        let n = e.count, m = l.count
        let neg = Int.min / 4
        var dp = Array(repeating: Array(repeating: neg, count: m + 1), count: n + 1)
        dp[n][m] = 0
        for j in stride(from: m - 1, through: 0, by: -1) { dp[n][j] = boxLike(l[j]) && dp[n][j + 1] != neg ? 0 : neg }
        for i in stride(from: n - 1, through: 0, by: -1) {
            dp[i][m] = 0
            for j in stride(from: m - 1, through: 0, by: -1) {
                var best = dp[i + 1][j]
                if boxLike(l[j]), dp[i][j + 1] > best { best = dp[i][j + 1] }
                if same(e[i], l[j]), dp[i + 1][j + 1] != neg, dp[i + 1][j + 1] + 1 > best { best = dp[i + 1][j + 1] + 1 }
                dp[i][j] = best
            }
        }
        guard dp[0][0] != neg else { return nil }
        var a = Alignment(matched: Array(repeating: false, count: n), inserted: [:])
        var i = 0, j = 0
        while i < n || j < m {
            if i < n, j < m, same(e[i], l[j]), dp[i + 1][j + 1] != neg, dp[i][j] == dp[i + 1][j + 1] + 1 {
                a.matched[i] = true; i += 1; j += 1
            } else if i < n, dp[i][j] == dp[i + 1][j] {
                i += 1
            } else {
                a.inserted[i, default: []].append(l[j].c); j += 1
            }
        }
        return a
    }

    enum LatinBlock { case basic, supplement, extA, extB, additional, other }
    static func latinBlock(_ c: Character) -> LatinBlock {
        guard let v = c.unicodeScalars.first?.value else { return .other }
        switch v {
        case 0...0x7F: return .basic
        case 0x80...0xFF: return .supplement
        case 0x100...0x17F: return .extA
        case 0x180...0x24F: return .extB
        case 0x1E00...0x1EFF: return .additional
        default: return .other
        }
    }
    static func script(_ c: Character) -> Scripts.Script? { c.unicodeScalars.first.flatMap { Scripts.script(of: $0) } }
    /// `ö` -> `o`: the base letter of a precomposed letter with marks; nil when it has none.
    static func baseLetter(_ c: Character) -> String? {
        let d = String(c).decomposedStringWithCanonicalMapping.unicodeScalars
        guard d.count > 1, let f = d.first else { return nil }
        return key(Character(f))
    }

    /// A run of missing expected characters, with what was read in its place.
    struct Run { var range: Range<Int>; var read: [Character] }

    static func runs(_ a: Alignment, count n: Int) -> [Run]? {
        // Read characters where nothing is missing (between two matched ones, or before the first or after the
        // last matched one): extra text, not tofu.
        for p in a.inserted.keys where !((p < n && !a.matched[p]) || (p > 0 && !a.matched[p - 1])) { return nil }
        var out: [Run] = []
        var i = 0
        while i < n {
            if a.matched[i] { i += 1; continue }
            var k = i
            while k < n, !a.matched[k] { k += 1 }
            out.append(Run(range: i..<k, read: (i...k).flatMap { a.inserted[$0] ?? [] }))
            i = k
        }
        return out
    }

    /// What a candidate yields: the missing characters (as written), or nil when the rule does not fire.
    struct Verdict { var chars: [String]; var trailing: Bool; var missingScripts: Set<Scripts.Script>; var whole = false }

    /// The rule on one expected text and its read text (TODO-036 check 3). `fragment`: catalog evidence, where every
    /// intact part must be at least 4 characters (2 in unspaced scripts).
    static func judge(expected: String, read: String, locale: String, fragment: Bool, guardScripts: Bool = true) -> Verdict? {
        if let v = judgeOrder(expected: expected, read: read, locale: locale, fragment: fragment, guardScripts: guardScripts) { return v }
        // A mixed right-to-left line comes back in visual order (T5a: `Plus: السعر` read as `DDDDPIus:`).
        guard TextMatch.isRightToLeft(locale), expected.contains(" ") else { return nil }
        let flipped = expected.split(separator: " ").reversed().joined(separator: " ")
        return judgeOrder(expected: flipped, read: read, locale: locale, fragment: fragment, guardScripts: guardScripts)
    }

    static func judgeOrder(expected: String, read: String, locale: String, fragment: Bool, guardScripts: Bool) -> Verdict? {
        let e = visible(expected), l = visible(read)
        guard !e.isEmpty, !l.isEmpty, let a = align(e, l), let rs = runs(a, count: e.count), !rs.isEmpty else { return nil }
        let matched = e.indices.filter { a.matched[$0] }.map { e[$0].c }
        // A box-shaped letter matched (Cyrillic `о` to a box read as `O`) proves nothing about the font.
        let proof = e.indices.filter { a.matched[$0] && !boxLetters.contains(e[$0].key) }.map { e[$0].c }
        let provenScripts = Set(proof.compactMap(script))
        let provenBlocks = Set(proof.filter { script($0) == .latin }.map(latinBlock))
        let readable = Scripts.readable(locale)
        if fragment {
            let min = TextMatch.isUnspaced(locale) ? 2 : 4
            // Located by an intact fragment: one matched stretch of at least 4 characters (2 unspaced).
            var i = 0, longest = 0
            while i < e.count {
                guard a.matched[i] else { i += 1; continue }
                var k = i
                while k < e.count, a.matched[k] { k += 1 }
                longest = max(longest, k - i)
                i = k
            }
            if longest < min { return nil }
        }
        var chars: [String] = []
        var missingScripts = Set<Scripts.Script>()
        for r in rs {
            var letters = 0
            let readKeys = Set(r.read.map(key))
            for i in r.range {
                let c = e[i].c
                if c.isLetter {
                    guard let s = script(c) else { return nil }
                    if guardScripts, !readable.contains(s) { return nil } // Vision cannot read it on this screen
                    // `ö` read as `o`: an OCR misread. A longer run read as box shapes may hold a base letter by chance (`ή` -> `ΠΗΠΠ`).
                    if r.range.count == 1, let b = baseLetter(c), readKeys.contains(b) { return nil }
                    let eligible: Bool
                    if matched.isEmpty {
                        eligible = s != .latin // a whole line in a script the font lacks
                    } else if s != .latin {
                        eligible = !provenScripts.contains(s)
                    } else {
                        let blk = latinBlock(c)
                        eligible = blk != .basic && (baseLetter(c) != nil || !provenBlocks.contains(blk))
                    }
                    guard eligible else { return nil }
                    letters += 1
                    missingScripts.insert(s)
                    chars.append(String(c))
                } else if c.isCurrencySymbol || c.unicodeScalars.count == 1 && typographic.contains(c.unicodeScalars.first!) {
                    chars.append(String(c))
                } else if c.isPunctuation, c.isASCII {
                    continue // `:` or `.` lost with the run it touches
                } else {
                    return nil // a digit or a letter the font proves: an OCR drop, not tofu
                }
            }
            // A sign or a quote alone is never evidence: Vision reads clean `₹` as `{` or `7` and `₪` as `D` (T5a).
            if letters == 0 { return nil }
        }
        if matched.isEmpty && l.contains(where: { !boxLike($0) }) { return nil }
        return Verdict(chars: chars, trailing: rs.last.map { $0.range.upperBound == e.count } ?? false, missingScripts: missingScripts, whole: matched.isEmpty)
    }

    public static func evaluate(_ job: GlyphsJob, lines: [RecognizedLine], width: Int, height: Int, locale: String, guardScripts: Bool = true) -> [Finding] {
        let W = Double(width), H = Double(height)
        let rtl = TextMatch.isRightToLeft(locale)
        let usable = lines.indices.filter { lines[$0].confidence >= minConfidence }
        var findings: [(Int, Finding)] = []
        var taken = Set<Int>()
        let joiner = TextMatch.isUnspaced(locale) ? "" : " "
        if let b = job.boxes, !b.elements.isEmpty {
            var byElement: [Int: [Int]] = [:]
            for i in lines.indices {
                if let k = Truncation.assign(lines[i].rect, b.elements) { byElement[k, default: []].append(i) }
            }
            for (k, idx) in byElement.sorted(by: { $0.key < $1.key }) {
                let el = b.elements[k]
                taken.formUnion(idx)
                guard let text = el.text, !el.offscreen, !Truncation.wholeScreen(el.rect) else { continue }
                let ok = idx.filter { usable.contains($0) }
                guard !ok.isEmpty, ok.count == idx.count else { continue }
                let read = ok.map { lines[$0].text }.joined(separator: joiner)
                if Truncation.hasEllipsis(read, rtl: rtl) { continue }
                guard let v = judge(expected: text, read: read, locale: locale, fragment: false, guardScripts: guardScripts) else { continue }
                let rect = ok.map { lines[$0].rect }.reduce(lines[ok[0]].rect) { $0.union($1) }
                if v.trailing, !v.whole { // nothing of a whole tofu line was read, so nothing was cut
                    // D13: a dropped end is truncation's unless its script is absent from the read part and the
                    // line ends over 1 line height short of its element's trailing edge.
                    let readScripts = Set(Scripts.scripts(in: read))
                    if !v.missingScripts.isEmpty, !v.missingScripts.isDisjoint(with: readScripts) { continue }
                    if v.missingScripts.isEmpty { continue }
                    let gap = rtl ? (rect.minX - el.rect.minX) * W : (el.rect.maxX - rect.maxX) * W
                    let lh = ok.map { lines[$0].rect.height * H }.max() ?? 0
                    if gap <= lh { continue }
                }
                var f = Finding(kind: "missing-glyphs", box: Geometry.box(rect), line: read)
                f.expected = text
                f.chars = v.chars
                f.element = Finding.Element(id: el.id, box: Geometry.box(el.rect))
                findings.append((ok.min()!, f))
            }
        }
        if !job.expected.isEmpty {
            let normal = Set(job.expected.map { TextMatch.normalize($0.text, locale: locale) })
            for i in usable where !taken.contains(i) {
                let l = lines[i]
                if normal.contains(TextMatch.normalize(l.text, locale: locale)) { continue } // the line is a catalog string
                if Truncation.hasEllipsis(l.text, rtl: rtl) { continue }
                let lv = visible(l.text)
                guard lv.count >= (TextMatch.isUnspaced(locale) ? 2 : 4) else { continue }
                let lkeys = lv.filter { !boxLike($0) }.map(\.key)
                var best: (Int, GlyphsJob.Expected, Verdict)? = nil
                for x in job.expected {
                    let ev = visible(x.text)
                    guard ev.count > lkeys.count, subsequence(lkeys, of: ev.map(\.key)) else { continue }
                    guard let v = judge(expected: x.text, read: l.text, locale: locale, fragment: true, guardScripts: guardScripts) else { continue }
                    if v.trailing, v.missingScripts.isEmpty || !v.missingScripts.isDisjoint(with: Set(Scripts.scripts(in: l.text))) { continue }
                    let score = ev.count - v.chars.count
                    if best == nil || score > best!.0 { best = (score, x, v) }
                }
                guard let (_, x, v) = best else { continue }
                // A line on the same row holds missing letters: split by Vision, not lost.
                let row = { (o: CGRect) in min(o.maxY, l.rect.maxY) - max(o.minY, l.rect.minY) > 0.5 * min(o.height, l.rect.height) }
                if lines.indices.contains(where: { $0 != i && row(lines[$0].rect) && v.chars.contains(where: lines[$0].text.contains) }) { continue }
                var f = Finding(kind: "missing-glyphs", box: Geometry.box(l.rect), line: l.text)
                f.expected = x.text
                f.key = x.key
                f.chars = v.chars
                findings.append((i, f))
            }
        }
        return findings.sorted { $0.0 < $1.0 }.map(\.1)
    }

    static func subsequence(_ a: [String], of b: [String]) -> Bool {
        var j = 0
        for x in b where j < a.count && x == a[j] { j += 1 }
        return j == a.count
    }
}
