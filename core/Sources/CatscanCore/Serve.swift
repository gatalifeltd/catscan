// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation

/// `serve`: JSON Lines over stdin and stdout (spec 01). Requests are answered in order; a small pool
/// overlaps decode with recognition.
public final class Server {
    public static let maxLine = 64 * 1024 * 1024
    static let available: Set<String> = ["check", "read", "untranslated", "video", "truncated", "overlap", "formats", "glyphs", "fit", "contrast"]
    static let planned: Set<String> = []

    let engine: Engine
    /// D32: `untranslated` fields by digest, so a run sends its catalogs once; the newest 4 are kept.
    var fields: [(String, UntranslatedJob)] = []
    /// TODO-039 T2: `pseudo` fields by digest, the same way; the newest 4 are kept.
    var pseudoFields: [(String, PseudoJob)] = []
    var uncataloguedFields: [(String, UncataloguedJob)] = []
    let pool: DispatchSemaphore
    let queue = DispatchQueue(label: "catscan.serve", attributes: .concurrent)
    let group = DispatchGroup()
    let lock = NSLock()
    var pending: [Int: Data] = [:]
    var nextOut = 0

    public init(engine: Engine, jobs: Int) {
        self.engine = engine
        pool = DispatchSemaphore(value: max(1, jobs))
    }

    public func run(input: Int32 = 0) {
        write(-1, JSONLine.encode(ReadyLine(visionTimeout: engine.visionTimeout, engine: engine.engineName, host: engine.host)))
        var buf = Data()
        var dropping = false // inside an oversized line
        var droppedHead = Data()
        var seq = 0
        var chunk = [UInt8](repeating: 0, count: 1 << 20)
        while true {
            let n = read(input, &chunk, chunk.count)
            if n <= 0 { break }
            var start = 0
            for i in 0..<n where chunk[i] == 0x0A {
                let piece = Data(chunk[start..<i])
                start = i + 1
                if dropping {
                    respondOversized(seq, droppedHead)
                    dropping = false
                    droppedHead = Data()
                } else if buf.count + piece.count > Server.maxLine {
                    respondOversized(seq, (buf + piece).prefix(4096))
                    buf = Data()
                } else {
                    buf.append(piece)
                    handle(seq, buf)
                    buf = Data()
                }
                seq += 1
            }
            let rest = chunk[start..<n]
            if dropping { continue }
            if buf.count + rest.count > Server.maxLine {
                dropping = true
                droppedHead = (buf + rest).prefix(4096)
                buf = Data()
            } else {
                buf.append(contentsOf: rest)
            }
        }
        if dropping { respondOversized(seq, droppedHead); seq += 1 }
        else if !buf.isEmpty { handle(seq, buf); seq += 1 }
        group.wait()
    }

    func respondOversized(_ seq: Int, _ head: Data) {
        // Recover the id from the start of the line, so the client can match the error.
        var id: String? = nil
        let re = try! NSRegularExpression(pattern: #""id"\s*:\s*"((?:[^"\\]|\\.)*)""#)
        if let s = String(data: head, encoding: .utf8),
            let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
            let r = Range(m.range(at: 1), in: s) {
            id = String(s[r])
        }
        write(seq, JSONLine.encode(ErrorResponse(
            id: id, error: Diagnostic("request-too-large", "The request line is over the 64 MB limit."))))
    }

    func handle(_ seq: Int, _ line: Data) {
        let trimmed = line.drop(while: { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D })
        if trimmed.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) {
            write(seq, Data()) // blank line: no response, but keep the order counter moving
            return
        }
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            write(seq, JSONLine.encode(ErrorResponse(
                id: nil, error: Diagnostic("invalid-json", "The request line is not a JSON object."))))
            return
        }
        let id = obj["id"] as? String
        func fail(_ code: String, _ message: String) {
            write(seq, JSONLine.encode(ErrorResponse(id: id, error: Diagnostic(code, message))))
        }
        if let raw = obj["id"], !(raw is String), !(raw is NSNull) {
            return fail("invalid-request", "id must be a string.")
        }
        guard let command = obj["command"] as? String else { return fail("invalid-request", "command is missing.") }
        if command == "thumbnail" {
            // Spec 18 D6: a report image, not an envelope; it holds a pool slot like any request.
            let job: ThumbnailJob
            switch Thumbnail.parse(obj) {
            case .success(let j): job = j
            case .failure(let d): return fail(d.code, d.message)
            }
            pool.wait()
            group.enter()
            queue.async {
                switch Thumbnail.make(job) {
                case .success(let (w, h, data)):
                    self.write(seq, JSONLine.encode(ThumbnailResponse(id: id, width: w, height: h, jpeg: data.base64EncodedString())))
                case .failure(let d):
                    self.write(seq, JSONLine.encode(ErrorResponse(id: id, error: d)))
                }
                self.pool.signal()
                self.group.leave()
            }
            return
        }
        if Server.planned.contains(command) {
            return fail("command-not-available", "The command \(command) is not available in this version.")
        }
        if !Server.available.contains(command) { return fail("unknown-command", "Unknown command \(command).") }
        var job = Job(command: command)
        if command == "video" {
            // D3: a video is read from its path; it never fits the request line.
            guard obj["image"] == nil, let p = obj["path"] as? String else {
                return fail("invalid-request", "A video request needs path; image is not accepted.")
            }
            switch Server.videoOptions(obj) {
            case .success(let o): job.video = o
            case .failure(let d): return fail(d.code, d.message)
            }
            job.path = p
        } else if let s = obj["image"] {
            guard let b64 = s as? String, let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
                return fail("invalid-request", "image must be base64.")
            }
            job.image = d
        } else if let p = obj["path"] as? String {
            job.path = p
        } else {
            return fail("invalid-request", "The request needs image or path.")
        }
        job.name = obj["name"] as? String
        switch Server.checks(obj) {
        case .success(let c): (job.present, job.absent, job.catalog) = c
        case .failure(let d): return fail(d.code, d.message)
        }
        if let v = obj["inventory"] {
            guard let a = v as? [Any] else { return fail("invalid-request", "inventory must be an array.") }
            var inv: [CatalogCheck] = []
            for item in a {
                guard let c = Server.catalogCheck(item, kind: "present") else {
                    return fail("invalid-request", "inventory items must be catalog checks {key, text, alternatives}.")
                }
                inv.append(c)
            }
            job.inventory = inv
        }
        if let v = obj["untranslated"] {
            let o = v as? [String: Any]
            if let o, o["digest"] != nil, !(o["digest"] is String) { return fail("invalid-request", "untranslated.digest must be a string.") }
            let digest = o?["digest"] as? String
            if let digest, o?.count == 1 {
                guard let u = fields.first(where: { $0.0 == digest })?.1 else {
                    return fail("invalid-request", "untranslated.digest \(digest) is not known to this process; send the full field with it first.")
                }
                job.untranslated = u
            } else {
                switch Server.untranslatedJob(v) {
                case .success(let u):
                    job.untranslated = u
                    if let digest {
                        fields.removeAll { $0.0 == digest }
                        fields.append((digest, u))
                        if fields.count > 4 { fields.removeFirst() }
                    }
                case .failure(let d): return fail("invalid-request", d.message)
                }
            }
        }
        if let v = obj["truncated"] {
            switch Server.truncationJob(v) {
            case .success(let t): job.truncated = t
            case .failure(let d): return fail(d.code, d.message)
            }
        }
        if let v = obj["pseudo"] {
            guard let o = v as? [String: Any] else { return fail("invalid-request", "pseudo must be an object.") }
            if o["digest"] != nil, !(o["digest"] is String) { return fail("invalid-request", "pseudo.digest must be a string.") }
            let digest = o["digest"] as? String
            var p: PseudoJob
            if let digest, o["entries"] == nil {
                guard let cached = pseudoFields.first(where: { $0.0 == digest })?.1 else {
                    return fail("invalid-request", "pseudo.digest \(digest) is not known to this process; send the full field with it first.")
                }
                p = cached
            } else {
                switch Server.pseudoJob(o) {
                case .success(let j):
                    p = j
                    if let digest {
                        pseudoFields.removeAll { $0.0 == digest }
                        pseudoFields.append((digest, j))
                        if pseudoFields.count > 4 { pseudoFields.removeFirst() }
                    }
                case .failure(let d): return fail(d.code, d.message)
                }
            }
            // Per image: elements with `dynamic: true` in its boxes file (TODO-036 check 4 guard).
            if let r = o["dynamic_rects"] {
                guard let a = r as? [[Double]], a.allSatisfy({ $0.count == 4 }) else {
                    return fail("invalid-request", "pseudo.dynamic_rects must be an array of [x, y, width, height].")
                }
                p.guards.rects = a.map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) }
            }
            if let s = o["dynamic_size"] {
                guard let a = s as? [Double], a.count == 2, a[0] > 0, a[1] > 0 else {
                    return fail("invalid-request", "pseudo.dynamic_size must be [width, height] above 0.")
                }
                p.rectsSize = (a[0], a[1])
            }
            job.pseudo = p
        }
        if let v = obj["uncatalogued"] {
            guard let o = v as? [String: Any] else { return fail("invalid-request", "uncatalogued must be an object.") }
            if o["digest"] != nil, !(o["digest"] is String) { return fail("invalid-request", "uncatalogued.digest must be a string.") }
            let digest = o["digest"] as? String
            var u: UncataloguedJob
            if let digest, o["entries"] == nil {
                guard let cached = uncataloguedFields.first(where: { $0.0 == digest })?.1 else {
                    return fail("invalid-request", "uncatalogued.digest \(digest) is not known to this process; send the full field with it first.")
                }
                u = cached
            } else {
                switch Server.uncataloguedJob(o) {
                case .success(let j):
                    u = j
                    if let digest {
                        uncataloguedFields.removeAll { $0.0 == digest }
                        uncataloguedFields.append((digest, j))
                        if uncataloguedFields.count > 4 { uncataloguedFields.removeFirst() }
                    }
                case .failure(let d): return fail(d.code, d.message)
                }
            }
            // Per image: elements with `dynamic: true` in its boxes file (D51, as pseudo).
            if let r = o["dynamic_rects"] {
                guard let a = r as? [[Double]], a.allSatisfy({ $0.count == 4 }) else {
                    return fail("invalid-request", "uncatalogued.dynamic_rects must be an array of [x, y, width, height].")
                }
                u.guards.rects = a.map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) }
            }
            if let s = o["dynamic_size"] {
                guard let a = s as? [Double], a.count == 2, a[0] > 0, a[1] > 0 else {
                    return fail("invalid-request", "uncatalogued.dynamic_size must be [width, height] above 0.")
                }
                u.rectsSize = (a[0], a[1])
            }
            job.uncatalogued = u
        }
        if let v = obj["overlap"] {
            switch Server.overlapJob(v) {
            case .success(let o): job.overlap = o
            case .failure(let d): return fail(d.code, d.message)
            }
        }
        if let v = obj["formats"] {
            switch Server.formatsJob(v) {
            case .success(let f): job.formats = f
            case .failure(let d): return fail(d.code, d.message)
            }
        }
        if let v = obj["contrast"] {
            switch Server.contrastJob(v) {
            case .success(let x): job.contrast = x
            case .failure(let d): return fail(d.code, d.message)
            }
        }
        if let v = obj["fit"] {
            switch Server.fitJob(v) {
            case .success(let f): job.fit = f
            case .failure(let d): return fail(d.code, d.message)
            }
        }
        if let v = obj["glyphs"] {
            switch Server.glyphsJob(v) {
            case .success(let g): job.glyphs = g
            case .failure(let d): return fail(d.code, d.message)
            }
        }
        if let v = obj["text_record"] {
            switch Server.textRecordJob(v) {
            case .success(let t): job.textRecord = t
            case .failure(let d): return fail(d.code, d.message)
            }
        }
        if let l = obj["locale"] {
            guard let s = l as? String, !s.isEmpty else { return fail("invalid-request", "locale must be a non-empty string.") }
            job.locale = s
        }
        if let f = obj["fallback"] {
            guard let s = f as? String, ["tesseract", "none"].contains(s) else {
                return fail("invalid-request", "fallback must be \"tesseract\" or \"none\".")
            }
            job.fallback = s
        }
        pool.wait()
        group.enter()
        queue.async {
            var env = self.engine.run(job)
            env.id = .some(id)
            self.write(seq, JSONLine.encode(env))
            self.pool.signal()
            self.group.leave()
        }
    }

    /// `present` and `absent`: strings or catalog checks; the catalog checks follow the literal ones (spec 02).
    static func checks(_ obj: [String: Any]) -> Result<([String], [String], [CatalogCheck]), Diagnostic> {
        var present: [String] = [], absent: [String] = [], catalog: [CatalogCheck] = []
        for key in ["present", "absent"] {
            guard let v = obj[key] else { continue }
            guard let a = v as? [Any] else { return .failure(Diagnostic("invalid-request", "\(key) must be an array.")) }
            var texts: [String] = []
            for item in a {
                if let s = item as? String { texts.append(s); continue }
                guard let c = Server.catalogCheck(item, kind: key) else {
                    return .failure(Diagnostic("invalid-request", "\(key) items must be strings or catalog checks {key, text, alternatives}."))
                }
                catalog.append(c)
            }
            if key == "present" { present = texts } else { absent = texts }
        }
        return .success((present, absent, catalog))
    }

    /// `every`, `from`, `to`, `frames` and `ranges` of a video request (spec 07 D3, D7).
    static func videoOptions(_ obj: [String: Any]) -> Result<VideoOptions, Diagnostic> {
        func bad(_ m: String) -> Result<VideoOptions, Diagnostic> { .failure(Diagnostic("invalid-request", m)) }
        func seconds(_ v: Any?) -> Double? {
            guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
            return n.doubleValue
        }
        func number(_ k: String) -> Double?? {
            guard let v = obj[k] else { return .some(nil) }
            // JSON true/false also bridge to NSNumber; only a real number is seconds.
            guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
            return .some(n.doubleValue)
        }
        var o = VideoOptions()
        guard let every = number("every"), let from = number("from"), let to = number("to") else {
            return bad("every, from and to must be numbers of seconds.")
        }
        if let every { guard every > 0 else { return bad("every must be above 0.") }; o.every = every }
        if let from { guard from >= 0 else { return bad("from must be 0 or more.") }; o.from = from }
        if let to { guard to > o.from else { return bad("to must be above from.") }; o.to = to }
        if let f = obj["frames"] {
            guard let n = f as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                return bad("frames must be true or false.")
            }
            o.frames = n.boolValue
        }
        if let v = obj["ranges"] {
            guard let a = v as? [[String: Any]] else { return bad("ranges must be an array of objects.") }
            for r in a {
                guard let key = r["key"] as? String, let start = seconds(r["start"]), start >= 0,
                    r["end"] == nil || r["end"] is NSNull || seconds(r["end"]).map({ $0 >= start }) == true
                else { return bad("ranges items need key, start >= 0 and end >= start or null.") }
                var range = VideoRange(key: key, start: start, end: seconds(r["end"]))
                switch checks(r) {
                case .success(let c): (range.present, range.absent, range.catalog) = c
                case .failure(let d): return .failure(Diagnostic(d.code, "ranges: \(d.message)"))
                }
                o.ranges.append(range)
            }
        }
        return .success(o)
    }

    /// The `text_record` field (TODO-038 T1): `{mode: full|digest, ignore?: [regex], ignore_digest?: string}`.
    static func textRecordJob(_ v: Any) -> Result<TextRecordJob, Diagnostic> {
        func bad(_ m: String) -> Result<TextRecordJob, Diagnostic> { .failure(Diagnostic("invalid-request", "text_record.\(m)")) }
        guard let o = v as? [String: Any] else { return bad("text_record must be an object.") }
        guard let mode = o["mode"] as? String, ["full", "digest"].contains(mode) else { return bad("mode must be \"full\" or \"digest\".") }
        var t = TextRecordJob(mode: mode)
        if let d = o["ignore_digest"], !(d is NSNull) {
            guard let s = d as? String else { return bad("ignore_digest must be a string.") }
            t.ignoreDigest = s
        }
        if let i = o["ignore"] {
            guard let a = i as? [String] else { return bad("ignore must be an array of strings.") }
            for p in a {
                guard let re = try? NSRegularExpression(pattern: p) else { return bad("ignore has an invalid pattern: \(p)") }
                t.ignore.append(re)
            }
        }
        return .success(t)
    }

    /// The `overlap` field (spec 12 D1): `{min_overlap, boxes?, allow?}` (TODO-046: boxes as `truncated`, allow strings).
    static func overlapJob(_ v: Any) -> Result<OverlapJob, Diagnostic> {
        guard let o = v as? [String: Any] else { return .failure(Diagnostic("invalid-request", "overlap must be an object.")) }
        var t = OverlapJob()
        if let m = o["min_overlap"] {
            guard let n = m as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue > 0, n.doubleValue <= 1 else {
                return .failure(Diagnostic("invalid-request", "overlap.min_overlap must be a number in (0, 1]."))
            }
            t.minOverlap = n.doubleValue
        }
        if let a = o["allow"] {
            guard let s = a as? [String] else { return .failure(Diagnostic("invalid-request", "overlap.allow must be an array of strings.")) }
            t.allow = s
        }
        if let c = o["occlusion"] { // TODO-049 D11: `--experimental` with boxes
            guard let n = c as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                return .failure(Diagnostic("invalid-request", "overlap.occlusion must be true or false."))
            }
            t.occlusion = n.boolValue
        }
        if let c = o["stacked"] { // TODO-067 D3
            guard let n = c as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                return .failure(Diagnostic("invalid-request", "overlap.stacked must be true or false."))
            }
            t.stacked = n.boolValue
        }
        if let c = o["geometry"] { // TODO-067 D17
            guard let n = c as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                return .failure(Diagnostic("invalid-request", "overlap.geometry must be true or false."))
            }
            t.geometry = n.boolValue
        }
        if !t.geometry && !t.stacked && o["boxes"] == nil { // D35: a request that runs no reader is never a pass
            return .failure(Diagnostic("invalid-request", "overlap.geometry false needs overlap.stacked true or boxes: no reader would run."))
        }
        if let n = o["no_boxes"] {
            guard let d = n as? [String: Any], let looked = d["looked"] as? String, !looked.isEmpty else {
                return .failure(Diagnostic("invalid-request", "overlap.no_boxes must be {looked: string}."))
            }
            t.noBoxes = looked
        }
        if let b = o["boxes"] {
            switch boxesField(b, field: "overlap") {
            case .success(let x): t.boxes = x
            case .failure(let d): return .failure(d)
            }
        }
        return .success(t)
    }

    /// TODO-073: the profile table by path, parsed once; one entry, so a client that sends many paths cannot grow it.
    nonisolated(unsafe) static var tables: [String: [DeviceProfile]] = [:]
    static let tablesLock = NSLock()

    static func table(_ path: String) -> [DeviceProfile]? {
        tablesLock.lock()
        defer { tablesLock.unlock() }
        if let t = tables[path] { return t }
        guard let d = FileManager.default.contents(atPath: path), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let rows = o["profiles"] as? [Any] else { return nil }
        let t = rows.compactMap(DeviceProfile.parse)
        guard t.count == rows.count else { return nil }
        tables = [path: t]
        return t
    }

    /// The `contrast` field (TODO-054 D27): `{level?, scale?, scale_source?, kinds?, allow?, boxes?}`.
    static func contrastJob(_ v: Any) -> Result<ContrastJob, Diagnostic> {
        func bad(_ m: String) -> Result<ContrastJob, Diagnostic> { .failure(Diagnostic("invalid-request", "contrast.\(m)")) }
        guard let o = v as? [String: Any] else { return bad("must be an object.") }
        var j = ContrastJob()
        if let l = o["level"] {
            guard let s = l as? String, Contrast.levels.contains(s) else { return bad("level must be AA or AAA.") }
            j.level = s
        }
        if let x = o["scale"] {
            guard let n = x as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue >= 1, n.doubleValue <= 4 else {
                return bad("scale must be a number from 1 to 4.")
            }
            j.scale = n.doubleValue
        }
        if let x = o["scale_source"] {
            guard let s = x as? String, ["flag", "boxes", "size-table", "page", "none"].contains(s) else {
                return bad("scale_source must be flag, boxes, size-table, page or none.")
            }
            j.scaleSource = s
        }
        if let k = o["kinds"] {
            guard let a = k as? [String], !a.isEmpty, a.allSatisfy(Contrast.kinds.contains) else {
                return bad("kinds must be a non-empty array of low-contrast, busy-background.")
            }
            j.kinds = Set(a)
        }
        if let a = o["allow"] {
            guard let s = a as? [String] else { return bad("allow must be an array of strings.") }
            j.allow = s
        }
        if let b = o["boxes"], !(b is NSNull) {
            switch boxesField(b, field: "contrast") {
            case .success(let x): j.boxes = x
            case .failure(let d): return .failure(d)
            }
        }
        return .success(j)
    }

    /// The `fit` field (TODO-073): `{profile?, matched_by?, table?, version?, platform?, orientation?, boxes?, reasons?,
    /// allow?, controls?, min_hidden?, min_control?}`; the Node layer validated user profiles and resolved ids.
    static func fitJob(_ v: Any) -> Result<FitJob, Diagnostic> {
        func bad(_ m: String) -> Result<FitJob, Diagnostic> { .failure(Diagnostic("invalid-request", "fit.\(m)")) }
        guard let o = v as? [String: Any] else { return bad("must be an object.") }
        var f = FitJob()
        if let p = o["profile"], !(p is NSNull) {
            guard let x = DeviceProfile.parse(p) else { return bad("profile must be a device profile (core/schema/device-profile.schema.json).") }
            f.profile = x
        }
        if let m = o["matched_by"] {
            guard let s = m as? String, ["flag", "label"].contains(s) else { return bad("matched_by must be flag or label.") }
            f.matchedBy = s
        }
        if let t = o["table"], !(t is NSNull) {
            guard let path = t as? String, let rows = table(path) else { return bad("table must be the path of a readable profile table.") }
            f.table = rows
        }
        if let s = o["version"] as? String { f.version = s }
        if let s = o["platform"] as? String { f.platform = s }
        if let x = o["orientation"], !(x is NSNull) {
            guard let s = x as? String, Fit.sidecarOrientations.contains(s) else { return bad("orientation must be portrait, landscape-left, landscape-right or portrait-upside-down.") }
            f.orientation = s
        }
        if let r = o["reasons"] {
            guard let a = r as? [String], !a.isEmpty, a.allSatisfy((Fit.reasons + Wrapping.reasons).contains) else {
                return bad("reasons must be a non-empty array of \((Fit.reasons + Wrapping.reasons).joined(separator: ", ")).")
            }
            f.reasons = Set(a)
        }
        if let a = o["allow"] {
            guard let s = a as? [String] else { return bad("allow must be an array of strings.") }
            f.allow = s
        }
        if let c = o["controls"] {
            // D37: the zones whose controls are checked; true and false stand for all and none.
            if let n = c as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() {
                f.controls = n.boolValue ? Set(Fit.reasons) : []
            } else if let a = c as? [String], a.allSatisfy(Fit.reasons.contains) {
                f.controls = Set(a)
            } else {
                return bad("controls must be true, false or an array of \(Fit.reasons.joined(separator: ", ")).")
            }
        }
        for (k, set) in [("min_hidden", { (x: Double) in f.minHidden = x }), ("min_control", { (x: Double) in f.minControl = x })] {
            guard let m = o[k] else { continue }
            guard let n = m as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue > 0, n.doubleValue <= 1 else {
                return bad("\(k) must be a number in (0, 1].")
            }
            set(n.doubleValue)
        }
        if let x = o["wrap"], !(x is NSNull) {
            switch wrapJob(x) {
            case .success(let w): f.wrap = w
            case .failure(let d): return .failure(d)
            }
        }
        if let b = o["boxes"], !(b is NSNull) {
            switch boxesField(b, field: "fit") {
            case .success(let x): f.boxes = x
            case .failure(let d): return .failure(d)
            }
        }
        return .success(f)
    }

    /// TODO-074 D9, D13: `fit.wrap` is `{evidence?, element_rows?, base_path?, base_locale?, base?: [{id, text, rows,
    /// orphan}], pairs?: {digest, entries?: [[key, target, base, catalog?]], catalog?}}`; pairs are cached by digest, as
    /// `untranslated` catalogs are (D32), so a run sends a catalog once.
    static func wrapJob(_ v: Any) -> Result<WrapJob, Diagnostic> {
        func bad(_ m: String) -> Result<WrapJob, Diagnostic> { .failure(Diagnostic("invalid-request", "fit.wrap.\(m)")) }
        guard let o = v as? [String: Any] else { return bad("must be an object.") }
        var w = WrapJob()
        if let e = o["evidence"] {
            guard let a = e as? [String], a.allSatisfy(Wrapping.evidence.contains) else { return bad("evidence must be an array of \(Wrapping.evidence.joined(separator: ", ")).") }
            w.evidence = Set(a)
        }
        if let e = o["element_rows"] {
            guard let n = e as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return bad("element_rows must be true or false.") }
            w.elementRows = n.boolValue
        }
        if let p = o["base_path"], !(p is NSNull) {
            guard let s = p as? String else { return bad("base_path must be a string.") }
            w.basePath = s
        }
        if let l = o["base_locale"] {
            guard let s = l as? String, !s.isEmpty else { return bad("base_locale must be a locale code.") }
            w.baseLocale = s
        }
        if let b = o["base"], !(b is NSNull) {
            guard let a = b as? [[String: Any]] else { return bad("base must be an array of {id, text, rows, orphan}.") }
            var rows: [WrapJob.BaseRow] = []
            for (i, r) in a.enumerated() {
                guard let n = r["rows"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.intValue >= 1,
                      (r["id"] == nil || r["id"] is String || r["id"] is NSNull), (r["text"] == nil || r["text"] is String || r["text"] is NSNull)
                else { return bad("base[\(i)] must be {id, text, rows >= 1, orphan}.") }
                rows.append(.init(id: r["id"] as? String, text: r["text"] as? String, rows: n.intValue, orphan: (r["orphan"] as? Bool) ?? false))
            }
            w.base = rows
        }
        if let p = o["pairs"], !(p is NSNull) {
            guard let q = p as? [String: Any], let digest = q["digest"] as? String else { return bad("pairs must be {digest, entries?, catalog?}.") }
            if let e = q["entries"] {
                guard let a = e as? [[String]], a.allSatisfy({ $0.count == 3 || $0.count == 4 }) else { return bad("pairs.entries must be an array of [key, target, base, catalog?].") }
                let entry = (a.map { WrapJob.Pair(key: $0[0], target: $0[1], base: $0[2], catalog: $0.count == 4 ? $0[3] : nil) }, q["catalog"] as? String)
                wrapPairs.removeAll { $0.0 == digest }
                wrapPairs.append((digest, entry))
                if wrapPairs.count > 4 { wrapPairs.removeFirst() }
            }
            guard let cached = wrapPairs.first(where: { $0.0 == digest })?.1 else {
                return .failure(Diagnostic("invalid-request", "fit.wrap.pairs.digest \(digest) is not known to this process; send the entries with it first."))
            }
            w.pairs = cached.0
            w.catalog = cached.1
        }
        return .success(w)
    }

    /// TODO-074 D13: catalog pairs by digest; the newest 4 are kept. handle() parses requests one at a time.
    static var wrapPairs: [(String, ([WrapJob.Pair], String?))] = []

    /// The `boxes` field of `truncated` and `overlap` (spec 06 "--boxes format"; TODO-046 adds `graphic`).
    static func boxesField(_ b: Any, field: String) -> Result<TruncationJob.Boxes, Diagnostic> {
        func bad(_ m: String) -> Result<TruncationJob.Boxes, Diagnostic> { .failure(Diagnostic("invalid-request", "\(field).\(m)")) }
        // JSON true bridges to NSNumber 1; a boolean is not a size or a coordinate.
        func num(_ x: Any?) -> Double? {
            guard let n = x as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
            return n.doubleValue
        }
        guard let d = b as? [String: Any], let img = d["image"] as? [String: Any],
              let w = num(img["width"]), let h = num(img["height"]), w > 0, h > 0
        else { return bad("boxes.image must be {width, height} above 0.") }
        guard let els = d["elements"] as? [Any] else { return bad("boxes.elements must be an array.") }
        var out: [TruncationJob.Element] = []
        for (i, el) in els.enumerated() {
            guard let e = el as? [String: Any], let box = e["box"] as? [Any], box.count == 4,
                  let n = Optional(box.compactMap { num($0) }), n.count == 4,
                  n.allSatisfy({ $0 >= 0 && $0 <= 1 }), n[2] > 0, n[3] > 0
            else { return bad("boxes.elements[\(i)].box must be 4 numbers in 0..1 with width and height above 0.") }
            if e["id"] != nil && !(e["id"] is String) && !(e["id"] is NSNull) { return bad("boxes.elements[\(i)].id must be a string.") }
            if e["text"] != nil && !(e["text"] is String) && !(e["text"] is NSNull) { return bad("boxes.elements[\(i)].text must be a string.") }
            for k in ["clips", "offscreen", "graphic", "panel", "scrolls", "control", "enabled"] where e[k] != nil {
                guard let n = e[k] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return bad("boxes.elements[\(i)].\(k) must be true or false.") }
            }
            var maxLines: Int? = nil
            if let m = e["max_lines"], !(m is NSNull) { // TODO-074 D2
                guard let n = m as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded(), n.intValue >= 1 else {
                    return bad("boxes.elements[\(i)].max_lines must be an integer of at least 1.")
                }
                maxLines = n.intValue
            }
            out.append(TruncationJob.Element(
                id: e["id"] as? String, rect: CGRect(x: n[0], y: n[1], width: n[2], height: n[3]), text: e["text"] as? String,
                clips: (e["clips"] as? Bool) ?? true, offscreen: (e["offscreen"] as? Bool) ?? false, graphic: (e["graphic"] as? Bool) ?? false,
                panel: (e["panel"] as? Bool) ?? false, scrolls: (e["scrolls"] as? Bool) ?? false, control: (e["control"] as? Bool) ?? false,
                enabled: (e["enabled"] as? Bool) ?? true, maxLines: maxLines))
        }
        return .success(TruncationJob.Boxes(width: w, height: h, elements: out))
    }

    /// The `truncated` field (spec 06 D2); every malformed shape names its field.
    static func truncationJob(_ v: Any) -> Result<TruncationJob, Diagnostic> {
        func bad(_ m: String) -> Result<TruncationJob, Diagnostic> { .failure(Diagnostic("invalid-request", "truncated.\(m)")) }
        func strings(_ x: Any?) -> [String]? { // absent: empty; not all strings: nil
            guard let x else { return [] }
            guard let a = x as? [Any] else { return nil }
            let s = a.compactMap { $0 as? String }
            return s.count == a.count ? s : nil
        }
        guard let o = v as? [String: Any] else { return bad("truncated must be an object.") }
        var job = TruncationJob()
        if let p = o["pseudo"] {
            guard let b = p as? Bool else { return bad("pseudo must be true or false.") }
            job.pseudo = b
        }
        if let r = o["reasons"] {
            guard let a = strings(r), !a.isEmpty, a.allSatisfy(Truncation.reasons.contains) else {
                return bad("reasons must be a non-empty array of \(Truncation.reasons.joined(separator: ", ")).")
            }
            job.reasons = Set(a)
        }
        if let e = o["edge_distance"] {
            guard let n = e as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue >= 0, n.doubleValue.isFinite else {
                return bad("edge_distance must be a number, 0 or more.")
            }
            job.edgeDistance = n.doubleValue
        }
        guard let allow = strings(o["allow"]) else { return bad("allow must be an array of strings.") }
        job.allow = allow
        if let p = o["prefixes"] {
            guard let a = p as? [Any] else { return bad("prefixes must be an array.") }
            for item in a {
                guard let d = item as? [String: Any], let text = d["text"] as? String, let alts = d["alternatives"] as? [Any],
                      let frags = Optional(alts.compactMap { strings($0) }), frags.count == alts.count
                else { return bad("prefixes items must be {text, alternatives: [[string]]}.") }
                job.prefixes.append(TruncationJob.Prefix(text: text, alternatives: frags))
            }
        }
        if let b = o["boxes"] {
            switch boxesField(b, field: "truncated") {
            case .success(let x): job.boxes = x
            case .failure(let d): return .failure(d)
            }
        }
        return .success(job)
    }

    /// The `glyphs` field (TODO-036 T5): `{boxes?, expected?: [{key?, text}], lines?: bool}`.
    static func glyphsJob(_ v: Any) -> Result<GlyphsJob, Diagnostic> {
        func bad(_ m: String) -> Result<GlyphsJob, Diagnostic> { .failure(Diagnostic("invalid-request", "glyphs.\(m)")) }
        guard let o = v as? [String: Any] else { return bad("glyphs must be an object.") }
        var g = GlyphsJob()
        if let b = o["boxes"] {
            switch boxesField(b, field: "glyphs") {
            case .success(let x): g.boxes = x
            case .failure(let d): return .failure(d)
            }
        }
        if let x = o["expected"] {
            guard let a = x as? [Any] else { return bad("expected must be an array.") }
            if a.count > Server.uncataloguedEntries { return bad("expected has \(a.count) items; the limit is \(Server.uncataloguedEntries).") }
            for (i, item) in a.enumerated() {
                guard let d = item as? [String: Any], let t = d["text"] as? String,
                      d["key"] == nil || d["key"] is NSNull || d["key"] is String
                else { return bad("expected[\(i)] must be {key?, text}.") }
                g.expected.append(GlyphsJob.Expected(key: d["key"] as? String, text: t))
            }
        }
        if let l = o["lines"] {
            guard let n = l as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return bad("lines must be true or false.") }
            g.lines = n.boolValue
        }
        return .success(g)
    }

    /// The `formats` field (TODO-036 T3, D36): rules, the storefront's currency and region, products and `--allow`.
    static func formatsJob(_ v: Any) -> Result<FormatsJob, Diagnostic> {
        func bad(_ m: String) -> Result<FormatsJob, Diagnostic> { .failure(Diagnostic("invalid-request", "formats.\(m)")) }
        guard let o = v as? [String: Any] else { return bad("formats must be an object.") }
        var j = FormatsJob()
        if let r = o["rules"] {
            guard let a = r as? [String], !a.isEmpty, a.allSatisfy({ FormatsJob.allRules.contains($0) }) else {
                return bad("rules must be a non-empty array of \(FormatsJob.allRules.joined(separator: ", ")).")
            }
            j.rules = Set(a)
        }
        let iso = try! NSRegularExpression(pattern: "^[A-Z]{3}$")
        func isISO(_ s: String) -> Bool { iso.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil }
        if let c = o["currency"], !(c is NSNull) {
            guard let s = c as? String, isISO(s) else { return bad("currency must be an ISO 4217 code.") }
            j.currency = s
        }
        if let c = o["storefront"], !(c is NSNull) {
            guard let s = c as? String, s.count == 2, s.allSatisfy({ $0.isASCII && $0.isUppercase }) else {
                return bad("storefront must be an ISO 3166 alpha-2 region.")
            }
            j.storefront = s
        }
        if let a = o["allow"] {
            guard let s = a as? [String] else { return bad("allow must be an array of strings.") }
            j.allow = s
        }
        if let p = o["products"] {
            guard let a = p as? [[String: Any]] else { return bad("products must be an array of objects.") }
            for (i, e) in a.enumerated() {
                // A JSON `true` bridges to Int 1, so booleans are refused by type; the bound keeps price arithmetic
                // in Formats far from overflow (review).
                let isBool = e["price"].map { CFGetTypeID($0 as CFTypeRef) == CFBooleanGetTypeID() } ?? false
                guard let id = e["product"] as? String, !isBool, var price = e["price"] as? Int, (0...1_000_000_000_000_000).contains(price),
                    let cur = e["currency"] as? String, isISO(cur) else {
                    return bad("products[\(i)] needs product, price (minor units, at most 10^15) and currency.")
                }
                func dur(_ k: String) -> String?? {
                    guard let x = e[k], !(x is NSNull) else { return .some(nil) }
                    guard let s = x as? String, Formats.days(s) != nil else { return nil }
                    return .some(s)
                }
                guard let period = dur("period"), let trial = dur("trial") else {
                    return bad("products[\(i)].period and trial must be ISO 8601 durations such as P1M or null.")
                }
                // `digits` is the fraction-digit count the client used for `price`. Node's CLDR and Foundation disagree
                // for some codes (PKR, RSD: 2 vs 0), so the price is rescaled to Foundation's; a price with a
                // fraction Foundation's digits cannot hold can never bind and is left out (review, TODO-036 T3).
                if let dv = e["digits"], !(dv is NSNull) {
                    guard let n = dv as? Int, (0...6).contains(n), !(CFGetTypeID(dv as CFTypeRef) == CFBooleanGetTypeID()) else {
                        return bad("products[\(i)].digits must be an integer 0-6.")
                    }
                    let cd = Formats.digits(cur)
                    if n > cd {
                        let f = Int(pow(10, Double(n - cd)))
                        if price % f != 0 { continue }
                        price /= f
                    } else if n < cd {
                        let (m, o) = price.multipliedReportingOverflow(by: Int(pow(10, Double(cd - n))))
                        if o { return bad("products[\(i)].price is too large.") }
                        price = m
                    }
                }
                j.products.append(.init(id: id, price: price, currency: cur, period: period, trial: trial))
            }
        }
        return .success(j)
    }

    /// The `pseudo` field (TODO-039 T2): base catalog entries, filler words, `--dynamic` patterns and `--allow`.
    static func pseudoJob(_ o: [String: Any]) -> Result<PseudoJob, Diagnostic> {
        func bad(_ m: String) -> Result<PseudoJob, Diagnostic> { .failure(Diagnostic("invalid-request", "pseudo.\(m)")) }
        var p = PseudoJob()
        for (name, target) in [("fillers", \PseudoJob.fillers)] {
            guard let x = o[name] else { continue }
            guard let a = x as? [String] else { return bad("\(name) must be an array of strings.") }
            p[keyPath: target] = a
        }
        let dynamic = o["dynamic"] ?? [String]()
        let allow = o["allow"] ?? [String]()
        guard let d = dynamic as? [String] else { return bad("dynamic must be an array of strings.") }
        guard let a = allow as? [String] else { return bad("allow must be an array of strings.") }
        do { p.guards = try DynamicText(patterns: d, allow: a) } catch let e as DynamicText.InvalidPattern {
            return bad("dynamic[\(e.index)] is not a valid ICU regex: \(e.pattern)")
        } catch { return bad("dynamic has an invalid pattern.") }
        if let x = o["entries"] {
            guard let a = x as? [Any] else { return bad("entries must be an array.") }
            if a.count > Untranslated.caps.pairs { return bad("entries has \(a.count) items; the limit is \(Untranslated.caps.pairs).") }
            for item in a {
                guard let e = item as? [String: Any], let key = e["key"] as? String, let text = e["text"] as? String,
                    let forms = e["forms"] as? [Any]
                else { return bad("entries items need key, text and forms.") }
                guard let c = e["catalog"], c is String || c is NSNull else { return bad("entries catalog must be a string or null.") }
                var fs: [PseudoJob.Form] = []
                for f in forms {
                    guard let f = f as? [String: Any], let frags = f["fragments"] as? [String] else {
                        return bad("entries \(key) forms need fragments.")
                    }
                    if frags.count > Untranslated.caps.fragments { return bad("entries \(key) has \(frags.count) fragments; the limit is \(Untranslated.caps.fragments).") }
                    fs.append(.init(fragments: frags, lead: f["lead"] as? Bool ?? false, trail: f["trail"] as? Bool ?? false))
                }
                if fs.count > Untranslated.caps.alternatives { return bad("entries \(key) has \(fs.count) forms; the limit is \(Untranslated.caps.alternatives).") }
                p.entries.append(.init(key: key, catalog: c as? String, text: text, forms: fs))
            }
        }
        return .success(p)
    }

    /// The `uncatalogued` field (TODO-036 T4, D50, D51): every catalog form of every locale, the project locales,
    /// `--dynamic` patterns and `--allow`. The entry cap is twice the untranslated pairs cap (13 catalogs fit).
    static let uncataloguedEntries = 2 * Untranslated.caps.pairs
    static func uncataloguedJob(_ o: [String: Any]) -> Result<UncataloguedJob, Diagnostic> {
        func bad(_ m: String) -> Result<UncataloguedJob, Diagnostic> { .failure(Diagnostic("invalid-request", "uncatalogued.\(m)")) }
        var u = UncataloguedJob()
        if let x = o["languages"] {
            guard let a = x as? [String] else { return bad("languages must be an array of strings.") }
            u.languages = a
        }
        let dynamic = o["dynamic"] ?? [String]()
        let allow = o["allow"] ?? [String]()
        guard let d = dynamic as? [String] else { return bad("dynamic must be an array of strings.") }
        guard let a = allow as? [String] else { return bad("allow must be an array of strings.") }
        do { u.guards = try DynamicText(patterns: d, allow: a) } catch let e as DynamicText.InvalidPattern {
            return bad("dynamic[\(e.index)] is not a valid ICU regex: \(e.pattern)")
        } catch { return bad("dynamic has an invalid pattern.") }
        guard let x = o["entries"] as? [Any] else { return bad("entries must be an array.") }
        if x.count > uncataloguedEntries { return bad("entries has \(x.count) items; the limit is \(uncataloguedEntries).") }
        for item in x {
            guard let e = item as? [String: Any], let key = e["key"] as? String, let locale = e["locale"] as? String,
                let text = e["text"] as? String, let forms = e["forms"] as? [Any]
            else { return bad("entries items need key, locale, text and forms.") }
            var fs: [PseudoJob.Form] = []
            for f in forms {
                guard let f = f as? [String: Any], let frags = f["fragments"] as? [String] else { return bad("entries \(key) forms need fragments.") }
                if frags.count > Untranslated.caps.fragments { return bad("entries \(key) has \(frags.count) fragments; the limit is \(Untranslated.caps.fragments).") }
                fs.append(.init(fragments: frags, lead: f["lead"] as? Bool ?? false, trail: f["trail"] as? Bool ?? false))
            }
            if fs.count > Untranslated.caps.alternatives { return bad("entries \(key) has \(fs.count) forms; the limit is \(Untranslated.caps.alternatives).") }
            u.entries.append(.init(key: key, locale: locale, text: text, forms: fs))
        }
        return .success(u)
    }

    /// The `untranslated` field (spec 17 D28); every malformed shape names its field.
    static func untranslatedJob(_ v: Any) -> Result<UntranslatedJob, Diagnostic> {
        func bad(_ m: String) -> Result<UntranslatedJob, Diagnostic> { .failure(Diagnostic("invalid-request", "untranslated.\(m)")) }
        guard let o = v as? [String: Any] else { return bad("untranslated must be an object.") }
        guard let bl = o["base_locale"] as? String, !bl.isEmpty else { return bad("base_locale must be a non-empty string.") }
        var u = UntranslatedJob(baseLocale: bl)
        for (name, target) in [("keys", \UntranslatedJob.keys), ("texts", \UntranslatedJob.texts), ("allow", \UntranslatedJob.allow)] {
            guard let x = o[name] else { continue }
            guard let a = x as? [String] else { return bad("\(name) must be an array of strings.") }
            u[keyPath: target] = a
        }
        if let x = o["styles"] {
            guard let a = x as? [String] else { return bad("styles must be an array of strings.") }
            if let s = a.first(where: { !Untranslated.styleNames.contains($0) }) {
                return bad("styles has the unknown style \(s); known: \(Untranslated.styleNames.sorted().joined(separator: " ")).")
            }
            u.styles = Set(a)
        }
        if let x = o["kinds"] {
            guard let a = x as? [String], !a.isEmpty, a.allSatisfy(Untranslated.kindNames.contains) else {
                return bad("kinds must be a non-empty array of \(Untranslated.kindNames.joined(separator: ", ")).")
            }
            u.kinds = Set(a)
        }
        // TODO-012 D1: bound the matching work of one field; the Node client checks the same caps first.
        let caps = Untranslated.caps
        func over(_ what: String, _ n: Int, _ limit: Int) -> Result<UntranslatedJob, Diagnostic>? {
            n > limit ? bad("\(what) has \(n) items; the limit is \(limit).") : nil
        }
        func alternatives(_ what: String, _ alts: [[String]]) -> Result<UntranslatedJob, Diagnostic>? {
            // Empty forms (a placeholder-only plural form) cost nothing and are not counted, as in the loader.
            if let e = over(what, alts.filter { !$0.isEmpty }.count, caps.alternatives) { return e }
            // The loader's rule: a string expands to at most 256 fragments over all its forms (TODO-012 D5).
            let total = alts.reduce(0) { $0 + $1.count }
            if total > caps.fragments { return bad("\(what) has \(total) fragments; the limit is \(caps.fragments).") }
            return nil
        }
        if let x = o["targets"] {
            guard let a = x as? [[String]] else { return bad("targets must be an array of fragment arrays.") }
            if let e = over("targets", a.count, caps.targets) { return e }
            if let f = a.first(where: { $0.count > caps.fragments }) {
                return bad("targets has an alternative of \(f.count) fragments; the limit is \(caps.fragments).")
            }
            u.targets = a
        }
        if let x = o["pairs"] {
            switch pairs(x, "pairs", bad: bad, over: over, alternatives: alternatives) {
            case .success(let p): u.pairs = p
            case .failure(let e): return .failure(e)
            }
        }
        // TODO-036 T2: other project locales for wrong-language (D25); each reuses the run locale's targets.
        if let x = o["wrong_language"] {
            guard let w = x as? [String: Any] else { return bad("wrong_language must be an object.") }
            var job = WrongLanguageJob()
            if let l = w["languages"] {
                guard let a = l as? [String] else { return bad("wrong_language.languages must be an array of strings.") }
                job.languages = a
            }
            if let p = w["preferred"] {
                guard let s = p as? String else { return bad("wrong_language.preferred must be a string.") }
                job.preferred = s
            }
            guard let others = (w["others"] ?? []) as? [[String: Any]] else { return bad("wrong_language.others must be an array of objects.") }
            let folded = u.targets.map { $0.map(WrongLanguage.foldMarks) }
            let memo = Untranslated.Memo()
            for (n, item) in others.enumerated() {
                guard let loc = item["locale"] as? String, !loc.isEmpty, let cat = item["catalog"] as? String, let ps = item["pairs"] else {
                    return bad("wrong_language.others[\(n)] needs locale, catalog and pairs.")
                }
                var other = UntranslatedJob(baseLocale: loc)
                other.baseOnly = true
                other.memo = memo
                switch pairs(ps, "wrong_language.others[\(n)].pairs", bad: bad, over: over, alternatives: alternatives) {
                // Matched without accents on both sides (WrongLanguage.foldMarks); the reported strings keep them.
                case .success(let p):
                    other.pairs = p.map { q in
                        var q = q
                        q.baseAlternatives = q.baseAlternatives.map { $0.map(WrongLanguage.foldMarks) }
                        q.targetAlternatives = q.targetAlternatives.map { $0.map(WrongLanguage.foldMarks) }
                        return q
                    }
                case .failure(let e): return .failure(e)
                }
                other.targets = folded
                other.allow = u.allow
                other.styles = u.styles
                job.others.append(.init(locale: loc, catalog: cat, job: other))
            }
            u.wrongLanguage = job
            // Prepared in the background while Vision reads the first images; evaluate waits on each job's Box.
            let jobs = job.others
            DispatchQueue.global(qos: .userInitiated).async {
                DispatchQueue.concurrentPerform(iterations: jobs.count) { i in _ = jobs[i].job.prepared.get { Untranslated.prepare(jobs[i].job) } }
            }
        }
        return .success(u)
    }

    /// The `pairs` array of an `untranslated` field or of one `wrong_language.others` entry.
    static func pairs(
        _ x: Any, _ name: String, bad: (String) -> Result<UntranslatedJob, Diagnostic>,
        over: (String, Int, Int) -> Result<UntranslatedJob, Diagnostic>?,
        alternatives: (String, [[String]]) -> Result<UntranslatedJob, Diagnostic>?
    ) -> Result<[UntranslatedJob.Pair], Diagnostic> {
        func fail(_ r: Result<UntranslatedJob, Diagnostic>) -> Result<[UntranslatedJob.Pair], Diagnostic> {
            if case .failure(let e) = r { return .failure(e) }
            return .failure(Diagnostic("invalid-request", "untranslated.\(name) is invalid."))
        }
        guard let a = x as? [Any] else { return fail(bad("\(name) must be an array.")) }
        if let e = over(name, a.count, Untranslated.caps.pairs) { return fail(e) }
        var out: [UntranslatedJob.Pair] = []
        for item in a {
            guard let p = item as? [String: Any], let key = p["key"] as? String, let base = p["base"] as? String,
                let ba = p["base_alternatives"] as? [[String]], let ta = p["target_alternatives"] as? [[String]]
            else { return fail(bad("\(name) items need key, base, base_alternatives and target_alternatives.")) }
            // Both keys are required; null is the value for "no file" / "no target string" (D28).
            guard let c = p["catalog"], c is String || c is NSNull else { return fail(bad("\(name) catalog must be a string or null.")) }
            guard let e = p["expected"], e is String || e is NSNull else { return fail(bad("\(name) expected must be a string or null.")) }
            if let e = alternatives("\(name) \(key) base_alternatives", ba) ?? alternatives("\(name) \(key) target_alternatives", ta) { return fail(e) }
            out.append(.init(
                key: key, catalog: p["catalog"] as? String, base: base, expected: p["expected"] as? String,
                baseAlternatives: ba, targetAlternatives: ta))
        }
        return .success(out)
    }

    /// `{key, catalog?, text, alternatives: [[String]], reason?}` (spec 02 D24).
    static func catalogCheck(_ item: Any, kind: String) -> CatalogCheck? {
        guard let o = item as? [String: Any], let key = o["key"] as? String, let text = o["text"] as? String,
            let alts = o["alternatives"] as? [[String]]
        else { return nil }
        if let v = o["catalog"], !(v is String || v is NSNull) { return nil } // null: a template named no file
        if o["reason"] != nil && !(o["reason"] is String) { return nil }
        return CatalogCheck(
            kind: kind, key: key, catalog: o["catalog"] as? String, text: text, alternatives: alts,
            reason: o["reason"] as? String)
    }

    /// Writes responses in request order. `seq` -1 is written at once (the ready line).
    func write(_ seq: Int, _ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        if seq < 0 {
            FileHandle.standardOutput.write(data)
            return
        }
        pending[seq] = data
        while let d = pending.removeValue(forKey: nextOut) {
            if !d.isEmpty { FileHandle.standardOutput.write(d) }
            nextOut += 1
        }
    }
}
