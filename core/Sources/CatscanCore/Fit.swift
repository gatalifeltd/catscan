// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// A device profile (TODO-073 "Device profiles"): hidden pixel runs in portrait screenshot pixels.
public struct DeviceProfile: Equatable {
    public struct Zone: Equatable {
        public var kind: String // cutout | corner | home-indicator
        public var runs: [[Int]] // [y, x0, x1)
        public var box: [Int]? // home-indicator: [x, y, width, height]
    }

    public var id: String
    public var platform: String
    public var width: Int
    public var height: Int
    public var zones: [Zone]
    /// The home indicator's box in landscape pixels; nil when the profile has none.
    public var landscapeHome: [Int]?
    /// Pixels per point (`screen.scale`); nil when the profile does not say.
    public var scale: Double?

    public init(id: String, platform: String, width: Int, height: Int, zones: [Zone], landscapeHome: [Int]? = nil, scale: Double? = nil) {
        self.id = id
        self.platform = platform
        self.width = width
        self.height = height
        self.zones = zones
        self.landscapeHome = landscapeHome
        self.scale = scale
    }

    /// Parses a profile object (shipped table row or user file, already validated by the Node layer).
    public static func parse(_ o: Any) -> DeviceProfile? {
        guard let o = o as? [String: Any], let id = o["id"] as? String, let s = o["screen"] as? [String: Any],
              let w = (s["width"] as? NSNumber)?.intValue, let h = (s["height"] as? NSNumber)?.intValue, w > 0, h > 0,
              let zs = o["zones"] as? [[String: Any]] else { return nil }
        var zones: [Zone] = []
        for z in zs {
            guard let k = z["kind"] as? String, Fit.reasons.contains(k) else { return nil }
            let runs = (z["runs"] as? [[NSNumber]])?.map { $0.map(\.intValue) } ?? []
            let box = (z["box"] as? [NSNumber])?.map(\.intValue)
            // Runs are [y, x0, x1) inside the screen; a box is [x, y, w, h] with a positive size (Node validates the same;
            // serve callers that skip it must not reach part()'s force unwraps or an unbounded rotate).
            if runs.contains(where: { $0.count != 3 || $0[0] < 0 || $0[0] >= h || $0[1] < 0 || $0[1] >= $0[2] || $0[2] > w }) { return nil }
            if let b = box, b.count != 4 || b[0] < 0 || b[1] < 0 || b[2] <= 0 || b[3] <= 0 || b[0] + b[2] > w || b[1] + b[3] > h { return nil }
            zones.append(Zone(kind: k, runs: runs, box: box))
        }
        let lh = ((o["landscape"] as? [String: Any])?["home-indicator"] as? [String: Any])?["box"] as? [NSNumber]
        // The landscape box is in landscape pixels (h wide, w tall).
        // D40: a portrait home indicator needs its landscape box, or a landscape image would neither run nor skip it.
        if lh == nil && zones.contains(where: { $0.kind == "home-indicator" }) { return nil }
        if let b = lh?.map(\.intValue), b.count != 4 || b[0] < 0 || b[1] < 0 || b[2] <= 0 || b[3] <= 0 || b[0] + b[2] > h || b[1] + b[3] > w { return nil }
        return DeviceProfile(id: id, platform: o["platform"] as? String ?? "", width: w, height: h, zones: zones, landscapeHome: lh?.map(\.intValue), scale: (s["scale"] as? NSNumber)?.doubleValue)
    }
}

/// The `fit` request field (TODO-073), built by the Node layer.
public struct FitJob {
    /// `--device-profile` or a TODO-075 label that names a profile (D21); nil: match by size (iOS and iPadOS only, D10).
    public var profile: DeviceProfile? = nil
    public var matchedBy = "flag" // flag | label
    /// The shipped table for size matching, and its version (nil for a user profile file).
    public var table: [DeviceProfile] = []
    public var version: String? = nil
    /// TODO-075: the input's platform; candidates of another platform are dropped (and android never matches by size).
    public var platform: String? = nil
    public var orientation: String? = nil // portrait | landscape-left | landscape-right; nil: from the image
    public var boxes: TruncationJob.Boxes? = nil
    public var reasons: Set<String> = Set(Fit.reasons)
    public var allow: [String] = []
    /// D9, D37: the zones whose controls are checked; a zone whose controls missed the gate is left out unless
    /// --experimental was given.
    public var controls: Set<String> = Set(Fit.reasons)
    public var minHidden = 0.5
    public var minControl = 0.25
    public var edgeDistance = 0.15 // spec 06's, in line heights
    /// TODO-074: the wrap reasons' base rows, catalog pairs and gated evidence.
    public var wrap = WrapJob()

    public init() {}
}

public enum Fit {
    /// Rule step 5: one finding per line or control, the first zone in this order.
    public static let reasons = ["cutout", "corner", "home-indicator"]
    public static let orientations = ["portrait", "landscape-left", "landscape-right"]
    /// A sidecar may also say the screen was upside down (uiautomator `rotation` 2); the CLI flag never does.
    public static let sidecarOrientations = orientations + ["portrait-upside-down"]

    /// Rows of hidden pixel runs, keyed by y; runs sorted and disjoint.
    typealias Rows = [Int: [(Int, Int)]]

    /// One hit-test region: a cutout, one rounded corner, or the grown home indicator, in the image's orientation.
    struct Part {
        var kind: String
        var rows: Rows
        var x0: Int, y0: Int, x1: Int, y1: Int
        var sides: Set<Character> // screen edges the region lies against: t, b, l, r
    }

    /// The zones of one profile for one image orientation, in profile pixels of that orientation.
    struct Layout {
        var width: Int
        var height: Int
        var parts: [Part]
    }

    public struct Match {
        public var profile: DeviceProfile
        public var ids: [String]
        public var matchedBy: String
        public var ambiguous: Bool
    }

    public struct Outcome {
        public var findings: [Finding] = []
        public var warnings: [Diagnostic] = []
        public var error: Diagnostic? = nil
        public var deviceProfile: DeviceProfileOut? = nil
        public var reasonsRun: [String] = []
        public var reasonsSkipped: [SkippedReason] = []
        public var elementRows: [ElementRows]? = nil // TODO-074 D9
    }

    // MARK: matching (D3, D4, D10, D21)

    /// The aspect check for a given profile (spec 06 D7): within 1% of either orientation.
    static func mismatch(_ p: DeviceProfile, width: Int, height: Int, path: String?) -> Diagnostic? {
        let shot = Double(width) / Double(height)
        let a = Double(p.width) / Double(p.height), b = Double(p.height) / Double(p.width)
        let diff = min(abs(a - shot) / shot, abs(b - shot) / shot)
        if diff <= 0.01 { return nil }
        let pct = String(format: "%.1f", ((diff * 1000).rounded() / 10))
        return Diagnostic(
            "device-profile-mismatch",
            "\(path ?? "-") is \(width)x\(height) but the profile \(p.id) is \(p.width)x\(p.height) (aspect differs by \(pct)%)",
            hint: "pass the profile of the device that took it")
    }

    /// Size and uniform-downscale matching over the iOS and iPadOS rows of the table.
    public static func match(_ job: FitJob, width: Int, height: Int) -> Match? {
        if let p = job.profile { return Match(profile: p, ids: [p.id], matchedBy: job.matchedBy, ambiguous: false) }
        if job.platform == "android" || job.platform == "web" { return nil }
        var pool = job.table.filter { $0.platform == "ios" || $0.platform == "ipados" }
        if let pf = job.platform { pool = pool.filter { $0.platform == pf } }
        let fits: (DeviceProfile) -> Bool = { p in
            (p.width == width && p.height == height) || (p.width == height && p.height == width)
        }
        var cands = pool.filter(fits), by = "size"
        if cands.isEmpty {
            // A uniform downscale of exactly one profile size: both axes by one factor, within 0.5 px.
            let scaled = pool.filter { p in
                let (pw, ph) = (width > height) == (p.width > p.height) ? (p.width, p.height) : (p.height, p.width)
                guard width < pw else { return false }
                // An exact point size (CSS pixels of a web viewport at 1x: 402x874, 440x956) is a browser, not a
                // downscaled phone screenshot: a viewport has no cutout (TODO-073 PR 2 follow-up).
                if let sc = p.scale, sc > 1, abs(Double(pw) / sc - Double(width)) < 0.5, abs(Double(ph) / sc - Double(height)) < 0.5 { return false }
                let f = Double(width) / Double(pw)
                return abs(Double(ph) * f - Double(height)) <= 0.5
            }
            if Set(scaled.map { "\($0.width)x\($0.height)" }).count == 1 { cands = scaled; by = "scale" }
        }
        guard let first = cands.first else { return nil }
        if cands.count == 1 { return Match(profile: first, ids: [first.id], matchedBy: by, ambiguous: false) }
        let ids = cands.map(\.id)
        if cands.dropFirst().allSatisfy({ same($0, first) }) { return Match(profile: first, ids: ids, matchedBy: by, ambiguous: false) }
        return Match(profile: intersection(cands), ids: ids, matchedBy: by, ambiguous: true)
    }

    static func rows(_ runs: [[Int]]) -> Rows {
        var r: Rows = [:]
        for v in runs { r[v[0], default: []].append((v[1], v[2])) }
        for k in r.keys { r[k] = merged(r[k]!) }
        return r
    }

    static func merged(_ runs: [(Int, Int)]) -> [(Int, Int)] {
        var out: [(Int, Int)] = []
        for (a, b) in runs.sorted(by: { $0.0 < $1.0 }) where b > a {
            if let l = out.last, a <= l.1 { out[out.count - 1].1 = max(l.1, b) } else { out.append((a, b)) }
        }
        return out
    }

    static func intersect(_ a: Rows, _ b: Rows) -> Rows {
        var out: Rows = [:]
        for (y, ra) in a {
            guard let rb = b[y] else { continue }
            var row: [(Int, Int)] = []
            for (a0, a1) in ra { for (b0, b1) in rb where min(a1, b1) > max(a0, b0) { row.append((max(a0, b0), min(a1, b1))) } }
            if !row.isEmpty { out[y] = merged(row) }
        }
        return out
    }

    static func zoneRows(_ p: DeviceProfile, _ kind: String) -> Rows {
        rows(p.zones.filter { $0.kind == kind && $0.box == nil }.flatMap(\.runs))
    }

    /// D3: zones identical within 1 px (same rows, each run end within 1 px; same home indicator box within 1 px).
    static func same(_ a: DeviceProfile, _ b: DeviceProfile) -> Bool {
        for k in ["cutout", "corner"] {
            let ra = zoneRows(a, k), rb = zoneRows(b, k)
            guard Set(ra.keys) == Set(rb.keys) else { return false }
            for (y, x) in ra {
                let o = rb[y]!
                guard x.count == o.count, zip(x, o).allSatisfy({ abs($0.0 - $1.0) <= 1 && abs($0.1 - $1.1) <= 1 }) else { return false }
            }
        }
        let ha = a.zones.first { $0.kind == "home-indicator" }?.box, hb = b.zones.first { $0.kind == "home-indicator" }?.box
        if (ha == nil) != (hb == nil) { return false }
        if let ha, let hb, zip(ha, hb).contains(where: { abs($0 - $1) > 1 }) { return false }
        return true
    }

    /// D3: only pixels hidden on every candidate (same pixel size) count; home indicator boxes intersect too.
    static func intersection(_ ps: [DeviceProfile]) -> DeviceProfile {
        var out = ps[0]
        out.zones = []
        for k in ["cutout", "corner"] {
            var r = zoneRows(ps[0], k)
            for p in ps.dropFirst() { r = intersect(r, zoneRows(p, k)) }
            if !r.isEmpty { out.zones.append(.init(kind: k, runs: r.keys.sorted().flatMap { y in r[y]!.map { [y, $0.0, $0.1] } }, box: nil)) }
        }
        func boxIntersect(_ bs: [[Int]?]) -> [Int]? {
            guard let f = bs.first ?? nil, bs.allSatisfy({ $0 != nil }) else { return nil }
            var (x0, y0, x1, y1) = (f[0], f[1], f[0] + f[2], f[1] + f[3])
            for b in bs.dropFirst() { let b = b!; x0 = max(x0, b[0]); y0 = max(y0, b[1]); x1 = min(x1, b[0] + b[2]); y1 = min(y1, b[1] + b[3]) }
            return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : nil
        }
        if let b = boxIntersect(ps.map { p in p.zones.first { $0.kind == "home-indicator" }?.box }) {
            out.zones.append(.init(kind: "home-indicator", runs: [], box: b))
        }
        out.landscapeHome = boxIntersect(ps.map(\.landscapeHome))
        return out
    }

    // MARK: geometry per orientation (D5)

    /// Portrait rows -> landscape rows. `landscape-left`: the portrait top edge is the image's left edge.
    static func rotate(_ r: Rows, width W: Int, height H: Int, _ o: String) -> Rows {
        var out: Rows = [:]
        for (y, runs) in r {
            for (x0, x1) in runs {
                if o == "landscape-left" {
                    for ny in (W - x1)..<(W - x0) { out[ny, default: []].append((y, y + 1)) }
                } else {
                    for ny in x0..<x1 { out[ny, default: []].append((H - 1 - y, H - y)) }
                }
            }
        }
        for k in out.keys { out[k] = merged(out[k]!) }
        return out
    }

    static func boxRows(_ b: [Int], grow: Bool, width: Int, height: Int) -> Rows {
        // Rule step 1: the indicator box grown by its own height on each side.
        let g = grow ? b[3] : 0
        let x0 = max(0, b[0] - g), x1 = min(width, b[0] + b[2] + g), y0 = max(0, b[1] - g), y1 = min(height, b[1] + b[3] + g)
        var r: Rows = [:]
        if x1 > x0 { for y in y0..<max(y0, y1) { r[y] = [(x0, x1)] } }
        return r
    }

    static func part(_ kind: String, _ r: Rows, width: Int, height: Int) -> Part? {
        guard let y0 = r.keys.min(), let y1 = r.keys.max() else { return nil }
        let x0 = r.values.compactMap { $0.first?.0 }.min()!, x1 = r.values.compactMap { $0.last?.1 }.max()!
        var sides = Set<Character>()
        // The nearest screen edge, and every edge the region touches (a corner touches two).
        if y0 == 0 { sides.insert("t") }
        if y1 + 1 >= height { sides.insert("b") }
        if x0 == 0 { sides.insert("l") }
        if x1 >= width { sides.insert("r") }
        if sides.isEmpty {
            let d = [("t", y0), ("b", height - 1 - y1), ("l", x0), ("r", width - x1)].min { $0.1 < $1.1 }!
            sides.insert(Character(d.0))
        }
        return Part(kind: kind, rows: r, x0: x0, y0: y0, x1: x1, y1: y1 + 1, sides: sides)
    }

    /// The zone parts for an image orientation; `side` nil means landscape with the side unknown (cutout skipped,
    /// corners intersected over both sides).
    static func layout(_ p: DeviceProfile, orientation o: String?) -> Layout {
        let land = o != "portrait"
        let (W, H) = land ? (p.height, p.width) : (p.width, p.height)
        var parts: [Part] = []
        func oriented(_ r: Rows) -> Rows {
            guard land else { return r }
            if let o { return rotate(r, width: p.width, height: p.height, o) }
            return intersect(rotate(r, width: p.width, height: p.height, "landscape-left"), rotate(r, width: p.width, height: p.height, "landscape-right"))
        }
        if o != nil || !land, let c = part("cutout", oriented(zoneRows(p, "cutout")), width: W, height: H) { parts.append(c) }
        // Each rounded corner is its own part, so zone_box is that corner, not the whole screen.
        let corner = oriented(zoneRows(p, "corner"))
        for (qx, qy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            var q: Rows = [:]
            for (y, runs) in corner where (y * 2 >= H) == (qy == 1) {
                let r = runs.compactMap { (a, b) -> (Int, Int)? in
                    let (s, e) = qx == 0 ? (a, min(b, W / 2)) : (max(a, W / 2), b)
                    return e > s ? (s, e) : nil
                }
                if !r.isEmpty { q[y] = r }
            }
            if let c = part("corner", q, width: W, height: H) { parts.append(c) }
        }
        let home = land ? p.landscapeHome : p.zones.first { $0.kind == "home-indicator" }?.box
        if let b = home, let h = part("home-indicator", boxRows(b, grow: true, width: W, height: H), width: W, height: H) { parts.append(h) }
        return Layout(width: W, height: H, parts: parts)
    }

    /// Hidden share of a rect (profile pixels of the layout) inside one part.
    static func coverage(_ r: CGRect, _ p: Part) -> Double {
        let area = Double(r.width * r.height)
        guard area > 0, r.maxX > CGFloat(p.x0), r.minX < CGFloat(p.x1), r.maxY > CGFloat(p.y0), r.minY < CGFloat(p.y1) else { return 0 }
        var acc = 0.0
        let ya = max(Int(r.minY.rounded(.down)), p.y0), yb = min(Int(r.maxY.rounded(.up)), p.y1)
        guard yb > ya else { return 0 }
        for y in ya..<yb {
            guard let runs = p.rows[y] else { continue }
            let yo = Double(min(CGFloat(y + 1), r.maxY) - max(CGFloat(y), r.minY))
            if yo <= 0 { continue }
            for (x0, x1) in runs {
                let xo = Double(min(CGFloat(x1), r.maxX) - max(CGFloat(x0), r.minX))
                if xo > 0 { acc += xo * yo }
            }
        }
        return acc / area
    }

    // MARK: rule

    static func hasLetterOrDigit(_ s: String) -> Bool { s.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) } }

    static func pixels(_ n: CGRect, _ l: Layout) -> CGRect {
        CGRect(x: n.minX * CGFloat(l.width), y: n.minY * CGFloat(l.height), width: n.width * CGFloat(l.width), height: n.height * CGFloat(l.height))
    }

    static func normalized(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, _ l: Layout) -> [Double] {
        Geometry.box(CGRect(x: CGFloat(x0) / CGFloat(l.width), y: CGFloat(y0) / CGFloat(l.height),
                            width: CGFloat(x1 - x0) / CGFloat(l.width), height: CGFloat(y1 - y0) / CGFloat(l.height)))
    }

    /// Per-character boxes (normalized): Vision's ranges, else even shares of the line box (D23, Tesseract). Vision
    /// often answers a one-character range with its whole word's box; a run of characters that share one box gets
    /// even shares of it, so `hidden` names the characters, not the word.
    static func characters(_ l: RecognizedLine) -> [(Character, CGRect)] {
        let idx = Array(l.text.indices)
        let n = CGFloat(max(idx.count, 1))
        var boxes: [CGRect] = idx.enumerated().map { k, i in
            if let f = l.rangeBox, let b = f(i..<l.text.index(after: i)), b.width > 0, b.height > 0 { return b }
            return CGRect(x: l.rect.minX + CGFloat(k) * l.rect.width / n, y: l.rect.minY, width: l.rect.width / n, height: l.rect.height)
        }
        var k = 0
        while k < boxes.count {
            var e = k + 1
            while e < boxes.count && boxes[e] == boxes[k] { e += 1 }
            if e - k > 1 {
                let b = boxes[k], w = b.width / CGFloat(e - k)
                // Right-to-left text runs from the right edge.
                let rtl = idx[k..<e].contains { l.text[$0].unicodeScalars.first.map { (0x0590...0x08FF).contains($0.value) } ?? false }
                for j in k..<e {
                    let o = CGFloat(rtl ? e - 1 - j : j - k)
                    boxes[j] = CGRect(x: b.minX + o * w, y: b.minY, width: w, height: b.height)
                }
            }
            k = e
        }
        return zip(idx, boxes).map { (l.text[$0], $1) }
    }

    /// Rule step 4: the line lies against the top or bottom screen edge on the part's side (content scrolled under
    /// the status bar or off the bottom, left to `truncated`). Left and right edges do not count: Vision's line box
    /// overhangs the ink and is clamped at x 0, so every label in a rounded corner would look edge-touching (D31).
    static func atEdge(_ r: CGRect, _ p: Part, _ l: Layout, d: Double) -> Bool {
        (p.sides.contains("t") && Double(r.minY) <= d) || (p.sides.contains("b") && Double(CGFloat(l.height) - r.maxY) <= d)
    }

    /// The safe-area reasons (TODO-073) when any is asked, then the wrap reasons (TODO-074), which need no profile.
    public static func evaluate(_ job: FitJob, lines: [RecognizedLine], width: Int, height: Int, path: String?, locale: String = "en") -> Outcome {
        var out = reasons.contains(where: job.reasons.contains) ? safeArea(job, lines: lines, width: width, height: height, path: path) : Outcome()
        if out.error != nil { return out }
        let asked = Wrapping.reasons.filter(job.reasons.contains)
        if !asked.isEmpty || job.wrap.elementRows {
            if job.boxes == nil {
                out.reasonsSkipped += asked.map { SkippedReason(reason: $0, cause: "boxes-missing") }
            } else {
                out.reasonsRun += asked
                let w = Wrapping.evaluate(job, lines: lines, locale: locale)
                out.findings += w.findings
                if job.wrap.elementRows { out.elementRows = w.elementRows }
            }
        }
        out.findings.sort { ($0.box?[1] ?? 0, $0.box?[0] ?? 0) < ($1.box?[1] ?? 0, $1.box?[0] ?? 0) }
        return out
    }

    static func safeArea(_ job: FitJob, lines: [RecognizedLine], width: Int, height: Int, path: String?) -> Outcome {
        var out = Outcome()
        let land = width > height
        // D5: the side from the flag or sidecar; a landscape image without it skips the cutout only. A portrait image
        // taken upside down (uiautomator `rotation` 2) has its cutout at the bottom: skipped too (D39).
        let stated = job.orientation
        let upsideDown = !land && stated == "portrait-upside-down"
        let orientation: String? = land ? (stated.flatMap { $0.hasPrefix("portrait") ? nil : $0 }) : "portrait"
        if let p = job.profile, let d = mismatch(p, width: width, height: height, path: path) { out.error = d; return out }
        guard let m = match(job, width: width, height: height) else {
            out.reasonsSkipped = reasons.filter(job.reasons.contains).map { SkippedReason(reason: $0, cause: "device-unknown") }
            return out
        }
        out.deviceProfile = DeviceProfileOut(id: m.ids[0], ids: m.ids, orientation: upsideDown ? "portrait-upside-down" : orientation ?? "landscape", matchedBy: m.matchedBy, version: job.version)
        if m.ambiguous {
            out.warnings.append(Diagnostic(
                "device-ambiguous",
                "\(width)x\(height) fits \(m.ids.joined(separator: ", ")) with different cutouts; only pixels hidden on all of them are checked",
                hint: "--device-profile \(m.ids.last!)"))
        }
        let layout = layout(m.profile, orientation: orientation)
        // A finding names what it was checked against: under device-ambiguous, the intersection of every candidate.
        let checkedAgainst = m.ambiguous ? m.ids.joined(separator: "+") : m.ids[0]
        let present = Set(layout.parts.map(\.kind))
        for r in reasons where job.reasons.contains(r) {
            if r == "cutout" && ((land && orientation == nil) || upsideDown) && m.profile.zones.contains(where: { $0.kind == "cutout" }) {
                out.reasonsSkipped.append(SkippedReason(reason: r, cause: "orientation-unknown"))
            } else if present.contains(r) {
                out.reasonsRun.append(r)
            }
        }
        if out.reasonsSkipped.contains(where: { $0.cause == "orientation-unknown" }) {
            let what = upsideDown ? "was taken upside down (portrait-upside-down), so its cutout is at the bottom"
                : stated == "portrait" ? "is landscape but its stated orientation is portrait"
                : "is landscape and its side is unknown"
            out.warnings.append(Diagnostic(
                "orientation-unknown", "\(path ?? "-") \(what); cutout skipped", hint: upsideDown ? "capture it in portrait" : "--orientation landscape-left"))
        }
        let parts = layout.parts.filter { out.reasonsRun.contains($0.kind) }
        guard !parts.isEmpty else { return out }
        let elements = job.boxes?.elements ?? []
        let order = { (k: String) in reasons.firstIndex(of: k)! }

        func owner(_ n: CGRect) -> TruncationJob.Element? {
            let c = CGPoint(x: n.midX, y: n.midY)
            return elements.filter { $0.rect.contains(c) }.min { $0.rect.width * $0.rect.height < $1.rect.width * $1.rect.height }
        }
        func skipped(_ n: CGRect) -> Bool {
            let c = CGPoint(x: n.midX, y: n.midY)
            return elements.contains { ($0.scrolls || $0.offscreen) && $0.rect.contains(c) }
        }

        for l in lines {
            let lp = pixels(l.rect, layout)
            let near = parts.filter { lp.maxX > CGFloat($0.x0) && lp.minX < CGFloat($0.x1) && lp.maxY > CGFloat($0.y0) && lp.minY < CGFloat($0.y1) }
            guard !near.isEmpty, hasLetterOrDigit(l.text), !job.allow.contains(l.text), !skipped(l.rect) else { continue }
            let el = owner(l.rect)
            if let el, let id = el.id, job.allow.contains(id) { continue }
            if let t = el?.text, job.allow.contains(t) { continue }
            let d = job.edgeDistance * Double(lp.height)
            let chars = characters(l)
            var best: (Part, [Int])? = nil
            for p in near.sorted(by: { order($0.kind) < order($1.kind) }) where !atEdge(lp, p, layout, d: d) {
                let hidden = chars.indices.filter { coverage(pixels(chars[$0].1, layout), p) >= job.minHidden }
                if hidden.contains(where: { hasLetterOrDigit(String(chars[$0].0)) }) { best = (p, hidden); break }
            }
            guard let (p, hidden) = best else { continue }
            let hb = hidden.map { chars[$0].1 }.reduce(CGRect.null) { $0.union($1) }
            var f = Finding(kind: "fit", box: Geometry.box(l.rect), line: l.text)
            f.reason = p.kind
            f.hidden = String(hidden.map { chars[$0].0 })
            f.hiddenBox = Geometry.box(hb)
            f.zoneBox = normalized(p.x0, p.y0, p.x1, p.y1, layout)
            f.element = el.map { Finding.Element(id: $0.id, box: Geometry.box($0.rect)) }
            f.confidence = Geometry.round2(l.confidence)
            f.profile = checkedAgainst
            out.findings.append(f)
        }

        // Rule step 3 (D7, D12): textless controls by their covered share; no center rule. D38: a control whose text is
        // only its accessibility label (an icon button labelled "Close": no line of Vision's inside it) is textless too.
        let controlParts = parts.filter { job.controls.contains($0.kind) }
        if !controlParts.isEmpty {
            // A control is textless when no line with a letter or digit lies inside it: an icon whose only drawn text is
            // a symbol ("+", "<") is still an icon, and a clickable container whose child text Vision reads is checked
            // as that text (step 2), not again as a control (TODO-073 PR 2 follow-up).
            func inked(_ e: TruncationJob.Element) -> Bool { lines.contains { hasLetterOrDigit($0.text) && e.rect.contains(CGPoint(x: $0.rect.midX, y: $0.rect.midY)) } }
            for e in elements where e.control && !e.offscreen && !e.scrolls && !inked(e) {
                if let id = e.id, job.allow.contains(id) { continue }
                if skipped(e.rect) { continue }
                let ep = pixels(e.rect, layout)
                guard let (p, share) = controlParts.sorted(by: { order($0.kind) < order($1.kind) })
                    .lazy.map({ ($0, coverage(ep, $0)) }).first(where: { $0.1 >= job.minControl }) else { continue }
                var f = Finding(kind: "fit", box: Geometry.box(e.rect), line: "")
                f.lineNull = true
                f.reason = p.kind
                f.hiddenBox = Geometry.box(e.rect)
                f.zoneBox = normalized(p.x0, p.y0, p.x1, p.y1, layout)
                f.element = Finding.Element(id: e.id, box: Geometry.box(e.rect))
                f.covered = Geometry.round2(share)
                f.profile = checkedAgainst
                out.findings.append(f)
            }
        }
        out.findings.sort { ($0.box?[1] ?? 0, $0.box?[0] ?? 0) < ($1.box?[1] ?? 0, $1.box?[0] ?? 0) }
        return out
    }
}

/// The envelope's `device_profile` (TODO-073 "Envelope"; D22: carries the table version).
public struct DeviceProfileOut: Encodable, Equatable {
    public var id: String
    public var ids: [String]
    public var orientation: String // portrait | landscape-left | landscape-right | landscape (side unknown)
    public var matchedBy: String
    public var version: String?

    enum K: String, CodingKey { case id, ids, orientation, matched_by, version }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        try c.encode(ids, forKey: .ids)
        try c.encode(orientation, forKey: .orientation)
        try c.encode(matchedBy, forKey: .matched_by)
        try c.encode(version, forKey: .version)
    }
}

/// D16, D25: a fit reason that did not run on an image, and why.
public struct SkippedReason: Encodable, Equatable {
    public var reason: String
    public var cause: String // device-unknown | orientation-unknown | boxes-missing (TODO-074: a wrap reason with no sidecar)
}
