// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Synthetic test images with known text, drawn with Core Text. Labeled by construction.
// Usage: swiftc -O test/fixtures/generate.swift -o .build/synth && .build/synth <synthetic.json> <outdir>
// A stand-in for the benchmark generator (spec 05) until it exists.
import CoreGraphics
import CoreText
import Foundation
import ImageIO

// `font` (TODO-031): a PostScript name that overrides the locale font, for weight studies.
// `cut` (spec 06): the line sits in a clipping element as wide as `cut` x its measured width (below 1: cut off;
// 1 or more: fits, with padding on both sides). The element is written to <name>.boxes.json with `full` (or the
// text) as its displayed string, so the set is labeled by construction, boxes included.
// `over` (TODO-036): the text is drawn whole, unclipped, and its element ends `over` x the font size before the
// text's trailing end (`align: "center"`: before both ends); `clips` is written to the element as given.
// TODO-044: `overFrac` sets that distance as a share of the text's width instead; `container` adds an undrawn parent
// element around the whole text (its `text` is `containerText`, none when absent); `icon` adds an undrawn textless
// element over the text's start (`"start"`) or under its center (`"center"`), smaller than the label's element.
struct Line: Decodable {
    let text: String; let x: Double; let y: Double; let size: Double; let cut: Double?; let full: String?; let font: String?
    let over: Double?; let align: String?; let clips: Bool?
    let overFrac: Double?; let container: Bool?; let containerText: String?; let icon: String?
}
struct Element: Encodable { let id: String; let box: [Double]; let text: String?; var clips: Bool? = nil }
struct Boxes: Encodable { let image: [String: Int]; let elements: [Element] }
// `crop`: the image is cut to the first element, so the image is the container (the study's no-box set).
struct Shot: Decodable { let name: String; let locale: String; let width: Int; let height: Int; let lines: [Line]; let crop: Bool? }

let fonts: [String: String] = [
    "ja": "Hiragino Sans", "zh": "PingFang SC", "ko": "Apple SD Gothic Neo", "th": "Thonburi",
    // Fallback locales (spec 03); Core Text cascades to a system font for Georgian and Armenian.
    "he": "Arial Hebrew", "fa": "Geeza Pro",
]

let a = CommandLine.arguments
let shots = try JSONDecoder().decode([Shot].self, from: Data(contentsOf: URL(fileURLWithPath: a[1])))
let out = URL(fileURLWithPath: a[2])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

for s in shots {
    let ctx = CGContext(
        data: nil, width: s.width, height: s.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: s.width, height: s.height))
    let base = String(s.locale.split(separator: "-")[0])
    var elements: [Element] = []
    for (i, l) in s.lines.enumerated() {
        ctx.saveGState()
        let font = CTFontCreateWithName((l.font ?? fonts[base] ?? "Helvetica") as CFString, l.size, nil)
        let attr = NSAttributedString(string: l.text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1),
        ])
        let line = CTLineCreateWithAttributedString(attr)
        let rtl = ["ar", "he", "fa", "ur"].contains(base)
        if let over = l.over {
            let w = CTLineGetTypographicBounds(line, nil, nil, nil)
            let pad = l.size * 0.4, o = l.overFrac.map { $0 * w } ?? over * l.size
            let top = l.y - l.size * 0.35, h = l.size * 1.7
            // Start-aligned: the element starts `pad` before the text's leading end and stops `o` short of its trailing end.
            let (x0, width) = l.align == "center" ? (l.x + o, w - 2 * o) : rtl ? (l.x + o, w - o + pad) : (l.x - pad, pad + w - o)
            precondition(width > l.size, "\(s.name): text too short for over \(over)")
            let r = CGRect(x: x0, y: Double(s.height) - top - h, width: width, height: h)
            ctx.setFillColor(CGColor(red: 0.95, green: 0.95, blue: 0.96, alpha: 1))
            ctx.fill(r)
            let W = Double(s.width), H = Double(s.height)
            let box = { (x: Double, y: Double, w: Double, h: Double) in [x / W, y / H, w / W, h / H].map { ($0 * 10000).rounded() / 10000 } }
            elements.append(Element(id: "e\(i)", box: box(x0, top, width, h), text: l.full ?? l.text, clips: l.clips))
            if l.container == true {
                elements.append(Element(id: "c\(i)", box: box(l.x - l.size, top - l.size * 0.5, w + 2 * l.size, h + l.size), text: l.containerText))
            }
            if let icon = l.icon {
                // Start: from before the text's leading end over 40% of its width; center: 1.5 font sizes wide.
                let iw = icon == "start" ? l.size * 0.3 + w * 0.4 : l.size * 1.5
                let ix = icon == "start" ? (rtl ? l.x + w - w * 0.4 : l.x - l.size * 0.3) : l.x + (w - iw) / 2
                precondition(iw < width, "\(s.name): icon not smaller than the label's element")
                elements.append(Element(id: "i\(i)", box: box(ix, top, iw, h), text: nil))
            }
        } else if let cut = l.cut {
            let w = CTLineGetTypographicBounds(line, nil, nil, nil)
            let pad = l.size * 0.4
            let top = l.y - l.size * 0.35, h = l.size * 1.7
            let width = cut >= 1 ? pad + w * cut + pad : pad + w * cut
            // Right to left, the trailing end is the left one: a cut removes the start of the drawn line.
            let x0 = rtl && cut < 1 ? l.x + w * (1 - cut) : l.x - pad
            let r = CGRect(x: x0, y: Double(s.height) - top - h, width: width, height: h)
            ctx.setFillColor(CGColor(red: 0.95, green: 0.95, blue: 0.96, alpha: 1)) // the element's background
            ctx.fill(r)
            ctx.clip(to: r)
            let W = Double(s.width), H = Double(s.height)
            elements.append(Element(
                id: "e\(i)", box: [x0 / W, top / H, width / W, h / H].map { ($0 * 10000).rounded() / 10000 },
                text: l.full ?? l.text))
        }
        // `y` is the top of the text from the top of the image; Core Graphics has its origin bottom left.
        ctx.textPosition = CGPoint(x: l.x, y: Double(s.height) - l.y - l.size)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }
    let dest = CGImageDestinationCreateWithURL(
        out.appendingPathComponent(s.name) as CFURL, "public.png" as CFString, 1, nil)!
    var img = ctx.makeImage()!
    if s.crop == true, let e = elements.first {
        let W = Double(s.width), H = Double(s.height)
        img = img.cropping(to: CGRect(x: e.box[0] * W, y: e.box[1] * H, width: e.box[2] * W, height: e.box[3] * H).integral)!
        elements = []
    }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    if !elements.isEmpty {
        let stem = (s.name as NSString).deletingPathExtension
        try JSONEncoder().encode(Boxes(image: ["width": s.width, "height": s.height], elements: elements))
            .write(to: out.appendingPathComponent(stem + ".boxes.json"))
    }
}
print("wrote \(shots.count) images to \(out.path)")
