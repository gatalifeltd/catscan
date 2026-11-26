// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation
import XCTest

@testable import CatscanCore

final class TesseractTests: XCTestCase {
    func testPackMap() {
        let want = [
            "el": "script/Greek", "he": "heb", "bg": "bul", "sr": "srp+srp_latn", "sr-Cyrl": "srp", "sr-Latn": "srp_latn",
            "sr-Latn-RS": "srp_latn", "hu": "hun", "fa": "fas", "ka": "kat", "hy": "hye", "el-GR": "script/Greek", "HE": "heb",
            "hr": "hrv", "sk": "slk", "sl": "slv", "lt": "lit", "lv": "lav", "mt": "mlt", "ga": "gle", "is": "isl",
            "mk": "mkd", "bs": "bos", "be": "bel", "hr-HR": "hrv", "et": "est", "cy": "cym", "sq": "sqi",
        ]
        for (l, p) in want { XCTAssertEqual(Tesseract.pack(for: l), p, l) }
        for l in ["en", "ru", "ja", "zh-Hant", "xx", ""] { XCTAssertNil(Tesseract.pack(for: l), l) }
        for l in Tesseract.locales { XCTAssertNotNil(Tesseract.pack(for: l), l) }
    }

    func testScaleFromLineHeights() {
        // TODO-020: tall text is read once, unscaled; short text again, scaled to the 40 px target.
        XCTAssertEqual(Tesseract.scale(lineHeights: [64, 43, 40], width: 600, height: 120), 1)
        XCTAssertEqual(Tesseract.scale(lineHeights: [20], width: 600, height: 120), 2)
        XCTAssertEqual(Tesseract.scale(lineHeights: [32, 16, 10, 20], width: 600, height: 120), 40.0 / 18, accuracy: 1e-9)
        // A median, not a mean: one large title does not stop the second read of a screen of small labels.
        XCTAssertEqual(Tesseract.scale(lineHeights: [200, 16, 16], width: 1000, height: 1000), 2.5)
        XCTAssertEqual(Tesseract.scale(lineHeights: [5], width: 600, height: 120), 3)
        XCTAssertEqual(Tesseract.scale(lineHeights: [], width: 600, height: 120), 2)
        // The 16 MP budget bounds the factor (a 1290 x 2796 phone screen gets about 2.1x), and no budget left
        // means no second read.
        XCTAssertEqual(Tesseract.scale(lineHeights: [10], width: 2000, height: 2000), 2, accuracy: 1e-9)
        XCTAssertEqual(Tesseract.scale(lineHeights: [10], width: 5000, height: 4000), 1)
    }

    func testLookupOrder() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("catscan-tess-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let a = root.appendingPathComponent("a"), b = root.appendingPathComponent("b")
        for d in [a, b] {
            try fm.createDirectory(at: d, withIntermediateDirectories: true)
            let t = d.appendingPathComponent("tesseract").path
            fm.createFile(atPath: t, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        }
        // PATH before the extra directory.
        XCTAssertEqual(Tesseract.find(env: ["PATH": a.path], extra: [b.path]), a.path + "/tesseract")
        // An empty PATH still finds the extra directory (why the tests need CATSCAN_TESSERACT, D2).
        XCTAssertEqual(Tesseract.find(env: ["PATH": ""], extra: [b.path]), b.path + "/tesseract")
        // The override wins, and a missing override means absent even with Tesseract on PATH.
        XCTAssertEqual(Tesseract.find(env: ["PATH": a.path, "CATSCAN_TESSERACT": b.path + "/tesseract"], extra: []), b.path + "/tesseract")
        XCTAssertNil(Tesseract.find(env: ["PATH": a.path, "CATSCAN_TESSERACT": "/nonexistent/tesseract"], extra: [b.path]))
        XCTAssertEqual(Tesseract.candidates(env: ["CATSCAN_TESSERACT": "/x/t"]), ["/x/t"])
        // A directory named tesseract is not a binary.
        XCTAssertNil(Tesseract.find(env: ["PATH": root.path], extra: []))
    }

    func testParseVersionAndLangs() {
        XCTAssertEqual(Tesseract.parseVersion("tesseract 5.5.3\n leptonica-1.87.0\n"), "5.5.3")
        XCTAssertNil(Tesseract.parseVersion("command not found"))
        let l = Tesseract.parseLangs("List of available languages in \"/opt/homebrew/share/tessdata/\" (3):\neng\nell\nscript/Greek\n")
        XCTAssertEqual(l.tessdata, "/opt/homebrew/share/tessdata/")
        XCTAssertEqual(l.packs, ["eng", "ell", "script/Greek"])
        XCTAssertEqual(Tesseract.parseLangs("List of available languages in \"/e/\" (0):\n").packs, [])
    }

    func testParseTSV() {
        let tsv = """
            level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
            1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t
            5\t1\t1\t1\t1\t1\t100\t200\t300\t50\t90.0\tΡυθμίσεις
            5\t1\t1\t1\t1\t2\t420\t190\t200\t70\t70.0\tλογαριασμού
            5\t1\t1\t1\t1\t3\t700\t200\t10\t10\t-1\t
            5\t1\t2\t1\t1\t1\t100\t1000\t250\t60\t96.0\tΣυνέχεια
            5\t1\t2\t1\t1\t2\t400\t1000\t10\t60\t50.0\t\u{20}
            """
        let lines = Tesseract.parseTSV(tsv, width: 1000, height: 2000)
        XCTAssertEqual(lines.map(\.text), ["Ρυθμίσεις λογαριασμού", "Συνέχεια"])
        XCTAssertEqual(Geometry.box(lines[0].rect), [0.1, 0.095, 0.52, 0.035])
        XCTAssertEqual(lines[0].confidence, 0.8, accuracy: 1e-9)
        XCTAssertEqual(Geometry.box(lines[1].rect), [0.1, 0.5, 0.25, 0.03])
        XCTAssertEqual(Tesseract.parseTSV("level\tpage_num\n", width: 10, height: 10), [])
    }

    func testRunDrainsLargeOutputAndReportsFailure() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("catscan-run-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let big = dir.appendingPathComponent("big").path
        // 2 MB on stdout and some stderr: reading only after exit would deadlock on the 64 KB pipe buffer.
        FileManager.default.createFile(
            atPath: big, contents: Data("#!/bin/sh\nhead -c 2097152 /dev/zero\necho warn >&2\n".utf8),
            attributes: [.posixPermissions: 0o755])
        let r = try Tesseract.run(big, [], timeout: 20)
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(r.stdout.count, 2_097_152)
        XCTAssertFalse(r.timedOut)

        let slow = dir.appendingPathComponent("slow").path
        FileManager.default.createFile(atPath: slow, contents: Data("#!/bin/sh\nexec sleep 30\n".utf8), attributes: [.posixPermissions: 0o755])
        XCTAssertTrue(try Tesseract.run(slow, [], timeout: 0.5).timedOut)

        // A grandchild holding stdout after the kill must not hang the run past the bound (pass 2 review).
        let held = dir.appendingPathComponent("held").path
        FileManager.default.createFile(
            atPath: held, contents: Data("#!/bin/sh\nsleep 30 &\nwait\n".utf8), attributes: [.posixPermissions: 0o755])
        let t0 = Date()
        XCTAssertTrue(try Tesseract.run(held, [], timeout: 0.5).timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 10) // gstack-timing-ok: the bound under test is 0.5 + 2 + 2 s

        // Exit 0 on time, but a grandchild keeps stdout: bounded, and flagged so it is never read as empty TSV.
        let leak = dir.appendingPathComponent("leak").path
        FileManager.default.createFile(
            atPath: leak, contents: Data("#!/bin/sh\nsleep 30 &\nexit 0\n".utf8), attributes: [.posixPermissions: 0o755])
        let t1 = Date()
        let r2 = try Tesseract.run(leak, [], timeout: 20)
        XCTAssertTrue(r2.pipesHeld)
        XCTAssertLessThan(Date().timeIntervalSince(t1), 10) // gstack-timing-ok: the bound under test is 2 s after exit

        let bad = dir.appendingPathComponent("bad").path
        FileManager.default.createFile(atPath: bad, contents: Data("#!/bin/sh\necho 'Error opening data file' >&2\nexit 1\n".utf8), attributes: [.posixPermissions: 0o755])
        let img = CGContext(
            data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!.makeImage()!
        let install = Tesseract.Install(path: bad, version: "9.9", packs: ["ell"], tessdata: nil)
        XCTAssertThrowsError(try Tesseract.recognize(img, install: install, langs: "ell+eng")) { e in
            let d = e as? Diagnostic
            XCTAssertEqual(d?.code, "fallback-failed")
            XCTAssertTrue(d?.message.contains("exited with status 1: Error opening data file") ?? false, d?.message ?? "")
        }
    }

    func testBMPRowsArePaddedAndBottomUp() {
        // Width 3: 9 bytes of pixels, padded to 12 per row.
        let ctx = CGContext(
            data: nil, width: 3, height: 2, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 1, width: 3, height: 1)) // Core Graphics y=1 is the top row
        let d = Tesseract.bmp(ctx.makeImage()!)!
        XCTAssertEqual(d.count, 54 + 12 * 2)
        XCTAssertEqual(Array(d[34..<38]), [24, 0, 0, 0]) // image size includes the padding
        XCTAssertEqual(Array(d[54..<57]), [0, 0, 0]) // bottom row first: black
        XCTAssertEqual(Array(d[66..<69]), [0, 0, 255]) // top row: red as BGR
    }

    func testGeorgianAndArmenianScripts() {
        XCTAssertEqual(Scripts.scripts(in: "პარამეტრები"), [.georgian])
        XCTAssertEqual(Scripts.scripts(in: "Կարգավորումներ"), [.armenian])
        XCTAssertTrue(Scripts.readable("ka").contains(.georgian))
        XCTAssertTrue(Scripts.readable("hy").contains(.armenian))
        XCTAssertFalse(Scripts.readable("en").contains(.georgian))
        XCTAssertFalse(Scripts.readable("ru").contains(.armenian))
        // sr-Latn runs srp_latn, which never outputs Cyrillic: a Cyrillic check must be unsupported, not pass.
        XCTAssertEqual(Scripts.readable("sr-Latn"), [.latin])
        XCTAssertEqual(Scripts.readable("sr-Latn-RS"), [.latin])
        XCTAssertEqual(Scripts.readable("sr"), [.latin, .cyrillic])
    }

    func testFallbackLocaleIsHintedNeverPicked() {
        let e = Engine(languages: .success(Languages.expected[27]!))
        e.tesseract = { _ in nil }
        var job = Job(command: "check")
        job.path = "/nonexistent.png"
        job.locale = "en"
        job.present = ["Συνέχεια"]
        let env = e.run(job)
        let w = env.warnings.first { $0.code == "locale-script-mismatch" }
        XCTAssertEqual(w?.hint, "--locale el")
        XCTAssertEqual(env.locale, "en")
        // Without --locale, a Greek check text still does not switch to el.
        job.locale = nil
        XCTAssertEqual(e.run(job).locale, "en")
    }

    // TODO-065 D6: the fix names the setup catscan found.
    func testFixNamesTheEffectiveSetup() {
        let brew = Tesseract.Install(path: "/opt/homebrew/bin/tesseract", version: "5.5.4", packs: ["eng"], tessdata: "/opt/homebrew/share/tessdata/")
        let own = Tesseract.Install(path: "/x/tesseract", version: "5.5.4", packs: ["eng"], tessdata: "/data/tess/")
        XCTAssertEqual(Tesseract.fix(missing: [], install: nil, env: [:]), "brew install tesseract tesseract-lang (about 650 MB), then rerun the same command")
        XCTAssertEqual(Tesseract.fix(missing: [], install: nil, env: ["CATSCAN_TESSERACT": "/x/t"]),
                       "CATSCAN_TESSERACT=/x/t is not a working tesseract: put one there, or change CATSCAN_TESSERACT where catscan is launched (the MCP server config, the CI job) and restart it")
        XCTAssertEqual(Tesseract.fix(missing: ["hrv"], install: brew, env: [:]), "brew install tesseract-lang (about 650 MB), then rerun the same command")
        // TESSDATA_PREFIX or another install: brew would fill a folder Tesseract does not read.
        XCTAssertEqual(Tesseract.fix(missing: ["hrv", "eng"], install: own, env: ["TESSDATA_PREFIX": "/data/tess/"]),
                       "add hrv.traineddata, eng.traineddata to /data/tess/, then rerun the same command")
        XCTAssertEqual(Tesseract.fix(missing: ["eng"], install: brew, env: [:]), "add eng.traineddata to /opt/homebrew/share/tessdata/, then rerun the same command")
        // eng ships with the tesseract formula, so tesseract-lang alone would not restore it.
        XCTAssertEqual(Tesseract.fix(missing: ["hrv", "eng"], install: brew, env: [:]), "add hrv.traineddata, eng.traineddata to /opt/homebrew/share/tessdata/, then rerun the same command")
    }

    // TODO-065 D5: a missing reader is probed again, at most once per interval, so an install needs no restart.
    func testProbeCacheRefreshesAtMostOncePerInterval() {
        let c = Tesseract.ProbeCache()
        var probes = 0
        var answer: Tesseract.Install? = nil
        let probe = { () -> Tesseract.Install? in probes += 1; return answer }
        XCTAssertNil(c.get(refresh: false, interval: 30, now: 100, probe: probe))
        XCTAssertNil(c.get(refresh: true, interval: 30, now: 110, probe: probe)) // inside the interval: cached
        XCTAssertEqual(probes, 1)
        answer = Tesseract.Install(path: "/t", version: "5.5.4", packs: ["eng"], tessdata: nil)
        XCTAssertEqual(c.get(refresh: true, interval: 30, now: 131, probe: probe)?.path, "/t")
        XCTAssertEqual(c.get(refresh: false, interval: 30, now: 500, probe: probe)?.path, "/t") // no refresh asked
        XCTAssertEqual(probes, 2)
    }

    // TODO-065 D5: a slow re-probe never blocks the serve pool; other callers read the cached value meanwhile.
    func testProbeCacheReprobesOutsideTheLock() {
        let c = Tesseract.ProbeCache()
        let old = Tesseract.Install(path: "/old", version: "5.5.4", packs: ["eng"], tessdata: nil)
        _ = c.get(refresh: false, interval: 30, now: 100) { old }
        let started = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = c.get(refresh: true, interval: 30, now: 200) {
                started.signal(); release.wait()
                return Tesseract.Install(path: "/new", version: "5.5.4", packs: ["eng"], tessdata: nil)
            }
            done.signal()
        }
        started.wait()
        var probedAgain = false
        // While the re-probe hangs: the cached value at once, and no second re-probe in the same interval.
        XCTAssertEqual(c.get(refresh: false, interval: 30, now: 201) { probedAgain = true; return nil }?.path, "/old")
        XCTAssertEqual(c.get(refresh: true, interval: 30, now: 202) { probedAgain = true; return nil }?.path, "/old")
        XCTAssertFalse(probedAgain)
        release.signal(); done.wait()
        XCTAssertEqual(c.get(refresh: false, interval: 30, now: 203) { nil }?.path, "/new")
    }

    // TODO-065 T3: every fallback locale has a self-test word for doctor --expect-locales.
    func testDoctorHasAWordForEveryFallbackLocale() {
        XCTAssertEqual(Set(Doctor.localeWords.keys), Set(Tesseract.locales))
    }

    func testDoctorLocaleSelfTestReportsATesseractFailureAsItsOwn() {
        let broken = Tesseract.Install(path: "/usr/bin/false", version: "5.5.4", packs: ["hrv", "eng"], tessdata: nil)
        let r = Doctor.localeSelfTest("hr", install: broken, timeout: 5)
        XCTAssertFalse(r.pass)
        XCTAssertEqual(r.error?.code, "fallback-failed") // an execution failure, never an install hint
        XCTAssertFalse(r.error?.hint?.contains("brew") ?? false)
    }

    // TODO-065 T3: a run that succeeds but reads the wrong text points at the language data, never at brew.
    func testDoctorLocaleSelfTestReportsAWrongReadAsALanguageDataProblem() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("catscan-fake-tess-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fake = dir.appendingPathComponent("tesseract")
        let header = ["level", "page_num", "block_num", "par_num", "line_num", "word_num", "left", "top", "width", "height", "conf", "text"].joined(separator: "\\t")
        try "#!/bin/sh\nprintf '\(header)\\n'\n".write(to: fake, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.path)
        let install = Tesseract.Install(path: fake.path, version: "5.5.4", packs: ["srp", "eng"], tessdata: "/t/")
        let r = Doctor.localeSelfTest("sr", langs: "srp", install: install, timeout: 5)
        XCTAssertFalse(r.pass)
        XCTAssertEqual(r.error?.code, "self-test-failed")
        XCTAssertEqual(r.error?.hint, "check the srp language data in /t/; reinstall it if it is damaged")
    }

    func testDoctorLocaleSelfTestReadsEveryLocaleWithTheRealTesseract() throws {
        guard let t = Tesseract.installed(), Tesseract.locales.allSatisfy({ l in (Tesseract.pack(for: l)!.split(separator: "+").map(String.init) + ["eng"]).allSatisfy(t.packs.contains) }) else {
            throw XCTSkip("needs Tesseract with tesseract-lang (the self-hosted runner has it)")
        }
        for l in Tesseract.locales {
            let r = Doctor.localeSelfTest(l, install: t, timeout: 15)
            XCTAssertTrue(r.pass, "\(l): \(r.error?.message ?? "")")
        }
    }
}
