// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The `truncated` request field (spec 06 D2): element boxes and catalog strings, parsed by the Node layer.
public struct TruncationJob {
    public struct Element: Equatable {
        public var id: String?
        public var rect: CGRect // normalized, origin top left
        public var text: String? // the displayed string only (D16)
        public var clips: Bool
        public var offscreen: Bool // the dump box extends past the screen (D19)
        public var graphic: Bool // TODO-046: a drawn non-text leaf (icon, image, control)
        public var panel: Bool // TODO-049 D2: an opaque surface drawn over what is not inside it
        public var scrolls: Bool // TODO-049 D2: inside a scroll container that can still scroll
        public var control: Bool // TODO-073 D7: a tappable element (button, switch, link, tab)
        public var enabled: Bool // TODO-054 D7: false for a disabled control (exempt from contrast)
        public var maxLines: Int? // TODO-074 D2: the element's declared line limit (`max_lines`, by hand or a game export)

        public init(id: String?, rect: CGRect, text: String? = nil, clips: Bool = true, offscreen: Bool = false, graphic: Bool = false,
                    panel: Bool = false, scrolls: Bool = false, control: Bool = false, enabled: Bool = true, maxLines: Int? = nil) {
            self.id = id
            self.rect = rect
            self.text = text
            self.clips = clips
            self.offscreen = offscreen
            self.graphic = graphic
            self.panel = panel
            self.scrolls = scrolls
            self.control = control
            self.enabled = enabled
            self.maxLines = maxLines
        }
    }

    public struct Boxes: Equatable {
        public var width: Double
        public var height: Double
        public var elements: [Element]

        public init(width: Double, height: Double, elements: [Element]) {
            self.width = width
            self.height = height
            self.elements = elements
        }
    }

    /// A catalog string for the prefix rule: its text as written and its fragments per alternative (spec 02).
    public struct Prefix {
        public var text: String
        public var alternatives: [[String]]

        public init(text: String, alternatives: [[String]]) {
            self.text = text
            self.alternatives = alternatives
        }
    }

    public var boxes: Boxes?
    public var prefixes: [Prefix] = []
    public var reasons: Set<String> = Set(Truncation.reasons)
    public var edgeDistance = 0.15
    public var allow: [String] = []
    /// TODO-039 T2: overflow's text matching folds pseudo text (markers, accents) on both sides.
    public var pseudo = false

    public init() {}
}

/// Spec 06 "Rule": ellipsis, prefix, edge and screen-edge findings on recognized lines; TODO-036 adds overflow.
public enum Truncation {
    /// D8: one finding per line, the first enabled reason in this order.
    public static let reasons = ["ellipsis", "prefix", "edge", "overflow", "screen-edge", "pseudo-cut"]

    /// The image size a boxes file may describe: aspect within 1% of the screenshot (D7).
    public static func mismatch(_ b: TruncationJob.Boxes, width: Int, height: Int) -> Diagnostic? {
        guard b.width > 0, b.height > 0, width > 0, height > 0 else { return nil }
        let shot = Double(width) / Double(height), boxes = b.width / b.height
        let diff = abs(boxes - shot) / shot
        if diff <= 0.01 { return nil }
        return Diagnostic(
            "boxes-mismatch",
            "the screenshot is \(width)x\(height) but its boxes are for \(Int(b.width))x\(Int(b.height)) (aspect differs by \(Int((diff * 100).rounded()))%)",
            hint: "convert the dump taken with this screenshot again")
    }

    /// TODO-036 D17: overflow's gate is measured on Vision only; an input Tesseract read says so when the rule ran.
    public static func unmeasuredOnFallback(_ job: TruncationJob) -> Diagnostic? {
        guard job.boxes != nil, job.reasons.contains("overflow") else { return nil }
        return Diagnostic(
            "rule-unmeasured-reader", "overflow is measured on Vision only; Tesseract read this image, so its overflow findings are unmeasured",
            hint: "--reasons \(reasons.filter { $0 != "overflow" && $0 != "pseudo-cut" }.joined(separator: ",")) to skip it")
    }

    /// The D48 fold, whitespace collapsed; the ellipsis kept (D4 compares lines that end in one).
    static func canon(_ s: String) -> String {
        TextMatch.fold(s).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// D61, D66: a letter or digit after the fold; dots ("... →" page dots) or a chevron read as "<" or "^" are not text.
    static func hasWord(_ s: String) -> Bool { TextMatch.fold(s).contains(where: { $0.isLetter || $0.isNumber }) }

    static func hasEllipsis(_ s: String, rtl: Bool) -> Bool {
        // The fold turns "…", "⋯" and "‥" into "..." and drops a trailing chevron (D42, D49).
        let t = TextMatch.fold(s)
        guard hasWord(s) else { return false }
        return t.hasSuffix("...") || (rtl && t.hasPrefix("..."))
    }

    /// D69, D70: the D48 fold without spaces, punctuation and diacritics, so a "(", a dropped space or a misread
    /// "İ" or "Ö" does not break a match.
    static func key(_ s: String) -> String {
        // TODO-104 D4: U+02BC is a modifier letter, not punctuation; drop it as `’` is dropped.
        String(joiners(TextMatch.fold(s)).folding(options: .diacriticInsensitive, locale: nil)
            .filter { !$0.isWhitespace && !$0.isPunctuation && $0 != Character(TextMatch.modifierApostrophe) })
    }

    /// D65: Vision drops a lone number set apart from a word ("SHIFT 6" reads "SHIFT").
    static func isNumber(_ rest: Substring) -> Bool {
        let t = rest.drop(while: { $0.isWhitespace })
        return t.first?.isNumber == true && t.allSatisfy { $0.isNumber || ".,:/%".contains($0) }
    }

    /// D67, D80: the line holds two or more on-screen elements with different text, each at least half inside it: a
    /// merged row. Nesting is not checked: a value or badge drawn inside its label's box is still a second view.
    static func merged(_ r: CGRect, _ elements: [TruncationJob.Element]) -> Bool {
        var texts = Set<String>()
        for e in elements where !e.offscreen {
            guard let t = e.text.map(key), !t.isEmpty else { continue }
            let x = r.intersection(e.rect)
            if !x.isNull && x.width * x.height >= 0.5 * e.rect.width * e.rect.height { texts.insert(t) }
        }
        return texts.count >= 2
    }

    /// D69: the line starts like a piece of the element's text: its first 3 characters (2 in unspaced scripts) occur
    /// there. A clip garbles the last glyph ("장바=" of "장바구니"), so the line's last character is never compared.
    /// D78: a line equal to the whole text has every character on screen, so its frame's edge cut nothing.
    static func belongs(_ line: String, to text: String, locale: String) -> Bool {
        let t = key(text), l = key(line)
        if !t.isEmpty && l == t { return false }
        let n = min(TextMatch.isUnspaced(locale) ? 2 : 3, l.count - 1)
        return t.isEmpty || n <= 0 || t.contains(String(l.prefix(n)))
    }

    /// D68: a clip hides glyphs past its edge; Vision's box overhangs a real clip by at most 0.19 line heights.
    static let overhang = 0.3

    /// TODO-036 D3: overflow needs the line at least this many line heights past its element; valid iOS text
    /// overhangs native frames by 0.42-0.63 (spec 06 D68). Fit on the synthetic set and frozen.
    static let overflowMin = 1.0

    /// TODO-036: an element as large as the screen is no container a line can overflow.
    static func wholeScreen(_ r: CGRect) -> Bool { r.minX <= 0.01 && r.minY <= 0.01 && r.maxX >= 0.99 && r.maxY >= 0.99 }

    /// TODO-036 D3: the smallest element holding 80% of the line's start (its first 3 characters, 2 in unspaced
    /// scripts, estimated by their share of the line's width), for a line no element holds at 80%.
    static func assignStart(
        _ l: RecognizedLine, _ elements: [TruncationJob.Element], rtl: Bool, locale: String, W: Double = 1, H: Double = 1
    ) -> Int? {
        let count = l.text.count
        guard count > 0 else { return nil }
        let w = l.rect.width * CGFloat(min(TextMatch.isUnspaced(locale) ? 2 : 3, count)) / CGFloat(count)
        let start = CGRect(x: rtl ? l.rect.maxX - w : l.rect.minX, y: l.rect.minY, width: w, height: l.rect.height)
        let candidates = elements.map { wholeScreen($0.rect) ? TruncationJob.Element(id: nil, rect: .null) : $0 }
        return assign(start, candidates) ?? assignCentered(l, candidates, W: W, H: H)
    }

    /// TODO-036 D22: centered text past both ends of its element has its start outside it, so with no element holding
    /// the start, the smallest element inside the line's span, centered on it within 1 line height and covering 80% of
    /// its height takes it.
    static func assignCentered(_ l: RecognizedLine, _ elements: [TruncationJob.Element], W: Double, H: Double) -> Int? {
        let r = l.rect
        var best: Int?
        for (i, e) in elements.enumerated() where !e.rect.isNull {
            // Pixels: the line height is vertical, the center offset horizontal.
            guard e.rect.minX >= r.minX, e.rect.maxX <= r.maxX,
                  Double(abs(e.rect.midX - r.midX)) * W <= Double(r.height) * H else { continue }
            let v = min(e.rect.maxY, r.maxY) - max(e.rect.minY, r.minY)
            if v < 0.8 * r.height { continue }
            if let b = best, elements[b].rect.width * elements[b].rect.height <= e.rect.width * e.rect.height { continue }
            best = i
        }
        return best
    }

    /// TODO-036 check 1: the line is its element's displayed text or a part of it, not cut by an ellipsis.
    /// TODO-039 T2: on a pseudo build Vision drops accents and markers, so both sides are folded first.
    static func ownText(_ l: RecognizedLine, _ e: TruncationJob.Element, rtl: Bool, pseudo: Bool = false, locale: String = "en") -> Bool {
        guard let text = e.text, hasWord(l.text), !hasEllipsis(l.text, rtl: rtl) else { return false }
        let side = { (s: String) in pseudo ? key(Pseudo.plain(s, locale: locale)) : key(s) }
        let k = side(l.text)
        return !k.isEmpty && side(text).contains(k)
    }

    /// TODO-044: a symbol Vision reads into the line (a bullet, chevron or status icon beside the label) widens its box;
    /// the part between such symbols, estimated by character share, is what overflows. A symbol the element's own text
    /// has at the same end ("9,99 €", "50 %"), compared after the `key` fold, is text, not a merged icon, and stays.
    static func wordSpan(_ l: RecognizedLine, rtl: Bool, text: String? = nil) -> CGRect {
        let c = Array(l.text)
        let word: (Character) -> Bool = { $0.isLetter || $0.isNumber }
        let t = Array(TextMatch.fold(text ?? ""))
        let first = t.firstIndex(where: word) ?? t.count, last = (t.lastIndex(where: word) ?? -1) + 1
        let head = Set(t[..<first].filter { !$0.isWhitespace }), tail = Set(t[last...].filter { !$0.isWhitespace })
        let keeps: (Character, Set<Character>) -> Bool = { ch, own in TextMatch.fold(String(ch)).first.map(own.contains) ?? false }
        var a = 0, b = c.count
        while a < b && !word(c[a]) && !keeps(c[a], head) { a += 1 }
        while b > a && !word(c[b - 1]) && !keeps(c[b - 1], tail) { b -= 1 }
        guard b > a else { return l.rect }
        let n = CGFloat(c.count), w = l.rect.width
        let x = l.rect.minX + w * CGFloat(rtl ? c.count - b : a) / n
        return CGRect(x: x, y: l.rect.minY, width: w * CGFloat(b - a) / n, height: l.rect.height)
    }

    /// TODO-044: the D3 and D22 chain over the elements whose text holds the line, so a textless or other-text
    /// container or icon never takes the line from its own element.
    static func assignOverflow(
        _ l: RecognizedLine, _ elements: [TruncationJob.Element], rtl: Bool, locale: String, W: Double, H: Double, pseudo: Bool = false
    ) -> Int? {
        // An offscreen element is never measured (`overflow`), so it must not take the line either (a paged carousel's
        // hidden "Weiter" would silence the visible one).
        let mine = elements.map { !$0.offscreen && ownText(l, $0, rtl: rtl, pseudo: pseudo, locale: locale) ? $0 : TruncationJob.Element(id: nil, rect: .null) }
        return assign(l.rect, mine).flatMap { wholeScreen(mine[$0].rect) ? nil : $0 }
            ?? assignStart(l, mine, rtl: rtl, locale: locale, W: W, H: H)
    }

    /// TODO-036 check 1: line heights the line runs past its element's trailing edge, or past either edge when both
    /// ends are past it (centered text). Nil unless the line is that element's own text, not cut by an ellipsis.
    static func overflow(
        _ l: RecognizedLine, _ e: TruncationJob.Element, W: Double, H: Double, rtl: Bool, pseudo: Bool = false, locale: String = "en"
    ) -> Double? {
        guard !e.offscreen, !wholeScreen(e.rect), ownText(l, e, rtl: rtl, pseudo: pseudo, locale: locale) else { return nil }
        let h = Double(l.rect.height) * H
        guard h > 0 else { return nil }
        let r = wordSpan(l, rtl: rtl, text: e.text)
        let right = Double(r.maxX - e.rect.maxX) * W / h, left = Double(e.rect.minX - r.minX) * W / h
        let (lead, trail) = rtl ? (right, left) : (left, right)
        // Centered: both ends past by more than Vision's box padding (D68), so an icon read into the line's start
        // (a "•" or "()" before a label) with a padded trailing end is not centered overflow (real set, 18 of 21 flags).
        let past = lead > overhang && trail > overhang ? max(lead, trail) : trail
        return past >= overflowMin ? past : nil
    }

    static let separators: Set<Character> = [",", "、", "，", "،"]

    /// D52, D62: the rest of the element text after the line is not missing from the screen. On a one-row element
    /// it starts at a label separator ("Mit E-Mail fortfahren" of "Mit E-Mail fortfahren, Taste"; ko and ja drop the
    /// space; a wrapped paragraph breaks at commas too, so it does not count there), or another recognized line starts
    /// with it (a wrapped message whose last row falls outside the element's frame).
    static func continues(_ p: String, of s: String, oneRow: Bool, elsewhere: [String], below: [String]) -> Bool {
        let rest = s.dropFirst(p.count).drop(while: { $0.isWhitespace })
        if oneRow, let c = rest.first, separators.contains(c) { return true }
        let body = key(String(rest)) // D70: "(konfigurowane" starts a row the probe must match without its "("
        // D79: a rest too short to probe ("not." of a wrapped joke) counts only when the row just below the element is
        // exactly that rest; anywhere on screen, a short word ("All") is too common.
        guard body.count >= 4 else { return !body.isEmpty && below.contains { key($0) == body } }
        let probe = String(body.prefix(8))
        return elsewhere.contains { key($0).hasPrefix(probe) }
    }

    /// TODO-095 D10, D11: for each line, the rows that continue it as the next row down (live rows only).
    static func nextRows(_ lines: [RecognizedLine], live: [Bool]) -> [[Int]] {
    lines.indices.map { j in
        let r = lines[j].rect
        let near = lines.indices.filter { k in
            let s = lines[k].rect
            return k != j && live[k] && s.minY > r.minY + 0.5 * r.height && s.minY <= r.maxY + 1.5 * r.height
                && s.minX < r.maxX && s.maxX > r.minX
        }
        // Only the next row down continues a line: a row with another one between it and the line above is a
        // separate label (review: "Account" + "settings" past "details" hid a cut of "Account recovery").
        return near.filter { k in
            let s = lines[k].rect
            return !near.contains { b in
                let t = lines[b].rect
                // A row starting half a line above `s` sits between, even when its box touches `s` (review).
                return t.minY < s.minY - 0.5 * min(t.height, s.height) && t.minX < s.maxX && t.maxX > s.minX
            }
        }
    }
    }

    /// TODO-095 D1, D3, D5, D7: the lines that are rows of a catalog string shown whole, on one row or wrapped onto the
    /// rows below. A row below starts more than half a line height under the current row's top, at most 1.5 line heights
    /// under its bottom, and overlaps it across; every such row is tried, at most 4 rows down. Rows are compared with
    /// `key(core(...))`, as the catalog text is (core folds look-alike letters, key drops case, diacritics, spaces and a
    /// hyphen at the break). A string with a placeholder after its first fragment (`open`) is reached by its fragment
    /// when the text goes on at a word boundary ("SCHICHT 6", not "SCHICHTB"); a fragment under 4 characters is too
    /// common to count that way. Such a value-reached match is `open`, keyed by the string's fragment: it clears a line
    /// only as a row of that same string, never as a cut of another one (review: `Delete {n}` must not hide a cut of
    /// `Delete account permanently`). `exact` rows spell a string, or a fragment with its value unread, exactly.
    static func wrappedRows(
        _ lines: [RecognizedLine], catalog: [(full: String, head: String, whole: Bool)], locale: String
    ) -> (exact: Set<Int>, open: [Int: Set<String>]) {
        let texts = lines.map { core($0.text, locale: locale) }
        let rows = texts.map { key($0) }
        var targets: [String: Bool] = [:] // key -> open
        for c in catalog {
            let t = key(c.head)
            if !t.isEmpty && (c.whole || t.count >= 4) { targets[t] = (targets[t] ?? false) || !c.whole }
        }
        let below = nextRows(lines, live: rows.map { !$0.isEmpty })
        // The keyed prefix of `text` equal to `t` ends where a non-letter (or the end) follows.
        func reaches(_ text: String, _ t: String) -> Bool {
            var acc = ""
            for i in text.indices {
                acc += key(String(text[i]))
                if acc == t { return !(text[text.index(after: i)...].first?.isLetter ?? false) }
                if acc.count > t.count || !t.hasPrefix(acc) { return false }
            }
            return false
        }
        var exact = Set<Int>(), openRows: [Int: Set<String>] = [:]
        // Every completing chain counts (review: the first one alone made the result depend on line order), and the
        // search is memoized on (row, characters already matched, depth): stacked repeated rows stay polynomial.
        for (t, open) in targets {
            let tc = Array(t)
            var memo: [Int: (exact: Bool, open: Bool)] = [:]
            // Does a chain that reaches row k with `prev` characters of t matched before it complete t?
            func solve(_ k: Int, _ prev: Int, _ depth: Int) -> (exact: Bool, open: Bool) {
                let id = (k * (tc.count + 1) + prev) * 5 + depth
                if let m = memo[id] { return m }
                let rest = String(tc[prev...]), row = rows[k]
                var r = (exact: row == rest, open: open && row.count > rest.count && row.hasPrefix(rest) && reaches(texts[k], rest))
                if row.count < rest.count && rest.hasPrefix(row) && depth < 4 {
                    for c in below[k] {
                        let s = solve(c, prev + row.count, depth + 1)
                        r.exact = r.exact || s.exact; r.open = r.open || s.open
                    }
                }
                memo[id] = r
                return r
            }
            var seen = Set<Int>()
            func mark(_ k: Int, _ prev: Int, _ depth: Int) {
                let id = (k * (tc.count + 1) + prev) * 5 + depth
                guard seen.insert(id).inserted else { return }
                let s = solve(k, prev, depth)
                if s.exact { exact.insert(k) }
                if s.open { openRows[k, default: []].insert(t) }
                let row = rows[k], rest = String(tc[prev...])
                guard row.count < rest.count && rest.hasPrefix(row) && depth < 4 else { return }
                for c in below[k] {
                    let cs = solve(c, prev + row.count, depth + 1)
                    if cs.exact || cs.open { mark(c, prev + row.count, depth + 1) }
                }
            }
            for j in lines.indices where !rows[j].isEmpty && (t.hasPrefix(rows[j]) || (open && rows[j].hasPrefix(t))) {
                let s = solve(j, 0, 0)
                if s.exact || s.open { mark(j, 0, 0) }
            }
        }
        return (exact, openRows)
    }

    /// TODO-099 item 2, D2-D6: rows walked down with `nextRows` that spell the start of a catalog string with
    /// placeholders, past its first fragment, and stop inside it with a visible cut: a mid-word end, or a lone misread
    /// symbol after a space where the string goes on with a word. Returns the chain's last row -> the string, and the
    /// other rows of the chains ending there. Unspaced locales are skipped: without spaces every end inside a word reads as mid-word.
    static func chainCuts(
        _ lines: [RecognizedLine], eligible: [Bool], prefixes: [TruncationJob.Prefix], locale: String
    ) -> (last: [Int: String], inner: [Int: Set<Int>]) {
        var last: [Int: String] = [:], inner: [Int: Set<Int>] = [:]
        guard !TextMatch.isUnspaced(locale) else { return (last, inner) }
        // D5: a lone non-letter, non-digit symbol after a space ends the raw row; `fold` drops only some of them.
        let lone = lines.map { l -> Bool in
            let t = Array(l.text.trimmingCharacters(in: .whitespaces))
            guard t.count >= 3, let c = t.last, t[t.count - 2].isWhitespace else { return false }
            return !c.isLetter && !c.isNumber
        }
        // `normalize`, not `core`: a row ending in "," or ";" keeps it, so "gamma," / "delta" still spells "gamma, delta".
        let texts = lines.indices.map { k in
            joiners(TextMatch.normalize(lone[k] ? String(lines[k].text.trimmingCharacters(in: .whitespaces).dropLast()) : lines[k].text,
                                        locale: locale))
        }
        let hyphen = texts.map { $0.hasSuffix("-") }
        // Review pass 2: a row keeps its trailing punctuation ("gamma," / "delta"), and is also tried without it, since
        // OCR adds a stray "." or ":" the string does not have. A hyphen is the D4 join's.
        let trim = CharacterSet.punctuationCharacters.union(.whitespaces)
        let rowForms = texts.map { t -> [String] in
            var s = t
            while let last = s.unicodeScalars.last, last != "-", trim.contains(last) { s.unicodeScalars.removeLast() }
            return s == t || s.isEmpty ? [t] : [t, s]
        }
        let next = nextRows(lines, live: lines.indices.map { eligible[$0] && !texts[$0].isEmpty })
        for p in prefixes {
            let full = core(p.text, locale: locale)
            for a in p.alternatives where a.count >= 2 {
                let frags = a.map { Array(core($0, locale: locale)) }
                guard let f0 = frags.first, !f0.isEmpty, full.hasPrefix(String(f0)) else { continue } // D2
                // Run 3: a chain starts with the first fragment, so a row that does not start with its first character
                // is skipped before any walk state is built.
                for j in lines.indices where eligible[j] && texts[j].first == f0.first {
                    // Review: overlapping repeated rows make the walk exponential; past this many steps from one start
                    // row it gives up, reporting nothing (it can only miss). Per start, so other rows keep theirs.
                    var budget = 400
                    var cuts: [[Int]] = [], whole = false
                    // D3: extend while a next row keeps matching, at most 8 rows; D4: a hyphen at the break both ways.
                    // Paths that reach one row with the same text end the same way: walk each such state once.
                    var visited = Set<String>()
                    func walk(_ chain: [Int], _ text: String) {
                        guard visited.insert("\(chain.last!)\u{1}\(text)").inserted else { return }
                        budget -= 1
                        if budget < 0 { whole = true; return }
                        let m = match(Array(text), frags)
                        if m.whole { whole = true }
                        guard m.open else { return }
                        var continued = false
                        if chain.count < 8 {
                            for k in next[chain.last!] where !chain.contains(k) {
                                let joins = rowForms[k].flatMap { row in
                                    hyphen[chain.last!]
                                        ? [String(text.dropLast()).trimmingCharacters(in: .whitespaces) + row, text + row]
                                        : [text + " " + row]
                                }
                                var on = false
                                for t in joins {
                                    let n = match(Array(t), frags)
                                    if n.open || n.whole { on = true; continued = true; walk(chain + [k], t) }
                                }
                                // Run 3 final review: a word broken with no hyphen goes on directly; tried only when no
                                // joined form goes on, so overlapping rows do not double the walk.
                                if !on, !hyphen[chain.last!] {
                                    for t in rowForms[k].map({ text + $0 }) {
                                        let n = match(Array(t), frags)
                                        if n.open || n.whole { continued = true; walk(chain + [k], t) }
                                    }
                                }
                            }
                        } else {
                            continued = true
                        }
                        if !continued, chain.count >= 2, let (i, at) = m.end, i >= 1, at > 0 {
                            let f = frags[i]
                            let mid = f[at - 1].isLetter && f[at].isLetter
                            let word = lone[chain.last!] && f[at] == " " && at + 1 < f.count && f[at + 1].isLetter
                            if mid || word { cuts.append(chain) }
                        }
                    }
                    for t in rowForms[j] { walk([j], t) }
                    if whole { continue }
                    for c in cuts {
                        last[c.last!] = last[c.last!] ?? p.text
                        inner[c.last!, default: []].formUnion(c.dropLast())
                    }
                }
            }
        }
        return (last, inner)
    }

    /// TODO-099 item 3, D9, D12: one row that joins catalog strings with a separator (`·`, `•`, `|`) and is cut inside
    /// the last one: every part before the last is a catalog string form, the last part is none, and it stops mid-word
    /// inside a form (4 characters or more; inside the first fragment, at most 85% of it). Returns that string.
    static func separatorCut(
        _ text: String, forms: [SeparatorForm], below: [Int], rows: [String], next: [[Int]], onScreen: [String], locale: String
    ) -> String? {
        guard !TextMatch.isUnspaced(locale) else { return nil }
        let parts = core(text, locale: locale).components(separatedBy: CharacterSet(charactersIn: "\u{00B7}\u{2022}\u{2219}\u{30FB}|"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count >= 2, let tail = parts.last, tail.count >= 4, !parts.contains(where: \.isEmpty) else { return nil }
        func isString(_ part: String) -> Bool {
            let c = Array(part)
            return forms.contains { f in
                // A form starting with a placeholder takes a value of 1 to 24 characters first ("5 songs").
                var starts = [0]
                if f.lead {
                    starts = []
                    var chars = 0
                    for q in c.indices where q > 0 {
                        if !c[q - 1].isWhitespace { chars += 1 }
                        if chars > 24 { break }
                        starts.append(q)
                    }
                }
                return starts.contains { q in
                    guard let rest = match(Array(c[q...]), f.frags).rest else { return false }
                    return rest == 0 || (f.trail && rest <= 26)
                }
            }
        }
        guard parts.dropLast().allSatisfy(isString), !isString(tail) else { return nil }
        let t = Array(tail)
        for f in forms where !f.lead {
            guard let (i, at) = match(t, f.frags).end, at > 0 else { continue }
            let frag = f.frags[i]
            guard frag[at - 1].isLetter, frag[at].isLetter, i > 0 || Double(at) <= 0.85 * Double(frag.count),
                  !onScreen.contains(where: { $0.contains(String(frag)) }) else { continue }
            // Final review: the last part may wrap onto the next row down (with a hyphen, or broken mid-word): a row
            // that goes on with the form shows it, so it is no cut. Run 3 review: a continuation that stops mid-word
            // again ("Playl" + "i") is still a cut, unless a row below it goes on in turn (up to 8 rows, as chains).
            // Run 3 final review: each (row, text) state once, and at most 200 states; past that it counts as shown
            // (it can only miss), so overlapping repeated rows cannot stall the scan.
            var seen = Set<String>(), steps = 200
            func goesOn(_ head: String, _ rs: [Int], _ depth: Int) -> Bool {
                rs.contains { r in
                    [head + rows[r], head + " " + rows[r], head + "-" + rows[r]].contains {
                        guard seen.insert("\(r)\u{1}\($0)").inserted else { return false }
                        steps -= 1
                        if steps < 0 { return true }
                        let m = match(Array($0), f.frags)
                        return m.whole || m.clean || (m.open && depth < 7 && goesOn($0, next[r], depth + 1))
                    }
                }
            }
            if goesOn(tail, below, 1) { continue }
            return f.text
        }
        return nil
    }

    /// TODO-099 D12: one form of a catalog string for item 3, read from the parsed fragments (plural forms, `{{count}}`
    /// and ICU arrive as the catalog parser reads them). A value may come before the first fragment or after the last
    /// only where a non-ICU form starts or ends with a placeholder, and a cut is found only in a form that starts with
    /// its first fragment (D2);
    /// an ICU form matches its fragments exactly (final review: `{n, plural, one {Song} ...}` matched "xSongx"). A
    /// placeholder form needs 4 letters of literal text (`{x}: {y}` matches anything).
    struct SeparatorForm { let text: String; let frags: [[Character]]; let lead: Bool; let trail: Bool }

    // No space flag and only conversion letters, so percent text ("3% off") is no placeholder (run 2 review).
    static let printf = #"%(\d+\$)?[-+0#]*\d*(\.\d+)?(ll|l|h|z|j)?[diouxXeEfFgGaAcs@]"#

    static func separatorForms(_ prefixes: [TruncationJob.Prefix], locale: String) -> [SeparatorForm] {
        var out: [SeparatorForm] = []
        for p in prefixes {
            let placeholder = p.text.range(of: #"\{|"# + printf, options: .regularExpression) != nil
            let icu = p.text.range(of: #",\s*(plural|select|selectordinal)\s*,"#, options: .regularExpression) != nil
            let texts = p.text.components(separatedBy: " | ")
            for (n, a) in p.alternatives.enumerated() {
                let frags = a.map { Array(core($0, locale: locale)) }.filter { !$0.isEmpty }
                guard !frags.isEmpty else { continue }
                if placeholder && frags.joined().filter(\.isLetter).count < 4 { continue }
                let form = (texts.count == p.alternatives.count ? texts[n] : p.text).trimmingCharacters(in: .whitespaces)
                // Run 2 review: a printf placeholder (`%s`, `%1$d`, `%@`) marks an edge as a brace does.
                let lead = !icu && form.range(of: #"^(\{|"# + printf + ")", options: .regularExpression) != nil
                let trail = !icu && form.range(of: #"(\}|"# + printf + ")$", options: .regularExpression) != nil
                out.append(SeparatorForm(text: p.text, frags: frags, lead: lead, trail: trail))
            }
        }
        return out
    }

    /// TODO-099: `text` against the fragments with a value of 1 to 24 characters (spaces aside) between them, from
    /// the string's start. `open`: `text` is a strict start of some reading; `end`: a fragment and the offset inside it
    /// where `text` stops (nil when it stops in a value or at a fragment's end); `whole`: `text` spells it all or more.
    /// `rest`: the fewest characters left after the last fragment, over the readings that spell it.
    /// `clean`: some reading ends at a word boundary or inside a value, read over every reading (run 3 review).
    static func match(_ c: [Character], _ frags: [[Character]]) -> (open: Bool, whole: Bool, end: (Int, Int)?, rest: Int?, clean: Bool) {
        var open = false, whole = false, end: (Int, Int)?, rest: Int?, clean = false
        // Review: memoized on (position, fragment), so repeated fragments stay polynomial.
        var seen = Set<Int>()
        func go(_ pos: Int, _ i: Int) {
            guard seen.insert(pos * frags.count + i).inserted else { return }
            let f = frags[i], n = min(f.count, c.count - pos)
            guard Array(c[pos..<pos + n]) == Array(f[0..<n]) else { return }
            if pos + n == c.count && n < f.count {
                open = true
                if end == nil { end = (i, n) }
                if !(f[n - 1].isLetter && f[n].isLetter) { clean = true }
                return
            }
            if i == frags.count - 1 { whole = true; rest = min(rest ?? .max, c.count - pos - n); return }
            if pos + n == c.count { open = true; clean = true; return }
            var q = pos + n, chars = 0
            while q < c.count {
                if !c[q].isWhitespace { chars += 1 }
                q += 1
                if chars > 24 { return }
                if chars >= 1 {
                    if q == c.count { open = true; clean = true } else { go(q, i + 1) }
                }
            }
        }
        if !c.isEmpty { go(0, 0) }
        return (open, whole, end, rest, clean)
    }

    /// TODO-099 D1: ZWNJ and ZWJ are not drawn as text; dropped only in this rule's match keys, since they shape
    /// Persian, Indic and emoji text that other commands compare.
    static func joiners(_ s: String) -> String {
        guard s.unicodeScalars.contains(where: { $0 == "\u{200C}" || $0 == "\u{200D}" }) else { return s }
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s.unicodeScalars.filter { $0 != "\u{200C}" && $0 != "\u{200D}" })
        return String(v)
    }

    /// Normalized text with trailing punctuation dropped: OCR loses a final "!" or "." (D5).
    static func core(_ s: String, locale: String) -> String {
        var t = joiners(TextMatch.normalize(s, locale: locale))
        while let last = t.unicodeScalars.last, CharacterSet.punctuationCharacters.union(.whitespaces).contains(last) {
            t.unicodeScalars.removeLast()
        }
        return t
    }

    static func strictPrefix(_ p: String, of s: String) -> Bool { !p.isEmpty && p.count < s.count && s.hasPrefix(p) }

    /// TODO-101 D2: the row's own trailing sentence marks (`text` normalized, `n` its `core`), spaces dropped. Only
    /// these count: hyphenation adds a dash, and Vision reads a chevron, bullet or icon into a row's end (ship review).
    static func trailingMarks(_ text: String, core n: String) -> String {
        String(String.UnicodeScalarView(joiners(text).unicodeScalars.dropFirst(n.unicodeScalars.count)))
            .filter { sentenceMarks.contains($0) }
    }

    static let sentenceMarks: Set<Character> = [
        ".", ",", ";", ":", "!", "?", ")", "]", "}", "\u{3002}", "\u{FF0C}", "\u{3001}", "\u{FF1B}", "\u{FF1A}", "\u{FF01}",
        "\u{FF1F}", "\u{FF09}", "\u{300D}", "\u{300F}", "\u{3011}", "\u{060C}", "\u{061B}", "\u{061F}", "\u{06D4}",
        "\u{0964}", "\u{0965}", "\u{0589}",
    ]

    /// TODO-101 D2: the row ends in punctuation `head` does not go on with there: it is other text, not a piece of
    /// `head` (OCR drops a final mark, it does not add one).
    static func ownPunctuation(_ text: String, core n: String, head: String) -> Bool {
        let tail = trailingMarks(text, core: n)
        // The marks `head` goes on with before its next word, compared the same way (`«Воинов»;` keeps `;`).
        let next = head.dropFirst(n.count).prefix { !$0.isLetter && !$0.isNumber }.filter { sentenceMarks.contains($0) }
        return !tail.isEmpty && !next.hasPrefix(tail)
    }

    /// TODO-101 D2: the row has no trailing punctuation and `head` goes on with a mark no line break can precede (`Enter`
    /// against `Enter: go`). An apostrophe, a middle dot and a `.` or `,` inside a token (`1.0`) are not such marks.
    static func labelEnd(_ text: String, core n: String, head: String) -> Bool {
        var rest = head.dropFirst(n.count)
        // French spacing puts a space before `:` `;` `!` `?` (ship review).
        if rest.first?.isWhitespace == true, let m = rest.dropFirst().first, ":;!?".contains(m) { rest = rest.dropFirst() }
        guard trailingMarks(text, core: n).isEmpty, let c = rest.first, let s = c.unicodeScalars.first, c.unicodeScalars.count == 1,
              [.closePunctuation, .finalPunctuation, .otherPunctuation].contains(s.properties.generalCategory),
              !"'\u{2019}\u{00B7}/\\&*#%@".contains(c) else { return false }
        if ".,".contains(c), let after = rest.dropFirst().first, after.isLetter || after.isNumber { return false }
        return true
    }

    /// Row count of lines: two lines share a row when they overlap vertically by half the smaller height.
    static func rows(_ rects: [CGRect]) -> Int {
        var anchors: [CGRect] = []
        for r in rects.sorted(by: { $0.minY < $1.minY }) {
            if let a = anchors.last, min(a.maxY, r.maxY) - max(a.minY, r.minY) >= 0.5 * min(a.height, r.height) { continue }
            anchors.append(r)
        }
        return anchors.count
    }

    /// The smallest element holding at least 80% of the line box.
    static func assign(_ r: CGRect, _ elements: [TruncationJob.Element]) -> Int? {
        let area = r.width * r.height
        guard area > 0 else { return nil }
        var best: Int?
        for (i, e) in elements.enumerated() {
            let x = r.intersection(e.rect)
            if x.isNull || x.width * x.height < 0.8 * area { continue }
            if let b = best, elements[b].rect.width * elements[b].rect.height <= e.rect.width * e.rect.height { continue }
            best = i
        }
        return best
    }

    /// D81: in box mode, a line the screen cuts: it reaches a screen edge, and it is a strict part of the `text` of an
    /// element on its row, missing text only where it meets the screen (the D82 anchor: a toast wider than the screen,
    /// cut at both ends, whose element is clamped to the screen and does not clip).
    /// Returns that element's text.
    static func screenCut(
        _ l: RecognizedLine, _ elements: [TruncationJob.Element], d: Double, W: Double, rtl: Bool, locale: String
    ) -> String? {
        guard hasWord(l.text) else { return nil }
        let left = Double(l.rect.minX) * W <= d, right = Double(1 - l.rect.maxX) * W <= d
        guard left || right else { return nil }
        let n = core(l.text, locale: locale)
        guard !TextMatch.isShort(n, locale: locale) else { return nil }
        let (lead, trail) = rtl ? (right, left) : (left, right)
        for e in elements {
            guard let t = e.text else { continue }
            let full = core(t, locale: locale)
            guard full.count > n.count, let r = full.range(of: n) else { continue }
            guard min(e.rect.maxY, l.rect.maxY) - max(e.rect.minY, l.rect.minY) >= 0.5 * l.rect.height else { continue }
            let head = r.lowerBound > full.startIndex, tail = r.upperBound < full.endIndex
            if (!head || lead) && (!tail || trail) { return t }
        }
        return nil
    }

    public static func evaluate(
        _ job: TruncationJob, lines: [RecognizedLine], width: Int, height: Int, locale: String
    ) -> [Finding] {
        let rtl = TextMatch.isRightToLeft(locale)
        let W = Double(width), H = Double(height)
        // TODO-046: a textless graphic (icon, image) never takes a line from its label.
        let elements = (job.boxes?.elements ?? []).filter { !($0.graphic && ($0.text ?? "").isEmpty) }
        let owner = lines.map { job.boxes == nil ? nil : assign($0.rect, elements) }
        var members: [Int: [Int]] = [:]
        for (i, o) in owner.enumerated() { if let o { members[o, default: []].append(i) } }
        let allow = Set(job.allow.map { TextMatch.normalize($0, locale: locale) })
        let onScreen = lines.map { TextMatch.normalize($0.text, locale: locale) }
        // Final review: containment checks compare with `core` text, which drops ZWNJ and ZWJ (D1).
        let onScreenKeys = onScreen.map { joiners($0) }
        // Catalog strings for the prefix rule: the first fragment of each alternative (placeholders cut the rest).
        // A string is whole when its one fragment is all of its text: spec 02 trims fragments and drops empty ones,
        // so "Willkommen, {name}" arrives as [["Willkommen,"]].
        var catalog: [(full: String, head: String, whole: Bool)] = []
        for p in job.prefixes {
            for a in p.alternatives where !a.isEmpty {
                let head = core(a[0], locale: locale)
                catalog.append((p.text, head, a.count == 1 && head == core(p.text, locale: locale)))
            }
        }
        let wholes = Set(catalog.filter(\.whole).map(\.head))
        let canonCatalog = Set(job.prefixes.map { canon($0.text) })
        let shownWhole = catalog.isEmpty ? (exact: [], open: [:]) : wrappedRows(lines, catalog: catalog, locale: locale)
        // TODO-099 D6: rows of a chain cut are reported once, on its last row; a row that spells a fragment exactly may still start a chain (review: `Hello` over `John, welc`).
        var separatorForms: [SeparatorForm]? // built once, on the first row with a separator
        let nextBelow = catalog.isEmpty ? [] : nextRows(lines, live: lines.map { !$0.text.isEmpty })
        lazy var coreRows = lines.map { core($0.text, locale: locale) } // run 3: once per screen, for separator rows
        let chains = catalog.isEmpty || !job.reasons.contains("prefix") ? (last: [:], inner: [:]) : chainCuts(
            lines, eligible: lines.indices.map { k in owner[k].map { elements[$0].text == nil } ?? true },
            prefixes: job.prefixes, locale: locale)
        // Run 2 review: a last row that is itself a catalog string, or a row of one shown whole, is no cut, and its
        // chain then hides none of its rows from the other rules.
        // Run 3 review: an allowed last row reports nothing, so its chain hides none of its rows either.
        let chainLast = chains.last.filter {
            !shownWhole.exact.contains($0.key) && !wholes.contains(core(lines[$0.key].text, locale: locale)) && !allow.contains(onScreen[$0.key])
        }
        let chainInner = chainLast.keys.reduce(into: Set<Int>()) { $0.formUnion(chains.inner[$1] ?? []) }.subtracting(chainLast.keys)

        var out: [Finding] = []
        for (i, l) in lines.enumerated() {
            if allow.contains(onScreen[i]) { continue }
            let e = owner[i].map { elements[$0] }
            var hits: [String: String?] = [:] // reason -> expected

            if hasEllipsis(l.text, rtl: rtl) {
                // D4: an intended ellipsis ("Share…") is the element's or a catalog string's own text.
                let c = canon(l.text)
                if !(e?.text.map { canon($0) == c } ?? false) && !canonCatalog.contains(c) { hits["ellipsis"] = .some(e?.text) }
            }

            let d = job.edgeDistance * Double(l.rect.height) * H
            // Trailing and leading gaps to the element in original pixels; a line past the edge has a negative trail.
            let lead = e.map { rtl ? Double($0.rect.maxX - l.rect.maxX) * W : Double(l.rect.minX - $0.rect.minX) * W }
            let trail = e.map { rtl ? Double(l.rect.minX - $0.rect.minX) * W : Double($0.rect.maxX - l.rect.maxX) * W }

            if let e, let text = e.text {
                // D5: the element's lines joined in reading order; reported on its last line.
                let mine = members[owner[i]!]!
                if mine.last == i {
                    let joined = core(mine.map { lines[$0].text }.joined(separator: " "), locale: locale)
                    let full = core(text, locale: locale)
                    // D63: a short line ("69%" of the label "69 percent off") is as weak as a short check string.
                    if strictPrefix(joined, of: full) && !TextMatch.isShort(joined, locale: locale) {
                        let others = lines.indices.filter { owner[$0] != owner[i] }
                        // D79: a row that starts within 1.5 line heights under the element and overlaps it across.
                        let below = others.filter {
                            let r = lines[$0].rect
                            return r.minY >= e.rect.minY && r.minY <= e.rect.maxY + 1.5 * l.rect.height
                                && r.minX < e.rect.maxX && r.maxX > e.rect.minX
                        }
                        let oneRow = rows(mine.map { lines[$0].rect }) == 1
                        // D65: on a one-row element, a lone number missing while the line ends short of the edge was
                        // drawn but not read.
                        let unread = oneRow && isNumber(full.dropFirst(joined.count)) && trail! > d
                        let cores = { (ix: [Int]) in ix.map { core(lines[$0].text, locale: locale) } }
                        if !unread && !continues(joined, of: full, oneRow: oneRow, elsewhere: cores(others), below: cores(below)) {
                            hits["prefix"] = .some(text)
                        }
                    }
                }
            } else if !catalog.isEmpty {
                let n = core(l.text, locale: locale)
                if n.count >= 4 && !wholes.contains(n) {
                    // TODO-101 D2, D3: per candidate, before the first is picked; an ellipsis or the screen's trailing
                    // edge is evidence of a cut whatever the row ends in.
                    // With --boxes, a textless container's trailing edge counts too (Codex, plan review).
                    let evidence = hasEllipsis(l.text, rtl: rtl)
                        || (rtl ? Double(l.rect.minX) * W : Double(1 - l.rect.maxX) * W) <= d
                        || trail.map { $0 <= d } ?? false
                    // D4: a row that ends where a catalog string goes on with a no-break mark is that string's label
                    // (`Enter` of `Enter: go`): a whole word, so no mid-word cut of another one (`Entertainers`); a
                    // string that goes on after a space still may be (`PANNENAUTO` of `Pannenauto gerammt`).
                    let label = !evidence && catalog.contains { strictPrefix(n, of: $0.head) && labelEnd(onScreen[i], core: n, head: $0.head) }
                    let found = catalog.filter { c in
                        strictPrefix(n, of: c.head) && Double(n.count) <= 0.85 * Double(c.head.count)
                            && !onScreenKeys.contains(where: { $0.contains(c.head) })
                            && (evidence || !ownPunctuation(onScreen[i], core: n, head: c.head))
                            && !(label && (labelEnd(onScreen[i], core: n, head: c.head)
                                || c.head.dropFirst(n.count).first.map { $0.isLetter || $0.isNumber } ?? true))
                    }
                    // TODO-095 D2, D7: a row of a catalog string shown whole is no cut of another one.
                    // D8: an open row clears only as a row of its own string; any string the line starts, so the
                    // 85% bound that picks reported candidates does not drop it (review).
                    let ownOpen = shownWhole.open[i].map { o in
                        catalog.contains { strictPrefix(n, of: $0.head) && o.contains(key($0.head)) }
                    } ?? false
                    if let c = found.first, !shownWhole.exact.contains(i), !ownOpen, !chainInner.contains(i) {
                        hits["prefix"] = .some(c.full)
                    }
                }
                if let c = chainLast[i] {
                    hits["prefix"] = .some(c)
                }
                if job.reasons.contains("prefix"), hits["prefix"] == nil, !chainInner.contains(i), !shownWhole.exact.contains(i),
                   TextMatch.normalize(l.text, locale: locale).contains(where: { "\u{00B7}\u{2022}\u{2219}\u{30FB}|".contains($0) }),
                   let c = separatorCut(l.text, forms: separatorForms ?? {
                       separatorForms = Truncation.separatorForms(job.prefixes, locale: locale); return separatorForms!
                   }(), below: nextBelow[i], rows: coreRows, next: nextBelow,
                   onScreen: onScreenKeys, locale: locale) {
                    hits["prefix"] = .some(c)
                }
            }

            if let e, let lead, let trail {
                // D3, D15, D19: a clipping, on-screen, single-row element whose line ends at its trailing edge only.
                // D66-D69: and the line is that element's own text: a word, not a merged row, not drawn past the edge,
                // and starting like the element's text.
                let h = Double(l.rect.height) * H
                if e.clips && !e.offscreen && rows(members[owner[i]!]!.map { lines[$0].rect }) == 1 && trail <= d && lead > d
                    && trail >= -overhang * h && hasWord(l.text) && !merged(l.rect, elements)
                    && e.text.map({ belongs(l.text, to: $0, locale: locale) }) ?? true {
                    hits["edge"] = .some(e.text)
                }
            } else {
                let trail = rtl ? Double(l.rect.minX) * W : Double(1 - l.rect.maxX) * W
                if trail <= d && hasWord(l.text) { hits["screen-edge"] = .some(nil) } // D66
            }
            // TODO-036 D3 and D22 over the elements whose text holds the line (TODO-044).
            var over: (e: TruncationJob.Element, by: Double)?
            if job.reasons.contains("overflow"), job.boxes != nil {
                let o = assignOverflow(l, elements, rtl: rtl, locale: locale, W: W, H: H, pseudo: job.pseudo)
                if let o, let by = overflow(l, elements[o], W: W, H: H, rtl: rtl, pseudo: job.pseudo, locale: locale) {
                    over = (elements[o], by)
                    hits["overflow"] = .some(elements[o].text)
                }
            }
            // D81 names the text even when D66 already flagged the unassigned line without it.
            if job.boxes != nil, let t = screenCut(l, elements, d: d, W: W, rtl: rtl, locale: locale) {
                hits["screen-edge"] = .some(t)
            }

            guard let reason = reasons.first(where: { job.reasons.contains($0) && hits[$0] != nil }) else { continue }
            // Vision's padded box can reach past the image at its edge; the schema keeps boxes in 0..1.
            let inside = l.rect.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
            guard !inside.isNull else { continue } // a box wholly outside the image has no place to report
            var f = Finding(kind: "truncated", box: Geometry.box(inside), line: l.text)
            f.reason = reason
            f.expected = hits[reason]!
            f.confidence = Geometry.round2(l.confidence)
            if let e { f.element = Finding.Element(id: e.id, box: Geometry.box(e.rect)) }
            if reason == "overflow", let over {
                f.element = Finding.Element(id: over.e.id, box: Geometry.box(over.e.rect))
                f.overflow = Geometry.round2(over.by)
            }
            out.append(f)
        }
        return out
    }
}
