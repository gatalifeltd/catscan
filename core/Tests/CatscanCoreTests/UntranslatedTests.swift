// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// Spec 17 "Rule" and D10-D15, D30: the core's half of `untranslated`, on synthetic recognized lines.
final class UntranslatedTests: XCTestCase {
    func lines(_ texts: [String]) -> [RecognizedLine] {
        texts.enumerated().map { i, t in
            RecognizedLine(text: t, rect: CGRect(x: 0.1, y: 0.1 + Double(i) * 0.05, width: 0.5, height: 0.03), confidence: 0.9)
        }
    }

    func pair(_ key: String, _ base: String, _ expected: String?, baseAlts: [[String]]? = nil, targetAlts: [[String]]? = nil)
        -> UntranslatedJob.Pair
    {
        .init(
            key: key, catalog: "de.json", base: base, expected: expected, baseAlternatives: baseAlts ?? [[base]],
            targetAlternatives: targetAlts ?? (expected.map { [[$0]] } ?? []))
    }

    func run(
        _ texts: [String], _ pairs: [UntranslatedJob.Pair], targets: [[String]] = [], keys: [String] = [],
        styles: Set<String> = [], allow: [String] = [], locale: String = "de", baseLocale: String = "en", catalogTexts: [String] = []
    ) -> ([Finding], [Diagnostic]) {
        var u = UntranslatedJob(baseLocale: baseLocale)
        u.pairs = pairs
        u.targets = targets + pairs.flatMap { $0.targetAlternatives }
        u.keys = keys
        u.texts = catalogTexts + pairs.flatMap { [$0.base] + ($0.expected.map { [$0] } ?? []) } // as the Node layer sends them
        u.styles = styles
        u.allow = allow
        return Untranslated.evaluate(u, lines: lines(texts), locale: locale, guardScripts: true)
    }

    func kinds(_ f: [Finding]) -> [String] { f.map { "\($0.kind):\($0.key ?? $0.token ?? $0.line)" } }

    func testUntranslatedOnOneLineAndAcrossTwo() {
        let (f, _) = run(["Einstellungen", "Privacy"], [pair("settings.privacy", "Privacy", "Datenschutz")])
        XCTAssertEqual(kinds(f), ["untranslated:settings.privacy"])
        XCTAssertEqual(f[0].line, "Privacy")
        XCTAssertEqual(f[0].expected, "Datenschutz")
        XCTAssertEqual(f[0].catalog, "de.json")
        let (g, _) = run(["Manage your", "notifications here"], [pair("n", "Manage your notifications", "Benachrichtigungen verwalten")])
        XCTAssertEqual(g.first?.line, "Manage your notifications here")
    }

    func testSharedStringsAreNeverFlagged() {
        XCTAssertEqual(run(["Email"], [pair("email", "Email", "E-mail ")]).0.count, 1) // differs after normalization
        XCTAssertTrue(run(["Video"], [pair("video", "Video", "video")]).0.isEmpty)
        // A plural is shared when any base form equals any target form (D14).
        let p = pair("n", "1 Video | %d Videos", "1 Video | %d Videos", baseAlts: [["1 Video"], ["Videos"]], targetAlts: [["1 Video"], ["Videos"]])
        XCTAssertTrue(run(["3 Videos"], [p]).0.isEmpty)
    }

    func testRealScreenFalseAlarms() {
        // D35: kept in quotes; D36: Vision drops the umlaut of MENÜ.
        XCTAssertTrue(run(["TAP TO START"], [pair("t", "TAP TO START", "« TAP TO START »")]).0.isEmpty)
        XCTAssertTrue(run(["MENU"], [pair("m", "MENU", "MENÜ")]).0.isEmpty)
        // D34: one line of a wrapped translation quoting the base word; a bare fallback line is still found.
        let stop = pair("sign.stop", "STOP", "HALT")
        let sentence = [["Der „STOP\"-Arm war raus. Dein Führerschein ist weg."]]
        XCTAssertTrue(run(["Der „STOP\"-Arm war raus. Dein"], [stop], targets: sentence).0.isEmpty)
        XCTAssertEqual(run(["STOP"], [stop], targets: sentence).0.count, 1)
        XCTAssertTrue(run(["SCHULBUS ÜBERHOLT", "Der „STOP\"-Arm war raus. Dein"], [stop], targets: sentence).0.isEmpty)
    }

    func testLengthRule() {
        XCTAssertTrue(run(["Go now"], [pair("go", "Go", "Los")]).0.isEmpty)
        XCTAssertTrue(run(["No"], [pair("no", "No", "Nein")]).0.isEmpty)
        XCTAssertEqual(run(["Sign in"], [pair("signin", "Sign in", "Anmelden")]).0.count, 1)
    }

    func testAllowList() {
        XCTAssertTrue(run(["Catscan Pro"], [pair("brand", "Catscan Pro", "Katzenscan Pro")], allow: ["catscan pro"]).0.isEmpty)
    }

    func testSpanRuleIsLocal() {
        // D10: inside another key's target ("Download starten") the base text is part of the translation...
        let dl = pair("download", "Download", "Herunterladen")
        XCTAssertTrue(run(["Download starten"], [dl], targets: [["Download starten"]]).0.isEmpty)
        // ...but a correct translation elsewhere on the screen does not hide a fallback.
        let (f, _) = run(["Datenschutz", "Privacy"], [pair("p", "Privacy", "Datenschutz")])
        XCTAssertEqual(f.count, 1)
        // The key's own target containing the base text: "Mail" inside "E-Mail-Adresse".
        XCTAssertTrue(run(["E-Mail-Adresse"], [pair("mail", "Mail", "E-Mail-Adresse")]).0.isEmpty)
    }

    func testWordBoundaries() {
        XCTAssertTrue(run(["Homepage öffnen"], [pair("home", "Home", "Start")]).0.isEmpty)
        XCTAssertEqual(run(["Home"], [pair("home", "Home", "Start")]).0.count, 1)
    }

    func testMissingTargetIsFlaggedWithNullExpected() {
        let (f, _) = run(["Delete account"], [pair("del", "Delete account", nil)])
        XCTAssertEqual(f.count, 1)
        XCTAssertNil(f[0].expected)
        let json = String(decoding: JSONLine.encode(f[0]), as: UTF8.self)
        XCTAssertTrue(json.contains("\"expected\":null"), json)
    }

    func testOverlapAndDuplicates() {
        // D12: the longer of two overlapping matches; two separate labels on one line are both reported.
        let a = pair("privacy", "Privacy", "Datenschutz"), b = pair("policy", "Privacy Policy", "Datenschutzerklärung")
        XCTAssertEqual(kinds(run(["Privacy Policy"], [a, b]).0), ["untranslated:policy"])
        let s = pair("settings", "Settings", "Einstellungen")
        XCTAssertEqual(kinds(run(["Privacy | Settings"], [a, s]).0), ["untranslated:privacy", "untranslated:settings"])
        // D13: equal base texts are one finding naming every key; a shared one among them suppresses it.
        let (f, _) = run(["Settings"], [pair("tab.settings", "Settings", "Einstellungen"), pair("menu.settings", "Settings", "Optionen")])
        XCTAssertEqual(f.map(\.key), ["menu.settings"])
        XCTAssertEqual(f[0].keys, ["menu.settings", "tab.settings"])
        XCTAssertTrue(run(["Settings"], [pair("a", "Settings", "Einstellungen"), pair("b", "Settings", "Settings")]).0.isEmpty)
    }

    func testPlaceholderFragmentsAndPlurals() {
        let p = pair("files", "1 file | %d files", "1 Datei | %d Dateien", baseAlts: [["1 file"], ["files"]], targetAlts: [["1 Datei"], ["Dateien"]])
        XCTAssertEqual(run(["12 files"], [p]).0.first?.base, "1 file | %d files")
    }

    func testPunctuationEdgedFragmentsMatchNextToAFilledPlaceholder() {
        let p = pair("hi", "Hello {name}, welcome back", "Hallo {name}, willkommen", baseAlts: [["Hello", ", welcome back"]], targetAlts: [["Hallo", ", willkommen"]])
        XCTAssertEqual(run(["Hello Anna, welcome back"], [p]).0.first?.key, "hi")
        let q = pair("pr", "{name}'s profile", "Profil von {name}", baseAlts: [["'s profile"]], targetAlts: [["Profil von"]])
        XCTAssertEqual(run(["Anna's profile"], [q]).0.first?.key, "pr")
    }

    func testBaseLocaleNormalization() {
        // D11: an English fallback on a ja screen keeps English word boundaries.
        XCTAssertEqual(run(["設定", "Sign in"], [pair("s", "Sign in", "サインイン")], locale: "ja").0.count, 1)
        XCTAssertTrue(run(["Homepage"], [pair("h", "Home", "ホーム")], locale: "ja").0.isEmpty)
    }

    func testUnreadableBaseScriptIsCounted() {
        let (f, w) = run(["Привет"], [pair("hi", "Привет", "Hallo")], locale: "de", baseLocale: "ru")
        XCTAssertTrue(f.isEmpty)
        XCTAssertEqual(w.map(\.code), ["untranslated-unreadable"])
    }

    func testRawKeys() {
        let (f, _) = run(["paywall.cta_title", "home.title ", "v1.2.3", "example.com", "photo.jpg", "Weiter", "onboarding_done"], [],
                         keys: ["onboarding_done"])
        XCTAssertEqual(kinds(f), ["raw-key:paywall.cta_title", "raw-key:home.title", "raw-key:onboarding_done"])
        XCTAssertTrue(run(["acme.ai.home"], [], allow: ["acme.ai.home"]).0.isEmpty)
        // A raw-key line is a key, not text: "account.sign_in" normalizes to "account.sign in" but is no fallback.
        let (k, _) = run(["account.sign_in"], [pair("account.sign_in", "Sign in", "Anmelden")], keys: ["account.sign_in"])
        XCTAssertEqual(kinds(k), ["raw-key:account.sign_in"])
        // D33: OCR spacing after the dot, and a joined line of two translations is not a fallback.
        XCTAssertEqual(run(["settings. language"], [pair("settings.language", "Language", "Sprache")]).0.map(\.kind), ["raw-key"])
        let start = [pair("tab.home", "Home", "Start"), pair("download.start", "Start download", "Download starten")]
        XCTAssertTrue(run(["Start", "Download starten"], start).0.isEmpty)
        // A correct translation spelled like another key's base string is translation (homographs, review finding).
        let homo = [pair("tab.home", "Home", "Start"), pair("cta.start", "Start", "Los geht's"),
                    pair("account.name", "Name", "Benutzername"), pair("profile.fullname", "Full name", "Name")]
        XCTAssertTrue(run(["Start", "Name"], homo).0.isEmpty)
        // A target inside the match ("Start" in "Start download") does not hide it.
        let (sd, _) = run(["Start download"], start + [pair("download.button", "Download", "Herunterladen")])
        XCTAssertEqual(kinds(sd), ["untranslated:download.start"])
    }

    func testFullWidthPlaceholdersOnCJKScreens() {
        XCTAssertEqual(run(["\u{FF5B}count\u{FF5D}個の商品"], [], locale: "ja").0.map(\.token), ["{count}"])
    }

    func testPlaceholderSyntaxes() {
        for (line, token) in [
            ("{count} Artikel", "{count}"), ("Hallo {{name}}", "{{name}}"), ("%@ gefällt das", "%@"), ("%d Artikel", "%d"),
            ("Von %s", "%s"), ("Seite %1$s", "%1$s"), ("Hi ${user.name}", "${user.name}"),
        ] {
            let (f, _) = run([line], [])
            XCTAssertEqual(f.map(\.token), [token], line)
            XCTAssertEqual(f.first?.kind, "placeholder")
        }
        for prose in ["100% done", "50 %", "50%discount", "100%% sicher", "{0} Dateien"] {
            XCTAssertTrue(run([prose], []).0.isEmpty, prose)
        }
        // Catalog styles add their own syntax.
        XCTAssertEqual(run(["{0} Dateien"], [], styles: ["{0}"]).0.map(\.token), ["{0}"])
        XCTAssertEqual(run(["{n, plural, one {# Datei}"], [], styles: ["icu"]).0.first?.kind, "placeholder")
        XCTAssertEqual(run(["Preis %.2f"], [], styles: ["printf"]).0.map(\.token), ["%.2f"])
    }

    func testEnvelope() {
        let e = Engine(languages: .success(["en-US", "de-DE"]))
        var job = Job(command: "untranslated")
        var u = UntranslatedJob(baseLocale: "en")
        u.pairs = [pair("p", "Privacy", "Datenschutz")]
        job.untranslated = u
        var env = Envelope(command: "untranslated", path: "x", verdict: "pass", engine: "e", locale: "de", image: nil, host: e.host)
        e.evaluate(job, lines: lines(["Privacy", "{count} Artikel"]), locale: "de", guardScripts: true, env: &env)
        XCTAssertEqual(env.verdict, "fail")
        XCTAssertEqual(env.findings.map(\.kind), ["untranslated", "placeholder"])
        var clean = Envelope(command: "untranslated", path: "x", verdict: "pass", engine: "e", locale: "de", image: nil, host: e.host)
        e.evaluate(job, lines: lines(["Datenschutz"]), locale: "de", guardScripts: true, env: &clean)
        XCTAssertEqual(clean.verdict, "pass")
        XCTAssertTrue(clean.findings.isEmpty)
        // Generated by /ship coverage audit (TODO-031).
        // Value: protects=the engine passes the image aspect (w/h) to the join pass; fails_when=aspect is dropped
        // (default 1) or inverted (h/w); why_new=key-join tests call Untranslated.evaluate with aspect 1 only;
        // seam=none; no_claim=real Vision rects (synthetic lines; unit only)
        var k = UntranslatedJob(baseLocale: "en")
        k.keys = ["menu.play"]
        job.untranslated = k
        // 0.15 apart in normalized x: 0.075 heights on a 1:2 portrait screen (joins), 0.15 at aspect 1, 0.3 inverted.
        let row = [RecognizedLine(text: "menu", rect: CGRect(x: 0.05, y: 0.5, width: 0.1, height: 0.03), confidence: 1),
                   RecognizedLine(text: "play", rect: CGRect(x: 0.3, y: 0.5, width: 0.1, height: 0.03), confidence: 1)]
        var portrait = Envelope(command: "untranslated", path: "x", verdict: "pass", engine: "e", locale: "de",
                                image: ImageSize(width: 500, height: 1000), host: e.host)
        e.evaluate(job, lines: row, locale: "de", guardScripts: true, env: &portrait)
        XCTAssertEqual(kinds(portrait.findings), ["raw-key:menu.play"])
        var landscape = Envelope(command: "untranslated", path: "x", verdict: "pass", engine: "e", locale: "de",
                                 image: ImageSize(width: 1000, height: 500), host: e.host)
        e.evaluate(job, lines: row, locale: "de", guardScripts: true, env: &landscape)
        XCTAssertTrue(landscape.findings.isEmpty)
    }

    func testServeParsing() {
        let ok: [String: Any] = [
            "base_locale": "en", "keys": ["a.b"], "texts": ["Game over"], "styles": ["printf"], "allow": ["X"], "targets": [["Hallo"]],
            "pairs": [["key": "k", "catalog": NSNull(), "base": "Hi", "expected": NSNull(), "base_alternatives": [["Hi"]], "target_alternatives": []]],
        ]
        guard case .success(let u) = Server.untranslatedJob(ok) else { return XCTFail("valid request rejected") }
        XCTAssertNil(u.pairs[0].expected)
        // Generated by /ship coverage audit (TODO-031).
        // Value: protects=serve reads untranslated.texts into the collision guard and rejects a non-string array;
        // fails_when=`texts` is dropped from the parsed fields; why_new=only the Node side asserted `texts`;
        // seam=none; no_claim=the serve socket loop (parser called directly; unit only)
        XCTAssertEqual(u.texts, ["Game over"])
        var bad: [[String: Any]] = [["base_locale": ""], ["base_locale": "en", "styles": ["%q"]], ["base_locale": "en", "keys": [1]],
                                    ["base_locale": "en", "texts": [1]],
                                    ["base_locale": "en", "targets": ["x"]], ["base_locale": "en", "pairs": [["key": "k"]]]]
        bad.append(["base_locale": "en", "pairs": [["key": "k", "base": "b", "expected": 3, "base_alternatives": [], "target_alternatives": []]]])
        for b in bad {
            guard case .failure(let d) = Server.untranslatedJob(b) else { return XCTFail("accepted \(b)") }
            XCTAssertEqual(d.code, "invalid-request")
        }
        if case .success = Server.untranslatedJob("x") { XCTFail("accepted a string") }
    }

    // TODO-010: the length rule reads the whole alternative; short fragments match in order, within 64 characters.
    func testLengthRuleOnTheWholeAlternative() {
        let goOn = pair("go.on", "Go {name} on", "Mach {name} weiter", baseAlts: [["Go ", " on"]], targetAlts: [["Mach ", " weiter"]])
        XCTAssertEqual(kinds(run(["Go Alice on"], [goOn]).0), ["untranslated:go.on"])
        let goName = pair("go.name", "Go {name}", "Los {name}", baseAlts: [["Go "]], targetAlts: [["Los "]])
        XCTAssertTrue(run(["Go Alice"], [goName]).0.isEmpty)
        XCTAssertTrue(run(["Go now"], [pair("go", "Go", "Los")]).0.isEmpty)
        XCTAssertTrue(run(["Go " + String(repeating: "lorem ", count: 12) + "on"], [goOn]).0.isEmpty)
        // The gap is the characters between `go` and `on`: 64 match, 65 do not (D3).
        XCTAssertEqual(kinds(run(["Go " + String(repeating: "x", count: 62) + " on"], [goOn]).0), ["untranslated:go.on"])
        XCTAssertTrue(run(["Go " + String(repeating: "x", count: 63) + " on"], [goOn]).0.isEmpty)
        // D2: a short target fragment now counts for D10, so a target that overlaps the match hides it.
        let onGo = pair("go.on", "Go {name} on", "{name} on go", baseAlts: [["Go ", " on"]], targetAlts: [[" on ", " go"]])
        XCTAssertTrue(run(["Go Alice on go"], [onGo]).0.isEmpty)
        // An alternative with a long fragment matches on it alone, as before: a long or cut-off file name is fine.
        let up = pair("up", "Uploaded {file} to {folder}", "{file} hochgeladen", baseAlts: [["Uploaded ", " to "]], targetAlts: [[" hochgeladen"]])
        XCTAssertEqual(kinds(run(["Uploaded " + String(repeating: "IMG_2024_family_trip_", count: 4) + ".heic t..."], [up]).0), ["untranslated:up"])
        // A short fragment between two placeholders with no letter is dropped, as before.
        let ratio = pair("ratio", "{a} / {b} done", "{a} / {b} fertig", baseAlts: [[" / ", " done"]], targetAlts: [[" / ", " fertig"]])
        XCTAssertEqual(kinds(run(["3 von 5 done"], [ratio]).0), ["untranslated:ratio"])
    }

    // TODO-013: a change into or out of Han, Kana, Hangul or Thai is a word boundary.
    func testScriptChangeIsAWordBoundary() {
        XCTAssertEqual(kinds(run(["Settingsを開く"], [pair("settings", "Settings", "設定")], locale: "ja").0), ["untranslated:settings"])
        XCTAssertEqual(kinds(run(["Settings를 열기"], [pair("settings", "Settings", "설정")], locale: "ko").0), ["untranslated:settings"])
        XCTAssertEqual(kinds(run(["Settingsเปิด"], [pair("settings", "Settings", "ตั้งค่า")], locale: "th").0), ["untranslated:settings"])
        XCTAssertTrue(run(["Homepage"], [pair("h", "Home", "ホーム")], locale: "ja").0.isEmpty)
        XCTAssertEqual(kinds(run(["Visit 東京 today"], [pair("city", "Visit 東京 today", "東京を訪問")], locale: "ja").0), ["untranslated:city"])
    }

    // TODO-014: a window that is a word-bounded part of one longer base fragment is a match.
    func testParagraphsWrappedOverManyLines() {
        let legal = pair("legal", "By continuing you agree to our Terms of Service and acknowledge our Privacy Policy",
                         "Wenn du fortfährst, stimmst du unseren Nutzungsbedingungen zu und bestätigst unsere Datenschutzerklärung")
        let (three, _) = run(["By continuing you agree to our", "Terms of Service and acknowledge", "our Privacy Policy"], [legal])
        XCTAssertEqual(kinds(three), ["untranslated:legal"])
        XCTAssertEqual(three[0].line, "By continuing you agree to our")
        let five = ["By continuing", "you agree to our Terms", "of Service and", "acknowledge our", "Privacy Policy"]
        XCTAssertEqual(kinds(run(five, [legal]).0), ["untranslated:legal"])
        XCTAssertTrue(run(["Wenn du fortfährst, stimmst du", "unseren Nutzungsbedingungen zu und", "bestätigst unsere Datenschutzerklärung"],
                          [legal]).0.isEmpty)
        // The floor and the word boundary, with every word of the paragraph on screen so the group is live (D18).
        let rest = ["Konto", "By continuing", "Konto", "Terms of", "Konto", "Service and", "Konto", "acknowledge", "Konto", "Privacy Policy"]
        XCTAssertTrue(run(["ntinuing you agree to our"] + rest, [legal]).0.isEmpty) // mid-word; "Privacy Policy": two words
        XCTAssertTrue(run(["you agree to", "Konto", "of Service and", "Konto", "our"] + rest, [legal]).0.isEmpty) // 3 words, under 16 characters
        XCTAssertEqual(kinds(run(["continuing you agree to our"] + rest, [legal]).0), ["untranslated:legal"])
        let ack = pair("ack", "Read the acknowledgements carefully before you continue", "Lies die Hinweise sorgfältig")
        XCTAssertTrue(run(["Read the", "Konto", "acknowledgements carefully", "Konto", "before you", "Konto", "continue"], [ack]).0.isEmpty)
        XCTAssertEqual(kinds(run(["Read the", "Konto", "acknowledgements carefully before", "Konto", "you continue"], [ack]).0), ["untranslated:ack"])
        // A window that is exactly one string is reported as that string, not as the paragraph around it.
        let para = pair("a.para", "Read our Privacy Policy and Terms of Use before you continue", "Lies unsere Datenschutzerklärung")
        let link = pair("z.link", "Privacy Policy and Terms of Use", "Datenschutz und Nutzungsbedingungen")
        let around = ["Read our", "Konto", "Privacy Policy and Terms of Use", "Konto", "before you continue"]
        let (tie, _) = run(around, [para, link])
        XCTAssertEqual(kinds(tie), ["untranslated:z.link", "untranslated:a.para"]) // the paragraph at its next window (TODO-011)
        XCTAssertEqual(tie.map(\.line), ["Privacy Policy and Terms of Use", "before you continue"])
        // The allow list covers a partial window too.
        let cloud = pair("c", "Your data is Powered by Acme Cloud servers", "Deine Daten liegen bei Acme")
        let shot = ["Your data is", "Einstellungen", "Powered by Acme Cloud", "Konto", "servers"] // every word on screen (D18)
        XCTAssertTrue(run(shot, [cloud], allow: ["Powered by Acme Cloud"]).0.isEmpty)
        XCTAssertEqual(kinds(run(shot, [cloud]).0), ["untranslated:c"])
        // An allowed line joined to a short neighbor is still allowed.
        XCTAssertTrue(run(["Your data is", "Konto", "Powered by Acme Cloud", "servers"], [cloud], allow: ["Powered by Acme Cloud"]).0.isEmpty)
        XCTAssertTrue(run(["Your data is", "Powered by Acme Cloud", "Konto", "servers"], [cloud], allow: ["Powered by Acme Cloud"]).0.isEmpty)
        // A line of a longer allowed phrase is allowed, even when it alone passes the floor.
        let ack2 = pair("ack2", "Please Read the acknowledgements carefully before you continue", "Bitte lies die Hinweise")
        let ackShot = ["Please", "Konto", "Read the acknowledgements carefully", "before you continue"]
        XCTAssertEqual(kinds(run(ackShot, [ack2]).0), ["untranslated:ack2"])
        XCTAssertTrue(run(ackShot, [ack2], allow: ["Read the acknowledgements carefully before you continue"]).0.isEmpty)
        // An allowed phrase wrapped over two lines is allowed as a whole.
        XCTAssertTrue(run(["Your data is", "Konto", "Powered by Acme", "Cloud servers"], [cloud], allow: ["Powered by Acme Cloud servers"]).0.isEmpty)
        // Unspaced base locales never use the partial window (D10): no word boundary anchors it.
        let ja = pair("ja.para", "iPhoneの設定でWi-Fiをオンにしてから写真を選んでください", "Turn on Wi-Fi first")
        let jaShot = ["設定でWi-Fiをオンにしてから写真", "ホーム", "iPhoneの設定でWi-Fiをオンにしてから写真を選んでください"]
        XCTAssertEqual(run(jaShot, [ja], locale: "ja", baseLocale: "ja").0.map(\.line), [jaShot[2]])
        // A window that is part of a target string is a translation quoting the base text (D2).
        let quote = pair("quote", "Quote", "Er schrieb: you agree to our Terms of Service, wörtlich")
        XCTAssertTrue(run(["you agree to our Terms of Service"], [legal, quote]).0.isEmpty)
    }

    // TODO-015: domains, country codes, file names and taglines are not raw keys; real keys still are.
    func testDomainsFilesAndTaglinesAreNotRawKeys() {
        let decoys = ["acme.shop", "mysite.xyz", "www.spiegel.de", "bbc.co.uk", "readme.md", "report.docx", "song.mp3", "denken. machen. teilen", "www.example.org"]
        XCTAssertTrue(run(decoys, []).0.isEmpty)
        XCTAssertEqual(kinds(run(["paywall.cta_title", "common.ok", "settings. language"], []).0),
                       ["raw-key:paywall.cta_title", "raw-key:common.ok", "raw-key:settings. language"])
        XCTAssertEqual(kinds(run(["button.no"], [], keys: ["button.no"]).0), ["raw-key:button.no"])
    }

    // TODO-011: a group whose first hit loses to a longer span (D12) is reported at its next surviving window.
    func testGroupReportedAtItsFirstSurvivingWindow() {
        let privacy = pair("settings.privacy", "Privacy", "Datenschutz")
        let settings = pair("settings.privacy_title", "Privacy settings", "Datenschutzeinstellungen")
        let (f, _) = run(["Privacy settings", "Konto", "Privacy"], [privacy, settings])
        XCTAssertEqual(kinds(f), ["untranslated:settings.privacy_title", "untranslated:settings.privacy"])
        XCTAssertEqual(f.map(\.line), ["Privacy settings", "Privacy"])
        // Two surviving windows of one base text are still one finding (D12, D13).
        XCTAssertEqual(kinds(run(["Privacy", "Konto", "Privacy"], [privacy]).0), ["untranslated:settings.privacy"])
        // Reading order: a match across lines 0 and 1 comes before a single-line match on line 3.
        let (o, _) = run(["Privacy", "settings", "Konto", "Privacy settings"], [settings])
        XCTAssertEqual(o.map(\.line), ["Privacy settings"])
        XCTAssertEqual(o.first?.box, Geometry.box(lines(["Privacy", "settings"]).map(\.rect).reduce(CGRect.null) { $0.union($1) }))
        // TODO-011 D1, D3: the longer base text has a hit in every window, so in window 2 it drops the shorter match it
        // overlaps, although it is reported at window 0.
        let now = pair("now", "settings now", "jetzt")
        XCTAssertEqual(kinds(run(["Privacy settings", "Konto", "Privacy settings now"], [settings, now]).0), ["untranslated:settings.privacy_title"])
        // A key inside every line of an untranslated paragraph is absorbed by the paragraph (TODO-014 D8 resolved).
        let legal = pair("legal", "By continuing you agree to our Terms of Service and acknowledge our Privacy Policy",
                         "Wenn du fortfährst, stimmst du unseren Nutzungsbedingungen zu")
        let (p, _) = run(["By continuing you agree to our", "Terms of Service and acknowledge", "our Privacy Policy"], [legal, privacy])
        XCTAssertEqual(kinds(p), ["untranslated:legal"])
    }

    // TODO-012 D1, D2: each cap refuses the field with invalid-request naming the field, the count and the limit.
    func testServeCaps() {
        let c = Untranslated.caps
        func pair(_ i: Int, base: [[String]] = [["Hi"]], target: [[String]] = []) -> [String: Any] {
            ["key": "k\(i)", "catalog": NSNull(), "base": "Hi", "expected": NSNull(), "base_alternatives": base, "target_alternatives": target]
        }
        let atCap: [String: Any] = ["base_locale": "en", "pairs": (0..<c.pairs).map { pair($0) },
                                    "targets": Array(repeating: Array(repeating: "x", count: c.fragments), count: c.targets)]
        let wide: [String: Any] = ["base_locale": "en", "pairs": [pair(0, base: Array(repeating: ["a"], count: c.alternatives),
                                                                     target: [Array(repeating: "a", count: c.fragments)])]]
        guard case .success = Server.untranslatedJob(wide) else { return XCTFail("a pair at the per-string caps was refused") }
        guard case .success = Server.untranslatedJob(atCap) else { return XCTFail("a field at the caps was refused") }
        let cases: [([String: Any], String)] = [
            (["base_locale": "en", "pairs": (0...c.pairs).map { pair($0) }], "untranslated.pairs has 20001 items; the limit is 20000."),
            (["base_locale": "en", "targets": Array(repeating: ["x"], count: c.targets + 1)], "untranslated.targets has 20001 items; the limit is 20000."),
            (["base_locale": "en", "targets": [Array(repeating: "x", count: c.fragments + 1)]], "untranslated.targets has an alternative of 257 fragments; the limit is 256."),
            (["base_locale": "en", "pairs": [pair(0, base: Array(repeating: ["a"], count: c.alternatives + 1))]], "untranslated.pairs k0 base_alternatives has 257 items; the limit is 256."),
            (["base_locale": "en", "pairs": [pair(0, target: Array(repeating: ["a"], count: c.alternatives + 1))]], "untranslated.pairs k0 target_alternatives has 257 items; the limit is 256."),
            (["base_locale": "en", "pairs": [pair(0, target: [Array(repeating: "a", count: c.fragments + 1)])]],
             "untranslated.pairs k0 target_alternatives has 257 fragments; the limit is 256."),
            (["base_locale": "en", "pairs": [pair(0, base: Array(repeating: ["a", "b"], count: c.fragments / 2 + 1))]], // over all forms
             "untranslated.pairs k0 base_alternatives has 258 fragments; the limit is 256."),
        ]
        for (field, message) in cases {
            guard case .failure(let d) = Server.untranslatedJob(field) else { XCTFail("accepted \(message)"); continue }
            XCTAssertEqual(d.code, "invalid-request")
            XCTAssertEqual(d.message, message)
        }
    }

    // TODO-031: game-UI rendering and OCR change a raw key's shape; each case is still the catalog key.
    let menu = [("tab.settings", "Settings", "Einstellungen"), ("settings.support", "Support", "Hilfe"),
                ("ui:shop:title", "Item shop", "Artikelladen"), ("level_2.title", "Level two", "Stufe zwei"),
                ("game.over", "Game over", "Spiel vorbei")]
    func menuRun(_ texts: [String], extraKeys: [String] = [], allow: [String] = [], textsField: [String] = []) -> [Finding] {
        run(texts, menu.map { pair($0.0, $0.1, $0.2) }, keys: menu.map(\.0) + extraKeys, allow: allow, catalogTexts: textsField).0
    }

    func testSeparatorMisreadIsRawKey() {
        for line in ["settings support", "settings·support", "settings,support", "settings-support", "settings | support", "settings.support|"] {
            XCTAssertEqual(kinds(menuRun([line])), ["raw-key:settings.support"], line)
            XCTAssertEqual(menuRun([line])[0].line, line)
        }
        XCTAssertEqual(kinds(menuRun(["ui: shop:title", "level_2 title"])), ["raw-key:ui:shop:title", "raw-key:level_2.title"])
        // The owner's case: no `untranslated: Settings` for the key line.
        XCTAssertFalse(menuRun(["Einstellungen", "settings support"]).contains { $0.kind == "untranslated" })
    }

    func testTitlesAndProseAreNotKeys() {
        for line in ["Settings Support", "SETTINGS SUPPORT", "settings support!?", "Settings: Support"] {
            XCTAssertFalse(menuRun([line]).contains { $0.kind == "raw-key" }, line)
        }
        // Guard: `game over` is also the base string `Game over`; only a visible key separator makes it the key.
        XCTAssertEqual(kinds(menuRun(["game over"])), ["untranslated:game.over"])
        XCTAssertEqual(kinds(menuRun(["game_over"])), ["raw-key:game.over"])
        // D7: an allow-listed line is no raw key (its words are still checked as base strings).
        XCTAssertFalse(menuRun(["settings support"], allow: ["settings support"]).contains { $0.kind == "raw-key" })
    }

    func testAllCapsKey() {
        XCTAssertEqual(kinds(menuRun(["SETTINGS.SUPPORT"])), ["raw-key:settings.support"])
        XCTAssertEqual(kinds(menuRun(["GAME.OVER"])), ["raw-key:game.over"])
        // A bold dot read as `, ` `|` or `. ` (D33) is still a visible separator.
        for line in ["SETTINGS,SUPPORT", "SETTINGS|SUPPORT", "SETTINGS. SUPPORT"] {
            XCTAssertEqual(kinds(menuRun([line])), ["raw-key:settings.support"], line)
        }
        XCTAssertEqual(kinds(menuRun(["GAME. OVER"])), ["raw-key:game.over"])
    }

    func testAmbiguousCanonNamesEveryKey() {
        let f = menuRun(["menu foo bar"], extraKeys: ["menu.foo-bar", "menu.foo_bar"])
        XCTAssertEqual(f.map(\.kind), ["raw-key"])
        XCTAssertNil(f[0].key)
        XCTAssertEqual(f[0].keys, ["menu.foo-bar", "menu.foo_bar"])
        // Generated by /ship coverage audit (TODO-031).
        // Value: protects=raw-key JSON carries `key` or `keys` (the wire contract render.js reads); fails_when=the
        // Model raw-key encode branch is dropped; why_new=tests read Finding fields, never the encoded line;
        // seam=none; no_claim=Node-side parsing (Swift encoder only)
        let many = String(decoding: JSONLine.encode(f[0]), as: UTF8.self)
        XCTAssertTrue(many.contains("\"keys\":[\"menu.foo-bar\",\"menu.foo_bar\"]") && !many.contains("\"key\":"), many)
        let one = String(decoding: JSONLine.encode(menuRun(["settings support"])[0]), as: UTF8.self)
        XCTAssertTrue(one.contains("\"key\":\"settings.support\"") && !one.contains("\"keys\":"), one)
    }

    func testKeyCutByEllipsis() {
        let extra = ["onboarding.permissions.notifications.description_long", "settings.notifications", "settings.notes", "contact.support.label"]
        XCTAssertEqual(kinds(menuRun(["onboarding.permissions.notif..."], extraKeys: extra)),
                       ["raw-key:onboarding.permissions.notifications.description_long"])
        XCTAssertEqual(kinds(menuRun(["onboarding.permissions.notif\u{2026}"], extraKeys: extra)),
                       ["raw-key:onboarding.permissions.notifications.description_long"])
        XCTAssertEqual(menuRun(["settings.no..."], extraKeys: extra)[0].keys, ["settings.notes", "settings.notifications"])
        // Too short, no separator, no catalog key, or the start of a catalog string: text.
        for line in ["menu.p...", "Loading...", "profile.ed...", "contact.support..."] {
            XCTAssertFalse(menuRun([line], extraKeys: extra, textsField: ["contact.support@example.com"]).contains { $0.kind == "raw-key" }, line)
        }
        // Generated by /ship coverage audit (TODO-031).
        // Value: protects=a cut key with more than 10 candidates is a raw key naming none, 10 names all; fails_when=the
        // cap is removed, moved, or returns nil (no finding); why_new=cut tests use at most 2 candidates;
        // seam=none; no_claim=none beyond protects
        let ten = (0..<10).map { "settings.n\($0)" }
        XCTAssertEqual(menuRun(["settings.n..."], extraKeys: ten)[0].keys?.count, 10)
        let eleven = menuRun(["settings.n..."], extraKeys: ten + ["settings.n10"])
        XCTAssertEqual(eleven.map(\.kind), ["raw-key"])
        XCTAssertNil(eleven[0].key)
        XCTAssertNil(eleven[0].keys)
    }

    func testKeyInsideALine() {
        let f = menuRun(["Einstellungen: settings.support"])
        XCTAssertEqual(kinds(f), ["raw-key:settings.support"])
        XCTAssertEqual(f[0].line, "Einstellungen: settings.support")
        // A domain in prose is no catalog key.
        XCTAssertTrue(menuRun(["Besuche acme.ai heute"]).isEmpty)
    }

    func testKeyOverTwoObservations() {
        XCTAssertEqual(kinds(menuRun(["settings.", "support"])), ["raw-key:settings.support"])
        let wrapped = menuRun(["onboarding.permissions.", "notifications.description_long"],
                              extraKeys: ["onboarding.permissions.notifications.description_long"])
        XCTAssertEqual(kinds(wrapped), ["raw-key:onboarding.permissions.notifications.description_long"])
        XCTAssertEqual(wrapped[0].line, "onboarding.permissions. notifications.description_long")
        // A one-segment key never joins (`play` + `back` buttons are not `playback`).
        XCTAssertTrue(run(["play", "back"], [], keys: ["playback"]).0.isEmpty)
        // Two labels far apart on one row are two controls.
        var u = UntranslatedJob(baseLocale: "en")
        u.keys = ["menu.play"]
        let apart = [RecognizedLine(text: "menu", rect: CGRect(x: 0.05, y: 0.5, width: 0.1, height: 0.03), confidence: 1),
                     RecognizedLine(text: "play", rect: CGRect(x: 0.7, y: 0.5, width: 0.1, height: 0.03), confidence: 1)]
        XCTAssertTrue(Untranslated.evaluate(u, lines: apart, locale: "de", guardScripts: true).0.isEmpty)
        let near = [apart[0], RecognizedLine(text: "play", rect: CGRect(x: 0.17, y: 0.5, width: 0.1, height: 0.03), confidence: 1)]
        XCTAssertEqual(kinds(Untranslated.evaluate(u, lines: near, locale: "de", guardScripts: true).0), ["raw-key:menu.play"])
        // Generated by /ship coverage audit (TODO-031).
        // Value: protects=stacked labels far below, or on the next row but far right, never join into a key;
        // fails_when=the next-row gap or left-edge guard in `continues` is loosened or inverted; why_new=only the
        // same-row branch had a negative case; seam=none; no_claim=real Vision rects (synthetic lines; unit only)
        let below = RecognizedLine(text: "play", rect: CGRect(x: 0.05, y: 0.7, width: 0.1, height: 0.03), confidence: 1)
        let indented = RecognizedLine(text: "play", rect: CGRect(x: 0.5, y: 0.54, width: 0.1, height: 0.03), confidence: 1)
        for b in [below, indented] {
            XCTAssertTrue(Untranslated.evaluate(u, lines: [apart[0], b], locale: "de", guardScripts: true).0.isEmpty, "\(b.rect)")
        }
        let wrapped2 = RecognizedLine(text: "play", rect: CGRect(x: 0.05, y: 0.54, width: 0.1, height: 0.03), confidence: 1)
        XCTAssertEqual(kinds(Untranslated.evaluate(u, lines: [apart[0], wrapped2], locale: "de", guardScripts: true).0), ["raw-key:menu.play"])
    }

    // /ship review of TODO-031 (red team, adversarial): catalog strings and prose that only look like keys.
    func testReviewRegressions() {
        // A caps catalog string with its own separator is that string, not a key.
        let signIn = [pair("sign_in", "Sign-in", "Anmelden"), pair("time.left", "Time left:", "Zeit übrig:")]
        for line in ["SIGN-IN", "TIME LEFT:"] {
            XCTAssertFalse(run([line], signIn, keys: ["sign_in", "time.left"], locale: "en", baseLocale: "en").0.contains { $0.kind == "raw-key" }, line)
        }
        // Title punctuation is no visible separator; a middle dot is.
        for line in ["SETTINGS: SUPPORT", "SETTINGS - SUPPORT", "SETTINGS, SUPPORT"] {
            XCTAssertFalse(menuRun([line]).contains { $0.kind == "raw-key" }, line)
        }
        XCTAssertEqual(kinds(menuRun(["SETTINGS · SUPPORT"])), ["raw-key:settings.support"])
        // A hyphenated key is a word in prose; a dotted one inside a line is still a key, blanked for rule 1 even
        // when Vision reads full-width punctuation around it.
        XCTAssertFalse(run(["Gib deine e-mail ein"], [pair("e-mail", "E-mail", "E-Mail")], keys: ["e-mail"]).0.contains { $0.kind == "raw-key" })
        XCTAssertEqual(kinds(menuRun(["Hilfe: settings\u{FF0E}support"])), ["raw-key:settings.support"])
        XCTAssertEqual(kinds(menuRun(["Hilfe: settings.support！"])), ["raw-key:settings.support"])
        // A dotted key inside a line is a key even when its words are a catalog string (`game.over`, `Game over`).
        XCTAssertEqual(kinds(menuRun(["Runde 3: game.over"])), ["raw-key:game.over"])
        // A catalog text cut by an ellipsis is that text truncated; a placeholder is no key inside a line.
        let mail = run(["contact.support..."], [pair("contact.support", "contact.support@example.com", "contact.support@example.com")],
                       keys: ["contact.support"], catalogTexts: ["contact.support@example.com"]).0
        XCTAssertFalse(mail.contains { $0.kind == "raw-key" })
        XCTAssertFalse(menuRun(["Hallo {level_2.title}"]).contains { $0.kind == "raw-key" })
        for line in ["contact. support...", "(contact.support...", "contact,support..."] {
            let cut = run([line], [pair("contact.support", "contact.support@example.com", "contact.support@example.com")],
                          keys: ["contact.support"]).0
            XCTAssertFalse(cut.contains { $0.kind == "raw-key" }, line)
        }
        XCTAssertFalse(run(["Mail: (contact.support..."], [pair("contact.support", "contact.support@example.com", "contact.support@example.com")],
                           keys: ["contact.support"]).0.contains { $0.kind == "raw-key" })
        // A key with its dot and an ellipsis is a key, though its words start a catalog text (`Game over`).
        XCTAssertEqual(kinds(menuRun(["game.over..."], extraKeys: ["game.over.subtitle"])), ["raw-key:game.over"])
        // Inside a line, a key that is also a catalog string is that string.
        XCTAssertFalse(menuRun(["Runde 3: level_2.title"], textsField: ["level_2.title"]).contains { $0.kind == "raw-key" })
        // A joined line on the allow list, or one part on it, is no key; two catalog texts side by side are two labels.
        XCTAssertFalse(menuRun(["settings.", "support"], allow: ["settings. support"]).contains { $0.kind == "raw-key" })
        XCTAssertFalse(menuRun(["settings.", "support"], allow: ["settings."]).contains { $0.kind == "raw-key" })
        let labels = [pair("settings.support", "Support", "Hilfe"), pair("tab.settings", "settings", "einstellungen"), pair("tab.support", "support", "hilfe")]
        XCTAssertFalse(run(["settings", "support"], labels, keys: ["settings.support"]).0.contains { $0.kind == "raw-key" })
        // One part that is a one-word key or text on its own still joins when the seam has the key's dot.
        XCTAssertEqual(kinds(menuRun(["settings.", "support"], extraKeys: ["support"])), ["raw-key:settings.support"])
    }

    func testJoinOrderAndCaps() {
        var u = UntranslatedJob(baseLocale: "en")
        u.keys = ["settings.support"]
        let r = { (x: Double, y: Double) in CGRect(x: x, y: y, width: 0.12, height: 0.03) }
        let eval = { (l: [RecognizedLine]) in self.kinds(Untranslated.evaluate(u, lines: l, locale: "ar", guardScripts: false).0) }
        // RTL reading order lists the right part first.
        XCTAssertEqual(eval([RecognizedLine(text: "support", rect: r(0.3, 0.5), confidence: 1),
                             RecognizedLine(text: "settings.", rect: r(0.15, 0.5), confidence: 1)]), ["raw-key:settings.support"])
        XCTAssertEqual(eval([RecognizedLine(text: "SETTINGS.", rect: r(0.15, 0.5), confidence: 1),
                             RecognizedLine(text: "SUPPORT", rect: r(0.3, 0.5), confidence: 1)]), ["raw-key:settings.support"])
        // A label and its value on one row (`SETTINGS:` `SUPPORT`) read like the one line `SETTINGS: SUPPORT`.
        XCTAssertEqual(eval([RecognizedLine(text: "SETTINGS:", rect: r(0.15, 0.5), confidence: 1),
                             RecognizedLine(text: "SUPPORT", rect: r(0.3, 0.5), confidence: 1)]), [])
        XCTAssertEqual(eval([RecognizedLine(text: "SETTINGS:", rect: r(0.1, 0.5), confidence: 1),
                             RecognizedLine(text: "SUPPORT", rect: r(0.1, 0.54), confidence: 1)]), [])
        var u3 = UntranslatedJob(baseLocale: "en"); u3.keys = ["settings.sound.effects"]
        XCTAssertEqual(kinds(Untranslated.evaluate(u3, lines: [RecognizedLine(text: "SETTINGS.SOUND", rect: r(0.1, 0.5), confidence: 1),
                                                               RecognizedLine(text: "EFFECTS", rect: r(0.1, 0.54), confidence: 1)],
                                                    locale: "ar", guardScripts: false).0), ["raw-key:settings.sound.effects"])
        // One label stacked under a word is two controls, even without a dot at the seam.
        let one = UntranslatedJob(baseLocale: "en")
        var u2 = one; u2.keys = ["settings.support"]; u2.texts = ["support"]
        XCTAssertEqual(kinds(Untranslated.evaluate(u2, lines: [RecognizedLine(text: "settings", rect: r(0.1, 0.5), confidence: 1),
                                                               RecognizedLine(text: "support", rect: r(0.1, 0.54), confidence: 1)],
                                                    locale: "ar", guardScripts: false).0), [])
        // A label wraps a long key inside a word.
        XCTAssertEqual(eval([RecognizedLine(text: "SETTINGS.SUPP", rect: r(0.1, 0.5), confidence: 1),
                             RecognizedLine(text: "ORT", rect: r(0.1, 0.54), confidence: 1)]), ["raw-key:settings.support"])
        XCTAssertEqual(eval([RecognizedLine(text: "settings supp", rect: r(0.1, 0.5), confidence: 1),
                             RecognizedLine(text: "ort", rect: r(0.1, 0.54), confidence: 1)]), ["raw-key:settings.support"])
        // The next line is below: a line listed second but drawn above does not continue the first.
        XCTAssertEqual(eval([RecognizedLine(text: "settings.", rect: r(0.1, 0.5), confidence: 1),
                             RecognizedLine(text: "support", rect: r(0.1, 0.46), confidence: 1)]), [])
    }
}
