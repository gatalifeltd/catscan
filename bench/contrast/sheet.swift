// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-054 review aid: a contact sheet of flagged lines, each cropped with one line height of context and numbered, so a
// reviewer labels them `real | exempt | false-alarm` (bench/contrast-real.js --sheets). Images stay in datasets/; the
// sheets are written outside git.
// Usage: swiftc -O bench/contrast/sheet.swift -o <bin> && <bin> <list.tsv> <out.png>
//   list.tsv: <index>\t<image path>\t<x>\t<y>\t<w>\t<h> per line (box normalized, origin top left)
import AppKit
import CoreText
import Foundation

let args = CommandLine.arguments
let rows = try! String(contentsOfFile: args[1], encoding: .utf8).split(separator: "\n").map { $0.split(separator: "\t").map(String.init) }
let W = 1100, rowH = 90, labelW = 60
let ctx = CGContext(data: nil, width: W, height: rowH * rows.count, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: rowH * rows.count))
for (k, r) in rows.enumerated() where r.count >= 6 {
    let y0 = rowH * (rows.count - 1 - k)
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: y0 + 2, width: labelW - 4, height: rowH - 4))
    let label = CTLineCreateWithAttributedString(NSAttributedString(string: r[0], attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Menlo-Bold" as CFString, 22, nil)]))
    ctx.textPosition = CGPoint(x: 4, y: Double(y0) + 34)
    CTLineDraw(label, ctx)
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: r[1]) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { continue }
    let iw = Double(img.width), ih = Double(img.height)
    let (x, y, w, h) = (Double(r[2])! * iw, Double(r[3])! * ih, Double(r[4])! * iw, Double(r[5])! * ih)
    let pad = h
    let rect = CGRect(x: max(0, x - pad), y: max(0, y - pad), width: min(iw, x + w + pad) - max(0, x - pad), height: min(ih, y + h + pad) - max(0, y - pad)).integral
    guard let crop = img.cropping(to: rect) else { continue }
    let s = min(Double(W - labelW) / Double(crop.width), Double(rowH - 4) / Double(crop.height))
    ctx.draw(crop, in: CGRect(x: Double(labelW), y: Double(y0 + 2), width: Double(crop.width) * s, height: Double(crop.height) * s))
}
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
