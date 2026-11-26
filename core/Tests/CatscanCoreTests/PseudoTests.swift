// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-039 T2: `pseudo-cut`, `hardcoded` and `pseudo-not-applied` on synthetic recognized lines (no Vision).
final class PseudoTests: XCTestCase {
    static let fillers = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

    func lines(_ texts: [String]) -> [RecognizedLine] {
        texts.enumerated().map { i, t in
            RecognizedLine(text: t, rect: CGRect(x: 0.1, y: 0.1 + Double(i) * 0.05, width: 0.5, height: 0.03), confidence: 0.9)
        }
    }

    func entry(_ key: String, _ text: String, _ frags: [String]? = nil, lead: Bool = false, trail: Bool = false) -> PseudoJob.Entry {
        .init(key: key, catalog: "en.json", text: text, forms: [.init(fragments: frags ?? [text], lead: lead, trail: trail)])
    }

    var catalog: [PseudoJob.Entry] {
        [
            entry("settings.title", "Settings"),
            entry("bonus.daily", "Daily reward"),
            entry("page.update", "Update your page settings"),
            entry("greeting", "Hello, {name}!", ["Hello,", "!"]),
            entry("about.long", "This is a long string that wraps over three lines on a phone"),
            entry("coffee", "Café au lait"),
        ]
    }

    func run(_ texts: [String], entries: [PseudoJob.Entry]? = nil, skip: Set<Int> = [], guards: DynamicText? = nil) -> Pseudo.Result {
        var job = PseudoJob(entries: entries ?? catalog, fillers: Self.fillers)
        if let guards { job.guards = guards }
        return Pseudo.evaluate(job, lines: lines(texts), locale: "en", skip: skip, cuts: true, hardcoded: true)
    }

    func cuts(_ r: Pseudo.Result) -> [String] { r.cuts.map { "\($0.finding.key!):\($0.finding.side!):\($0.finding.lost!)" } }
    func hard(_ r: Pseudo.Result) -> [String] { r.hardcoded.map { "\($0.finding.evidence!):\($0.finding.key ?? $0.finding.line)" } }

    // A clean pseudo screen: every string bracketed, accented and expanded, plus traits enough for D4.
    let clean = ["[Šéttíñgš öñé]", "[Dáílý réwárd öñé twö]", "[Hélló, Anna! öñé twö]"]

    func testFoldAndMarkers() {
        XCTAssertEqual(Pseudo.fold("Šéttíñgš", locale: "en"), "settings")
        XCTAssertEqual(Pseudo.markers("¡Šéttíñgš öñé]"), .init(open: true, close: true, inner: "Šéttíñgš öñé"))
        XCTAssertEqual(Pseudo.markers("[Géñéráí|]"), .init(open: true, close: true, inner: "Géñéráíl"), "final | before ] is l")
        XCTAssertEqual(Pseudo.markers("Hé|lo|"), .init(open: false, close: false, inner: "Hé|lo|"), "repairs only at the ends")
        XCTAssertEqual(Pseudo.markers("\u{202E}[Šéttíñgš]\u{202C}").inner, "Šéttíñgš", "bidi marks dropped before the markers")
    }

    func testFillerSplits() {
        let s = Pseudo.splits(["settings", "one", "two", "th"], fillers: Self.fillers)
        XCTAssertEqual(s.first, .init(content: "settings", fillers: 2, partial: true))
        XCTAssertTrue(s.contains(.init(content: "settings one two th", fillers: 0, partial: false)))
        XCTAssertFalse(Pseudo.splits(["level", "two"], fillers: Self.fillers).contains { $0.fillers > 0 }, "a run starts at the first filler")
    }

    func testCleanScreenHasNoFinding() {
        let r = run(clean)
        XCTAssertTrue(r.cuts.isEmpty && r.hardcoded.isEmpty && r.notApplied == nil)
    }

    func testCutAtTheEnd() {
        XCTAssertEqual(cuts(run(clean + ["[Šéttíñgš ö"])), ["settings.title:end:filler"], "stops inside the filler")
        XCTAssertEqual(cuts(run(clean + ["[Šéttíñgš"])), ["settings.title:end:filler"], "all filler lost")
        XCTAssertEqual(cuts(run(clean + ["[Dáílý réw"])), ["bonus.daily:end:text"], "base text cut")
        XCTAssertEqual(cuts(run(clean + ["[Dáílý réwárd öñé"])), [], "content and filler run complete: a ] misread")
        XCTAssertEqual(cuts(run(clean + ["[Šéttíñgš öñé"])), [], "complete at the 30% expansion")
    }

    func testCutAtTheStart() {
        XCTAssertEqual(cuts(run(clean + ["ílý réwárd öñé twö]"])), ["bonus.daily:start:text"])
        XCTAssertEqual(cuts(run(clean + ["Dáílý réwárd öñé twö]"])), [], "complete: the [ was not read")
    }

    func testWrappedAndJoinedLines() {
        XCTAssertTrue(run(clean + ["[Úpdáté ýöür págé", "šéttíñgš öñé twö]"]).cuts.isEmpty, "a wrapped string is no cut")
        let threeLines = ["[Thíš íš á löñg štríñg thát", "wrápš övér thréé líñéš", "öñ á phöñé öñé twö thréé]"]
        let w = run(clean + threeLines)
        XCTAssertTrue(w.cuts.isEmpty && w.hardcoded.isEmpty, "3-line wrap")
        let j = run(clean + ["[Úpdáté ýöür págé", "šéttí"])
        XCTAssertEqual(cuts(j), ["page.update:end:text"])
        XCTAssertEqual(j.cuts.first?.finding.line, "[Úpdáté ýöür págé šéttí", "reported on the joined lines")
    }

    /// TODO-051: the Android sample app's onboarding body wrapped over two lines, with the boxes `catscan read` gave on
    /// the API 36 emulator (D3) and the line ends Vision gave across runs (`_` seen in TODO-039 T3).
    func testWrappedStringWithMisreadClose() {
        let entries = catalog + [entry("onboarding.body", "Check every screen in every language."), entry("hello.name", "Hello, {name}", ["Hello,"], trail: true)]
        let job = PseudoJob(entries: entries, fillers: Self.fillers)
        func eval(_ two: [String], below: Double = 0, cuts: Bool = true, title: String? = nil) -> Pseudo.Result {
            // A closing title stacked right above makes the chain pass skip the paragraph (TODO-051 review).
            let head = title.map { [RecognizedLine(text: $0, rect: CGRect(x: 0.0543, y: 0.115, width: 0.4, height: 0.0247), confidence: 1)] } ?? []
            let para = head + [
                RecognizedLine(text: two[0], rect: CGRect(x: 0.0543, y: 0.1483, width: 0.8682, height: 0.0247), confidence: 1),
                RecognizedLine(text: two[1], rect: CGRect(x: 0.0542, y: 0.1816 + below, width: 0.199, height: 0.0206), confidence: 1),
            ]
            return Pseudo.evaluate(job, lines: lines(clean) + para, locale: "en", cuts: cuts, hardcoded: true)
        }
        let first = "[Çhéçk évérý šçrééñ ín évérý láñgüágé. öñé twö"
        for second in ["thréé foür_", "thréé foür", "thréé foürj", "thréé foür)", "thréé foür1", "thréé foür]"] {
            let r = eval([first, second])
            XCTAssertTrue(r.cuts.isEmpty && r.hardcoded.isEmpty && r.notApplied == nil, "complete with `\(second)`: no cut")
        }
        XCTAssertTrue(eval([first, "three four)"], cuts: false).hardcoded.isEmpty, "untranslated: an accent-dropped continuation is no hardcoded")
        let titled = eval([first, "thréé foür_"], title: "[Šéttíñgš öñé]")
        XCTAssertTrue(titled.cuts.isEmpty && titled.hardcoded.isEmpty, "a closing title stacked above the paragraph")
        for second in ["thréé fo_", "thréé foürx"] {
            XCTAssertEqual(cuts(eval([first, second])), ["onboarding.body:end:filler"], "filler cut: `\(second)`")
        }
        let short = eval(["[Çhéçk évérý šçrééñ íñ évérý láñgüágé. öñé", "twö_"])
        XCTAssertEqual(cuts(short), ["onboarding.body:end:filler"], "two filler words, three needed at 30%")
        XCTAssertEqual(short.cuts.first?.finding.line, "[Çhéçk évérý šçrééñ íñ évérý láñgüágé. öñé twö_", "reported on the joined lines")
        XCTAssertEqual(cuts(eval([first, "thréé foür"], below: 0.03)), ["onboarding.body:end:filler"], "a separate label below is no continuation")
        XCTAssertEqual(Pseudo.read(["[öñé twö)"], locale: "en", fillers: Self.fillers).words, ["one", "two"], "a misread `]` after a filler is dropped")
        XCTAssertEqual(Pseudo.read(["Step one1"], locale: "en", fillers: Self.fillers).words, ["step", "one1"], "no `[`: base text keeps its end")
        XCTAssertEqual(hard(run(clean + ["Step one)"])), ["none:Step one)"], "a hardcoded label ending in a filler and `)` stays hardcoded")
        XCTAssertEqual(Pseudo.read(["[ñíñé téñ öñéj"], locale: "en", fillers: Self.fillers).words, ["nine", "ten", "one"], "a run of 11+ fillers wraps to one")
        XCTAssertEqual(Pseudo.read(["[Stép 1"], locale: "en", fillers: Self.fillers).words, ["step", "1"], "a base `1` after no filler is kept")
        XCTAssertEqual(Pseudo.read(["[öñé twö1]"], locale: "en", fillers: Self.fillers).words, ["one", "two1"], "a closed read is not repaired")
        XCTAssertEqual(Pseudo.read(["[Héllö, one1"], locale: "en", fillers: Self.fillers).words, ["hello,", "one1"], "a placeholder value is no filler run")
        XCTAssertEqual(cuts(run(clean + ["[Héllö, one1"], entries: entries)), ["hello.name:end:filler"], "user name `one1`: the filler is still lost")
    }

    /// Traps measured on the T2 gate (bench/pseudo.js): Vision drops a marker or reads a clipped glyph as anything.
    func testMeasuredReadTraps() {
        XCTAssertEqual(cuts(run(clean + ["[Ñötífíçátíöñš öi"])), [], "complete content, filler partly read")
        XCTAssertEqual(cuts(run(clean + ["[Šéttíñgš öi"])), ["settings.title:end:filler"], "a clipped filler glyph read as i")
        XCTAssertEqual(cuts(run(clean + ["[Úpdáté ýöür págé šéttíñ["])), ["page.update:end:text"], "a clipped glyph read as an open bracket")
        XCTAssertEqual(cuts(run(clean + [": ílý réwárd öñé twö]"])), ["bonus.daily:start:text"], "a clipped first glyph read as :")
        XCTAssertEqual(cuts(run(clean + ["Úpdáté ýöür pá"])), ["page.update:end:text"], "the [ was not read; pseudo accents")
        XCTAssertEqual(hard(run(clean + ["Don 't allow"])), [], "system UI as Vision reads it")
        // A wrapped paragraph whose [ was dropped: tight line spacing makes it one string, not a start cut.
        let para = ["Thíš íš á löñg štríñg thát", "wrápš övér thréé líñéš", "öñ á phöñé öñé twö thréé]"].enumerated().map { i, t in
            RecognizedLine(text: t, rect: CGRect(x: 0.1, y: 0.6 + Double(i) * 0.03, width: 0.8, height: 0.025), confidence: 0.9)
        }
        let r = Pseudo.evaluate(PseudoJob(entries: catalog, fillers: Self.fillers), lines: lines(clean) + para, locale: "en", cuts: true, hardcoded: true)
        XCTAssertTrue(r.cuts.isEmpty && r.hardcoded.isEmpty)
    }

    func testWrappedMiddleLineIsNotHardcoded() {
        XCTAssertEqual(hard(run(clean + ["wraps over three lines"])), [], "D5: a strict fragment of a catalog string")
    }

    func testHardcoded() {
        XCTAssertEqual(hard(run(clean + ["Daily reward"])), ["base:bonus.daily"])
        let f = run(clean + ["Daily reward"]).hardcoded[0].finding
        XCTAssertEqual([f.catalog, f.expected], ["en.json", "Daily reward"])
        XCTAssertEqual(hard(run(clean + ["Limited offer today"])), ["none:Limited offer today"])
        XCTAssertEqual(hard(run(clean + ["Hello, Anna!"])), ["base:greeting"], "a filled placeholder still matches")
        XCTAssertEqual(hard(run(clean + ["Café au lait"])), ["base:coffee"], "an accent the base string has is no trait")
        XCTAssertEqual(hard(run(clean + ["Dáily reward"])), [], "an accent the base string lacks is a trait")
        XCTAssertEqual(hard(run(clean + ["Daily reward one two"])), [], "a filler run is a trait")
        XCTAssertEqual(hard(run(clean + ["Daily reward"], skip: [3])), [], "raw-key and placeholder win on the line")
    }

    func testDynamicGuardsAndSystemUI() throws {
        let g = try DynamicText(patterns: ["Hi, \\w+"], allow: ["Acme Cloud Pro"])
        let r = run(clean + ["$4.99 per month", "Hi, Anna", "Acme Cloud Pro", "Allow Once", "Don't Allow", "Allow “Shop” to use your location?", "Go"], guards: g)
        XCTAssertEqual(hard(r), [])
        let bar = Pseudo.evaluate(
            PseudoJob(entries: catalog, fillers: Self.fillers),
            lines: lines(clean) + [RecognizedLine(text: "Carrier Wi-Fi", rect: CGRect(x: 0.05, y: 0.005, width: 0.3, height: 0.02), confidence: 0.9)],
            locale: "en", cuts: true, hardcoded: true)
        XCTAssertEqual(hard(bar), [], "status-bar band")
    }

    func testPseudoNotApplied() {
        let r = run(["Settings", "Daily reward", "Limited offer today", "Privacy policy"])
        XCTAssertEqual(r.notApplied?.kind, "pseudo-not-applied")
        XCTAssertEqual(r.notApplied?.traits, 0)
        XCTAssertEqual(r.notApplied?.lines, 4)
        XCTAssertTrue(r.hardcoded.isEmpty, "D4: no hardcoded on a build that fell back to base")
        XCTAssertNil(run(["Settings", "Daily reward"]).notApplied, "fewer than 3 lines: judged by hardcoded alone")
        XCTAssertEqual(hard(run(["Settings", "Daily reward"])).count, 2)
        // 1 of 5 lines with a trait is 20%: applied.
        XCTAssertNil(run(["[Šéttíñgš öñé]", "Daily reward", "Limited offer today", "Privacy policy", "Terms of use"]).notApplied)
    }

    func testPseudoCatalogMatchesLikeTheBase() {
        let pseudo = [entry("settings.title", "[Šéttíñgš öñé]"), entry("bonus.daily", "[Dáílý réwárd öñé twö]")]
        XCTAssertEqual(cuts(run(clean + ["[Dáílý réw"], entries: pseudo)), ["bonus.daily:end:text"])
        XCTAssertEqual(hard(run(clean + ["Daily reward"], entries: pseudo)), ["base:bonus.daily"])
    }

    func testFindingShapes() throws {
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        let cut = run(clean + ["[Šéttíñgš ö"]).cuts[0].finding
        let c = try JSONSerialization.jsonObject(with: enc.encode(cut)) as! [String: Any]
        XCTAssertEqual(Set(c.keys), ["kind", "box", "line", "reason", "element", "expected", "confidence", "side", "lost", "key", "catalog"])
        let h = try JSONSerialization.jsonObject(with: enc.encode(run(clean + ["Limited offer today"]).hardcoded[0].finding)) as! [String: Any]
        XCTAssertEqual(Set(h.keys), ["kind", "box", "line", "evidence"])
        let n = try JSONSerialization.jsonObject(with: enc.encode(run(["Settings", "Daily reward", "Privacy policy"]).notApplied!)) as! [String: Any]
        XCTAssertEqual(Set(n.keys), ["kind", "box", "traits", "lines"])
    }

    func testServeFields() throws {
        let ok: [String: Any] = [
            "entries": [["key": "a", "catalog": "en.json", "text": "Hello, {name}!", "forms": [["fragments": ["Hello,", "!"], "lead": false, "trail": false]]]],
            "fillers": Self.fillers, "dynamic": ["Hi, \\w+"], "allow": ["Acme"],
        ]
        let j = try Server.pseudoJob(ok).get()
        XCTAssertEqual(j.entries.first?.forms.first?.fragments, ["Hello,", "!"])
        XCTAssertEqual(j.guards.patterns, ["Hi, \\w+"])
        func err(_ o: [String: Any]) -> String? { if case .failure(let d) = Server.pseudoJob(o) { return d.message }; return nil }
        XCTAssertEqual(err(["entries": [["key": "a"]]]), "pseudo.entries items need key, text and forms.")
        XCTAssertEqual(err(["dynamic": ["ok", "(unclosed"]]), "pseudo.dynamic[1] is not a valid ICU regex: (unclosed")
        XCTAssertEqual(err(["fillers": [1]]), "pseudo.fillers must be an array of strings.")
        func kinds(_ k: Any) -> String? {
            if case .failure(let d) = Server.untranslatedJob(["base_locale": "en", "kinds": k]) { return d.message }
            return nil
        }
        XCTAssertNil(kinds(["hardcoded", "raw-key"]))
        XCTAssertEqual(kinds(["wrong"]), "untranslated.kinds must be a non-empty array of untranslated, raw-key, placeholder, hardcoded, wrong-language, uncatalogued.")
        XCTAssertEqual(try Server.truncationJob(["pseudo": true]).get().pseudo, true)
    }

    func testOverflowFoldsPseudoReads() {
        // Added by /ship coverage audit.
        // Value: protects=truncated --pseudo overflow matches a pseudo read to its element (TODO-039 T2); fails_when=job.pseudo
        // stops reaching Truncation.overflow or the end repair is dropped; why_new=OverflowTests has no pseudo case;
        // seam=none; no_claim=real Vision reads (synthetic line)
        let W = 1000.0, H = 2000.0
        let line = RecognizedLine(text: "[Fréé tríá|]", rect: CGRect(x: 0.1, y: 0.1, width: 0.6, height: 0.02), confidence: 0.9)
        var j = TruncationJob()
        j.boxes = .init(width: W, height: H, elements: [.init(id: "cta", rect: CGRect(x: 0.08, y: 0.095, width: 0.5, height: 0.03), text: "[Fréé tríál]", clips: true, offscreen: false)])
        XCTAssertEqual(Truncation.evaluate(j, lines: [line], width: Int(W), height: Int(H), locale: "en").map(\.reason), [])
        j.pseudo = true
        XCTAssertEqual(Truncation.evaluate(j, lines: [line], width: Int(W), height: Int(H), locale: "en").map(\.reason), ["overflow"])
    }

    func testEngineMergeKeepsReadingOrder() {
        // Added by /ship coverage audit.
        // Value: protects=pseudo findings land in reading order and lines an existing finding covers are skipped; fails_when=
        // Engine.merge appends or Engine.reported misses a covered line; why_new=no test calls either; seam=none; no_claim=Vision boxes
        let ls = lines(["a", "b", "c"])
        let at = { (i: Int, k: String) -> Finding in Finding(kind: k, box: Geometry.box(ls[i].rect), line: ls[i].text) }
        XCTAssertEqual(Engine.reported([at(2, "raw-key")], ls), [2])
        XCTAssertEqual(Engine.reported([Finding(kind: "pseudo-not-applied", box: nil, line: "")], ls), [])
        let merged = Engine.merge([at(0, "raw-key"), at(2, "placeholder")], [(line: 1, finding: at(1, "hardcoded")), (line: 2, finding: at(2, "hardcoded"))], ls)
        XCTAssertEqual(merged.map { "\($0.kind):\($0.line)" }, ["raw-key:a", "hardcoded:b", "placeholder:c", "hardcoded:c"])
    }

    /// Review fix-check: dynamic rects for another screen aspect are dropped with boxes-mismatch, so they guard nothing.
    func testDynamicRectsForAnotherAspectAreDropped() throws {
        var p = PseudoJob(entries: catalog, fillers: Self.fillers)
        p.guards.rects = [CGRect(x: 0, y: 0, width: 1, height: 1)]
        var job = Job(command: "untranslated")
        job.untranslated = UntranslatedJob(baseLocale: "en")
        let host = HostInfo(chip: "x", arch: "arm64", host_class: "x", macos: "27", vision_revision: 3)
        func run(_ size: (Double, Double)) -> Envelope {
            p.rectsSize = size
            job.pseudo = p
            var env = Envelope(command: "untranslated", path: "a.png", verdict: "pass", engine: "e", locale: "en", image: ImageSize(width: 1170, height: 2532), host: host)
            Engine(languages: .success(["en-US"])).evaluate(job, lines: lines(clean + ["Daily reward"]), locale: "en", guardScripts: false, env: &env)
            return env
        }
        let same = run((390, 844))
        XCTAssertEqual(same.findings.map(\.kind), [], "the rect covers the whole screen: guarded")
        let other = run((844, 390))
        XCTAssertEqual(other.findings.map(\.kind), ["hardcoded"])
        XCTAssertEqual(other.warnings.map(\.code), ["boxes-mismatch"])
    }

    /// Review fix-check: templates are folded per locale (ja drops spaces), not once for the first locale.
    func testPreparedTemplatesPerLocale() {
        let job = PseudoJob(entries: catalog, fillers: Self.fillers)
        let en = Pseudo.evaluate(job, lines: lines(clean + ["Daily reward"]), locale: "en", cuts: false, hardcoded: true)
        let ja = Pseudo.evaluate(job, lines: lines(clean + ["Daily reward"]), locale: "ja", cuts: false, hardcoded: true)
        XCTAssertEqual(hard(en), ["base:bonus.daily"])
        XCTAssertEqual(hard(ja), ["base:bonus.daily"], "a ja read folds without spaces and needs ja templates")
    }

    func testCheckPlain() {
        XCTAssertEqual(Pseudo.plain("[Šéttíñgš öñé]", locale: "en"), "settings one")
    }
}
