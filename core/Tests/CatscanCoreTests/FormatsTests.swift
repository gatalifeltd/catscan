// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-036 check 5 (T3) and D33-D41: the core's half of `formats`, on synthetic recognized lines. Expected values
/// come from Foundation's CLDR on the running Mac, so the tests assert roles and rules, not exact renderings,
/// except where the rendering is stable across CLDR releases.
final class FormatsTests: XCTestCase {
    func lines(_ texts: [String], conf: Double = 0.95) -> [RecognizedLine] {
        texts.enumerated().map { RecognizedLine(text: $0.element, rect: CGRect(x: 0.1, y: 0.05 + Double($0.offset) * 0.05, width: 0.6, height: 0.03), confidence: conf) }
    }

    func run(_ texts: [String], _ locale: String, rules: [String]? = nil, currency: String? = nil, storefront: String? = nil,
        products: [FormatsJob.Product] = [], allow: [String] = [], conf: Double = 0.95) -> Formats.Result {
        var j = FormatsJob()
        if let rules { j.rules = Set(rules) }
        j.currency = currency
        j.storefront = storefront
        j.products = products
        j.allow = allow
        return Formats.evaluate(j, lines: lines(texts, conf: conf), locale: locale)
    }

    func rules(_ r: Formats.Result) -> [String] { r.findings.map { "\($0.kind)/\($0.rule ?? $0.field ?? "")" } }

    // MARK: Token grammar (D12, D37)

    func testResolveSeparators() {
        // Value: protects=D12 and D37 separator roles; fails_when=a single 3-digit group is called a decimal, a repeated separator a decimal, or `$4.9` rescaled; why_new=new; seam=none; no_claim=OCR
        let r = NSRange(location: 0, length: 0)
        let a = Formats.resolve("1,234.56", range: r, currencyDigits: nil, localeGroup: ",")!
        XCTAssertEqual(a.decimal, "."); XCTAssertEqual(a.group, ","); XCTAssertEqual(a.intDigits, "1234"); XCTAssertEqual(a.frac, "56")
        let b = Formats.resolve("1,234", range: r, currencyDigits: nil, localeGroup: ",")!
        XCTAssertNil(b.decimal); XCTAssertNil(b.group) // ambiguous
        XCTAssertNil(Formats.resolve("1.2.3", range: r, currencyDigits: nil, localeGroup: ","))
        XCTAssertEqual(Formats.resolve("12,34,567.89", range: r, currencyDigits: nil, localeGroup: ",")?.intDigits, "1234567") // en-IN
        XCTAssertNil(Formats.resolve("4.9", range: r, currencyDigits: 2, localeGroup: ","))
        XCTAssertNil(Formats.resolve("4.990", range: r, currencyDigits: 2, localeGroup: ",")) // `.` is not en's group
        XCTAssertEqual(Formats.resolve("4.990", range: r, currencyDigits: 2, localeGroup: ".")?.intDigits, "4990") // de
        XCTAssertEqual(Formats.resolve("1 234 567", range: r, currencyDigits: nil, localeGroup: " ")?.group, " ")
        XCTAssertNil(Formats.resolve("2 400 00", range: r, currencyDigits: nil, localeGroup: " ")) // D12: 3-digit groups only
        XCTAssertEqual(Formats.resolve("1500", range: r, currencyDigits: 0, localeGroup: ",")?.intDigits, "1500")
    }

    // MARK: number

    func testNumberWrongRolesPerLocale() {
        // Value: protects=number rule over the 12 bench locales; fails_when=a locale's own format is flagged or a swapped one is not; why_new=new; seam=none; no_claim=Vision reads
        for (loc, good, bad) in [
            ("de", "1.234,56", "1,234.56"), ("fr", "1 234,56", "1,234.56"), ("es", "1.234,56", "1,234.56"),
            ("it", "1.234,56", "1,234.56"), ("pt-BR", "1.234,56", "1,234.56"), ("tr", "1.234,56", "1,234.56"),
            ("ru", "1 234,56", "1,234.56"), ("en-US", "1,234.56", "1.234,56"), ("en-GB", "1,234.56", "1.234,56"),
            ("en-IN", "1,234.56", "1.234,56"), ("ja", "1,234.56", "1.234,56"), ("ko", "1,234.56", "1.234,56"),
        ] {
            XCTAssertEqual(rules(run(["Total \(good) points"], loc)), [], "\(loc) \(good)")
            let f = run(["Total \(bad) points"], loc).findings
            XCTAssertEqual(f.map(\.rule), ["number"], "\(loc) \(bad)")
            XCTAssertEqual(f.first?.token, bad)
        }
    }

    func testNumberNegatives() {
        // Value: protects=ambiguous and non-number tokens stay silent; fails_when=versions, ambiguous 1,234, percentages, times or ranges are flagged; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(run(["v1.2.3", "Version 10.25.3", "1,234 players", "12,5 %", "Score 12:30", "Level 1-3", "+1 555 123 4567"], "de")), [])
        XCTAssertEqual(rules(run(["12.5 km", "1,234"], "de")), []) // one separator, no currency: ambiguous
    }

    func testNumberDecimalNextToCurrency() {
        // Value: protects=the 2-decimals-next-to-currency branch; fails_when=`9.99 €` in de passes; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(run(["Nur 9.99 € heute"], "de")), ["format/number"])
        XCTAssertEqual(rules(run(["Nur 9,99 € heute"], "de")), [])
    }

    // MARK: date

    func testDateOrderOnlyWhenProven() {
        // Value: protects=date rule proof requirement; fails_when=an unprovable date is flagged or a proven swap passes; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(run(["Expires 11/25/2026"], "de")), ["format/date"]) // M/d in a d.M locale
        XCTAssertEqual(rules(run(["Expires 25.11.2026"], "de")), [])
        XCTAssertEqual(rules(run(["Expires 05/06/2026"], "de")), []) // no field proves the order
        XCTAssertEqual(rules(run(["Expires 25/11/2026"], "en-US")), ["format/date"])
        XCTAssertEqual(rules(run(["Expires 11/25/26"], "en-GB")), ["format/date"]) // middle field > 12
        XCTAssertEqual(rules(run(["Expires 2026/11/25"], "de")), ["format/date"]) // year first
        XCTAssertEqual(rules(run(["Expires 2026/11/25"], "ja")), [])
        XCTAssertEqual(rules(run(["Built 2026-11-25"], "de")), []) // ISO 8601 (D41)
        let f = run(["Expires 11/25/2026"], "de").findings[0]
        XCTAssertTrue(f.expected?.contains("25") ?? false)
    }

    // MARK: time (opt-in, D7)

    func testTimeMarkerIn24HourLocale() {
        // Value: protects=time rule and its opt-in; fails_when=AM/PM passes in de, 24-hour is flagged in en-US, or the rule runs by default; why_new=new; seam=none; no_claim=none
        let all = FormatsJob.allRules
        XCTAssertEqual(rules(run(["Starts at 3:00 PM"], "de", rules: all)), ["format/time"])
        XCTAssertEqual(rules(run(["Starts at 3:00 PM"], "de")), []) // off by default
        XCTAssertEqual(rules(run(["Starts at 15:00"], "en-US", rules: all)), [])
        XCTAssertEqual(rules(run(["Starts at 3:00 PM"], "en-US", rules: all)), [])
        XCTAssertEqual(rules(run(["Starts at 3:00 PM"], "ko", rules: all)), [])
    }

    // MARK: currency (D9, D20)

    func testCurrencyByStorefront() {
        // Value: protects=unexpected currency incl. English UI in a DE storefront and ambiguous `$`; fails_when=`$` passes in DE or fails in CA; why_new=new; seam=none; no_claim=none
        let f = run(["Pro $4.99 / month"], "en", currency: "EUR", storefront: "DE").findings
        XCTAssertEqual(f.map(\.kind), ["currency"])
        XCTAssertEqual(f[0].rule, "unexpected"); XCTAssertEqual(f[0].currencies, ["USD"]); XCTAssertEqual(f[0].expectedCurrency, "EUR")
        XCTAssertEqual(f[0].token, "$4.99")
        XCTAssertEqual(rules(run(["Pro €4.99 / month"], "en", currency: "EUR", storefront: "DE")), [])
        XCTAssertEqual(rules(run(["Pro $4.99 / month"], "en", currency: "CAD", storefront: "CA")), [])
        XCTAssertEqual(rules(run(["Pro 49 kr / mån"], "sv", currency: "SEK", storefront: "SE")), [])
        XCTAssertEqual(rules(run(["Pro USD 4.99"], "en", currency: "EUR")), ["currency/unexpected"])
    }

    func testMixedWithoutStorefront() {
        // Value: protects=mixed-currency; fails_when=two currencies on a screen pass, or `$` with `US$` is mixed; why_new=new; seam=none; no_claim=none
        let f = run(["Monthly $7.99", "Yearly €39.99"], "en").findings
        XCTAssertEqual(f.map { "\($0.kind)/\($0.rule!)" }, ["currency/mixed"])
        XCTAssertNil(f[0].expectedCurrency)
        XCTAssertEqual(f[0].currencies, ["EUR", "USD"])
        XCTAssertEqual(rules(run(["Monthly $7.99", "Yearly US$39.99"], "en")), [])
        let w = run(["Monthly $7.99"], "en")
        XCTAssertEqual(w.findings, [])
    }

    func testCurrencyGuards() {
        // Value: protects=look-alike letters, `$` without an amount, low confidence and the missing-glyph line (D2); fails_when=any of them makes a currency finding; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(run(["Pro C9,99", "E 9,99", "S 4.99", "P5.00"], "de", currency: "USD")), [])
        XCTAssertEqual(rules(run(["$name won $$$", "Earn $ today"], "en", currency: "EUR")), [])
        XCTAssertEqual(rules(run(["Pro $4.99"], "en", currency: "EUR", conf: 0.3)), [])
        XCTAssertEqual(rules(run(["Prix \u{25A1} 666 $4.99"], "fr", currency: "EUR")), [])
    }

    func testPlacementOptIn() {
        // Value: protects=currency-placement side and spacing, opt-in, storefront format accepted (D41); fails_when=`€9,99` passes in de or the rule runs by default; why_new=new; seam=none; no_claim=none
        let all = FormatsJob.allRules
        XCTAssertEqual(rules(run(["Nur €9,99"], "de", rules: all, currency: "EUR")), ["format/currency-placement"])
        XCTAssertEqual(rules(run(["Nur €9,99"], "de", currency: "EUR")), [])
        XCTAssertEqual(rules(run(["Nur 9,99 €"], "de", rules: all, currency: "EUR")), [])
        XCTAssertEqual(rules(run(["Only €9.99"], "en-IE", rules: all, currency: "EUR")), [])
    }

    func testAllowList() {
        // Value: protects=--allow skips a line; fails_when=an allowed line is flagged; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(run(["Total 1,234.56 points"], "de", allow: ["Total 1,234.56 points"])), [])
    }

    // MARK: price (D8, D38, D41)

    let annual = FormatsJob.Product(id: "annual", price: 3999, currency: "USD", period: "P1Y", trial: "P3D")
    let monthly = FormatsJob.Product(id: "monthly", price: 799, currency: "USD", period: "P1M")
    let weekly = FormatsJob.Product(id: "weekly", price: 399, currency: "USD", period: "P1W")

    func price(_ texts: [String], products: [FormatsJob.Product]? = nil) -> Formats.Result {
        run(texts, "en", currency: "USD", storefront: "US", products: products ?? [annual, monthly, weekly])
    }

    func testPriceAmountAndPeriod() {
        // Value: protects=amount binding, period by suffix and prefix, the two-pair line (D38); fails_when=a bound amount is flagged, a wrong period passes, or pairs cross; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(price(["3 day free, then $39.99 per year."])), [])
        XCTAssertEqual(rules(price(["$7.99/month or $39.99/year"])), [])
        XCTAssertEqual(rules(price(["$39.99/month"])), ["price/period"])
        XCTAssertEqual(rules(price(["$7.99/year or $39.99/month"])), ["price/period", "price/period"])
        XCTAssertEqual(rules(price(["Monthly: $39.99"])), ["price/period"])
        XCTAssertEqual(rules(price(["Monthly", "$7.99"])), []) // label line above: not its period (D38)
        let f = price(["$39.99/month"]).findings[0]
        XCTAssertEqual(f.product, "annual"); XCTAssertEqual(f.expected, "per year")
        XCTAssertEqual(rules(price(["Pro $5.49 per month", "Annual $39.99"])), ["price/amount"])
    }

    func testDerivedAndAmbiguousAndWasPrices() {
        // Value: protects=derived per-period price, ambiguous amounts skipped, "was" exemption counted, no amount rule off a paywall (D41); fails_when=any of those flags or the count is wrong; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(price(["Only $3.33/month, billed $39.99 yearly"])), []) // 3999/12 = 333.25 -> 333
        XCTAssertEqual(rules(price(["Only $0.76/week", "$39.99 per year"])), []) // 3999/52 = 76.9 -> 76 or 77
        let twin = [annual, FormatsJob.Product(id: "annual-b", price: 3999, currency: "USD", period: "P1Y")]
        XCTAssertEqual(rules(price(["$39.99/month"], products: twin)), []) // two products: skipped (D8)
        let was = price(["$79.99 $39.99 per year"])
        XCTAssertEqual(rules(was), []); XCTAssertEqual(was.priceExempt, 1)
        XCTAssertEqual(price(["Was $59.99", "$39.99 per year"]).priceExempt, 1)
        XCTAssertEqual(rules(price(["Balance $123.45"])), []) // nothing binds: not a paywall
    }

    func testTrial() {
        // Value: protects=trial field with one bound product, two durations skipped, `No free trial` silent; fails_when=a matching trial flags or a wrong one passes; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(price(["3 day free, then $39.99 per year."])), [])
        XCTAssertEqual(rules(price(["7-day free trial, then $39.99 per year."])), ["price/trial"])
        XCTAssertEqual(rules(price(["3 day free trial, then $7.99/month"])), ["price/trial"])
        XCTAssertEqual(price(["3 day free trial, then $7.99/month"]).findings[0].expected, "none")
        XCTAssertEqual(rules(price(["No free trial. $7.99/month"])), [])
        XCTAssertEqual(rules(price(["3 day free trial"])), []) // no amount on the line
    }

    func testRupeeMisreadsStayQuiet() {
        // Value: protects=D42 alias; fails_when=a `€` read on an IN storefront is a currency or price finding, or `$` stops being one; why_new=new; seam=none; no_claim=which glyphs Vision misreads (bench/formats.js)
        let inr = [FormatsJob.Product(id: "annual", price: 349900, currency: "INR", period: "P1Y")]
        XCTAssertEqual(rules(run(["₹3,499.00 per year", "Total €1.64"], "en-IN", currency: "INR", storefront: "IN", products: inr)), [])
        XCTAssertEqual(rules(run(["₹3,499.00 per year", "Total $1.64"], "en-IN", currency: "INR", storefront: "IN", products: inr)), ["currency/unexpected"])
        XCTAssertEqual(rules(run(["₹3,499.00 per year", "Total €1.64"], "en-IN")), [])
    }

    func testPriceRulesNeedCurrency() {
        // Value: protects=D15 filtering and price off without a currency; fails_when=price runs with no currency or a filtered rule still reports; why_new=new; seam=none; no_claim=none
        XCTAssertEqual(rules(run(["$39.99/month"], "en", products: [annual])), [])
        XCTAssertEqual(rules(run(["$39.99/month"], "en", rules: ["number"], currency: "USD", products: [annual])), [])
        XCTAssertNil(run(["$39.99/month"], "en").priceExempt)
    }

    // MARK: serve field (D36)

    func testServeFormatsJob() throws {
        // Value: protects=serve formats field parsing and its invalid-request errors; fails_when=a malformed rule, code, region, product or duration reaches the rules; why_new=no test called Server.formatsJob; seam=none; no_claim=the serve loop (test/formats.test.js)
        func obj(_ json: String) -> Any { try! JSONSerialization.jsonObject(with: Data(json.utf8)) }
        let ok = try Server.formatsJob(obj(#"{"rules":["number","price"],"currency":"USD","storefront":"US","allow":["Ok 1"],"products":[{"product":"annual","price":3999,"currency":"USD","period":"P1Y","trial":"P3D"},{"product":"life","price":9900,"currency":"USD","period":null}]}"#)).get()
        XCTAssertEqual(ok.rules, ["number", "price"]); XCTAssertEqual(ok.currency, "USD"); XCTAssertEqual(ok.storefront, "US"); XCTAssertEqual(ok.allow, ["Ok 1"])
        XCTAssertEqual(ok.products, [annual, FormatsJob.Product(id: "life", price: 9900, currency: "USD")])
        let empty = try Server.formatsJob(obj(#"{"currency":null,"storefront":null}"#)).get()
        XCTAssertEqual(empty, FormatsJob())
        for (json, field) in [
            (#"[]"#, "formats must"), (#"{"rules":["numbr"]}"#, "rules"), (#"{"rules":"number"}"#, "rules"),
            (#"{"currency":"eur"}"#, "currency"), (#"{"currency":"EURO"}"#, "currency"), (#"{"storefront":"DEU"}"#, "storefront"),
            (#"{"storefront":"de"}"#, "storefront"), (#"{"allow":[1]}"#, "allow"), (#"{"products":{}}"#, "products must"),
            (#"{"products":[{"product":"a","price":9.99,"currency":"USD"}]}"#, "products[0] needs"),
            (#"{"products":[{"product":"a","price":-1,"currency":"USD"}]}"#, "products[0] needs"),
            (#"{"products":[{"product":"a","price":1,"currency":"usd"}]}"#, "products[0] needs"),
            (#"{"products":[{"price":1,"currency":"USD"}]}"#, "products[0] needs"),
            (#"{"products":[{"product":"a","price":1,"currency":"USD","period":"monthly"}]}"#, "products[0].period"),
            (#"{"products":[{"product":"a","price":1,"currency":"USD","trial":7}]}"#, "products[0].period"),
            (#"{"rules":[]}"#, "rules"), (#"{"products":[{"product":"a","price":true,"currency":"USD"}]}"#, "products[0] needs"),
            (#"{"products":[{"product":"a","price":1000000000000000001,"currency":"USD"}]}"#, "products[0] needs"),
            (#"{"products":[{"product":"a","price":1,"digits":7,"currency":"USD"}]}"#, "products[0].digits"),
            (#"{"products":[{"product":"a","price":1,"currency":"USD","trial":"P99999999999999999Y"}]}"#, "products[0].period"),
        ] {
            guard case .failure(let d) = Server.formatsJob(obj(json)) else { XCTFail("accepted \(json)"); continue }
            XCTAssertEqual(d.code, "invalid-request", json)
            XCTAssertTrue(d.message.hasPrefix("formats.\(field)"), "\(json): \(d.message)")
        }
    }

    func testProductDigitsAndHugeAmounts() throws {
        // Value: protects=review fixes (Node and Foundation digits disagree for PKR and RSD; overflow traps kill serve); fails_when=a PKR price stays 100x what the core reads, or an 18-digit amount or a 10^18 price traps; why_new=review findings; seam=none; no_claim=which codes disagree on a given macOS (checked by Formats.digits)
        func obj(_ json: String) -> Any { try! JSONSerialization.jsonObject(with: Data(json.utf8)) }
        let d = Formats.digits("PKR"), usd = Formats.digits("USD")
        let pk = try Server.formatsJob(obj(#"{"products":[{"product":"a","price":110000,"digits":2,"currency":"PKR"},{"product":"b","price":99950,"digits":2,"currency":"PKR"},{"product":"c","price":399,"digits":2,"currency":"USD"}]}"#)).get()
        // Rescaled to Foundation's digits; a fraction Foundation cannot hold is left out only when its digits are fewer.
        XCTAssertEqual(pk.products.map(\.id), d < 2 ? ["a", "c"] : ["a", "b", "c"])
        XCTAssertEqual(pk.products[0].price, 110000 / Int(pow(10, Double(2 - min(d, 2)))))
        XCTAssertEqual(pk.products.last?.price, 399 * Int(pow(10, Double(usd - 2))))
        _ = run(["Total $100,000,000,000,000,000.00", "€ 123456789012345678"], "en-US", currency: "USD", storefront: "US")
        let big = [FormatsJob.Product(id: "big", price: 1_000_000_000_000_000_000, currency: "USD", period: "P1Y")]
        _ = run(["$9.99 / month"], "en-US", currency: "USD", storefront: "US", products: big)
    }

    func testFindingAndEnvelopeKeys() throws {
        // Value: protects=D20 and schema-required keys when null; fails_when=expected or expected_currency is dropped when nil, or price_exempt leaks to other commands or errors; why_new=goldens only see non-null values; seam=none; no_claim=none
        func keys<T: Encodable>(_ v: T) throws -> [String: Any] { try JSONSerialization.jsonObject(with: JSONEncoder().encode(v), options: .fragmentsAllowed) as! [String: Any] }
        var f = Finding(kind: "format", box: nil, line: "x"); f.rule = "number"
        XCTAssertTrue(try keys(f)["expected"] is NSNull)
        var c = Finding(kind: "currency", box: nil, line: "x"); c.rule = "mixed"; c.currencies = ["EUR", "USD"]
        XCTAssertTrue(try keys(c)["expected_currency"] is NSNull)
        var p = Finding(kind: "price", box: nil, line: "x"); p.field = "amount"
        let pk = try keys(p)
        XCTAssertTrue(pk["expected"] is NSNull); XCTAssertNil(pk["product"]); XCTAssertEqual(pk["field"] as? String, "amount")
        let host = HostInfo(chip: "x", arch: "arm64", host_class: "x", macos: "27", vision_revision: 3)
        func envelope(_ cmd: String) -> Envelope { Envelope(command: cmd, path: "a.png", verdict: "pass", engine: "e", locale: "en", image: nil, host: host) }
        var env = envelope("formats")
        XCTAssertTrue(try keys(env)["price_exempt"] is NSNull)
        env.error = Diagnostic("file-not-found", "m")
        XCTAssertNil(try keys(env)["price_exempt"])
        XCTAssertNil(try keys(envelope("overlap"))["price_exempt"])
    }

    func testTablesCarryCJKAndDropOneLetters() {
        // Value: protects=D35 table filter; fails_when=narrow `M`/`J` stay or `年` is dropped; why_new=new; seam=none; no_claim=CLDR content beyond these words
        XCTAssertFalse(FormatsTables.units["de"]!["year"]!.contains("j"))
        XCTAssertTrue(FormatsTables.perUnit["ja"]!["year"]!.contains("/年"))
        XCTAssertTrue(FormatsTables.units["en"]!["month"]!.contains("month"))
    }
}
