// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The `untranslated` request (spec 17 D28): catalog strings as raw fragments, parsed by the Node layer.
public struct UntranslatedJob {
    public struct Pair {
        public var key: String
        public var catalog: String?
        public var base: String
        public var expected: String? // nil: the target has no string for the key (D2, D15)
        public var baseAlternatives: [[String]]
        public var targetAlternatives: [[String]]

        public init(
            key: String, catalog: String?, base: String, expected: String?, baseAlternatives: [[String]],
            targetAlternatives: [[String]]
        ) {
            self.key = key
            self.catalog = catalog
            self.base = base
            self.expected = expected
            self.baseAlternatives = baseAlternatives
            self.targetAlternatives = targetAlternatives
        }
    }

    public var baseLocale: String
    public var pairs: [Pair] = []
    public var targets: [[String]] = [] // every target string's alternatives, for the span rule (D10)
    public var keys: [String] = [] // exact catalog keys that count as raw keys (D6)
    public var texts: [String] = [] // every catalog string, for the TODO-031 collision guard
    public var styles: Set<String> = []
    public var allow: [String] = []
    /// TODO-036 D15 / TODO-039 D15: the finding kinds reported (`--kinds`); nil: all.
    public var kinds: Set<String>? = nil
    /// TODO-036 T2: other project locales and languages for `wrong-language`; nil when it cannot run.
    public var wrongLanguage: WrongLanguageJob? = nil
    /// TODO-036 T2: rule 1 only (an other-locale job of wrong-language); the main job reports keys and placeholders.
    var baseOnly = false
    /// TODO-036 T2: the run locale's strings are the target of every other-locale job; their checkable forms are
    /// computed once per normalization class and shared (`Untranslated.Memo`).
    var memo: Untranslated.Memo? = nil
    /// The locale-independent work, done once per field and shared by every copy of the job (D32).
    let prepared = Untranslated.Box()

    public init(baseLocale: String) { self.baseLocale = baseLocale }
}

/// Spec 17 "Rule": untranslated base strings, raw keys and unfilled placeholders on recognized lines.
public enum Untranslated {
    /// TODO-012 D1, D5: the most work one `untranslated` field may ask for; the per-string caps equal the catalog
    /// loader's expansion cap (256 fragments over all forms of a string), so no loaded string reaches them. `packages/core-js/src/untranslated.js` mirrors
    /// these numbers (a unit test reads them from this file).
    public static let caps = (pairs: 20_000, targets: 20_000, alternatives: 256, fragments: 256)

    /// Placeholder styles the spec 02 parser records (D21, D28); anything else is an invalid request.
    public static let styleNames: Set<String> = ["{name}", "{{name}}", "{0}", "icu", "printf"]
    /// `--kinds` names (TODO-036 D15); `hardcoded` needs `--pseudo` (TODO-039 D15).
    public static let kindNames = ["untranslated", "raw-key", "placeholder", "hardcoded", "wrong-language", "uncatalogued"]

    // D30, amended by TODO-015 D1: last segments that make a line a domain or a file name, not a key.
    static let rawKey = try! NSRegularExpression(pattern: "^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)+$")
    static let notKeys: Set<String> = [
        "com", "net", "org", "io", "ai", "app", "dev", "co", "me", "info", "edu", "gov", "html", "htm", "php", "js",
        "json", "xml", "txt", "csv", "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "mp4", "mov", "zip",
        "md", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "odt", "ods", "epub", "mp3", "wav", "m4a", "aac",
        "flac", "ogg", "avi", "mkv", "webm", "m4v", "gz", "tgz", "tar", "rar", "dmg", "apk", "ipa", "ics", "vcf",
        "yaml", "yml", "shop", "store", "xyz", "online", "site", "tech", "cloud", "biz",
    ]
    /// Country-code top-level domains: ISO 3166-1 alpha-2 plus `uk`, `eu` and `ac` (TODO-015 D1, D2).
    static let countryCodes = Set(("""
        ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by
        bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk
        fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is
        it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm
        mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps
        pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk
        tl tm tn to tr tt tv tw tz ua ug uk um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw
        """).split(whereSeparator: { $0.isWhitespace }).map(String.init))

    /// Whether a line that matches the raw-key pattern after the D33 close-up is a domain, a file name or a tagline.
    static func notKey(_ closed: String, raw: String) -> Bool {
        let segs = closed.split(separator: ".").map(String.init)
        // TODO-015 D3: two or more spaced dots are prose (`denken. machen. teilen`); one is OCR noise (D33).
        let spaced = raw.components(separatedBy: ".").dropFirst().filter { $0.first?.isWhitespace == true }.count
        return segs.first == "www" || notKeys.contains(segs.last!) || countryCodes.contains(segs.last!) || spaced >= 2
    }
    // A conversion followed by a letter is prose ("50%discount"), and `%%` is a literal percent sign.
    static let fixed = "\\{\\{\\s*[A-Za-z_][\\w.]*\\s*\\}\\}|\\$\\{[A-Za-z_][\\w.]*\\}|\\{[A-Za-z_][\\w.]*\\}|(?<!%)%(?:\\d+\\$)?[@ds](?![A-Za-z])"
    static let byStyle: [String: String] = [
        "{0}": "\\{\\d+\\}",
        "icu": "\\{\\s*[A-Za-z_]\\w*\\s*,\\s*(?:plural|selectordinal|select|number|date|time)\\b[^{}]*",
        "printf": "(?<!%)%(?:\\d+\\$)?[-+#0']*(?:\\d+|\\*)?(?:\\.(?:\\d+|\\*))?(?:hh|h|ll|l|L|q|j|z|t)?[@dDiuUxXoOfFeEgGcCsSpaA](?![A-Za-z])",
    ]

    static func placeholderPattern(_ styles: Set<String>) -> NSRegularExpression {
        let extra = styles.sorted().compactMap { byStyle[$0] }
        return try! NSRegularExpression(pattern: ([fixed] + extra).joined(separator: "|"))
    }

    struct Window {
        var hay: [Character]
        var line: String
        var rect: CGRect
        var first: Int // index of its first line, for reading order
        var join: Int? = nil // joined windows: where the second line starts in `hay`
    }

    /// Lines in `skip` (raw keys) are not text, so rule 1 never reads them.
    static func windows(_ lines: [RecognizedLine], locale: String, skip: Set<Int> = []) -> [Window] {
        var out = lines.enumerated().filter { !skip.contains($0.offset) }.map { i, l in
            Window(hay: Array(TextMatch.normalize(l.text, locale: locale)), line: l.text, rect: l.rect, first: i)
        }
        if lines.count > 1 {
            for i in 0..<(lines.count - 1) where !skip.contains(i) && !skip.contains(i + 1) {
                let t = lines[i].text + " " + lines[i + 1].text
                out.append(Window(
                    hay: Array(TextMatch.normalize(t, locale: locale)), line: t, rect: lines[i].rect.union(lines[i + 1].rect), first: i,
                    join: TextMatch.normalize(lines[i].text, locale: locale).count))
            }
        }
        return out
    }

    /// TODO-031: whether `b` continues `a`: on the same row, or the next row starting near `a`'s left edge. Two
    /// neighboring labels (`play` and `back` buttons) are apart, so they never join into a key.
    /// Rects are normalized per axis; `aspect` (width / height) puts x in the units of y.
    static func continues(_ ra: CGRect, _ rb: CGRect, aspect: Double, sameRowOnly: Bool = false) -> Bool {
        let x = { (r: CGRect) in CGRect(x: r.minX * aspect, y: r.minY, width: r.width * aspect, height: r.height) }
        let a = x(ra), b = x(rb)
        let h = max(a.height, b.height)
        let sameRow = min(a.maxY, b.maxY) - max(a.minY, b.minY) > 0.5 * min(a.height, b.height)
        if sameRow { return b.minX >= a.minX && b.minX - a.maxX < 4 * h }
        if sameRowOnly || b.minY <= a.minY { return false } // the next line is below (rects are top-left)
        let gap = max(a.minY, b.minY) - min(a.maxY, b.maxY)
        return gap >= -0.5 * h && gap < 1.5 * h && abs(a.minX - b.minX) < 1.5 * h
    }

    /// TODO-010 D3: the most characters between two fragments of a match when all of them are short.
    static let maxGap = 64

    /// Every span where the fragments occur in order without overlap, each on word boundaries when `bounded`.
    static func spans(_ frags: [[Character]], in h: [Character], bounded: Bool) -> [Range<Int>] {
        guard let first = frags.first, !first.isEmpty else { return [] }
        let capped = frags.count > 1 && frags.allSatisfy { $0.count < TextMatch.minLength(unspaced: !bounded) }
        var out: [Range<Int>] = []
        var start = 0
        search: while let s = index(first, in: h, from: start, bounded: bounded) {
            var end = s + first.count
            start = s + 1
            for f in frags.dropFirst() {
                // The first later occurrence is the nearest, so no later start can find a fragment this one cannot.
                guard let i = index(f, in: h, from: end, bounded: bounded) else { break search }
                if capped && i - end > maxGap { continue search }
                end = i + f.count
            }
            out.append(s..<end)
        }
        return out
    }

    /// TODO-013 D1: Han, Kana, Hangul and Thai attach to a neighboring word without a space.
    static let closedScripts: Set<Scripts.Script> = [.han, .kana, .hangul, .thai]

    static func isClosed(_ c: Character) -> Bool {
        c.unicodeScalars.first.flatMap(Scripts.script(of:)).map(closedScripts.contains) ?? false
    }

    /// A word boundary between two neighbors in bounded matching: a non-word side, or a change into or out of a
    /// closed script (`settings|を開く`).
    static func boundary(_ a: Character?, _ b: Character?) -> Bool {
        guard let a, let b, TextMatch.isWordChar(a), TextMatch.isWordChar(b) else { return true }
        return isClosed(a) != isClosed(b)
    }

    static func index(_ n: [Character], in h: [Character], from: Int, bounded: Bool) -> Int? {
        if n.isEmpty || from + n.count > h.count { return nil }
        for i in from...(h.count - n.count) where h[i..<(i + n.count)].elementsEqual(n) {
            if !bounded { return i }
            let before = i == 0 ? nil : h[i - 1]
            let after = i + n.count == h.count ? nil : h[i + n.count]
            // A fragment edge that is punctuation (", welcome back" after a filled {name}) is its own boundary.
            if boundary(before, n.first) && boundary(n.last, after) { return i }
        }
        return nil
    }

    struct Entry {
        var pair: UntranslatedJob.Pair
        var text: String // the normalized base text, which groups keys (D13)
        var scripts: [Scripts.Script]
        var alternatives: [[[Character]]] // checkable fragments per alternative
        var longest: [[Character]] // per alternative: its longest fragment, the prefilter's probe (D18)
        var runs: [[String]] // per alternative: the letter-or-digit runs of `longest`
        var words: [Set<Int>] // per alternative: ids of the runs of all its fragments, the per-window prefilter (TODO-012 D3)
        var own: [[[Character]]] // this key's target alternatives, checkable (D10, D34)
        var shared: Bool
    }

    /// TODO-031: the catalog keys a misread line is matched against, built once per field (D32).
    struct KeyIndex {
        var exact: Set<String> = []
        var canon: [String: [String]] = [:] // canon(key) -> keys, case-sensitive
        var folded: [String: [String]] = [:] // canon(key) lowercased -> keys, for ALL CAPS lines
        var guarded: Set<String> = [] // canon forms (lowercased) that a catalog text also has
        var prefixes: [(String, String)] = [] // (canon(key), key), sorted, for keys cut by an ellipsis
        var textCanon: [String] = [] // canon of every catalog text, lowercased: the guard
        var shown: Set<String> = [] // every catalog text as `plain` folds it: a line equal to one is that text
        var verbatim: Set<String> = [] // every catalog text, whitespace collapsed, case kept
        var textShapes: [String] = [] // every catalog text as `shape` reads it: a cut text with a visible separator

        init() {}
        init(keys: [String], texts: [String]) {
            exact = Set(keys)
            shown = Set(texts.map(KeyIndex.plain))
            verbatim = Set(texts.map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") })
            // Lenient: any other character is a separator too, so `contact.support@example.com` guards its prefixes.
            guarded = Set(texts.compactMap { Untranslated.canon($0, lenient: true)?.lowercased() })
            textCanon = guarded.sorted()
            textShapes = Set(texts.map(KeyIndex.shape)).sorted()
            for k in keys.sorted() {
                // Only keys of two or more segments: a one-segment key (camelCase) matches exactly or not at all.
                guard let c = Untranslated.canon(k), c.contains(".") else { continue }
                canon[c, default: []].append(k)
                folded[c.lowercased(), default: []].append(k)
                prefixes.append((c, k))
            }
            prefixes.sort { $0.0 < $1.0 }
        }

        /// A line that is a key with its separators misread (`settings support`, `ui: shop:title`); case-sensitive,
        /// so a title (`Settings Support`) is text.
        func loose(_ t: String) -> [String]? {
            guard let c = Untranslated.canon(t), c.contains("."), open(c, t) else { return nil }
            return canon[c]
        }

        /// Lowercased, whitespace collapsed: how a line is compared with the catalog texts.
        static func plain(_ s: String) -> String {
            s.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        }

        func isText(_ t: String) -> Bool { shown.contains(KeyIndex.plain(t)) }

        /// Lowercased, outer punctuation dropped, a run of spaces kept as one space and any other run of non-letters
        /// read as `.`: `contact. support` and `contact.support@x` share a start, `game.over` and `game over` do not.
        static func shape(_ s: String) -> String {
            var out = "", gap = "", started = false
            for c in s.lowercased() {
                if c.isLetter || c.isNumber {
                    if started && !gap.isEmpty { out.append(gap.allSatisfy(\.isWhitespace) ? " " : ".") }
                    gap = ""; started = true; out.append(c)
                } else if started { gap.append(c) }
            }
            return out
        }

        /// The guard. A line equal to a catalog text is that text (`SIGN-IN` for `Sign-in`, `TIME LEFT:`). A form
        /// a catalog text also has (`Daily bonus` for `daily.bonus`) matches only when the line shows a key
        /// separator (`daily_bonus`, `DAILY.BONUS`); with spaces alone it is that text.
        func open(_ c: String, _ t: String) -> Bool {
            !isText(t) && (!guarded.contains(c.lowercased()) || Untranslated.visible(t)) && !textCut(c, t)
        }

        /// A line cut by an ellipsis whose visible part starts a catalog text (`contact.support...` for
        /// `contact.support@example.com`) is that text truncated, not a key. With a visible key separator the text
        /// must start with the line as shown (`game.over...` is no cut `Game over`).
        func textCut(_ c: String, _ t: String) -> Bool {
            var p = t
            if p.hasSuffix("...") { p.removeLast(3) } else if p.hasSuffix("\u{2026}") { p.removeLast() } else { return false }
            if Untranslated.visible(p) {
                let part = KeyIndex.shape(p)
                return !part.isEmpty && textShapes.contains { $0.hasPrefix(part) }
            }
            let lower = c.lowercased()
            return textCanon.contains { $0.hasPrefix(lower) }
        }

        /// A key in ALL CAPS styling (`SETTINGS.SUPPORT`). A caps line needs a visible separator, so `SETTINGS
        /// SUPPORT` and `SETTINGS: SUPPORT` stay titles.
        func caps(_ t: String) -> [String]? {
            guard t.contains(where: \.isLetter), !t.contains(where: \.isLowercase), Untranslated.visible(t),
                  let c = Untranslated.canon(t)?.lowercased(), c.contains("."), open(c, t) else { return nil }
            return folded[c]
        }

        /// A key cut by an ellipsis (`onboarding.permissions.notif...`): the visible part, 8 or more characters with
        /// a separator, starts one or more catalog keys and no catalog text. More than 10 candidates name none.
        func cut(_ t: String) -> [String]? {
            var p = t
            if p.hasSuffix("...") { p.removeLast(3) } else if p.hasSuffix("\u{2026}") { p.removeLast() } else { return nil }
            p = p.trimmingCharacters(in: .whitespaces)
            guard p.count >= 8, p.contains(where: { Untranslated.keySeparators.contains($0) }),
                  let c = Untranslated.canon(p), c.contains(".") else { return nil }
            let lower = c.lowercased()
            if isText(t) || textCanon.contains(where: { $0.hasPrefix(lower) }) { return nil }
            let ks = starting(with: c)
            if ks.isEmpty { return nil }
            return ks.count <= 10 ? ks : []
        }

        /// Exact catalog keys among the whitespace tokens of a line (outer punctuation trimmed), with their range in
        /// the line. Only keys with a `.` or `_` and two segments that are no catalog text: a hyphenated or slashed
        /// key (`e-mail`, `km/h`) is a word in prose.
        func tokens(in t: String) -> [(String, Range<String.Index>)] {
            var out: [(String, Range<String.Index>)] = []
            for raw in t.split(whereSeparator: \.isWhitespace) {
                // `{player_name}` is a placeholder (rule 3), not the key `player_name`.
                if raw.contains("{") || raw.contains("}") { continue }
                let tok = raw.trimmingCharacters(in: Untranslated.tokenTrim)
                guard tok.contains(where: { $0 == "." || $0 == "_" }), exact.contains(tok),
                      let c = Untranslated.canon(tok), c.contains("."), !isText(tok), !textCut(c, String(raw)),
                      let r = raw.range(of: tok) else { continue }
                out.append((tok, r))
            }
            return out
        }

        /// Keys whose canon starts with `p`: binary search on the sorted canon forms.
        func starting(with p: String) -> [String] {
            var lo = 0, hi = prefixes.count
            while lo < hi { let m = (lo + hi) / 2; if prefixes[m].0 < p { lo = m + 1 } else { hi = m } }
            var out: [String] = []
            while lo < prefixes.count, prefixes[lo].0.hasPrefix(p) { out.append(prefixes[lo].1); lo += 1 }
            return out
        }
    }

    // TODO-031: a key's separators, and what Vision reads them as (a space above all, on bold and outlined text).
    static let keySeparators: Set<Character> = [".", "_", "-", "/", ":"]
    static let readSeparators: Set<Character> = [",", "·", "•", "‧", "∙", "|"]
    /// Punctuation around a key inside a sentence (`Tippe auf menu.play.`, `"settings.support":`).
    /// A separator Vision kept: a key separator, or a `,` or `|` misread of one, between two letters or digits; a
    /// `.` before a space (D33); or a middle dot or bullet. `SETTINGS: SUPPORT` and `OPTIONS - AUDIO` are title
    /// punctuation.
    static func visible(_ t: String) -> Bool {
        let c = Array(t)
        let word = { (i: Int) in i >= 0 && i < c.count && (c[i].isLetter || c[i].isNumber) }
        for (i, ch) in c.enumerated() {
            if ["·", "•", "‧", "∙"].contains(ch) { return true }
            guard keySeparators.contains(ch) || ch == "," || ch == "|", word(i - 1) else { continue }
            if word(i + 1) || (ch == "." && i + 1 < c.count && c[i + 1] == " " && word(i + 2)) { return true }
        }
        return false
    }

    static let tokenTrim = CharacterSet(charactersIn: ".,:;!?()[]{}\"'«»“”„‚‘’")

    /// TODO-031: letter-or-digit runs joined by `.`, or nil when the string has any other character.
    static func canon(_ s: String, lenient: Bool = false) -> String? {
        var out = ""
        var gap = false
        for c in s {
            if c.isLetter || c.isNumber {
                if gap && !out.isEmpty { out.append(".") }
                gap = false
                out.append(c)
            } else if lenient || c.isWhitespace || keySeparators.contains(c) || readSeparators.contains(c) {
                gap = true
            } else {
                return nil
            }
        }
        return out.isEmpty ? nil : out
    }

    struct Prepared {
        var keys = KeyIndex()
        var entries: [Entry]
        var ids: [String: Int] // every word of every base fragment, so a window's words compare as integers
        var allow: Set<String>
        var targets: [[[Character]]]
    }

    /// Results shared across jobs; computed outside the lock so parallel preparation does not serialize on it.
    final class Memo {
        private let lock = NSLock()
        private var values: [String: Any] = [:]

        func get<T>(_ key: String, _ make: () -> T) -> T {
            lock.lock()
            let hit = values[key] as? T
            lock.unlock()
            if let hit { return hit }
            let v = make()
            lock.lock()
            values[key] = v
            lock.unlock()
            return v
        }
    }

    final class Box {
        let lock = NSLock()
        var value: Prepared?

        func get(_ make: () -> Prepared) -> Prepared {
            lock.lock()
            defer { lock.unlock() }
            if let v = value { return v }
            let v = make()
            value = v
            return v
        }
    }

    /// Letter-or-digit runs, split at a closed-script change too (TODO-013 D1), so each is a bounded word.
    static func runs(_ h: [Character]) -> [String] {
        var out: [String] = []
        var cur = ""
        var prev: Character? = nil
        for c in h {
            if !TextMatch.isWordChar(c) || (prev != nil && boundary(prev, c)) {
                if !cur.isEmpty { out.append(cur) }
                cur = ""
            }
            if TextMatch.isWordChar(c) { cur.append(c) }
            prev = c
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    /// TODO-010 D1, D2: the fragments of one alternative, normalized with the base locale. An alternative with a
    /// fragment of the minimum length matches on those fragments, as before (`Uploaded {file} to {folder}` needs
    /// only `uploaded`). One whose fragments are all short is checked when they reach the length together, so
    /// `Go {name} on` is checked and `Go {name}` is not; a short fragment with no letter or digit never counts.
    static func checkable(_ alt: [String], locale bl: String) -> [[Character]] {
        let frags = alt.map { TextMatch.normalize($0, locale: bl) }.filter { !$0.isEmpty }
        let long = frags.filter { !TextMatch.isShort($0, locale: bl) }
        if !long.isEmpty { return long.map { Array($0) } }
        let words = frags.filter { $0.contains(where: TextMatch.isWordChar) }
        return TextMatch.isShort(words.joined(), locale: bl) ? [] : words.map { Array($0) }
    }

    static func prepare(_ u: UntranslatedJob) -> Prepared {
        let bl = u.baseLocale
        let norm = { (s: String) in TextMatch.normalize(s, locale: bl) }
        // D35, D36: shared when the words match without punctuation and diacritics (`« TAP TO START »`, and Vision
        // reading `MENÜ` as `MENU`, cannot tell a translation from its base string).
        let words = { (alt: [String]) -> [String] in
            alt.flatMap { runs(Array(norm($0).folding(options: .diacriticInsensitive, locale: nil))) }
        }
        let checkable = { (alt: [String]) in Untranslated.checkable(alt, locale: bl) }
        // TextMatch.normalize depends on the locale only through the homoglyph fold and unspaced joining.
        let b = TextMatch.base(bl)
        let cls = "\(TextMatch.cyrillicFold.contains(b) || !TextMatch.nonLatin.contains(b))\(TextMatch.unspaced.contains(b))"
        func shared<T>(_ kind: String, _ alt: [String], _ make: ([String]) -> T) -> T {
            guard let m = u.memo else { return make(alt) }
            return m.get("\(kind)\(cls)\u{1}" + alt.joined(separator: "\u{1}")) { make(alt) }
        }
        var ids: [String: Int] = [:]
        let id = { (w: String) -> Int in
            if let v = ids[w] { return v }
            ids[w] = ids.count
            return ids.count - 1
        }
        let entries = u.pairs.map { p -> Entry in
            let alts = p.baseAlternatives.map(checkable).filter { !$0.isEmpty }
            let t = Set(p.targetAlternatives.map { shared("w", $0, words) })
            return Entry(
                pair: p, text: norm(p.base), scripts: Scripts.scripts(in: p.base), alternatives: alts,
                longest: alts.map { a in a.max { $0.count < $1.count }! },
                runs: alts.map { a in runs(a.max { $0.count < $1.count }!) },
                words: alts.map { a in Set(a.flatMap { runs($0) }.map(id)) },
                own: p.targetAlternatives.map { shared("c", $0, checkable) }.filter { !$0.isEmpty },
                shared: p.baseAlternatives.contains { t.contains(words($0)) })
        }
        return Prepared(keys: KeyIndex(keys: u.keys, texts: u.texts), entries: entries, ids: ids, allow: Set(u.allow.map(norm)), targets: u.targets.map { shared("c", $0, checkable) }.filter { !$0.isEmpty })
    }

    struct Group {
        var pairs: [UntranslatedJob.Pair] // sorted by key; the first one is reported (D13)
        var alternatives: [[[Character]]] // checkable, normalized with the base locale
        var words: [Set<Int>] // per alternative, as `Entry.words`
        var own: [[[Character]]] // every key's target alternatives
    }

    public static func evaluate(
        _ u: UntranslatedJob, lines: [RecognizedLine], locale: String, guardScripts: Bool, aspect: Double = 1
    ) -> ([Finding], [Diagnostic]) {
        var warnings: [Diagnostic] = []
        let bl = u.baseLocale
        let bounded = !TextMatch.isUnspaced(bl)
        let checkable = { (alt: [String]) in Untranslated.checkable(alt, locale: bl) }
        let prep = u.prepared.get { prepare(u) }
        let allowLine = Set(u.allow.map { TextMatch.normalize($0, locale: locale) })

        // Rules 2 and 3 read single lines as recognized, after NFKC (Vision reads full-width braces on CJK screens).
        var located: [(Int, Int, Finding)] = []
        var keyLines = Set<Int>()
        var masked = lines // rule 1 reads these: a catalog key inside a line is blanked (TODO-031)
        let keyIndex = prep.keys
        let placeholder = u.baseOnly ? nil : placeholderPattern(u.styles)
        let clean = { (l: RecognizedLine) in l.text.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespaces) }
        let allowedLine = { (t: String) in allowLine.contains(TextMatch.normalize(t, locale: locale)) }
        let rawKeyFinding = { (i: Int, box: CGRect, line: String, keys: [String]) -> Finding in
            var f = Finding(kind: "raw-key", box: Geometry.box(box), line: line)
            if keys.count == 1 { f.key = keys[0] } else if !keys.isEmpty { f.keys = keys }
            return f
        }
        // TODO-031: a key split into two observations, or wrapped over two lines, is one finding with its key.
        if !u.baseOnly && lines.count > 1 {
            var i = 0
            while i < lines.count - 1 {
                // Same row, right to left (an RTL screen lists the right part first): the left part comes first.
                let (x, y) = continues(lines[i + 1].rect, lines[i].rect, aspect: aspect, sameRowOnly: true) ? (i + 1, i) : (i, i + 1)
                let a = clean(lines[x]), b = clean(lines[y])
                // Two labels that are catalog texts or keys on their own are two controls, not one split key. One
                // label next to a part with a `.` or `_` at the seam is still a split key (`settings.` + `support`).
                // Case kept: `support` beside `settings.` is the owner's split key even with a base string `Support`.
                // A seam is a `.` or `_`, or a break inside a word (`SETTINGS.SUPP` + `ORT`: a label wraps a long key
                // by character); other punctuation is a label and its value (`SETTINGS:` + `SUPPORT`).
                let inWord = (a.last.map { $0.isLetter || $0.isNumber } ?? false) && (b.first.map { $0.isLetter || $0.isNumber } ?? false)
                let dot = a.last == "." || a.last == "_" || b.first == "." || b.first == "_"
                let seam = inWord || dot
                let label = { (s: String) -> Bool in keyIndex.verbatim.contains(s) || keyIndex.exact.contains(s) }
                let labels = [label(a), label(b)].filter { $0 }.count
                let blocked = a.isEmpty || b.isEmpty || allowedLine(a) || allowedLine(b) || labels == 2 || (labels == 1 && !dot)
                if !blocked, !allowedLine(a + " " + b) {
                    let ab = a + b
                    let exactKey = ab.contains(where: { keySeparators.contains($0) }) && keyIndex.exact.contains(ab)
                    // Only a seam glues the parts; `SETTINGS:` + `SUPPORT` reads like the one line `SETTINGS: SUPPORT` (D10).
                    let spaced = a + " " + b
                    let glued = seam ? ab : spaced
                    var keys: [String] = []
                    if exactKey { keys = [ab] } else if let k = keyIndex.loose(glued) ?? keyIndex.loose(spaced) ?? keyIndex.caps(glued) ?? keyIndex.caps(spaced) { keys = k }
                    if !keys.isEmpty && continues(lines[x].rect, lines[y].rect, aspect: aspect) {
                        keyLines.formUnion([i, i + 1])
                        located.append((i, 0, rawKeyFinding(i, lines[x].rect.union(lines[y].rect), a + " " + b, keys)))
                        i += 2
                        continue
                    }
                }
                i += 1
            }
        }
        for (i, l) in lines.enumerated() where !u.baseOnly {
            let t = clean(l)
            if t.isEmpty || allowedLine(t) { continue }
            let whole = NSRange(t.startIndex..., in: t)
            if !keyLines.contains(i) {
                // Vision often reads `settings.language` as `settings. language` (D33).
                let k = t.replacingOccurrences(of: "\\.\\s+", with: ".", options: .regularExpression)
                var keys: [String]? = keyIndex.exact.contains(k) ? [k] : nil
                if keys == nil, rawKey.firstMatch(in: k, range: NSRange(k.startIndex..., in: k)) != nil, !notKey(k, raw: t) { keys = [] }
                if keys == nil { keys = keyIndex.loose(t) ?? keyIndex.caps(t) ?? keyIndex.cut(t) }
                if let keys {
                    keyLines.insert(i)
                    located.append((i, 0, rawKeyFinding(i, l.rect, t, keys)))
                } else {
                    // TODO-031: a catalog key inside a longer line (`Einstellungen: settings.support`).
                    // The key's own characters are blanked in the read text, so rule 1 never reads them (red team).
                    let found = keyIndex.tokens(in: t)
                    var blanked = t
                    for (token, r) in found.reversed() {
                        located.append((i, t.distance(from: t.startIndex, to: r.lowerBound) + 1, rawKeyFinding(i, l.rect, t, [token])))
                        blanked.replaceSubrange(r, with: String(repeating: " ", count: token.count))
                    }
                    if !found.isEmpty { masked[i].text = blanked }
                }
            }
            var seen = Set<String>()
            for m in placeholder!.matches(in: t, range: whole) {
                let token = String(t[Range(m.range, in: t)!])
                guard seen.insert(token).inserted else { continue }
                var f = Finding(kind: "placeholder", box: Geometry.box(l.rect), line: t)
                f.token = token
                located.append((i, m.range.location + 1, f))
            }
        }

        // Rule 1. D18: a key whose longest fragment is not on the screen cannot match, so most keys stop here.
        let wins = windows(masked, locale: bl, skip: keyLines)
        // A bounded match keeps every letter-or-digit run of the fragment whole, so each run must be a screen word.
        let words = Set(wins.flatMap { runs($0.hay) })
        let screen = bounded ? "" : wins.map { String($0.hay) }.joined(separator: "\n")
        let screenChars = Set(screen)
        var byText: [String: [(Entry, [Int])]] = [:]
        var unreadable = 0
        let readable = Scripts.readable(locale)
        for e in prep.entries {
            if guardScripts, e.scripts.contains(where: { !readable.contains($0) }) {
                unreadable += 1
                continue
            }
            let live = e.alternatives.indices.filter { i in
                // TODO-036 T2: a fragment with a character the screen lacks cannot occur in it; the set test is far
                // cheaper than the substring search it guards (13 locales x 1,100 strings per image).
                bounded ? e.runs[i].allSatisfy(words.contains) : e.longest[i].allSatisfy(screenChars.contains) && screen.contains(String(e.longest[i]))
            }
            if !live.isEmpty { byText[e.text, default: []].append((e, live)) }
        }
        if unreadable > 0 {
            warnings.append(Diagnostic(
                "untranslated-unreadable",
                "\(unreadable) base string\(unreadable == 1 ? " uses" : "s use") a script the locale \(locale) cannot read; \(unreadable == 1 ? "it was" : "they were") not checked.",
                hint: "check those screens with --locale for the base language"))
        }
        // D13: keys with one base text are one group; a shared or allowed text is never flagged.
        var groups: [Group] = []
        for (text, es) in byText where !text.isEmpty && !prep.allow.contains(text) {
            if es.contains(where: { $0.0.shared }) { continue }
            let sorted = es.sorted { $0.0.pair.key < $1.0.pair.key }
            let (e, live) = sorted[0]
            groups.append(Group(
                pairs: sorted.map(\.0.pair), alternatives: live.map { e.alternatives[$0] }, words: live.map { e.words[$0] },
                own: sorted.flatMap(\.0.own)))
        }
        let targets = prep.targets

        // TODO-014 D3: the target side of D10 and D34 depends on the window only, so it is computed once per window.
        var targetSpans: [Int: [Range<Int>]] = [:]
        var inTarget: [Int: Bool] = [:]
        func partOf(_ ts: [[[Character]]], _ hay: [Character]) -> Bool {
            ts.contains { t in t.contains { f in f.count >= hay.count && index(hay, in: f, from: 0, bounded: false) != nil } }
        }
        // TODO-014 D1: the floor for a window that is only part of a base fragment (a wrapped paragraph).
        let partialWords = 3, partialChars = 16
        // A window inside an allowed phrase (one line of it, or the phrase wrapped over two), or an allowed line joined
        // to a neighbor, is never a partial window.
        func allowed(_ w: Window) -> Bool {
            let hay = String(w.hay)
            if prep.allow.contains(where: { $0.contains(hay) }) { return true }
            guard let j = w.join else { return false }
            return prep.allow.contains(String(w.hay[..<j])) || prep.allow.contains(String(w.hay[j...]).trimmingCharacters(in: .whitespaces))
        }
        // TODO-014 D10: only spaced base locales, where a word boundary anchors the window inside the fragment.
        let partial = wins.map { bounded && $0.hay.count >= partialChars && runs($0.hay).count >= partialWords }
        // TODO-012 D3: the D18 prefilter per window. A bounded match keeps every word of its fragments whole, so an
        // alternative with a word the window lacks cannot match there; only then are its spans searched.
        // A word no base fragment has is -1: it fails every partial-window subset test, as a string word would.
        let winWords = bounded ? wins.map { Set(runs($0.hay).map { prep.ids[$0] ?? -1 }) } : []

        struct Hit { var group: Group; var window: Int; var span: Range<Int>; var partial = false }
        var hits: [Hit] = []
        for g in groups {
            let own = g.own
            // TODO-011 D1: the first unsuppressed match in every window, so a hit lost to D12 does not end the group.
            search: for (wi, w) in wins.enumerated() {
                // Lazy: most windows of a live group never match, and then the targets are never read.
                let tSpans = { () -> [Range<Int>] in
                    if let v = targetSpans[wi] { return v }
                    let v = targets.flatMap { spans($0, in: w.hay, bounded: bounded) }
                    targetSpans[wi] = v
                    return v
                }
                let whole = { () -> Bool in
                    if let v = inTarget[wi] { return v }
                    let v = partOf(targets, w.hay)
                    inTarget[wi] = v
                    return v
                }
                for (ai, alt) in g.alternatives.enumerated() where !bounded || g.words[ai].isSubset(of: winWords[wi]) {
                    // A joined window only adds matches across the line break; one line decides its own (D34).
                    for span in spans(alt, in: w.hay, bounded: bounded) where w.join.map({ span.lowerBound < $0 && span.upperBound > $0 }) ?? true {
                        // D10, D33: a target occurrence in the same window that overlaps the match without lying
                        // strictly inside it (`Download` in `Download starten`, a line joined to its neighbor, or the
                        // same text: de `Start` for one key is en `Start` of another) makes it translation.
                        let covers = { (t: Range<Int>) in
                            t.overlaps(span) && (t == span || !(span.lowerBound <= t.lowerBound && t.upperBound <= span.upperBound))
                        }
                        let covered = tSpans().contains(where: covers)
                            || own.contains { spans($0, in: w.hay, bounded: bounded).contains(where: covers) }
                        // D34: a line with more text than the match that is part of a target string is a wrapped
                        // translation quoting the base word (`Der „STOP"-Arm war raus.`).
                        let inside = w.hay.count > span.count && (whole() || partOf(own, w.hay))
                        if !covered && !inside { hits.append(Hit(group: g, window: wi, span: span)); continue search }
                    }
                }
                // TODO-014 D1, D2: a window that is a word-bounded part of one longer base fragment, and of no target.
                if partial[wi] && !allowed(w)
                    // A window inside a fragment has only words of that fragment (bounded, as the full match above).
                    && g.alternatives.indices.contains(where: { ai in
                        winWords[wi].isSubset(of: g.words[ai])
                            && g.alternatives[ai].contains { f in f.count > w.hay.count && index(w.hay, in: f, from: 0, bounded: bounded) != nil }
                    })
                    && !whole() && !partOf(own, w.hay)
                {
                    hits.append(Hit(group: g, window: wi, span: 0..<w.hay.count, partial: true))
                }
            }
        }
        // D12: in one window, the longer of two overlapping matches wins.
        // Compared within each window only: a group can now hold a hit in every window (TODO-011).
        let byWindow = Dictionary(grouping: hits, by: \.window)
        let kept = hits.filter { h in
            !byWindow[h.window]!.contains { o in
                o.span.overlaps(h.span)
                    && (o.span.count > h.span.count
                        // TODO-014: a window that is exactly one string beats a paragraph it is part of.
                        || (o.span.count == h.span.count && (o.partial ? 1 : 0, o.group.pairs[0].key) < (h.partial ? 1 : 0, h.group.pairs[0].key)))
            }
        }
        // D12, D13: one finding per base text, at its first surviving window in reading order (TODO-011 D1).
        var reported = Set<String>()
        let first = kept.sorted { a, b in
            let x = wins[a.window], y = wins[b.window]
            return (x.first, x.join == nil ? 0 : 1, a.span.lowerBound) < (y.first, y.join == nil ? 0 : 1, b.span.lowerBound)
        }.filter { reported.insert($0.group.pairs[0].key).inserted }
        for h in first {
            let p = h.group.pairs[0]
            let w = wins[h.window]
            var f = Finding(kind: "untranslated", box: Geometry.box(w.rect), line: w.line)
            f.key = p.key
            f.keys = h.group.pairs.count > 1 ? h.group.pairs.map(\.key) : nil
            f.catalog = p.catalog
            f.base = p.base
            f.expected = p.expected
            located.append((w.first, h.span.lowerBound, f))
        }
        let findings = located.enumerated().sorted { a, b in
            (a.element.0, a.element.1, a.offset) < (b.element.0, b.element.1, b.offset)
        }.map { $0.element.2 }
        return (findings, warnings)
    }
}
