// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-031 audit renderer: game-UI text styles that break OCR of raw keys. Labeled by construction.
// Usage: swiftc -O bench/rawkey-audit/render.swift -o .build/rawkey-render && .build/rawkey-render <shots.json> <outdir>
// Each line: a PostScript font, a fill (flat or vertical gradient), an optional stroke, shadow or glow, letter-spacing,
// and an optional box width that cuts the line with an ellipsis. Each shot: a flat, low-contrast or textured background.
import CoreGraphics
import CoreText
import Foundation
import ImageIO

struct Line: Decodable {
    let text: String; let x: Double; let y: Double; let size: Double; let font: String
    let color: [Double]?; let gradient: [Double]? // [r,g,b, r,g,b]: top to bottom
    let stroke: Double?; let strokeColor: [Double]? // stroke width in % of the font size, as kCTStrokeWidthAttributeName
    let shadow: Double?; let glow: Double? // blur radius in points; shadow is offset down-right, glow is centered
    let effectColor: [Double]?
    let kern: Double? // letter-spacing in points
    let ellipsisWidth: Double? // cut to this width with a trailing "…" (Core Text truncation)
}
struct Shot: Decodable { let name: String; let width: Int; let height: Int; let background: String; let bg: [Double]?; let lines: [Line] }

func color(_ c: [Double]?, _ d: [Double]) -> CGColor { let v = c ?? d; return CGColor(red: v[0], green: v[1], blue: v[2], alpha: 1) }

/// FNV-1a seed from the shot name, so a textured background is the same in every run.
func seed(_ s: String) -> UInt64 { var h: UInt64 = 0xcbf29ce484222325; for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }; return h }
struct SplitMix { var s: UInt64; mutating func next() -> Double { s = s &+ 0x9e3779b97f4a7c15; var z = s; z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9; z = (z ^ (z >> 27)) &* 0x94d049bb133111eb; return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53) } }

let a = CommandLine.arguments
let shots = try JSONDecoder().decode([Shot].self, from: Data(contentsOf: URL(fileURLWithPath: a[1])))
let out = URL(fileURLWithPath: a[2])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

for s in shots {
    let W = Double(s.width), H = Double(s.height)
    let ctx = CGContext(
        data: nil, width: s.width, height: s.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(color(s.bg, [1, 1, 1]))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    if s.background == "texture" {
        // Busy game background: overlapping translucent blobs and stripes in many colors.
        var r = SplitMix(s: seed(s.name))
        for _ in 0..<160 {
            ctx.setFillColor(CGColor(red: r.next(), green: r.next(), blue: r.next(), alpha: 0.35))
            let w = 20 + r.next() * 160, h = 20 + r.next() * 160
            ctx.fillEllipse(in: CGRect(x: r.next() * W - w / 2, y: r.next() * H - h / 2, width: w, height: h))
        }
        for i in stride(from: 0.0, to: W + H, by: 18) {
            ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.12))
            ctx.setLineWidth(3)
            ctx.move(to: CGPoint(x: i, y: 0)); ctx.addLine(to: CGPoint(x: i - H, y: H)); ctx.strokePath()
        }
    }
    for l in s.lines {
        ctx.saveGState()
        let font = CTFontCreateWithName(l.font as CFString, l.size, nil)
        var attrs: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(l.color, [0.07, 0.07, 0.07]),
        ]
        if let k = l.kern { attrs[NSAttributedString.Key(kCTKernAttributeName as String)] = k }
        if let sw = l.stroke {
            attrs[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = -sw // negative: fill and stroke
            attrs[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = color(l.strokeColor, [0, 0, 0])
        }
        func make(_ at: [NSAttributedString.Key: Any]) -> CTLine {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: l.text, attributes: at))
            guard let w = l.ellipsisWidth else { return line }
            let tok = CTLineCreateWithAttributedString(NSAttributedString(string: "\u{2026}", attributes: at))
            return CTLineCreateTruncatedLine(line, w, .end, tok) ?? line
        }
        // A stroke attribute overrides the clip drawing mode, so a gradient clips with an unstroked line.
        var plain = attrs
        plain[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = nil
        let line = make(l.gradient == nil ? attrs : plain)
        let y = H - l.y - l.size // the line's baseline, top-left coordinates in the manifest
        ctx.textPosition = CGPoint(x: l.x, y: y)
        if let b = l.shadow { ctx.setShadow(offset: CGSize(width: b * 0.6, height: -b * 0.6), blur: b, color: color(l.effectColor, [0, 0, 0])) }
        if let b = l.glow { ctx.setShadow(offset: .zero, blur: b, color: color(l.effectColor, [1, 0.85, 0.2])) }
        if let g = l.gradient {
            // Gradient fill: the glyphs become the clip, then the gradient is painted through them.
            ctx.setTextDrawingMode(.clip)
            CTLineDraw(line, ctx)
            let cs = CGColorSpace(name: CGColorSpace.sRGB)!
            let grad = CGGradient(colorsSpace: cs, colors: [color(Array(g[0..<3]), [1, 1, 1]), color(Array(g[3..<6]), [0, 0, 0])] as CFArray, locations: [0, 1])!
            ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: y + l.size), end: CGPoint(x: 0, y: y - l.size * 0.25), options: [])
            if let sw = l.stroke {
                ctx.restoreGState()
                ctx.saveGState()
                ctx.textPosition = CGPoint(x: l.x, y: y)
                var outline = plain
                outline[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = sw // positive: stroke only
                outline[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = color(l.strokeColor, [0, 0, 0])
                CTLineDraw(make(outline), ctx)
            }
        } else {
            CTLineDraw(line, ctx)
        }
        ctx.restoreGState()
    }
    let img = ctx.makeImage()!
    let dest = CGImageDestinationCreateWithURL(out.appendingPathComponent(s.name) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
}
print("{\"images\": \(shots.count)}")
