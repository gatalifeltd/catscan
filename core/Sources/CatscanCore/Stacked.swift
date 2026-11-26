// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// TODO-067: text drawn on top of text, found with no catalog and no element boxes. Vision with language correction
/// (catscan's read) drops a stacked line or reads it as plausible words; read again without correction, the same ink
/// comes back at its lowest confidence. T0 (results/spike-stacked.txt) kept only this "correction" signal: word shape,
/// dictionary, ink and doubled edges did not hold 1 false alarm per 100 real screens alone (D10). D31 adds a
/// `dictionary` signal for stacks Vision reads confidently as non-words (`Notleißigladiagen` at 1.0), frozen on
/// calibration data by bench/stacked-dictionary.js (StackedDictionary.swift).
public enum Stacked {
    /// Vision's confidence takes few values (0.3, 0.5, 1.0); a stacked line reads at the lowest (T0, D6).
    static let maxConfidence = 0.31
    static let minLetters = 6
    /// Share of the screen's median corrected line height; shorter reads are glyph runs and icons (T0).
    static let minHeight = 0.8
    /// Below this box IoU no corrected line covers the uncorrected one: the corrected read dropped it.
    static let coverIoU = 0.3
    /// A covered line counts when the reads differ by this many letters away from both ends (an icon read as a
    /// letter at the start, `V Profil` against `/ Profil`, is not a stack; T0).
    static let minInteriorChange = 2

    /// `corrected` is the production read, `uncorrected` the same image read with language correction off.
    /// `lookup` answers the dictionary signal (D31); tests pass a fake, production the system spell checker.
    public static func evaluate(
        corrected: [RecognizedLine], uncorrected: [RecognizedLine], locale: String, allow: [String],
        lookup: StackedDictionary.Lookup = StackedDictionary.system
    ) -> [Finding] {
        // With no corrected line (correction dropped them all) the uncorrected read gives the height, so the filter
        // never switches off.
        let heights = (corrected.isEmpty ? uncorrected : corrected).map { Double($0.rect.height) }.sorted()
        let median = heights.isEmpty ? 0 : heights[heights.count / 2]
        let readable = Scripts.readable(locale)
        // The element reader's --allow matching (Overlap.swift), so one entry keeps a line from every reader.
        let norm = { (s: String) in TextMatch.normalize(s, locale: locale) }
        let allowed = Set(allow.map(norm))
        var out: [(CGRect, Finding)] = []
        func add(_ u: RecognizedLine, _ evidence: String, _ read: String?) {
            if let i = out.firstIndex(where: { $0.0.intersects(u.rect) }) {
                let r = out[i].0.union(u.rect)
                out[i].0 = r
                out[i].1.box = Geometry.box(r)
                if !(out[i].1.stackedEvidence ?? []).contains(evidence) { out[i].1.stackedEvidence?.append(evidence) }
                if out[i].1.corrected == nil { out[i].1.corrected = read } // null only when correction dropped every line
                return
            }
            var f = Finding(kind: "overlap", box: Geometry.box(u.rect), line: u.text)
            f.a = Finding.OverlapLine(text: u.text, box: Geometry.box(u.rect), confidence: Geometry.round2(u.confidence))
            f.signal = "stacked"
            f.stackedEvidence = [evidence]
            f.corrected = read
            out.append((u.rect, f))
        }
        for u in uncorrected where u.confidence <= maxConfidence {
            guard letters(u.text) >= minLetters, Double(u.rect.height) >= minHeight * median else { continue }
            let best = corrected.max { iou($0.rect, u.rect) < iou($1.rect, u.rect) }
            let covered = best.map { iou($0.rect, u.rect) >= coverIoU } ?? false
            var evidence: String
            var read: String? = nil
            if !covered {
                // A dropped read in a script the locale does not read is a decorative or stylized label (T0: a game card
                // read as Cyrillic in an es run), not a stack.
                guard readableShare(u.text, readable) >= 0.8 else { continue }
                evidence = "correction-dropped"
            } else if let b = best, b.text != u.text, interiorChange(u.text, b.text) >= minInteriorChange {
                evidence = "correction-changed"
                read = b.text
            } else {
                continue
            }
            if allowed.contains(norm(u.text)) || read.map({ allowed.contains(norm($0)) }) == true { continue }
            add(u, evidence, read)
        }
        // D31: a confident production line made mostly of non-words. `a` is the uncorrected read of the same box when
        // there is one (closest to the ink), else the line itself; `corrected` is always the production text.
        for l in corrected where Double(l.rect.height) >= minHeight * median {
            guard StackedDictionary.fires(l.text, locale: locale, lookup: lookup), !allowed.contains(norm(l.text)) else { continue }
            let twin = uncorrected.max { iou($0.rect, l.rect) < iou($1.rect, l.rect) }.flatMap { iou($0.rect, l.rect) >= coverIoU ? $0 : nil }
            if let t = twin, allowed.contains(norm(t.text)) { continue }
            add(twin ?? l, "dictionary", l.text)
        }
        return out.sorted { ($0.0.minY, $0.0.minX) < ($1.0.minY, $1.0.minX) }.map(\.1)
    }

    /// TODO-067 D33: with boxes, an --allow entry naming an element (its id or text) also keeps quiet a stacked finding
    /// mostly inside that element's box joined with the text or graphic elements it intersects (the pair it is drawn
    /// over), so one entry silences one region across readers. Containers and panels never widen it: a full-screen root
    /// or a keyboard would silence the whole screen.
    public static func dropAllowed(_ stacked: [Finding], elements: [TruncationJob.Element], allow: [String], locale: String) -> [Finding] {
        let ids = Set(allow), texts = Set(allow.map { TextMatch.normalize($0, locale: locale) })
        // Only a text or graphic element anchors or widens the region, and a neighbour more than 4 times the anchor's
        // area never widens it (a full-screen background image, a card): containers and panels never silence a screen.
        func leaf(_ e: TruncationJob.Element) -> Bool {
            !e.offscreen && !e.panel && (e.graphic || !(e.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        func area(_ r: CGRect) -> CGFloat { r.width * r.height }
        let rects = elements.filter { e in
            leaf(e) && (e.id.map(ids.contains) == true || e.text.map { texts.contains(TextMatch.normalize($0, locale: locale)) } == true)
        }.map { a in
            elements.filter { leaf($0) && $0.rect.intersects(a.rect) && area($0.rect) <= 4 * area(a.rect) }
                .reduce(a.rect) { $0.union($1.rect) }
        }
        guard !rects.isEmpty else { return stacked }
        return stacked.filter { s in
            guard let b = s.box else { return true }
            let r = CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
            return !rects.contains { e in
                let i = r.intersection(e)
                return !i.isNull && Double(i.width * i.height) >= 0.8 * Double(r.width * r.height)
            }
        }
    }

    /// Drops stacked findings that lie mostly inside a finding another reader already made, then orders all by box.
    public static func merge(_ others: [Finding], _ stacked: [Finding]) -> [Finding] {
        func rect(_ b: [Double]?) -> CGRect { b.map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) } ?? .null }
        let kept = stacked.filter { s in
            let r = rect(s.box)
            return !others.contains { o in
                let i = r.intersection(rect(o.box))
                return !i.isNull && Double(i.width * i.height) >= 0.8 * Double(r.width * r.height)
            }
        }
        return (others + kept).sorted {
            let a = rect($0.box), b = rect($1.box)
            return (a.minY, a.minX) < (b.minY, b.minX)
        }
    }

    static func readableShare(_ s: String, _ readable: Set<Scripts.Script>) -> Double {
        let sc = s.unicodeScalars.compactMap(Scripts.script(of:))
        return sc.isEmpty ? 1 : Double(sc.filter(readable.contains).count) / Double(sc.count)
    }

    static func letters(_ s: String) -> Int { s.unicodeScalars.filter { $0.properties.isAlphabetic }.count }

    static func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let i = a.intersection(b)
        if i.isNull || i.isEmpty { return 0 }
        let ia = Double(i.width * i.height)
        return ia / (Double(a.width * a.height + b.width * b.height) - ia)
    }

    /// Letters that differ between two reads, not counting a change that touches either end (T0).
    static func interiorChange(_ a: String, _ b: String) -> Int {
        let x = Array(a.lowercased().unicodeScalars.filter { $0.properties.isAlphabetic })
        let y = Array(b.lowercased().unicodeScalars.filter { $0.properties.isAlphabetic })
        let ops = diff(x, y)
        return ops.filter { $0.i1 > 0 && $0.j1 > 0 && $0.i2 < x.count && $0.j2 < y.count }.reduce(0) { $0 + max($1.i2 - $1.i1, $1.j2 - $1.j1) }
    }

    struct Op { let i1: Int; let i2: Int; let j1: Int; let j2: Int }

    /// Non-equal blocks between two sequences, from their longest common subsequence (difflib-like opcodes).
    static func diff(_ x: [Unicode.Scalar], _ y: [Unicode.Scalar]) -> [Op] {
        let n = x.count, m = y.count
        var l = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
        if n > 0 && m > 0 {
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    l[i][j] = x[i] == y[j] ? l[i + 1][j + 1] + 1 : max(l[i + 1][j], l[i][j + 1])
                }
            }
        }
        var ops: [Op] = []
        var i = 0, j = 0, si = 0, sj = 0
        while i < n || j < m {
            if i < n, j < m, x[i] == y[j] {
                if si < i || sj < j { ops.append(Op(i1: si, i2: i, j1: sj, j2: j)) }
                i += 1; j += 1; si = i; sj = j
            } else if j < m, i == n || l[i][j + 1] >= l[i + 1][j] {
                j += 1
            } else {
                i += 1
            }
        }
        if si < n || sj < m { ops.append(Op(i1: si, i2: n, j1: sj, j2: m)) }
        return ops
    }
}
