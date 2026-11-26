// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The `overlap` request field (spec 12 D1; TODO-046 adds `boxes` and `allow`).
public struct OverlapJob: Equatable {
    /// Intersection area over the smaller box's area (D4); nil: the reader's default (TODO-046 D17).
    public var minOverlap: Double?
    /// TODO-046: element boxes (the `truncated` format); with them only the `elements` reader runs (D3).
    public var boxes: TruncationJob.Boxes?
    /// TODO-046 D10: element ids or texts whose findings are dropped.
    public var allow: [String]
    /// TODO-046 D3: the sidecar the CLI looked for and did not find ("-" for stdin); the image is then an error.
    public var noBoxes: String? = nil
    /// TODO-049 D6, D11: report text cut off by a panel (`--experimental` with boxes) until its gate passes.
    public var occlusion = false
    /// TODO-067 D3: also read the image without language correction and report stacked text (`signal: stacked`).
    public var stacked = false
    /// TODO-067 D17: run spec 12's OCR line-geometry reader on an image with no boxes; the CLI sends false when
    /// `stacked` runs by default without `--experimental`, so plain `overlap` runs `stacked` only.
    public var geometry = true
    public init(minOverlap: Double? = nil, boxes: TruncationJob.Boxes? = nil, allow: [String] = []) {
        self.minOverlap = minOverlap
        self.boxes = boxes
        self.allow = allow
    }
}

/// Spec 12: two recognized lines drawn over each other. The garbled-line signal was measured and dropped (D9, D21).
public enum Overlap {
    public static let defaultMinOverlap = 0.3 // D21: set on the dev half and the real screens
    /// Same-baseline pieces: vertical centers within this share of the line height (spec 12 rule 1).
    static let baselineShare = 0.25
    /// D2: pieces merge when their horizontal gap is in [minGap, maxGap] line heights; a deeper overlap is a pair.
    static let minGap = -0.1
    static let maxGap = 0.5
    struct Line {
        var text: String
        var rect: CGRect // pixels, origin top left
        var confidence: Double
        var source: CGRect // normalized, for output
    }

    /// D3, D12: an image with no boxes is an error unless the OCR-only reader was asked for by name.
    public static func noBoxes(_ looked: String, path: String?) -> Diagnostic {
        if looked == "-" {
            return Diagnostic(
                "overlap-no-boxes", "no boxes for - (stdin has no path to find a sidecar by); element overlap needs its boxes",
                hint: "pass the image as a file, or --boxes <file> for it, or add --experimental for the OCR-only check")
        }
        let p = path ?? "-"
        return Diagnostic(
            "overlap-no-boxes", "no boxes for \(p) (looked for \(looked)); element overlap needs its boxes",
            hint: "catscan boxes <source> <dump> --image \(p) > \(looked), or add --experimental for the OCR-only check")
    }

    public static func evaluate(_ job: OverlapJob, lines: [RecognizedLine], width: Int, height: Int, locale: String) -> [Finding] {
        if let b = job.boxes { return OverlapElements.evaluate(job, boxes: b, lines: lines, width: width, height: height, locale: locale) }
        let w = CGFloat(max(width, 1)), h = CGFloat(max(height, 1))
        // D3: a text read twice (an outline or shadow pass, a tile seam) is one line.
        let unique = Geometry.mergeTiles(lines, locale: locale)
        let px = merged(unique.map {
            Line(text: $0.text, rect: CGRect(x: $0.rect.minX * w, y: $0.rect.minY * h, width: $0.rect.width * w, height: $0.rect.height * h),
                 confidence: $0.confidence, source: $0.rect)
        })
        var findings: [(CGRect, Finding)] = []
        for i in px.indices {
            for j in px.indices where j > i {
                let a = px[i], b = px[j]
                let inter = a.rect.intersection(b.rect)
                if inter.isNull || inter.isEmpty { continue }
                let smaller = min(a.rect.width * a.rect.height, b.rect.width * b.rect.height)
                guard smaller > 0 else { continue }
                let share = Double(inter.width * inter.height / smaller)
                if share < job.minOverlap ?? defaultMinOverlap { continue }
                // Reading order inside the pair: the upper line first, then the left one.
                let (first, second) = (a.rect.minY, a.rect.minX) <= (b.rect.minY, b.rect.minX) ? (a, b) : (b, a)
                var f = Finding(kind: "overlap", box: Geometry.box(first.source.union(second.source)), line: "\(first.text) / \(second.text)")
                f.a = out(first)
                f.b = out(second)
                f.overlap = Geometry.round2(share)
                f.signal = "boxes"
                findings.append((first.source.union(second.source), f))
            }
        }
        // Findings in reading order of their boxes.
        return findings.sorted { ($0.0.minY, $0.0.minX) < ($1.0.minY, $1.0.minX) }.map { $0.1 }
    }

    static func out(_ l: Line) -> Finding.OverlapLine {
        Finding.OverlapLine(text: l.text, box: Geometry.box(l.source), confidence: Geometry.round2(l.confidence))
    }

    /// Joins the pieces of one visual line (rule 1, D2) until no two pieces qualify.
    static func merged(_ lines: [Line]) -> [Line] {
        var out = lines.sorted { ($0.rect.minX, $0.rect.minY) < ($1.rect.minX, $1.rect.minY) }
        var changed = true
        while changed {
            changed = false
            outer: for i in out.indices {
                for j in out.indices where j != i {
                    let l = out[i], r = out[j]
                    guard l.rect.minX <= r.rect.minX else { continue }
                    let lh = min(l.rect.height, r.rect.height)
                    guard lh > 0, abs(l.rect.midY - r.rect.midY) <= baselineShare * lh else { continue }
                    let gap = (r.rect.minX - l.rect.maxX) / lh
                    guard gap >= minGap && gap <= maxGap else { continue }
                    out[i] = Line(text: "\(l.text) \(r.text)", rect: l.rect.union(r.rect),
                                  confidence: min(l.confidence, r.confidence), source: l.source.union(r.source))
                    out.remove(at: j)
                    changed = true
                    break outer
                }
            }
        }
        return out
    }
}

/// TODO-046 "Rule": overlap from element boxes, confirmed by the ink Vision read in each element.
enum OverlapElements {
    /// D17: candidates from any element-box intersection of this share; ink decides (set on the synthetic dev half).
    static let defaultMinOverlap = 0.01
    /// D17: the ink intersection must be this many median line heights deep on both axes (set on the dev half).
    static let minDepth = 0.15
    /// D17: Vision's line box is the glyphs; the typographic box the rule compares (spec 12 D5) is this share of the line
    /// height taller on each side (set on the dev half).
    static let typoPad = 0.1
    /// D2: a box at least this share inside the other is nesting, not collision.
    static let contained = 0.9
    /// Step 3: a line is owned at this share inside an element, shared at this share inside each of a pair.
    static let owned = 0.5
    static let shared = 0.25
    /// D4: a line taller than this many median line heights is a merged stack.
    static let stack = 1.3
    /// D17: a line reads as a text when their folded letters differ by at most this share (OCR noise).
    static let reads = 0.8
    /// D17: a merged row reads as the two texts joined only this closely; a garbled junction is a collision.
    static let joined = 0.95

    struct Side {
        var element: TruncationJob.Element
        var graphic: Bool
        var ink: [CGRect] = []
        var confidence: Double? = nil
        /// D17: some of its ink is a read of only part of its text (the rest hidden or garbled).
        var partial = false
        var key: String { Truncation.key(element.text ?? "") }
    }

    /// TODO-072 D1, D11: two text elements one inside the other are two sheets drawn over each other, not a container and
    /// its content, when they hold one line height (within this share) and neither text holds the other. 0.8 let an
    /// undrawn segmented-control label (0.86 of its segments' height) through on the real negatives; stacked pages of
    /// one sheet share a text style (0.97 and up on the real positives).
    static let sheetHeight = 0.9

    /// TODO-072 (T0): pages of a sheet stacked at once are centred, same-size text boxes, so the D2 containment gate read
    /// them as nesting. A container's text holds its child's (an accessibility label over the label it reads), or the
    /// container is taller; stacked pages carry unrelated texts of one line height. The ink test still decides.
    static func stackable(_ a: Side, _ b: Side) -> Bool {
        guard !a.graphic, !b.graphic else { return false }
        let ka = a.key, kb = b.key
        guard !ka.isEmpty, !kb.isEmpty, !ka.contains(kb), !kb.contains(ka) else { return false }
        let ha = Double(a.element.rect.height), hb = Double(b.element.rect.height)
        return min(ha, hb) >= sheetHeight * max(ha, hb)
    }

    static func area(_ r: CGRect) -> Double { r.isNull || r.isEmpty ? 0 : Double(r.width * r.height) }

    static func inside(_ l: CGRect, _ e: CGRect) -> Double {
        let a = area(l)
        return a > 0 ? area(l.intersection(e)) / a : 0
    }

    /// 1 - Levenshtein distance over the longer length, on characters.
    static func similarity(_ a: String, _ b: String) -> Double {
        let x = Array(a), y = Array(b)
        if x.isEmpty || y.isEmpty { return x.isEmpty && y.isEmpty ? 1 : 0 }
        var prev = Array(0...y.count)
        for i in 1...x.count {
            var cur = [i] + [Int](repeating: 0, count: y.count)
            for j in 1...y.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1)) }
            prev = cur
        }
        return 1 - Double(prev[y.count]) / Double(max(x.count, y.count))
    }

    /// D4: the longest run of the element's text in the line (case folded per character), as a range of the line's
    /// text. Shorter than 3 characters (2 in unspaced scripts) or than half the shorter of the two texts is no run.
    static func run(_ text: String, in line: String, locale: String) -> Range<String.Index>? {
        let fold = { (c: Character) in String(c).lowercased() }
        let l = Array(line.indices), lc = line.map(fold), t = text.map(fold)
        guard !l.isEmpty, !t.isEmpty else { return nil }
        var best = 0, end = 0
        var prev = [Int](repeating: 0, count: t.count + 1)
        for i in 1...lc.count {
            var cur = [Int](repeating: 0, count: t.count + 1)
            for j in 1...t.count where lc[i - 1] == t[j - 1] {
                cur[j] = prev[j - 1] + 1
                if cur[j] > best { best = cur[j]; end = i }
            }
            prev = cur
        }
        let letters = { (s: [String]) in s.filter { !$0.allSatisfy(\.isWhitespace) }.count }
        let floor = TextMatch.isUnspaced(locale) ? 2 : 3
        guard best >= floor, Double(best) >= 0.5 * Double(min(letters(t), letters(lc))) else { return nil }
        let lo = l[end - best]
        let hi = end < l.count ? l[end] : line.endIndex
        return lo..<hi
    }

    /// The box of a run: Vision's range box, or the run's share of the line width when Vision gives none or gives the
    /// whole line for a part of it.
    static func runBox(_ l: RecognizedLine, _ r: Range<String.Index>) -> CGRect {
        let n = l.text.count, a = l.text.distance(from: l.text.startIndex, to: r.lowerBound), k = l.text.distance(from: r.lowerBound, to: r.upperBound)
        let share = CGRect(x: l.rect.minX + l.rect.width * CGFloat(a) / CGFloat(max(n, 1)), y: l.rect.minY,
                           width: l.rect.width * CGFloat(k) / CGFloat(max(n, 1)), height: l.rect.height)
        guard let v = l.rangeBox?(r), area(v) > 0 else { return share }
        if Double(k) < 0.8 * Double(n) && v.width >= 0.95 * l.rect.width { return share }
        return v
    }

    /// D17: the line reads as the text, or as a piece of it (one row of a wrapped paragraph): OCR noise allowed.
    static func readsAs(_ k: String, _ t: String) -> Bool {
        guard !k.isEmpty, !t.isEmpty else { return false }
        if similarity(k, t) >= reads { return true }
        guard k.count < t.count else { return false }
        // The longest common run of the line's letters within the text covers most of the line.
        let a = Array(k), b = Array(t)
        var best = 0, prev = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            var cur = [Int](repeating: 0, count: b.count + 1)
            for j in 1...b.count where a[i - 1] == b[j - 1] { cur[j] = prev[j - 1] + 1; best = max(best, cur[j]) }
            prev = cur
        }
        return Double(best) >= reads * Double(a.count)
    }

    /// Step 3 (D4, D17): what a line the pair shares adds to one text side's ink. A line that reads as this side's
    /// text is its ink; one that reads as the other side's or a third element's text is not; one that reads as the two
    /// texts joined (a merged row) adds this side's run; a garbled line (Vision merged the two into neither) or a
    /// merged stack (taller than 1.3 median lines) is ink of both sides.
    static func sharedInk(_ s: Side, other: Side, _ l: RecognizedLine, median: Double, locale: String, third: [String]) -> CGRect? {
        let k = Truncation.key(l.text)
        guard !k.isEmpty else { return nil }
        let tall = Double(l.rect.height) > stack * median
        if readsAs(k, s.key) { return own(l, s, locale: locale) }
        if other.graphic {
            if run(s.element.text ?? "", in: l.text, locale: locale) != nil { return own(l, s, locale: locale) }
            return tall ? l.rect : nil
        }
        // A clean read of the other side is a stack only when it spills past that side's own frame.
        if readsAs(k, other.key) { return tall && l.rect.height > 1.1 * other.element.rect.height ? l.rect : nil }
        if third.contains(where: { readsAs(k, $0) }) { return nil }
        if max(similarity(k, s.key + other.key), similarity(k, other.key + s.key)) >= joined {
            return run(s.element.text ?? "", in: l.text, locale: locale).map { runBox(l, $0) } ?? (tall ? l.rect : nil)
        }
        return l.rect
    }

    /// D17: the ink of the element's own text in a line: the box of its run (Vision's range box, so an icon Vision read
    /// as a character beside the label is not ink), extrapolated over the characters a graphic drawn over the label's
    /// end hid (the run is a strict start or end of the text and reaches the line's end). No run: the whole line.
    static func own(_ l: RecognizedLine, _ s: Side, locale: String) -> CGRect {
        guard let r = run(s.element.text ?? "", in: l.text, locale: locale) else { return l.rect }
        var box = runBox(l, r)
        let k = Truncation.key(String(l.text[r])), t = s.key
        guard k.count >= 2, k.count < t.count else { return box }
        let head = t.hasPrefix(k) && Truncation.key(String(l.text[r.upperBound...])).isEmpty
        let tail = t.hasSuffix(k) && Truncation.key(String(l.text[..<r.lowerBound])).isEmpty
        guard head != tail else { return box }
        let extra = box.width * CGFloat(t.count - k.count) / CGFloat(k.count)
        // The hidden part is after the read in reading order (head) or before it (tail).
        if head == TextMatch.isRightToLeft(locale) { box.origin.x -= extra }
        box.size.width += extra
        return box
    }

    /// Step 3 for one side of a pair: owned lines clipped to the element, plus what the lines the pair shares add.
    static func ink(_ s: inout Side, other: Side, lines: [RecognizedLine], median: Double, locale: String, third: [String]) {
        let e = s.element.rect
        for l in lines {
            // A line shares an element when it lies a quarter inside it, or covers half of it (a short word under a
            // long one Vision merged into one line).
            let inE = inside(l.rect, e), f = other.element.rect
            let inF = max(inside(l.rect, f), area(l.rect.intersection(f)) / max(area(f), 1e-12) >= 2 * shared ? shared : 0)
            var add: CGRect? = nil
            if inE >= shared && inF >= shared { add = sharedInk(s, other: other, l, median: median, locale: locale, third: third) }
            else if inE >= owned {
                // A line inside the frame that reads as another element's text is that element's ink.
                let k = Truncation.key(l.text)
                if !readsAs(k, s.key) && (third + (other.graphic ? [] : [other.key])).contains(where: { readsAs(k, $0) }) { continue }
                add = own(l, s, locale: locale).intersection(e)
            }
            guard let add, area(add) > 0 else { continue }
            let k = Truncation.key(l.text)
            if !k.isEmpty, k.count < s.key.count, s.key.contains(k) || similarity(k, s.key) < reads { s.partial = true }
            // The typographic box (spec 12 D5): Vision's box is the glyphs.
            let p = CGFloat(typoPad) * add.height
            s.ink.append(add.insetBy(dx: -p / 2, dy: -p))
            s.confidence = min(s.confidence ?? 1, l.confidence)
        }
    }

    static func evaluate(_ job: OverlapJob, boxes: TruncationJob.Boxes, lines: [RecognizedLine], width: Int, height: Int, locale: String) -> [Finding] {
        let W = CGFloat(max(width, 1)), H = CGFloat(max(height, 1))
        let heights = lines.map { Double($0.rect.height) }.sorted()
        let median = heights.isEmpty ? 0 : heights[heights.count / 2]
        let depth = minDepth * median * Double(H) // pixels
        let minOverlap = job.minOverlap ?? defaultMinOverlap
        let allowIds = Set(job.allow)
        let allowTexts = Set(job.allow.map { TextMatch.normalize($0, locale: locale) })
        // Step 1: graphics and text elements on screen; containers and unlabeled views never pair.
        let play: [Side] = boxes.elements.compactMap { e in
            if e.offscreen { return nil }
            if e.graphic { return Side(element: e, graphic: true) }
            guard let t = e.text, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return Side(element: e, graphic: false)
        }
        let texts = Array(Set(play.filter { !$0.graphic }.map(\.key).filter { !$0.isEmpty }))
        var out: [(CGRect, Finding)] = []
        for i in play.indices {
            for j in play.indices where j > i {
                var a = play[i], b = play[j]
                if a.graphic && b.graphic { continue }
                // Step 2: candidates by element-box share; containment, the same id and the same text are nesting.
                let inter = area(a.element.rect.intersection(b.element.rect))
                let smaller = min(area(a.element.rect), area(b.element.rect))
                guard smaller > 0, inter > 0 else { continue }
                let share = inter / smaller
                if share < minOverlap { continue }
                let sheets = share >= contained && stackable(a, b)
                if share >= contained && !sheets { continue }
                if let id = a.element.id, id == b.element.id { continue }
                if !a.graphic && !b.graphic,
                   TextMatch.normalize(a.element.text!, locale: locale) == TextMatch.normalize(b.element.text!, locale: locale) { continue }
                if allowIds.contains(a.element.id ?? "\u{0}") || allowIds.contains(b.element.id ?? "\u{0}")
                    || [a, b].contains(where: { !$0.graphic && allowTexts.contains(TextMatch.normalize($0.element.text!, locale: locale)) }) { continue }
                // Step 3 and 4: ink per text side, then an ink intersection deep enough on both axes (D17).
                let third = texts.filter { $0 != a.key && $0 != b.key }
                if !a.graphic { ink(&a, other: b, lines: lines, median: median, locale: locale, third: third) }
                if !b.graphic { ink(&b, other: a, lines: lines, median: median, locale: locale, third: third) }
                let inkOf = { (s: Side) in s.graphic ? [s.element.rect] : s.ink }
                let ia = inkOf(a), ib = inkOf(b)
                guard !ia.isEmpty, !ib.isEmpty else { continue }
                let deep = ia.contains { x in ib.contains { y in
                    let r = x.intersection(y)
                    return !r.isNull && Double(min(r.width * W, r.height * H)) >= depth
                } }
                // D17: a graphic drawn over part of a label leaves Vision a piece of it; the piece touching the graphic
                // is the collision.
                let hidden = (a.graphic && b.partial) || (b.graphic && a.partial)
                    ? ia.contains { x in ib.contains { y in let r = x.intersection(y); return !r.isNull && r.width > 0 && r.height > 0 } } : false // edge contact is not a collision
                if !deep && !hidden { continue }
                // Output: a text side first; two texts in reading order of their ink.
                let boxOf = { (s: Side) -> CGRect in inkOf(s).reduce(CGRect.null) { $0.union($1) } }
                var (first, second) = (a, b)
                if first.graphic || (!second.graphic && (boxOf(second).minY, boxOf(second).minX) < (boxOf(first).minY, boxOf(first).minX)) {
                    (first, second) = (second, first)
                }
                let unit = CGRect(x: 0, y: 0, width: 1, height: 1)
                let clip = { (r: CGRect) in r.intersection(unit) }
                let side = { (s: Side) -> Finding.OverlapLine in
                    Finding.OverlapLine(
                        text: s.graphic ? nil : s.element.text, box: Geometry.box(clip(boxOf(s))),
                        confidence: s.graphic ? nil : s.confidence.map(Geometry.round2),
                        element: Finding.Element(id: s.element.id, box: Geometry.box(s.element.rect)))
                }
                let name = { (s: Side) in s.graphic ? "[\(s.element.id ?? "graphic")]" : s.element.text! }
                let u = clip(boxOf(first).union(boxOf(second)))
                var f = Finding(kind: "overlap", box: Geometry.box(u), line: "\(name(first)) / \(name(second))")
                f.a = side(first)
                f.b = side(second)
                f.overlap = Geometry.round2(share)
                f.signal = sheets ? "sheets" : "elements"
                out.append((clip(boxOf(first)), f))
            }
        }
        if job.occlusion {
            out += occlusion(boxes, lines: lines, W: W, H: H, median: median, minOverlap: minOverlap, locale: locale,
                             allowIds: allowIds, allowTexts: allowTexts)
        }
        return out.sorted { ($0.0.minY, $0.0.minX) < ($1.0.minY, $1.0.minX) }.map { $0.1 }
    }

    /// TODO-049 D12 (set on the synthetic dev half): a read cut by a panel ends at its edge, Vision's box crossing it by
    /// 0 to `reach` median line heights; a text drawn over the panel, or a see-through panel, reads deeper.
    static let reach = 0.22
    /// A line at the edge is cut when it reads short of or garbled against the whole text (similarity under `whole`),
    /// is under `cut` median line heights tall (a footer's edge through its glyphs), or crosses the edge by `cross`.
    static let whole = 0.95
    static let cut = 0.85
    static let cross = 0.12

    /// TODO-049 rule: a text element crossing a panel's edge, read by Vision only up to that edge. The ink decides which
    /// side is on top (D2): a read deep inside the panel means the panel is see-through there or the text is drawn over
    /// it; no read at all is no finding (D3).
    static func occlusion(_ boxes: TruncationJob.Boxes, lines: [RecognizedLine], W: CGFloat, H: CGFloat, median: Double, minOverlap: Double,
                          locale: String, allowIds: Set<String>, allowTexts: Set<String>) -> [(CGRect, Finding)] {
        let live = boxes.elements.filter { !$0.offscreen }
        let panels = live.filter(\.panel)
        guard !panels.isEmpty, median > 0 else { return [] }
        let texts = live.filter {
            !$0.panel && !$0.graphic && !$0.scrolls && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let keys = Set(texts.map { Truncation.key($0.text!) })
        var out: [(CGRect, Finding)] = []
        for t in texts {
            let key = Truncation.key(t.text!)
            if allowIds.contains(t.id ?? "\u{0}") || allowTexts.contains(TextMatch.normalize(t.text!, locale: locale)) { continue }
            // Its lines: half inside its box, not a read of another element's text (a cut read may be garbled).
            let third = keys.subtracting([key])
            let seen = lines.filter { l in
                let k = Truncation.key(l.text)
                return !k.isEmpty && inside(l.rect, t.rect) >= owned && !(!readsAs(k, key) && third.contains { readsAs(k, $0) })
            }
            guard !seen.isEmpty else { continue } // D3: no ink, no finding
            for p in panels {
                let share = area(t.rect.intersection(p.rect)) / max(area(t.rect), 1e-12)
                guard share >= minOverlap, share < contained, inside(p.rect, t.rect) < contained else { continue }
                if let id = t.id, id == p.id { continue }
                if allowIds.contains(p.id ?? "\u{0}") { continue }
                // Each edge of P that T crosses: how far a line's box reaches past it, in median line heights; nil when
                // the line is beside P on the other axis (no glyph of it can be under P).
                let r = t.rect, q = p.rect, m = CGFloat(median), mx = m * H / max(W, 1)
                let besideX = { (l: CGRect) in l.maxX <= q.minX || l.minX >= q.maxX }, besideY = { (l: CGRect) in l.maxY <= q.minY || l.minY >= q.maxY }
                var past: [(CGRect) -> CGFloat?] = []
                if q.minY > r.minY && q.minY < r.maxY && q.maxY >= r.maxY { past.append { besideX($0) ? nil : ($0.maxY - q.minY) / m } }
                if q.maxY > r.minY && q.maxY < r.maxY && q.minY <= r.minY { past.append { besideX($0) ? nil : (q.maxY - $0.minY) / m } }
                if q.minX > r.minX && q.minX < r.maxX && q.maxX >= r.maxX { past.append { besideY($0) ? nil : ($0.maxX - q.minX) / mx } }
                if q.maxX > r.minX && q.maxX < r.maxX && q.minX <= r.minX { past.append { besideY($0) ? nil : (q.maxX - $0.minX) / mx } }
                let cutAtEdge = seen.contains { l in
                    past.contains { f in
                        guard let v = f(l.rect) else { return false }
                        let d = Double(v)
                        guard d >= 0, d <= reach else { return false }
                        return similarity(Truncation.key(l.text), key) < whole || Double(l.rect.height) < cut * median || d >= cross
                    }
                }
                guard cutAtEdge else { continue }
                let unit = CGRect(x: 0, y: 0, width: 1, height: 1)
                let ink = seen.map(\.rect).reduce(CGRect.null) { $0.union($1) }.intersection(unit)
                var f = Finding(kind: "occluded", box: Geometry.box(ink.union(r.intersection(q)).intersection(unit)), line: "\(t.text!) / [\(p.id ?? "panel")]")
                f.a = Finding.OverlapLine(text: t.text, box: Geometry.box(ink), confidence: nil, element: Finding.Element(id: t.id, box: Geometry.box(t.rect)))
                f.b = Finding.OverlapLine(text: nil, box: Geometry.box(q.intersection(unit)), confidence: nil, element: Finding.Element(id: p.id, box: Geometry.box(q)))
                f.overlap = Geometry.round2(share)
                f.signal = "elements"
                out.append((ink, f))
                break // one finding per text: the first panel that cuts it
            }
        }
        return out
    }
}
