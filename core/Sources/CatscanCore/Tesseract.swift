// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import Foundation
import ImageIO

/// The Tesseract fallback for locales Vision cannot read (spec 03). catscan never installs or bundles Tesseract.
public enum Tesseract {
    /// Locale (lowercased BCP 47) -> Tesseract packs joined with "+" (spec 03 table, D5). el reads with the Greek
    /// script model: `ell` emits polytonic marks and Latin lookalikes on UI text (TODO-020).
    public static let packs: [String: String] = [
        "el": "script/Greek", "he": "heb", "bg": "bul", "sr": "srp+srp_latn", "sr-cyrl": "srp", "sr-latn": "srp_latn",
        "hu": "hun", "fa": "fas", "ka": "kat", "hy": "hye",
        // TODO-037: Vision drops letters outside its Latin and Cyrillic sets (ė ų ā ħ þ ș ...), so these read here.
        "hr": "hrv", "sk": "slk", "sl": "slv", "lt": "lit", "lv": "lav", "mt": "mlt", "ga": "gle", "is": "isl",
        "mk": "mkd", "bs": "bos", "be": "bel", "et": "est", "cy": "cym", "sq": "sqi",
    ]
    /// The base locales the fallback covers, for hints (D4) and `doctor`.
    public static let locales = [
        "el", "he", "bg", "sr", "sr-Latn", "hu", "fa", "ka", "hy",
        "hr", "sk", "sl", "lt", "lv", "mt", "ga", "is", "mk", "bs", "be", "et", "cy", "sq",
    ]
    public static let timeout: TimeInterval = 60
    public static let extraDirs = ["/opt/homebrew/bin"]
    /// Median line height, in pixels, that Tesseract reads best (TODO-020): taller text loses accuracy when
    /// upscaled, shorter text gains from it. The second read is at most 3x (the largest factor measured) and
    /// 16 MP, so a wide screenshot of small text stays within the 60 s timeout.
    public static let targetLineHeight = 40.0
    public static let maxScale = 3.0
    public static let maxScaledPixels = 16_000_000.0

    /// The factor for a second read of a `width` x `height` image, from the line heights (pixels) of the first,
    /// unscaled read; 1 means no second read. Nothing read at all gets 2x: text below Tesseract's floor is found
    /// only when upscaled.
    public static func scale(lineHeights: [Double], width: Int, height: Int) -> Double {
        var f = 2.0
        if !lineHeights.isEmpty { f = targetLineHeight / max(median(lineHeights), 1) }
        f = min(f, maxScale, (maxScaledPixels / Double(max(width * height, 1))).squareRoot())
        return f > 1 ? f : 1
    }

    static func median(_ v: [Double]) -> Double {
        let s = v.sorted()
        return s.isEmpty ? 0 : s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
    }

    /// RFC 4647 lookup over the table: `sr-Latn-RS` -> srp_latn, `el-GR` -> script/Greek.
    public static func pack(for locale: String) -> String? {
        var parts = locale.lowercased().split(separator: "-").map(String.init)
        while !parts.isEmpty {
            if let p = packs[parts.joined(separator: "-")] { return p }
            parts.removeLast()
        }
        return nil
    }

    public struct Install: Equatable {
        public let path: String
        public let version: String
        public let packs: [String]
        public let tessdata: String?
        public var engineName: String { "tesseract-\(version)" }
    }

    /// Where the binary is looked for, in order (D2): `CATSCAN_TESSERACT` alone when set, else PATH, then Homebrew.
    public static func candidates(env: [String: String], extra: [String] = extraDirs) -> [String] {
        if let o = env["CATSCAN_TESSERACT"], !o.isEmpty { return [o] }
        let dirs = (env["PATH"] ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty } + extra
        var out: [String] = []
        for d in dirs {
            let p = (d as NSString).appendingPathComponent("tesseract")
            if !out.contains(p) { out.append(p) }
        }
        return out
    }

    public static func find(env: [String: String], extra: [String] = extraDirs) -> String? {
        candidates(env: env, extra: extra).first { p in
            var isDir: ObjCBool = false
            return FileManager.default.fileExists(atPath: p, isDirectory: &isDir) && !isDir.boolValue
                && FileManager.default.isExecutableFile(atPath: p)
        }.map { ($0 as NSString).standardizingPath }
    }

    /// `tesseract 5.5.3` (first line of `--version`).
    static func parseVersion(_ out: String) -> String? {
        for line in out.split(separator: "\n") {
            let f = line.split(separator: " ")
            if f.count >= 2, f[0] == "tesseract" { return String(f[1]) }
        }
        return nil
    }

    /// `List of available languages in "/opt/homebrew/share/tessdata/" (163):` then one pack per line.
    static func parseLangs(_ out: String) -> (tessdata: String?, packs: [String]) {
        var dir: String? = nil
        var packs: [String] = []
        for line in out.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }) where !line.isEmpty {
            if line.hasPrefix("List of available languages") {
                if let a = line.firstIndex(of: "\""), let b = line.lastIndex(of: "\""), a < b {
                    dir = String(line[line.index(after: a)..<b])
                }
            } else if !line.contains(" ") {
                packs.append(line)
            }
        }
        return (dir, packs)
    }

    /// Probed on first use and shared by the serve pool. TODO-065 D5: `refresh` probes again, at most once per
    /// `reprobeInterval`, so a Tesseract installed while an MCP server or a test run is up is used without a restart.
    public static func installed(refresh: Bool = false) -> Install? {
        probeCache.get(refresh: refresh, interval: reprobeInterval) { probe(env: ProcessInfo.processInfo.environment) }
    }
    public static let reprobeInterval: TimeInterval = 30
    static let probeCache = ProbeCache()

    final class ProbeCache {
        private let lock = NSLock()
        private var value: Install?
        private var at: TimeInterval?
        func get(refresh: Bool, interval: TimeInterval, now: TimeInterval = ProcessInfo.processInfo.systemUptime,
                 probe: () -> Install?) -> Install? {
            lock.lock()
            if let at, !refresh || now - at < interval { defer { lock.unlock() }; return value }
            // The first probe: nothing is cached, so every caller waits for it.
            if at == nil { defer { lock.unlock() }; value = probe(); at = now; return value }
            // A re-probe runs outside the lock (a hung CATSCAN_TESSERACT takes ~20 s): this caller claims the
            // interval, the serve pool keeps reading the cached value meanwhile.
            at = now
            lock.unlock()
            let fresh = probe()
            lock.lock(); value = fresh; lock.unlock()
            return fresh
        }
    }

    /// TODO-065 D6: the fix for a missing reader names the setup catscan actually found. `missing` holds the
    /// packs (eng included) the locale needs and `install` lacks; empty when `install` is nil.
    public static func fix(missing: [String], install: Install?, env: [String: String]) -> String {
        guard let install else {
            if let o = env["CATSCAN_TESSERACT"], !o.isEmpty {
                return "CATSCAN_TESSERACT=\(o) is not a working tesseract: put one there, or change CATSCAN_TESSERACT where catscan is launched (the MCP server config, the CI job) and restart it"
            }
            return "brew install tesseract tesseract-lang (about 650 MB), then rerun the same command"
        }
        let files = missing.map { "\($0).traineddata" }.joined(separator: ", ")
        // Homebrew's tesseract-lang fills Homebrew's tessdata only; TESSDATA_PREFIX or another install reads its own.
        // eng ships with the tesseract formula, not tesseract-lang: a missing eng is added by hand.
        guard let dir = install.tessdata, dir.hasPrefix("/opt/homebrew/"), !missing.contains("eng") else {
            return "add \(files) to \(install.tessdata ?? "the tessdata directory of \(install.path)"), then rerun the same command"
        }
        return "brew install tesseract-lang (about 650 MB), then rerun the same command"
    }

    public static func probe(env: [String: String]) -> Install? {
        guard let path = find(env: env) else { return nil }
        guard let v = try? run(path, ["--version"], timeout: 10), v.status == 0,
            let version = parseVersion(String(decoding: v.stdout + v.stderr, as: UTF8.self))
        else { return nil }
        let l = try? run(path, ["--list-langs"], timeout: 10)
        let parsed = parseLangs(String(decoding: (l?.stdout ?? Data()) + (l?.stderr ?? Data()), as: UTF8.self))
        return Install(path: path, version: version, packs: parsed.packs, tessdata: parsed.tessdata)
    }

    public struct Output {
        public var status: Int32
        public var stdout: Data
        public var stderr: Data
        public var timedOut: Bool
        /// The process exited but something it started still held stdout or stderr: the output may be cut.
        public var pipesHeld = false
    }

    /// Runs the binary by absolute path with an argument array (posix_spawn, no shell). Both pipes are drained on
    /// their own threads while the process runs: reading one after exit deadlocks once output passes the pipe buffer.
    public static func run(_ path: String, _ args: [String], timeout: TimeInterval) throws -> Output {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        // TODO-005: recorded under the lock with the spawn, so a signal never misses a child; dropped as soon as
        // Foundation reports the exit (a pid reused in that short gap is the one accepted risk).
        p.terminationHandler = { proc in
            lock.withLock { _ = children.remove(proc.processIdentifier) }
            done.signal()
        }
        try lock.withLock {
            // serve ignores SIGINT/SIGTERM for its cleanup source; Process spawns with default actions, so
            // Tesseract still gets Ctrl-C and terminate() (checked in test/fallback.test.js).
            try p.run()
            children.insert(p.processIdentifier)
        }
        final class Box: @unchecked Sendable { var out = Data(), err = Data() }
        let box = Box()
        let g = DispatchGroup()
        DispatchQueue.global().async(group: g) { let d = out.fileHandleForReading.readDataToEndOfFile(); box.out = d }
        DispatchQueue.global().async(group: g) { let d = err.fileHandleForReading.readDataToEndOfFile(); box.err = d }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            if done.wait(timeout: .now() + 2) == .timedOut { kill(p.processIdentifier, SIGKILL); done.wait() }
            // A grandchild (a wrapper script's tesseract) can keep the pipes open after the kill. Never close a
            // handle a reader is blocked on (that raises an uncatchable exception); abandon the readers instead.
            if g.wait(timeout: .now() + 2) == .timedOut {
                return Output(status: p.terminationStatus, stdout: Data(), stderr: Data(), timedOut: true)
            }
            return Output(status: p.terminationStatus, stdout: box.out, stderr: box.err, timedOut: true)
        }
        // The same on a normal exit: a grandchild holding the pipes must not hold the job.
        if g.wait(timeout: .now() + 2) == .timedOut {
            return Output(status: p.terminationStatus, stdout: Data(), stderr: Data(), timedOut: false, pipesHeld: true)
        }
        return Output(status: p.terminationStatus, stdout: box.out, stderr: box.err, timedOut: false)
    }

    /// TSV word rows (level 5) grouped into lines by page, block, paragraph and line, in Tesseract's order
    /// (logical order for right-to-left scripts). Rects are normalized, top-left origin.
    public static func parseTSV(_ tsv: String, width: Int, height: Int) -> [RecognizedLine] {
        struct Acc { var words: [String] = []; var rect = CGRect.null; var conf: [Double] = [] }
        var order: [String] = []
        var acc: [String: Acc] = [:]
        for row in tsv.split(separator: "\n", omittingEmptySubsequences: true) {
            let f = row.split(separator: "\t", omittingEmptySubsequences: false)
            guard f.count >= 12, f[0] == "5", let conf = Double(f[10]), conf >= 0,
                let l = Double(f[6]), let t = Double(f[7]), let w = Double(f[8]), let h = Double(f[9])
            else { continue }
            let text = f[11...].joined(separator: "\t").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            let key = f[1...4].joined(separator: ".")
            if acc[key] == nil { order.append(key); acc[key] = Acc() }
            acc[key]!.words.append(text)
            acc[key]!.rect = acc[key]!.rect.union(CGRect(x: l, y: t, width: w, height: h))
            acc[key]!.conf.append(conf)
        }
        let W = CGFloat(max(width, 1)), H = CGFloat(max(height, 1))
        return order.map { k in
            let a = acc[k]!
            return RecognizedLine(
                text: a.words.joined(separator: " "),
                rect: CGRect(x: a.rect.minX / W, y: a.rect.minY / H, width: a.rect.width / W, height: a.rect.height / H),
                confidence: a.conf.reduce(0, +) / Double(a.conf.count) / 100)
        }
    }

    // MARK: temp images

    static let lock = NSLock()
    static var dir: String? = nil
    /// Running Tesseract pids, so a signal can stop them (TODO-005).
    static var children = Set<Int32>()
    nonisolated(unsafe) static var signalSources: [DispatchSourceSignal] = []

    /// TODO-005: `atexit` does not run on a signal, so SIGINT and SIGTERM stop the running Tesseract children and
    /// remove the temp directory, then die by the same signal (conventional exit status). A dispatch source, not a
    /// signal handler, so the cleanup may lock and allocate.
    public static func cleanUpOnSignals() {
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            s.setEventHandler {
                cleanUp()
                signal(sig, SIG_DFL)
                raise(sig)
            }
            s.resume()
            signalSources.append(s)
        }
    }

    static func cleanUp() {
        let (pids, d) = lock.withLock { (children, dir) }
        // SIGKILL: Tesseract has nothing to save, and a stuck one must not delay the exit.
        for p in pids { kill(p, SIGKILL) }
        if let d { try? FileManager.default.removeItem(atPath: d) }
    }

    /// A per-process 0700 directory (mkdtemp), removed at exit.
    static func tempDir() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        if let dir { return dir }
        var tmpl = Array((NSTemporaryDirectory() as NSString).appendingPathComponent("catscan-XXXXXX").utf8CString)
        guard mkdtemp(&tmpl) != nil else { throw Diagnostic("fallback-failed", "Cannot create a temporary directory.") }
        let d = String(cString: tmpl)
        dir = d
        atexit { if let d = Tesseract.dir { try? FileManager.default.removeItem(atPath: d) } }
        return d
    }

    /// Uncompressed 24-bit BMP: Tesseract reads it about 3x faster than PNG (spec 03 D3). Written by hand:
    /// ImageIO's BMP leaves the row padding out of the header size, and Leptonica rejects that file.
    static func bmp(_ img: CGImage) -> Data? {
        let w = img.width, h = img.height
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let px = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        let row = (w * 3 + 3) & ~3
        let size = 54 + row * h
        var d = Data(count: size)
        d.withUnsafeMutableBytes { (b: UnsafeMutableRawBufferPointer) in
            let o = b.bindMemory(to: UInt8.self).baseAddress!
            func put(_ v: Int, _ at: Int, _ n: Int) { for i in 0..<n { o[at + i] = UInt8((v >> (8 * i)) & 0xFF) } }
            o[0] = 0x42; o[1] = 0x4D // "BM"
            put(size, 2, 4); put(54, 10, 4); put(40, 14, 4); put(w, 18, 4); put(h, 22, 4)
            put(1, 26, 2); put(24, 28, 2); put(0, 30, 4); put(row * h, 34, 4); put(2835, 38, 4); put(2835, 42, 4)
            // The context's first row is the top of the image; BMP rows run bottom-up.
            for y in 0..<h {
                let src = px + y * w * 4
                let dst = o + 54 + (h - 1 - y) * row
                for x in 0..<w {
                    dst[x * 3] = src[x * 4 + 2]; dst[x * 3 + 1] = src[x * 4 + 1]; dst[x * 3 + 2] = src[x * 4]
                }
            }
        }
        return d
    }

    static func writeBMP(_ img: CGImage) throws -> String {
        var tmpl = Array((try tempDir() as NSString).appendingPathComponent("img-XXXXXX").utf8CString)
        let fd = mkstemp(&tmpl)
        guard fd >= 0 else { throw Diagnostic("fallback-failed", "Cannot create a temporary image file.") }
        let path = String(cString: tmpl)
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        guard let data = bmp(img) else {
            unlink(path)
            throw Diagnostic("fallback-failed", "Cannot convert the image for Tesseract.")
        }
        // The throwing write: the legacy one raises an uncatchable exception on a full disk and kills serve.
        do {
            try h.write(contentsOf: data)
            try h.close()
        } catch {
            unlink(path)
            throw Diagnostic("fallback-failed", "Cannot write the temporary image: \(error.localizedDescription)", hint: "free space in \(NSTemporaryDirectory())")
        }
        return path
    }

    /// Reads one upright image. Throws a `fallback-failed` Diagnostic (D8).
    static func recognize(_ img: CGImage, install: Install, langs: String, timeout: TimeInterval = Tesseract.timeout) throws -> [RecognizedLine] {
        let path = try writeBMP(img)
        defer { unlink(path) }
        let what = "Tesseract \(install.version) at \(install.path)"
        let r: Output
        do {
            // -c, not the `tsv` config file: a tessdata directory without configs/ makes Tesseract print plain
            // text and exit 0, which would read as "no text" and pass every absent check.
            r = try run(install.path, [path, "stdout", "-l", langs, "-c", "tessedit_create_tsv=1"], timeout: timeout)
        } catch {
            throw Diagnostic("fallback-failed", "\(what) could not start: \(error.localizedDescription)", hint: "catscan doctor")
        }
        let tail = String(decoding: r.stderr.suffix(400), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if r.timedOut {
            throw Diagnostic(
                "fallback-failed", "\(what) did not finish in \(Int(timeout)) s and was stopped\(tail.isEmpty ? "" : ": \(tail)")",
                hint: "catscan doctor; rerun once; --fallback none skips Tesseract")
        }
        if r.pipesHeld {
            throw Diagnostic(
                "fallback-failed", "\(what) exited but a process it started kept its output open.",
                hint: "catscan doctor; check CATSCAN_TESSERACT; --fallback none skips Tesseract")
        }
        if r.status != 0 {
            throw Diagnostic(
                "fallback-failed", "\(what) exited with status \(r.status): \(tail.isEmpty ? "no output" : tail)",
                hint: "catscan doctor; --fallback none skips Tesseract")
        }
        let tsv = String(decoding: r.stdout, as: UTF8.self)
        guard tsv.hasPrefix("level\tpage_num") else {
            throw Diagnostic(
                "fallback-failed", "\(what) did not write TSV output\(tail.isEmpty ? "" : ": \(tail)")",
                hint: "catscan doctor; --fallback none skips Tesseract")
        }
        return parseTSV(tsv, width: img.width, height: img.height)
    }
}
