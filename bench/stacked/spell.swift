// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-067 D31 bench helper: NSSpellChecker lookups for the `dictionary` stacked signal, bench-only (D10).
// stdin "locale<TAB>word" lines -> "locale<TAB>word<TAB>v<TAB>near":
//   v     1 unknown to every dictionary of its script, 0 known, - no dictionary checks it
//   near  1 when the checker's correction or a guess differs from the word only by accents, dotless i, apostrophes
//         or case (`speciale` -> `spéciale`, `Oğünlerini` -> `Öğünlerini`): a reading slip, not stacked ink.
// A Latin word is checked with the run language and `en` (Vision reads en-US in every run); a word in another script
// only with the run language, and only when the run language is written in that script (TODO-053 D3).
// Build: swiftc -O bench/stacked/spell.swift -o .build/stacked-spell
import AppKit

let spell = NSSpellChecker.shared
let dictLangs = Set(spell.availableLanguages)
let nonLatinLocales: Set<String> = ["ru", "uk", "bg", "el", "he", "ar", "ars", "ko", "hi", "pa", "te", "ja", "zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant", "th", "sr"]
let english = dictLangs.filter { $0 == "en" || $0.hasPrefix("en_") }.sorted()

// As StackedDictionary.dictionary(for:in:): exact region, base, no -> nb, ars -> ar, else the first region of the base (pt -> pt_BR).
func dictFor(_ loc: String) -> String? {
    let base = String(loc.split(separator: "-").first ?? "")
    return [loc.replacingOccurrences(of: "-", with: "_"), base, base == "no" ? "nb" : base == "ars" ? "ar" : ""].first { dictLangs.contains($0) }
        ?? dictLangs.filter { $0.hasPrefix(base + "_") }.sorted().first
}
func isLatin(_ s: Unicode.Scalar) -> Bool {
    (0x41...0x5A).contains(s.value) || (0x61...0x7A).contains(s.value) || (0xC0...0x24F).contains(s.value) || (0x1E00...0x1EFF).contains(s.value)
}
func fold(_ w: String) -> String {
    let f = w.replacingOccurrences(of: "ı", with: "i").replacingOccurrences(of: "İ", with: "I")
        .folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
    return String(String.UnicodeScalarView(f.unicodeScalars.filter { CharacterSet.letters.contains($0) }))
}

while let l = readLine() {
    let p = l.split(separator: "\t", maxSplits: 1).map(String.init); guard p.count == 2 else { continue }
    let (loc, w) = (p[0], p[1])
    // TODO-067 D34: a run language with no dictionary checks nothing; letters as core counts them (isAlphabetic).
    let latin = w.unicodeScalars.filter { $0.properties.isAlphabetic }.allSatisfy(isLatin)
    // As core (D35): a Latin run language with no dictionary checks nothing; English counts in every installed region.
    let d = dictFor(loc)
    let nonLatin = nonLatinLocales.contains { loc == $0 || loc.hasPrefix($0 + "-") } // as isNonLatin
    let dicts: [String] = d == nil && !nonLatin ? [] : latin ? ([d].compactMap { $0 } + english) : nonLatin ? [d].compactMap { $0 } : []
    if dicts.isEmpty { print("\(loc)\t\(w)\t-\t0"); continue }
    let range = NSRange(location: 0, length: (w as NSString).length)
    let unknown = dicts.allSatisfy {
        spell.checkSpelling(of: w, startingAt: 0, language: $0, wrap: false, inSpellDocumentWithTag: 0, wordCount: nil).location != NSNotFound
    }
    var near = false
    if unknown {
        let fw = fold(w)
        for dl in dicts where !near {
            let c = spell.correction(forWordRange: range, in: w, language: dl, inSpellDocumentWithTag: 0)
            let g = spell.guesses(forWordRange: range, in: w, language: dl, inSpellDocumentWithTag: 0) ?? []
            near = ([c].compactMap { $0 } + g).contains { fold($0) == fw }
        }
    }
    print("\(loc)\t\(w)\t\(unknown ? "1" : "0")\t\(near ? "1" : "0")")
}
