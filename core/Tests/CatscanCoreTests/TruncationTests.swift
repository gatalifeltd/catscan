// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// Spec 06 "Rule" and D3-D8, D15-D20: the core's half of `truncated`, on synthetic recognized lines.
final class TruncationTests: XCTestCase {
    typealias El = TruncationJob.Element

    func line(_ t: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double = 0.02) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: w, height: h), confidence: 0.93)
    }

    func run(
        _ lines: [RecognizedLine], elements: [El]? = nil, prefixes: [TruncationJob.Prefix] = [], reasons: [String]? = nil,
        allow: [String] = [], locale: String = "de", size: (Int, Int) = (1000, 2000)
    ) -> [Finding] {
        var j = TruncationJob()
        if let elements { j.boxes = .init(width: Double(size.0), height: Double(size.1), elements: elements) }
        j.prefixes = prefixes
        if let reasons { j.reasons = Set(reasons) }
        j.allow = allow
        return Truncation.evaluate(j, lines: lines, width: size.0, height: size.1, locale: locale)
    }

    func reasons(_ f: [Finding]) -> [String] { f.map { "\($0.reason!):\($0.line)" } }

    // TODO-099 item 2: wrapped rows that spell only the start of a placeholder paragraph, cut on the last row.
    func testCatalogPrefixAcrossWrappedRows() {
        let hint: [TruncationJob.Prefix] = [.init(
            text: "Первые города (их {free}) \u{2014} без штрафа; дальше за каждые {step} сверх того в каждом городе прибавляется один недовольный житель. Помогает храм.",
            alternatives: [["Первые города (их", ") \u{2014} без штрафа; дальше за каждые",
                            "сверх того в каждом городе прибавляется один недовольный житель. Помогает храм."]])]
        func rows(_ t: [String]) -> [RecognizedLine] {
            t.enumerated().map { line($0.element, 0.0644, 0.5 + 0.025 * Double($0.offset), 0.55) }
        }
        let head = ["Первые города (их 4) - без", "штрафа; дальше за каждые 3", "сверх того в каждом городе"]
        let ok = { (t: [String]) in XCTAssertEqual(self.run(rows(t), prefixes: hint, locale: "ru"), [], "\(t)") }
        // A lone misread symbol after a space, and a cut mid-word.
        XCTAssertEqual(reasons(run(rows(head + ["прибавляется один недовольный ›"]), prefixes: hint, locale: "ru")),
                       ["prefix:прибавляется один недовольный ›"])
        let cut = run(rows(head + ["прибавляется один недовольный ж"]), prefixes: hint, locale: "ru")
        XCTAssertEqual(reasons(cut), ["prefix:прибавляется один недовольный ж"])
        XCTAssertEqual(cut.first?.expected, hint[0].text)
        // Shown whole; a word boundary with nothing misread; a chain that leaves the string after its head.
        ok(head + ["прибавляется один недовольный житель.", "Помогает храм."])
        ok(head + ["прибавляется один недовольный"])
        ok(["Первые города (их 4) - без", "налогов в первый год жизни"])
        // A hyphen at the break, joined without it.
        XCTAssertEqual(reasons(run(rows(["Первые города (их 4) - без штра-", "фа; дальше за ка"]), prefixes: hint, locale: "ru")),
                       ["prefix:фа; дальше за ка"])
        // D6: a first row that is also a cut of the head alone is reported once, on the chain's last row.
        XCTAssertEqual(reasons(run(rows(["Первые города", "(их 4) - без штр"]), prefixes: hint, locale: "ru")),
                       ["prefix:(их 4) - без штр"])
        // D2: a string that starts with a placeholder is never matched by the chain.
        let lead: [TruncationJob.Prefix] = [.init(text: "{n} Städte ohne Strafe danach", alternatives: [["Städte ohne Strafe danach"]])]
        XCTAssertEqual(run(rows(["4 Städte ohne", "Strafe da"]), prefixes: lead), [])
        // Value: protects=D2, a chain never starts on a string whose text opens with a placeholder; fails_when=the
        // first-fragment guard in chainCuts is dropped; why_new=the case above has one fragment, so the >=2 filter
        // hides it; seam=none; no_claim=real OCR rows (synthetic lines; unit only)
        let lead2: [TruncationJob.Prefix] = [.init(text: "{n} Städte ohne {m} Strafe danach",
                                                   alternatives: [["Städte ohne", "Strafe danach"]])]
        XCTAssertEqual(run(rows(["Städte ohne 5", "Strafe da"]), prefixes: lead2), [])
        // Value: protects=D8, unspaced locales get no chain finding; fails_when=the isUnspaced guard in chainCuts is
        // dropped; why_new=no test ran the chain under ja/ko/zh/th; seam=none; no_claim=real Vision rows (synthetic
        // lines; unit only)
        let ja: [TruncationJob.Prefix] = [.init(text: "設定を変更すると{n}件の項目が削除されます",
                                                alternatives: [["設定を変更すると", "件の項目が削除されます"]])]
        XCTAssertEqual(run(rows(["設定を変更すると3", "件の項目が削"]), prefixes: ja, locale: "ja"), [])
        // Value: protects=D3, a chain still matching at the 8-row cap is not a cut; fails_when=the cap stops the walk
        // without marking the chain continued; why_new=no chain above reaches 8 rows; seam=none; no_claim=chains longer
        // than 9 rows (synthetic lines; unit only)
        let long: [TruncationJob.Prefix] = [.init(text: "Start {n} aa bb cc dd ee ff gg hh",
                                                  alternatives: [["Start", "aa bb cc dd ee ff gg hh"]])]
        XCTAssertEqual(run(rows(["Start 4", "aa", "bb", "cc", "dd", "ee", "ff", "g-", "g hh"]), prefixes: long, locale: "ru"), [])
    }

    // TODO-099 item 1: a soft hyphen, ZWNJ or ZWJ in a catalog string is not drawn, so the rows that show it match.
    func testCatalogInvisibleCharacters() {
        let top = line("IN DEN", 0.40, 0.802, 0.2), bottom = line("GEGENVERKEHR", 0.35, 0.827, 0.3)
        for mark in ["\u{00AD}", "\u{200C}", "\u{200D}"] {
            let sign: [TruncationJob.Prefix] = [.init(text: "IN DEN GEGEN\(mark)VERKEHR", alternatives: [["IN DEN GEGEN\(mark)VERKEHR"]]),
                                                .init(text: "GEGEN\(mark)VERKEHRSSCHILD", alternatives: [["GEGEN\(mark)VERKEHRSSCHILD"]])]
            XCTAssertEqual(run([top, bottom], prefixes: sign), [], mark.debugDescription)
            // A cut row of it still flags.
            XCTAssertEqual(reasons(run([line("IN DEN GEGEN", 0.3, 0.5, 0.4)], prefixes: sign)), ["prefix:IN DEN GEGEN"], mark.debugDescription)
        }
    }

    func testEllipsisAtTheEndBothForms() {
        let f = run([line("Einstellun...", 0.1, 0.1, 0.3), line("Fortsetz…", 0.1, 0.2, 0.3), line("Weiter", 0.1, 0.3, 0.2)])
        XCTAssertEqual(reasons(f), ["ellipsis:Einstellun...", "ellipsis:Fortsetz…"])
        XCTAssertNil(f[0].element)
        XCTAssertEqual(f[0].confidence, 0.93)
    }

    func testEllipsisAtTheStartOnlyRightToLeft() {
        XCTAssertEqual(reasons(run([line("…إعدادات", 0.5, 0.1, 0.3)], locale: "ar")), ["ellipsis:…إعدادات"])
        XCTAssertEqual(reasons(run([line("...הגדרות", 0.5, 0.1, 0.3)], locale: "he")), ["ellipsis:...הגדרות"])
        XCTAssertEqual(reasons(run([line("...Einstellungen", 0.1, 0.1, 0.3)])), [])
    }

    func testIntendedEllipsisIsNotTruncated() {
        // D4: the element's own text or a catalog string ends in the same ellipsis.
        let share = line("Teilen…", 0.1, 0.1, 0.2)
        XCTAssertEqual(run([share], elements: [El(id: "share", rect: CGRect(x: 0.05, y: 0.09, width: 0.5, height: 0.04), text: "Teilen…")]), [])
        XCTAssertEqual(run([share], prefixes: [.init(text: "Teilen…", alternatives: [["Teilen…"]])]), [])
        XCTAssertEqual(reasons(run([share], prefixes: [.init(text: "Teilen", alternatives: [["Teilen"]])])), ["ellipsis:Teilen…"])
    }

    func testAssignmentPicksTheSmallestElementHoldingEightyPercent() {
        let l = line("Einstellungen", 0.10, 0.10, 0.30)
        let outer = El(id: "cell", rect: CGRect(x: 0, y: 0.05, width: 1, height: 0.2))
        let inner = El(id: "title", rect: CGRect(x: 0.05, y: 0.09, width: 0.35, height: 0.04))
        XCTAssertEqual(Truncation.assign(l.rect, [outer, inner]), 1)
        // Under 80% inside: not this element.
        let half = El(id: "half", rect: CGRect(x: 0.25, y: 0.05, width: 0.5, height: 0.2))
        XCTAssertNil(Truncation.assign(l.rect, [half]))
    }

    /// An element whose trailing edge sits `gap` original pixels past the line's end; the line starts 40 px inside it.
    func edgeCase(
        gap: Double, size: (Int, Int), rtl: Bool = false, clips: Bool = true, offscreen: Bool = false,
        read: String = "Einstellun", text: String? = nil, locale: String = "de"
    ) -> [Finding] {
        let W = Double(size.0), H = Double(size.1)
        let lh = 40 / H // 40 px line height: the edge distance is 6 px
        let l = rtl ? line("إعدادات", (300 + 0) / W, 0.1, 300 / W, lh) : line(read, 200 / W, 0.1, 300 / W, lh)
        let rect = rtl
            ? CGRect(x: (300 - gap) / W, y: 0.1 - 2 / H, width: (300 + gap + 40) / W, height: lh + 4 / H)
            : CGRect(x: 160 / W, y: 0.1 - 2 / H, width: (340 + gap) / W, height: lh + 4 / H)
        return run([l], elements: [El(id: "e", rect: rect, text: text, clips: clips, offscreen: offscreen)], locale: rtl ? "ar" : locale, size: size)
    }

    func testEdgeDistanceIsAFractionOfTheLineHeightAtEveryScale() {
        // 0.15 x 40 px = 6 px, whatever the screenshot size (1x, 2x, 3x).
        for size in [(400, 800), (800, 1600), (1200, 2400)] {
            XCTAssertEqual(edgeCase(gap: 5.5, size: size).map(\.reason), ["edge"], "\(size)")
            XCTAssertEqual(edgeCase(gap: -3, size: size).map(\.reason), ["edge"], "past the edge, \(size)")
            XCTAssertEqual(edgeCase(gap: 6.6, size: size), [], "\(size)")
        }
        let f = edgeCase(gap: 2, size: (1000, 2000))
        XCTAssertEqual(f[0].element?.id, "e")
        XCTAssertEqual(f[0].expected, nil)
    }

    func testEdgeIsTheLeftEdgeRightToLeft() {
        XCTAssertEqual(edgeCase(gap: 3, size: (1000, 2000), rtl: true).map(\.reason), ["edge"])
        XCTAssertEqual(edgeCase(gap: 30, size: (1000, 2000), rtl: true), [])
    }

    func testEdgeSkipsNonClippingAndOffscreenElements() {
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), clips: false), [])
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), offscreen: true), [])
    }

    func testEdgeSkipsAFrameThatHugsTheLine() {
        // D15: leading and trailing both within the edge distance (accessibility frames).
        let l = line("Weiter", 0.2, 0.1, 0.2, 0.02)
        let hug = El(id: "b", rect: CGRect(x: 0.2005, y: 0.099, width: 0.199, height: 0.022))
        XCTAssertEqual(run([l], elements: [hug]), [])
    }

    func testEdgeSkipsElementsWithTwoRows() {
        // D3, D26: a wrapped paragraph's first row ends near the edge by chance.
        let p = El(id: "p", rect: CGRect(x: 0.1, y: 0.1, width: 0.5, height: 0.06))
        let rows = [line("Ein langer Absatz der", 0.12, 0.105, 0.479), line("umbricht", 0.12, 0.13, 0.2)]
        XCTAssertEqual(run(rows, elements: [p]), [])
        XCTAssertEqual(Truncation.rows(rows.map(\.rect)), 2)
        XCTAssertEqual(Truncation.rows([rows[0].rect, CGRect(x: 0.4, y: 0.106, width: 0.1, height: 0.02)]), 1)
    }

    func testFullTextPrefixOnTheElementsJoinedLines() {
        let el = El(id: "t", rect: CGRect(x: 0.05, y: 0.09, width: 0.6, height: 0.04), text: "Einstellungen")
        let f = run([line("Einstellun", 0.1, 0.1, 0.3)], elements: [el])
        XCTAssertEqual(reasons(f), ["prefix:Einstellun"])
        XCTAssertEqual(f[0].expected, "Einstellungen")
        // Equal text, and trailing punctuation OCR dropped, are not prefixes (D5).
        XCTAssertEqual(run([line("Einstellungen", 0.1, 0.1, 0.3)], elements: [el]), [])
        let done = El(id: "d", rect: el.rect, text: "Fertig!")
        XCTAssertEqual(run([line("Fertig", 0.1, 0.1, 0.3)], elements: [done]), [])
        // A wrapped full string: both lines joined equal the text.
        let wrap = El(id: "w", rect: CGRect(x: 0.05, y: 0.09, width: 0.6, height: 0.08), text: "Mit E-Mail fortfahren")
        XCTAssertEqual(run([line("Mit E-Mail", 0.1, 0.1, 0.3), line("fortfahren", 0.1, 0.13, 0.3)], elements: [wrap]), [])
        // Cut on the second row: reported once, on the last line.
        let cut = run([line("Mit E-Mail", 0.1, 0.1, 0.3), line("fortfa", 0.1, 0.13, 0.2)], elements: [wrap])
        XCTAssertEqual(reasons(cut), ["prefix:fortfa"])
    }

    // TODO-019, D37, D42, D52: rows of the normalization table as the rules see them.
    func testNormalizedTextBeforeEveryPrefixMatch() {
        let rect = CGRect(x: 0.05, y: 0.09, width: 0.6, height: 0.04)
        let row = El(id: "r", rect: rect, text: "Settings  >")
        XCTAssertEqual(run([line("Settings ›", 0.1, 0.1, 0.3)], elements: [row]), [])
        XCTAssertEqual(reasons(run([line("Sett", 0.1, 0.1, 0.1)], elements: [row])), ["prefix:Sett"])
        let back = El(id: "b", rect: rect, text: "Back")
        XCTAssertEqual(run([line("‹ Back", 0.1, 0.1, 0.3)], elements: [back]), [])
        let he = El(id: "h", rect: rect, text: "\u{200F}הגדרות\u{200F}")
        XCTAssertEqual(run([line("הגדרות", 0.1, 0.1, 0.3)], elements: [he], locale: "he"), [])
        let cat: [TruncationJob.Prefix] = [.init(text: "Continuer »", alternatives: [["Continuer »"]])]
        XCTAssertEqual(run([line("Continuer", 0.1, 0.1, 0.2)], prefixes: cat, locale: "fr"), [])
        XCTAssertEqual(reasons(run([line("Contin", 0.1, 0.1, 0.2)], prefixes: cat, locale: "fr")), ["prefix:Contin"])
        // D52: an extended label is not a cut; a cut inside it still is.
        let cta = El(id: "c", rect: rect, text: "Mit E-Mail fortfahren, Taste")
        XCTAssertEqual(run([line("Mit E-Mail fortfahren", 0.1, 0.1, 0.3)], elements: [cta]), [])
        XCTAssertEqual(reasons(run([line("Mit E-Mail fort", 0.1, 0.1, 0.3)], elements: [cta])), ["prefix:Mit E-Mail fort"])
        // D52 in unspaced scripts: ko drops the space, ja joins with "、".
        let ko = El(id: "k", rect: rect, text: "네, 일부를 더해요")
        XCTAssertEqual(run([line("네", 0.1, 0.1, 0.1)], elements: [ko], locale: "ko"), [])
        // D62: the rest of a wrapped message on a line outside the element is on screen; missing, it is a cut.
        let msg = El(id: "m", rect: CGRect(x: 0.05, y: 0.09, width: 0.6, height: 0.04), text: "Benachrichtigungen können in den Einstellungen konfiguriert werden.")
        let top = line("Benachrichtigungen können in den", 0.1, 0.1, 0.5)
        XCTAssertEqual(run([top, line("Einstellungen konfiguriert werden.", 0.1, 0.13, 0.5)], elements: [msg]), [])
        XCTAssertEqual(reasons(run([top, line("Etwas anderes hier", 0.1, 0.13, 0.5)], elements: [msg])), ["prefix:Benachrichtigungen können in den"])
        // D63: a short line is not a prefix finding.
        let pct = El(id: "p", rect: rect, text: "69 Prozent Rabatt")
        XCTAssertEqual(run([line("69%", 0.1, 0.1, 0.1)], elements: [pct]), [])
        // D37: an element with text and no recognized line yields nothing.
        XCTAssertEqual(run([], elements: [cta]), [])
    }

    func testEllipsisVariantsAndATrailingChevron() {
        XCTAssertEqual(reasons(run([line("设置⋯", 0.1, 0.1, 0.2)], locale: "zh-Hans")), ["ellipsis:设置⋯"])
        XCTAssertEqual(reasons(run([line("設定‥", 0.1, 0.1, 0.2)], locale: "ja")), ["ellipsis:設定‥"])
        XCTAssertEqual(reasons(run([line("Einstellun… ›", 0.1, 0.1, 0.2)])), ["ellipsis:Einstellun… ›"])
        XCTAssertEqual(reasons(run([line("\u{200F}…הגדרות", 0.5, 0.1, 0.3)], locale: "he")), ["ellipsis:\u{200F}…הגדרות"])
        // D61: dots alone are page dots or a menu button.
        XCTAssertEqual(run([line(".... →", 0.1, 0.1, 0.1), line("⋯", 0.5, 0.1, 0.05)]), [])
    }

    func testCatalogPrefixBoundsAndSkips() {
        let cat: [TruncationJob.Prefix] = [
            .init(text: "Continue", alternatives: [["Continue"]]), .init(text: "Settings", alternatives: [["Settings"]]),
            .init(text: "Settings and privacy", alternatives: [["Settings and privacy"]]),
        ]
        XCTAssertEqual(reasons(run([line("Contin", 0.1, 0.1, 0.2)], prefixes: cat, locale: "en")), ["prefix:Contin"])
        XCTAssertEqual(run([line("Contin", 0.1, 0.1, 0.2)], prefixes: cat, locale: "en")[0].expected, "Continue")
        // Over 85% of the string, under 4 characters, or itself a catalog string: not flagged.
        XCTAssertEqual(run([line("Continu", 0.1, 0.1, 0.2)], prefixes: cat, locale: "en"), [])
        XCTAssertEqual(run([line("Con", 0.1, 0.1, 0.2)], prefixes: cat, locale: "en"), [])
        XCTAssertEqual(run([line("Settings", 0.1, 0.1, 0.2)], prefixes: cat, locale: "en"), [])
        // The full string is on screen elsewhere: the short line is something else.
        XCTAssertEqual(run([line("Contin", 0.1, 0.1, 0.2), line("Continue", 0.1, 0.3, 0.2)], prefixes: cat, locale: "en"), [])
    }

    // TODO-095: a catalog string wrapped onto the rows below is whole; a cut on any row of the wrap still flags.
    func testCatalogPrefixWrappedOntoRowsBelow() {
        let sign: [TruncationJob.Prefix] = [.init(text: "NICHT BETRETEN", alternatives: [["NICHT BETRETEN"]])]
        let top = line("NICHT", 0.40, 0.146, 0.27, 0.03)
        XCTAssertEqual(run([top, line("BETRETEN", 0.35, 0.180, 0.40, 0.028)], prefixes: sign, locale: "de"), [])
        // Wider second row starting left of the first, and a hyphen at the break.
        let marke: [TruncationJob.Prefix] = [.init(text: "Marke Eigenbau", alternatives: [["Marke Eigenbau"]])]
        XCTAssertEqual(run([line("MARKE", 0.41, 0.677, 0.17, 0.019), line("EIGENBAU", 0.39, 0.699, 0.23, 0.017)],
                           prefixes: marke, locale: "de"), [])
        let trafo: [TruncationJob.Prefix] = [.init(text: "Trafohäuschen", alternatives: [["Trafohäuschen"]])]
        XCTAssertEqual(run([line("TRAFOHÄUS -", 0.38, 0.561, 0.24, 0.016), line("CHEN", 0.45, 0.581, 0.1, 0.015)],
                           prefixes: trafo, locale: "de"), [])
        // Three rows with a short middle row; the last row cut still flags.
        let door: [TruncationJob.Prefix] = [.init(text: "Bitte nicht die Tür öffnen", alternatives: [["Bitte nicht die Tür öffnen"]])]
        let b1 = line("Bitte nicht", 0.3, 0.30, 0.3), b2 = line("die Tür", 0.35, 0.325, 0.2)
        XCTAssertEqual(run([b1, b2, line("öffnen", 0.35, 0.35, 0.2)], prefixes: door, locale: "de"), [])
        XCTAssertEqual(reasons(run([b1, b2, line("öff", 0.35, 0.35, 0.1)], prefixes: door, locale: "de")), ["prefix:Bitte nicht"])
        // A placeholder string: the rows below reach its first fragment and the value follows.
        let ph: [TruncationJob.Prefix] = [.init(text: "Willkommen zurück, {name}", alternatives: [["Willkommen zurück,"]])]
        XCTAssertEqual(run([line("Willkommen", 0.3, 0.3, 0.3), line("zurück, Anna", 0.3, 0.325, 0.3)], prefixes: ph), [])

        // Cyrillic: the catalog text is normalized with look-alike letters folded; the rows must be too.
        let ru: [TruncationJob.Prefix] = [.init(text: "Классика жанра", alternatives: [["Классика жанра"]])]
        XCTAssertEqual(run([line("КЛАССИКА", 0.072, 0.570, 0.227, 0.016), line("ЖАНРА", 0.111, 0.590, 0.147, 0.017)],
                           prefixes: ru, locale: "ru"), [])

        // D7: a middle row of one wrapped string is no cut of another that starts like it.
        let cards: [TruncationJob.Prefix] = [.init(text: "Le transfo est vexé", alternatives: [["Le transfo est vexé"]]),
                                             .init(text: "Transfo qui tremble", alternatives: [["Transfo qui tremble"]])]
        let le = line("LE", 0.475, 0.558, 0.057, 0.017), transfo = line("TRANSFO", 0.401, 0.580, 0.202, 0.017)
        XCTAssertEqual(run([le, transfo, line("EST VEXé", 0.388, 0.599, 0.227, 0.019)], prefixes: cards, locale: "fr"), [])
        XCTAssertEqual(reasons(run([le, transfo, line("EST", 0.45, 0.599, 0.1, 0.019)], prefixes: cards, locale: "fr")), ["prefix:TRANSFO"])
        // D7: a line that is a placeholder string's text with its value unread ("SCHICHT" of "Schicht {n}") is that string.
        let shift: [TruncationJob.Prefix] = [.init(text: "Schicht {n}", alternatives: [["Schicht"]]),
                                             .init(text: "Schichtbonus", alternatives: [["Schichtbonus"]])]
        XCTAssertEqual(run([line("SCHICHT", 0.12, 0.318, 0.6, 0.05)], prefixes: shift, locale: "de"), [])
        XCTAssertEqual(reasons(run([line("SCHICHTB", 0.12, 0.318, 0.6, 0.05)], prefixes: shift, locale: "de")), ["prefix:SCHICHTB"])

        // Only rows below count: the rest overlapping across but above the line, or on its row, does not.
        for other in [line("BETRETEN", 0.40, 0.11, 0.3, 0.028), line("BETRETEN", 0.45, 0.150, 0.3, 0.028)] {
            XCTAssertEqual(reasons(run([top, other], prefixes: sign, locale: "de")), ["prefix:NICHT"], "\(other.rect)")
        }
        // A row with no letters (a dash) is skipped and does not join the wrap.
        XCTAssertEqual(reasons(run([top, line("-", 0.5, 0.178, 0.05, 0.028), line("BETRETEN", 0.35, 0.23, 0.40, 0.028)],
                                   prefixes: sign, locale: "de")), ["prefix:NICHT"])
        // At most 4 rows under the first: five rows clear, six still report the first.
        let words = ["Eins", "Zwei", "Drei", "Vier", "Fünf", "Sechs"]
        let rows = words.enumerated().map { line($0.element, 0.3, 0.1 + 0.025 * Double($0.offset), 0.3) }
        let five: [TruncationJob.Prefix] = [.init(text: words.prefix(5).joined(separator: " "), alternatives: [[words.prefix(5).joined(separator: " ")]])]
        let six: [TruncationJob.Prefix] = [.init(text: words.joined(separator: " "), alternatives: [[words.joined(separator: " ")]])]
        XCTAssertEqual(run(Array(rows.prefix(5)), prefixes: five, locale: "de"), [])
        XCTAssertEqual(reasons(run(rows, prefixes: six, locale: "de")), ["prefix:Eins"])
        // An open fragment under 4 characters never clears a line; a head both whole and open keeps the open match;
        // a hyphen at the break inside an open string still reaches its fragment.
        let short: [TruncationJob.Prefix] = [.init(text: "Go {x}", alternatives: [["Go"]]), .init(text: "Go homepage", alternatives: [["Go homepage"]])]
        XCTAssertEqual(reasons(run([line("GO HOME", 0.3, 0.3, 0.3)], prefixes: short)), ["prefix:GO HOME"])
        let both: [TruncationJob.Prefix] = [.init(text: "Willkommen zurück, {name}", alternatives: [["Willkommen zurück,"]]),
                                            .init(text: "Willkommen zurück", alternatives: [["Willkommen zurück"]])]
        XCTAssertEqual(run([line("Willkommen", 0.3, 0.3, 0.3), line("zurück, Anna", 0.3, 0.325, 0.3)], prefixes: both), [])
        // A long first row of a placeholder string (over 85% of its fragment) is still that string's row.
        let trafoNLong: [TruncationJob.Prefix] = [.init(text: "Trafohäuschen {n}", alternatives: [["Trafohäuschen"]]),
                                                  .init(text: "Trafohäuschenbau", alternatives: [["Trafohäuschenbau"]])]
        XCTAssertEqual(run([line("TRAFOHÄUSCHE -", 0.38, 0.561, 0.26, 0.016), line("N 3", 0.45, 0.581, 0.08, 0.015)],
                           prefixes: trafoNLong, locale: "de"), [])
        // Two rows below both complete the string: the middle row of either chain is that string, in both orders.
        let mid: [TruncationJob.Prefix] = [.init(text: "Nicht hier parken", alternatives: [["Nicht hier parken"]]),
                                           .init(text: "Hier ist frei", alternatives: [["Hier ist frei"]])]
        let n1 = line("NICHT", 0.4, 0.1, 0.2), hA = line("HIER", 0.4, 0.125, 0.2), hB = line("HIER", 0.42, 0.126, 0.2)
        let p1 = line("PARKEN", 0.4, 0.15, 0.2)
        XCTAssertEqual(run([n1, hA, hB, p1], prefixes: mid, locale: "de"), [])
        XCTAssertEqual(run([n1, hB, hA, p1], prefixes: mid, locale: "de"), [])
        // 200 stacked repeated rows under a string they never complete: the search stays polynomial (an
        // unmemoized walk tries about 50^4 chains per seed and does not finish). No time bound: a hang fails the run.
        let stack = (0..<200).map { line("ab", 0.3, 0.1 + 0.001 * Double($0), 0.1) }
        let near: [TruncationJob.Prefix] = [.init(text: "ababababab x", alternatives: [["ababababab x"]])]
        XCTAssertEqual(run(stack, prefixes: near), [])
        // A value-reached placeholder string never hides a cut of another string: "Delete account" may be
        // "Delete {n}" with a value, but it is also the start of "Delete account permanently", so it is reported.
        let del: [TruncationJob.Prefix] = [.init(text: "Delete {n}", alternatives: [["Delete"]]),
                                           .init(text: "Delete account permanently", alternatives: [["Delete account permanently"]])]
        XCTAssertEqual(reasons(run([line("Delete account", 0.1, 0.1, 0.3)], prefixes: del)), ["prefix:Delete account"])
        // A continuation is the next row down: a tight list never joins a cut row to a row past the one under it
        // ("Account" + "settings" over "details" would hide a cut of "Account recovery").
        let acct: [TruncationJob.Prefix] = [.init(text: "Account settings", alternatives: [["Account settings"]]),
                                            .init(text: "Account recovery", alternatives: [["Account recovery"]])]
        XCTAssertEqual(reasons(run([line("Account", 0.1, 0.1, 0.3), line("details", 0.1, 0.121, 0.3),
                                    line("settings", 0.1, 0.142, 0.3)], prefixes: acct)), ["prefix:Account"])
        // The same list with boxes that touch: a middle row whose box reaches into the next one still sits between.
        XCTAssertEqual(reasons(run([line("Account", 0.1, 0.1, 0.3), line("details", 0.1, 0.119, 0.3),
                                    line("settings", 0.1, 0.138, 0.3)], prefixes: acct)), ["prefix:Account"])
        let trafoN: [TruncationJob.Prefix] = [.init(text: "Trafohäuschen {n}", alternatives: [["Trafohäuschen"]]),
                                              .init(text: "Trafohäuschenbau", alternatives: [["Trafohäuschenbau"]])]
        XCTAssertEqual(run([line("TRAFOHÄUS -", 0.38, 0.561, 0.24, 0.016), line("CHEN 3", 0.42, 0.581, 0.15, 0.015)],
                           prefixes: trafoN, locale: "de"), [])

        // Still a cut: nothing below; too far down; same row; another column; a cut row; a row that only starts like it.
        XCTAssertEqual(reasons(run([top], prefixes: sign, locale: "de")), ["prefix:NICHT"])
        for other in [line("BETRETEN", 0.35, 0.30, 0.40, 0.028), line("BETRETEN", 0.70, 0.146, 0.25, 0.03),
                      line("BETRETEN", 0.75, 0.180, 0.2, 0.028), line("BETRE", 0.35, 0.180, 0.25, 0.028),
                      line("BETRETEN VERBOTEN", 0.35, 0.180, 0.5, 0.028)] {
            XCTAssertEqual(reasons(run([top, other], prefixes: sign, locale: "de")), ["prefix:NICHT"], other.text)
        }
        // Several candidates: any completed one clears the line; none completed reports the first.
        let two: [TruncationJob.Prefix] = sign + [.init(text: "NICHT RAUCHEN", alternatives: [["NICHT RAUCHEN"]])]
        XCTAssertEqual(run([top, line("RAUCHEN", 0.38, 0.180, 0.3, 0.028)], prefixes: two, locale: "de"), [])
        XCTAssertEqual(reasons(run([top, line("RAUCHE", 0.38, 0.180, 0.3, 0.028)], prefixes: two, locale: "de")), ["prefix:NICHT"])
        // Two qualifying rows below, one completing: clear in either input order.
        let good = line("BETRETEN", 0.35, 0.180, 0.40, 0.028), bad = line("BETR", 0.40, 0.182, 0.2, 0.028)
        XCTAssertEqual(run([top, bad, good], prefixes: sign, locale: "de"), [])
        XCTAssertEqual(run([top, good, bad], prefixes: sign, locale: "de"), [])
    }

    func testCatalogPrefixWithoutSpacesAndPlaceholders() {
        let ja: [TruncationJob.Prefix] = [.init(text: "アカウント設定を変更", alternatives: [["アカウント設定を変更"]])]
        XCTAssertEqual(reasons(run([line("アカウント設", 0.1, 0.1, 0.2)], prefixes: ja, locale: "ja")), ["prefix:アカウント設"])
        // A placeholder string matches on its first fragment.
        let ph: [TruncationJob.Prefix] = [.init(text: "Willkommen zurück, {name}", alternatives: [["Willkommen zurück,"]])]
        XCTAssertEqual(reasons(run([line("Willkommen zu", 0.1, 0.1, 0.2)], prefixes: ph)), ["prefix:Willkommen zu"])
    }

    func testCatalogPrefixSkipsLinesWithElementText() {
        let el = El(id: "t", rect: CGRect(x: 0.05, y: 0.09, width: 0.6, height: 0.04), text: "Contin")
        let cat: [TruncationJob.Prefix] = [.init(text: "Continue", alternatives: [["Continue"]])]
        XCTAssertEqual(run([line("Contin", 0.1, 0.1, 0.2)], elements: [el], prefixes: cat, locale: "en"), [])
    }

    func testScreenEdgeWithoutBoxesAndForUnassignedLines() {
        XCTAssertEqual(reasons(run([line("Einstellun", 0.7, 0.1, 0.299)])), ["screen-edge:Einstellun"])
        XCTAssertEqual(run([line("Einstellungen", 0.6, 0.1, 0.3)]), [])
        XCTAssertEqual(reasons(run([line("إعدادا", 0.0005, 0.1, 0.3)], locale: "ar")), ["screen-edge:إعدادا"])
        // A box Vision pads past the image edge is reported inside it.
        XCTAssertEqual(run([line("Einstellun", -0.004, 0.1, 0.3)], locale: "ar")[0].box, [0, 0.1, 0.296, 0.02])
        // A box wholly outside the image is dropped, not encoded as an infinite null rect.
        XCTAssertEqual(run([line("Einstellun...", 1.2, 0.1, 0.3)]), [])
        // Box mode: an assigned line never gets screen-edge; an unassigned one does.
        let el = El(id: "e", rect: CGRect(x: 0.65, y: 0.09, width: 0.35, height: 0.04), clips: false)
        XCTAssertEqual(run([line("Einstellun", 0.7, 0.1, 0.299)], elements: [el]), [])
        XCTAssertEqual(reasons(run([line("Einstellun", 0.7, 0.1, 0.299)], elements: [])), ["screen-edge:Einstellun"])
    }

    func testOneFindingPerLineInReasonOrderAndReasonsFilterFirst() {
        let el = El(id: "t", rect: CGRect(x: 0.05, y: 0.09, width: 0.35, height: 0.04), text: "Einstellungen")
        let l = line("Einstellun...", 0.1, 0.1, 0.3)
        XCTAssertEqual(reasons(run([l], elements: [el])), ["ellipsis:Einstellun..."])
        XCTAssertEqual(reasons(run([l], elements: [el], reasons: ["edge", "prefix"])), ["prefix:Einstellun..."])
        XCTAssertEqual(reasons(run([l], elements: [el], reasons: ["edge"])), ["edge:Einstellun..."])
        XCTAssertEqual(run([l], elements: [el], reasons: ["screen-edge"]), [])
    }

    func testAllowListedLinesAreNeverFindings() {
        XCTAssertEqual(run([line("Loading...", 0.1, 0.1, 0.3)], allow: ["Loading..."]), [])
    }

    func testMismatchOnlyAboveOnePercentAspect() {
        let b = TruncationJob.Boxes(width: 390, height: 844, elements: [])
        XCTAssertNil(Truncation.mismatch(b, width: 1170, height: 2532)) // 3x
        let d = Truncation.mismatch(b, width: 2532, height: 1170)
        XCTAssertEqual(d?.code, "boxes-mismatch")
        XCTAssertEqual(d?.message, "the screenshot is 2532x1170 but its boxes are for 390x844 (aspect differs by 79%)")
    }

    func testFindingEncodesEveryTruncatedField() throws {
        var f = Finding(kind: "truncated", box: [0.1, 0.1, 0.3, 0.02], line: "Weit")
        f.reason = "screen-edge"
        f.confidence = 0.9
        let o = try JSONSerialization.jsonObject(with: JSONLine.encode(f)) as! [String: Any]
        XCTAssertEqual(Set(o.keys), ["kind", "box", "line", "reason", "element", "expected", "confidence"])
        XCTAssertTrue(o["element"] is NSNull)
        XCTAssertTrue(o["expected"] is NSNull)
    }

    func testServeFieldValidationNamesTheField() {
        func err(_ v: Any) -> String? {
            if case .failure(let d) = Server.truncationJob(v) { return d.message }
            return nil
        }
        XCTAssertEqual(err(["reasons": ["edg"]]), "truncated.reasons must be a non-empty array of ellipsis, prefix, edge, overflow, screen-edge, pseudo-cut.")
        // An empty list would turn every rule off and pass every screen.
        XCTAssertEqual(err(["reasons": [String]()]), "truncated.reasons must be a non-empty array of ellipsis, prefix, edge, overflow, screen-edge, pseudo-cut.")
        XCTAssertEqual(err(["edge_distance": -1]), "truncated.edge_distance must be a number, 0 or more.")
        XCTAssertEqual(err(["allow": [1]]), "truncated.allow must be an array of strings.")
        XCTAssertEqual(err(["prefixes": [["text": "a"]]]), "truncated.prefixes items must be {text, alternatives: [[string]]}.")
        XCTAssertEqual(err(["boxes": ["elements": []]]), "truncated.boxes.image must be {width, height} above 0.")
        let img: [String: Any] = ["width": 10, "height": 20]
        XCTAssertEqual(err(["boxes": ["image": ["width": true, "height": 20], "elements": []]]), "truncated.boxes.image must be {width, height} above 0.")
        XCTAssertEqual(
            err(["boxes": ["image": img, "elements": [["box": [0, 0, true, 1]]]]]),
            "truncated.boxes.elements[0].box must be 4 numbers in 0..1 with width and height above 0.")
        XCTAssertEqual(
            err(["boxes": ["image": img, "elements": [["box": [0, 0, 0, 1]]]]]),
            "truncated.boxes.elements[0].box must be 4 numbers in 0..1 with width and height above 0.")
        XCTAssertEqual(
            err(["boxes": ["image": img, "elements": [["box": [0, 0, 1, 1], "clips": "yes"]]]]),
            "truncated.boxes.elements[0].clips must be true or false.")
        // Every reason the Node layer accepts is accepted here (packages/core-js/src/truncated.js REASONS).
        for r in Truncation.reasons { XCTAssertNil(err(["reasons": [r]]), r) }
        guard case .success(let ok) = Server.truncationJob(["boxes": ["image": img, "elements": [["box": [0, 0, 1, 1]]]]]) else {
            return XCTFail("valid field rejected")
        }
        XCTAssertEqual(ok.boxes?.elements.first?.clips, true) // D7 default
    }

    // Precision on real screens (D65-D70): each false-positive cause from the owner's checked gate set, with a twin
    // that still flags.

    func testALoneNumberVisionDidNotReadIsNotAPrefix() {
        // D65: game-1 "SHIFT 6" reads "SHIFT" with room after it; the same line at the edge of its box still flags.
        let room = El(id: "t", rect: CGRect(x: 0.2, y: 0.3, width: 0.6, height: 0.05), text: "SHIFT 6", clips: false)
        XCTAssertEqual(run([line("SHIFT", 0.2, 0.305, 0.44, 0.04)], elements: [room]), [])
        let tight = El(id: "t", rect: CGRect(x: 0.2, y: 0.3, width: 0.442, height: 0.05), text: "SHIFT 6", clips: false)
        XCTAssertEqual(reasons(run([line("SHIFT", 0.2, 0.305, 0.44, 0.04)], elements: [tight])), ["prefix:SHIFT"])
        // A missing word is still a cut, room or not.
        let done = El(id: "t", rect: room.rect, text: "SHIFT DONE", clips: false)
        XCTAssertEqual(reasons(run([line("SHIFT", 0.2, 0.305, 0.44, 0.04)], elements: [done])), ["prefix:SHIFT"])
        // Only on a one-row element: a wrapped message's last row ends short of the edge by nature.
        let code = El(id: "c", rect: CGRect(x: 0.2, y: 0.3, width: 0.6, height: 0.1), text: "Your code expires in 10", clips: false)
        XCTAssertEqual(reasons(run([line("Your code", 0.2, 0.305, 0.3, 0.04), line("expires in", 0.2, 0.35, 0.3, 0.04)], elements: [code])),
                       ["prefix:expires in"])
    }

    func testAChevronIsNotText() {
        // D66: a back chevron read as "<" or "^" at its hugging frame's edge; and a lone ">" at the screen edge.
        let back = El(id: "b", rect: CGRect(x: 0.1, y: 0.104, width: 0.035, height: 0.043), text: "‹")
        XCTAssertEqual(run([line("<", 0.107, 0.121, 0.025, 0.016)], elements: [back], locale: "pl"), [])
        XCTAssertEqual(run([line("^", 0.107, 0.121, 0.025, 0.016)], elements: [back], locale: "ko"), [])
        XCTAssertEqual(run([line(">", 0.97, 0.1, 0.0299)]), [])
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000)).map(\.reason), ["edge"])
    }

    func testAMergedRowIsNotAnEdgeFinding() {
        // D67: Vision merged an icon, a label and a value into one line that ends at the row's edge.
        let row = El(id: "row", rect: CGRect(x: 0.07, y: 0.436, width: 0.801, height: 0.082))
        let label = El(id: nil, rect: CGRect(x: 0.199, y: 0.463, width: 0.478, height: 0.028), text: "Περπάτημα, 45 λεπ.")
        let value = El(id: "kcal", rect: CGRect(x: 0.707, y: 0.463, width: 0.164, height: 0.028), text: "+80 kcal")
        let merged = line("at Περπάτημα, 45 λεπ. +80 kcal", 0.129, 0.463, 0.74, 0.029)
        XCTAssertEqual(run([merged], elements: [row, label, value], locale: "el"), [])
        // One element with text under the line: not a merge, the row's edge still counts.
        let quiet = El(id: nil, rect: label.rect)
        XCTAssertEqual(run([merged], elements: [row, quiet, value], locale: "el").map(\.reason), ["edge"])
        // D80: an offscreen element is not a second view; a value drawn inside its label's box still is (an app icon
        // with its badge on the Android gate set).
        let away = El(id: "kcal", rect: value.rect, text: "+80 kcal", offscreen: true)
        XCTAssertEqual(run([merged], elements: [row, label, away], locale: "el").map(\.reason), ["edge"])
        let wide = El(id: nil, rect: CGRect(x: 0.129, y: 0.463, width: 0.74, height: 0.029), text: "Περπάτημα, 45 λεπ.")
        XCTAssertEqual(run([merged], elements: [row, wide, value], locale: "el"), [])
    }

    func testALinePastTheElementEdgeIsNotClippedByIt() {
        // D68: 40 px line height; 16 px (0.4) past the edge shows glyphs the element does not hide, 4 px (0.1) is padding.
        XCTAssertEqual(edgeCase(gap: -16, size: (1000, 2000)), [])
        XCTAssertEqual(edgeCase(gap: -4, size: (1000, 2000)).map(\.reason), ["edge"])
    }

    func testTheEdgeRuleNeedsTheElementsOwnText() {
        // D69: a chip under another view's text, and a hero whose text is a spoken label.
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "Piano", text: "Unità di altezza", locale: "it"), [])
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "69% DTO.", text: "69 por ciento de descuento", locale: "es"), [])
        // The element's own text, with a garbled last glyph or a misread leading diacritic, still flags.
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "Einstellur", text: "Einstellungen").map(\.reason), ["edge"])
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "Internet bağla", text: "İnternet bağlantısı yok", locale: "tr").map(\.reason), ["edge"])
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "장바=", text: "장바구니", locale: "ko").map(\.reason), ["edge"])
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "删除巾", text: "删除帐户", locale: "zh-Hans").map(\.reason), ["edge"])
        // D78: the whole text read at a tight frame's edge (an Android status-bar clock, a stage title) is intact.
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "16:59", text: "16:59", locale: "es"), [])
        XCTAssertEqual(edgeCase(gap: 2, size: (1000, 2000), read: "Gagne des offres", text: "Gagne des offres", locale: "fr"), [])
    }

    func testARestThatStartsAnotherRowIsNotAPrefix() {
        // D70: the rest "(konfigurowane ..." starts a row outside the frame; the "(" no longer hides the match.
        let alert = El(id: nil, rect: CGRect(x: 0.177, y: 0.475, width: 0.647, height: 0.066),
                       text: "Powiadomieniami mogą być alerty, dźwięki i plakietki na ikonach (konfigurowane w Ustawieniach).")
        let rows = [line("Powiadomieniami mogą być alerty,", 0.177, 0.478, 0.587), line("dźwięki i plakietki na ikonach", 0.176, 0.501, 0.489, 0.022)]
        XCTAssertEqual(run(rows + [line("(konfigurowane w Ustawieniach).", 0.173, 0.545, 0.568, 0.019)], elements: [alert], locale: "pl"), [])
        XCTAssertEqual(reasons(run(rows + [line("(coś innego tutaj).", 0.173, 0.545, 0.4, 0.019)], elements: [alert], locale: "pl")),
                       ["prefix:dźwięki i plakietki na ikonach"])
        // A price whose "(3 dni)" row goes to a smaller element across the screen.
        let price = El(id: "rung-offer-line", rect: CGRect(x: 0.06, y: 0.654, width: 0.881, height: 0.064), text: "29,99 USD/rok po darmowym okresie (3 dni)")
        let strip = El(id: nil, rect: CGRect(x: 0, y: 0.69, width: 1, height: 0.034), text: "0%")
        let head = line("29,99 USD/rok po darmowym okresie", 0.073, 0.661, 0.855, 0.029)
        XCTAssertEqual(run([head, line("(3 dni)", 0.423, 0.693, 0.155, 0.023)], elements: [price, strip], locale: "pl"), [])
        XCTAssertEqual(reasons(run([head], elements: [price, strip], locale: "pl")), ["prefix:29,99 USD/rok po darmowym okresie"])
        // D79: a rest under 4 characters on its own row outside the frame; a row that only starts with it is not enough.
        let joke = El(id: "t", rect: CGRect(x: 0.103, y: 0.224, width: 0.747, height: 0.048), text: "Stopped on green. The guy behind did not.", clips: false)
        let first = line("Stopped on green. The guy behind did", 0.101, 0.224, 0.754, 0.023)
        XCTAssertEqual(run([first, line("not.", 0.101, 0.262, 0.083, 0.02)], elements: [joke], locale: "en"), [])
        // The same short row far from the element, or a short word elsewhere on screen, does not count.
        XCTAssertEqual(reasons(run([first, line("not.", 0.101, 0.9, 0.083, 0.02)], elements: [joke], locale: "en")),
                       ["prefix:Stopped on green. The guy behind did"])
        let del = El(id: "d", rect: CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.05), text: "Delete all", clips: false)
        XCTAssertEqual(reasons(run([line("Delete", 0.1, 0.205, 0.2, 0.04), line("All", 0.7, 0.9, 0.05, 0.02)], elements: [del], locale: "en")),
                       ["prefix:Delete"])
        // Generated by /ship coverage audit.
        // Value: protects=D79/D80 the short-rest row must overlap the element across, not just sit within 1.5 line heights
        // under it; fails_when=the horizontal overlap check in the `below` filter is dropped; why_new=existing rows
        // vary only the vertical distance; seam=none; no_claim=real Vision rows (synthetic lines)
        XCTAssertEqual(reasons(run([line("Delete", 0.1, 0.205, 0.2, 0.04), line("All", 0.7, 0.26, 0.05, 0.02)], elements: [del], locale: "en")),
                       ["prefix:Delete"])
        XCTAssertEqual(reasons(run([first, line("nothing else", 0.101, 0.262, 0.3, 0.02)], elements: [joke], locale: "en")),
                       ["prefix:Stopped on green. The guy behind did"])
    }

    func testAMergedRowNeedsTwoDifferentTextsInsideTheLine() {
        // D67: the edgeCase geometry (40 px line ending 2 px before its clipping element's edge) with more elements.
        let l = line("Einstellur", 0.2, 0.1, 0.3)
        let e = El(id: "e", rect: CGRect(x: 0.16, y: 0.099, width: 0.342, height: 0.022), text: "Einstellungen")
        XCTAssertEqual(run([l], elements: [e]).map(\.reason), ["edge"])
        // A second element with the same text over the line (a cell and its label) is one text, not a merge.
        let twin = El(id: "label", rect: e.rect, text: "Einstellungen")
        XCTAssertEqual(run([l], elements: [e, twin]).map(\.reason), ["edge"])
        // An element with other text that is not at least half inside the line does not make it a merged row.
        let far = El(id: "cancel", rect: CGRect(x: 0.1, y: 0.8, width: 0.3, height: 0.02), text: "Abbrechen")
        let wide = El(id: "screen", rect: CGRect(x: 0, y: 0, width: 1, height: 1), text: "Konto")
        XCTAssertEqual(run([l], elements: [e, far]).map(\.reason), ["edge"])
        XCTAssertEqual(run([l], elements: [e, wide]).map(\.reason), ["edge"])
    }

    func testALineTheScreenCutsIsAScreenEdgeFindingInBoxMode() {
        // D81: the anchor case (DNT ru toast): an element clamped to the screen that does not clip, a container holding
        // the line, and a line cut by both screen edges.
        let plate = El(id: "plate", rect: CGRect(x: 0, y: 0.7, width: 1, height: 0.1), clips: false)
        let toast = El(id: "t", rect: CGRect(x: 0, y: 0.726, width: 1, height: 0.023),
                       text: "Приходи снова завтра: шаг 2, подарок с монетами", clips: false, offscreen: true)
        let cut = line("иходи снова завтра: шаг 2, подарок с моне", 0, 0.725, 0.998, 0.031)
        let f = run([cut], elements: [plate, toast], locale: "ru", size: (1082, 2202))
        XCTAssertEqual(reasons(f), ["screen-edge:иходи снова завтра: шаг 2, подарок с моне"])
        XCTAssertEqual(f[0].expected, "Приходи снова завтра: шаг 2, подарок с монетами")
        // Without the plate no element owns the line (under 80% inside the toast): D66 flags it, D81 still names the text.
        XCTAssertEqual(run([cut], elements: [toast], locale: "ru", size: (1082, 2202)).map(\.expected), [toast.text])
        // Cut only at the end, at the right edge: flagged; missing its start away from the left edge: not.
        let tail = line("Приходи снова завтра: шаг 2, подарок с моне", 0.05, 0.725, 0.948, 0.031)
        XCTAssertEqual(run([tail], elements: [plate, toast], locale: "ru", size: (1082, 2202)).map(\.reason), ["screen-edge"])
        let inside = line("иходи снова завтра: шаг 2, подарок с моне", 0.05, 0.725, 0.948, 0.031)
        XCTAssertEqual(run([inside], elements: [plate, toast], locale: "ru", size: (1082, 2202)), [])
        // The whole string at the screen edges, a string on another row, and a short line are not cuts.
        let whole = line("Приходи снова завтра: шаг 2, подарок с монетами", 0, 0.725, 0.998, 0.031)
        XCTAssertEqual(run([whole], elements: [plate, toast], locale: "ru", size: (1082, 2202)), [])
        let low = El(id: "t", rect: CGRect(x: 0, y: 0.9, width: 1, height: 0.023), text: toast.text, clips: false)
        XCTAssertEqual(run([cut], elements: [plate, low], locale: "ru", size: (1082, 2202)), [])
        let day = El(id: "d", rect: toast.rect, text: "день 2 из 7", clips: false)
        XCTAssertEqual(run([line("ден", 0.9, 0.725, 0.0999, 0.031)], elements: [plate, day], locale: "ru", size: (1082, 2202)), [])
    }

    // Generated by /ship coverage audit.
    // Value: protects=D81 in right-to-left text the missing start must meet the right screen edge and the missing end
    // the left one; fails_when=screenCut ignores rtl or swaps lead and trail; why_new=every D81 test is left-to-right;
    // seam=none; no_claim=real Hebrew Vision output (synthetic lines and boxes)
    func testAScreenCutInRightToLeftTextMeetsTheEdgeOnTheReadingSide() {
        let plate = El(id: "plate", rect: CGRect(x: 0, y: 0.7, width: 1, height: 0.1), clips: false)
        let toast = El(id: "t", rect: CGRect(x: 0, y: 0.726, width: 1, height: 0.023), text: "ברוכים הבאים לחנות החדשה שלנו", clips: false)
        let check = { (l: RecognizedLine) in self.run([l], elements: [plate, toast], locale: "he", size: (1082, 2202)) }
        // The start is missing where the line meets the right screen edge: cut.
        XCTAssertEqual(check(line("כים הבאים לחנות החדשה שלנו", 0.1, 0.725, 0.9, 0.031)).map(\.expected), [toast.text])
        // The same line at the left screen edge only: its start is missing away from any edge.
        XCTAssertEqual(check(line("כים הבאים לחנות החדשה שלנו", 0, 0.725, 0.9, 0.031)), [])
        // The end is missing where the line meets the left screen edge: cut.
        XCTAssertEqual(check(line("ברוכים הבאים לחנות החדשה ש", 0, 0.725, 0.9, 0.031)).map(\.reason), ["screen-edge"])
    }
}
