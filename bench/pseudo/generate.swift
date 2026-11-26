// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-039 T2 gate renderer: one PNG per planned screen, its text items drawn with Core Text. Labeled by construction
// (bench/pseudo.js plans every item and its expected verdict); deterministic for one macOS build.
// Usage: swiftc -O bench/pseudo/generate.swift -o .build/pseudo-gen && .build/pseudo-gen <plan.json> <outdir>
// Prints one JSON line per screen: {"name", "items": [{"id", "box": [x, y, w, h] normalized, origin top left}]},
// then {"fonts": ["<PostScript name> <version>", ...]}.
import CoreGraphics
import CoreText
import Foundation
import ImageIO

struct Item: Decodable {
    let id: String
    let text: String
    let x: Double, y: Double, w: Double
    let size: Double
    let align: String // left | center | right
    let wrap: Bool // true: wrap within w (a paragraph); false: one line
    let keep: Int? // one line clipped after this many characters (cut end, D14)
    let drop: Int? // one line with this many leading characters hidden (cut start)
    let ellipsis: Bool
    let contrast: Double // 1: full; lower: a faint line (a `]` hard to read)
    let panel: Bool // drawn on a system alert panel
}
struct Screen: Decodable { let name: String; let width: Double; let height: Double; let scale: Double; let theme: String; let font: String; let items: [Item] }

let a = CommandLine.arguments
let screens = try JSONDecoder().decode([Screen].self, from: Data(contentsOf: URL(fileURLWithPath: a[1])))
let out = URL(fileURLWithPath: a[2])
var fonts = Set<String>()

func font(_ name: String, _ px: Double) -> CTFont {
    let f: CTFont = name == "SF"
        ? CTFontCreateUIFontForLanguage(.system, px, "en" as CFString)!
        : CTFontCreateWithName(name as CFString, px, nil)
    let ver = (CTFontCopyName(f, kCTFontVersionNameKey) as String?) ?? "?"
    fonts.insert("\(CTFontCopyPostScriptName(f) as String) \(ver)")
    return f
}

for s in screens {
    let W = Int(s.width * s.scale), H = Int(s.height * s.scale)
    let ctx = CGContext(
        data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let dark = s.theme == "dark"
    let bg = dark ? 0.08 : 0.98
    ctx.setFillColor(CGColor(red: bg, green: bg, blue: bg, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    var boxes: [[String: Any]] = []
    // Points, origin top left -> pixels, origin bottom left.
    func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
        CGRect(x: x * s.scale, y: Double(H) - (y + h) * s.scale, width: w * s.scale, height: h * s.scale)
    }
    let panels = s.items.filter(\.panel)
    if let top = panels.map(\.y).min(), let bottom = panels.map({ $0.y + $0.size * 2.2 }).max() {
        let p = dark ? 0.2 : 0.9
        ctx.setFillColor(CGColor(red: p, green: p, blue: p, alpha: 1))
        ctx.addPath(CGPath(roundedRect: rect(40, top - 16, s.width - 80, bottom - top + 24), cornerWidth: 14 * s.scale, cornerHeight: 14 * s.scale, transform: nil))
        ctx.fillPath()
    }
    for it in s.items {
        let px = it.size * s.scale
        let f = font(s.font, px)
        let ink = dark ? 0.95 : 0.07
        let v = ink * it.contrast + bg * (1 - it.contrast)
        let attrs: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): f,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: v, green: v, blue: v, alpha: 1),
        ]
        let str = NSAttributedString(string: it.text, attributes: attrs)
        if it.wrap {
            let fs = CTFramesetterCreateWithAttributedString(str)
            let size = CTFramesetterSuggestFrameSizeWithConstraints(fs, CFRange(), nil, CGSize(width: it.w * s.scale, height: .greatestFiniteMagnitude), nil)
            let h = Double(size.height) / s.scale
            let frame = CTFramesetterCreateFrame(fs, CFRange(), CGPath(rect: rect(it.x, it.y, it.w, h + 2), transform: nil), nil)
            CTFrameDraw(frame, ctx)
            boxes.append(["id": it.id, "box": [it.x / s.width, it.y / s.height, it.w / s.width, (h + 2) / s.height]])
            continue
        }
        var line = CTLineCreateWithAttributedString(str)
        let full = Double(CTLineGetTypographicBounds(line, nil, nil, nil)) / s.scale
        var visible = min(full, it.w)
        var shift = 0.0 // points the line is moved left (a hidden start)
        if it.ellipsis {
            let token = CTLineCreateWithAttributedString(NSAttributedString(string: "\u{2026}", attributes: attrs))
            line = CTLineCreateTruncatedLine(line, it.w * s.scale, .end, token) ?? line
            visible = Double(CTLineGetTypographicBounds(line, nil, nil, nil)) / s.scale
        }
        let ns = it.text as NSString
        // Clipping cuts through the next glyph at 45% of its width, as a narrow frame does.
        func offset(_ i: Int) -> Double { Double(CTLineGetOffsetForStringIndex(line, i, nil)) / s.scale }
        if let k = it.keep, k < ns.length {
            visible = offset(k) + 0.45 * (offset(min(k + 1, ns.length)) - offset(k))
        }
        if let d = it.drop, d > 0, d < ns.length {
            shift = offset(d) - 0.45 * (offset(d) - offset(d - 1))
            visible = full - shift
        }
        let x0 = it.align == "center" ? it.x + (it.w - visible) / 2 : it.align == "right" ? it.x + it.w - visible : it.x
        let lh = it.size * 1.45
        ctx.saveGState()
        ctx.clip(to: rect(x0, it.y, visible, lh))
        ctx.textPosition = CGPoint(x: (x0 - shift) * s.scale, y: Double(H) - (it.y + it.size * 1.15) * s.scale)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
        boxes.append(["id": it.id, "box": [x0 / s.width, it.y / s.height, visible / s.width, lh / s.height]])
    }
    let url = out.appendingPathComponent(s.name + ".png")
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    let line = try JSONSerialization.data(withJSONObject: ["name": s.name, "items": boxes], options: [.sortedKeys])
    print(String(data: line, encoding: .utf8)!)
}
print(String(data: try JSONSerialization.data(withJSONObject: ["fonts": fonts.sorted()]), encoding: .utf8)!)
