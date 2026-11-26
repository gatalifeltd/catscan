// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-036 T4: `uncatalogued` (Check 4, D48-D53). The rule is a pure function over recognized lines and catalog
/// forms, so the tests build both literally; Vision runs only in the integration golden.
final class UncataloguedTests: XCTestCase {
    func entry(_ key: String, _ text: String, locale: String = "en") -> UncataloguedJob.Entry {
        // `{x}` marks a placeholder, as the Node layer splits it (spec 02 fragments with lead/trail).
        let parts = text.components(separatedBy: "{x}")
        let frags = parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return .init(key: key, locale: locale, text: text, forms: [.init(fragments: frags, lead: text.hasPrefix("{x}"), trail: text.hasSuffix("{x}"))])
    }

    func job(_ e: [UncataloguedJob.Entry], dynamic: [String] = [], rects: [CGRect] = [], allow: [String] = []) -> UncataloguedJob {
        var j = UncataloguedJob(entries: e)
        j.guards = try! DynamicText(patterns: dynamic, rects: rects, allow: allow)
        return j
    }

    /// Lines stacked down the screen, far apart so none continues another, unless `rects` places them.
    func lines(_ texts: [String], rects: [CGRect]? = nil) -> [RecognizedLine] {
        texts.enumerated().map { i, t in
            RecognizedLine(text: t, rect: rects?[i] ?? CGRect(x: 0.1, y: 0.1 + Double(i) * 0.12, width: 0.6, height: 0.03), confidence: 0.95)
        }
    }

    func flagged(_ j: UncataloguedJob, _ texts: [String], rects: [CGRect]? = nil, locale: String = "en", skip: Set<Int> = []) -> [String] {
        Uncatalogued.evaluate(j, lines: lines(texts, rects: rects), locale: locale, aspect: 0.56, skip: skip).map(\.finding.line)
    }

    let catalog = [
        "settings": "Settings and privacy", "account": "Account", "security": "Security", "prefs": "Settings",
        "news": "Read the latest news from our team", "order": "Your order has been shipped and will arrive soon",
        "welcome": "Welcome back, {x}", "greet": "Olá, {x}", "coins": "{x} coins left in your wallet", "plans": "Tap here to learn more about our plans",
    ]
    lazy var base = job(catalog.map { entry($0.key, $0.value) })

    func testWholeFormsExactFuzzyAndTwoInARow() {
        // Value: protects=D48 (1), (4), (5); fails_when=a catalog line or its OCR misread is flagged, or two labels read as one line are; why_new=new rule; seam=none; no_claim=Vision's misreads (bench)
        XCTAssertEqual(flagged(base, ["Settings and privacy", "Settinqs and privacv", "Read the latest news from our team."]), [])
        XCTAssertEqual(flagged(base, ["Account Settings"]), [], "two whole forms in a row")
        XCTAssertEqual(flagged(base, ["Account Security Settings"]), [], "a tab bar: three whole forms in a row")
        XCTAssertEqual(flagged(base, ["Account Security Bonus"]), ["Account Security Bonus"], "every part must be a whole form")
        XCTAssertEqual(flagged(base, ["Account security settings"]), ["Account security settings"], "three in a sentence's case are prose")
        // Fragments of different keys never add up (D48), and near-catalog prose past 0.2 is a finding.
        XCTAssertEqual(flagged(base, ["Account security settings", "Read the newest stories from the team"]), ["Account security settings", "Read the newest stories from the team"])
    }

    func testCutsNeedAnEllipsisOrMostOfTheForm() {
        // Value: protects=D48 (2); fails_when=a middle fragment or a short start of a long sentence covers a standalone label, or a real cut is flagged; why_new=outside voice; seam=none; no_claim=none
        XCTAssertEqual(flagged(base, ["Your order has been shipped and will…", "Your order has been shipped and wi"]), [])
        XCTAssertEqual(flagged(base, ["Learn more about our plans", "Tap here to learn"]), ["Learn more about our plans", "Tap here to learn"])
        XCTAssertEqual(flagged(base, ["Tap here to learn..."]), [])
    }

    func testPlaceholderSlotsOnly() {
        // Value: protects=D48 (3); fails_when=a filled placeholder is flagged, or a long text around a short fixed part is covered; why_new=new rule; seam=none; no_claim=none
        XCTAssertEqual(flagged(base, ["Welcome back, Anna", "250 coins left in your wallet"]), [])
        XCTAssertEqual(flagged(base, ["Welcome back, the whole team says thanks for the many updates this week"]),
                       ["Welcome back, the whole team says thanks for the many updates this week"])
        XCTAssertEqual(flagged(base, ["Welcome back"]), [], "the start of the form, 100% of its fixed head")
        // A short value (a name) fills a slot even when the fixed text is under half the letters (bench: pt-BR).
        XCTAssertEqual(flagged(base, ["Olá, Anna", "Olá, Maria Luiza"]), [])
        XCTAssertEqual(flagged(job([entry("near", "{x} more to the +{x} bonus")]), ["4 more to the +40 bonus"]), [], "real leg: two slots")
        // Review: Node's fragments keep their punctuation; a fragment that is only punctuation keeps its slot.
        let punct = job([
            .init(key: "w", locale: "en", text: "Welcome, {name}!", forms: [.init(fragments: ["Welcome,", "!"])]),
            .init(key: "d", locale: "en", text: "Delete “{name}”?", forms: [.init(fragments: ["Delete “", "”?"])]),
            .init(key: "s", locale: "fr", text: "Supprimer « {name} » ?", forms: [.init(fragments: ["Supprimer «", "» ?"])]),
        ])
        XCTAssertEqual(flagged(punct, ["Welcome, Anna!", "Delete “Report”?", "Supprimer « Rapport » ?"]), [])
        XCTAssertEqual(flagged(punct, ["Welcome"]), [], "the fixed head alone is a 100% cut")
        XCTAssertEqual(flagged(punct, ["Delete everything in this folder now"]), ["Delete everything in this folder now"], "prose after the head is no short slot")
        XCTAssertEqual(flagged(base, ["Olá, todos os jogadores da nossa equipe"]), ["Olá, todos os jogadores da nossa equipe"])
    }

    func testJoinOnlyWhenTheLineContinues() {
        // Value: protects=D49; fails_when=two unrelated lines join into a catalog match, or a wrapped string is flagged; why_new=outside voice; seam=none; no_claim=none
        let wrapped = [CGRect(x: 0.1, y: 0.40, width: 0.7, height: 0.03), CGRect(x: 0.1, y: 0.435, width: 0.4, height: 0.03)]
        XCTAssertEqual(flagged(base, ["Your order has been shipped", "and will arrive soon"], rects: wrapped), [])
        XCTAssertEqual(flagged(base, ["Your order has been shipped", "and will arrive soon"]), ["Your order has been shipped", "and will arrive soon"],
                       "apart, 27 of 48 characters is under the 60% cut floor and the second line starts no form")
    }

    func testParagraphMiddleLinesAndChevrons() {
        // Value: protects=D49 paragraphs, canon chevrons; fails_when=a middle line of a wrapped catalog paragraph, or a label read with its chevron, is flagged, or a non-wrapped substring is covered; why_new=real leg false flags; seam=none; no_claim=Vision's line breaks (real leg)
        let legal = job([entry("legal", "I have read the Privacy Policy and the Terms of Use. By continuing, I acknowledge that the Company will process my personal data")])
        let wrap = (0..<4).map { CGRect(x: 0.1, y: 0.40 + Double($0) * 0.035, width: 0.7, height: 0.03) }
        XCTAssertEqual(flagged(legal, ["I have read the Privacy Policy and the", "Terms of Use. By continuing, I acknowledge", "that the Company will process my", "personal data"], rects: wrap), [])
        XCTAssertEqual(flagged(legal, ["Terms of Use. By continuing, I acknowledge"]), ["Terms of Use. By continuing, I acknowledge"], "alone, a middle part is not the string")
        // Centered store art: two short pieces of one form, stacked but not left-aligned (no `continues`).
        let warned = job([entry("warned", "They did warn you")])
        let art = [CGRect(x: 0.30, y: 0.50, width: 0.40, height: 0.05), CGRect(x: 0.25, y: 0.44, width: 0.50, height: 0.05)]
        XCTAssertEqual(flagged(warned, ["THEY DID", "WARN YOU"], rects: art), [])
        let comma = job([entry("gdpr", "I have read the Terms. By continuing, I agree")])
        XCTAssertEqual(flagged(comma, ["I have read the Terms. By", "continuing", "I agree"], rects: [art[0], art[1], CGRect(x: 0.3, y: 0.38, width: 0.4, height: 0.05)]), [], "a piece ends at a comma")
        XCTAssertEqual(flagged(warned, ["THEY DID", "WARN YOU"], rects: [art[0], CGRect(x: 0.25, y: 0.10, width: 0.50, height: 0.05)]), ["THEY DID", "WARN YOU"], "far apart, each piece is alone")
        XCTAssertEqual(flagged(base, ["v Account", "Security >", "Settings ›"]), [])
        XCTAssertEqual(flagged(base, ["Account 18 / 35", "Security O.3.1", "+30 Settings"]), [], "a form with a value beside it")
        XCTAssertEqual(flagged(base, ["Account 18 / 35 left today"]), ["Account 18 / 35 left today"], "a value inside prose is not a form")
    }

    func testAdversarialReviewFixes() {
        // Value: protects=slotted memo, caseless tab-bar rule, scalar prefix scan, smaller key on duplicate texts; fails_when=a long line hangs on short fragments, a CJK run of forms is covered, a Thai cut is missed, or nearest follows load order; why_new=adversarial review; seam=none; no_claim=real catalogs (bench)
        // 24 one-sign fragments over a line that fails at the end: exponential without the memo.
        let bars = job([.init(key: "bars", locale: "en", text: "", forms: [.init(fragments: Array(repeating: "|", count: 24), lead: true, trail: true)])])
        let line = (0..<30).map { "w\($0)" }.joined(separator: " | ") + " | " + String(repeating: "x", count: 60)
        XCTAssertEqual(flagged(bars, [line]), [line])
        // Caseless scripts are never titled, so a run of 3+ exact forms is prose there.
        let ja = job(["設定", "通知", "履歴", "表示"].enumerated().map { entry("k\($0.offset)", $0.element, locale: "ja") })
        XCTAssertEqual(flagged(ja, ["設定通知履歴表示"], locale: "ja"), ["設定通知履歴表示"])
        // Thai: a head with a combining mark sorts between the cut and the head it belongs to.
        // The cut is 8 of the valid head's 13 characters: past 60%, out of fuzzy reach (fix-check).
        let th = job([entry("a", "กขคงจฉชซ\u{0E31}ด", locale: "th"), entry("b", "กขคงจฉชซๆดตถท", locale: "th")])
        XCTAssertEqual(flagged(th, ["กขคงจฉชซ…"], locale: "th"), [])
        // The same text under two keys: nearest names the smaller one, whatever the load order.
        let dup = job([entry("b", "Photo album"), entry("a", "Photo album")])
        XCTAssertEqual(Uncatalogued.evaluate(dup, lines: lines(["Photo albums, yes"]), locale: "en", aspect: 0.56).first?.finding.nearest?.key, "a")
    }

    func testGuardsAndSkip() {
        // Value: protects=D51 guards and D52 skip; fails_when=a name, value, status bar, dynamic element, pattern or allowed line is flagged, or a line another kind reported is; why_new=new rule; seam=none; no_claim=which lines a project marks (D54)
        let j = job(base.entries, dynamic: [#"^Season \d+: .+$"#], rects: [CGRect(x: 0, y: 0.5, width: 1, height: 0.1)], allow: ["Made with love"])
        let rects = [
            CGRect(x: 0.1, y: 0.01, width: 0.3, height: 0.02), // status band
            CGRect(x: 0.1, y: 0.52, width: 0.5, height: 0.03), // inside the dynamic element
            CGRect(x: 0.1, y: 0.20, width: 0.5, height: 0.03), CGRect(x: 0.1, y: 0.25, width: 0.5, height: 0.03),
            CGRect(x: 0.1, y: 0.30, width: 0.5, height: 0.03), CGRect(x: 0.1, y: 0.35, width: 0.5, height: 0.03),
            CGRect(x: 0.1, y: 0.70, width: 0.5, height: 0.03),
        ]
        let texts = ["Carrier signal strong now", "Anna Schmidt likes this", "Season 3: Frozen Peaks", "Made with love", "12:30 - 4 Dec", "Hello", "This text is hardcoded somewhere"]
        XCTAssertEqual(flagged(j, texts, rects: rects), ["This text is hardcoded somewhere"])
        XCTAssertEqual(flagged(j, texts, rects: rects, skip: [6]), [])
    }

    func testNearestAndLanguageFields() {
        // Value: protects=Check 4 finding shape and D53 nearest; fails_when=nearest is missing for a close string, kept past 0.5, or its tie order drifts; why_new=new fields; seam=none; no_claim=the recognizer's probabilities (integration)
        let r = Uncatalogued.evaluate(base, lines: lines(["Read the newest stories from the team", "Completely unrelated words over here"]), locale: "en", aspect: 0.56)
        XCTAssertEqual(r.count, 2)
        XCTAssertEqual(r[0].finding.nearest?.key, "news")
        XCTAssertLessThan(r[0].finding.nearest!.distance, 0.5)
        XCTAssertNil(r[1].finding.nearest)
        XCTAssertNil(r[0].finding.language, "no project languages given")
        let tie = job([entry("b", "Photo album one"), entry("a", "Photo album two")]) // both 4 edits from the line
        XCTAssertEqual(Uncatalogued.evaluate(tie, lines: lines(["Photo album xyzw"]), locale: "en", aspect: 0.56).first?.finding.nearest?.key, "a")
    }

    func testBoundedDistanceAndGramFilterAgreeWithBruteForce() {
        // Value: protects=D53; fails_when=the 3-gram filter or the early exit drops a form within the cutoff; why_new=new search; seam=none; no_claim=speed (bench microbenchmark)
        func lev(_ a: [Character], _ b: [Character]) -> Int {
            var d = Array(0...b.count)
            for i in 1...max(a.count, 1) where !a.isEmpty {
                var p = d[0]; d[0] = i
                for j in 1...max(b.count, 1) where !b.isEmpty { let t = d[j]; d[j] = min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] == b[j - 1] ? 0 : 1)); p = t }
            }
            return d[b.count]
        }
        // Seeded (review): a failure replays with the same forms and lines.
        struct SplitMix: RandomNumberGenerator {
            var state: UInt64
            mutating func next() -> UInt64 { state &+= 0x9E3779B97F4A7C15; var z = state; z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9; z = (z ^ (z >> 27)) &* 0x94D049BB133111EB; return z ^ (z >> 31) }
        }
        var rng = SplitMix(state: 36004)
        let alphabet = Array("abcde ")
        var forms: [String] = []
        for i in 0..<300 { forms.append(String((0..<(8 + i % 20)).map { _ in alphabet.randomElement(using: &rng)! })) }
        let j = job(forms.enumerated().map { entry("k\($0.offset)", $0.element) })
        let x = Uncatalogued.index(j, locale: "en")
        for _ in 0..<60 {
            let t = Array(Uncatalogued.canon(String((0..<(8 + Int.random(in: 0..<20, using: &rng))).map { _ in alphabet.randomElement(using: &rng)! }), locale: "en"))
            let got = Set(Uncatalogued.near(t, x, cutoff: Uncatalogued.fuzzy, all: false).map(\.whole))
            let want = Set(x.wholes.indices.filter { wi in
                let w = x.wholes[wi].text, longer = max(w.count, t.count)
                let inWindow = Double(w.count) >= (Double(t.count) * 0.8).rounded(.down) && Double(w.count) <= (Double(t.count) * 1.2).rounded(.up)
                return inWindow && Double(lev(t, w)) <= (0.2 * Double(longer)).rounded(.down)
            })
            XCTAssertEqual(got, want, String(t))
        }
    }

    func testServeUncataloguedJob() throws {
        // Value: protects=D50 wire shape; fails_when=a malformed entry or pattern reaches the rule, or the cap is not enforced; why_new=new field; seam=none; no_claim=the serve loop (integration)
        func obj(_ json: String) -> [String: Any] { try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any] }
        let ok = try Server.uncataloguedJob(obj(#"{"entries":[{"key":"a","locale":"de","text":"Hallo {x}","forms":[{"fragments":["Hallo"],"trail":true}]}],"languages":["de","en"],"dynamic":["^x$"],"allow":["Ok"]}"#)).get()
        XCTAssertEqual(ok.entries, [entry("a", "Hallo {x}", locale: "de")])
        XCTAssertEqual(ok.languages, ["de", "en"])
        XCTAssertEqual(ok.guards.patterns, ["^x$"])
        for (json, what) in [
            (#"{}"#, "entries must"), (#"{"entries":[{"key":"a","text":"b","forms":[]}]}"#, "entries items need"),
            (#"{"entries":[],"dynamic":["("]}"#, "dynamic[0]"), (#"{"entries":[{"key":"a","locale":"en","text":"b","forms":[{}]}]}"#, "entries a forms"),
        ] {
            guard case .failure(let d) = Server.uncataloguedJob(obj(json)) else { XCTFail("accepted \(json)"); continue }
            XCTAssertTrue(d.message.hasPrefix("uncatalogued.\(what)"), "\(json): \(d.message)")
        }
        // Added by /ship coverage audit.
        // Value: protects=D50 entry, form and fragment caps and field types on the wire; fails_when=a cap check is dropped or off by one, or a non-array languages/allow is accepted; why_new=the rows above test no cap; seam=none; no_claim=the Node cap (untranslated.test.js)
        let many = { (n: Int, s: String) in Array(repeating: s, count: n).joined(separator: ",") }
        let form = #"{"fragments":["a"]}"#
        for (json, what) in [
            (#"{"entries":[\#(many(Server.uncataloguedEntries + 1, "0"))]}"#, "entries has \(Server.uncataloguedEntries + 1) items"),
            (#"{"entries":[{"key":"k","locale":"en","text":"t","forms":[\#(many(Untranslated.caps.alternatives + 1, form))]}]}"#, "entries k has \(Untranslated.caps.alternatives + 1) forms"),
            (#"{"entries":[{"key":"k","locale":"en","text":"t","forms":[{"fragments":[\#(many(Untranslated.caps.fragments + 1, "\"a\""))]}]}]}"#, "entries k has \(Untranslated.caps.fragments + 1) fragments"),
            (#"{"entries":[],"languages":"de"}"#, "languages must"), (#"{"entries":[],"allow":"Ok"}"#, "allow must"),
        ] {
            guard case .failure(let d) = Server.uncataloguedJob(obj(json)) else { XCTFail("accepted \(json.prefix(80))"); continue }
            XCTAssertTrue(d.message.hasPrefix("uncatalogued.\(what)"), d.message)
        }
        XCTAssertNoThrow(try Server.uncataloguedJob(obj(#"{"entries":[{"key":"k","locale":"en","text":"t","forms":[\#(many(Untranslated.caps.alternatives, form))]}]}"#)).get(), "the cap itself is allowed")
    }

    func testEngineRunsOnlyWhenAskedAndDropsRectsForAnotherAspect() {
        // Added by /ship coverage audit.
        // Value: protects=Engine gate (uncatalogued only in kinds) and spec 06 D7 rects drop with boxes-mismatch; fails_when=the field runs without the kind, or rects measured on another aspect still guard lines; why_new=no test calls Engine with an uncatalogued job; seam=none; no_claim=Vision reads and the serve parser (golden)
        var u = job(base.entries, rects: [CGRect(x: 0, y: 0, width: 1, height: 1)])
        let host = HostInfo(chip: "x", arch: "arm64", host_class: "x", macos: "27", vision_revision: 3)
        func run(_ kinds: Set<String>?, _ size: (Double, Double)) -> Envelope {
            u.rectsSize = size
            var j = Job(command: "untranslated")
            j.untranslated = UntranslatedJob(baseLocale: "en")
            j.untranslated?.kinds = kinds
            j.uncatalogued = u
            var env = Envelope(command: "untranslated", path: "a.png", verdict: "pass", engine: "e", locale: "en", image: ImageSize(width: 1170, height: 2532), host: host)
            Engine(languages: .success(["en-US"])).evaluate(j, lines: lines(["Account", "This text is hardcoded somewhere"]), locale: "en", guardScripts: false, env: &env)
            return env
        }
        XCTAssertEqual(run(["uncatalogued"], (390, 844)).findings.map(\.kind), [], "the rect covers the whole screen: guarded")
        let other = run(["uncatalogued"], (844, 390))
        XCTAssertEqual(other.findings.map { "\($0.kind):\($0.line)" }, ["uncatalogued:This text is hardcoded somewhere"])
        XCTAssertEqual(other.warnings.map(\.code), ["boxes-mismatch"])
        XCTAssertEqual(other.verdict, "fail")
        XCTAssertFalse(run(nil, (844, 390)).findings.contains { $0.kind == "uncatalogued" }, "default kinds leave it off")
        // D52 (review): a line another kind reports is skipped only when that kind is selected.
        let others = ["raw-key", "placeholder", "hardcoded", "untranslated", "wrong-language"].map { Finding(kind: $0, box: [0, 0, 1, 0.1], line: $0) }
        XCTAssertEqual(Uncatalogued.shadowing(others, kinds: ["raw-key", "uncatalogued"]).map(\.kind), ["raw-key", "placeholder", "hardcoded"])
        XCTAssertEqual(Uncatalogued.shadowing(others, kinds: ["wrong-language", "uncatalogued"]).map(\.kind), ["raw-key", "placeholder", "hardcoded", "wrong-language"])
        XCTAssertEqual(Uncatalogued.shadowing(others, kinds: nil).count, 5)
    }
}
