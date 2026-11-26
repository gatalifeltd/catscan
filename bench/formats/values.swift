// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-036 T3 bench (D33, D39): Foundation renderings for the synthetic set, so seeded values are real CLDR formats
// of the same macOS the core reads. Reads a JSON array of requests on stdin, prints a JSON array of strings.
//   {"t":"num","l":"de","v":"1234.56","f":2}            decimal number with f fraction digits
//   {"t":"cur","l":"de","c":"EUR","v":"9.99"}            currency, standard symbol
//   {"t":"date","l":"de","y":2026,"m":11,"d":25,"tpl":"yyyyMMdd"|null}  short date, or the locale's order of a template
//   {"t":"time","l":"de","h":15,"mi":5,"tpl":"hmma"|null}  short time, or a template (`hmma`: 12-hour with AM/PM)
//   {"t":"fingerprint","l":["de",...]}                  the patterns the rules read, one line per locale
// Usage: swiftc -O bench/formats/values.swift -o <bin> && <bin> < requests.json
import Foundation

func fold(_ s: String) -> String {
    s.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
}

let utc = TimeZone(identifier: "UTC")!
var cal = Calendar(identifier: .gregorian)
cal.timeZone = utc

let reqs = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
var out: [String] = []
for r in reqs {
    let t = r["t"] as! String
    if t == "fingerprint" {
        var lines: [String] = []
        for id in r["l"] as! [String] {
            let l = Locale(identifier: id)
            let nf = NumberFormatter(); nf.locale = l; nf.numberStyle = .decimal
            let cf = NumberFormatter(); cf.locale = l; cf.numberStyle = .currency
            let df = DateFormatter(); df.locale = l; df.dateStyle = .short
            let tf = DateFormatter(); tf.locale = l; tf.timeStyle = .short
            let j = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: l) ?? ""
            lines.append([id, nf.decimalSeparator ?? "", nf.groupingSeparator ?? "", cf.positiveFormat ?? "", df.dateFormat ?? "", tf.dateFormat ?? "", j, tf.amSymbol, tf.pmSymbol].joined(separator: "|"))
        }
        out.append(lines.joined(separator: "\n"))
        continue
    }
    let l = Locale(identifier: r["l"] as! String)
    switch t {
    case "num":
        let nf = NumberFormatter(); nf.locale = l; nf.numberStyle = .decimal
        let f = r["f"] as! Int
        nf.minimumFractionDigits = f; nf.maximumFractionDigits = f
        out.append(fold(nf.string(from: NSDecimalNumber(string: r["v"] as? String)) ?? ""))
    case "cur":
        let nf = NumberFormatter(); nf.locale = l; nf.numberStyle = .currency
        nf.currencyCode = r["c"] as? String
        out.append(fold(nf.string(from: NSDecimalNumber(string: r["v"] as? String)) ?? ""))
    case "date", "time":
        var c = DateComponents()
        c.year = r["y"] as? Int ?? 2026; c.month = r["m"] as? Int ?? 1; c.day = r["d"] as? Int ?? 1
        c.hour = r["h"] as? Int ?? 0; c.minute = r["mi"] as? Int ?? 0
        let df = DateFormatter(); df.locale = l; df.timeZone = utc
        if let tpl = r["tpl"] as? String { df.setLocalizedDateFormatFromTemplate(tpl) }
        else if t == "date" { df.dateStyle = .short } else { df.timeStyle = .short }
        out.append(fold(df.string(from: cal.date(from: c)!)))
    default:
        fatalError("unknown request \(t)")
    }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))
