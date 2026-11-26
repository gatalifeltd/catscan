// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-049 integration golden: paints an opaque bar over part of a generated screenshot (a footer or toast).
// Usage: panel <in.png> <out.png> <x> <y> <w> <h>   (pixels, origin top left)
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
guard a.count == 7, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fatalError("usage: panel <in.png> <out.png> <x> <y> <w> <h>") }
let (x, y, w, h) = (Double(a[3])!, Double(a[4])!, Double(a[5])!, Double(a[6])!)
let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
ctx.setFillColor(CGColor(red: 0.2, green: 0.3, blue: 0.45, alpha: 1))
ctx.fill(CGRect(x: x, y: Double(img.height) - y - h, width: w, height: h))
let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dst, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dst)
