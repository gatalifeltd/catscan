// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation
import NaturalLanguage

/// TODO-036 T2: the `wrong_language` part of the `untranslated` request. Catalog evidence is spec 17's base-string
/// rule run once per other project locale (D25); language ID covers the lines no catalog explains.
public struct WrongLanguageJob {
    /// One other project locale: its strings as the base, the run locale's strings as the target (D25).
    public struct Other {
        public var locale: String
        public var catalog: String // the file that matched (`evidence_catalog`, D19)
        public var job: UntranslatedJob

        public init(locale: String, catalog: String, job: UntranslatedJob) {
            self.locale = locale
            self.catalog = catalog
            self.job = job
        }
    }

    /// Project locales for the recognizer's constraint set (catalog locales or `--languages`), without the run locale.
    public var languages: [String] = []
    public var others: [Other] = []
    /// The locale named first when several catalogs hold a line (D25): the base locale when it is one.
    public var preferred: String? = nil
    /// The run locale's strings normalized for the in-target test, once per field (shared by every image).
    let normalizedTargets = Cache<[String]>() // keyed by run locale

    public init() {}
}

/// Values computed once per key and shared by the copies of a job (as `Untranslated.Box`).
final class Cache<T> {
    private let lock = NSLock()
    private var values: [String: T] = [:]

    func get(_ key: String, _ make: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        if let v = values[key] { return v }
        let v = make()
        values[key] = v
        return v
    }
}

public enum WrongLanguage {
    /// D23 / spec: the recognizer's thresholds and the minimum line for language ID.
    static let minTop = 0.95, maxRun = 0.02
    static let minWords = 3, minLetters = 15, minClosedChars = 8, minScriptLetters = 4

    /// A locale tag as `NLLanguage`: `pt-BR` -> pt, `zh-Hant`/`zh-TW`/`zh-HK` -> zh-Hant, other zh -> zh-Hans.
    static func nl(_ locale: String) -> NLLanguage {
        let parts = locale.lowercased().replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
        let base = parts.first ?? ""
        switch base {
        case "zh", "yue":
            return parts.contains(where: { ["hant", "tw", "hk", "mo"].contains($0) }) || base == "yue" ? .traditionalChinese : .simplifiedChinese
        case "no", "nn": return .norwegian
        case "nb": return .norwegian
        case "iw": return .hebrew
        default: return NLLanguage(rawValue: base)
        }
    }

    /// The verdict of language ID, a pure function over the recognizer's hypotheses (D6), so tests use literal tables.
    /// Returns the winning language when it is not the run language at >= 0.95 and the run language is <= 0.02.
    static func verdict(_ hyp: [NLLanguage: Double], run: NLLanguage) -> (NLLanguage, Double)? {
        guard let top = hyp.max(by: { ($0.value, $1.key.rawValue) < ($1.value, $0.key.rawValue) }) else { return nil }
        guard top.key != run, top.value >= minTop, (hyp[run] ?? 0) <= maxRun else { return nil }
        return (top.key, top.value)
    }

    /// Letters of a line, and whether it is mostly a closed script (Han, Kana, Hangul, Thai), where no spaces split words.
    static func measure(_ t: String) -> (letters: Int, words: Int, closed: Bool) {
        var letters = 0, closed = 0
        for u in t.unicodeScalars where u.properties.isAlphabetic {
            letters += 1
            if let s = Scripts.script(of: u), [.han, .kana, .hangul, .thai].contains(s) { closed += 1 }
        }
        // A word has 2 or more letters: an OCR fragment (`[Е`) is not one (real-screen review, D31).
        let words = t.split(whereSeparator: { $0.isWhitespace }).filter { $0.unicodeScalars.filter { $0.properties.isAlphabetic }.count >= 2 }.count
        return (letters, words, letters > 0 && closed * 2 > letters)
    }

    /// Whether a line is long enough for the recognizer: 3 words and 15 letters, or 8 letters of a closed script.
    static func judgeable(_ t: String) -> Bool {
        let m = measure(t)
        return m.closed ? m.letters >= minClosedChars : m.words >= minWords && m.letters >= minLetters
    }

    /// D23: the one non-Latin script every letter of the line is in, when the run locale does not write it.
    static func foreignScript(_ t: String, locale: String) -> Scripts.Script? {
        let letters = t.unicodeScalars.filter { $0.properties.isAlphabetic }
        guard letters.count >= minScriptLetters else { return nil }
        let scripts = Set(letters.compactMap { Scripts.script(of: $0) })
        // Kana and Han together are Japanese; Hangul with Han is Korean.
        let one: Scripts.Script? = scripts.count == 1 ? scripts.first
            : scripts == [.kana, .han] ? .kana : scripts == [.hangul, .han] ? .hangul : nil
        guard let s = one, s != .latin, s != .other else { return nil }
        // Han on a ja or ko screen is native (`readable` lists it); Kana on a zh screen is not.
        return Scripts.readable(locale).contains(s) ? nil : s
    }

    /// The hypotheses the recognizer gives a line under a constraint set (only the integration golden runs it, D6).
    static func hypotheses(_ t: String, constraints: [NLLanguage]) -> [NLLanguage: Double] {
        let r = NLLanguageRecognizer()
        if !constraints.isEmpty { r.languageConstraints = constraints }
        r.processString(t)
        return r.languageHypotheses(withMaximum: max(constraints.count, 5))
    }

    /// Whether the line is (part of) a run-locale string: the line inside one of its fragments, or a fragment that
    /// covers at least half of the line inside it.
    static func inTarget(_ t: String, targets: [String]) -> Bool {
        guard !t.isEmpty else { return false }
        return targets.contains { f in
            f.contains(t) || (f.count * 2 >= t.count && f.count >= 4 && t.contains(f))
        }
    }

    /// Latin, Greek and Cyrillic letters without their accents (U+0300-U+036F after NFD). Vision on a screen of
    /// another script often drops them (`Anderungen` for `Änderungen` on a ja screen); kana voicing marks and Hangul
    /// stay as they are.
    static func foldMarks(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.decomposedStringWithCanonicalMapping.unicodeScalars where !(0x300...0x36F).contains(u.value) { out.append(u) }
        return String(out).precomposedStringWithCanonicalMapping
    }

    /// D31: a one-word string of another locale is evidence only when it is the whole line. A short word shared by
    /// two languages (`dans` fr and tr `Dans`, `desde` es and pt) inside a longer line is no wrong language.
    static func wholeOrPhrase(_ f: Finding, base: String, run: String) -> Bool {
        if TextMatch.isUnspaced(base) { return true }
        // Compared as rule 1 matched them: accents folded (the line is the folded read), words with a letter only
        // (a filled `{count}` is a number on screen).
        let words = { (s: String) in
            Untranslated.runs(Array(TextMatch.normalize(foldMarks(s), locale: base))).filter { $0.contains(where: \.isLetter) }
        }
        // Placeholders are not words of the string (`desde {date}` is one word).
        let pattern = "\\{[^}]*\\}|%(\\d+\\$)?[@a-zA-Z]"
        let base0 = f.base ?? ""
        guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
        // The string as words and placeholder slots (nil), in order.
        var tokens: [String?] = []
        var at = base0.startIndex
        for m in re.matches(in: base0, range: NSRange(base0.startIndex..., in: base0)) {
            let r = Range(m.range, in: base0)!
            tokens += words(String(base0[at..<r.lowerBound])).map { $0 }
            tokens.append(nil)
            at = r.upperBound
        }
        tokens += words(String(base0[at...])).map { $0 }
        if tokens.compactMap({ $0 }).count >= 2 { return true }
        // The whole line is the string, each placeholder filled by up to 2 words in its place (`Olá, Anna` for
        // `Olá, {name}`; a number is no word, so `3 articoli` is `{count} articoli`); `configurarlas desde Ajustes.`
        // is not `desde {date}`.
        let line = words(f.line)
        func fits(_ t: Int, _ l: Int) -> Bool {
            if t == tokens.count { return l == line.count }
            guard let w = tokens[t] else { return (0...2).contains { l + $0 <= line.count && fits(t + 1, l + $0) } }
            return l < line.count && line[l] == w && fits(t + 1, l + 1)
        }
        return fits(0, 0)
    }

    /// Catalog evidence, then language ID on the lines nothing reported. `reported` are the spec 17 findings
    /// (untranslated, raw keys, placeholders): wrong-language never reports their lines again (D5), except that a
    /// longer other-locale string beats a shorter base string inside it (`Download starten` holding `Download`, D12);
    /// `drop` names the findings it replaces.
    public static func evaluate(
        _ w: WrongLanguageJob, main: UntranslatedJob, lines: [RecognizedLine], locale: String, guardScripts: Bool,
        aspect: Double, reported: [Finding]
    ) -> (add: [(line: Int, finding: Finding)], drop: Set<Int>) {
        var out: [(line: Int, finding: Finding)] = []
        let owned = reported.map { Engine.reported([$0], lines) }
        var taken = owned.reduce(into: Set<Int>()) { $0.formUnion($1) }
        var drop = Set<Int>()
        let allow = Set(main.allow.map { TextMatch.normalize($0, locale: locale) })
        let order = w.others.sorted { a, b in
            let pa = a.locale == w.preferred ? 0 : 1, pb = b.locale == w.preferred ? 0 : 1
            return (pa, a.locale) < (pb, b.locale)
        }
        // The other locales are prepared once per field, in parallel (D28 performance bar).
        DispatchQueue.concurrentPerform(iterations: order.count) { i in _ = order[i].job.prepared.get { Untranslated.prepare(order[i].job) } }
        let folded = lines.map { RecognizedLine(text: foldMarks($0.text), rect: $0.rect, confidence: $0.confidence) }
        // Catalog evidence: rule 1 with the other locale as the base. One finding per line; the first locale wins.
        for o in order {
            let (found, _) = Untranslated.evaluate(o.job, lines: folded, locale: locale, guardScripts: guardScripts, aspect: aspect)
            for f in found where f.kind == "untranslated" && wholeOrPhrase(f, base: o.job.baseLocale, run: locale) {
                let at = Engine.reported([f], lines)
                guard let first = at.min() else { continue }
                if !at.isDisjoint(with: taken) {
                    // Only a shorter untranslated base string on these lines gives way; anything else keeps the line.
                    let length = { (s: String?) in TextMatch.normalize(s ?? "", locale: o.locale).count }
                    let rivals = reported.indices.filter { !owned[$0].isDisjoint(with: at) && !drop.contains($0) }
                    guard !rivals.isEmpty, out.allSatisfy({ at.isDisjoint(with: Engine.reported([$0.finding], lines)) }),
                        rivals.allSatisfy({ reported[$0].kind == "untranslated" && length(reported[$0].base) < length(f.base) && owned[$0].isSubset(of: at) })
                    else { continue }
                    drop.formUnion(rivals)
                }
                var g = Finding(kind: "wrong-language", box: f.box, line: at.sorted().map { lines[$0].text }.joined(separator: " "))
                g.language = o.locale
                g.expectedLanguage = locale
                g.evidence = "catalog"
                g.confidence = 1
                g.key = f.key
                g.keys = f.keys
                g.catalog = f.catalog
                g.expected = f.expected
                g.evidenceCatalog = o.catalog
                taken.formUnion(at)
                out.append((first, g))
            }
        }
        // Language ID on single lines no rule reported.
        let run = nl(locale)
        var constraints: [NLLanguage] = [run]
        var tagOf: [NLLanguage: String] = [:]
        for l in w.languages {
            let n = nl(l)
            if tagOf[n] == nil { tagOf[n] = l }
            if !constraints.contains(n) { constraints.append(n) }
        }
        let targets = w.normalizedTargets.get(locale) { main.targets.flatMap { $0 }.map { TextMatch.normalize($0, locale: locale) } }
        for (i, l) in lines.enumerated() where !taken.contains(i) {
            let t = l.text.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespaces)
            let n = TextMatch.normalize(t, locale: locale)
            if n.isEmpty || allow.contains(n) || inTarget(n, targets: targets) { continue }
            if !t.unicodeScalars.contains(where: { $0.properties.isAlphabetic }) { continue }
            var hit: (String, Double)? = nil
            if let s = foreignScript(t, locale: locale) {
                // D23: the script decides; the recognizer only names the language, among project languages in it.
                let inScript = constraints.filter { c in tagOf[c].map { Scripts.readable($0).contains(s) } ?? false }
                let h = hypotheses(t, constraints: inScript)
                let best = h.max { $0.value < $1.value }?.key
                hit = (best.flatMap { tagOf[$0] } ?? best?.rawValue ?? "und", 1)
            } else if constraints.count > 1, judgeable(t) {
                // D31: the language must write every non-Latin script of the line (a Greek line is never es).
                if let (lang, p) = verdict(hypotheses(t, constraints: constraints), run: run),
                    Set(Scripts.scripts(in: t)).subtracting([.latin]).isSubset(of: Scripts.readable(tagOf[lang] ?? lang.rawValue)) {
                    hit = (tagOf[lang] ?? lang.rawValue, (p * 100).rounded() / 100)
                }
            }
            guard let (lang, p) = hit else { continue }
            var g = Finding(kind: "wrong-language", box: Geometry.box(l.rect), line: t)
            g.language = lang
            g.expectedLanguage = locale
            g.evidence = "langid"
            g.confidence = p
            out.append((i, g))
        }
        return (out, drop)
    }
}
