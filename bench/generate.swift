// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 05 renderer: one PNG per planned image, the image being the text's box (the container), drawn with Core Text
// in the macOS system UI font for the language (D1). Labeled by construction; deterministic for one macOS build.
// Usage: swiftc -O bench/generate.swift -o .build/bench-gen && .build/bench-gen <plan.json> <outdir>
// Prints one JSON line: {"images": N, "fonts": {"<locale>": ["<PostScript name> <version>", ...]}}.
import CoreGraphics
import CoreText
import Foundation
import ImageIO

// case: fit | ellipsis | clip. size: CSS px (drawn at scale 3). theme: light | dark. background: flat | gradient.
struct Item: Decodable { let name: String; let locale: String; let text: String; let `case`: String; let size: Double; let theme: String; let background: String; let rtl: Bool }

let scale = 3.0
let cutRatio = 0.6 // ellipsis and clip boxes are 0.6 x the line width (spec 05 "Rendering")

/// FNV-1a: a stable seed from the image name; Swift's hashValue changes per process (spec 05 D-noise).
func fnv1a(_ s: String) -> UInt64 {
    var h: UInt64 = 0xcbf29ce484222325
    for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
    return h
}
struct SplitMix { var s: UInt64; mutating func next() -> UInt64 { s = s &+ 0x9e3779b97f4a7c15; var z = s; z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9; z = (z ^ (z >> 27)) &* 0x94d049bb133111eb; return z ^ (z >> 31) } }

func rgb(_ v: Double) -> CGColor { CGColor(red: v, green: v, blue: v, alpha: 1) }

let a = CommandLine.arguments
let items = try JSONDecoder().decode([Item].self, from: Data(contentsOf: URL(fileURLWithPath: a[1])))
let out = URL(fileURLWithPath: a[2])
var fonts: [String: Set<String>] = [:]

for it in items {
    let px = it.size * scale
    let lang = it.locale as CFString
    let font = CTFontCreateUIFontForLanguage(.system, px, lang) ?? CTFontCreateWithName("Helvetica" as CFString, px, nil)
    let dark = it.theme == "dark"
    let fg = dark ? CGColor(red: 0.95, green: 0.95, blue: 0.97, alpha: 1) : CGColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1)
    let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): fg,
    ]
    // A CTLine ignores a paragraph style's base direction, so right to left is forced through the typesetter's
    // embedding level; truncation at .end then cuts the logical end, which is drawn on the left.
    func makeLine(_ s: String) -> CTLine {
        let opts = [kCTTypesetterOptionForcedEmbeddingLevel: NSNumber(value: it.rtl ? 1 : 0)] as CFDictionary
        let ts = CTTypesetterCreateWithAttributedStringAndOptions(NSAttributedString(string: s, attributes: attrs), opts)!
        return CTTypesetterCreateLine(ts, CFRange(location: 0, length: 0))
    }
    let full = makeLine(it.text)
    let w = CTLineGetTypographicBounds(full, nil, nil, nil)
    let pad = (px * 0.4).rounded()
    // The box: fit = padding + line + padding; cut cases = leading padding + 0.6 x line, the trailing edge cutting it.
    let inner = it.case == "fit" ? w : (w * cutRatio).rounded(.down)
    let width = Int((it.case == "fit" ? pad + inner + pad : pad + inner).rounded(.up))
    let height = Int((px * 1.7).rounded())
    var line = full
    if it.case == "ellipsis" {
        let token = makeLine("\u{2026}")
        line = CTLineCreateTruncatedLine(full, inner, .end, token) ?? full
    }
    let lw = CTLineGetTypographicBounds(line, nil, nil, nil)
    for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let f = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName as String] as! CTFont
        let name = CTFontCopyPostScriptName(f) as String
        let version = (CTFontCopyName(f, kCTFontVersionNameKey) as String?) ?? "?"
        fonts[it.locale, default: []].insert("\(name) \(version)")
    }

    let ctx = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let bg = dark ? 0x1C / 255.0 : 1.0
    if it.background == "flat" {
        ctx.setFillColor(rgb(bg)); ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    } else {
        // Gradient: 12% toward the opposite theme across the box, plus +-8 levels of seeded noise per channel.
        let buf = ctx.data!.bindMemory(to: UInt8.self, capacity: width * height * 4)
        var rng = SplitMix(s: fnv1a(it.name))
        let to = dark ? bg + 0.12 * (1 - bg) : bg - 0.12
        for y in 0..<height { for x in 0..<width {
            let t = Double(x) / Double(max(1, width - 1))
            let base = (bg + (to - bg) * t) * 255
            let o = (y * width + x) * 4
            for c in 0..<3 { buf[o + c] = UInt8(max(0, min(255, base + Double(Int(rng.next() % 17) - 8)))) }
            buf[o + 3] = 255
        } }
    }
    // Baseline so the line sits centered vertically; Core Graphics has its origin bottom left.
    var asc: CGFloat = 0, desc: CGFloat = 0
    _ = CTLineGetTypographicBounds(full, &asc, &desc, nil)
    let y = (Double(height) - Double(asc + desc)) / 2 + Double(desc)
    // The line starts after the leading padding: the left one, or for right to left the right one, so a cut line
    // runs past the trailing edge (right, or left for right to left).
    let x = it.rtl && it.case != "fit" ? Double(width) - pad - lw : pad
    ctx.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, ctx)

    let url = out.appendingPathComponent(it.name)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
}
let report: [String: Any] = ["images": items.count, "fonts": fonts.mapValues { $0.sorted() }]
print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
