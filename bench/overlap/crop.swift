// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-035: crops image regions for the split re-read. Input: a JSON file with [{"src", "out", "rect": [x, y, w, h]}]
// in pixels, origin top left. Each crop is written as PNG at its source scale, so Vision reads it as it read the
// screenshot. Usage: swiftc -O crop.swift -o crop && ./crop jobs.json
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Job: Decodable { let src: String; let out: String; let rect: [Double] }

let jobs = try JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var cache: [String: CGImage] = [:]
var failed = 0
for j in jobs {
    if cache[j.src] == nil {
        guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: j.src) as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(s, 0, nil) else { failed += 1; continue }
        // The core reads boxes on the EXIF-oriented image; a rotated source would be cropped in the wrong place.
        let props = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any]
        if let o = props?[kCGImagePropertyOrientation] as? Int, o != 1 { failed += 1; continue }
        cache = [j.src: img] // jobs come grouped by source; keep one image in memory
    }
    let img = cache[j.src]!
    let r = CGRect(x: j.rect[0], y: j.rect[1], width: j.rect[2], height: j.rect[3]).integral
        .intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
    guard !r.isEmpty, let c = img.cropping(to: r),
          let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: j.out) as CFURL, UTType.png.identifier as CFString, 1, nil) else { failed += 1; continue }
    CGImageDestinationAddImage(d, c, nil)
    if !CGImageDestinationFinalize(d) { failed += 1 }
}
print("{\"jobs\":\(jobs.count),\"failed\":\(failed)}")
