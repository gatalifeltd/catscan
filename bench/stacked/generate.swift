// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-067 synthetic set (D8): a sheet of pages (title, subtitle, counter, button) with 1-3 pages drawn at the same place or
// offset by a share of the title's line height, plus clean and hard-negative controls (drop shadow, outline), on
// plain, dark, checker and mosaic backgrounds, in 13 locales of bench/untranslated/strings.json, with the macOS system
// UI font. Its own seed per image, so spec 12's generator and items are untouched. Labeled by construction: each
// image's title, subtitle, counter and button boxes and whether each is stacked. TODO-072 D4: each image also gets
// <name>.boxes.json, one element per page's drawn line (images and labels.json unchanged).
// Usage (from the repo root): swiftc -O bench/stacked/generate.swift -o <bin> && <bin> <outdir> [--only <text>] [--tall]
//   --only draws only the images whose name contains one of the comma-separated <text>s (test goldens); --tall puts 3800 px of paper above the
//   sheet, so catscan reads the image in tiles (TODO-067 D2).
//   writes <outdir>/<locale>/<NNNN-kind-bg-offset>.png and <outdir>/labels.json; even NNNN is the dev half.
import AppKit
import CoreText
import Foundation

func writePNG(_ img: CGImage, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: img)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

struct Rand: RandomNumberGenerator { var s: UInt64; mutating func next() -> UInt64 { s = s &* 6364136223846793005 &+ 1442695040888963407; return s }; mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) } }

func r3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

struct Region: Encodable { let role: String; let stacked: Bool; let box: [Double] }
/// TODO-072 D4: one element per drawn line of each page, as an app's element dump gives it (`overlap --boxes` sidecar).
struct Element: Encodable { let id: String; let box: [Double]; let text: String; let clips: Bool }
struct Sidecar: Encodable { let image: [String: Int]; let elements: [Element] }
struct Label: Encodable { let file: String; let locale: String; let kind: String; let bg: String; let offset: Double; let pages: Int; let regions: [Region] }

var only: [String]? = nil
var paperAbove = 0 // --tall

func synth(_ out: String) {
    let corpus = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "bench/untranslated/strings.json"))) as! [String: Any]
    let locs = corpus["locales"] as! [String: [String]]
    let locales = ["en", "de", "fr", "es", "it", "pt-BR", "pl", "tr", "ru", "uk", "ja", "ko", "zh-Hans"]
    // kind: pages drawn at the same place (1 = clean), offset as a share of the title's line height.
    let kinds: [(String, Int, Double)] = [("clean", 1, 0), ("shadow", 1, 0), ("outline", 1, 0), ("stack2", 2, 0), ("stack2", 2, 0.1),
                                         ("stack2", 2, 0.25), ("stack2", 2, 0.5), ("stack3", 3, 0), ("ghost", 1, 0)]
    let bgs = ["light", "dark", "checker", "mosaic"]
    var labels: [Label] = []
    var idx = 0
    for loc in locales {
        let s = locs[loc]!.filter { !$0.contains("{") && !$0.contains("%") && $0.count >= 4 }
        try! FileManager.default.createDirectory(atPath: "\(out)/\(loc)", withIntermediateDirectories: true)
        for bg in bgs {
            for (kind, pages, off) in kinds {
                var rnd = Rand(s: UInt64(idx * 7919 + 17))
                let name = String(format: "%04d-%@-%@-%.2f", idx, kind, bg, off)
                let file = "\(loc)/\(name).png"
                let (img, regions, sidecar) = drawSheet(loc: loc, strings: s, kind: kind, pages: pages, offset: off, bg: bg, rnd: &rnd)
                if let o = only, !o.contains(where: file.contains) { idx += 1; continue }
                writePNG(img, "\(out)/\(file)")
                let senc = JSONEncoder(); senc.outputFormatting = [.sortedKeys]
                try! senc.encode(sidecar).write(to: URL(fileURLWithPath: "\(out)/\(loc)/\(name).boxes.json"))
                labels.append(Label(file: file, locale: loc, kind: kind, bg: bg, offset: off, pages: pages, regions: regions))
                idx += 1
            }
        }
    }
    let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try! enc.encode(labels).write(to: URL(fileURLWithPath: "\(out)/labels.json"))
    print("synth: \(labels.count) images in \(out)")
}

func drawSheet(loc: String, strings: [String], kind: String, pages: Int, offset: Double, bg: String, rnd: inout Rand) -> (CGImage, [Region], Sidecar) {
    let W = 900, H = 1400 + paperAbove
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let dark = bg == "dark"
    let paper = dark ? CGColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1) : CGColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1)
    ctx.setFillColor(paper); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    // The picture area (top-left y 300..900) carries the counter.
    let pic = CGRect(x: 0, y: H - 900 - paperAbove, width: W, height: 600)
    switch bg {
    case "checker":
        let q = 36
        for yy in stride(from: Int(pic.minY), to: Int(pic.maxY), by: q) { for xx in stride(from: 0, to: W, by: q) where ((xx + yy) / q) % 2 == 0 {
            ctx.setFillColor(CGColor(red: 0.30, green: 0.36, blue: 0.47, alpha: 1)); ctx.fill(CGRect(x: xx, y: yy, width: q, height: q)) } }
    case "mosaic":
        for _ in 0..<500 {
            ctx.setFillColor(CGColor(red: rnd.unit(), green: rnd.unit(), blue: rnd.unit(), alpha: 1))
            let w = 20 + rnd.unit() * 50, h = 20 + rnd.unit() * 50
            ctx.fill(CGRect(x: rnd.unit() * Double(W), y: pic.minY + rnd.unit() * (pic.height - h), width: w, height: h))
        }
    default:
        ctx.setFillColor(dark ? CGColor(red: 0.2, green: 0.24, blue: 0.3, alpha: 1) : CGColor(red: 0.85, green: 0.88, blue: 0.9, alpha: 1)); ctx.fill(pic)
    }
    let ink = dark ? CGColor(red: 0.95, green: 0.95, blue: 0.95, alpha: 1) : CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
    let grey = dark ? CGColor(red: 0.7, green: 0.7, blue: 0.7, alpha: 1) : CGColor(red: 0.4, green: 0.4, blue: 0.4, alpha: 1)
    func font(_ size: Double, bold: Bool) -> CTFont {
        CTFontCreateUIFontForLanguage(bold ? .emphasizedSystem : .system, size, loc as CFString) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
    }
    // Returns the drawn line's top-left box in px. `cx` centers the line; `right` right-aligns it at that x.
    func line(_ text: String, _ f: CTFont, _ color: CGColor, topY: Double, cx: Double? = nil, right: Double? = nil, dx: Double = 0, dy: Double = 0,
              mode: String = "fill") -> CGRect {
        let attr = NSAttributedString(string: text, attributes: [.init(kCTFontAttributeName as String): f, .init(kCTForegroundColorAttributeName as String): color])
        let l = CTLineCreateWithAttributedString(attr)
        var asc: CGFloat = 0, desc: CGFloat = 0, lead: CGFloat = 0
        let w = Double(CTLineGetTypographicBounds(l, &asc, &desc, &lead))
        let x = (cx.map { $0 - w / 2 } ?? right.map { $0 - w } ?? 40) + dx
        let top = topY + dy + Double(paperAbove)
        ctx.saveGState()
        if mode == "outline" { ctx.setTextDrawingMode(.fillStroke); ctx.setStrokeColor(dark ? CGColor(gray: 0, alpha: 1) : CGColor(gray: 1, alpha: 1)); ctx.setLineWidth(3) }
        if mode == "shadow" { ctx.setShadow(offset: CGSize(width: 2, height: -2), blur: 1, color: CGColor(gray: 0, alpha: 0.45)) }
        ctx.textPosition = CGPoint(x: x, y: Double(H) - top - Double(asc))
        CTLineDraw(l, ctx)
        ctx.restoreGState()
        return CGRect(x: x, y: top, width: w, height: Double(asc + desc))
    }
    let titleF = font(42, bold: true), subF = font(26, bold: false), countF = font(26, bold: true), btnF = font(28, bold: true)
    let lh = 52.0
    var pick = strings.shuffled(using: &rnd)
    func take() -> String { pick.isEmpty ? "Premium" : pick.removeLast() }
    let mode = kind == "shadow" ? "shadow" : kind == "outline" ? "outline" : "fill"
    var title = CGRect.null, sub = CGRect.null, count = CGRect.null
    var els: [(String, CGRect, String)] = []
    for p in 0..<pages {
        let dy = Double(p) * offset * lh
        let t = take(), u = take(), c = "\(p + 1) / \(max(pages, 3))"
        let rt = line(t, titleF, ink, topY: 960, cx: 450, dy: dy, mode: mode)
        let ru = line(u, subF, grey, topY: 1030, cx: 450, dy: dy, mode: mode)
        let rc = line(c, countF, ink, topY: 330, right: 860, dy: dy, mode: mode)
        title = title.union(rt); sub = sub.union(ru); count = count.union(rc)
        els += [("page\(p + 1)-title", rt, t), ("page\(p + 1)-subtitle", ru, u), ("page\(p + 1)-counter", rc, c)]
        if kind == "ghost" { // the same strings again, 3 px lower and 2 px right (an unwanted double draw, not a shadow)
            title = title.union(line(t, titleF, ink, topY: 960, cx: 450, dx: 2, dy: 3))
            sub = sub.union(line(u, subF, grey, topY: 1030, cx: 450, dx: 2, dy: 3))
        }
    }
    let btnText = take()
    let btn = line(btnText, btnF, ink, topY: 1150, cx: 450)
    els.append(("button", btn, btnText))
    let stacked = pages > 1 || kind == "ghost"
    func nb(_ r: CGRect) -> [Double] { [r3(r.minX / Double(W)), r3(r.minY / Double(H)), r3(r.width / Double(W)), r3(r.height / Double(H))] }
    let regions = [Region(role: "title", stacked: stacked, box: nb(title)), Region(role: "subtitle", stacked: stacked, box: nb(sub)),
                   Region(role: "counter", stacked: pages > 1, box: nb(count)), Region(role: "button", stacked: false, box: nb(btn))]
    // Element boxes in 0..1 (unrounded r3 would put a 1 px line outside its own box); the image size in px.
    func eb(_ r: CGRect) -> [Double] { let x0 = max(0, r.minX), y0 = max(0, r.minY); return [x0 / Double(W), y0 / Double(H), (min(Double(W), r.maxX) - x0) / Double(W), (min(Double(H), r.maxY) - y0) / Double(H)] }
    let sidecar = Sidecar(image: ["width": W, "height": H], elements: els.map { Element(id: $0.0, box: eb($0.1), text: $0.2, clips: false) })
    return (ctx.makeImage()!, regions, sidecar)
}


let args = Array(CommandLine.arguments.dropFirst())
guard !args.isEmpty else { print("usage: generate <outdir> [--only <text>] [--tall]"); exit(2) }
if let i = args.firstIndex(of: "--only"), i + 1 < args.count { only = args[i + 1].split(separator: ",").map(String.init) }
if args.contains("--tall") { paperAbove = 3800 }
synth(args[0])
