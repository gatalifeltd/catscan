// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The `pseudo` request field (TODO-039 T2): the base catalog's strings and the generator's filler words.
public struct PseudoJob {
    /// One form of a string (a plural form is its own): spec 02 fragments, and whether a placeholder starts or ends it.
    public struct Form: Equatable {
        public var fragments: [String]
        public var lead: Bool
        public var trail: Bool

        public init(fragments: [String], lead: Bool = false, trail: Bool = false) {
            self.fragments = fragments
            self.lead = lead
            self.trail = trail
        }
    }

    public struct Entry: Equatable {
        public var key: String
        public var catalog: String?
        public var text: String
        public var forms: [Form]

        public init(key: String, catalog: String?, text: String, forms: [Form]) {
            self.key = key
            self.catalog = catalog
            self.text = text
            self.forms = forms
        }
    }

    public var entries: [Entry] = []
    /// The generator's filler words in order (`packages/core-js/src/pseudo.js` FILLER), sent by the Node layer.
    public var fillers: [String] = []
    /// TODO-039 D10: the shared dynamic-text guards (`--dynamic`, `--allow`, `dynamic: true` elements).
    public var guards = try! DynamicText()
    /// The image size the `dynamic_rects` were measured on; rects for another aspect are dropped (spec 06 D7).
    public var rectsSize: (width: Double, height: Double)? = nil
    let prepared = Pseudo.Box()

    public init(entries: [Entry] = [], fillers: [String] = []) {
        self.entries = entries
        self.fillers = fillers
    }
}

/// TODO-039 T2: `pseudo-cut`, `hardcoded` and `pseudo-not-applied` on a pseudo-localized screen (D4, D5, D11, D13, D14).
public enum Pseudo {
    /// D4, D11: an image with at least this many lines with letters, under this share with a pseudo trait.
    public static let minLines = 3, minTraitShare = 0.2
    /// The smallest expansion a pseudo build is assumed to use (German and Finnish grow 30-40%): a complete string
    /// read without `]` and with at least this many filler words is a marker misread, with fewer it is a cut.
    public static let minExpand = 30.0
    /// pseudo.js counts a placeholder as 6 visible characters.
    static let placeholderWidth = 6
    /// The fewest letters a cut read must keep to name its string.
    static let minCutLetters = 2

    /// System UI drawn over the app is never pseudo (an iOS permission alert, an Android permission dialog); folded.
    static let systemUI: [NSRegularExpression] = [
        "allow .+ to .+",
        "(allow once|allow while using (the )?app|don ?'?t allow|only this time|while using the app|ask every time|ask app not to track|keep only while using|change to always allow|precise:? (on|off)|approximate)",
    ].map { try! NSRegularExpression(pattern: "^(?:\($0))$") }

    /// Spec 02 normalization plus diacritic folding: Vision drops or swaps accents on about half of the reads (T0).
    public static func fold(_ s: String, locale: String) -> String {
        TextMatch.normalize(s, locale: locale).folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX"))
    }

    struct Marked: Equatable {
        var open: Bool
        var close: Bool
        var inner: String
    }

    /// D13: markers are found on the raw read, before `TextMatch.fold` drops leading glyphs, with two repairs at the
    /// line ends only: a final `|` before `]` is `l`, a leading `¡` is `[` (T0).
    static func markers(_ raw: String) -> Marked {
        var s = String.UnicodeScalarView()
        s.append(contentsOf: raw.precomposedStringWithCompatibilityMapping.unicodeScalars.filter { !TextMatch.invisible.contains($0) })
        var t = String(s).trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("¡") { t = "[" + t.dropFirst() }
        if t.hasSuffix("|]") { t = t.dropLast(2) + "l]" }
        let open = t.hasPrefix("[")
        if open { t.removeFirst() }
        let close = t.hasSuffix("]")
        if close { t.removeLast() }
        return Marked(open: open, close: close, inner: t.trimmingCharacters(in: .whitespaces))
    }

    /// One way to read a line's words: content, then `fillers` whole filler words in the generator's order, then
    /// (`partial`) the start of the next filler word.
    struct Split: Equatable {
        var content: String
        var fillers: Int
        var partial: Bool
    }

    /// Every split of the words, the longest filler run first; the last one is the whole line as content.
    static func splits(_ words: [String], fillers: [String]) -> [Split] {
        guard !fillers.isEmpty else { return [Split(content: words.joined(separator: " "), fillers: 0, partial: false)] }
        let filler = { (k: Int) in fillers[k % fillers.count] }
        var out: [Split] = []
        // A filler run starts at the first filler word, so the last k words are fillers 0..<k.
        func run(_ w: ArraySlice<String>) -> [Int] {
            var ks: [Int] = []
            var k = 1
            while k <= w.count {
                if w.suffix(k).enumerated().allSatisfy({ $0.element == filler($0.offset) }) { ks.append(k) }
                k += 1
            }
            return ks.reversed()
        }
        let w = words[...]
        if let last = w.last, w.count >= 2 {
            let before = w.dropLast()
            for k in run(before) + [0] {
                let next = filler(k)
                // A clipped glyph is read as anything, so the last character of the partial word is not compared.
                if last != next && last.count <= next.count && (last.count == 1 ? next.hasPrefix(last) : next.hasPrefix(last.dropLast())) {
                    out.append(Split(content: before.dropLast(k).joined(separator: " "), fillers: k, partial: true))
                }
            }
        }
        for k in run(w) { out.append(Split(content: w.dropLast(k).joined(separator: " "), fillers: k, partial: false)) }
        out.append(Split(content: words.joined(separator: " "), fillers: 0, partial: false))
        // Longest filler interpretation first; a whole split before a partial one at the same run.
        return out.sorted { ($0.fillers, $0.partial ? 0 : 1) > ($1.fillers, $1.partial ? 0 : 1) }
    }

    /// A catalog form folded for matching, with the generator's width for the expansion rule.
    struct Template {
        var entry: Int
        var fragments: [[Character]]
        var lead: Bool
        var trail: Bool
        var width: Int
        var letters: Int { fragments.reduce(0) { $0 + $1.filter(\.isLetter).count } }
    }

    struct Prepared {
        var templates: [Template] = []
        var fillers: [String] = []
        var accented: [Set<Character>] = [] // per entry, the accented letters its own text has
        var anyAccented: Set<Character> = [] // every accented letter of the catalog (café)
    }

    /// Folding depends on the locale (spec 02 normalization), so the prepared templates are kept per locale.
    final class Box {
        private var values: [String: Prepared] = [:]
        private let lock = NSLock()
        func get(_ locale: String, _ make: () -> Prepared) -> Prepared {
            lock.lock()
            defer { lock.unlock() }
            if let v = values[locale] { return v }
            let v = make()
            values[locale] = v
            return v
        }
    }

    static func accents(_ s: String) -> Set<Character> {
        Set(s.lowercased().precomposedStringWithCanonicalMapping.filter { c in
            c.isLetter && String(c).decomposedStringWithCanonicalMapping.unicodeScalars.count > 1
        })
    }

    /// D3: the base catalog, or a pseudo catalog passed instead: markers and the filler run are stripped here too.
    static func prepare(_ job: PseudoJob, locale: String) -> Prepared {
        var p = Prepared()
        p.fillers = job.fillers.map { fold($0, locale: locale) }
        for (i, e) in job.entries.enumerated() {
            p.accented.append(accents(e.text))
            p.anyAccented.formUnion(p.accented[i])
            for f in e.forms where !f.fragments.isEmpty {
                var frags = f.fragments
                let bracketed = frags.first?.hasPrefix("[") == true && frags.last?.hasSuffix("]") == true
                if bracketed {
                    frags[0].removeFirst()
                    frags[frags.count - 1].removeLast()
                }
                var folded = frags.map { fold($0, locale: locale) }
                if bracketed, let last = folded.last {
                    let s = splits(last.split(separator: " ").map(String.init), fillers: p.fillers)
                    if let whole = s.first(where: { !$0.partial }) { folded[folded.count - 1] = whole.content }
                }
                folded = folded.filter { !$0.isEmpty }
                if folded.isEmpty { continue }
                let holes = folded.count - 1 + (f.lead ? 1 : 0) + (f.trail ? 1 : 0)
                p.templates.append(Template(
                    entry: i, fragments: folded.map(Array.init), lead: f.lead, trail: f.trail,
                    width: folded.reduce(0) { $0 + $1.count } + holes * (placeholderWidth + 1)))
            }
        }
        return p
    }

    enum Fit { case full, prefix, none }

    /// How a read fits a form: all of it (placeholders as wildcards), a strict start of it, or neither.
    static func fit(_ c: [Character], _ t: Template) -> Fit {
        guard !c.isEmpty else { return .none }
        var pos = 0
        for (k, f) in t.fragments.enumerated() {
            let rest = c[pos...]
            if k == 0 && !t.lead {
                if rest.starts(with: f) { pos += f.count; continue }
                return f.starts(with: rest) ? .prefix : .none
            }
            // A placeholder's value comes before this fragment.
            let last = k == t.fragments.count - 1
            if last && !t.trail {
                if c.count - pos >= f.count, c.suffix(f.count).elementsEqual(f), c.count - f.count > pos || (k == 0 && c.count == f.count) {
                    pos = c.count
                    continue
                }
            } else if let at = index(f, in: c, from: pos) {
                pos = at + f.count
                continue
            }
            // The read stops inside the value or inside this fragment: a cut when an earlier fragment matched and the
            // rest is short enough to be a value.
            return pos > 0 && c.count - pos <= 24 ? .prefix : .none
        }
        return pos == c.count || t.trail ? .full : .none
    }

    static func index(_ n: [Character], in h: [Character], from: Int) -> Int? {
        guard n.count <= h.count - from else { return nil }
        var i = from
        while i + n.count <= h.count {
            if h[i..<(i + n.count)].elementsEqual(n) { return i }
            i += 1
        }
        return nil
    }

    /// The mirror for a cut start: the read is the end of the form.
    static func fitEnd(_ c: [Character], _ t: Template) -> Fit {
        let r = Template(
            entry: t.entry, fragments: t.fragments.reversed().map { Array($0.reversed()) }, lead: t.trail, trail: t.lead, width: t.width)
        return fit(Array(c.reversed()), r)
    }

    /// The filler words a complete string carries at `minExpand` (pseudo.js `transform`).
    static func fillersNeeded(_ t: Template, fillers: [String]) -> Int {
        guard !fillers.isEmpty else { return 0 }
        let target = Int((Double(t.width) * (1 + minExpand / 100)).rounded(.up))
        var w = t.width, k = 0
        while w < target {
            w += 1 + fillers[k % fillers.count].count
            k += 1
        }
        return k
    }

    /// A line (or lines joined in reading order) as read.
    struct Read {
        var open: Bool
        var close: Bool
        var words: [String]
        var accents: Set<Character>
        var letters: Int
        var splits: [Split]
    }

    /// TODO-051: glyphs Vision reads for a `]` glued to the last filler word (`_` already folds to a space).
    static let closeMisreads: Set<Character> = ["j", ")", "1"]

    static func read(_ texts: [String], locale: String, fillers: [String]) -> Read {
        let m = texts.map(markers)
        let inner = m.map(\.inner).joined(separator: " ")
        var words = fold(inner, locale: locale).split(separator: " ").map(String.init)
        // TODO-051 (D2): in a read that opens with `[`, a misread `]` glued to the end of a filler run (the last word
        // a filler, the word before it the filler before that, wrapping after the last) is dropped. The filler count still decides cut or
        // misread (D13). A line without `[` (a hardcoded label) and a placeholder value such as `[Héllö, one1` keep it.
        if m.first!.open, !m.last!.close, words.count >= 2, let last = words.last, last.count > 1, let g = last.last, closeMisreads.contains(g),
           let k = fillers.firstIndex(of: String(last.dropLast())), words[words.count - 2] == fillers[(k + fillers.count - 1) % fillers.count] {
            words[words.count - 1].removeLast()
        }
        return Read(
            open: m.first!.open, close: m.last!.close, words: words, accents: accents(inner),
            letters: inner.filter(\.isLetter).count, splits: splits(words, fillers: fillers))
    }

    /// The best whole match of a read: the template and the split that matched.
    static func whole(_ r: Read, _ p: Prepared) -> (Template, Split)? {
        for s in r.splits where !s.partial {
            let c = Array(s.content)
            if let t = p.templates.first(where: { fit(c, $0) == .full }) { return (t, s) }
        }
        return nil
    }

    struct Cut {
        var template: Template
        var side: String
        var lost: String
    }

    /// The `pseudo-cut` rule on one read, or nil (no cut, or a marker misread).
    static func cut(_ r: Read, _ p: Prepared) -> Cut? {
        if r.open && !r.close {
            // The whole base content and the read stops in the filler words: only the filler was lost.
            for s in r.splits {
                let c = Array(s.content)
                guard let t = p.templates.first(where: { fit(c, $0) == .full }) else { continue }
                if s.partial || s.fillers < fillersNeeded(t, fillers: p.fillers) { return Cut(template: t, side: "end", lost: "filler") }
                return nil // the content is complete and the filler run too: `]` was not read
            }
            // The read stops inside the base text; the clipped last glyph may be read as anything.
            guard let s = r.splits.last, s.content.filter(\.isLetter).count >= minCutLetters else { return nil }
            for c in [Array(s.content), Array(s.content.dropLast().trimmingCharacters(in: .whitespaces))] where c.filter(\.isLetter).count >= minCutLetters {
                if let t = p.templates.filter({ fit(c, $0) == .prefix }).min(by: { ($0.width, $0.entry) < ($1.width, $1.entry) }) {
                    return Cut(template: t, side: "end", lost: "text")
                }
            }
            return nil
        }
        if r.close && !r.open {
            // Mirrored: `]` without `[` (centered or RTL text cut at its start). The base text's start is lost; the
            // clipped first glyph may be read as anything.
            for s in r.splits where !s.partial && s.content.filter(\.isLetter).count >= minCutLetters + 1 {
                if p.templates.contains(where: { fit(Array(s.content), $0) == .full }) { return nil } // `[` was not read
                for c in [Array(s.content), Array(s.content.dropFirst().trimmingCharacters(in: .whitespaces))] where c.filter(\.isLetter).count >= minCutLetters + 1 {
                    if let t = p.templates.filter({ fitEnd(c, $0) == .prefix }).min(by: { ($0.width, $0.entry) < ($1.width, $1.entry) }) {
                        return Cut(template: t, side: "start", lost: "text")
                    }
                }
            }
        }
        return nil
    }

    public struct Result {
        public var cuts: [(line: Int, finding: Finding)] = []
        public var hardcoded: [(line: Int, finding: Finding)] = []
        public var notApplied: Finding?
    }

    /// Runs the pseudo rules over one image's lines. `skip` holds lines another rule already reported (`raw-key`,
    /// `placeholder`, an existing truncation reason), which win on the same line.
    public static func evaluate(
        _ job: PseudoJob, lines: [RecognizedLine], locale: String, skip: Set<Int> = [], cuts wantCuts: Bool, hardcoded wantHardcoded: Bool
    ) -> Result {
        let p = job.prepared.get(locale) { prepare(job, locale: locale) }
        let reads = lines.map { read([$0.text], locale: locale, fillers: p.fillers) }
        var res = Result()
        var used = Set<Int>()
        var traited = Set<Int>()

        // A string wrapped over 2-6 lines: `[` on the first, `]` on the last, unmarked lines between, either the
        // joined content whole or the lines stacked as one paragraph (one misread in a long string must not make
        // its last line a cut). Not a cut, and its lines are pseudo text.
        // Lines of one paragraph: aligned and closer than half a line height (separate labels sit further apart).
        func stacked(_ a: RecognizedLine, _ b: RecognizedLine) -> Bool {
            let aligned = abs(a.rect.minX - b.rect.minX) <= 0.03 || abs(a.rect.midX - b.rect.midX) <= 0.03 || abs(a.rect.maxX - b.rect.maxX) <= 0.03
            return aligned && b.rect.minY > a.rect.minY && b.rect.minY - a.rect.maxY <= 0.5 * a.rect.height
        }
        // A paragraph of 3+ lines that opens or closes like pseudo text is one wrapped string even when a marker
        // was misread; a 2-line one ending in `]` too. A 2-line paragraph that opens and does not close is judged
        // below.
        var i0 = 0
        while i0 < lines.count {
            var chain = [i0]
            while chain.count < 6, let last = chain.last, last + 1 < lines.count, stacked(lines[last], lines[last + 1]) { chain.append(last + 1) }
            defer { i0 = chain.last! + 1 }
            guard chain.count >= 2, !chain.dropFirst().contains(where: { reads[$0].open }), !chain.dropLast().contains(where: { reads[$0].close }) else { continue }
            let opens = reads[chain[0]].open, closes = reads[chain.last!].close
            if (chain.count >= 3 && (opens || closes)) || (chain.count == 2 && closes) {
                used.formUnion(chain)
                traited.formUnion(chain)
            }
        }
        for i in lines.indices where !used.contains(i) && reads[i].open && !reads[i].close {
            for n in 2...6 where i + n <= lines.count {
                let ix = Array(i..<(i + n))
                if ix.contains(where: { used.contains($0) }) { break }
                if ix.dropFirst().contains(where: { reads[$0].open }) || ix.dropLast().dropFirst().contains(where: { reads[$0].close }) { break }
                guard reads[ix.last!].close else { continue }
                let r = read(ix.map { lines[$0].text }, locale: locale, fillers: p.fillers)
                if whole(r, p) != nil || zip(ix, ix.dropFirst()).allSatisfy({ stacked(lines[$0], lines[$1]) }) {
                    used.formUnion(ix)
                    traited.formUnion(ix)
                }
                break
            }
            // TODO-051 (D1): two lines of one paragraph whose joined read is the whole string with its filler run are
            // one wrapped string whose `]` was misread or lost (D13), also when a stacked neighbour kept the chain
            // pass above from judging them. Otherwise they are judged below as two joined lines (a cut).
            let pair = [i, i + 1]
            guard !used.contains(i), i + 1 < lines.count, !used.contains(i + 1), !reads[i + 1].open, !reads[i + 1].close,
                  stacked(lines[i], lines[i + 1]) else { continue }
            let r = read(pair.map { lines[$0].text }, locale: locale, fillers: p.fillers)
            if cut(r, p) == nil, let (t, s) = whole(r, p), s.fillers >= fillersNeeded(t, fillers: p.fillers) {
                used.formUnion(pair)
                traited.formUnion(pair)
            }
        }

        // Cuts, on one line or on a line joined with the next (spec 00).
        for i in lines.indices where !used.contains(i) {
            let r = reads[i]
            if r.open || r.close { traited.insert(i) }
            // A markerless line with pseudo accents (ones no catalog string has) that stops inside a string is a cut
            // whose `[` was not read.
            var r2 = r
            if !r.open && !r.close && !r.accents.subtracting(p.anyAccented).isEmpty { r2.open = true }
            guard wantCuts, !skip.contains(i), r2.open != r2.close else { continue }
            var at = [i], c = cut(r2, p)
            if r2.open, i + 1 < lines.count, !used.contains(i + 1), !skip.contains(i + 1), !reads[i + 1].open, !reads[i + 1].close {
                var j = read([lines[i].text, lines[i + 1].text], locale: locale, fillers: p.fillers)
                j.open = true
                if let cj = cut(j, p), c == nil || cj.template.entry == c!.template.entry { (at, c) = ([i, i + 1], cj) }
            }
            guard let c else { continue }
            used.formUnion(at)
            traited.formUnion(at)
            let e = job.entries[c.template.entry]
            let rect = at.map { lines[$0].rect }.reduce(lines[at[0]].rect) { $0.union($1) }
            var f = Finding(kind: "truncated", box: Geometry.box(rect.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))), line: at.map { lines[$0].text }.joined(separator: " "))
            f.reason = "pseudo-cut"
            f.side = c.side
            f.lost = c.lost
            f.key = e.key
            f.catalog = e.catalog
            f.expected = e.text
            f.confidence = Geometry.round2(at.map { lines[$0].confidence }.min() ?? 0)
            res.cuts.append((i, f))
        }

        // Pseudo traits and `hardcoded` on the remaining lines.
        var candidates: [(Int, Finding)] = []
        for (i, l) in lines.enumerated() where !used.contains(i) {
            let r = reads[i]
            let w = whole(r, p)
            let fillerTrait = w.map { $0.1.fillers > 0 } ?? r.splits.contains { $0.fillers > 0 || $0.partial }
            let extra = r.accents.subtracting(w.map { p.accented[$0.0.entry] } ?? [])
            if r.open || r.close || fillerTrait || !extra.isEmpty {
                traited.insert(i)
                continue
            }
            guard wantHardcoded, !skip.contains(i), r.letters > 0 else { continue }
            if job.guards.guarded(l.text, rect: l.rect, locale: locale) != nil { continue }
            let plain = r.words.joined(separator: " ")
            let whole = NSRange(plain.startIndex..., in: plain)
            if systemUI.contains(where: { $0.firstMatch(in: plain, range: whole) != nil }) { continue }
            var f = Finding(kind: "hardcoded", box: Geometry.box(l.rect), line: l.text)
            if let (t, _) = w {
                let e = job.entries[t.entry]
                f.evidence = "base"
                f.key = e.key
                f.catalog = e.catalog
                f.expected = e.text
            } else {
                // D5: a markerless strict fragment of a catalog string is a wrapped middle line; a strict start of
                // one is a cut whose `[` was not read.
                if p.templates.contains(where: { t in t.fragments.contains { TextMatch.contains(String($0), plain, wordBounded: true) } }) { continue }
                if p.templates.contains(where: { fit(Array(plain), $0) == .prefix }) { continue }
                f.evidence = "none"
            }
            candidates.append((i, f))
        }

        // D4, D11: per image, lines with letters (outside the status bar) and the share that carries a trait.
        let lettered = lines.indices.filter { reads[$0].letters > 0 && lines[$0].rect.midY >= DynamicText.statusBand }
        let share = lettered.isEmpty ? 1 : Double(lettered.filter(traited.contains).count) / Double(lettered.count)
        if lettered.count >= minLines && share < minTraitShare {
            var f = Finding(kind: "pseudo-not-applied", box: nil, line: "")
            f.traits = Geometry.round2(share)
            f.lines = lettered.count
            res.notApplied = f
        } else {
            res.hardcoded = candidates
        }
        return res
    }

    /// `check --pseudo` (D8): the read with its markers stripped and accents folded, so a literal or `--expect` check
    /// written against the base catalog matches a pseudo screen. Filler words stay: checks match inside a line.
    public static func plain(_ text: String, locale: String) -> String {
        fold(markers(text).inner, locale: locale)
    }
}
