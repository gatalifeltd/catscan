// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import NaturalLanguage
import XCTest
@testable import CatscanCore

/// TODO-036 T2: wrong-language on synthetic recognized lines. The language-ID verdict is tested on literal
/// hypothesis tables (D6); the real recognizer runs in the integration golden and the bench.
final class WrongLanguageTests: XCTestCase {
    func lines(_ texts: [String]) -> [RecognizedLine] {
        texts.enumerated().map { i, t in
            RecognizedLine(text: t, rect: CGRect(x: 0.1, y: 0.1 + Double(i) * 0.05, width: 0.5, height: 0.03), confidence: 0.9)
        }
    }

    /// pt-BR run, with es (and optionally en) as other project locales; `catalog` is key -> (es, pt-BR).
    func run(
        _ texts: [String], _ catalog: [String: (String, String?)], locale: String = "pt-BR", others: [String: [String: String]] = [:],
        languages: [String] = [], allow: [String] = [], preferred: String? = nil, reported: [Finding] = []
    ) -> [Finding] {
        evaluate(texts, catalog, locale: locale, others: others, languages: languages, allow: allow, preferred: preferred, reported: reported).add.map(\.finding)
    }

    func evaluate(
        _ texts: [String], _ catalog: [String: (String, String?)], locale: String = "pt-BR", others: [String: [String: String]] = [:],
        languages: [String] = [], allow: [String] = [], preferred: String? = nil, reported: [Finding] = []
    ) -> (add: [(line: Int, finding: Finding)], drop: Set<Int>) {
        var main = UntranslatedJob(baseLocale: "en")
        main.targets = catalog.values.compactMap { $0.1 }.map { [$0] }
        main.allow = allow
        var w = WrongLanguageJob()
        w.languages = languages
        w.preferred = preferred
        var all = others
        all["es"] = catalog.mapValues { $0.0 }
        for (loc, strings) in all.sorted(by: { $0.key < $1.key }) {
            var o = UntranslatedJob(baseLocale: loc)
            o.pairs = strings.sorted(by: { $0.key < $1.key }).map { k, v in
                let t = catalog[k]?.1
                // As Serve sends them: matched without accents (foldMarks), reported as written.
                return .init(key: k, catalog: "pt-BR.json", base: v, expected: t, baseAlternatives: [fragments(v)],
                             targetAlternatives: t.map { [fragments($0)] } ?? [])
            }
            o.targets = main.targets.map { $0.map(WrongLanguage.foldMarks) }
            o.allow = allow
            w.others.append(.init(locale: loc, catalog: "\(loc).json", job: o))
        }
        return WrongLanguage.evaluate(w, main: main, lines: lines(texts), locale: locale, guardScripts: true, aspect: 1, reported: reported)
    }

    /// As the Node loader splits a string at its placeholders and Serve folds it: `desde {date}` -> [`desde `].
    func fragments(_ v: String) -> [String] {
        v.replacingOccurrences(of: "\\{[^}]*\\}", with: "\u{0}", options: .regularExpression).split(separator: "\u{0}")
            .map { WrongLanguage.foldMarks(String($0)) }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    let shop: [String: (String, String?)] = [
        "shop.buy": ("Comprar ahora", "Comprar agora"),
        "common.cancel": ("Cancelar", "Cancelar"), // shared (D35)
        "settings.title": ("Ajustes", "Configurações"),
        "account.enter": ("Iniciar sesión", "Entrar"),
    ]

    func testCatalogEvidenceNamesKeyFilesAndLanguage() {
        let f = run(["Configurações", "Comprar ahora"], shop)
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f[0].kind, "wrong-language")
        XCTAssertEqual(f[0].evidence, "catalog")
        XCTAssertEqual(f[0].language, "es")
        XCTAssertEqual(f[0].expectedLanguage, "pt-BR")
        XCTAssertEqual(f[0].key, "shop.buy")
        XCTAssertEqual(f[0].catalog, "pt-BR.json")
        XCTAssertEqual(f[0].expected, "Comprar agora")
        XCTAssertEqual(f[0].evidenceCatalog, "es.json")
        XCTAssertEqual(f[0].confidence, 1)
    }

    func testSharedStringAndTargetStringAreNotFlagged() {
        // `Cancelar` is the same in es and pt-BR; `Ajustes` is es for settings.title, also a pt-BR string elsewhere.
        var cat = shop
        cat["tab.settings"] = ("Preferencias", "Ajustes")
        XCTAssertEqual(run(["Cancelar", "Ajustes"], cat).count, 0)
    }

    func testLocalityTargetOnScreenAroundIt() {
        // D10: the pt-BR string around the es match makes it translation (`Comprar agora` contains no es match,
        // but `Iniciar sesión` inside a pt-BR sentence that quotes it is covered by the target span).
        var cat = shop
        cat["help.login"] = ("Toca Iniciar sesión", "Toque em Iniciar sesión para continuar")
        XCTAssertEqual(run(["Toque em Iniciar sesión para continuar"], cat).count, 0)
    }

    func testOneFindingPerLineFirstLocaleWins() {
        // `Comprar ahora` is es and also (made up) gl: one finding, the preferred locale named.
        let f = run(["Comprar ahora"], shop, others: ["gl": ["shop.buy": "Comprar ahora"]], preferred: "gl")
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f[0].language, "gl")
        XCTAssertEqual(run(["Comprar ahora"], shop, others: ["gl": ["shop.buy": "Comprar ahora"]])[0].language, "es")
    }

    /// A finding another rule reported. The key goes through a parameter: a literal `x.key = "..."` reads as a
    /// secret assignment to the pregate scan.
    private func reported(_ kind: String, _ line: String, _ k: String) -> Finding {
        var f = Finding(kind: kind, box: Geometry.box(lines(["x"])[0].rect), line: line)
        f.key = k
        return f
    }

    func testReportedLinesAreSkipped() {
        // D5: a line another rule reported (an untranslated base string, a raw key) is never reported again.
        let key = reported("raw-key", "Comprar ahora", "shop.buy")
        XCTAssertEqual(run(["Comprar ahora"], shop, reported: [key]).count, 0)
    }

    func testLongerForeignStringBeatsAShorterBaseStringInside() {
        // D12: `Iniciar sesión` (es) holds no base string, but `Download starten` (de) holds en `Download`.
        var u = reported("untranslated", "Download starten", "download.button")
        u.base = "Download"
        let cat: [String: (String, String?)] = ["download.start": ("Iniciar descarga", "Iniciar download")]
        let r = evaluate(["Download starten"], cat, others: ["de": ["download.start": "Download starten"]], reported: [u])
        XCTAssertEqual(r.add.map(\.finding.language), ["de"])
        XCTAssertEqual(r.drop, [0])
        // A base string as long as the line keeps it: nothing is replaced.
        u.base = "Download starten"
        let same = evaluate(["Download starten"], cat, others: ["de": ["download.start": "Download starten"]], reported: [u])
        XCTAssertTrue(same.add.isEmpty)
        XCTAssertTrue(same.drop.isEmpty)
    }

    func testAccentsDroppedByVisionStillMatch() {
        // Vision on a ja screen reads `Änderungen` as `Anderungen`; the finding keeps the line as read.
        let f = run(["Alle Anderungen speichern"], [:], locale: "ja", others: ["de": ["save": "Alle Änderungen speichern"]])
        XCTAssertEqual(f.map(\.language), ["de"])
        XCTAssertEqual(f.first?.line, "Alle Anderungen speichern")
        XCTAssertEqual(WrongLanguage.foldMarks("Änderungen löschen ガ й"), "Anderungen loschen ガ и")
    }

    func testAllowListAndShortLinesWithoutCatalog() {
        XCTAssertEqual(run(["Comprar ahora"], shop, allow: ["Comprar ahora"]).count, 0)
        // One- and two-word lines without catalog evidence: never language ID (no recognizer call reaches a verdict).
        XCTAssertEqual(run(["Jugar ahora"], [:], languages: ["es"]).count, 0)
        XCTAssertEqual(run(["12:30", "9,99 €", "100%"], [:], languages: ["es"]).count, 0)
    }

    func testRealScreenFalseAlarms() {
        // D31: a one-word string of another locale inside a longer line (fr `dans`, tr `Dans`; es `desde`, pt-BR
        // `desde {date}`) is no evidence; the same word as the whole line is.
        let cat: [String: (String, String?)] = ["dance": ("Baile", "Dança")]
        XCTAssertEqual(run(["dans Réglages."], cat, locale: "fr", others: ["tr": ["dance": "Dans"]]).count, 0)
        XCTAssertEqual(run(["configurarlas desde Ajustes."], cat, locale: "es", others: ["pt-BR": ["since": "desde {date}"]]).count, 0)
        XCTAssertEqual(run(["Dans"], cat, locale: "fr", others: ["tr": ["dance": "Dans"]]).map(\.language), ["tr"])
        // The whole line still counts when Vision dropped its accents or filled its placeholder.
        XCTAssertEqual(run(["Parametres"], cat, locale: "ja", others: ["fr": ["settings": "Paramètres"]]).map(\.language), ["fr"])
        XCTAssertEqual(run(["3 articoli"], cat, locale: "de", others: ["it": ["items": "articoli"]]).map(\.language), ["it"], "the filled number is no word")
        // A filled placeholder adds words to a one-word string: `Olá, {name}` shown as `Olá, Anna`.
        var w = WrongLanguageJob()
        var o = UntranslatedJob(baseLocale: "pt-BR")
        o.pairs = [.init(key: "hi", catalog: "de.json", base: "Olá, {name}", expected: "Hallo, {name}", baseAlternatives: [["Ola, "]], targetAlternatives: [["Hallo, "]])] // folded, as Serve sends them
        o.baseOnly = true
        w.others = [.init(locale: "pt-BR", catalog: "pt-BR.json", job: o)]
        let hi = WrongLanguage.evaluate(w, main: UntranslatedJob(baseLocale: "en"), lines: lines(["Olá, Anna"]), locale: "de", guardScripts: true, aspect: 1, reported: [])
        XCTAssertEqual(hi.add.map(\.finding.language), ["pt-BR"])
        // An OCR fragment is no word: two real words and `[Е` stay under the 3-word minimum.
        XCTAssertFalse(WrongLanguage.judgeable("ЗЕЛЕНИЙ? ПОДИВИСЬ [Е"))
    }

    func testVerdictThresholds() {
        let run = NLLanguage.portuguese
        XCTAssertEqual(WrongLanguage.verdict([.spanish: 0.97, .portuguese: 0.01], run: run)?.0, .spanish)
        XCTAssertNil(WrongLanguage.verdict([.spanish: 0.94, .portuguese: 0.01], run: run), "top under 0.95")
        XCTAssertNil(WrongLanguage.verdict([.spanish: 0.96, .portuguese: 0.03], run: run), "run language over 0.02")
        XCTAssertNil(WrongLanguage.verdict([.portuguese: 0.99, .spanish: 0.01], run: run), "the run language wins")
        XCTAssertNil(WrongLanguage.verdict([:], run: run))
        XCTAssertEqual(WrongLanguage.verdict([.english: 0.95, .portuguese: 0.02], run: run)?.0, .english, "bounds inclusive")
    }

    func testWordAndLetterMinimums() {
        XCTAssertFalse(WrongLanguage.judgeable("Comprar ahora"), "two words")
        XCTAssertFalse(WrongLanguage.judgeable("Ir al mar"), "three words, 7 letters")
        XCTAssertTrue(WrongLanguage.judgeable("Guardar todos los cambios"))
        XCTAssertFalse(WrongLanguage.judgeable("設定を保存"), "5 closed-script letters")
        XCTAssertTrue(WrongLanguage.judgeable("設定を保存しますか今すぐ"))
    }

    func testScriptMismatchOnlyForNonLatinScripts() {
        // D23: Cyrillic on a pt-BR screen at >= 4 letters; Latin on a ru screen is never script evidence.
        XCTAssertEqual(WrongLanguage.foreignScript("Настройки", locale: "pt-BR"), .cyrillic)
        XCTAssertNil(WrongLanguage.foreignScript("Мир", locale: "pt-BR"), "3 letters")
        XCTAssertNil(WrongLanguage.foreignScript("Premium Wi-Fi", locale: "ru"))
        XCTAssertNil(WrongLanguage.foreignScript("Настройки", locale: "uk"), "Cyrillic is native to uk")
        XCTAssertNil(WrongLanguage.foreignScript("Настройки Wi-Fi", locale: "pt-BR"), "mixed scripts")
        XCTAssertEqual(WrongLanguage.foreignScript("設定を保存", locale: "zh-Hans"), .kana, "Japanese on a Chinese screen")
        XCTAssertNil(WrongLanguage.foreignScript("設定保存", locale: "ja"), "Han is native to ja")
        XCTAssertEqual(WrongLanguage.foreignScript("설정 저장", locale: "ja"), .hangul)
        let f = run(["Настройки"], [:], languages: ["ru"])
        XCTAssertEqual(f.map(\.evidence), ["langid"])
        XCTAssertEqual(f.first?.confidence, 1)
    }

    func testLanguageTags() {
        XCTAssertEqual(WrongLanguage.nl("pt-BR"), .portuguese)
        XCTAssertEqual(WrongLanguage.nl("zh-Hant"), .traditionalChinese)
        XCTAssertEqual(WrongLanguage.nl("zh-TW"), .traditionalChinese)
        XCTAssertEqual(WrongLanguage.nl("zh"), .simplifiedChinese)
        XCTAssertEqual(WrongLanguage.nl("es_419"), .spanish)
    }

    func testLineInsideTargetStringIsSkipped() {
        XCTAssertTrue(WrongLanguage.inTarget("configurações da conta", targets: ["configurações da conta e privacidade"]))
        XCTAssertFalse(WrongLanguage.inTarget("guardar todos los cambios", targets: ["salvar"]))
    }

    // protects: Serve's `wrong_language` parsing - other-locale jobs are rule-1-only, matched without accents, share
    //   the run locale's targets and allow list; each malformed shape names its own field.
    // fails_when: baseOnly, accent folding or target/allow propagation is dropped, or a nested error loses its path.
    // why_new: no unit or integration test feeds a malformed or accented `wrong_language` field to the core.
    // seam: none (Server.untranslatedJob is the request parser).
    // no_claim: the Node client's shape of the field (untranslated.test.js) and the matching itself.
    func testServeParsesWrongLanguageAndNamesBadFields() throws {
        func parse(_ wl: Any) -> Result<UntranslatedJob, Diagnostic> {
            Server.untranslatedJob(["base_locale": "en", "targets": [["Configurações"]], "allow": ["Acme"], "wrong_language": wl])
        }
        let pair: [String: Any] = ["key": "save", "catalog": NSNull(), "base": "Änderungen", "expected": "Alterações",
                                   "base_alternatives": [["Änderungen"]], "target_alternatives": [["Alterações"]]]
        let u = try parse(["languages": ["de", "es"], "preferred": "de",
                           "others": [["locale": "de", "catalog": "de.json", "pairs": [pair]]]]).get()
        let w = try XCTUnwrap(u.wrongLanguage)
        XCTAssertEqual([w.languages, [w.preferred ?? ""]], [["de", "es"], ["de"]])
        let o = try XCTUnwrap(w.others.first)
        XCTAssertEqual([o.locale, o.catalog, o.job.baseLocale], ["de", "de.json", "de"])
        XCTAssertTrue(o.job.baseOnly)
        XCTAssertEqual(o.job.pairs.first?.base, "Änderungen", "reported as written")
        XCTAssertEqual(o.job.pairs.first?.baseAlternatives, [["Anderungen"]], "matched without accents")
        XCTAssertEqual(o.job.pairs.first?.targetAlternatives, [["Alteracoes"]])
        XCTAssertEqual(o.job.targets, [["Configuracoes"]])
        XCTAssertEqual(o.job.allow, ["Acme"])
        XCTAssertEqual(u.targets, [["Configurações"]], "the main job keeps its accents")
        func message(_ wl: Any) -> String? {
            if case .failure(let e) = parse(wl) { return e.message }
            return nil
        }
        XCTAssertEqual(message("x"), "untranslated.wrong_language must be an object.")
        XCTAssertEqual(message(["languages": "es"]), "untranslated.wrong_language.languages must be an array of strings.")
        XCTAssertEqual(message(["preferred": 1]), "untranslated.wrong_language.preferred must be a string.")
        XCTAssertEqual(message(["others": [["locale": "de", "pairs": []]]]), "untranslated.wrong_language.others[0] needs locale, catalog and pairs.")
        XCTAssertEqual(message(["others": [["locale": "", "catalog": "x", "pairs": []]]]), "untranslated.wrong_language.others[0] needs locale, catalog and pairs.")
        var noBase = pair
        noBase["base"] = nil
        XCTAssertEqual(message(["others": [["locale": "de", "catalog": "de.json", "pairs": [noBase]]]]),
                       "untranslated.wrong_language.others[0].pairs items need key, base, base_alternatives and target_alternatives.")
    }

    // protects: D31 - a language-ID verdict is dropped when the language does not write every non-Latin script of
    //   the line (a Latin line with a Greek word is never es).
    // fails_when: the script-subset check after `verdict` is removed or inverted.
    // why_new: no test reaches that check; the precondition below proves the recognizer alone would report es.
    // seam: none (the real NLLanguageRecognizer, as testScriptMismatchOnlyForNonLatinScripts uses).
    // no_claim: the recognizer's probabilities on other lines.
    func testLanguageIdNeedsALanguageThatWritesTheLinesScripts() {
        let latin = "Guarda todos los cambios antes de salir"
        let mixed = latin + " Ωμέγα"
        XCTAssertNil(WrongLanguage.foreignScript(mixed, locale: "pt-BR"), "mixed scripts: no script evidence")
        XCTAssertTrue(WrongLanguage.judgeable(mixed))
        XCTAssertEqual(WrongLanguage.verdict(WrongLanguage.hypotheses(mixed, constraints: [.portuguese, .spanish]), run: .portuguese)?.0, .spanish,
                       "precondition: the recognizer alone names es")
        XCTAssertEqual(run([latin], [:], languages: ["es"]).map(\.language), ["es"], "the Latin line alone is reported")
        XCTAssertEqual(run([mixed], [:], languages: ["es"]).count, 0, "es writes no Greek")
    }
}
