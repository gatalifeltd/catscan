// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation
import NaturalLanguage

/// The `uncatalogued` request field (TODO-036 T4, D50): every loaded catalog form of every locale, so a line is
/// judged against all of them whether or not `wrong-language` runs, plus the shared dynamic-text guards (D51).
public struct UncataloguedJob {
    public struct Entry: Equatable {
        public var key: String
        public var locale: String
        public var text: String
        public var forms: [PseudoJob.Form]

        public init(key: String, locale: String, text: String, forms: [PseudoJob.Form]) {
            self.key = key
            self.locale = locale
            self.text = text
            self.forms = forms
        }
    }

    public var entries: [Entry] = []
    /// Project locales for the `language` field (the catalogs' locales); empty means no language is named.
    public var languages: [String] = []
    public var guards = try! DynamicText()
    /// The image size the `dynamic_rects` were measured on; rects for another aspect are dropped (spec 06 D7).
    public var rectsSize: (width: Double, height: Double)? = nil
    let index = Uncatalogued.Box()

    public init(entries: [Entry] = [], languages: [String] = []) {
        self.entries = entries
        self.languages = languages
    }
}

/// Check 4 (TODO-036 T4): a line that no catalog form of any loaded locale explains. It measures catalog absence,
/// not hardcoding (D10): one form must explain a line (D48), lines join only when one continues the other (D49).
public enum Uncatalogued {
    /// D48 (4): normalized edit distance to one whole form. `nearest` is reported below 0.5 (D53).
    public static let fuzzy = 0.2, nearestCutoff = 0.5
    /// D53: the fuzzy search's length window, +-20% of the line.
    static let window = 0.2
    /// D48 (3): the fixed text is at least half the line's letters; a placeholder slot holds 1-40 characters.
    static let minFixedShare = 0.5, maxSlot = 40
    /// D48 (2): a cut without an ellipsis covers at least 60% of its form (a clipped label shows most of it).
    static let minPrefixShare = 0.6
    static let q = 3

    struct Whole {
        var text: [Character]
        var entry: Int
        var key: String // ties in `near` go to the smaller key (D53)
        var grams: [UInt64: Int]
    }

    struct Slotted {
        var fragments: [[Character]]
        var lead: Bool
        var trail: Bool
        var entry: Int
    }

    struct Index {
        var wholes: [Whole] = []
        var exact: [String: Int] = [:] // whole text -> its first entry
        var byLength: [Int: [Int]] = [:]
        var postings: [UInt64: [(Int, Int)]] = [:] // 3-gram -> (whole, count)
        var heads: [(String, Int)] = [] // sorted: whole texts and first fragments of forms not led by a placeholder
        var slotted: [Slotted] = []
        var slottedByGram: [UInt64: [Int]] = [:] // the first 3-gram of a form's longest fragment
        var slottedShort: [Int] = [] // forms whose longest fragment has under 3 characters
        var longest = 0 // characters of the longest form, slots at their maximum: a longer paragraph matches none
    }

    final class Box {
        private var values: [String: Index] = [:]
        private let lock = NSLock()
        func get(_ locale: String, _ make: () -> Index) -> Index {
            lock.lock()
            defer { lock.unlock() }
            if let v = values[locale] { return v }
            let v = make()
            values[locale] = v
            return v
        }
    }

    /// A line as compared: spec 17 normalization, then outer punctuation dropped (Vision adds or drops a final `.`),
    /// and chevrons (`>`, `›`, a dropdown's `v` read as a word) dropped from either end (real leg: `v Perfil`).
    static func canon(_ s: String, locale: String) -> String {
        let outer = CharacterSet(charactersIn: " .,!?:;'\"·>›<‹»«")
        var t = TextMatch.normalize(s, locale: locale).trimmingCharacters(in: outer)
        if t.hasPrefix("v "), t.count > 2 { t = String(t.dropFirst(2)).trimmingCharacters(in: outer) }
        return t
    }

    /// 3-grams keyed by their characters' first scalars. Two grams that share a key only raise the shared count,
    /// so the lemma's floor stays a lower bound and no form within the cutoff is dropped (D53).
    static func gram(_ a: Character, _ b: Character, _ c: Character) -> UInt64 {
        (UInt64(a.unicodeScalars.first!.value) << 42) | (UInt64(b.unicodeScalars.first!.value) << 21) | UInt64(c.unicodeScalars.first!.value)
    }
    static func grams(_ t: [Character]) -> [UInt64: Int] {
        var g: [UInt64: Int] = [:]
        if t.count >= q { for i in 0...(t.count - q) { g[gram(t[i], t[i + 1], t[i + 2]), default: 0] += 1 } }
        return g
    }

    static func index(_ job: UncataloguedJob, locale: String) -> Index {
        job.index.get(locale) {
            var x = Index()
            var wholeOf: [String: Int] = [:]
            for (ei, e) in job.entries.enumerated() {
                for f in e.forms {
                    // A fragment that is only punctuation (`!` of `Welcome, {name}!`, the quotes of `Delete “{name}”?`)
                    // is dropped, and its placeholder stays a slot at that end (review).
                    let all = f.fragments.map { canon($0, locale: locale) }
                    let frags = all.filter { !$0.isEmpty }
                    guard !frags.isEmpty else { continue }
                    let f = PseudoJob.Form(fragments: f.fragments, lead: f.lead || all.first!.isEmpty, trail: f.trail || all.last!.isEmpty)
                    if all.count == 1 && !f.lead && !f.trail {
                        let t = frags[0]
                        // The same text under several keys: the smaller key names it (D53 tie rule, review).
                        if let wi = wholeOf[t] {
                            if e.key < x.wholes[wi].key { x.wholes[wi].entry = ei; x.wholes[wi].key = e.key; x.exact[t] = ei }
                            continue
                        }
                        x.exact[t] = ei
                        wholeOf[t] = x.wholes.count
                        let chars = Array(t)
                        let w = Whole(text: chars, entry: ei, key: e.key, grams: grams(chars))
                        let wi = x.wholes.count
                        x.wholes.append(w)
                        x.byLength[chars.count, default: []].append(wi)
                        x.longest = max(x.longest, chars.count)
                        for (g, n) in w.grams { x.postings[g, default: []].append((wi, n)) }
                        x.heads.append((t, ei))
                    } else {
                        let s = Slotted(fragments: frags.map(Array.init), lead: f.lead, trail: f.trail, entry: ei)
                        let si = x.slotted.count
                        x.longest = max(x.longest, frags.reduce(0) { $0 + $1.count + 1 } + maxSlot * (frags.count + 1))
                        x.slotted.append(s)
                        if !f.lead { x.heads.append((frags[0], ei)) }
                        let longest = s.fragments.max { $0.count < $1.count }!
                        if longest.count >= q { x.slottedByGram[gram(longest[0], longest[1], longest[2]), default: []].append(si) } else { x.slottedShort.append(si) }
                    }
                }
            }
            x.heads.sort { $0.0 < $1.0 }
            return x
        }
    }

    /// Levenshtein distance between `a` and `b`, or nil when it exceeds `k` (a row past `k` stops early).
    static func distance(_ a: [Character], _ b: [Character], max k: Int) -> Int? {
        if abs(a.count - b.count) > k { return nil }
        if a.isEmpty || b.isEmpty { return max(a.count, b.count) }
        var prev = [Int](0...b.count)
        var cur = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            cur[0] = i
            var best = i
            for j in 1...b.count {
                cur[j] = min(prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1)
                best = min(best, cur[j])
            }
            if best > k { return nil }
            swap(&prev, &cur)
        }
        return prev[b.count] <= k ? prev[b.count] : nil
    }

    /// The closest whole forms within `cutoff` (normalized), best first (D53). Shared 3-gram counts come from the
    /// postings in one dense pass. With `all` false (the 0.2 match) every form within the +-20% length window (D53;
    /// the window, not the cutoff, bounds the search) and the q-gram lemma's floor is checked, so no form in the
    /// window within the cutoff is dropped; with `all` true (`nearest`, an
    /// informational field) only the `nearestPool` forms sharing the most 3-grams are measured.
    static let nearestPool = 64
    static func near(_ t: [Character], _ x: Index, cutoff: Double, all: Bool) -> [(whole: Int, distance: Double)] {
        guard !t.isEmpty, !x.wholes.isEmpty else { return [] }
        var shared = [Int32](repeating: 0, count: x.wholes.count)
        var touched: [Int] = []
        for (g, n) in grams(t) {
            for (wi, m) in x.postings[g] ?? [] {
                if shared[wi] == 0 { touched.append(wi) }
                shared[wi] += Int32(min(n, m))
            }
        }
        var out: [(Int, Double)] = []
        func measure(_ wi: Int) {
            let w = x.wholes[wi].text
            let longer = max(w.count, t.count)
            let k = Int((cutoff * Double(longer)).rounded(.down))
            if let d = distance(t, w, max: k) { out.append((wi, Double(d) / Double(longer))) }
        }
        if all {
            touched.sort { shared[$0] != shared[$1] ? shared[$0] > shared[$1] : $0 < $1 }
            for wi in touched.prefix(nearestPool) { measure(wi) }
        } else {
            let lo = Int((Double(t.count) * (1 - window)).rounded(.down)), hi = Int((Double(t.count) * (1 + window)).rounded(.up))
            let floorAt = { (len: Int) -> Int in
                let longer = max(len, t.count)
                return longer - (q - 1) - Int((cutoff * Double(longer)).rounded(.down)) * q
            }
            if floorAt(hi) > 0 && floorAt(lo) > 0 {
                // Every form within the cutoff shares at least the floor's 3-grams, so it is among the touched ones.
                for wi in touched where (lo...hi).contains(x.wholes[wi].text.count) && Int(shared[wi]) >= floorAt(x.wholes[wi].text.count) { measure(wi) }
            } else {
                for len in max(1, lo)...max(1, hi) { for wi in x.byLength[len] ?? [] where Int(shared[wi]) >= floorAt(len) { measure(wi) } }
            }
        }
        return out.sorted { $0.1 != $1.1 ? $0.1 < $1.1 : (x.wholes[$0.0].key, $0.0) < (x.wholes[$1.0].key, $1.0) }
    }

    static func isBoundary(_ c: Character?, unspaced: Bool) -> Bool {
        guard let c else { return true }
        return unspaced || !(c.isLetter || c.isNumber)
    }

    /// D48 (3): the form's fragments in order, each slot between them (and at a placeholder edge) 1-40 characters.
    /// The fixed text is at least half the line's letters, or every slot holds a short value (2 words at most: a
    /// name or a count, as `Olá, Anna` fills `Olá, {name}`).
    static func slotted(_ h: [Character], _ s: Slotted, unspaced: Bool) -> Bool {
        let fixed = s.fragments.reduce(0) { $0 + $1.filter(\.isLetter).count }
        let letters = h.filter(\.isLetter).count
        guard letters > 0 else { return false }
        let share = Double(fixed) >= minFixedShare * Double(letters)
        func at(_ f: [Character], _ p: Int) -> Bool {
            // A fragment edge that is a sign (`+{bonus}`, `{n}%`) needs no word boundary beside it (real leg).
            let word = { (c: Character?) in c.map { $0.isLetter || $0.isNumber } ?? false }
            return p >= 0 && p + f.count <= h.count && Array(h[p..<(p + f.count)]) == f
                && (!word(f.first) || isBoundary(p > 0 ? h[p - 1] : nil, unspaced: unspaced))
                && (!word(f.last) || isBoundary(p + f.count < h.count ? h[p + f.count] : nil, unspaced: unspaced))
        }
        func short(_ slot: ArraySlice<Character>) -> Bool {
            unspaced ? slot.filter(\.isLetter).count <= 4 : slot.split(separator: " ").filter { $0.contains(where: \.isLetter) }.count <= 2
        }
        // `ok`: the share holds, or every slot so far is short. A failed (fragment, position, ok) state is never
        // tried again, so short fragments over a long line stay polynomial (review: a serve worker could hang).
        var failed = Set<Int>()
        func match(_ k: Int, from: Int, ok: Bool) -> Bool {
            if k == s.fragments.count {
                if !s.trail { return from == h.count && ok }
                guard h.count - from >= 1 && h.count - from <= maxSlot else { return false }
                return share || (ok && short(h[from...]))
            }
            let state = (k * (h.count + 2) + from + 1) * 2 + (ok ? 1 : 0)
            if failed.contains(state) { return false }
            let f = s.fragments[k]
            var found = false
            if k == 0 && !s.lead { found = at(f, 0) && match(1, from: f.count, ok: ok) }
            else {
                let first = from + 1, last = min(h.count - f.count, from + maxSlot)
                if first <= last {
                    for p in first...last where at(f, p) {
                        if match(k + 1, from: p + f.count, ok: share || (ok && short(h[max(0, from)..<p]))) { found = true; break }
                    }
                }
            }
            if !found { failed.insert(state) }
            return found
        }
        return match(0, from: s.lead ? 0 : -1, ok: true)
    }

    /// Whether one catalog form explains the normalized text `n` (D48). `ellipsis`: the line ends with `…` or `...`.
    static func covered(_ n: String, ellipsis: Bool, _ x: Index, locale: String, titled: Bool = false) -> Bool {
        guard !n.isEmpty else { return true }
        if x.exact[n] != nil { return true } // (1)
        let unspaced = TextMatch.isUnspaced(locale)
        let h = Array(n)
        // (2) a cut: the start of a form, shown with an ellipsis or covering 60% of it.
        var lo = 0, hi = x.heads.count
        while lo < hi { let m = (lo + hi) / 2; if x.heads[m].0 < n { lo = m + 1 } else { hi = m } }
        var i = lo
        // Heads sort by scalars; a head whose next scalar is a combining mark (Thai, Devanagari) shares the scalar
        // prefix but not the character one, so the scan runs on scalars and checks characters per head (review).
        while i < x.heads.count, x.heads[i].0.unicodeScalars.starts(with: n.unicodeScalars) {
            if x.heads[i].0.hasPrefix(n), ellipsis || Double(h.count) >= minPrefixShare * Double(x.heads[i].0.count) { return true }
            i += 1
        }
        // (3) one placeholder form; candidates share the first 3-gram of the form's longest fragment.
        var seen = Set<Int>()
        let lineGrams = grams(h)
        for g in lineGrams.keys { for si in x.slottedByGram[g] ?? [] where seen.insert(si).inserted { if slotted(h, x.slotted[si], unspaced: unspaced) { return true } } }
        for si in x.slottedShort where slotted(h, x.slotted[si], unspaced: unspaced) { return true }
        // (4) fuzzy within 0.2 of one whole form.
        if !near(h, x, cutoff: fuzzy, all: false).isEmpty { return true }
        // (5) whole forms read as one line (adjacent labels), each exact: two in any line, three or more only when every
        // word is capitalized, as a tab bar's labels are (real leg), so a sentence of one-word labels stays a finding.
        guard h.count <= 200 else { return false }
        let cuts = [0] + (1..<h.count).filter { unspaced || h[$0] == " " } + [h.count]
        var reach = [UInt64](repeating: 0, count: cuts.count) // bit k: k whole forms end exactly at cuts[i]
        reach[0] = 1
        for e in 1..<cuts.count {
            for b in 0..<e where reach[b] != 0 {
                let t = String(h[cuts[b]..<cuts[e]]).trimmingCharacters(in: .whitespaces)
                if !t.isEmpty, x.exact[t] != nil { reach[e] |= reach[b] << 1 }
            }
        }
        let end = reach[cuts.count - 1]
        if end & 0b100 != 0 || (titled && end >> 3 != 0) { return true }
        // (6) a form with a value beside it (`Collection 18 / 35`, `Version 0.3.1`, `New death +30`): letterless
        // tokens at the ends, one with a digit, dropped; the rest must be one whole form, exact or within 0.2.
        var words = n.split(separator: " ").map(String.init)
        var value = false
        let bare = { (w: String) in !w.contains { $0.isLetter } || (w.count <= 8 && w.contains { $0.isNumber } && w.filter(\.isLetter).count <= 1) }
        while let w = words.last, bare(w) { value = value || w.contains { $0.isNumber }; words.removeLast() }
        while let w = words.first, bare(w) { value = value || w.contains { $0.isNumber }; words.removeFirst() }
        guard value, !words.isEmpty else { return false }
        let rest = words.joined(separator: " ")
        return x.exact[rest] != nil || !near(Array(rest), x, cutoff: fuzzy, all: false).isEmpty
    }

    /// The whole forms that hold the line word for word (starting and ending where no letter or digit goes on): a wrapped string's
    /// pieces. Candidates hold every gram of the line, so the rarest gram's postings are enough.
    static func containing(_ h: [Character], _ x: Index) -> Set<Int> {
        guard h.count >= q else { return [] }
        var best: [(Int, Int)]? = nil
        for i in 0...(h.count - q) {
            guard let p = x.postings[gram(h[i], h[i + 1], h[i + 2])] else { return [] }
            if best == nil || p.count < best!.count { best = p }
        }
        var out = Set<Int>()
        for (w, _) in best ?? [] {
            let t = x.wholes[w].text
            guard t.count > h.count else { continue }
            let edge = { (c: Character) in !c.isLetter && !c.isNumber }
            for s in 0...(t.count - h.count) where (s == 0 || edge(t[s - 1])) && (s + h.count == t.count || edge(t[s + h.count])) {
                if t[s..<(s + h.count)].elementsEqual(h) { out.insert(w); break }
            }
        }
        return out
    }

    /// One line right above the other: they overlap across, sit on different rows, and their gap is at most one
    /// line height.
    static func stacked(_ a: CGRect, _ b: CGRect) -> Bool {
        let h = max(a.height, b.height)
        let gap = abs(a.midY - b.midY) - (a.height + b.height) / 2
        return gap <= h && abs(a.midY - b.midY) > h / 2 && min(a.maxX, b.maxX) > max(a.minX, b.minX)
    }

    static func endsWithEllipsis(_ t: String) -> Bool {
        let s = t.trimmingCharacters(in: .whitespaces)
        return s.hasSuffix("…") || s.hasSuffix("...") || s.hasSuffix("\u{22EF}")
    }

    /// The findings, in line order, for the lines not in `skip` (lines another kind reported, D52).
    public static func evaluate(
        _ job: UncataloguedJob, lines: [RecognizedLine], locale: String, aspect: Double, skip: Set<Int> = []
    ) -> [(line: Int, finding: Finding)] {
        guard !job.entries.isEmpty, !lines.isEmpty else { return [] }
        let x = index(job, locale: locale)
        var memo: [String: Bool] = [:]
        func ok(_ text: String) -> Bool {
            let n = canon(text, locale: locale)
            // A caseless script (ja, zh, ko, th) is never titled: its lines have no capitals to tell labels from prose.
            let titled = text.contains { $0.isUppercase || $0.isLowercase }
                && text.split(separator: " ").allSatisfy { w in w.first { $0.isLetter }.map { !$0.isLowercase } ?? true }
            let key = (endsWithEllipsis(text) ? "1" : "0") + (titled ? "1" : "0") + n
            if let v = memo[key] { return v }
            let v = covered(n, ellipsis: endsWithEllipsis(text), x, locale: locale, titled: titled)
            memo[key] = v
            return v
        }
        // D49: a line joins its neighbor only when the neighbor continues it.
        let next = lines.indices.map { i in i + 1 < lines.count && Untranslated.continues(lines[i].rect, lines[i + 1].rect, aspect: aspect) }
        // A paragraph: the run of lines that continue each other. A wrapped string's middle lines start no form and
        // fill under 60% of it, so the whole run is tested, and a middle line counts when it sits inside one form.
        var start = Array(lines.indices)
        for i in lines.indices.dropFirst() where next[i - 1] { start[i] = start[i - 1] }
        var end = Array(lines.indices)
        for i in lines.indices.reversed().dropFirst() where next[i] { end[i] = end[i + 1] }
        var pieceMemo: [Int: Set<Int>] = [:]
        func pieces(_ i: Int) -> Set<Int> {
            if let v = pieceMemo[i] { return v }
            let v = containing(Array(canon(lines[i].text, locale: locale)), x)
            pieceMemo[i] = v
            return v
        }
        var out: [(Int, Finding)] = []
        for i in lines.indices where !skip.contains(i) {
            let l = lines[i]
            if job.guards.guarded(l.text, rect: l.rect, locale: locale) != nil { continue }
            if ok(l.text) { continue }
            if i > 0, next[i - 1], ok(lines[i - 1].text + " " + l.text) { continue }
            if next[i], ok(l.text + " " + lines[i + 1].text) { continue }
            if end[i] - start[i] >= 2 {
                let para = lines[start[i]...end[i]].map(\.text).joined(separator: " ")
                if Double(para.count) <= 1.25 * Double(x.longest), ok(para) { continue }
            }
            // A wrapped piece: this line and the line just above or below sit inside the same form word for word,
            // whatever their alignment (centered store art, a two-line wrap under 60%). A lone piece stays a finding.
            if !pieces(i).isEmpty, lines.indices.contains(where: { j in
                j != i && stacked(l.rect, lines[j].rect) && !pieces(i).isDisjoint(with: pieces(j))
            }) { continue }
            var f = Finding(kind: "uncatalogued", box: Geometry.box(l.rect), line: l.text)
            if let best = near(Array(canon(l.text, locale: locale)), x, cutoff: nearestCutoff, all: true).first {
                let e = job.entries[x.wholes[best.whole].entry]
                f.nearest = .init(key: e.key, text: e.text, distance: (best.distance * 100).rounded() / 100)
            }
            f.language = language(l.text, job.languages)
            out.append((i, f))
        }
        return out
    }

    /// D52: the findings whose lines are never uncatalogued. Raw keys, placeholders and hardcoded lines are not
    /// text; `untranslated` and `wrong-language` win only when selected, otherwise their line is judged here (review).
    static func shadowing(_ findings: [Finding], kinds: Set<String>?) -> [Finding] {
        findings.filter { ["raw-key", "placeholder", "hardcoded"].contains($0.kind) || kinds?.contains($0.kind) ?? true }
    }

    /// The project language the recognizer names at >= 0.95, or nil (Check 4 `language`).
    static func language(_ t: String, _ languages: [String]) -> String? {
        guard !languages.isEmpty else { return nil }
        let nl = languages.map { (WrongLanguage.nl($0), $0) }
        let h = WrongLanguage.hypotheses(t, constraints: nl.map(\.0))
        guard let top = h.max(by: { $0.value < $1.value }), top.value >= 0.95 else { return nil }
        return nl.first { $0.0 == top.key }?.1
    }
}
