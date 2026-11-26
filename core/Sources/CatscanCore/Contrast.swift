// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The `contrast` request field (TODO-054 T1/T2): `{level?, scale?, scale_source?, kinds?, allow?, boxes?}`.
/// The Node layer resolves the scale chain (flag, sidecar, iOS size table, none: D6) and says which source won.
public struct ContrastJob {
    public var level = "AA" // AA | AAA (D10)
    public var scale = 1.0
    public var scaleSource = "none" // flag | boxes | size-table | page | none
    public var kinds: Set<String> = Contrast.kinds
    public var allow: [String] = []
    public var boxes: TruncationJob.Boxes? = nil

    public init() {}
}

/// Per-line contrast in the `contrast` envelope's `lines` (TODO-054 "Outputs", D25).
public struct LineContrast: Encodable, Equatable {
    public var skipped: String? = nil // too-small | no-ink | not-text | allow | disabled | covered
    public var ratio: Double? = nil
    public var threshold: Double? = nil
    public var size: String? = nil // normal | large | uncertain
    public var busy = false
    public var edges: Double? = nil
    public var ink: String? = nil
    public var background: String? = nil
    public var uncertain = false // D17: the split separated poorly or the ink is two colours; never a finding

    enum K: String, CodingKey { case skipped, ratio, threshold, size, busy, edges, ink, background, uncertain }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        if let skipped {
            try c.encode(skipped, forKey: .skipped)
            return
        }
        try c.encode(ratio, forKey: .ratio)
        try c.encode(threshold, forKey: .threshold)
        try c.encode(size, forKey: .size)
        try c.encode(busy, forKey: .busy)
        try c.encode(edges, forKey: .edges)
        try c.encode(ink, forKey: .ink)
        try c.encode(background, forKey: .background)
        if uncertain { try c.encode(true, forKey: .uncertain) }
    }
}

public enum Contrast {
    public static let kinds: Set<String> = ["low-contrast", "busy-background"]
    public static let levels = ["AA", "AAA"]

    // Tuned on the dev half of the synthetic set only (TODO-054 D21; bench/contrast.js, results/contrast.json).
    /// D2: a line fails below threshold / margin, so boundary noise is not a finding.
    static let margin = 1.02
    /// Spec "Text size": Vision box height / font px, median 0.95, p10 0.81 (probe, 1,649 lines).
    static let heightMedian = 0.95
    static let heightLow = 0.81
    static let largeRegular = 24.0 // WCAG 18 pt in CSS px; platform pt/dp treated as CSS px (WCAG2ICT)
    static let largeBold = 18.67 // WCAG 14 pt bold
    /// D17: a split whose between-class share of the variance is under this floor separates poorly.
    static let separationFloor = 0.55
    /// D17: an ink class that splits again into two groups this far apart (sqrt-L) and this large is two colours.
    static let bimodalGap = 0.25
    static let bimodalShare = 0.2
    static let bimodalSeparation = 0.8
    /// D17: a second ink inside the background class: at least half its pixels within 0.03 of its median, 0.15 from bg.
    static let secondSpread = 0.03
    static let secondCompact = 0.5
    static let secondGap = 0.15
    /// D19: neighbour step in sqrt(L) that counts as an edge, and the busy thresholds per pixel set.
    static let edgeStep = 0.06
    static let busyInside = 0.04
    static let busyRing = 0.02
    static let minInk = 8

    // MARK: WCAG

    static let lin8: [Double] = (0..<256).map { i in
        let c = Double(i) / 255
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    public static func luminance(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> Double {
        0.2126 * lin8[Int(r)] + 0.7152 * lin8[Int(g)] + 0.0722 * lin8[Int(b)]
    }

    public static func ratio(_ a: Double, _ b: Double) -> Double { (max(a, b) + 0.05) / (min(a, b) + 0.05) }

    public static func thresholds(level: String) -> (normal: Double, large: Double) {
        level == "AAA" ? (7, 4.5) : (4.5, 3)
    }

    /// D6: `normal` only if even the largest plausible size is under the bold large-text limit; `large` when the median
    /// estimate reaches the regular limit; otherwise `uncertain`, judged at the large threshold (doubt never applies 4.5:1).
    public static func sizeClass(heightPx: Double, scale: Double) -> String {
        let s = max(scale, 1)
        if heightPx / heightLow / s < largeBold { return "normal" }
        if heightPx / heightMedian / s >= largeRegular { return "large" }
        return "uncertain"
    }

    /// Not-text filter (spec "Real screens", D33): fewer than two letters or digits (page dots, chevrons, a lone glyph).
    /// The spec's confidence < 0.5 half failed D16 on real screens (it removed grey tab labels and game buttons that fail).
    static func notText(_ l: RecognizedLine) -> Bool {
        l.text.unicodeScalars.filter({ CharacterSet.alphanumerics.contains($0) }).count < 2
    }

    // MARK: pixels

    /// sRGB pixels of one region (D20: never a full-image plane). Core Graphics converts Display P3 and other spaces
    /// to sRGB in the draw, since WCAG luminance is defined in sRGB (spec "Ink and background", step 1).
    struct Region {
        let x0: Int, y0: Int, w: Int, h: Int // in image pixels, origin top left
        var px: [UInt8]
        var lum: [Double]
        var q: [Double] // sqrt(L): the perceptual space of the split

        init?(_ img: CGImage, x0: Int, y0: Int, x1: Int, y1: Int) {
            let w = x1 - x0, h = y1 - y0
            guard w > 0, h > 0, let crop = img.cropping(to: CGRect(x: x0, y: y0, width: w, height: h)),
                  let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
            var buf = [UInt8](repeating: 255, count: w * h * 4)
            let ok = buf.withUnsafeMutableBytes { p -> Bool in
                guard let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
                ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
                ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
                ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
                return true
            }
            guard ok else { return nil }
            self.x0 = x0; self.y0 = y0; self.w = w; self.h = h
            px = buf
            lum = (0..<(w * h)).map { i in Contrast.luminance(buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]) }
            q = lum.map { $0.squareRoot() }
        }

        func at(_ x: Int, _ y: Int) -> Int { (y - y0) * w + (x - x0) }
        func hex(_ i: Int) -> String { String(format: "#%02X%02X%02X", px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) }
    }

    /// Otsu over values in 0...1: the threshold and the between-class share of the total variance (0...1).
    static func otsu(_ v: [Double]) -> (t: Double, eta: Double) {
        var hist = [Double](repeating: 0, count: 256)
        for x in v { hist[min(255, max(0, Int(x * 255.999)))] += 1 }
        let n = Double(v.count)
        var sum = 0.0, sumSq = 0.0
        for i in 0..<256 { sum += Double(i) * hist[i]; sumSq += Double(i * i) * hist[i] }
        let mean = sum / n, total = sumSq / n - mean * mean
        var sB = 0.0, wB = 0.0, best = 0.0, t = 0
        for i in 0..<256 {
            wB += hist[i]
            if wB == 0 { continue }
            let wF = n - wB
            if wF == 0 { break }
            sB += Double(i) * hist[i]
            let mB = sB / wB, mF = (sum - sB) / wF
            let between = wB * wF * (mB - mF) * (mB - mF)
            if between > best { best = between; t = i }
        }
        let eta = total > 0 ? best / (n * n) / total : 0
        return ((Double(t) + 0.5) / 255.999, eta)
    }

    struct Split {
        var bg: Int // pixel index of the background's median
        var ink: Int // pixel index of the ink core (p90 of distance from bg)
        var inkSet: [Int]
        var second: [Int] // D17: a second ink colour the split put with the background
        var bgLow: Bool // background is the dark class
        var t: Double
        var eta: Double
        var bimodal: Bool
        var ratio: Double
    }

    /// D1: Otsu on sqrt(L); the majority class is background (its median), the minority is ink, and ink is the pixel at
    /// the 90th percentile of distance from the background: the stroke core, not the anti-aliased edge.
    static func split(_ r: Region, x0: Int, x1: Int, y0: Int, y1: Int) -> Split? {
        var idx: [Int] = []
        idx.reserveCapacity((x1 - x0) * (y1 - y0))
        for y in y0..<y1 { for x in x0..<x1 { idx.append(r.at(x, y)) } }
        guard idx.count >= 16 else { return nil }
        let (t, eta) = otsu(idx.map { r.q[$0] })
        var lo: [Int] = [], hi: [Int] = []
        for i in idx { if r.q[i] <= t { lo.append(i) } else { hi.append(i) } }
        guard !lo.isEmpty, !hi.isEmpty else { return nil }
        let bgLow = lo.count >= hi.count
        let (bgSet, inkSet) = bgLow ? (lo, hi) : (hi, lo)
        let bgSorted = bgSet.sorted { r.lum[$0] < r.lum[$1] }
        let bg = bgSorted[bgSorted.count / 2]
        let bgL = r.lum[bg], bgQ = r.q[bg]
        let byDist = inkSet.sorted { abs(r.lum[$0] - bgL) < abs(r.lum[$1] - bgL) }
        let ink = byDist[min(byDist.count - 1, Int(Double(byDist.count - 1) * 0.9))]
        // D17: two ink colours make the ink class split cleanly again, with both groups large and far apart.
        var bimodal = false
        if inkSet.count >= 2 * minInk {
            let d = inkSet.map { abs(r.q[$0] - bgQ) }
            let (t2, eta2) = otsu(d)
            let near = d.filter { $0 <= t2 }, far = d.filter { $0 > t2 }
            if eta2 >= bimodalSeparation, Double(min(near.count, far.count)) >= bimodalShare * Double(d.count) {
                let m1 = near.reduce(0, +) / Double(near.count), m2 = far.reduce(0, +) / Double(far.count)
                bimodal = m2 - m1 >= bimodalGap
            }
        }
        // D17: a second ink colour lighter (or darker) than the first can fall in the background class (a grey run beside
        // a black one on white). It shows as a compact group far from the background: glyph interiors of one colour,
        // unlike a photo's spread or the anti-aliased ramp.
        var second: [Int] = []
        if bgSet.count >= 2 * minInk {
            let (t3, eta3) = otsu(bgSet.map { r.q[$0] })
            let a = bgSet.filter { r.q[$0] <= t3 }, b = bgSet.filter { r.q[$0] > t3 }
            let (minor, major) = a.count <= b.count ? (a, b) : (b, a)
            if eta3 >= bimodalSeparation, minor.count >= minInk {
                let mq = minor.map { r.q[$0] }.sorted(), med = mq[mq.count / 2]
                let majMed = major.map { r.q[$0] }.sorted()[major.count / 2]
                let compact = Double(mq.filter { abs($0 - med) <= secondSpread }.count) / Double(mq.count)
                if compact >= secondCompact, abs(med - majMed) >= secondGap { second = minor }
            }
        }
        return Split(bg: bg, ink: ink, inkSet: inkSet, second: second, bgLow: bgLow, t: t, eta: eta, bimodal: bimodal || !second.isEmpty,
                     ratio: ratio(r.lum[ink], bgL))
    }

    /// D19: share of pixels whose right or lower neighbour differs by more than `edgeStep` in sqrt(L).
    static func edgeShare(_ r: Region, _ pts: [(Int, Int)]) -> Double? {
        var n = 0, e = 0
        for (x, y) in pts where x + 1 < r.x0 + r.w && y + 1 < r.y0 + r.h {
            let q = r.q[r.at(x, y)]
            n += 1
            if abs(q - r.q[r.at(x + 1, y)]) > edgeStep || abs(q - r.q[r.at(x, y + 1)]) > edgeStep { e += 1 }
        }
        return n >= 16 ? Double(e) / Double(n) : nil
    }

    public struct Measure: Equatable {
        public var ratio: Double
        public var ink: String
        public var background: String
        public var busy: Bool
        public var edges: Double
        public var uncertain: Bool
    }

    /// The estimate for one line box in image pixels (origin top left); `others` are the other lines' boxes (cut out of
    /// the ring). nil when the box has no ink.
    public static func measure(_ img: CGImage, box: CGRect, others: [CGRect]) -> Measure? {
        let W = img.width, H = img.height
        let bx0 = max(0, Int(box.minX.rounded(.down))), bx1 = min(W, Int(box.maxX.rounded(.up)))
        let by0 = max(0, Int(box.minY.rounded(.down))), by1 = min(H, Int(box.maxY.rounded(.up)))
        guard bx1 - bx0 >= 4, by1 - by0 >= 4 else { return nil }
        let lh = by1 - by0
        let pad = max(2, Int((Double(lh) * 0.25).rounded()))
        let rx0 = max(0, bx0 - pad), rx1 = min(W, bx1 + pad + 1), ry0 = max(0, by0 - pad), ry1 = min(H, by1 + pad + 1)
        guard let r = Region(img, x0: rx0, y0: ry0, x1: rx1, y1: ry1), let all = split(r, x0: bx0, x1: bx1, y0: by0, y1: by1),
              all.inkSet.count >= minInk else { return nil }

        // Busy (D4, D19): background pixels inside the box at least 2 px from ink, and the ring around the box.
        var inkMask = [Bool](repeating: false, count: r.w * r.h)
        for i in all.inkSet + all.second { inkMask[i] = true }
        var near = inkMask
        for y in by0..<by1 { for x in bx0..<bx1 where inkMask[r.at(x, y)] {
            for dy in -2...2 { for dx in -2...2 {
                let xx = x + dx, yy = y + dy
                if xx >= rx0, xx < rx1, yy >= ry0, yy < ry1 { near[r.at(xx, yy)] = true }
            } }
        } }
        var inside: [(Int, Int)] = []
        for y in by0..<by1 { for x in bx0..<bx1 where !near[r.at(x, y)] { inside.append((x, y)) } }
        var ring: [(Int, Int)] = []
        for y in ry0..<ry1 { for x in rx0..<rx1 {
            if x >= bx0, x < bx1, y >= by0, y < by1 { continue }
            let p = CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5)
            if others.contains(where: { $0.contains(p) }) { continue }
            ring.append((x, y))
        } }
        let eIn = edgeShare(r, inside) ?? 0, eRing = edgeShare(r, ring) ?? 0
        let busy = eIn > busyInside || eRing > busyRing
        let doubt = { (s: Split) in s.eta < separationFloor || s.bimodal }

        // D3: gradients take the minimum over the whole box and segments two line heights wide; a busy line takes the
        // whole box (its segments would pick texture as background). D17: an uncertain split never gives the ratio, and
        // a line with no certain split is uncertain.
        var candidates = doubt(all) ? [] : [all]
        if !busy {
            let segW = max(8, 2 * lh)
            var x = bx0
            while x < bx1 {
                let xb = min(bx1, x + segW)
                if xb - x >= 4, let s = split(r, x0: x, x1: xb, y0: by0, y1: by1), s.inkSet.count >= minInk, !doubt(s) { candidates.append(s) }
                x = xb
            }
        }
        let best = candidates.min(by: { $0.ratio < $1.ratio }) ?? all
        return Measure(ratio: best.ratio, ink: r.hex(best.ink), background: r.hex(best.bg), busy: busy,
                       edges: Geometry.round2(max(eIn, eRing)), uncertain: candidates.isEmpty)
    }

    public struct Result {
        public var findings: [Finding] = []
        public var lines: [LineOut] = []
        public var warnings: [Diagnostic] = []
    }

    /// D7, D15: the element a line belongs to (the smallest that holds its centre) and whether a panel later in the
    /// hierarchy covers the centre. Dumps list parents before children, so a later element is drawn on top and is never
    /// an ancestor; one inside the owner's box is its own child, not a cover.
    static func boxesSkip(_ b: TruncationJob.Boxes, center c: CGPoint) -> String? {
        let holding = b.elements.enumerated().filter { $0.element.rect.contains(c) }
        guard let owner = holding.min(by: { $0.element.rect.width * $0.element.rect.height < $1.element.rect.width * $1.element.rect.height })
        else { return nil }
        if holding.contains(where: { !$0.element.enabled && $0.element.rect.contains(owner.element.rect) }) { return "disabled" }
        for (i, e) in holding where e.panel && i > owner.offset && !owner.element.rect.contains(e.rect) { return "covered" }
        return nil
    }

    public static func evaluate(_ job: ContrastJob, lines: [RecognizedLine], image img: CGImage, locale: String) -> Result {
        var out = Result()
        let W = Double(img.width), H = Double(img.height)
        let th = thresholds(level: job.level)
        let allow = Set(job.allow.map { TextMatch.normalize($0, locale: locale) })
        let px = lines.map { CGRect(x: $0.rect.minX * W, y: $0.rect.minY * H, width: $0.rect.width * W, height: $0.rect.height * H) }
        var relaxed: [(String, Double)] = []
        var covered = 0
        for (i, l) in lines.enumerated() {
            var c = LineContrast()
            let box = px[i]
            let center = CGPoint(x: l.rect.midX, y: l.rect.midY)
            if box.height < 4 { c.skipped = "too-small" }
            else if notText(l) { c.skipped = "not-text" }
            else if !allow.isEmpty, allow.contains(TextMatch.normalize(l.text, locale: locale)) { c.skipped = "allow" }
            else if let b = job.boxes, let s = boxesSkip(b, center: center) { c.skipped = s; if s == "covered" { covered += 1 } }
            if c.skipped != nil {
                out.lines.append(LineOut(text: l.text, box: Geometry.box(l.rect), confidence: Geometry.round2(l.confidence), contrast: c))
                continue
            }
            guard let m = measure(img, box: box, others: px.enumerated().filter { $0.offset != i }.map(\.element)) else {
                c.skipped = "no-ink"
                out.lines.append(LineOut(text: l.text, box: Geometry.box(l.rect), confidence: Geometry.round2(l.confidence), contrast: c))
                continue
            }
            let size = sizeClass(heightPx: box.height, scale: job.scale)
            let threshold = size == "normal" ? th.normal : th.large
            c.ratio = Geometry.round2(m.ratio)
            c.threshold = threshold
            c.size = size
            c.busy = m.busy
            c.edges = m.edges
            c.ink = m.ink
            c.background = m.background
            c.uncertain = m.uncertain
            out.lines.append(LineOut(text: l.text, box: Geometry.box(l.rect), confidence: Geometry.round2(l.confidence), contrast: c))
            func finding(_ kind: String) -> Finding {
                var f = Finding(kind: kind, box: Geometry.box(l.rect), line: l.text)
                f.ratio = c.ratio
                f.threshold = threshold
                f.size = size
                f.ink = m.ink
                f.background = m.background
                f.edges = m.edges
                f.scale = job.scale
                f.scaleSource = job.scaleSource
                f.confidence = Geometry.round2(l.confidence)
                return f
            }
            if m.busy, job.kinds.contains("busy-background") { out.findings.append(finding("busy-background")) }
            let fails = m.ratio < threshold / margin
            if fails, !m.uncertain, job.kinds.contains("low-contrast") { out.findings.append(finding("low-contrast")) }
            // D6, D29: doubt about the size relaxed the verdict when the line fails 4.5:1 but passes 3:1.
            if size == "uncertain", !m.uncertain, m.ratio < th.normal / margin, !fails { relaxed.append((l.text, c.ratio ?? m.ratio)) }
        }
        if !relaxed.isEmpty {
            let shown = relaxed.prefix(10).map { "\"\($0.0)\" \(String(format: "%.2f", $0.1)):1" }.joined(separator: ", ")
            let more = relaxed.count > 10 ? " and \(relaxed.count - 10) more" : ""
            out.warnings.append(Diagnostic(
                "contrast-size-uncertain",
                "\(relaxed.count) line\(relaxed.count == 1 ? "" : "s") of uncertain size judged at \(fmt(th.large)):1, not \(fmt(th.normal)):1: \(shown)\(more)",
                hint: "--scale <n> pins the size; lines with size \"uncertain\" in --json"))
        }
        if covered > 0 {
            out.warnings.append(Diagnostic(
                "contrast-behind-scrim",
                "\(covered) line\(covered == 1 ? "" : "s") covered by a panel in the boxes not checked",
                hint: "covered text is skipped only with --boxes; check the screen without the modal for its own contrast"))
        }
        return out
    }

    static func fmt(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(v) }
}

