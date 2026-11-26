// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 12 synthetic set (D10): two UI labels drawn with Core Text with a controlled overlap, plus distractor labels,
// in the macOS system UI font for the language, as bench/generate.swift (spec 05) draws. Labeled by construction:
// the overlap is between the two lines' typographic boxes (ascent to descent, D5), in CSS px (drawn at scale 3).
// TODO-041 T1 crop mode (an item with `font`): a freely licensed font file instead of the system font (D9), a render
// scale of 1-3x, gradient and image backgrounds, outlines and shadows, and hard negatives stacked under the pair
// (tight paragraphs, large titles, icons next to text). Every image also reports where the ink of two texts touches
// (D7): `contact` for the labeled pair, `other_cells` for any other two texts, in 4 px cells.
// TODO-041 D24: layout `tg` pairs text `a` with a graphic (an icon shape or a made-up image patch) drawn under or
// over it, `amount` CSS px into the text's box from `gside`; `contact` is then the text ink inside the graphic, and
// `b` is an ordinary label below. `mode: "crop"` without `font` draws crop mode in the system font (evaluation sets).
// TODO-041 D25: a paragraph's consecutive lines are stepped by `leading` x their height, or by their height minus
// `overlap` CSS px; `para` reports every consecutive pair: how far their glyph ink overlaps vertically (CSS px) and
// where the ink touches.
// Usage: swiftc -O bench/overlap/generate.swift -o .build/overlap-gen && .build/overlap-gen <plan.json> <outdir>
// Prints one JSON object: {"images": [{name, width, height, lines: [{text, role, box: [x, y, w, h] px}], skipped?,
// scale, ov?, contact, other_cells}], "fonts": {...}}.
import CoreGraphics
import CoreText
import Foundation
import ImageIO

// layout: vv (a label over a label, offset), lh (two lines with a line-height under 1.0), hh (one row),
// icon (a label over an icon's caption). amount: CSS px of overlap; negative is a gap.
struct Extra: Decodable { let kind: String; let texts: [String]; let size: Double; let leading: Double?; let overlap: Double? }
struct Item: Decodable {
    let name: String; let locale: String; let layout: String; let amount: Double; let size: Double; let theme: String
    let a: String; let b: String; let distractors: [String]; let shift: Double
    // Crop mode only (TODO-041 T1).
    let font: String?; let fontName: String?; let wght: Double?; let scale: Double?; let bg: String?; let effect: String?
    let seed: Int?; let extras: [Extra]?; let pairAt: Int?; let gap: Double?
    let mode: String?; let graphic: String?; let gside: String?; let gover: Bool?
}
struct Out: Encodable { let text: String; let role: String; let box: [Double] }
struct Contact: Encodable { let ink_px: Int; let cells: [[Int]] }
struct Image: Encodable {
    let name: String; let width: Int; let height: Int; let lines: [Out]; let skipped: String?
    let scale: Double; let ov: [Double]?; let contact: Contact; let other_cells: [[Int]]
    let pair_kind: String; let graphic: [Double]?; let para: [Para]
}
struct Para: Encodable { let lines: [Int]; let ink_overlap: Double; let ink_px: Int; let cells: [[Int]] }

/// A drawn non-text element: icon shapes (`round`, `rect`, `ring`) or an `image` patch; rect is top-left origin.
struct Graphic { let rect: CGRect; let shape: String; let color: CGColor; let over: Bool; let seed: UInt32 }

/// Draws `g` into `ctx` whose top-left is (ox, oy) in image px and whose height is `h`; `mask` fills its opaque area white.
func drawGraphic(_ ctx: CGContext, _ g: Graphic, ox: Double, oy: Double, h: Double, mask: Bool) {
    let r = CGRect(x: g.rect.minX - ox, y: h - (g.rect.maxY - oy), width: g.rect.width, height: g.rect.height)
    ctx.saveGState()
    defer { ctx.restoreGState() }
    let fill = mask ? CGColor(gray: 1, alpha: 1) : g.color
    switch g.shape {
    case "round": ctx.setFillColor(fill); ctx.fillEllipse(in: r)
    case "ring":
        ctx.setStrokeColor(fill); ctx.setLineWidth(max(2, r.width / 7)); ctx.strokeEllipse(in: r.insetBy(dx: r.width / 14, dy: r.width / 14))
    case "image":
        ctx.setFillColor(fill); ctx.fill(r)
        if !mask { // a made-up picture: shapes in other colors, clipped to the patch
            var rr = Rand(s: g.seed)
            ctx.clip(to: r)
            for _ in 0..<6 {
                ctx.setFillColor(CGColor(red: rr.next(), green: rr.next(), blue: rr.next(), alpha: 1))
                let e = CGRect(x: r.minX + rr.range(-0.3, 0.9) * r.width, y: r.minY + rr.range(-0.3, 0.9) * r.height, width: rr.range(0.2, 0.8) * r.width, height: rr.range(0.2, 0.8) * r.height)
                if rr.next() < 0.5 { ctx.fillEllipse(in: e) } else { ctx.fill(e) }
            }
        }
    default:
        ctx.setFillColor(fill)
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: r.width / 5, cornerHeight: r.height / 5, transform: nil)); ctx.fillPath()
    }
}

let args = CommandLine.arguments
let items = try JSONDecoder().decode([Item].self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
let outDir = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
var fonts: [String: Set<String>] = [:]
var images: [Image] = []

struct Placed {
    let text: String; let role: String; let line: CTLine; let mask: CTLine; var x: Double; var top: Double; let w: Double
    let asc: Double; let desc: Double; let ink: CGRect
    var h: Double { asc + desc }
    var box: [Double] { [x, top, w, h].map { ($0 * 10).rounded() / 10 } }
    var rect: CGRect { CGRect(x: x, y: top, width: w, height: h) }
    /// Typographic box and glyph ink together, top-left origin: where this text can put ink.
    var reach: CGRect { rect.union(CGRect(x: x + ink.minX, y: top + asc - ink.maxY, width: ink.width, height: ink.height)) }
}

/// Deterministic per-item randomness for crop mode (mulberry32, as bench/overlap.js plans).
struct Rand {
    var s: UInt32
    mutating func next() -> Double {
        s = s &+ 0x6d2b79f5
        var t = (s ^ (s >> 15)) &* (1 | s)
        t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
        return Double((t ^ (t >> 14))) / 4294967296
    }
    mutating func range(_ a: Double, _ b: Double) -> Double { a + (b - a) * next() }
}

var descriptors: [String: CTFontDescriptor] = [:]
func fontFile(_ path: String, _ name: String?, _ wght: Double?, _ size: Double) -> CTFont? {
    let key = path + "|" + (name ?? "")
    if descriptors[key] == nil {
        guard let all = CTFontManagerCreateFontDescriptorsFromURL(URL(fileURLWithPath: path) as CFURL) as? [CTFontDescriptor] else { return nil }
        descriptors[key] = name.flatMap { n in all.first { (CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String) == n } } ?? all.first
    }
    guard var d = descriptors[key] else { return nil }
    if let w = wght { d = CTFontDescriptorCreateCopyWithVariation(d, NSNumber(value: 0x77676874), CGFloat(w)) } // 'wght'
    return CTFontCreateWithFontDescriptor(d, size, nil)
}

func color(_ r: inout Rand, dark: Bool, text: Bool) -> CGColor {
    // Text contrasts with the theme; a background stays in the theme's half.
    let lum = text ? (dark ? r.range(0.82, 1) : r.range(0, 0.3)) : (dark ? r.range(0.04, 0.3) : r.range(0.75, 1))
    let tint = r.next() < 0.5 ? 0 : r.range(0, 0.25)
    let hot = Int(r.next() * 3)
    let ch = (0..<3).map { max(0, min(1, lum + ($0 == hot ? tint : -tint / 2))) }
    return CGColor(red: ch[0], green: ch[1], blue: ch[2], alpha: 1)
}

/// Device px where two texts both have ink (alpha >= 128, outlines included), counted in 4 px cells.
func contact(_ p: Placed, _ q: Placed) -> (Int, [[Int]]) {
    contact(p.reach, q.reach, { ctx, ox, oy, h in drawMask(p, ctx, ox, oy, h) }, { ctx, ox, oy, h in drawMask(q, ctx, ox, oy, h) })
}
/// D24: device px of the text's ink inside the graphic's opaque area.
func contact(_ p: Placed, _ g: Graphic) -> (Int, [[Int]]) {
    contact(p.reach, g.rect, { ctx, ox, oy, h in drawMask(p, ctx, ox, oy, h) }, { ctx, ox, oy, h in drawGraphic(ctx, g, ox: ox, oy: oy, h: h, mask: true) })
}
func drawMask(_ t: Placed, _ ctx: CGContext, _ ox: Double, _ oy: Double, _ h: Double) {
    ctx.textPosition = CGPoint(x: t.x - ox, y: h - (t.top + t.asc - oy))
    CTLineDraw(t.mask, ctx)
}
func contact(_ ra: CGRect, _ rb: CGRect, _ da: (CGContext, Double, Double, Double) -> Void, _ db: (CGContext, Double, Double, Double) -> Void) -> (Int, [[Int]]) {
    let region = ra.insetBy(dx: -2, dy: -2).intersection(rb.insetBy(dx: -2, dy: -2)).integral
    if region.isNull || region.isEmpty { return (0, []) }
    let w = Int(region.width), h = Int(region.height)
    func mask(_ draw: (CGContext, Double, Double, Double) -> Void) -> [UInt8] {
        var buf = [UInt8](repeating: 0, count: w * h)
        buf.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
            draw(ctx, region.minX, region.minY, Double(h))
        }
        return buf
    }
    let a = mask(da), b = mask(db)
    var cells: [Int: Int] = [:], n = 0
    // Row 0 of the bitmap is the top row of the region.
    for y in 0..<h { for x in 0..<w where a[y * w + x] >= 128 && b[y * w + x] >= 128 {
        n += 1
        let cx = (Int(region.minX) + x) / 4, cy = (Int(region.minY) + y) / 4
        cells[cy * 100_000 + cx, default: 0] += 1
    } }
    return (n, cells.keys.sorted().map { [($0 % 100_000) * 4, ($0 / 100_000) * 4, 4, cells[$0]!] })
}

for it in items {
    let crop = it.font != nil || it.mode == "crop"
    let tg = it.layout == "tg"
    // 3x, a phone's scale: 1170 px wide, so Vision reads it without the 2x upscale it applies under 1000 px.
    let scale = it.scale ?? 3.0
    let W = 390.0 * scale
    var H = 600.0 * scale
    var rnd = Rand(s: UInt32(truncatingIfNeeded: it.seed ?? 0))
    let dark = it.theme == "dark"
    var skipped: String? = nil
    func fontFor(_ size: Double) -> CTFont {
        if let f = it.font {
            if let font = fontFile(f, it.fontName, it.wght, size * scale) { return font }
            skipped = skipped ?? "font file unreadable"
        }
        return CTFontCreateUIFontForLanguage(.system, size * scale, it.locale as CFString)
            ?? CTFontCreateWithName("Helvetica" as CFString, size * scale, nil)
    }
    let effect = it.effect ?? "none"
    func make(_ s: String, _ role: String, _ size: Double, _ fg: CGColor) -> Placed {
        let font = fontFor(size)
        func attrs(_ c: CGColor) -> [NSAttributedString.Key: Any] {
            var a: [NSAttributedString.Key: Any] = [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): c,
            ]
            if effect == "outline" { // fill and stroke; the stroke is part of the ink
                a[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = -6.0
                a[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = crop ? (dark ? CGColor(gray: 0, alpha: 1) : CGColor(gray: 1, alpha: 1)) : c
            }
            return a
        }
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs(fg)))
        var maskAttrs = attrs(CGColor(gray: 1, alpha: 1))
        if effect == "outline" { maskAttrs[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = CGColor(gray: 1, alpha: 1) }
        let mask = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: maskAttrs))
        var asc: CGFloat = 0, desc: CGFloat = 0
        let w = CTLineGetTypographicBounds(line, &asc, &desc, nil)
        let want = CTFontCopyPostScriptName(font) as String
        for run in CTLineGetGlyphRuns(line) as! [CTRun] {
            let f = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName as String] as! CTFont
            let ps = CTFontCopyPostScriptName(f) as String
            fonts[it.locale, default: []].insert("\(ps) \((CTFontCopyName(f, kCTFontVersionNameKey) as String?) ?? "?")")
            // D9: a crop-mode text drawn by a fallback (system) font is not drawn at all.
            if it.font != nil && ps != want { skipped = skipped ?? "font fallback: \(ps)" }
        }
        let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
        return Placed(text: s, role: role, line: line, mask: mask, x: 0, top: 0, w: w, asc: Double(asc), desc: Double(desc), ink: ink)
    }
    let fgSpec12 = dark ? CGColor(red: 0.95, green: 0.95, blue: 0.97, alpha: 1) : CGColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1)
    let fgA = crop ? color(&rnd, dark: dark, text: true) : fgSpec12
    let fgB = crop ? (rnd.next() < 0.5 ? fgA : color(&rnd, dark: dark, text: true)) : fgSpec12
    let d = it.amount * scale
    var a = make(it.a, "a", it.size, fgA), b = make(it.b, tg ? "label" : "b", it.size, fgB)
    var graphic: Graphic? = nil
    var paraPairs: [(Int, Int)] = [] // consecutive drawn lines of one paragraph, as indices in `rows`
    var icons: [(CGRect, CGColor, Bool)] = [] // rect (top-left origin), color, round
    var rows: [Placed] = []
    // The pair at `top`: returns the bottom of the block.
    func placePair(_ top: Double) -> Double {
        a.top = top
        switch it.layout {
        case "vv", "lh":
            a.x = 20 * scale
            b.x = it.layout == "lh" ? a.x : a.x + it.shift * a.w
            b.top = a.top + a.h - d
        case "hh":
            // One row: b starts `d` before a ends, on the same baseline; the pair is centered.
            let total = a.w + b.w - d
            a.x = max(10 * scale, (W - total) / 2)
            b.x = a.x + a.w - d
            b.top = a.top
            if b.x + b.w > W - 10 * scale { skipped = skipped ?? "row wider than the image" }
        case "tg": // D24: a graphic reaching `d` into a's box from `gside`; b is a plain label under the block
            let image = it.graphic == "image"
            let gh = image ? a.h * rnd.range(1.5, 3.5) : a.h * rnd.range(1.0, 2.2)
            let gw = image ? rnd.range(60, 160) * scale : gh
            var g = CGRect(x: 0, y: 0, width: gw, height: gh)
            switch it.gside ?? "left" {
            case "left":
                a.x = max(20 * scale, gw - d + 20 * scale); a.top = top + max(0, (gh - a.h) / 2)
                g.origin = CGPoint(x: a.x + d - gw, y: a.top + a.h / 2 - gh / 2)
            case "right":
                a.x = 20 * scale; a.top = top + max(0, (gh - a.h) / 2)
                g.origin = CGPoint(x: a.x + a.w - d, y: a.top + a.h / 2 - gh / 2)
            case "above":
                a.x = 20 * scale; a.top = top + gh - d
                g.origin = CGPoint(x: a.x + rnd.range(0, max(0, a.w - gw)), y: top)
            default: // below
                a.x = 20 * scale
                g.origin = CGPoint(x: a.x + rnd.range(0, max(0, a.w - gw)), y: a.top + a.h - d)
            }
            if g.maxX > W - 5 * scale { skipped = skipped ?? "graphic wider than the image" }
            let shape = image ? "image" : ["round", "rect", "ring"][Int(rnd.next() * 3)]
            graphic = Graphic(rect: g, shape: shape, color: color(&rnd, dark: !dark, text: false), over: it.gover ?? false, seed: UInt32(truncatingIfNeeded: (it.seed ?? 0) &+ 7))
            b.x = 20 * scale
            b.top = max(a.top + a.h, g.maxY) + 16 * scale
        default: // icon: a 48 px icon, its caption (a) 8 px under it, the label (b) reaching `d` into the caption
            let side = 48 * scale
            let icon = CGRect(x: 30 * scale, y: top - 50 * scale, width: side, height: side)
            icons.append((icon, CGColor(red: 0.2, green: 0.45, blue: 0.9, alpha: 1), false))
            a.x = max(10 * scale, icon.midX - a.w / 2)
            a.top = icon.maxY + 8 * scale
            b.x = a.x + it.shift * a.w
            b.top = a.top + d - b.h
        }
        if a.x + a.w > W - 5 * scale || b.x + b.w > W - 5 * scale { skipped = skipped ?? "label wider than the image" }
        return max(a.top + a.h, b.top + b.h, graphic?.rect.maxY ?? 0)
    }
    if !crop {
        _ = placePair(260 * scale)
        // Distractors: one per row, far from the pair (above 400 px and below 820 px).
        var y = 30 * scale
        for (i, s) in it.distractors.enumerated() {
            var p = make(s, "d", it.size, fgSpec12)
            p.x = (20 + Double(i % 2) * 30) * scale
            p.top = y
            if i == 1 { y = 430 * scale } else { y += p.h + 40 * scale }
            if p.x + p.w <= W - 5 * scale { rows.append(p) }
        }
    } else {
        // Crop mode: blocks stacked from the top, `gap` CSS px apart; the pair is block `pairAt`.
        let gap = (it.gap ?? 24) * scale
        var y = 24 * scale
        let extras = it.extras ?? []
        for i in 0...extras.count {
            if i == (it.pairAt ?? 0) {
                if it.layout == "icon" { y += 50 * scale }
                y = placePair(y) + gap
            }
            guard i < extras.count else { break }
            let e = extras[i]
            let fg = color(&rnd, dark: dark, text: true)
            switch e.kind {
            case "para": // lines `leading` x their height apart: tight leading, typographic boxes may overlap
                var top = y
                var prev: Int? = nil // index in `rows` of the line just above, when it was drawn
                for s in e.texts {
                    var p = make(s, "para", e.size, fg)
                    p.x = 20 * scale; p.top = top
                    top += e.overlap.map { p.h - $0 * scale } ?? (e.leading ?? 1) * p.h
                    if p.x + p.w <= W - 5 * scale {
                        rows.append(p)
                        if let i = prev { paraPairs.append((i, rows.count - 1)) }
                        prev = rows.count - 1
                    } else { prev = nil }
                }
                y = top + gap
            case "iconside": // an icon, then a label 4-12 px to its right, centered on it
                var p = make(e.texts[0], "iconside", e.size, fg)
                let side = p.h * rnd.range(0.9, 1.6)
                let ic = CGRect(x: 20 * scale, y: y, width: side, height: side)
                icons.append((ic, color(&rnd, dark: !dark, text: false), rnd.next() < 0.5))
                p.x = ic.maxX + rnd.range(4, 12) * scale
                p.top = ic.midY - p.h / 2
                if p.x + p.w <= W - 5 * scale { rows.append(p) }
                y = max(ic.maxY, p.top + p.h) + gap
            default: // "label", "title": one line
                var p = make(e.texts[0], e.kind, e.size, fg)
                p.x = (20 + rnd.range(0, 30)) * scale; p.top = y
                if p.x + p.w <= W - 5 * scale { rows.append(p) }
                y = p.top + p.h + gap
            }
        }
        H = max(200 * scale, y + 24 * scale - gap)
    }

    let width = Int(W), height = Int(H)
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    if !crop || it.bg == "solid" || it.bg == nil {
        let v = dark ? 0x1C / 255.0 : 1.0
        ctx.setFillColor(crop ? color(&rnd, dark: dark, text: false) : CGColor(red: v, green: v, blue: v, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    } else {
        let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                           colors: [color(&rnd, dark: dark, text: false), color(&rnd, dark: dark, text: false)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 0), end: CGPoint(x: W * rnd.next(), y: H), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        if it.bg == "image" { // a made-up picture: translucent shapes in the theme's half
            for _ in 0..<Int(rnd.range(12, 30)) {
                let r = CGRect(x: rnd.range(-0.2, 1) * W, y: rnd.range(-0.2, 1) * H, width: rnd.range(0.05, 0.6) * W, height: rnd.range(0.03, 0.3) * H)
                ctx.setFillColor(color(&rnd, dark: dark, text: false).copy(alpha: rnd.range(0.25, 0.6))!)
                if rnd.next() < 0.5 { ctx.fillEllipse(in: r) } else { ctx.fill(r) }
            }
        }
    }
    for (r, c, round) in icons {
        ctx.setFillColor(c)
        let flipped = CGRect(x: r.minX, y: H - r.maxY, width: r.width, height: r.height)
        if round { ctx.fillEllipse(in: flipped) } else {
            ctx.addPath(CGPath(roundedRect: flipped, cornerWidth: min(10 * scale, r.width / 4), cornerHeight: min(10 * scale, r.height / 4), transform: nil))
            ctx.fillPath()
        }
    }
    if let g = graphic, !g.over { drawGraphic(ctx, g, ox: 0, oy: 0, h: H, mask: false) }
    let all = [a, b] + rows
    if effect == "shadow" { ctx.setShadow(offset: CGSize(width: 1.5 * scale, height: -1.5 * scale), blur: 2 * scale, color: CGColor(gray: dark ? 0 : 0.3, alpha: 0.8)) }
    for p in all {
        // Core Graphics has its origin bottom left; the baseline is `asc` under the top.
        ctx.textPosition = CGPoint(x: p.x, y: H - (p.top + p.asc))
        CTLineDraw(p.line, ctx)
    }
    if let g = graphic, g.over { drawGraphic(ctx, g, ox: 0, oy: 0, h: H, mask: false) }
    let url = outDir.appendingPathComponent(it.name)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    let pair = graphic.map { contact(a, $0) } ?? contact(a, b)
    var other: [[Int]] = []
    for i in 0..<all.count { for j in (i + 1)..<max(i + 1, all.count) where !(i == 0 && j == 1 && graphic == nil) { other += contact(all[i], all[j]).1 } }
    if let g = graphic { for p in all.dropFirst() { other += contact(p, g).1 } }
    let para: [Para] = paraPairs.map { (i, j) in
        let u = rows[i], l = rows[j]
        let inkOverlap = ((u.top + u.asc - u.ink.minY) - (l.top + l.asc - l.ink.maxY)) / scale // upper ink bottom - lower ink top
        let c = contact(u, l)
        return Para(lines: [i + 2, j + 2], ink_overlap: (inkOverlap * 10).rounded() / 10, ink_px: c.0, cells: c.1)
    }
    let ovr = a.rect.intersection(graphic?.rect ?? b.rect)
    let ov: [Double]? = ovr.isNull || ovr.isEmpty ? nil : [Double(ovr.minX), Double(ovr.minY), Double(ovr.width), Double(ovr.height)].map { ($0 * 10).rounded() / 10 }
    images.append(Image(name: it.name, width: width, height: height, lines: all.map { Out(text: $0.text, role: $0.role, box: $0.box) }, skipped: skipped,
                        scale: scale, ov: ov,
                        contact: Contact(ink_px: pair.0, cells: pair.1), other_cells: other,
                        pair_kind: graphic == nil ? "text-text" : "text-graphic",
                        graphic: graphic.map { g -> [Double] in [Double(g.rect.minX), Double(g.rect.minY), Double(g.rect.width), Double(g.rect.height)].map { ($0 * 10).rounded() / 10 } }, para: para))
}
let enc = JSONEncoder()
enc.outputFormatting = [.sortedKeys]
struct Report: Encodable { let images: [Image]; let fonts: [String: [String]] }
print(String(data: try enc.encode(Report(images: images, fonts: fonts.mapValues { $0.sorted() })), encoding: .utf8)!)
