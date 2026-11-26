// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// A recognized line in full-image coordinates: normalized, origin top left.
public struct RecognizedLine: Equatable {
    public var text: String
    public var rect: CGRect
    public var confidence: Double
    /// TODO-046 D4: the box of a character range of `text` (normalized, origin top left), from Vision's
    /// `VNRecognizedText.boundingBox(for:)`; nil for readers that give no ranges (Tesseract, tests).
    public var rangeBox: ((Range<String.Index>) -> CGRect?)? = nil

    public init(text: String, rect: CGRect, confidence: Double, rangeBox: ((Range<String.Index>) -> CGRect?)? = nil) {
        self.text = text
        self.rect = rect
        self.confidence = confidence
        self.rangeBox = rangeBox
    }

    public static func == (a: RecognizedLine, b: RecognizedLine) -> Bool {
        a.text == b.text && a.rect == b.rect && a.confidence == b.confidence
    }
}

public enum Geometry {
    public static func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
    public static func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

    /// Vision box (normalized, origin bottom left) -> catscan box (normalized, origin top left).
    public static func fromVision(_ b: CGRect) -> CGRect {
        CGRect(x: b.minX, y: 1 - b.minY - b.height, width: b.width, height: b.height)
    }

    /// `[x, y, width, height]`, rounded to 4 decimals.
    public static func box(_ r: CGRect) -> [Double] {
        [r.minX, r.minY, r.width, r.height].map { round4(Double($0)) }
    }

    public static func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let i = a.intersection(b)
        if i.isNull || i.isEmpty { return 0 }
        let inter = Double(i.width * i.height)
        return inter / (Double(a.width * a.height) + Double(b.width * b.height) - inter)
    }

    /// Tile origins along one edge: tiles of `tile` px with `overlap` px overlap, the last one flush with the end.
    public static func tileStarts(length: Int, tile: Int = 4096, overlap: Int = 256) -> [Int] {
        if length <= tile { return [0] }
        var starts: [Int] = []
        var s = 0
        while s + tile < length {
            starts.append(s)
            s += tile - overlap
        }
        starts.append(length - tile)
        return starts
    }

    /// Merges lines from overlapping tiles: equal normalized text and IoU > 0.5 keep the higher confidence.
    public static func mergeTiles(_ lines: [RecognizedLine], locale: String) -> [RecognizedLine] {
        var out: [RecognizedLine] = []
        for l in lines {
            // TODO-104 D1: merged lines feed the text record, so the merge keeps U+02BC apart as before.
            let n = TextMatch.normalize(l.text, locale: locale, apostrophes: false)
            if let i = out.firstIndex(where: {
                TextMatch.normalize($0.text, locale: locale, apostrophes: false) == n && iou($0.rect, l.rect) > 0.5
            }) {
                if l.confidence > out[i].confidence { out[i] = l }
            } else {
                out.append(l)
            }
        }
        return out
    }

    /// Reading order: rows top to bottom, then left to right (right to left when `rtl`).
    /// Two lines share a row when their vertical overlap is at least half the smaller height.
    public static func readingOrder(_ lines: [RecognizedLine], rtl: Bool) -> [RecognizedLine] {
        let byTop = lines.sorted {
            ($0.rect.minY, $0.rect.minX, $0.text) < ($1.rect.minY, $1.rect.minX, $1.text)
        }
        var rows: [[RecognizedLine]] = []
        for l in byTop {
            if let anchor = rows.last?.first {
                let overlap = min(anchor.rect.maxY, l.rect.maxY) - max(anchor.rect.minY, l.rect.minY)
                if overlap >= 0.5 * min(anchor.rect.height, l.rect.height) {
                    rows[rows.count - 1].append(l)
                    continue
                }
            }
            rows.append([l])
        }
        return rows.flatMap { row in
            row.sorted { rtl ? $0.rect.maxX > $1.rect.maxX : $0.rect.minX < $1.rect.minX }
        }
    }
}
