// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// catscan-core: the Swift binary behind @catscan/cli. Recognition, rules and JSON Lines only;
// the Node layer owns argument parsing, rendering and the exit code (spec 00).
//
//   catscan-core serve [--jobs N]   JSON Lines requests on stdin, one response per line on stdout
//   catscan-core version [--json]   catscan version, macOS version and the Vision request revision
//   catscan-core languages          the language table against this Mac's Vision, as JSON (spec 04)
//   catscan-core doctor [--expect-locales a,b]   version, host and the Tesseract fallback, as JSON (spec 03;
//                                   spec 08 extends it; TODO-065 T3 adds a reader and self-test per listed locale)
import CatscanCore
import Foundation

let args = Array(CommandLine.arguments.dropFirst())

func usage() -> Never {
    FileHandle.standardError.write(Data("usage: catscan-core serve [--jobs N] | version [--json] | languages | doctor [--expect-locales a,b]\n".utf8))
    exit(2)
}

switch args.first {
case "serve":
    var jobs = 2
    if let i = args.firstIndex(of: "--jobs") {
        guard i + 1 < args.count, let n = Int(args[i + 1]), n >= 1, n <= 16 else { usage() }
        jobs = n
    }
    Tesseract.cleanUpOnSignals()
    if let v = ProcessInfo.processInfo.environment["CATSCAN_VISION_TIMEOUT"],
        Engine.visionTimeout(["CATSCAN_VISION_TIMEOUT": v]) == Engine.defaultVisionTimeout, Double(v) != Engine.defaultVisionTimeout {
        FileHandle.standardError.write(Data("catscan-core: CATSCAN_VISION_TIMEOUT=\(v) is not a positive number of seconds; using \(Int(Engine.defaultVisionTimeout))\n".utf8))
    }
    Server(engine: Engine(), jobs: jobs).run()
case "version", "--version":
    let e = Engine()
    if args.contains("--json") {
        let o: [String: Any] = [
            "catscan": catscanVersion, "macos": Host.macOS(), "macos_build": Host.macOSBuild(),
            "vision_revision": e.revision, "engine": e.engineName, "locales": e.locales,
            "host": [
                "chip": e.host.chip, "arch": e.host.arch, "host_class": e.host.host_class, "macos": e.host.macos,
                "vision_revision": e.host.vision_revision,
            ] as [String: Any],
        ]
        let d = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
        FileHandle.standardOutput.write(d + Data([0x0A]))
    } else {
        print("catscan \(catscanVersion)")
        print("macOS \(Host.macOS()) (\(Host.macOSBuild()))")
        print("Vision VNRecognizeTextRequest revision \(e.revision)")
    }
case "languages":
    let e = Engine()
    if let why = e.languagesError {
        let err: [String: Any] = ["error": [
            "code": "vision-languages-failed", "message": "Vision could not list its recognition languages: \(why)",
            "hint": "rerun; if it persists, report it with the output of catscan --version",
        ]]
        FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: err, options: [.sortedKeys]) + Data([0x0A]))
        exit(5)
    }
    let d = try! JSONSerialization.data(withJSONObject: languagesReport(e), options: [.sortedKeys])
    FileHandle.standardOutput.write(d + Data([0x0A]))
case "doctor":
    var requested: [String]? = nil
    if let i = args.firstIndex(of: "--expect-locales") {
        guard i + 1 < args.count else { usage() }
        requested = args[i + 1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    let e = Engine()
    let d = try! JSONSerialization.data(withJSONObject: doctorReport(e, requested: requested), options: [.sortedKeys, .withoutEscapingSlashes])
    FileHandle.standardOutput.write(d + Data([0x0A]))
default:
    usage()
}

/// `catscan doctor --json` (spec 03 D1), with the spec 08 D3 fields; the Node layer adds its checks (spec 08 D8).
func doctorReport(_ e: Engine, requested: [String]? = nil) -> [String: Any] {
    // TODO-065 T3: the locale budget counts from here and the Vision self-test runs first, so every stage fits in
    // the launcher's 60 s timeout (client.js) and a slow locale gets its own row, never binary-failed.
    let started = ProcessInfo.processInfo.systemUptime
    let selfTest = Doctor.selfTest(e)
    let env = ProcessInfo.processInfo.environment
    let t = Tesseract.probe(env: env)
    // eng as well: the fallback always runs <pack>+eng.
    let packsOf = { (pack: String) in (pack.split(separator: "+").map(String.init) + ["eng"]).filter { !(t?.packs.contains($0) ?? false) } }
    let missingPacks = { (l: String) in packsOf(Tesseract.pack(for: l)!) }
    // Each listed locale gets its reader; a Tesseract locale is read for real with the packs a check would use
    // (sr-Cyrl: srp, not the sr row's srp+srp_latn), one self-test per pack.
    var tests: [String: Doctor.LocaleTest] = [:]
    var rows: [[String: Any]] = []
    for loc in requested ?? [] {
        var row: [String: Any] = ["locale": loc]
        if e.resolve(loc) != nil {
            row["reader"] = "vision"; row["ok"] = true
        } else if let pack = Tesseract.pack(for: loc) {
            // The fallback table row that reads it: el-GR -> el, sr-Cyrl -> sr.
            let base = Tesseract.locales.first { Tesseract.pack(for: $0) == pack }
                ?? Tesseract.locales.first { loc.lowercased().hasPrefix($0.lowercased() + "-") } ?? loc
            row["reader"] = "tesseract"; row["fallback_locale"] = base
            let missing = packsOf(pack)
            var err: Diagnostic? = nil
            if let t, missing.isEmpty {
                let left = Doctor.localeBudget - (ProcessInfo.processInfo.systemUptime - started)
                if let done = tests[pack] {
                    err = done.error
                    row["self_test"] = ["ms": done.ms, "pass": done.pass] as [String: Any]
                } else if left < Doctor.localeMinimum {
                    err = Diagnostic("self-test-skipped", "doctor ran out of its \(Int(Doctor.localeBudget)) s self-test budget before \(loc).",
                                     hint: "catscan doctor --expect-locales \(loc)")
                } else {
                    let r = Doctor.localeSelfTest(base, langs: pack, install: t, timeout: min(Doctor.localeTimeout, left))
                    tests[pack] = r
                    err = r.error
                    row["self_test"] = ["ms": r.ms, "pass": r.pass] as [String: Any]
                }
            } else {
                let what = t == nil ? "which is not installed on this Mac" : "but Tesseract \(t!.version) has no \(missing.joined(separator: ", ")) language data in \(t!.tessdata ?? "its tessdata directory")"
                err = Diagnostic("reader-missing", "catscan reads the locale \(loc) with Tesseract, \(what).",
                                 hint: Tesseract.fix(missing: t == nil ? [] : missing, install: t, env: env))
            }
            row["ok"] = err == nil
            if let err { row["error"] = ["code": err.code, "message": err.message, "hint": err.hint.map { $0 as Any } ?? NSNull()] as [String: Any] }
        } else {
            row["reader"] = NSNull(); row["ok"] = false
            row["error"] = ["code": "unsupported-language", "message": "No reader in catscan reads the locale \(loc).",
                            "hint": Languages.corrections[loc.lowercased()].map { "--expect-locales \($0)" } ?? "catscan languages lists the locales catscan reads"] as [String: Any]
        }
        rows.append(row)
    }
    let locales = Tesseract.locales.map { l -> [String: Any] in
        let packs = Tesseract.pack(for: l)!.split(separator: "+").map(String.init)
        let missing = missingPacks(l)
        var o: [String: Any] = ["locale": l, "packs": packs, "installed": t != nil && missing.isEmpty, "missing": missing]
        if let r = tests[Tesseract.pack(for: l)!] { o["self_test"] = ["ms": r.ms, "pass": r.pass] as [String: Any] }
        return o
    }
    let allMissing = t == nil ? [] : Array(Set(Tesseract.locales.flatMap(missingPacks))).sorted()
    var report: [String: Any] = [
        "schema": 1, "catscan": catscanVersion, "engine": e.engineName, "host": [
            "chip": e.host.chip, "arch": e.host.arch, "host_class": e.host.host_class, "macos": e.host.macos,
            "vision_revision": e.host.vision_revision, "macos_build": Host.macOSBuild(),
        ] as [String: Any],
        "neural_engine": Doctor.neuralEngine(),
        "vision": [
            "revision": e.revision,
            "languages": ["accurate": e.visionLanguages.count, "fast": Doctor.fastLanguages()?.count ?? 0],
        ] as [String: Any],
        "self_test": ["ms": selfTest.ms, "pass": selfTest.pass] as [String: Any],
        "fallback": [
            "engine": t.map { $0.engineName as Any } ?? NSNull(), "path": t.map { $0.path as Any } ?? NSNull(),
            "version": t.map { $0.version as Any } ?? NSNull(), "tessdata": t?.tessdata.map { $0 as Any } ?? NSNull(),
            "packs": t?.packs ?? [], "searched": Tesseract.candidates(env: env), "locales": locales,
            // TODO-065 D6: the one fix for the doctor tesseract row, from the same function as the verdict hints.
            "fix": allMissing.isEmpty && t != nil ? NSNull() : Tesseract.fix(missing: allMissing, install: t, env: env) as Any,
        ] as [String: Any],
    ]
    if requested != nil { report["requested"] = rows }
    return report
}

/// `catscan languages --json`: the source for doctor, the MCP server and the docs (spec 04).
func languagesReport(_ e: Engine) -> [String: Any] {
    let live = e.visionLanguages
    let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
    let rows = Languages.rows(adding: live)
    var table: [String: Any] = ["macos": major, "known": false, "matches": false, "added": live, "removed": []]
    if let diff = Languages.compare(live, macOSMajor: major) {
        table = [
            "macos": major, "known": true, "matches": diff.added.isEmpty && diff.removed.isEmpty,
            "added": diff.added, "removed": diff.removed,
        ]
    }
    return [
        "schema": 1, "catscan": catscanVersion, "engine": e.engineName, "host": [
            "chip": e.host.chip, "arch": e.host.arch, "host_class": e.host.host_class, "macos": e.host.macos,
            "vision_revision": e.host.vision_revision,
        ] as [String: Any],
        "os_table": table,
        // TODO-037 D10: the locales the Tesseract fallback reads when installed; doctor says which packs are.
        "fallback_locales": Tesseract.locales,
        "languages": rows.map { r -> [String: Any] in
            // A language newer than the table: catscan knows nothing about its script (TODO-003 D11).
            let inTable = Languages.catalog.contains { $0.vision == r.vision }
            return [
                "locale": r.locale, "vision": r.vision, "aliases": r.aliases, "script": r.script,
                "direction": inTable ? (TextMatch.isRightToLeft(r.locale) ? "rtl" : "ltr") : NSNull(),
                "no_spaces": inTable ? TextMatch.isUnspaced(r.locale) as Any : NSNull(),
                "in_table": inTable, "supported": live.contains(r.vision),
                "fallback": NSNull(), // a locale Vision reads never uses the fallback (spec 03); see doctor
            ]
        },
    ]
}
