// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-099 item 3: a row that joins catalog strings with a separator and is cut inside the last one.
extension TruncationTests {
    func testCatalogPrefixAfterSeparator() {
        let ui: [TruncationJob.Prefix] = [
            .init(text: "Leader of the {civ}", alternatives: [["Leader of the"]]),
            .init(text: "At peace: the borders are closed", alternatives: [["At peace: the borders are closed"]]),
            .init(text: "Deals", alternatives: [["Deals"]]),
        ]
        let cut = run([line("Leader of the Chinese • At peace: the borders a", 0.29, 0.33, 0.178, 0.017)], prefixes: ui, locale: "en")
        XCTAssertEqual(reasons(cut), ["prefix:Leader of the Chinese • At peace: the borders a"])
        XCTAssertEqual(cut.first?.expected, "At peace: the borders are closed")
        // Shown whole; cut at a word boundary; a head that is no catalog string; a short tail.
        for t in ["Leader of the Chinese • At peace: the borders are closed", "Leader of the Chinese · At peace: the borders",
                  "Ruler of the Chinese • At peace: the borders a", "Leader of the Chinese • Dea"] {
            XCTAssertEqual(run([line(t, 0.29, 0.33, 0.178, 0.017)], prefixes: ui, locale: "en"), [], t)
        }
    }

    // Review fixes: a tail that is itself a catalog string; a head part with text past its string.
    func testSeparatorCutNeedsCatalogParts() {
        let ui: [TruncationJob.Prefix] = [
            .init(text: "Song", alternatives: [["Song"]]), .init(text: "Play", alternatives: [["Play"]]),
            .init(text: "Playlist", alternatives: [["Playlist"]]), .init(text: "{n} items", alternatives: [["items"]]),
            .init(text: "Delete {n} items", alternatives: [["Delete", "items"]]),
        ]
        XCTAssertEqual(run([line("Song · Play", 0.3, 0.3, 0.3)], prefixes: ui, locale: "en"), [])
        // A template with no literal words (`{x}: {y}`, `{unit}`) is no evidence that a part is a catalog string.
        let loose = ui + [.init(text: "{x}: {y}", alternatives: [[":"]]), .init(text: "{unit}", alternatives: [])]
        XCTAssertEqual(reasons(run([line("Delete 3 items · Playl", 0.3, 0.3, 0.3)], prefixes: loose, locale: "en")),
                       ["prefix:Delete 3 items · Playl"])
        XCTAssertEqual(run([line("turn 21 · Playl", 0.3, 0.3, 0.3)], prefixes: loose, locale: "en"), [])
        XCTAssertEqual(run([line("Delete 3 items more · Playl", 0.3, 0.3, 0.3)], prefixes: ui, locale: "en"), [])
        XCTAssertEqual(reasons(run([line("Delete 3 items · Playl", 0.3, 0.3, 0.3)], prefixes: ui, locale: "en")),
                       ["prefix:Delete 3 items · Playl"])
    }

    // Review fixes: a chain through a row ending in punctuation, and through a row that spells the first fragment.
    func testChainRowEdges() {
        let hint: [TruncationJob.Prefix] = [.init(text: "Alpha {n} beta gamma, delta epsilon zeta",
                                                  alternatives: [["Alpha", "beta gamma, delta epsilon zeta"]])]
        func rows(_ t: [String]) -> [RecognizedLine] {
            t.enumerated().map { line($0.element, 0.06, 0.5 + 0.025 * Double($0.offset), 0.55) }
        }
        XCTAssertEqual(reasons(run(rows(["Alpha 3 beta gamma,", "delta eps"]), prefixes: hint, locale: "en")), ["prefix:delta eps"])
        let hello: [TruncationJob.Prefix] = [.init(text: "Hello {name}, welcome back to the game", alternatives: [["Hello", ", welcome back to the game"]])]
        XCTAssertEqual(reasons(run(rows(["Hello", "John, welcome ba"]), prefixes: hello, locale: "en")), ["prefix:John, welcome ba"])
    }

    // Review fixes: overlapping repeated rows and repeated fragments stay fast (both searches were exponential).
    func testChainSearchIsBounded() {
        let frags = Array(repeating: "a", count: 12)
        let rep: [TruncationJob.Prefix] = [.init(text: frags.joined(separator: " {x} "), alternatives: [frags])]
        var lines: [RecognizedLine] = []
        for r in 0..<9 { for k in 0..<6 { lines.append(line("a a a a a", 0.1 + 0.001 * Double(k), 0.1 + 0.025 * Double(r), 0.5)) } }
        let start = Date()
        _ = run(lines, prefixes: rep, locale: "en")
        XCTAssertLessThan(Date().timeIntervalSince(start), 30) // an unbounded search takes hours, not seconds
    }

    // Review pass 2: short plain strings, plural and {{name}} heads, a per-row budget, and a stray period on a row.
    func testSeparatorAndChainEdgesPass2() {
        let ui: [TruncationJob.Prefix] = [
            .init(text: "New", alternatives: [["New"]]), .init(text: "Settings", alternatives: [["Settings"]]),
            .init(text: "Song", alternatives: [["Song"]]), .init(text: "3Pro", alternatives: [["3Pro"]]),
            .init(text: "3Products", alternatives: [["3Products"]]),
            .init(text: "1 song | {{count}} songs", alternatives: [["1 song"], ["songs"]]),
            .init(text: "Playlist settings", alternatives: [["Playlist settings"]]),
        ]
        let one = { (t: String) in self.reasons(self.run([self.line(t, 0.3, 0.3, 0.3)], prefixes: ui, locale: "en")) }
        XCTAssertEqual(one("New · Settin"), ["prefix:New · Settin"])
        XCTAssertEqual(one("Song · 3Pro"), [])
        XCTAssertEqual(one("5 songs · Playlist sett"), ["prefix:5 songs · Playlist sett"])
        let hint: [TruncationJob.Prefix] = [.init(text: "Alpha {n} beta gamma, delta epsilon zeta",
                                                  alternatives: [["Alpha", "beta gamma, delta epsilon zeta"]])]
        var lines = (0..<420).map { line("Noise \($0)", 0.06, 0.001 * Double($0), 0.3, 0.0005) }
        lines += [line("Alpha 3 beta gamma,", 0.06, 0.6, 0.55), line("delta eps", 0.06, 0.625, 0.55)]
        XCTAssertEqual(reasons(run(lines, prefixes: hint, locale: "en")), ["prefix:delta eps"])
        let plain: [TruncationJob.Prefix] = [.init(text: "Alpha {n} beta gamma delta epsilon zeta",
                                                   alternatives: [["Alpha", "beta gamma delta epsilon zeta"]])]
        let rows = [line("Alpha 3 beta gamma.", 0.06, 0.6, 0.55), line("delta eps", 0.06, 0.625, 0.55)]
        XCTAssertEqual(reasons(run(rows, prefixes: plain, locale: "en")), ["prefix:delta eps"])
    }

    // Final review: ICU plural edges, plain plural forms, a tail past a placeholder, and a pathological template.
    func testSeparatorFinalReview() {
        let ui: [TruncationJob.Prefix] = [
            .init(text: "{n, plural, one {Song} other {Songs}}", alternatives: [["Song"], ["Songs"]]),
            .init(text: "Song", alternatives: [["Song"]]), .init(text: "Play | Plays", alternatives: [["Play"], ["Plays"]]),
            .init(text: "Playlist", alternatives: [["Playlist"]]),
            .init(text: "Hello {name}, welcome back to the game", alternatives: [["Hello", ", welcome back to the game"]]),
        ]
        let one = { (t: String) in self.reasons(self.run([self.line(t, 0.3, 0.3, 0.3)], prefixes: ui, locale: "en")) }
        XCTAssertEqual(one("xSongx · Playl"), [])
        XCTAssertEqual(one("Song · Play"), [])
        XCTAssertEqual(one("Song · Hello John, welc"), ["prefix:Song · Hello John, welc"])
        let frags = Array(repeating: "a", count: 12)
        let rep: [TruncationJob.Prefix] = [.init(text: frags.joined(separator: " {x} "), alternatives: [frags])]
        let row = String(repeating: "a ", count: 30) + "b \u{00B7} abcd"
        let start = Date()
        _ = run([line(row, 0.1, 0.1, 0.8)], prefixes: rep, locale: "en")
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
    }

    // Generated by /gstack-ship coverage audit (TODO-099).
    // Value: protects=item 3 skips unspaced locales, where a cut kana row reads as mid-word; fails_when=the isUnspaced
    // guard in separatorCut is dropped; why_new=no separator test ran under ja/zh/ko/th; seam=none; no_claim=real
    // Vision rows (synthetic lines; unit only)
    func testSeparatorCutSkipsUnspacedLocales() {
        let ui: [TruncationJob.Prefix] = [.init(text: "設定", alternatives: [["設定"]]),
                                          .init(text: "プライバシー", alternatives: [["プライバシー"]])]
        let row = [line("設定・プライバシ", 0.3, 0.3, 0.3)]
        XCTAssertEqual(run(row, prefixes: ui, locale: "ja"), [])
        // Control: the same row in a spaced locale is a cut, so the guard, not the match, keeps ja quiet.
        XCTAssertEqual(reasons(run(row, prefixes: ui, locale: "en")), ["prefix:設定・プライバシ"])
    }

    // Generated by /gstack-ship coverage audit (TODO-099).
    // Value: protects=D12, a tail past 85% of a first fragment or with that fragment shown elsewhere is no cut;
    // fails_when=the 85% bound or the onScreen check in separatorCut is dropped; why_new=every tail above is under 85%
    // with no other row; seam=none; no_claim=real layouts (synthetic lines; unit only)
    func testSeparatorCutBoundAndOnScreen() {
        let ui: [TruncationJob.Prefix] = [.init(text: "New", alternatives: [["New"]]),
                                          .init(text: "Settings", alternatives: [["Settings"]])]
        XCTAssertEqual(run([line("New · Setting", 0.3, 0.3, 0.3)], prefixes: ui, locale: "en"), [])
        XCTAssertEqual(run([line("New · Settin", 0.3, 0.3, 0.3), line("Settings", 0.3, 0.6, 0.3)], prefixes: ui, locale: "en"), [])
    }

    // Generated by /gstack-ship coverage audit (TODO-099).
    // Value: protects=D6 wiring, rows owned by an element with dump text never join a chain; fails_when=the eligible
    // filter passed to chainCuts in evaluate is dropped; why_new=no chain test passes elements; seam=none;
    // no_claim=the element rule's own verdict on those rows (synthetic dump; unit only)
    func testChainSkipsRowsOwnedByTextElements() {
        let hint: [TruncationJob.Prefix] = [.init(text: "Alpha {n} beta gamma, delta epsilon zeta",
                                                  alternatives: [["Alpha", "beta gamma, delta epsilon zeta"]])]
        let rows = [line("Alpha 3 beta gamma,", 0.06, 0.5, 0.55), line("delta eps", 0.06, 0.525, 0.55)]
        let el = El(id: "hint", rect: CGRect(x: 0.05, y: 0.49, width: 0.6, height: 0.06), text: "Alpha 3 beta gamma, delta eps")
        XCTAssertFalse(reasons(run(rows, elements: [el], prefixes: hint, locale: "en")).contains("prefix:delta eps"))
        // Control: without the element the same rows are a chain cut.
        XCTAssertEqual(reasons(run(rows, prefixes: hint, locale: "en")), ["prefix:delta eps"])
    }

    // Run 2 review: printf placeholders at an edge, and a chain whose last row is a whole catalog string.
    func testPrintfEdgeAndWholeLastRow() {
        let ui: [TruncationJob.Prefix] = [
            .init(text: "Leader of the %s", alternatives: [["Leader of the"]]),
            .init(text: "At peace: the borders are closed", alternatives: [["At peace: the borders are closed"]]),
        ]
        XCTAssertEqual(reasons(run([line("Leader of the Chinese • At peace: the borders a", 0.29, 0.33, 0.178, 0.017)], prefixes: ui, locale: "en")),
                       ["prefix:Leader of the Chinese • At peace: the borders a"])
        let hello: [TruncationJob.Prefix] = [
            .init(text: "Hello {name}, welcome back to the game", alternatives: [["Hello", ", welcome back to the game"]]),
            .init(text: "John, welc", alternatives: [["John, welc"]]),
        ]
        let rows = [line("Hello", 0.06, 0.5, 0.55), line("John, welc", 0.06, 0.525, 0.55)]
        XCTAssertEqual(run(rows, prefixes: hello, locale: "en"), [])
    }

    // Run 2 pass 2: percent text is no printf placeholder; a chain suppressed on its last row hides none of its rows.
    func testPercentTextAndSuppressedChainRows() {
        let ui: [TruncationJob.Prefix] = [.init(text: "3% off", alternatives: [["3% off"]]), .init(text: "Settings", alternatives: [["Settings"]])]
        XCTAssertEqual(reasons(run([line("3% off · Settin", 0.1, 0.3, 0.3)], prefixes: ui, locale: "en")), ["prefix:3% off · Settin"])
        let hint: [TruncationJob.Prefix] = [
            .init(text: "Alpha {n} beta gamma, delta epsilon zeta", alternatives: [["Alpha", "beta gamma, delta epsilon zeta"]]),
            .init(text: "delta eps", alternatives: [["delta eps"]]),
            .init(text: "Alpha 3 beta gamma, and more text here", alternatives: [["Alpha 3 beta gamma, and more text here"]]),
        ]
        let rows = [line("Alpha 3 beta gamma,", 0.06, 0.5, 0.55), line("delta eps", 0.06, 0.525, 0.55)]
        XCTAssertEqual(reasons(run(rows, prefixes: hint, locale: "en")), ["prefix:Alpha 3 beta gamma,"])
    }

    // Run 2 final review: a separator row's last part wrapped onto the row below is shown whole; a ZWNJ string shown
    // whole elsewhere still clears the single-row rule.
    func testSeparatorTailWrapsAndJoinerOnScreen() {
        let ui: [TruncationJob.Prefix] = [
            .init(text: "Level {n}", alternatives: [["Level"]]),
            .init(text: "IN DEN GEGEN\u{00AD}VERKEHR", alternatives: [["IN DEN GEGEN\u{00AD}VERKEHR"]]),
        ]
        for top in ["Level 3 · IN DEN GEGEN-", "Level 3 · IN DEN GEGEN"] {
            let rows = [line(top, 0.3, 0.5, 0.4), line("VERKEHR", 0.5, 0.525, 0.2)]
            XCTAssertEqual(run(rows, prefixes: ui, locale: "de"), [], top)
        }
        XCTAssertEqual(reasons(run([line("Level 3 · IN DEN GEGEN", 0.3, 0.5, 0.4)], prefixes: ui, locale: "de")),
                       ["prefix:Level 3 · IN DEN GEGEN"])
        let fa: [TruncationJob.Prefix] = [.init(text: "می\u{200C}خواهم بروم به خانه", alternatives: [["می\u{200C}خواهم بروم به خانه"]])]
        let shown = [line("میخواهم", 0.3, 0.2, 0.2), line("می\u{200C}خواهم بروم به خانه", 0.3, 0.6, 0.4)]
        XCTAssertEqual(run(shown, prefixes: fa, locale: "fa"), [])
    }

    // Run 3 review: a separator tail that goes on mid-word on the row below is still cut; an allowed chain last row
    // hides none of its rows.
    func testSeparatorTailContinuesMidWordAndAllowedChain() {
        let ui: [TruncationJob.Prefix] = [.init(text: "New", alternatives: [["New"]]), .init(text: "Playlist", alternatives: [["Playlist"]])]
        let rows = [line("New · Playl", 0.3, 0.5, 0.3), line("i", 0.5, 0.525, 0.02)]
        XCTAssertEqual(reasons(run(rows, prefixes: ui, locale: "en")), ["prefix:New · Playl"])
        // Round 2 Red Team: a tail broken mid-word over three rows is shown whole; one that stops mid-word on its
        // last row is still cut.
        let week: [TruncationJob.Prefix] = [
            .init(text: "New", alternatives: [["New"]]), .init(text: "Playlist of the week", alternatives: [["Playlist of the week"]]),
        ]
        let three = { (last: String) in [self.line("New · Playl", 0.3, 0.5, 0.3), self.line("ist of the we", 0.3, 0.525, 0.3), self.line(last, 0.3, 0.55, 0.05)] }
        XCTAssertEqual(run(three("ek"), prefixes: week, locale: "en"), [])
        XCTAssertEqual(reasons(run(three("e"), prefixes: week, locale: "en")), ["prefix:New · Playl"])
        let hint: [TruncationJob.Prefix] = [
            .init(text: "Alpha {n} beta gamma, delta epsilon zeta", alternatives: [["Alpha", "beta gamma, delta epsilon zeta"]]),
            .init(text: "Alpha 3 beta gamma, and more text here", alternatives: [["Alpha 3 beta gamma, and more text here"]]),
        ]
        let chain = [line("Alpha 3 beta gamma,", 0.06, 0.5, 0.55), line("delta eps", 0.06, 0.525, 0.55)]
        XCTAssertEqual(reasons(run(chain, prefixes: hint, allow: ["delta eps"], locale: "en")), ["prefix:Alpha 3 beta gamma,"])
    }

    // Generated by /gstack-ship coverage audit (TODO-099 run 3).
    // Value: protects=hyphen kept at a chain break, a cut inside the first fragment, a chain last row shown whole and a
    // printf lead form; fails_when=the kept-hyphen join, the i >= 1 guard, the shownWhole filter or the printf lead is
    // dropped; why_new=no test reached these branches; seam=none; no_claim=real Vision rows and catalog parsing
    func testChainAndSeparatorCoverageRun3() {
        let wk: [TruncationJob.Prefix] = [.init(text: "Alpha {n} well-known gamma delta", alternatives: [["Alpha", "well-known gamma delta"]])]
        let hy = [line("Alpha 3 well-", 0.06, 0.5, 0.55), line("known gam", 0.06, 0.525, 0.55)]
        XCTAssertEqual(reasons(run(hy, prefixes: wk, locale: "en")), ["prefix:known gam"])
        let ab: [TruncationJob.Prefix] = [.init(text: "Alpha {n} beta gamma delta", alternatives: [["Alpha beta gamma", "delta"]])]
        let first = [line("Alpha be", 0.06, 0.5, 0.55), line("ta gam", 0.06, 0.525, 0.55)]
        XCTAssertFalse(reasons(run(first, prefixes: ab, locale: "en")).contains("prefix:ta gam"))
        let hello: [TruncationJob.Prefix] = [
            .init(text: "Hello {name}, welcome back to the game", alternatives: [["Hello", ", welcome back to the game"]]),
            .init(text: "John, welc ome", alternatives: [["John, welc ome"]]),
        ]
        let whole = [line("Hello", 0.06, 0.5, 0.55), line("John, welc", 0.06, 0.525, 0.55), line("ome", 0.06, 0.55, 0.55)]
        XCTAssertEqual(run(whole, prefixes: hello, locale: "en"), [])
        let songs: [TruncationJob.Prefix] = [
            .init(text: "%d songs", alternatives: [["songs"]]), .init(text: "Playlist settings", alternatives: [["Playlist settings"]]),
        ]
        XCTAssertEqual(reasons(run([line("5 songs · Playlist sett", 0.1, 0.3, 0.4)], prefixes: songs, locale: "en")),
                       ["prefix:5 songs · Playlist sett"])
    }

    // Run 3 final review: a word broken across chain rows without a hyphen goes on directly; the separator tail's
    // continuation search is bounded on overlapping repeated rows.
    func testChainDirectJoinAndBoundedSeparatorWrap() {
        let hint: [TruncationJob.Prefix] = [
            .init(text: "Alpha {n} beta gammadelta epsilon zeta", alternatives: [["Alpha", "beta gammadelta epsilon zeta"]]),
        ]
        let rows = [line("Alpha 3 beta", 0.06, 0.5, 0.55), line("gammadel", 0.06, 0.525, 0.55), line("ta epsilon zeta", 0.06, 0.55, 0.55)]
        XCTAssertEqual(run(rows, prefixes: hint, locale: "en"), [])
        // One long word: every continuation stops mid-word, so no path ends the search early.
        let long = String(repeating: "Playlist", count: 10)
        let ui: [TruncationJob.Prefix] = [.init(text: "New", alternatives: [["New"]]), .init(text: long, alternatives: [[long]])]
        var stack = [line("New · Play", 0.3, 0.5, 0.3)]
        for level in 1...7 {
            for _ in 0..<8 { stack.append(line(level % 2 == 1 ? "list" : "play", 0.3, 0.5 + 0.025 * Double(level), 0.3)) }
        }
        let start = Date()
        _ = run(stack, prefixes: ui, locale: "en")
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
    }
}
