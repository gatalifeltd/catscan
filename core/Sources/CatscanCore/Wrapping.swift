// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation
import NaturalLanguage

/// TODO-074: the `wrapped` and `orphan` reasons of `fit`, from element boxes. The Node layer pairs a target screen with
/// its base-locale screen and sends the base's row counts (`base`, D9), plus the catalog pairs (`pairs`, D3, D13).
public struct WrapJob {
    /// One element's rows on the base screenshot, keyed to the target element by `id` or by its target `text` (D3).
    public struct BaseRow: Equatable {
        public var id: String?
        public var text: String?
        public var rows: Int
        /// The base element's last row is one word and one token (the design accepts that orphan).
        public var orphan: Bool

        public init(id: String?, text: String?, rows: Int, orphan: Bool) {
            self.id = id
            self.text = text
            self.rows = rows
            self.orphan = orphan
        }
    }

    /// A catalog key's target and base strings (D13).
    public struct Pair: Equatable {
        public var key: String
        public var target: String
        public var base: String
        public var catalog: String? // the target file of this key (D18), when the run has several catalogs

        public init(key: String, target: String, base: String, catalog: String? = nil) {
            self.key = key
            self.target = target
            self.base = base
            self.catalog = catalog
        }
    }

    /// D20: the evidence types that passed their gate (or all, with --experimental).
    public var evidence: Set<String> = Set(Wrapping.evidence)
    /// D9: return every judged element's rows in the envelope's internal `element_rows`.
    public var elementRows = false
    public var basePath: String? = nil
    public var baseLocale = "en"
    /// nil: no base screenshot for this screen (base evidence skipped).
    public var base: [BaseRow]? = nil
    public var pairs: [Pair] = []
    public var catalog: String? = nil

    public init() {}
}

/// D9: one judged element's rows, returned for a base screenshot.
public struct ElementRows: Encodable, Equatable {
    public var id: String?
    public var text: String?
    public var rows: Int
    public var orphan: Bool

    enum K: String, CodingKey { case id, text, rows, orphan }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        try c.encode(text, forKey: .text)
        try c.encode(rows, forKey: .rows)
        try c.encode(orphan, forKey: .orphan)
    }
}

public enum Wrapping {
    public static let reasons = ["wrapped", "orphan"]
    /// Rule order: the first that applies is the finding's `evidence`.
    public static let evidence = ["declared", "base", "control"]

    /// "Rows of an element": one row of an element, its lines in reading order.
    struct Row {
        var lines: [RecognizedLine]
        var rect: CGRect
        var text: String
    }

    /// One element whose rows join to exactly its `text` (D4).
    struct Judged {
        var index: Int
        var rows: [Row]
    }

    static func letterOrDigit(_ s: String) -> Bool { s.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) } }

    /// Spec 00 normalization with spaces dropped: a break at a space or inside an unspaced script compares equal.
    static func squash(_ s: String, locale: String) -> String {
        TextMatch.normalize(s, locale: locale).filter { !$0.isWhitespace }
    }

    /// Lines grouped into rows: two lines are one row when they overlap vertically by half the smaller height. Rows
    /// with no letter or digit are dropped, except ja/zh/yue closing punctuation (the D6 kinsoku orphan); rows run top
    /// to bottom, lines in a row in reading order.
    static func rows(_ lines: [RecognizedLine], rtl: Bool, locale: String = "en") -> [Row] {
        var groups: [[RecognizedLine]] = []
        var rects: [CGRect] = []
        for l in lines.sorted(by: { $0.rect.minY < $1.rect.minY }) {
            if let k = rects.indices.first(where: { min(rects[$0].maxY, l.rect.maxY) - max(rects[$0].minY, l.rect.minY) >= 0.5 * min(rects[$0].height, l.rect.height) }) {
                groups[k].append(l)
                rects[k] = rects[k].union(l.rect)
            } else {
                groups.append([l])
                rects.append(l.rect)
            }
        }
        return zip(groups, rects).compactMap { g, r in
            let ordered = g.sorted { rtl ? $0.rect.maxX > $1.rect.maxX : $0.rect.minX < $1.rect.minX }
            let text = ordered.map(\.text).joined(separator: " ")
            return letterOrDigit(text) || closingOnly(text, locale: locale) ? Row(lines: ordered, rect: r, text: text) : nil
        }.sorted { $0.rect.minY < $1.rect.minY }
    }

    /// "Lines of an element" (TODO-044 D1) and "Own text only" (D4): the spec 06 owner over elements with text, and
    /// only elements whose rows join to their normalized `text`.
    static func judge(_ elements: [TruncationJob.Element], lines: [RecognizedLine], locale: String) -> [Judged] {
        let texted = elements.map { e -> TruncationJob.Element in
            (e.text ?? "").contains(where: { !$0.isWhitespace }) ? e : TruncationJob.Element(id: nil, rect: .null)
        }
        var owned: [Int: [RecognizedLine]] = [:]
        for l in lines where letterOrDigit(l.text) || closingOnly(l.text, locale: locale) {
            if let i = Truncation.assign(l.rect, texted) { owned[i, default: []].append(l) }
        }
        let rtl = TextMatch.isRightToLeft(locale)
        return owned.keys.sorted().compactMap { i in
            let rs = rows(owned[i]!, rtl: rtl, locale: locale)
            guard !rs.isEmpty, let t = elements[i].text else { return nil }
            let joined = squash(rs.map(\.text).joined(separator: " "), locale: locale)
            return !joined.isEmpty && joined == squash(t, locale: locale) ? Judged(index: i, rows: rs) : nil
        }
    }

    // MARK: orphan (D6)

    static let closing: Set<Character> = ["。", "、", "，", "．", "」", "』", "）", "】", "〕", "〉", "》", "！", "？", "：", "；", ")", "]"]

    static func closingOnly(_ s: String, locale: String) -> Bool {
        let ink = s.filter { !$0.isWhitespace }
        return cjk.contains(TextMatch.base(locale)) && !ink.isEmpty && ink.allSatisfy(closing.contains)
    }

    /// Word tokens of a row (NLTokenizer, unit word, language from the locale), punctuation and symbols dropped.
    static func words(_ s: String, locale: String) -> [String] {
        let t = NLTokenizer(unit: .word)
        t.string = s
        t.setLanguage(NLLanguage(TextMatch.base(locale) == "zh" && locale.lowercased().contains("hant") ? "zh-Hant" : TextMatch.base(locale) == "zh" ? "zh-Hans" : TextMatch.base(locale)))
        var out: [String] = []
        t.enumerateTokens(in: s.startIndex..<s.endIndex) { r, _ in
            let w = String(s[r])
            if letterOrDigit(w) { out.append(w) }
            return true
        }
        return out
    }

    /// A row that is one number, price or time alone ("3", "9,99 €", "12:30", "1/3"): no letter in it.
    static func numeric(_ s: String) -> Bool { !s.contains { $0.isLetter } }

    static let cjk: Set<String> = ["ja", "zh", "yue"]

    /// The last row's orphan word, or nil. `width` applies the one-third bound (not to a closing-punctuation row).
    static func orphanWord(_ rs: [Row], locale: String) -> String? {
        guard rs.count >= 2, let last = rs.last else { return nil }
        let text = last.text.trimmingCharacters(in: .whitespaces)
        let ink = text.filter { !$0.isWhitespace }
        // Unspaced extra: a row of closing punctuation alone is an orphan whatever its width (a kinsoku break).
        if closingOnly(text, locale: locale) { return text }
        guard letterOrDigit(text), !numeric(text) else { return nil }
        let widest = rs.map(\.rect.width).max() ?? 0
        guard widest > 0, last.rect.width <= widest / 3 else { return nil }
        if cjk.contains(TextMatch.base(locale)), ink.count <= 2 { return text }
        return words(text, locale: locale).count == 1 ? text : nil
    }

    /// The last row is one word and one token, whatever its width: the base design accepts such a last row.
    static func oneWordLast(_ rs: [Row], locale: String) -> Bool {
        guard rs.count >= 2, let last = rs.last else { return false }
        return words(last.text, locale: locale).count == 1
    }

    // MARK: wrapped (D1-D5, D12)

    /// D5: a short base string, which a translation should not wrap.
    static func short(_ s: String, locale: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if TextMatch.isUnspaced(locale) { return t.count <= 12 }
        return t.split(whereSeparator: { $0.isWhitespace }).count <= 4 && t.count <= 32
    }

    static func median(_ xs: [Double]) -> Double {
        let s = xs.sorted()
        guard !s.isEmpty else { return 0 }
        return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
    }

    static func inside(_ a: CGRect, _ b: CGRect, _ share: CGFloat = 0.9) -> Bool {
        let x = a.intersection(b)
        return !x.isNull && a.width * a.height > 0 && x.width * x.height >= share * a.width * a.height
    }

    /// D12: a control's only label: the element is a control, or lies 90% inside one; that control is at most 4
    /// median line heights tall (the element's own lines) and holds no other text element.
    static func controlLabel(_ i: Int, _ elements: [TruncationJob.Element], lineHeight: Double, locale: String) -> Bool {
        let e = elements[i]
        let cands = elements.indices.filter { j in elements[j].control && (j == i || inside(e.rect, elements[j].rect)) }
        return cands.contains { j in
            let c = elements[j]
            guard Double(c.rect.height) <= 4 * lineHeight else { return false }
            return !elements.indices.contains { k in
                k != i && k != j && (elements[k].text ?? "").contains(where: { !$0.isWhitespace }) && inside(elements[k].rect, c.rect)
                    // A wrapper of the same label (a button around its own text) is not another text.
                    && !(squash(elements[k].text ?? "", locale: locale) == squash(e.text ?? "", locale: locale) && inside(e.rect, elements[k].rect))
            }
        }
    }

    /// D3: the base element of a target element: the same non-null id, else the catalog key of its text.
    static func base(_ e: TruncationJob.Element, _ job: WrapJob, locale: String) -> (WrapJob.BaseRow, String?)? {
        guard let base = job.base else { return nil }
        if let id = e.id, let b = base.first(where: { $0.id == id }) { return (b, nil) }
        guard let t = e.text, !job.pairs.isEmpty else { return nil }
        let nt = squash(t, locale: locale)
        // D13: a string that is the value of more than one key pairs by none of them, on either side.
        let keys = Set(job.pairs.filter { squash($0.target, locale: locale) == nt }.map(\.key))
        guard keys.count == 1, let p = job.pairs.first(where: { $0.key == keys.first! }) else { return nil }
        let nb = squash(p.base, locale: job.baseLocale)
        guard Set(job.pairs.filter { squash($0.base, locale: job.baseLocale) == nb }.map(\.key)).count == 1 else { return nil }
        let hits = base.filter { b in b.text.map { squash($0, locale: job.baseLocale) == nb } ?? false }
        guard hits.count == 1 else { return nil }
        return (hits[0], p.key)
    }

    public struct Outcome {
        public var findings: [Finding] = []
        public var elementRows: [ElementRows] = []
    }

    public static func evaluate(_ job: FitJob, lines: [RecognizedLine], locale: String) -> Outcome {
        var out = Outcome()
        let w = job.wrap
        let want = { (r: String) in job.reasons.contains(r) }
        guard let elements = job.boxes?.elements, want("wrapped") || want("orphan") || w.elementRows else { return out }
        let judged = judge(elements, lines: lines, locale: locale)
        if w.elementRows {
            out.elementRows = judged.map { j in
                ElementRows(id: elements[j.index].id, text: elements[j.index].text, rows: j.rows.count, orphan: oneWordLast(j.rows, locale: locale))
            }
        }
        let allowed = { (e: TruncationJob.Element) in
            (e.id.map(job.allow.contains) ?? false) || (e.text.map { t in job.allow.contains { TextMatch.normalize($0, locale: locale) == TextMatch.normalize(t, locale: locale) } } ?? false)
        }
        for j in judged {
            let e = elements[j.index]
            guard j.rows.count >= 2, !e.offscreen, !allowed(e) else { continue }
            let rect = j.rows.map(\.rect).reduce(CGRect.null) { $0.union($1) }
            let conf = j.rows.flatMap(\.lines).map(\.confidence).min() ?? 0
            func finding(_ reason: String) -> Finding {
                var f = Finding(kind: "fit", box: Geometry.box(rect), line: j.rows.map(\.text).joined(separator: " / "))
                f.reason = reason
                f.element = Finding.Element(id: e.id, box: Geometry.box(e.rect))
                f.rows = j.rows.count
                f.confidence = Geometry.round2(conf)
                return f
            }
            let paired = base(e, w, locale: locale)
            if want("wrapped") {
                var ev: String? = nil
                var f = finding("wrapped")
                if e.maxLines == 1 {
                    ev = "declared"
                } else if let (b, key) = paired {
                    // The design wraps (2+ base rows), or a long base string may wrap by design (D5).
                    if b.rows == 1, let bt = b.text, short(bt, locale: w.baseLocale) {
                        ev = "base"
                        f.baseRows = 1
                        f.basePath = w.basePath
                        if let key { f.key = key; f.catalog = w.pairs.first { $0.key == key }?.catalog ?? w.catalog }
                    }
                } else if controlLabel(j.index, elements, lineHeight: median(j.rows.flatMap(\.lines).map { Double($0.rect.height) }), locale: locale) {
                    ev = "control"
                }
                if let ev, w.evidence.contains(ev) {
                    f.evidence = ev
                    out.findings.append(f)
                }
            }
            if want("orphan"), j.rows.count <= 3, let word = orphanWord(j.rows, locale: locale) {
                if let (b, _) = paired, b.orphan { continue }
                var f = finding("orphan")
                f.orphan = word
                out.findings.append(f)
            }
        }
        return out
    }
}
