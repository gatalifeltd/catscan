// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T5a renderer: screens whose lines are runs of clean text and tofu, labeled by construction. Each line sits
// in its own element (written to <name>.boxes.json with the full intended text), as an app's text field would.
// Tofu styles: `notdef` draws glyph 0 of a named font (what Core Text draws for a font without the character and no
// fallback), `lastresort` draws the Last Resort font's glyph (Apple's per-script box), `box` strokes an empty
// rectangle (the hollow box Android draws). Clean runs use Core Text with its normal font cascade.
// Usage: swiftc -O bench/glyphs/generate.swift -o .build/glyphs-gen && .build/glyphs-gen <plan.json> <outdir>
// Prints one JSON line: {"images": N, "fonts": {"<PostScript name>": "<version>"}}.
import CoreGraphics
import CoreText
import Foundation
import ImageIO

struct Run: Decodable { let text: String; let mode: String; let font: String? } // mode: clean | notdef | lastresort | box
struct Line: Decodable { let runs: [Run]; let x: Double; let y: Double; let size: Double; let gray: Double; let rtl: Bool }
struct Shot: Decodable { let name: String; let font: String; let width: Int; let height: Int; let lines: [Line] }
struct Element: Encodable { let id: String; let box: [Double]; let text: String }
struct Boxes: Encodable { let image: [String: Int]; let elements: [Element] }

let a = CommandLine.arguments
let shots = try JSONDecoder().decode([Shot].self, from: Data(contentsOf: URL(fileURLWithPath: a[1])))
let out = URL(fileURLWithPath: a[2])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
var fontsUsed: [String: String] = [:]

func note(_ f: CTFont) {
    let name = CTFontCopyPostScriptName(f) as String
    if fontsUsed[name] == nil {
        fontsUsed[name] = (CTFontCopyName(f, kCTFontVersionNameKey) as String?) ?? "?"
    }
}

/// Draws one run at `x` (left edge) on the baseline; returns its advance. `measure` only measures.
func draw(_ r: Run, base: String, size: Double, x: Double, baseline: Double, ctx: CGContext, gray: Double, measure: Bool) -> Double {
    let color = CGColor(red: gray, green: gray, blue: gray, alpha: 1)
    switch r.mode {
    case "clean":
        let font = CTFontCreateWithName(base as CFString, size, nil)
        note(font)
        let attr = NSAttributedString(string: r.text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        ])
        let line = CTLineCreateWithAttributedString(attr)
        let w = CTLineGetTypographicBounds(line, nil, nil, nil)
        if !measure {
            ctx.textPosition = CGPoint(x: x, y: baseline)
            CTLineDraw(line, ctx)
        }
        return w
    case "box":
        let n = r.text.unicodeScalars.filter { !$0.properties.isWhitespace }.count
        let cw = size * 0.6
        if !measure {
            ctx.setStrokeColor(color)
            ctx.setLineWidth(max(1, size * 0.06))
            for i in 0..<n {
                ctx.stroke(CGRect(x: x + Double(i) * cw + size * 0.08, y: baseline, width: cw - size * 0.16, height: size * 0.72))
            }
        }
        return Double(n) * cw
    default: // notdef | lastresort: glyphs drawn one per UTF-16 unit, no fallback
        let font = CTFontCreateWithName((r.mode == "lastresort" ? "LastResort" : (r.font ?? base)) as CFString, size, nil)
        note(font)
        let chars = Array(r.text.utf16)
        var glyphs = [CGGlyph](repeating: 0, count: chars.count)
        if r.mode == "lastresort" { _ = CTFontGetGlyphsForCharacters(font, chars, &glyphs, chars.count) }
        var adv = [CGSize](repeating: .zero, count: glyphs.count)
        CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &adv, glyphs.count)
        var pos: [CGPoint] = []
        var cx = x
        for (i, g) in adv.enumerated() {
            // A space stays a space: only letters, signs and marks become boxes.
            let w = chars[i] == 0x20 ? size * 0.28 : max(g.width, size * 0.3)
            pos.append(CGPoint(x: cx, y: baseline)); cx += w
        }
        if !measure {
            ctx.setFillColor(color)
            let keep = chars.indices.filter { chars[$0] != 0x20 }
            CTFontDrawGlyphs(font, keep.map { glyphs[$0] }, keep.map { pos[$0] }, keep.count, ctx)
        }
        return cx - x
    }
}

for s in shots {
    let ctx = CGContext(
        data: nil, width: s.width, height: s.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: s.width, height: s.height))
    var elements: [Element] = []
    let W = Double(s.width), H = Double(s.height)
    for (i, l) in s.lines.enumerated() {
        let baseline = H - l.y - l.size
        let widths = l.runs.map { draw($0, base: s.font, size: l.size, x: 0, baseline: 0, ctx: ctx, gray: l.gray, measure: true) }
        let total = widths.reduce(0, +)
        // Right to left: logical runs are laid out from the right edge leftwards.
        var x = l.rtl ? W - l.x - total : l.x
        let order = l.rtl ? Array(l.runs.indices.reversed()) : Array(l.runs.indices)
        for k in order {
            _ = draw(l.runs[k], base: s.font, size: l.size, x: x, baseline: baseline, ctx: ctx, gray: l.gray, measure: false)
            x += widths[k]
        }
        let pad = l.size * 0.4, top = l.y - l.size * 0.35, h = l.size * 1.7
        let x0 = (l.rtl ? W - l.x - total : l.x) - pad
        let box = [x0 / W, top / H, (total + 2 * pad) / W, h / H].map { ($0 * 10000).rounded() / 10000 }
        elements.append(Element(id: "e\(i)", box: box, text: l.runs.map(\.text).joined()))
    }
    let dest = CGImageDestinationCreateWithURL(out.appendingPathComponent(s.name) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    let stem = (s.name as NSString).deletingPathExtension
    try JSONEncoder().encode(Boxes(image: ["width": s.width, "height": s.height], elements: elements))
        .write(to: out.appendingPathComponent(stem + ".boxes.json"))
}
let summary: [String: Any] = ["images": shots.count, "fonts": fontsUsed]
print(String(data: try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]), encoding: .utf8)!)
