// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Synthetic screens for bench/safe-area.js (TODO-073 "Measurement"): text lines and icon buttons placed by their
// ink edges, so the plan can push ink exactly N px into a profile zone. Writes <name>.png, <name>.boxes.json (one
// element per line and icon; icons are textless controls) and <name>.truth.json (every glyph's ink rect).
// Usage: swiftc -O bench/safe-area/generate.swift -o .build/safe-area-gen && .build/safe-area-gen <plan.json> <outdir>
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Item: Decodable {
    let id: String
    let text: String? // nil: an icon button (a filled rounded square)
    let size: Double // font size, or the icon's side
    // Ink anchor in pixels (top-left origin): exactly one of left/right/centerX and one of top/bottom/centerY.
    let left: Double?; let right: Double?; let centerX: Double?
    let top: Double?; let bottom: Double?; let centerY: Double?
}
struct Shot: Decodable { let name: String; let locale: String; let width: Int; let height: Int; let background: String; let items: [Item]; let seed: Int }
struct Glyph: Encodable { let ch: String; let rect: [Double] }
struct TruthItem: Encodable { let id: String; let text: String?; let ink: [Double]; let glyphs: [Glyph] }
struct Element: Encodable { let id: String; let box: [Double]; let text: String?; let control: Bool? }
struct Boxes: Encodable { let image: [String: Int]; let elements: [Element] }

let fonts: [String: String] = ["ja": "Hiragino Sans", "zh": "PingFang SC", "ko": "Apple SD Gothic Neo", "th": "Thonburi", "he": "Arial Hebrew", "ar": "Geeza Pro", "fa": "Geeza Pro"]
let a = CommandLine.arguments
let shots = try JSONDecoder().decode([Shot].self, from: Data(contentsOf: URL(fileURLWithPath: a[1])))
let out = URL(fileURLWithPath: a[2])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func font(_ locale: String, _ size: Double) -> CTFont {
    CTFontCreateWithName((fonts[String(locale.prefix(2))] ?? "Helvetica Neue") as CFString, size, nil)
}

/// A seeded generator, so a plan draws the same pixels every run.
struct LCG { var s: UInt64; mutating func next() -> Double { s = s &* 6364136223846793005 &+ 1442695040888963407; return Double(s >> 11) / Double(1 << 53) } }

for shot in shots {
    let W = shot.width, H = shot.height
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    var rng = LCG(s: UInt64(shot.seed) &+ 1)
    // Backgrounds: plain light, a vertical gradient, or light photo-like noise blocks.
    switch shot.background {
    case "gradient":
        let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [CGColor(red: 0.98, green: 0.95, blue: 0.85, alpha: 1), CGColor(red: 0.82, green: 0.9, blue: 0.98, alpha: 1)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: 0, y: H), options: [])
    case "noise":
        ctx.setFillColor(CGColor(red: 0.93, green: 0.93, blue: 0.93, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        let step = 24
        for y in stride(from: 0, to: H, by: step) { for x in stride(from: 0, to: W, by: step) {
            let v = 0.82 + 0.16 * rng.next()
            ctx.setFillColor(CGColor(red: v, green: v * (0.96 + 0.04 * rng.next()), blue: v * (0.94 + 0.06 * rng.next()), alpha: 1))
            ctx.fill(CGRect(x: x, y: y, width: step, height: step))
        } }
    default:
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    }
    var truth: [TruthItem] = [], elements: [Element] = []
    for it in shot.items {
        // Ink size first, then the origin that puts the ink where the anchor says.
        var inkW = it.size, inkH = it.size, inkX0 = 0.0, inkTopFromBaseline = 0.0
        var line: CTLine? = nil
        if let t = it.text {
            let attr = NSAttributedString(string: t, attributes: [kCTFontAttributeName as NSAttributedString.Key: font(shot.locale, it.size),
                                                                  kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(red: 0.08, green: 0.08, blue: 0.1, alpha: 1)])
            let l = CTLineCreateWithAttributedString(attr)
            ctx.textPosition = .zero // drawing advances it, and the image bounds are offset by it
            let b = CTLineGetImageBounds(l, ctx)
            inkW = Double(b.width); inkH = Double(b.height); inkX0 = Double(b.minX); inkTopFromBaseline = Double(b.maxY)
            line = l
        }
        let left = it.left ?? (it.right.map { $0 - inkW }) ?? ((it.centerX ?? 0) - inkW / 2)
        let top = it.top ?? (it.bottom.map { $0 - inkH }) ?? ((it.centerY ?? 0) - inkH / 2)
        var glyphs: [Glyph] = []
        if let l = line {
            // Core Graphics has a bottom-left origin: the baseline sits inkTop below the ink's top edge.
            let ox = left - inkX0, baseline = Double(H) - top - inkTopFromBaseline
            ctx.textPosition = CGPoint(x: ox, y: baseline)
            CTLineDraw(l, ctx)
            // Glyph ink boxes from the font and the glyph positions, independent of the context's text position.
            let baseTop = Double(H) - baseline // the baseline's y from the top
            for run in CTLineGetGlyphRuns(l) as! [CTRun] {
                let n = CTRunGetGlyphCount(run)
                var idx = [CFIndex](repeating: 0, count: n), glyphIDs = [CGGlyph](repeating: 0, count: n), pos = [CGPoint](repeating: .zero, count: n)
                CTRunGetStringIndices(run, CFRange(location: 0, length: n), &idx)
                CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphIDs)
                CTRunGetPositions(run, CFRange(location: 0, length: n), &pos)
                let attrs = CTRunGetAttributes(run) as NSDictionary
                let runFont = attrs[kCTFontAttributeName as String] as! CTFont
                var rects = [CGRect](repeating: .zero, count: n)
                CTFontGetBoundingRectsForGlyphs(runFont, .horizontal, glyphIDs, &rects, n)
                let str = it.text! as NSString
                for g in 0..<n {
                    let r = rects[g]
                    guard r.width > 0, r.height > 0 else { continue }
                    let ch = str.substring(with: str.rangeOfComposedCharacterSequence(at: idx[g]))
                    glyphs.append(Glyph(ch: ch, rect: [ox + Double(pos[g].x + r.minX), baseTop - Double(pos[g].y + r.maxY), Double(r.width), Double(r.height)]))
                }
            }
        } else {
            ctx.setFillColor(CGColor(red: 0.2, green: 0.25, blue: 0.3, alpha: 1))
            let r = CGRect(x: left, y: Double(H) - top - inkH, width: inkW, height: inkH)
            ctx.addPath(CGPath(roundedRect: r, cornerWidth: inkW * 0.22, cornerHeight: inkH * 0.22, transform: nil)); ctx.fillPath()
        }
        truth.append(TruthItem(id: it.id, text: it.text, ink: [left, top, inkW, inkH], glyphs: glyphs))
        // The element: the ink plus 15% padding (a touch target), clipped to the screen.
        let p = it.text == nil ? inkW * 0.15 : inkH * 0.15
        let x0 = max(0, left - p), y0 = max(0, top - p), x1 = min(Double(W), left + inkW + p), y1 = min(Double(H), top + inkH + p)
        if x1 > x0 && y1 > y0 {
            elements.append(Element(id: it.id, box: [x0 / Double(W), y0 / Double(H), (x1 - x0) / Double(W), (y1 - y0) / Double(H)].map { ($0 * 10000).rounded() / 10000 },
                                    text: it.text, control: it.text == nil ? true : nil))
        }
    }
    let img = ctx.makeImage()!
    let dest = CGImageDestinationCreateWithURL(out.appendingPathComponent("\(shot.name).png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    let enc = JSONEncoder()
    try enc.encode(truth).write(to: out.appendingPathComponent("\(shot.name).truth.json"))
    try enc.encode(Boxes(image: ["width": W, "height": H], elements: elements)).write(to: out.appendingPathComponent("\(shot.name).boxes.json"))
}
