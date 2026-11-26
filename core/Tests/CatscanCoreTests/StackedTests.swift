// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-067 rule on synthetic reads: the corrected (production) read against the read without language correction.
final class StackedTests: XCTestCase {
    func line(_ t: String, _ y: Double, x: Double = 0.25, w: Double = 0.5, h: Double = 0.02, conf: Double = 1) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: w, height: h), confidence: conf)
    }

    /// The owner's screen (bench/stacked/positives.json): clean lines, a dropped title, a changed subtitle.
    var clean: [RecognizedLine] { [line("Stillleben mit Blumen", 0.13), line("Bonusbild freigeschaltet", 0.83), line("Abzeichen ansehen", 0.88)] }

    /// The correction tests run with every word known, so only the correction branches can fire.
    func run(_ c: [RecognizedLine], _ u: [RecognizedLine], locale: String = "de", allow: [String] = [],
             lookup: @escaping StackedDictionary.Lookup = { _, _ in .known }) -> [Finding] {
        Stacked.evaluate(corrected: c, uncorrected: u, locale: locale, allow: allow, lookup: lookup)
    }

    /// D31 fake: the listed words are unknown, `Квадрат` has no dictionary, the rest are known.
    let fake: StackedDictionary.Lookup = { _, w in
        ["Notleißigladiagen", "refachig", "Bil", "ppettues", "sriorahd", "güeslen", "bittsim"].contains(w) ? .unknown : w == "Квадрат" ? .unchecked : .known
    }

    func testDictionaryRule() {
        // Value: protects=D31 line rule (2 unknown, at least half, digits dropped, short and all-caps skips, unchecked words do not count); fails_when=a threshold or skip moves; why_new=new signal; seam=lookup; no_claim=the system dictionaries (testSystemLookup)
        func f(_ t: String) -> Bool { StackedDictionary.fires(t, locale: "en", lookup: fake) }
        XCTAssertTrue(f("45ppettues sriorahd dy")) // digits dropped, `dy` under 3 letters
        XCTAssertTrue(f("4 Bil Bilde refachig Tag")) // 2 of 4, at half
        XCTAssertFalse(f("Bil Bilde refachig Tag Abend")) // 2 of 5
        XCTAssertFalse(f("Notleißigladiagen")) // one unknown word is not enough (D31: the long-word rule failed)
        XCTAssertFalse(f("Notleißigladiagen Квадрат")) // an unchecked word is neither known nor unknown
        XCTAssertTrue(f("Bir güeslen, bittsim!")) // edge punctuation stripped
        XCTAssertFalse(f("BIL sriorahd")) // all caps of at most 4 letters skipped
    }

    func testDictionaryFindings() {
        // Value: protects=D31 findings (a = the uncorrected twin else the line, corrected = production text, merge with correction evidence, allow by the line or its shown twin, height filter); fails_when=the evidence, a or corrected change or a filter drops; why_new=new signal; seam=lookup; no_claim=Vision reads (bench/stacked-real.js)
        let c = clean + [line("Bir güeslen bittsim", 0.80)]
        let f = run(c, clean, lookup: fake)
        XCTAssertEqual(f.map(\.stackedEvidence), [["dictionary"]])
        XCTAssertEqual(f[0].a?.text, "Bir güeslen bittsim")
        XCTAssertEqual(f[0].corrected, "Bir güeslen bittsim")
        let twin = run(c, clean + [line("Bir gueslen bittslm", 0.80, conf: 0.5)], lookup: fake)
        XCTAssertEqual(twin[0].a?.text, "Bir gueslen bittslm")
        XCTAssertEqual(twin[0].a?.confidence, 0.5)
        // The render hint shows `a` (the twin) and says to add that line to --allow, so allowing the shown read keeps it quiet.
        XCTAssertTrue(run(c, clean + [line("Bir gueslen bittslm", 0.80, conf: 0.5)], allow: ["Bir gueslen bittslm"], lookup: fake).isEmpty)
        let both = run(c, clean + [line("Bir guesIen bxttsim", 0.80, conf: 0.3)], lookup: fake)
        XCTAssertEqual(both.map(\.stackedEvidence), [["correction-changed", "dictionary"]])
        XCTAssertTrue(run(c, clean, allow: ["Bir güeslen bittsim"], lookup: fake).isEmpty)
        XCTAssertTrue(run(clean + [line("Bir güeslen bittsim", 0.80, h: 0.015)], clean, lookup: fake).isEmpty) // 0.75 of the median height
    }

    func testAllowedElementKeepsItsStackQuiet() {
        // Value: protects=D33, D35 (an --allow entry naming a text or graphic element by id or text also drops a stacked finding mostly inside its box; panels, containers and much larger neighbours never widen it); fails_when=the id or text match or the 80% rule breaks; why_new=stacked runs with boxes by default; seam=none; no_claim=the element reader's own allow (OverlapTests)
        let f = run(clean, clean + [line("Estn2AhAckunck", 0.77, conf: 0.3)])
        func el(_ id: String?, _ text: String?, _ r: CGRect) -> TruncationJob.Element {
            TruncationJob.Element(id: id, rect: r, text: text, clips: false, offscreen: false)
        }
        let around = CGRect(x: 0.2, y: 0.75, width: 0.6, height: 0.05), elsewhere = CGRect(x: 0.2, y: 0.1, width: 0.6, height: 0.05)
        XCTAssertTrue(Stacked.dropAllowed(f, elements: [el("title", "Willkommen", around)], allow: ["title"], locale: "de").isEmpty)
        XCTAssertTrue(Stacked.dropAllowed(f, elements: [el(nil, "Willkommen", around)], allow: ["willkommen"], locale: "de").isEmpty)
        XCTAssertEqual(Stacked.dropAllowed(f, elements: [el("title", "Willkommen", elsewhere)], allow: ["title"], locale: "de").count, 1)
        XCTAssertEqual(Stacked.dropAllowed(f, elements: [el("title", "Willkommen", around)], allow: ["other"], locale: "de").count, 1)
        // One side of a stacked pair: its box joined with the element it is drawn over covers the stack.
        let top = CGRect(x: 0.3, y: 0.76, width: 0.3, height: 0.03), wide = CGRect(x: 0.2, y: 0.765, width: 0.6, height: 0.03)
        XCTAssertTrue(Stacked.dropAllowed(f, elements: [el("a", "Willkommen", top), el("b", "Hallo", wide)], allow: ["a"], locale: "de").isEmpty)
        // A textless full-screen root or a panel never widens the region (D34): the stack outside the badge stays.
        let badge = CGRect(x: 0.1, y: 0.1, width: 0.1, height: 0.03), screen = CGRect(x: 0, y: 0, width: 1, height: 1)
        var kb = el("keyboard", "Tastatur", screen); kb.panel = true
        XCTAssertEqual(Stacked.dropAllowed(f, elements: [el("badge", "Neu", badge), el("root", nil, screen), kb], allow: ["badge"], locale: "de").count, 1)
        // D35: a panel or container is never the anchor, and a full-screen image never widens a small badge.
        XCTAssertEqual(Stacked.dropAllowed(f, elements: [kb], allow: ["keyboard"], locale: "de").count, 1)
        XCTAssertEqual(Stacked.dropAllowed(f, elements: [el("root", nil, screen)], allow: ["root"], locale: "de").count, 1)
        var bg = el("bg", nil, screen); bg.graphic = true
        XCTAssertEqual(Stacked.dropAllowed(f, elements: [el("badge", "Neu", CGRect(x: 0.3, y: 0.76, width: 0.1, height: 0.03)), bg], allow: ["badge"], locale: "de").count, 1)
    }

    func testSystemLookup() {
        // Value: protects=D31 lookup on the macOS dictionaries (run language plus en, own-script only, near-miss slips known, no checked with nb); fails_when=a dictionary, the nb fallback or the fold changes; why_new=new signal; seam=none; no_claim=dictionary contents beyond these words
        // TODO-089 D5: each line asks AppleSpell once and, on a mismatch, prints that lookup's answers; its guesses
        // change from run to run (docs/gotchas/tests.md), and testSlipRule pins the rule on fixed answers.
        func expect(_ l: String, _ w: String, _ want: StackedDictionary.Word, line: UInt = #line) {
            let (got, trace) = StackedDictionary.explain(l, w)
            XCTAssertEqual(got, want, "AppleSpell answered: \(trace)", line: line)
        }
        XCTAssertEqual(StackedDictionary.system("en", "sriorahd"), .unknown) // the cached production path
        expect("de", "Bonusbild", .known)
        expect("fr", "speciale", .known) // accent slip of spéciale
        expect("tr", "Oğünlerini", .known) // Öğünlerini read without its dots
        expect("no", "skjermbilde", .known) // the no locale has only an nb dictionary
        expect("de", "Подтвердить", .unchecked) // no de dictionary checks Cyrillic
        expect("ru", "рардень", .unknown)
        expect("ja", "sriorahd", .unknown) // no ja dictionary: Latin words still go to English (D35)
        expect("ja", "設定", .unchecked) // and its own script goes nowhere
        expect("en", "colours", .known) // English counts in every installed region (en_GB)
        expect("ms", "Tetapan", .unchecked) // no ms dictionary: English alone would call every word unknown
        expect("pt", "Configurações", .known) // pt resolves to a pt_ region dictionary
        XCTAssertEqual(StackedDictionary.dictionary(for: "pt", in: ["pt_BR", "pt_PT"]), "pt_BR")
        XCTAssertEqual(StackedDictionary.dictionary(for: "ars", in: ["ar", "en"]), "ar") // Najdi Arabic reads with ar
        expect("ja-JP", "sriorahd", .unknown) // a region keeps its script's rule, as ja
        XCTAssertTrue(StackedDictionary.isNonLatin("zh-Hans-CN"))
        XCTAssertFalse(StackedDictionary.isNonLatin("de-DE"))
    }

    func testSlipRule() {
        // Value: protects=D31 slip rule (a guess equal up to dots, accents or case is known) on fixed answers; fails_when=fold or the guess branch changes; why_new=AppleSpell's guesses vary run to run (TODO-089 D5); seam=Speller; no_claim=AppleSpell's answers (testSystemLookup)
        func speller(_ guesses: [String], correction: String? = nil) -> StackedDictionary.Speller {
            .init(languages: { ["tr", "en"] }, misspelled: { _, _ in true }, correction: { _, _ in correction }, guesses: { _, _ in guesses })
        }
        let rule = { (g: [String], c: String?) in StackedDictionary.rule("tr", "Oğünlerini", have: ["tr", "en"], speller: speller(g, correction: c)) }
        XCTAssertEqual(rule(["Günlerini", "Öğünlerini"], nil), .known)
        XCTAssertEqual(rule([], "Öğünlerini"), .known)
        XCTAssertEqual(rule(["Günlerini", "Öğütlerini"], nil), .unknown)
        XCTAssertEqual(rule([], nil), .unknown) // the answer AppleSpell gave once under load: no guesses
        var trace: [String] = []
        _ = StackedDictionary.rule("tr", "Oğünlerini", have: ["tr", "en"], speller: speller([])) { trace.append($0) }
        XCTAssertEqual(trace, ["tr misspelled", "en misspelled", "tr correction none, guesses []", "en correction none, guesses []"])
    }

    func testDroppedAndChangedReadsAreStacked() {
        // Value: protects=TODO-067 correction rule on the owner's screen's reads; fails_when=a branch is removed or the confidence bar moves; why_new=new; seam=none; no_claim=Vision's reads (test/overlap.test.js, bench)
        let c = clean + [line("EiD Bild asteS Bilder", 0.80)]
        let u = clean + [line("Estn2AhAckunck", 0.77, conf: 0.3), line("EiDBildasteSBiWer", 0.80, conf: 0.3)]
        let f = run(c, u)
        XCTAssertEqual(f.map(\.signal), ["stacked", "stacked"])
        XCTAssertEqual(f.map(\.stackedEvidence), [["correction-dropped"], ["correction-changed"]])
        XCTAssertEqual(f.map(\.corrected), [nil, "EiD Bild asteS Bilder"])
        XCTAssertEqual(f[0].a?.text, "Estn2AhAckunck")
        XCTAssertEqual(f[0].a?.confidence, 0.3)
        XCTAssertNil(f[0].b)
        XCTAssertNil(f[0].overlap)
        XCTAssertEqual(f[0].kind, "overlap")
    }

    func testCleanReadsAndConfidentReadsPass() {
        // Value: protects=no finding without a low-confidence uncorrected read; fails_when=the bar is dropped or inverted; why_new=new; seam=none; no_claim=none beyond protects
        XCTAssertTrue(run(clean, clean).isEmpty)
        XCTAssertTrue(run(clean, clean + [line("Estn2AhAckunck", 0.77, conf: 0.5)]).isEmpty) // 0.5 is above the bar
        XCTAssertEqual(run(clean, clean + [line("Estn2AhAckunck", 0.77, conf: 0.31)]).count, 1) // at the bar
    }

    func testFiltersOnLettersHeightAndScript() {
        // Value: protects=T0 filters (6 letters, 0.8 median height, readable script for a dropped line); fails_when=a filter is removed; why_new=new; seam=none; no_claim=the filter values (fitted in T0)
        XCTAssertTrue(run(clean, clean + [line("•0••0", 0.5, conf: 0.3)]).isEmpty) // under 6 letters
        XCTAssertTrue(run(clean, clean + [line("IIIIIll", 0.5, h: 0.015, conf: 0.3)]).isEmpty) // 0.75 of the median height
        XCTAssertEqual(run(clean, clean + [line("IIIIIll", 0.5, h: 0.016, conf: 0.3)]).count, 1) // 0.8 of it
        XCTAssertTrue(run(clean, clean + [line("СATYА вTСЛII", 0.5, conf: 0.3)], locale: "es").isEmpty) // Cyrillic in an es run
        XCTAssertEqual(run(clean, clean + [line("СATYА вTСЛII", 0.5, conf: 0.3)], locale: "ru").count, 1)
    }

    func testChangedReadNeedsAnInteriorChange() {
        // Value: protects=icons read as a first letter are not stacks (T0: V Profil / / Profil); fails_when=any text change fires; why_new=new; seam=none; no_claim=none beyond protects
        let c = clean + [line("/ Objetivo pessoal", 0.5)]
        XCTAssertTrue(run(c, clean + [line("V Objetivo pessoal", 0.5, conf: 0.3)]).isEmpty)
        XCTAssertTrue(run(c, clean + [line("/ Objetivo pessoal", 0.5, conf: 0.3)]).isEmpty) // same text
        XCTAssertEqual(run(c, clean + [line("/ Objctvo pessoal", 0.5, conf: 0.3)]).count, 1)
        XCTAssertEqual(Stacked.interiorChange("Dominoacertanten", "Dovmmoacertanten"), 3)
        XCTAssertEqual(Stacked.interiorChange("V Profil", "/ Profil"), 0)
    }

    func testMixedRegionAndEmptyCorrectedRead() {
        // Value: protects=a region found by both branches lists both and keeps the corrected read; the height filter holds when correction dropped every line; fails_when=the merge drops the changed read or the box union, or the median falls to 0; why_new=testAllowMergeAndOtherReaders merges two dropped reads only; seam=none; no_claim=Vision reads
        let c = clean + [line("EiD Bild asteS Bilder", 0.785)]
        let f = run(c, clean + [line("Estn2AhAckunck", 0.77, conf: 0.3), line("EiDBildasteSBiWer", 0.785, conf: 0.3)])
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f[0].stackedEvidence, ["correction-dropped", "correction-changed"])
        XCTAssertEqual(f[0].corrected, "EiD Bild asteS Bilder")
        XCTAssertEqual(f[0].box?[1] ?? 0, 0.77, accuracy: 1e-4)
        XCTAssertEqual(f[0].box?[3] ?? 0, 0.035, accuracy: 1e-4)
        let none = run([], [line("Estn2AhAckunck", 0.77, conf: 0.3), line("IIIIIll", 0.5, h: 0.01, conf: 0.3)])
        XCTAssertEqual(none.map(\.line), ["Estn2AhAckunck"]) // the half-height glyph run stays filtered
    }

    func testAllowMergeAndOtherReaders() {
        // Value: protects=--allow by either read, one finding per region, no duplicate of a boxes finding; fails_when=allow, merge or the 80% inside rule breaks; why_new=new; seam=none; no_claim=none beyond protects
        let c = clean + [line("EiD Bild asteS Bilder", 0.80)]
        let u = clean + [line("EiDBildasteSBiWer", 0.80, conf: 0.3)]
        XCTAssertTrue(run(c, u, allow: ["eid bild astes bilder"]).isEmpty)
        XCTAssertTrue(run(c, u, allow: ["EiDBildasteSBiWer"]).isEmpty)
        XCTAssertTrue(run(c, u, allow: ["EiD  Bild asteS Bilder…"]).isEmpty) // the element reader's normalization
        let two = run(clean, clean + [line("Estn2AhAckunck", 0.77, conf: 0.3), line("Estnz2AhAckunk", 0.785, conf: 0.3)])
        XCTAssertEqual(two.count, 1)
        let s = run(clean, clean + [line("Estn2AhAckunck", 0.77, conf: 0.3)])
        var other = Finding(kind: "overlap", box: [0.2, 0.76, 0.6, 0.04], line: "a / b")
        other.signal = "boxes"
        XCTAssertEqual(Stacked.merge([other], s).map(\.signal), ["boxes"])
        other.box = [0.2, 0.1, 0.6, 0.04]
        XCTAssertEqual(Stacked.merge([other], s).map(\.signal), ["boxes", "stacked"])
    }

    func testEncodingAndServeField() throws {
        // Value: protects=JSON shape (b, overlap null; stacked_evidence, corrected) and overlap.stacked validation; fails_when=a field is dropped or a non-boolean is accepted; why_new=new; seam=none; no_claim=the Node schema (packages/core-js/test)
        let f = run(clean, clean + [line("Estn2AhAckunck", 0.77, conf: 0.3)])[0]
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(f)) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["kind", "box", "line", "a", "b", "overlap", "signal", "stacked_evidence", "corrected"])
        XCTAssertTrue(json["b"] is NSNull)
        XCTAssertTrue(json["corrected"] is NSNull)
        func job(_ v: Any) -> OverlapJob? { try? Server.overlapJob(v).get() }
        XCTAssertEqual(job(["stacked": true])?.stacked, true)
        XCTAssertEqual(job([:])?.stacked, false)
        XCTAssertNil(job(["stacked": 1]))
        XCTAssertNil(job(["stacked": "true"]))
    }
}
