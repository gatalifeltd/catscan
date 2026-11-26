// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import AppKit
import Foundation

/// TODO-067 D31: the `dictionary` stacked signal. Two pages drawn over each other can read confidently as non-words
/// (`45ppettues sriorahd dy`), which the correction signal cannot see. A line fires when at least 2 of its words are
/// unknown to the macOS dictionaries and they are at least half of its checkable words. Frozen on calibration data by
/// bench/stacked-dictionary.js, whose helper bench/stacked/spell.swift this lookup mirrors: change both together.
public enum StackedDictionary {
    public enum Word: Equatable { case unchecked, known, unknown }
    /// (locale, word with its digits dropped) -> verdict.
    public typealias Lookup = @Sendable (String, String) -> Word

    static let punctuation = Set(".,:;!?()[]{}\"'«»“”„‚‘’-–/\\|*•·…%+=<>#@&_~^$€£¥")
    static let minUnknown = 2

    /// Tokens: whitespace-split words without edge punctuation; digits are dropped before the lookup (`45ppettues`);
    /// under 3 letters and all-caps words of at most 4 letters are skipped (TODO-053's skips, digits aside).
    public static func fires(_ text: String, locale: String, lookup: Lookup) -> Bool {
        var unknown = 0, checkable = 0
        for raw in text.split(whereSeparator: { $0.isWhitespace }) {
            var w = Substring(raw)
            while let c = w.first, punctuation.contains(c) { w.removeFirst() }
            while let c = w.last, punctuation.contains(c) { w.removeLast() }
            let key = String(w.filter { !$0.unicodeScalars.allSatisfy { $0.properties.generalCategory == .decimalNumber } })
            let n = key.unicodeScalars.filter { $0.properties.isAlphabetic }.count
            if n < 3 || (n <= 4 && key == key.uppercased()) { continue }
            switch lookup(locale, key) {
            case .unchecked: continue
            case .known: checkable += 1
            case .unknown: checkable += 1; unknown += 1
            }
        }
        return unknown >= minUnknown && unknown * 2 >= checkable
    }

    /// The system spell checker. NSSpellChecker is not thread-safe and `serve` evaluates on a concurrent queue
    /// (TODO-053 D8), so every call goes through one serial queue, which also owns the cache.
    public static let system: Lookup = { locale, word in queue.sync { cached(locale, word) } }

    private static let queue = DispatchQueue(label: "catscan.stacked-dictionary")
    nonisolated(unsafe) private static var cache: [String: Word] = [:]
    nonisolated(unsafe) private static var languages: Set<String>? = nil
    static let maxCache = 50_000
    /// Run locales written in a non-Latin script: their words are checked with their own dictionary (TODO-053 D3).
    static let nonLatinLocales: Set<String> = ["ru", "uk", "bg", "el", "he", "ar", "ars", "ko", "hi", "pa", "te", "ja", "zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant", "th", "sr"]

    private static func cached(_ locale: String, _ word: String) -> Word {
        let k = locale + "\t" + word
        if let v = cache[k] { return v }
        let v = check(locale, word)
        if languages == nil { return v } // checked with no dictionaries listed yet: ask again, never keep (D35)
        if cache.count >= maxCache { cache.removeAll(keepingCapacity: true) } // serve lives long; OCR tokens are unbounded
        cache[k] = v
        return v
    }

    /// The spell service the rule asks (TODO-089 D5): AppleSpell in production, a fixed one in tests, since AppleSpell's
    /// guesses change from run to run and a test of the slip rule must not depend on them.
    struct Speller {
        var languages: () -> [String]
        var misspelled: (_ word: String, _ language: String) -> Bool
        var correction: (_ word: String, _ language: String) -> String?
        var guesses: (_ word: String, _ language: String) -> [String]
    }

    static let appleSpell = Speller(
        languages: { NSSpellChecker.shared.availableLanguages },
        misspelled: { w, l in
            NSSpellChecker.shared.checkSpelling(of: w, startingAt: 0, language: l, wrap: false, inSpellDocumentWithTag: 0, wordCount: nil).location != NSNotFound
        },
        correction: { w, l in NSSpellChecker.shared.correction(forWordRange: NSRange(location: 0, length: (w as NSString).length), in: w, language: l, inSpellDocumentWithTag: 0) },
        guesses: { w, l in NSSpellChecker.shared.guesses(forWordRange: NSRange(location: 0, length: (w as NSString).length), in: w, language: l, inSpellDocumentWithTag: 0) ?? [] })

    private static func check(_ locale: String, _ word: String) -> Word {
        let have = listed()
        return rule(locale, word, have: have, speller: appleSpell)
    }

    private static func listed() -> Set<String> {
        let have = languages ?? Set(appleSpell.languages())
        if !have.isEmpty { languages = have } // an empty answer (spell service not up yet) is asked again, never kept
        return have
    }

    /// One AppleSpell lookup, uncached, with every answer the rule used: a test that disagrees prints the answers of
    /// the lookup that disagreed, not of a second query (TODO-089 D5).
    static func explain(_ locale: String, _ word: String) -> (Word, String) {
        queue.sync {
            var trace: [String] = []
            let have = listed()
            let w = rule(locale, word, have: have, speller: appleSpell) { trace.append($0) }
            return (w, "\(locale) \(word) -> \(w); \(have.count) dictionaries listed; " + trace.joined(separator: "; "))
        }
    }

    static func rule(_ locale: String, _ word: String, have: Set<String>, speller: Speller, trace: ((String) -> Void)? = nil) -> Word {
        // An unlisted language returns no misspelling at all, silently: availability is checked, never inferred. A
        // Latin-script run language with no dictionary checks nothing: English alone would call every native word
        // unknown (ms, ca). A word is unknown only when every dictionary consulted rejects it, and English counts in
        // all its installed regions, so `colours` is known (D35).
        let d = dictionary(for: locale, in: have)
        let nonLatin = isNonLatin(locale)
        if d == nil && !nonLatin { trace?("no \(locale) dictionary"); return .unchecked }
        let english = have.filter { $0 == "en" || $0.hasPrefix("en_") }.sorted()
        let latin = word.unicodeScalars.filter { $0.properties.isAlphabetic }.allSatisfy(isLatin)
        let dicts: [String] = latin ? ([d].compactMap { $0 } + english) : nonLatin ? [d].compactMap { $0 } : []
        if dicts.isEmpty { trace?("no dictionary for this script"); return .unchecked }
        let unknown = dicts.allSatisfy { l in
            let m = speller.misspelled(word, l)
            trace?("\(l) \(m ? "misspelled" : "spelled")")
            return m
        }
        if !unknown { return .known }
        // A word whose correction or a guess differs only by accents, dotless i, apostrophes or case is a reading
        // slip (`speciale`, `Oğünlerini`), not stacked ink: it counts as known (D31).
        let f = fold(word)
        for dl in dicts {
            let c = speller.correction(word, dl)
            let g = speller.guesses(word, dl)
            trace?("\(dl) correction \(c ?? "none"), guesses \(g)")
            if ([c].compactMap { $0 } + g).contains(where: { fold($0) == f }) { return .known }
        }
        return .unknown
    }

    /// A run locale written in a non-Latin script, with or without a region (`ja`, `ja-JP`, `zh-Hans-CN`).
    static func isNonLatin(_ locale: String) -> Bool {
        nonLatinLocales.contains { locale == $0 || locale.hasPrefix($0 + "-") }
    }

    /// The run locale's dictionary: the exact region, the base language, `no` -> `nb`, `ars` -> `ar`, or the first
    /// region of the base language (`pt` -> `pt_BR`).
    static func dictionary(for locale: String, in have: Set<String>) -> String? {
        let base = String(locale.split(separator: "-").first ?? "")
        return [locale.replacingOccurrences(of: "-", with: "_"), base, base == "no" ? "nb" : base == "ars" ? "ar" : ""].first { have.contains($0) }
            ?? have.filter { $0.hasPrefix(base + "_") }.sorted().first
    }

    static func isLatin(_ s: Unicode.Scalar) -> Bool {
        (0x41...0x5A).contains(s.value) || (0x61...0x7A).contains(s.value) || (0xC0...0x24F).contains(s.value) || (0x1E00...0x1EFF).contains(s.value)
    }

    static func fold(_ w: String) -> String {
        let f = w.replacingOccurrences(of: "ı", with: "i").replacingOccurrences(of: "İ", with: "I")
            .folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
        return String(String.UnicodeScalarView(f.unicodeScalars.filter { CharacterSet.letters.contains($0) }))
    }
}
