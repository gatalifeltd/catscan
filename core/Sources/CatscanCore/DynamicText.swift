// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The dynamic-text guards (TODO-036 check 4, landed by TODO-039 T2 per its D10): lines a "this text is not from the
/// catalog" verdict must never judge. `hardcoded` (TODO-039) uses them now; `uncatalogued` (TODO-036 T4) reuses them.
public struct DynamicText: Equatable {
    /// The `--dynamic` pattern ICU cannot compile, by its position in the list.
    public struct InvalidPattern: Error, Equatable {
        public var index: Int
        public var pattern: String
    }

    /// The iOS/Android status-bar band: lines centered in the top 4% of the screen.
    public static let statusBand = 0.04
    /// The floor for a line worth judging: 2 words or 8 letters (TODO-036 check 4).
    public static let minWords = 2, minLetters = 8

    /// `--dynamic <file>`: one regex per line, matched against the whole line (anchored).
    public var patterns: [String] = []
    /// Elements with `dynamic: true` in the boxes file, normalized, origin top left.
    public var rects: [CGRect] = []
    /// `--allow` entries.
    public var allow: [String] = []
    var compiled: [NSRegularExpression] = []

    public init(patterns: [String] = [], rects: [CGRect] = [], allow: [String] = []) throws {
        self.patterns = patterns
        self.rects = rects
        self.allow = allow
        compiled = try patterns.enumerated().map { i, p in
            do { return try NSRegularExpression(pattern: "^(?:\(p))$") } catch { throw InvalidPattern(index: i, pattern: p) }
        }
    }

    public static func == (a: DynamicText, b: DynamicText) -> Bool {
        a.patterns == b.patterns && a.rects == b.rects && a.allow == b.allow
    }

    /// The guard that keeps a line out of the verdict, or nil when the line may be judged.
    /// Order: allow, status bar, dynamic element, dynamic pattern, formatted value, too short.
    public func guarded(_ text: String, rect: CGRect, locale: String) -> String? {
        let n = TextMatch.normalize(text, locale: locale)
        if !n.isEmpty, allow.contains(where: { a in let x = TextMatch.normalize(a, locale: locale); return !x.isEmpty && x.contains(n) }) {
            return "allow"
        }
        if rect.midY < DynamicText.statusBand { return "status-bar" }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        if rects.contains(where: { $0.contains(center) }) { return "dynamic-element" }
        let t = text.trimmingCharacters(in: .whitespaces)
        let whole = NSRange(t.startIndex..., in: t)
        if compiled.contains(where: { $0.firstMatch(in: t, range: whole) != nil }) { return "dynamic-pattern" }
        if DynamicText.isFormatted(t) { return "formatted" }
        if !DynamicText.eligible(t) { return "short" }
        return nil
    }

    /// At least 2 words or 8 letters (a word is a run with a letter).
    public static func eligible(_ text: String) -> Bool {
        let words = text.split(whereSeparator: { $0.isWhitespace }).filter { $0.contains(where: \.isLetter) }
        return words.count >= minWords || text.filter(\.isLetter).count >= minLetters
    }

    // Tokens that, beside digits, make up numbers, prices, dates, times, percentages, scores and counters.
    static let valueWords: Set<String> = [
        "$", "€", "£", "¥", "₽", "₹", "₩", "₺", "%", "/", "-", "–", ":", "+", "×", "x", "k", "m", "b", "h", "min", "s",
        "sec", "d", "am", "pm", "a.m.", "p.m.", "pts", "pt", "xp", "hp", "lv", "lvl", "vs", "of", "per", "a", "day", "days", "week",
        "weeks", "wk", "month", "months", "mo", "year", "years", "yr", "hours", "hrs", "minutes", "mins",
        "usd", "eur", "gbp", "jpy", "cny", "rub", "inr", "krw", "brl", "cad", "aud", "chf", "sek", "nok", "dkk", "pln",
        "try", "mxn", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
        "january", "february", "march", "april", "june", "july", "august", "september", "october", "november",
        "december", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
    ]

    /// A line that is a number, price, date, time, percentage, score or counter: it has a digit and every token
    /// holds a digit or is a currency, unit, month or weekday word.
    public static func isFormatted(_ text: String) -> Bool {
        guard text.contains(where: \.isNumber) else { return false }
        let strip = CharacterSet(charactersIn: "()[],.;!?\"'«»")
        return text.lowercased().split(whereSeparator: { $0.isWhitespace }).allSatisfy { raw in
            let t = String(raw).trimmingCharacters(in: strip)
            return t.isEmpty || t.contains(where: \.isNumber) || valueWords.contains(t) || valueWords.contains(String(raw))
        }
    }
}
