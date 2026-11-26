// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-054 synthetic set (T3, "Measurement"): one line of text per image, drawn with Core Text at a known sRGB colour
// pair and WCAG ratio, labeled by construction. Matrix: light, dark and random-colour pairs; 14 target ratios 1.5-15;
// Helvetica Neue Thin/Light/Regular/Bold at 11/15/24 pt on 2x and 3x; flat, gradient, busy (blobs), photo (Core Image
// CIRandomGenerator + blur, whole canvas) and photo-under (photo only under the text) backgrounds, an icon beside text on
// a solid button (not busy, D19); mixed-colour, mixed-weight and outlined lines (D17); and CJK, Arabic and Devanagari
// thin strokes on flat backgrounds.
// Truth: the ratio of the text colour against the background (gradient: the worst point under the text; busy and photo:
// the median luminance under the text box before the text is drawn; mixed colour: the worse run; outlined: the better of
// fill and outline, since the outline alone makes the text legible). Size: large at 24 pt (WCAG 18 pt).
// Usage (from the repo root): swiftc -O bench/contrast/generate.swift -o <bin> && <bin> <outdir> [--only <text>]
//   --only writes only the images whose name contains one of the comma-separated <text>s (test fixtures); names,
//   colours and halves are those of the full set.
//   writes <outdir>/<locale>-s<scale>/<NNNN>-<cell>.png and <outdir>/labels.json; even NNNN is the dev half (D21).
import AppKit
import CoreImage
import CoreText
import Foundation

func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
func lum(_ r: Double, _ g: Double, _ b: Double) -> Double { 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
func ratio(_ a: Double, _ b: Double) -> Double { (max(a, b) + 0.05) / (min(a, b) + 0.05) }

struct RGB { var r, g, b: Double; var L: Double { lum(r, g, b) }; var cg: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: 1) } }

struct Rng {
    var s: UInt64
    mutating func next() -> Double {
        s = s &+ 0x9e3779b97f4a7c15
        var z = s
        z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
        z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
        return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53)
    }
}

/// The colour on the line from `hue` toward black or white whose luminance is `targetL` (binary search).
func solve(_ hue: RGB, targetL: Double) -> RGB {
    let dark = targetL < hue.L
    func at(_ m: Double) -> RGB {
        dark ? RGB(r: hue.r * (1 - m), g: hue.g * (1 - m), b: hue.b * (1 - m))
            : RGB(r: hue.r + (1 - hue.r) * m, g: hue.g + (1 - hue.g) * m, b: hue.b + (1 - hue.b) * m)
    }
    var lo = 0.0, hi = 1.0
    for _ in 0..<50 {
        let m = (lo + hi) / 2
        if (at(m).L > targetL) == dark { lo = m } else { hi = m }
    }
    return at((lo + hi) / 2)
}

/// A colour at `target` contrast against `bg`: darker when possible (light mode), lighter otherwise; nil if neither fits.
func against(_ bg: RGB, target: Double, hue: RGB, preferDark: Bool) -> RGB? {
    let darkL = (bg.L + 0.05) / target - 0.05, lightL = target * (bg.L + 0.05) - 0.05
    let options = preferDark ? [darkL, lightL] : [lightL, darkL]
    guard let tl = options.first(where: { $0 >= 0 && $0 <= 1 }) else { return nil }
    return solve(hue, targetL: tl)
}

func writePNG(_ img: CGImage, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: img)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let ci = CIContext(options: [.workingColorSpace: sRGB, .outputColorSpace: sRGB])

/// A photo-like texture (TODO-054 "Dataset"): hundreds of soft shapes whose luminance spreads around `base`, blurred
/// with Core Image so the result has the smooth regions and edges of a photo rather than flat blobs.
func photo(w: Int, h: Int, base: RGB, blob: Double, rng: inout Rng) -> CGImage {
    let c = { (v: Double) in min(0.75, max(0.25, v)) } // room to vary on either side of a white or black base
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(RGB(r: c(base.r), g: c(base.g), b: c(base.b)).cg)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    for _ in 0..<(w * h / Int(blob * blob) * 2 + 50) {
        let l = (rng.next() - 0.5) * 0.9
        let col = RGB(r: min(1, max(0, c(base.r) + l + (rng.next() - 0.5) * 0.2)), g: min(1, max(0, c(base.g) + l + (rng.next() - 0.5) * 0.2)),
                      b: min(1, max(0, c(base.b) + l + (rng.next() - 0.5) * 0.2)))
        ctx.setFillColor(col.cg)
        let d = blob * (0.3 + rng.next() * 2)
        ctx.fillEllipse(in: CGRect(x: rng.next() * Double(w) - d / 2, y: rng.next() * Double(h) - d / 2, width: d, height: d * (0.4 + rng.next())))
    }
    let soft = CIImage(cgImage: ctx.makeImage()!).clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: blob * 0.15])
    return ci.createCGImage(soft, from: CGRect(x: 0, y: 0, width: w, height: h))!
}

struct Label: Encodable {
    let name: String, half: String, locale: String, scale: Double
    let mode: String, bg: String, variant: String, font: String, pt: Double, target: Double
    let truth: Double, size: String, busy: Bool, ink: String, background: String, text: String
}

func hex(_ c: RGB) -> String { String(format: "#%02X%02X%02X", Int((c.r * 255).rounded()), Int((c.g * 255).rounded()), Int((c.b * 255).rounded())) }

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "contrast-synth"
let only: [String]? = CommandLine.arguments.firstIndex(of: "--only").map { CommandLine.arguments[$0 + 1].split(separator: ",").map(String.init) }
var labels: [Label] = []
var rng = Rng(s: 5402)
var n = 0

let latin = ["Continue to checkout", "Weiter zur Kasse", "Paramètres du compte", "Notifications", "Rejoindre la partie", "Forgot password?"]
let scripts: [(locale: String, font: String, text: String)] = [
    ("zh-Hans", "PingFangSC-Light", "继续结账并保存设置"), ("ja", "HiraginoSans-W2", "アカウント設定を保存"),
    ("ar", "GeezaPro", "متابعة إلى الدفع الآن"), ("hi", "KohinoorDevanagari-Light", "खाता सेटिंग्स सहेजें"),
]
let ratios = [1.5, 2, 2.5, 3, 3.5, 4, 4.25, 4.5, 4.75, 5, 6, 7, 10, 15]
let fonts = ["HelveticaNeue-Thin", "HelveticaNeue-Light", "HelveticaNeue", "HelveticaNeue-Bold"]

func attr(_ font: String, _ px: Double, _ c: RGB, stroke: (RGB, Double)? = nil) -> [NSAttributedString.Key: Any] {
    var a: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(font as CFString, px, nil),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): c.cg,
    ]
    if let (sc, w) = stroke {
        a[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = sc.cg
        a[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = -w // negative: stroke and fill
    }
    return a
}

/// Median luminance of an image region (the background under the text, before the text is drawn).
func medianL(_ img: CGImage, _ r: CGRect) -> (Double, RGB) {
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: sRGB,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    var vals: [(Double, RGB)] = []
    for y in max(0, Int(r.minY))..<min(h, Int(r.maxY)) { for x in max(0, Int(r.minX))..<min(w, Int(r.maxX)) {
        let i = ((h - 1 - y) * w + x) * 4 // r is in bottom-left coordinates
        let c = RGB(r: Double(px[i]) / 255, g: Double(px[i + 1]) / 255, b: Double(px[i + 2]) / 255)
        vals.append((c.L, c))
    } }
    vals.sort { $0.0 < $1.0 }
    return vals[vals.count / 2]
}

func render(mode: String, bgKind: String, variant: String, font: String, pt: Double, scale: Double, target: Double,
            locale: String = "en", text: String) {
    var bg: RGB
    switch mode {
    case "light": bg = RGB(r: 1, g: 1, b: 1)
    case "dark": bg = RGB(r: 0.11, g: 0.11, b: 0.118)
    default: bg = RGB(r: rng.next(), g: rng.next(), b: rng.next())
    }
    let hue = mode == "color" ? RGB(r: rng.next(), g: rng.next(), b: rng.next()) : RGB(r: 0.5, g: 0.5, b: 0.5)
    let preferDark = mode == "light" || (mode == "color" && rng.next() < 0.5)
    guard let fg = against(bg, target: target, hue: hue, preferDark: preferDark) else { return }
    let fpx = pt * scale
    var truth = ratio(fg.L, bg.L)
    let bold = font.hasSuffix("Bold")
    let size = pt >= 24 || (bold && pt >= 18.67) ? "large" : "normal"

    // The line: one run, or two (mixed colour or weight), or stroked (outlined).
    let s = NSMutableAttributedString()
    let words = text.split(separator: " ").map(String.init)
    let half = max(1, words.count / 2)
    let first = words.prefix(half).joined(separator: " "), second = words.dropFirst(half).joined(separator: " ")
    switch variant {
    case "mixed-colour":
        let t2 = ratios[Int(rng.next() * Double(ratios.count))]
        let fg2 = against(bg, target: t2, hue: RGB(r: rng.next(), g: rng.next(), b: rng.next()), preferDark: preferDark) ?? fg
        s.append(NSAttributedString(string: first + " ", attributes: attr(font, fpx, fg)))
        s.append(NSAttributedString(string: second, attributes: attr(font, fpx, fg2)))
        truth = min(truth, ratio(fg2.L, bg.L))
    case "mixed-weight":
        s.append(NSAttributedString(string: first + " ", attributes: attr("HelveticaNeue", fpx, fg)))
        s.append(NSAttributedString(string: second, attributes: attr("HelveticaNeue-Bold", fpx, fg)))
    case "outlined":
        let outline = bg.L > 0.4 ? RGB(r: 0, g: 0, b: 0) : RGB(r: 1, g: 1, b: 1)
        s.append(NSAttributedString(string: text, attributes: attr(font, fpx, fg, stroke: (outline, 4))))
        truth = max(truth, ratio(outline.L, bg.L))
    default:
        s.append(NSAttributedString(string: text, attributes: attr(font, fpx, fg)))
    }
    let line = CTLineCreateWithAttributedString(s)
    let tw = CTLineGetTypographicBounds(line, nil, nil, nil)
    let iconW = bgKind == "icon-beside" ? fpx * 1.6 : 0
    let W = Int(tw + fpx * 4 + iconW), H = Int(fpx * 4)
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let textX = 2 * fpx + iconW, baseY = 1.6 * fpx
    let textRect = CGRect(x: textX, y: baseY - 0.25 * fpx, width: tw, height: fpx)
    var busy = false
    switch bgKind {
    case "gradient":
        // A horizontal gradient that halves the contrast at the far end of the canvas (probe matrix).
        let bg2 = solve(bg, targetL: (fg.L + bg.L) / 2)
        let g = CGGradient(colorsSpace: sRGB, colors: [bg.cg, bg2.cg] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: W, y: 0), options: [])
        let f = (textX + tw) / Double(W)
        let far = RGB(r: bg.r + (bg2.r - bg.r) * f, g: bg.g + (bg2.g - bg.g) * f, b: bg.b + (bg2.b - bg.b) * f)
        truth = min(truth, ratio(fg.L, far.L))
    case "busy":
        ctx.setFillColor(bg.cg)
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        for _ in 0..<60 {
            let c = RGB(r: min(1, max(0, bg.r + (rng.next() - 0.5) * 0.9)), g: min(1, max(0, bg.g + (rng.next() - 0.5) * 0.9)),
                        b: min(1, max(0, bg.b + (rng.next() - 0.5) * 0.9)))
            ctx.setFillColor(c.cg)
            let d = fpx * (0.3 + rng.next() * 1.5)
            ctx.fillEllipse(in: CGRect(x: rng.next() * Double(W), y: rng.next() * Double(H), width: d, height: d * (0.3 + rng.next())))
        }
        busy = true
    case "photo", "photo-under":
        ctx.setFillColor(bg.cg)
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        let p = photo(w: W, h: H, base: bg, blob: max(4, fpx * 0.5), rng: &rng)
        if bgKind == "photo" { ctx.draw(p, in: CGRect(x: 0, y: 0, width: W, height: H)) } else {
            let r = textRect.insetBy(dx: -0.1 * fpx, dy: -0.05 * fpx)
            ctx.saveGState()
            ctx.clip(to: r)
            ctx.draw(p, in: CGRect(x: 0, y: 0, width: W, height: H))
            ctx.restoreGState()
        }
        busy = true
    case "icon-beside":
        ctx.setFillColor(bg.cg)
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        // A solid icon left of the text on the same button colour: an edge in the ring, not a textured background.
        ctx.setFillColor(fg.cg)
        ctx.fillEllipse(in: CGRect(x: 2 * fpx - 0.2 * fpx, y: baseY - 0.1 * fpx, width: fpx * 0.9, height: fpx * 0.9))
    default:
        ctx.setFillColor(bg.cg)
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    }
    var under = bg
    if busy, let pre = ctx.makeImage() {
        let (l, c) = medianL(pre, textRect)
        under = c
        let t = ratio(fg.L, l)
        truth = variant == "outlined" ? truth : (variant == "mixed-colour" ? min(truth, t) : t)
    }
    ctx.textPosition = CGPoint(x: textX, y: baseY)
    CTLineDraw(line, ctx)
    let img = ctx.makeImage()!
    let folder = "\(locale)-s\(Int(scale))"
    let cell = "\(mode)-\(bgKind)-\(variant)-\(font)-\(Int(pt))-\(target)".replacingOccurrences(of: ".", with: "_")
    let name = "\(folder)/\(String(format: "%04d", n))-\(cell).png"
    defer { n += 1 }
    if let only, !only.contains(where: { name.contains($0) }) { return }
    try? FileManager.default.createDirectory(atPath: "\(out)/\(folder)", withIntermediateDirectories: true)
    writePNG(img, "\(out)/\(name)")
    labels.append(Label(name: name, half: n % 2 == 0 ? "dev" : "held_out", locale: locale, scale: scale, mode: mode, bg: bgKind,
                        variant: variant, font: font, pt: pt, target: target, truth: (truth * 1000).rounded() / 1000, size: size,
                        busy: busy, ink: hex(fg), background: hex(under), text: s.string))
}

// Flat: the probe's full matrix.
for mode in ["light", "dark", "color"] { for target in ratios { for font in fonts { for pt in [11.0, 15, 24] { for sc in [2.0, 3] {
    render(mode: mode, bgKind: "flat", variant: "plain", font: font, pt: pt, scale: sc, target: target, text: latin[n % latin.count])
} } } } }
// Gradients, busy, photos and the icon counterexample: Thin, Regular and Bold at 2x.
for mode in ["light", "dark", "color"] { for bgKind in ["gradient", "busy", "photo", "photo-under", "icon-beside"] {
    for target in ratios { for font in ["HelveticaNeue-Thin", "HelveticaNeue", "HelveticaNeue-Bold"] { for pt in [11.0, 15, 24] {
        render(mode: mode, bgKind: bgKind, variant: "plain", font: font, pt: pt, scale: 2, target: target, text: latin[n % latin.count])
    } } }
} }
// D17: mixed colour, mixed weight and outlined lines on flat backgrounds.
for variant in ["mixed-colour", "mixed-weight", "outlined"] { for mode in ["light", "dark", "color"] { for target in ratios {
    for pt in [15.0, 24] { for sc in [2.0, 3] {
        render(mode: mode, bgKind: "flat", variant: variant, font: "HelveticaNeue", pt: pt, scale: sc, target: target, text: latin[n % latin.count])
    } }
} } }
// Thin strokes in other scripts.
for s in scripts { for mode in ["light", "dark", "color"] { for target in ratios { for pt in [11.0, 15, 24] {
    render(mode: mode, bgKind: "flat", variant: "plain", font: s.font, pt: pt, scale: 3, target: target, locale: s.locale, text: s.text)
} } } }

let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys]
try! enc.encode(["images": labels]).write(to: URL(fileURLWithPath: "\(out)/labels.json"))
print("contrast synthetic: \(labels.count) images in \(out)")
