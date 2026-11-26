// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// The `formats` field of a request (TODO-036 check 5, D36): which rules run, the storefront's currency and
/// region, the price file's products and `--allow`. Node validates every input; the core owns the rules.
public struct FormatsJob: Equatable {
    public struct Product: Equatable {
        public var id: String
        public var price: Int // minor units of `currency`
        public var currency: String
        public var period: String? // P1W, P1M, P1Y...; nil for a one-time purchase
        public var trial: String? // P3D, P1W...; nil without a free trial
        public init(id: String, price: Int, currency: String, period: String? = nil, trial: String? = nil) {
            self.id = id; self.price = price; self.currency = currency; self.period = period; self.trial = trial
        }
    }
    public static let allRules = ["number", "date", "time", "currency-placement", "currency", "mixed-currency", "price"]
    public static let defaultRules: Set<String> = ["number", "date", "currency", "mixed-currency", "price"] // D7
    public var rules: Set<String> = FormatsJob.defaultRules
    public var currency: String? = nil
    public var storefront: String? = nil // alpha-2 region, when given
    public var products: [Product] = []
    public var allow: [String] = []
    public init() {}
}

/// Check 5: number, date and time formats against CLDR via Foundation for the run locale, and currencies and prices
/// against the storefront and a price file (TODO-036 T3, D7-D9, D15, D20, D33-D41).
public enum Formats {
    // MARK: Tokens

    /// A number as read, with its separators resolved (D37). `minor` is set only for a resolved amount.
    struct Num: Equatable {
        var text: String
        var range: NSRange
        var intDigits: String
        var frac: String? // digits after a proven decimal separator
        var decimal: Character?
        var group: Character?
    }

    struct Money {
        var num: Num
        var symbol: String
        var symbolBefore: Bool
        var spaced: Bool
        var codes: [String] // ISO codes the symbol can name, most likely first
        var token: String
        var range: NSRange // number and symbol
        var minor: Int? // value in minor units of the resolved currency; nil when unresolved (D37)
        var code: String // the resolved currency
    }

    static let spaces: Set<Character> = [" ", "\u{00A0}", "\u{202F}"]

    /// One line with NBSP and narrow NBSP folded to spaces (same UTF-16 length, so ranges stay valid).
    /// NBSP and narrow NBSP to spaces, and the fullwidth signs and digits ja/zh write (`￥980`) to their ASCII forms;
    /// each mapping keeps the UTF-16 length, so ranges stay valid on the line as read.
    static let foldMap: [Character: Character] = {
        var m: [Character: Character] = ["\u{00A0}": " ", "\u{202F}": " ", "\u{3000}": " ", "￥": "¥", "＄": "$", "￡": "£", "￦": "₩", "．": ".", "，": ",", "：": ":", "／": "/"]
        for (i, d) in "０１２３４５６７８９".enumerated() { m[d] = Character(String(i)) }
        return m
    }()
    static func fold(_ s: String) -> String { String(s.map { foldMap[$0] ?? $0 }) }

    static let numberRE = try! NSRegularExpression(
        pattern: #"(?<![\p{N}.,'_/:#@-])\d+(?:[.,' ]\d+)*(?![\p{N}]|[.,']\d|%|\p{L}\p{N})"#)

    /// Splits a number into digit runs and separators and resolves them (D12, D37). `currencyDigits`: the fraction
    /// digits of the currency next to it, nil for a bare number. `localeGroup`: the run locale's group separator.
    static func resolve(_ text: String, range: NSRange, currencyDigits: Int?, localeGroup: Character) -> Num? {
        var runs: [String] = [""], seps: [Character] = []
        for ch in text {
            if ch.isASCII, ch.isNumber { runs[runs.count - 1].append(ch) } else { seps.append(ch); runs.append("") }
        }
        if runs.contains(where: \.isEmpty) { return nil }
        func validGroups(_ r: [String]) -> Bool { // r: the integer runs
            guard let first = r.first, (1...3).contains(first.count) else { return false }
            if r.dropFirst().allSatisfy({ $0.count == 3 }) { return true }
            // en-IN: 12,34,567 (last group 3, the ones above it 2)
            guard r.count >= 3, r.last!.count == 3, first.count <= 2 else { return false }
            return r.dropFirst().dropLast().allSatisfy { $0.count == 2 }
        }
        var n = Num(text: text, range: range, intDigits: runs.joined(), frac: nil, decimal: nil, group: nil)
        if seps.isEmpty { return n }
        let last = seps.last!
        let lastIsDecimalCandidate = last == "." || last == ","
        let others = seps.dropLast()
        if !others.isEmpty, lastIsDecimalCandidate, others.allSatisfy({ $0 == others.first! }), others.first! != last {
            // Two kinds of separator: the last one is the decimal separator.
            guard validGroups(Array(runs.dropLast())) else { return nil }
            if let d = currencyDigits, runs.last!.count != d { return nil }
            n.intDigits = runs.dropLast().joined(); n.frac = runs.last!; n.decimal = last; n.group = others.first!
            return n
        }
        if seps.allSatisfy({ $0 == last }) {
            if seps.count >= 2 || !lastIsDecimalCandidate {
                guard validGroups(runs) else { return nil } // 1.2.3, 2 400 00
                n.group = last
                return n
            }
            // One `.` or `,`.
            let after = runs[1].count
            if let d = currencyDigits {
                if after == d && d != 3 { n.intDigits = runs[0]; n.frac = runs[1]; n.decimal = last; return n }
                // `$4.990`: a group only where the run locale groups with it (D37); `$4.9`: unresolved.
                if after == 3, last == localeGroup, validGroups(runs) { n.group = last; return n }
                return nil
            }
            if after != 3 { n.intDigits = runs[0]; n.frac = runs[1]; n.decimal = last; return n }
            return n // 1,234: ambiguous, no roles (the number rule skips it)
        }
        return nil
    }

    // MARK: Currencies

    /// Compiled patterns built from locale data (time markers, trial units), cached so a paywall's lines do not
    /// recompile them per line (review).
    private static let reLock = NSLock()
    nonisolated(unsafe) private static var reCache: [String: NSRegularExpression] = [:]
    static func regex(_ pattern: String) -> NSRegularExpression {
        reLock.lock(); defer { reLock.unlock() }
        if let r = reCache[pattern] { return r }
        let r = try! NSRegularExpression(pattern: pattern)
        reCache[pattern] = r
        return r
    }

    /// Symbol -> ISO codes, from Foundation's CLDR: each currency's symbol and narrow symbol in en-US, plus the
    /// symbols the main locales write for their own and the common currencies. Built once per process.
    static let symbols: [String: [String]] = {
        var map: [String: Set<String>] = [:]
        let nf = NumberFormatter()
        nf.numberStyle = .currency
        func add(_ s: String, _ code: String) {
            let sym = s.trimmingCharacters(in: .whitespaces)
            // A lone Latin letter (`R`, `K`, `P`) next to a number is an OCR look-alike, never a currency (guard).
            if sym.isEmpty || sym == code || (sym.count == 1 && sym.first!.isLetter && sym.first!.isASCII) { return }
            if sym.contains(where: { $0.isNumber }) { return }
            map[sym, default: []].insert(code)
        }
        let enUS = Locale(identifier: "en_US")
        nf.locale = enUS
        for code in Locale.commonISOCurrencyCodes {
            nf.currencyCode = code
            add(nf.currencySymbol, code)
            let narrow = (1.0).formatted(.currency(code: code).presentation(.narrow).locale(enUS))
            add(String(narrow.filter { !$0.isNumber && !".,".contains($0) }), code)
        }
        let common = ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "BRL", "TRY", "RUB", "KRW", "CAD", "AUD", "CHF"]
        for id in ["en_GB", "en_CA", "en_AU", "en_IN", "de_DE", "de_CH", "fr_FR", "fr_CA", "es_ES", "es_MX", "it_IT",
            "pt_BR", "tr_TR", "ja_JP", "ko_KR", "ru_RU", "uk_UA", "zh_Hans_CN", "zh_Hant_TW", "pl_PL", "sv_SE", "nb_NO",
            "da_DK", "cs_CZ", "hu_HU", "id_ID", "th_TH", "vi_VN", "he_IL", "ro_RO", "nl_NL", "hi_IN", "ms_MY"] {
            let l = Locale(identifier: id)
            nf.locale = l
            for code in common + [l.currency?.identifier].compactMap({ $0 }) {
                nf.currencyCode = code
                add(nf.currencySymbol, code)
            }
        }
        // Most likely first: the common currencies in order, then the rest alphabetically.
        return map.mapValues { set in
            set.sorted { a, b in
                let ia = common.firstIndex(of: a) ?? 99, ib = common.firstIndex(of: b) ?? 99
                return ia != ib ? ia < ib : a < b
            }
        }
    }()
    static let symbolKeys: [String] = symbols.keys.sorted { $0.count != $1.count ? $0.count > $1.count : $0 < $1 }
    static let isoCodes = Set(Locale.commonISOCurrencyCodes)

    static func digits(_ code: String) -> Int {
        let nf = NumberFormatter()
        nf.numberStyle = .currency
        nf.currencyCode = code
        nf.locale = Locale(identifier: "en_US")
        return nf.maximumFractionDigits
    }

    /// The currency symbol or ISO code right before (`$9.99`, `EUR 9,99`) or right after (`9,99 €`) a number. The
    /// locale's side is tried first; the other side only when that symbol does not touch another number, so in
    /// `79,98 € 39,99 €` the middle `€` belongs to the first amount.
    static func attach(_ s: NSString, _ r: NSRange, suffixFirst: Bool) -> (symbol: String, before: Bool, spaced: Bool, range: NSRange)? {
        func isLetter(_ i: Int) -> Bool {
            guard i >= 0, i < s.length else { return false }
            return CharacterSet.letters.contains(UnicodeScalar(s.character(at: i)) ?? " ")
        }
        func isDigit(_ i: Int) -> Bool {
            guard i >= 0, i < s.length else { return false }
            let c = s.character(at: i)
            return c >= 0x30 && c <= 0x39
        }
        func candidates(_ t: String) -> Bool { symbols[t] != nil || (t.count == 3 && isoCodes.contains(t)) }
        func before(_ second: Bool) -> (String, Bool, Bool, NSRange)? {
            for spaced in [false, true] {
                let end = r.location - (spaced ? 1 : 0)
                if spaced && (end < 0 || s.character(at: end) != 0x20) { continue }
                for len in stride(from: 4, through: 1, by: -1) where end - len >= 0 {
                    let t = s.substring(with: NSRange(location: end - len, length: len))
                    guard candidates(t) else { continue }
                    if isLetter(end - len - 1) && t.first!.isLetter { continue } // part of a word
                    let lead = end - len - 1
                    if second && (isDigit(lead) || (lead >= 0 && s.character(at: lead) == 0x20 && isDigit(lead - 1))) { return nil }
                    return (t, true, spaced, NSRange(location: end - len, length: r.location + r.length - (end - len)))
                }
            }
            return nil
        }
        func after(_ second: Bool) -> (String, Bool, Bool, NSRange)? {
            let a = r.location + r.length
            for spaced in [false, true] {
                let start = a + (spaced ? 1 : 0)
                if spaced && (a >= s.length || s.character(at: a) != 0x20) { continue }
                for len in stride(from: 4, through: 1, by: -1) where start + len <= s.length {
                    let t = s.substring(with: NSRange(location: start, length: len))
                    guard candidates(t) else { continue }
                    if isLetter(start + len) && t.last!.isLetter { continue }
                    let tail = start + len
                    if second && (isDigit(tail) || (tail < s.length && s.character(at: tail) == 0x20 && isDigit(tail + 1))) { return nil }
                    return (t, false, spaced, NSRange(location: r.location, length: start + len - r.location))
                }
            }
            return nil
        }
        let hit = suffixFirst ? (after(false) ?? before(true)) : (before(false) ?? after(true))
        return hit.map { (symbol: $0.0, before: $0.1, spaced: $0.2, range: $0.3) }
    }

    /// D42: Vision reads a drawn `₹` as `€` or `₽` (bench/formats.js), so those reads may also be rupees: a rupee
    /// storefront never flags them, and they never make a rupee screen mixed.
    static let visionAliases: [String: [String]] = ["€": ["INR"], "₽": ["INR"]]

    static func codes(of symbol: String) -> [String] {
        if let c = symbols[symbol] { return c + (visionAliases[symbol] ?? []) }
        return isoCodes.contains(symbol) ? [symbol] : []
    }

    // MARK: Locale data (Foundation, the CLDR macOS ships)

    struct LocaleData {
        var decimal: Character
        var group: Character
        var dateOrder: [Character] // y, M, d in the short date pattern's order
        var hour24: Bool
        var am: [String]
        var locale: Locale
        var suffix: Bool // the currency symbol follows the number (`9,99 €`)
    }

    static func data(_ id: String) -> LocaleData {
        let l = Locale(identifier: id)
        let nf = NumberFormatter()
        nf.locale = l
        nf.numberStyle = .decimal
        let df = DateFormatter()
        df.locale = l
        df.dateStyle = .short
        var order: [Character] = []
        for ch in df.dateFormat ?? "" where "yMd".contains(ch) && !order.contains(ch) { order.append(ch) }
        let j = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: l) ?? "H"
        let tf = DateFormatter()
        tf.locale = l
        let g = (nf.groupingSeparator ?? ",").first ?? ","
        return LocaleData(
            decimal: (nf.decimalSeparator ?? ".").first ?? ".", group: spaces.contains(g) ? " " : g, dateOrder: order,
            hour24: j.contains("H") || j.contains("k"), am: [tf.amSymbol, tf.pmSymbol], locale: l,
            suffix: currencySuffix(l))
    }

    static func currencySuffix(_ l: Locale) -> Bool {
        let c = NumberFormatter()
        c.locale = l
        c.numberStyle = .currency
        let f = c.positiveFormat ?? "¤#"
        guard let sym = f.firstIndex(of: "¤"), let num = f.firstIndex(where: { $0 == "#" || $0 == "0" }) else { return false }
        return sym > num
    }

    // MARK: Evaluate

    public struct Result {
        public var findings: [Finding] = []
        public var priceExempt: Int? = nil
    }

    struct Hit {
        var line: Int
        var finding: Finding
    }

    public static func evaluate(_ job: FormatsJob, lines: [RecognizedLine], locale: String) -> Result {
        let ld = data(locale)
        let lang = TextMatch.base(locale) == "nb" ? "no" : TextMatch.base(locale)
        let tableLang = FormatsTables.units[lang] != nil ? lang : (locale.hasPrefix("zh-Hant") ? "zh-Hant" : lang)
        // D41: a run with a storefront also accepts that region's format in the UI language (StoreKit formats
        // `displayPrice` for the storefront).
        var storeData: LocaleData? = nil
        if let sf = job.storefront { storeData = data("\(TextMatch.base(locale))_\(sf)") }
        let allow = Set(job.allow.map { TextMatch.normalize($0, locale: locale) })
        var out = Result()
        var hits: [Hit] = []
        var monies: [(line: Int, m: Money)] = []
        func box(_ l: RecognizedLine, _ r: NSRange) -> [Double] {
            if let rb = l.rangeBox, let rr = Range(r, in: l.text), let b = rb(rr), b.width > 0 { return Geometry.box(b) }
            return Geometry.box(l.rect)
        }
        for (i, l) in lines.enumerated() {
            if allow.contains(TextMatch.normalize(l.text, locale: locale)) { continue }
            let text = fold(l.text)
            let s = text as NSString, orig = l.text as NSString // tokens are reported as read
            // T0/D2: a missing-glyph sign makes the amounts on its line untrustworthy (`9,99` read as `666`).
            let glyphless = text.contains("\u{FFFD}") || text.contains("\u{25A1}") || text.contains("\u{25AF}")
            var taken: [NSRange] = []
            // Dates and times first, so their digits are not read as numbers.
            for d in dates(s) {
                taken.append(d.range)
                guard let f = judgeDate(d, ld) else { continue }
                var x = Finding(kind: "format", box: box(l, d.range), line: l.text)
                x.rule = "date"; x.token = orig.substring(with: d.range); x.expected = f
                hits.append(Hit(line: i, finding: x))
            }
            for t in times(s, ld) {
                taken.append(t.range)
                guard ld.hour24, t.marker else { continue }
                var x = Finding(kind: "format", box: box(l, t.range), line: l.text)
                x.rule = "time"; x.token = orig.substring(with: t.range); x.expected = t.expected
                hits.append(Hit(line: i, finding: x))
            }
            for m in numberRE.matches(in: text, range: NSRange(location: 0, length: s.length)) {
                if taken.contains(where: { NSIntersectionRange($0, m.range).length > 0 }) { continue }
                let raw = s.substring(with: m.range)
                // A number glued to a letter (`v1.2.3`, `x2`) counts only behind a currency sign (`$US96,35`, `CHF9`).
                let glued = m.range.location > 0 && CharacterSet.letters.contains(UnicodeScalar(s.character(at: m.range.location - 1)) ?? " ")
                let attached = attach(s, m.range, suffixFirst: ld.suffix)
                if glued && !(attached.map { $0.before && !$0.spaced } ?? false) { continue }
                if let a = attached {
                    let codes = codes(of: a.symbol)
                    guard !codes.isEmpty else { continue }
                    // The expected currency when the symbol can name it (`$` in a CA storefront is CAD), else the likeliest.
                    let code = job.currency.flatMap { codes.contains($0) ? $0 : nil } ?? codes[0]
                    guard let num = resolve(raw, range: m.range, currencyDigits: digits(code), localeGroup: ld.group) else { continue }
                    var minor: Int? = nil
                    if !glyphless, let iv = Int(num.intDigits) {
                        let d = digits(code)
                        let fv = Int((num.frac ?? "").padding(toLength: d, withPad: "0", startingAt: 0)) ?? 0
                        // An OCR run of 18+ digits must not trap the serve process (review): no minor amount then.
                        let (m, o1) = iv.multipliedReportingOverflow(by: Int(pow(10, Double(d))))
                        let (sum, o2) = m.addingReportingOverflow(d == 0 ? 0 : fv)
                        minor = o1 || o2 ? nil : sum
                    }
                    let money = Money(
                        num: num, symbol: a.symbol, symbolBefore: a.before, spaced: a.spaced, codes: codes,
                        token: orig.substring(with: a.range), range: a.range, minor: minor, code: code)
                    if glyphless { continue }
                    if l.confidence >= 0.5 { monies.append((i, money)) }
                    // number: a decimal separator wrong for the locale, next to a currency with exactly its digits.
                    if let dsep = num.decimal, dsep != ld.decimal, dsep != storeData?.decimal ?? ld.decimal {
                        var x = Finding(kind: "format", box: box(l, a.range), line: l.text)
                        x.rule = "number"; x.token = money.token
                        x.expected = formatNumber(num, ld.locale)
                        hits.append(Hit(line: i, finding: x))
                    } else if let p = placement(money, ld, store: storeData) {
                        var x = Finding(kind: "format", box: box(l, a.range), line: l.text)
                        x.rule = "currency-placement"; x.token = money.token; x.expected = p
                        hits.append(Hit(line: i, finding: x))
                    }
                    continue
                }
                // A bare number: only a token with both a group and a decimal separator proves the roles (D12).
                guard let num = resolve(raw, range: m.range, currencyDigits: nil, localeGroup: ld.group),
                    let dsep = num.decimal, num.group != nil, dsep != ld.decimal else { continue }
                var x = Finding(kind: "format", box: box(l, m.range), line: l.text)
                x.rule = "number"; x.token = orig.substring(with: m.range); x.expected = formatNumber(num, ld.locale)
                hits.append(Hit(line: i, finding: x))
            }
        }
        // Currencies (D9, D20): unexpected against the storefront; mixed on one screen.
        if let exp = job.currency {
            for (i, m) in monies where !m.codes.contains(exp) {
                var x = Finding(kind: "currency", box: box(lines[i], m.range), line: lines[i].text)
                x.rule = "unexpected"; x.token = m.token; x.currencies = [m.code]; x.expectedCurrency = exp
                hits.append(Hit(line: i, finding: x))
            }
        } else if let mixed = mixedCurrency(monies.map(\.m)) {
            let (i, m) = monies[mixed.index]
            var x = Finding(kind: "currency", box: box(lines[i], m.range), line: lines[i].text)
            x.rule = "mixed"; x.token = m.token; x.currencies = mixed.codes; x.expectedCurrency = nil
            hits.append(Hit(line: i, finding: x))
        }
        if job.rules.contains("price"), let exp = job.currency, !job.products.isEmpty {
            // D42: a read `€` or `₽` may be a misread `₹`, enough to stay quiet, never enough to bind as a price.
            let own = monies.filter { e in (symbols[e.m.symbol] ?? [e.m.symbol]).contains(exp) }
            let p = prices(job, own, lines: lines, lang: tableLang, ld: ld, box: box)
            hits += p.hits
            out.priceExempt = p.exempt
        }
        // D15: `--rules` filters the rule each finding names.
        func ruleName(_ f: Finding) -> String {
            switch f.kind {
            case "currency": return f.rule == "mixed" ? "mixed-currency" : "currency"
            case "price": return "price"
            default: return f.rule ?? ""
            }
        }
        out.findings = hits.filter { job.rules.contains(ruleName($0.finding)) }
            .enumerated().sorted { ($0.element.line, $0.offset) < ($1.element.line, $1.offset) }.map(\.element.finding)
        return out
    }

    static func formatNumber(_ n: Num, _ l: Locale) -> String? {
        let nf = NumberFormatter()
        nf.locale = l
        nf.numberStyle = .decimal
        nf.minimumFractionDigits = n.frac?.count ?? 0
        nf.maximumFractionDigits = n.frac?.count ?? 0
        guard let v = Decimal(string: n.intDigits + (n.frac.map { ".\($0)" } ?? "")) else { return nil }
        return nf.string(from: v as NSDecimalNumber).map(fold)
    }

    /// currency-placement (opt-in, D7): the symbol's side and spacing against the locale's currency pattern.
    static func placement(_ m: Money, _ ld: LocaleData, store: LocaleData?) -> String? {
        func shape(_ l: Locale) -> (before: Bool, spaced: Bool, text: String)? {
            let nf = NumberFormatter()
            nf.locale = l
            nf.numberStyle = .currency
            nf.currencyCode = m.code
            let v = Decimal(string: m.num.intDigits + (m.num.frac.map { ".\($0)" } ?? "")) ?? 0
            guard let t = nf.string(from: v as NSDecimalNumber).map(fold) else { return nil }
            // Only judged when the locale writes this currency with the same symbol (else the pattern says nothing).
            guard t.contains(m.symbol) else { return nil }
            let before = t.firstIndex(where: { $0.isNumber })! > t.range(of: m.symbol)!.lowerBound
            let spaced = before
                ? t[t.range(of: m.symbol)!.upperBound...].first == " "
                : t[..<t.range(of: m.symbol)!.lowerBound].last == " "
            return (before, spaced, t)
        }
        guard let want = shape(ld.locale) else { return nil }
        // D41: the side only; Vision keeps or drops the space between symbol and number unreliably.
        if want.before == m.symbolBefore { return nil }
        if let st = store, let alt = shape(st.locale), alt.before == m.symbolBefore { return nil }
        return want.text
    }

    /// Two currencies on one screen that no single currency explains (`$` and `CA$` are both CAD).
    static func mixedCurrency(_ ms: [Money]) -> (index: Int, codes: [String])? {
        guard ms.count >= 2 else { return nil }
        var common = Set(ms[0].codes)
        for m in ms.dropFirst() { common.formIntersection(m.codes) }
        if !common.isEmpty { return nil }
        // The first token whose likeliest currency differs from the first token's.
        let first = ms[0].code
        guard let i = ms.firstIndex(where: { !$0.codes.contains(first) }) else { return nil }
        var seen: [String] = []
        for m in ms where !seen.contains(m.code) { seen.append(m.code) }
        return (i, seen.sorted())
    }

    // MARK: Dates and times

    struct DateToken {
        var range: NSRange
        var fields: [String]
        var sep: String
    }

    static let dateRE = try! NSRegularExpression(
        pattern: #"(?<![\p{L}\p{N}.,/:-])(\d{1,4})([./-])(\d{1,2})\2(\d{1,4})(?![\p{N}]|[./-]\d)"#)
    static let koDateRE = try! NSRegularExpression(pattern: #"(?<![\p{N}.])(\d{4})\. ?(\d{1,2})\. ?(\d{1,2})\.?"#)

    static func dates(_ s: NSString) -> [DateToken] {
        var out: [DateToken] = []
        let all = NSRange(location: 0, length: s.length)
        for m in koDateRE.matches(in: s as String, range: all) {
            out.append(DateToken(range: m.range, fields: (1...3).map { s.substring(with: m.range(at: $0)) }, sep: ". "))
        }
        for m in dateRE.matches(in: s as String, range: all) where !out.contains(where: { NSIntersectionRange($0.range, m.range).length > 0 }) {
            out.append(DateToken(range: m.range, fields: [1, 3, 4].map { s.substring(with: m.range(at: $0)) }, sep: s.substring(with: m.range(at: 2))))
        }
        return out
    }

    /// date: the field order contradicts the locale's short date, and a field proves it (spec check 5).
    static func judgeDate(_ d: DateToken, _ ld: LocaleData) -> String? {
        let f = d.fields
        // A year is 2 or 4 digits; day and month 1 or 2.
        let yearAt = f.indices.filter { f[$0].count == 4 }
        guard yearAt.count <= 1, f.allSatisfy({ (1...2).contains($0.count) || $0.count == 4 }) else { return nil }
        // ISO 8601 (`2026-11-17`) is a deliberate format, not a locale order (D41).
        if d.sep == "-", yearAt == [0] { return nil }
        let order = ld.dateOrder
        guard order.count == 3 else { return nil }
        let v = f.map { Int($0) ?? 0 }
        var proven: [Character]? = nil // the order the token proves
        if let y = yearAt.first {
            // A 4-digit year: its position, then the remaining two by a field above 12.
            let rest = f.indices.filter { $0 != y }
            if v[rest[0]] > 12 && v[rest[1]] <= 12 { proven = Formats.slots(y: y, d: rest[0], m: rest[1]) }
            else if v[rest[1]] > 12 && v[rest[0]] <= 12 { proven = Formats.slots(y: y, d: rest[1], m: rest[0]) }
            else if order.firstIndex(of: "y") != y {
                // Wrong year position alone: judged against the locale's day/month order.
                let dm = order.filter { $0 != "y" }
                proven = Formats.slots(y: y, d: dm[0] == "d" ? rest[0] : rest[1], m: dm[0] == "d" ? rest[1] : rest[0])
            }
        } else {
            guard let yi = order.firstIndex(of: "y"), f[yi].count == 2 else { return nil } // `10.25.3` is a version
            // Two-digit year: only a day field above 12 where the locale puts the month proves the order.
            for (i, c) in order.enumerated() where c == "M" && v[i] > 12 && v[i] <= 31 {
                // The token's day is where the locale has its month; the locale's day slot is then the month.
                if let di = order.firstIndex(of: "d"), v[di] <= 12, let yi = order.firstIndex(of: "y") {
                    proven = Formats.slots(y: yi, d: i, m: di)
                }
            }
        }
        guard let p = proven, p != order else { return nil }
        let day = v[p.firstIndex(of: "d")!], month = v[p.firstIndex(of: "M")!]
        var year = v[p.firstIndex(of: "y")!]
        guard (1...12).contains(month), (1...31).contains(day) else { return nil }
        if year < 100 { year += 2000 }
        var c = DateComponents()
        c.year = year; c.month = month; c.day = day
        guard let date = Calendar(identifier: .gregorian).date(from: c) else { return nil }
        let df = DateFormatter()
        df.locale = ld.locale
        df.dateStyle = .short
        df.timeZone = TimeZone(identifier: "UTC")
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return df.string(from: cal.date(from: c) ?? date)
    }

    static func slots(y: Int, d: Int, m: Int) -> [Character] {
        var o: [Character] = ["?", "?", "?"]
        o[y] = "y"; o[d] = "d"; o[m] = "M"
        return o
    }

    struct TimeToken {
        var range: NSRange
        var marker: Bool
        var expected: String?
    }

    static func times(_ s: NSString, _ ld: LocaleData) -> [TimeToken] {
        let markers = (["AM", "PM", "am", "pm", "a.m.", "p.m.", "A.M.", "P.M."] + ld.am)
            .map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|")
        let re = regex(
            #"(?<![\p{N}.:])(?:("# + markers + #")\s?)?(\d{1,2})[.:](\d{2})(?![\p{N}]|[.:]\d)(?:\s?("# + markers + #")(?![\p{L}]))?"#)
        var out: [TimeToken] = []
        for m in re.matches(in: s as String, range: NSRange(location: 0, length: s.length)) {
            let marker = m.range(at: 1).location != NSNotFound || m.range(at: 4).location != NSNotFound
            let mark = marker ? s.substring(with: m.range(at: m.range(at: 4).location != NSNotFound ? 4 : 1)) : ""
            let sep = s.substring(with: NSRange(location: m.range(at: 2).location + m.range(at: 2).length, length: 1))
            // A `.` time needs a marker; `12.30` alone is a number.
            if sep == "." && !marker { continue }
            var expected: String? = nil
            if marker, var h = Int(s.substring(with: m.range(at: 2))), let mi = Int(s.substring(with: m.range(at: 3))), h <= 12, mi < 60 {
                let pm = mark.lowercased().hasPrefix("p") || mark == ld.am.last
                if pm && h < 12 { h += 12 } else if !pm && h == 12 { h = 0 }
                let df = DateFormatter()
                df.locale = ld.locale
                df.timeStyle = .short
                df.timeZone = TimeZone(identifier: "UTC")
                var cal = Calendar(identifier: .gregorian)
                cal.timeZone = TimeZone(identifier: "UTC")!
                if let d = cal.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: h, minute: mi)) { expected = fold(df.string(from: d)) }
            }
            out.append(TimeToken(range: m.range, marker: marker && expected != nil, expected: expected))
        }
        return out
    }

    // MARK: Prices (D8, D38, D41)

    static func isoPeriod(_ p: String) -> String {
        switch p { case "day": return "P1D"; case "week": return "P1W"; case "month": return "P1M"; default: return "P1Y" }
    }

    /// Days of an ISO duration (months and years as 30 and 365), for comparing trials (`P7D` is `P1W`).
    static func days(_ iso: String) -> Int? {
        let re = regex(#"^P(\d{1,4})([DWMY])$"#) // bounded: an unbounded count overflows the multiply (review)
        let s = iso as NSString
        guard let m = re.firstMatch(in: iso, range: NSRange(location: 0, length: s.length)), let n = Int(s.substring(with: m.range(at: 1))) else { return nil }
        switch s.substring(with: m.range(at: 2)) { case "D": return n; case "W": return n * 7; case "M": return n * 30; default: return n * 365 }
    }

    static func words(_ lang: String) -> (units: [String: [String]], per: [String: [String]], hand: [String: [String]]) {
        (FormatsTables.units[lang] ?? [:], FormatsTables.perUnit[lang] ?? [:], FormatsTables.hand[lang] ?? [:])
    }

    /// The period a word names right after an amount (`/month`, ` per year`, `/月`) or right before it
    /// (`Monthly: $7.99`), D38.
    static func period(after: String, before: String, lang: String) -> String? {
        let w = words(lang)
        let a = after.lowercased(), b = before.lowercased()
        for p in ["day", "week", "month", "year"] {
            for per in w.per[p] ?? [] where a.hasPrefix(" " + per) || a.hasPrefix(per) {
                if boundary(a, after: (a.hasPrefix(" ") ? 1 : 0) + per.count) { return p }
            }
            for u in (w.units[p] ?? []) + (w.hand[p] ?? []) {
                for pre in ["/", " / ", "/ ", " /"] where a.hasPrefix(pre + u) && boundary(a, after: pre.count + u.count) { return p }
            }
            for adj in w.hand[p] ?? [] where adj.count > 2 {
                for suf in [": ", " ", ":"] where b.hasSuffix(adj + suf) {
                    let start = b.count - adj.count - suf.count
                    if start == 0 || !b[b.index(b.startIndex, offsetBy: start - 1)].isLetter { return p }
                }
            }
        }
        return nil
    }

    static func boundary(_ s: String, after n: Int) -> Bool {
        guard n < s.count else { return true }
        let c = s[s.index(s.startIndex, offsetBy: n)]
        return !c.isLetter
    }

    /// A trial claim: a duration (`3 day`, `7-day`, `1 Woche`) on a line with a trial word.
    static func trial(_ line: String, lang: String) -> String? {
        let w = words(lang)
        let l = fold(line).lowercased()
        guard let tw = w.hand["trial"], tw.contains(where: { l.contains($0) }) else { return nil }
        var found: [String] = []
        for p in ["day", "week", "month", "year"] {
            for u in w.units[p] ?? [] {
                // CJK writes no space after a unit (`7日無料`), so the word boundary applies to alphabetic units only.
                let cjk = u.unicodeScalars.last.map { [.han, .kana, .hangul].contains(Scripts.script(of: $0)) } ?? false
                let re = regex(#"(?<![\p{N}.,])(\d{1,3})[ -]?"# + NSRegularExpression.escapedPattern(for: u) + (cjk ? "" : #"(?![\p{L}])"#))
                for m in re.matches(in: l, range: NSRange(location: 0, length: (l as NSString).length)) {
                    let n = (l as NSString).substring(with: m.range(at: 1))
                    let iso = "P\(n)\(["day": "D", "week": "W", "month": "M", "year": "Y"][p]!)"
                    if !found.contains(iso) { found.append(iso) }
                }
            }
        }
        return found.count == 1 ? found[0] : nil // two durations on one line: ambiguous, skipped
    }

    static func prices(
        _ job: FormatsJob, _ ms: [(line: Int, m: Money)], lines: [RecognizedLine], lang: String, ld: LocaleData,
        box: (RecognizedLine, NSRange) -> [Double]
    ) -> (hits: [Hit], exempt: Int) {
        var hits: [Hit] = []
        var exempt = 0
        let exp = job.currency!
        func bind(_ v: Int) -> [(FormatsJob.Product, String?)] { // product, derived period
            var out: [(FormatsJob.Product, String?)] = []
            for p in job.products where p.currency == exp {
                if p.price == v { out.append((p, nil)); continue }
                if p.period == "P1Y" {
                    for (n, per) in [(12, "P1M"), (52, "P1W")] {
                        let down = p.price / n, up = p.price / n + (p.price % n * 2 >= n ? 1 : 0)
                        if v == down || v == up { out.append((p, per)); break }
                    }
                }
            }
            return out
        }
        let bound = ms.map { e -> (FormatsJob.Product, String?)? in
            guard let v = e.m.minor else { return nil }
            let b = bind(v)
            return b.count == 1 ? b[0] : nil
        }
        // D41: amounts are judged only on a screen where some amount binds (a paywall); a balance on a stats screen
        // is not a price.
        guard bound.contains(where: { $0 != nil }) else { return ([], 0) }
        let wasWords = words(lang).hand["was"] ?? []
        for (k, e) in ms.enumerated() {
            guard let v = e.m.minor else { continue }
            let l = lines[e.line]
            let s = fold(l.text) as NSString
            let before = s.substring(to: e.m.range.location)
            let after = s.substring(from: e.m.range.location + e.m.range.length)
            if let (p, derived) = bound[k] {
                // period: the word next to the amount against the product's (or the derived) period.
                let want = derived ?? p.period
                if let per = period(after: after, before: before, lang: lang), let want, isoPeriod(per) != want {
                    var x = Finding(kind: "price", box: box(l, e.m.range), line: l.text)
                    x.field = "period"; x.token = e.m.token; x.product = p.id
                    x.expected = phrase(want, lang: lang)
                    hits.append(Hit(line: e.line, finding: x))
                }
                continue
            }
            if !bind(v).isEmpty { continue } // two products: ambiguous (D8)
            // "Was" prices: a higher amount before a bound one on its line, or next to a was word, is exempt.
            let sameLine = ms.indices.filter { ms[$0].line == e.line && $0 != k }
            let beforeBound = sameLine.contains { j in
                guard let b = bound[j], let bv = ms[j].m.minor else { return false }
                return j > k && v > bv && b.0.price <= v
            }
            let tail = String(before.lowercased().suffix(24))
            if beforeBound || wasWords.contains(where: { tail.contains($0) }) { exempt += 1; continue }
            var x = Finding(kind: "price", box: box(l, e.m.range), line: l.text)
            x.field = "amount"; x.token = e.m.token
            x.expected = nearest(v, job.products.filter { $0.currency == exp }, ld: ld)
            hits.append(Hit(line: e.line, finding: x))
        }
        // trial: a duration with a trial word, on a line whose amounts bind to one product.
        for (i, l) in lines.enumerated() {
            let ps = ms.indices.filter { ms[$0].line == i }.compactMap { bound[$0]?.0 }
            guard let p = ps.first, ps.allSatisfy({ $0.id == p.id }), let claim = trial(l.text, lang: lang) else { continue }
            if let t = p.trial, days(t) == days(claim) { continue }
            var x = Finding(kind: "price", box: Geometry.box(l.rect), line: l.text)
            x.field = "trial"; x.token = claim; x.product = p.id
            x.expected = p.trial ?? "none"
            hits.append(Hit(line: i, finding: x))
        }
        return (hits, exempt)
    }

    static func phrase(_ iso: String, lang: String) -> String {
        let p = ["P1D": "day", "P1W": "week", "P1M": "month", "P1Y": "year"][iso]
        if let p, let w = words(lang).per[p]?.first { return w }
        if let p, let w = words(lang).units[p]?.first { return "/\(w)" }
        return iso
    }

    static func nearest(_ v: Int, _ ps: [FormatsJob.Product], ld: LocaleData) -> String? {
        guard let p = ps.min(by: { abs($0.price - v) < abs($1.price - v) }) else { return nil }
        let nf = NumberFormatter()
        nf.locale = ld.locale
        nf.numberStyle = .currency
        nf.currencyCode = p.currency
        let d = digits(p.currency)
        return nf.string(from: (Decimal(p.price) / pow(10, d)) as NSDecimalNumber).map(fold)
    }
}
