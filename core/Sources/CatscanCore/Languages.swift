// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import Foundation

/// One row of the language table (spec 04, "Mapping").
public struct Language: Equatable {
    public let locale: String // catscan code, the one `catscan languages` prints
    public let vision: String // Vision recognition language code
    public let aliases: [String] // other tags that resolve to this row exactly
    public let script: String

    public var tags: [String] { [locale, vision] + aliases }
}

/// The language table, locale resolution and the per-OS expected Vision list (spec 04, TODO-003).
public enum Languages {
    static func row(_ locale: String, _ vision: String, _ script: String, _ aliases: [String] = []) -> Language {
        Language(locale: locale, vision: vision, aliases: aliases, script: script)
    }

    /// Every language Vision `.accurate` revision 3 reads on macOS 27, in Vision's order, then the languages read with
    /// one of them (TODO-037). A Vision code maps back to its first row.
    public static let catalog: [Language] = [
        row("en", "en-US", "Latin"), row("fr", "fr-FR", "Latin"), row("it", "it-IT", "Latin"),
        row("de", "de-DE", "Latin"), row("es", "es-ES", "Latin"), row("pt-BR", "pt-BR", "Latin", ["pt"]),
        // zh-SG, zh-MO and the yue regions are exact too, so a region never reads as the other script (TODO-003 D5).
        row("zh-Hans", "zh-Hans", "Han", ["zh-CN", "zh-SG"]), row("zh-Hant", "zh-Hant", "Han", ["zh-TW", "zh-HK", "zh-MO"]),
        row("yue-Hans", "yue-Hans", "Han", ["yue-CN"]), row("yue-Hant", "yue-Hant", "Han", ["yue-HK", "yue-MO"]),
        row("ko", "ko-KR", "Hangul"), row("ja", "ja-JP", "Japanese"),
        row("ru", "ru-RU", "Cyrillic"), row("uk", "uk-UA", "Cyrillic"),
        row("th", "th-TH", "Thai"), row("vi", "vi-VT", "Latin"),
        row("ar", "ar-SA", "Arabic"), row("ars", "ars-SA", "Arabic"),
        row("tr", "tr-TR", "Latin"), row("id", "id-ID", "Latin"), row("cs", "cs-CZ", "Latin"),
        row("da", "da-DK", "Latin"), row("nl", "nl-NL", "Latin"),
        row("no", "no-NO", "Latin"), row("nn", "nn-NO", "Latin"), row("nb", "nb-NO", "Latin"),
        row("ms", "ms-MY", "Latin"), row("pl", "pl-PL", "Latin"), row("ro", "ro-RO", "Latin"),
        row("sv", "sv-SE", "Latin"), row("fi", "fi-FI", "Latin"),
        row("hi", "hi-IN", "Devanagari"), row("mr", "mr-IN", "Devanagari"),
        // TODO-037: languages Vision does not list, read with a listed model of the same letters. Vision's Latin
        // output is the same whichever Latin model is asked, so the choice only steers its language correction.
        row("ca", "es-ES", "Latin"), row("eu", "es-ES", "Latin"), row("gl", "es-ES", "Latin"),
        row("lb", "de-DE", "Latin"), row("fil", "en-US", "Latin", ["tl"]),
    ]

    /// `supportedRecognitionLanguages()` for `.accurate` revision 3, per macOS major version, as measured.
    /// A row is added only from a run on that version; the live check (CoreTests) fails on a Mac without one.
    /// 15 and 26: GitHub `macos-15` 15.8.2 (24H232) and `macos-26` 26.6.2 (25G83) runners, 2026-11-04 (TODO-004).
    public static let expected: [Int: [String]] = [
        15: [
            "en-US", "fr-FR", "it-IT", "de-DE", "es-ES", "pt-BR", "zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant",
            "ko-KR", "ja-JP", "ru-RU", "uk-UA", "th-TH", "vi-VT", "ar-SA", "ars-SA",
        ],
        26: [
            "en-US", "fr-FR", "it-IT", "de-DE", "es-ES", "pt-BR", "zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant",
            "ko-KR", "ja-JP", "ru-RU", "uk-UA", "th-TH", "vi-VT", "ar-SA", "ars-SA", "tr-TR", "id-ID", "cs-CZ",
            "da-DK", "nl-NL", "no-NO", "nn-NO", "nb-NO", "ms-MY", "pl-PL", "ro-RO", "sv-SE",
        ],
        27: [
            "en-US", "fr-FR", "it-IT", "de-DE", "es-ES", "pt-BR", "zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant",
            "ko-KR", "ja-JP", "ru-RU", "uk-UA", "th-TH", "vi-VT", "ar-SA", "ars-SA", "tr-TR", "id-ID", "cs-CZ",
            "da-DK", "nl-NL", "no-NO", "nn-NO", "nb-NO", "ms-MY", "pl-PL", "ro-RO", "sv-SE", "fi-FI", "hi-IN",
            "mr-IN",
        ],
    ]

    public struct Resolution: Equatable {
        public let locale: String // catscan code of the matched row
        public let vision: String
        public let exact: Bool // false: matched by a shorter tag or the language subtag (warning locale-fallback)
        public let inTable: Bool // false: a Vision language newer than the table (warning language-not-in-table)
    }

    /// ISO 15924 codes a row's script answers to, for script subtags such as `ru-Cyrl`.
    static let iso15924: [String: Set<String>] = [
        "Latin": ["latn"], "Cyrillic": ["cyrl"], "Japanese": ["jpan"], "Hangul": ["kore", "hang"],
        "Thai": ["thai"], "Arabic": ["arab"], "Devanagari": ["deva"],
    ]

    /// The row a bare language subtag falls back to when table order would pick the wrong one.
    /// Cantonese is written in Traditional in Hong Kong and Macau (TODO-003 D16).
    static let languageDefault: [String: String] = ["yue": "yue-Hant"]

    /// Country codes people pass as locales, for the unsupported-language hint only (TODO-003 D10).
    public static let corrections: [String: String] = [
        "jp": "ja", "kr": "ko", "cn": "zh-Hans", "tw": "zh-Hant", "br": "pt-BR", "ua": "uk", "se": "sv",
        "dk": "da", "cz": "cs",
    ]

    /// The catscan code for a Vision code: the table row, else the code itself (a language newer than the table).
    public static func locale(forVision v: String) -> String {
        catalog.first { $0.vision == v }?.locale ?? v
    }

    /// The table plus any Vision code it does not know yet (a language newer than this catscan).
    public static func rows(adding supported: [String]) -> [Language] {
        catalog + supported.filter { v in !catalog.contains { $0.vision == v } }.map { row($0, $0, "unknown") }
    }

    /// Resolves a BCP 47 tag against the languages Vision reads on this Mac (`supported`, Vision codes).
    /// Lookup order: the full tag, then the tag with trailing subtags removed (RFC 4647 lookup), then the
    /// table row for the language subtag. A fallback never changes script (TODO-003 D8, D14): a tag naming a
    /// row this Mac does not list, or a script subtag the row does not use (`ru-Latn`), is unsupported.
    public static func resolve(_ tag: String, supported: [String]) -> Resolution? {
        let all = rows(adding: supported)
        var subtags = tag.lowercased().split(separator: "-").map(String.init)
        let full = subtags.joined(separator: "-")
        let script = subtags.dropFirst().first { $0.count == 4 && $0.allSatisfy(\.isLetter) }
        func accept(_ r: Language, exact: Bool) -> Resolution? {
            guard supported.contains(r.vision) else { return nil }
            if let script {
                let own = Set(r.tags.flatMap { $0.lowercased().split(separator: "-").map(String.init) })
                guard own.contains(script) || iso15924[r.script, default: []].contains(script) else { return nil }
            }
            let inTable = catalog.contains { $0.vision == r.vision }
            return Resolution(locale: r.locale, vision: r.vision, exact: exact, inTable: inTable)
        }
        while !subtags.isEmpty {
            let t = subtags.joined(separator: "-")
            if let r = all.first(where: { $0.tags.contains { $0.lowercased() == t } }) {
                return accept(r, exact: t == full)
            }
            subtags.removeLast()
        }
        let b = TextMatch.base(tag)
        let row = languageDefault[b].flatMap { d in all.first { $0.locale == d } }
            ?? all.first { TextMatch.base($0.locale) == b }
        return row.flatMap { accept($0, exact: false) }
    }

    /// The live Vision list against the row for `macOSMajor`: nil when the table has no row for it.
    public static func compare(_ live: [String], macOSMajor: Int) -> (added: [String], removed: [String])? {
        guard let want = expected[macOSMajor] else { return nil }
        return (live.filter { !want.contains($0) }, want.filter { !live.contains($0) })
    }
}
