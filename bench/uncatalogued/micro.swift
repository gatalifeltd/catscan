// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T4 D53 microbenchmark: `Uncatalogued.evaluate` alone, 20 all-miss lines per image against 13 catalogs of
// 1,100 strings, no Vision. bench/uncatalogued.js builds it with the core sources into one module, so it times
// the release-built rule exactly as the core runs it.
// Prints JSON: {catalogs, strings, lines, images, ms_per_image (median of 5 runs of 20 images), budget_ms, pass}.
import CoreGraphics
import Foundation

// argv[1]: bench/wrong-language/strings.json; each locale's catalog is 1,100 strings drawn from its own words, as
// the end-to-end perf run in bench/uncatalogued.js builds them.
let strings = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let byLocale = strings["locales"] as! [String: [String]]
let locales = byLocale.keys.sorted()
var seed: UInt64 = 36004
func next() -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int(seed >> 33) }
var entries: [UncataloguedJob.Entry] = []
for l in locales {
    let words = Array(Set(byLocale[l]!.flatMap { $0.split(separator: " ").map(String.init) }.filter { $0.count >= 3 })).sorted()
    for i in 0..<1100 {
        let t = (0..<3).map { _ in words[next() % words.count] }.joined(separator: " ") + " \(i)"
        entries.append(.init(key: "screen.k\(i)", locale: l, text: t, forms: [.init(fragments: [t])]))
    }
}
let job = UncataloguedJob(entries: entries)
let missing = ["Lade deine Freunde zu einer neuen Runde ein", "Diese Funktion ist bald für alle verfügbar",
               "Prüfe deine Verbindung und versuche es erneut", "Wir haben dein Feedback erhalten, danke"]
let lines = (0..<20).map { i in
    RecognizedLine(text: missing[i % missing.count] + " \(i)x", rect: CGRect(x: 0.05, y: 0.05 + Double(i) * 0.045, width: 0.9, height: 0.03), confidence: 0.9)
}
_ = Uncatalogued.evaluate(job, lines: lines, locale: "de", aspect: 0.46) // builds the index once, as the first image does
var runs: [Double] = []
for _ in 0..<5 {
    let t0 = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<20 { _ = Uncatalogued.evaluate(job, lines: lines, locale: "de", aspect: 0.46) }
    runs.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6 / 20)
}
let ms = runs.sorted()[2]
let out: [String: Any] = ["catalogs": locales.count, "strings": entries.count, "lines": lines.count, "images": 20,
                          "ms_per_image": (ms * 10).rounded() / 10, "budget_ms": 50, "pass": ms <= 50]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
