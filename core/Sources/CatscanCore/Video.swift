// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import AVFoundation
import CoreGraphics
import Foundation

/// `catscan video` (spec 07): sampling, decode and the per-check aggregation over frames.
public struct VideoOptions {
    public var every = 0.5
    public var from = 0.0
    public var to: Double? = nil
    public var frames = false
    public var ranges: [VideoRange] = []

    public init() {}
}

/// An `--expect` range (D7): its checks apply to the frames with start <= t <= end.
public struct VideoRange {
    public var key: String
    public var start: Double
    public var end: Double? // nil: to the last frame
    public var present: [String] = []
    public var absent: [String] = []
    public var catalog: [CatalogCheck] = []

    public init(key: String, start: Double, end: Double?) {
        self.key = key
        self.start = start
        self.end = end
    }
}

public struct VideoInfo: Encodable {
    public var width: Int
    public var height: Int
    public var fps: Double
    public var duration: Double
}

/// One sampled frame for `--frames` (D15): the CLI turns each into a `video-frame` line.
public struct FrameSample: Encodable {
    public var t: Double
    public var lines: [LineOut]
}

public enum Video {
    public static let maxSamples = 20_000
    static let eps = 1e-6

    static func round3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

    /// Sample times (D5, D17): from + k * every while t <= to and t < duration; `every` is at least one frame.
    /// `start` is the video track's first frame time: a track that starts late is never sought before it.
    static func sampleTimes(
        duration: Double, fps: Double, _ o: VideoOptions, start: Double = 0
    ) -> (times: [Double], every: Double, clamped: Bool, over: Bool) {
        let frame = fps > 0 ? 1 / fps : 0
        let every = max(o.every, frame)
        let clamped = o.every < frame - eps
        let end = min(o.to ?? duration, duration)
        var times: [Double] = []
        // Keep the from + k * every grid (D5); only skip the grid points before the track's first frame.
        var k = start > o.from ? Int(((start - o.from) / every).rounded(.up)) : 0
        while o.from + Double(k) * every < start { k += 1 }
        // The quotient can round up past a grid point that lands exactly on start (0.07 / 0.01 = 7.000000000000001).
        while k > 0 && o.from + Double(k - 1) * every >= start { k -= 1 }
        while true {
            let t = o.from + Double(k) * every
            if t > end + eps || t >= duration - eps { break }
            if times.count == maxSamples { return (times, every, clamped, true) }
            times.append(t)
            k += 1
        }
        return (times, every, clamped, false)
    }

    /// The check rule over the sampled frames (D2, D7). `frames` are (time, lines) in time order.
    static func evaluate(
        _ job: Job, frames: [(t: Double, at: Double, lines: [RecognizedLine])], every: Double, locale: String, guardScripts: Bool,
        env: inout Envelope
    ) {
        func unreadable(_ t: String) -> Bool {
            guardScripts && Scripts.scripts(in: t).contains(where: { !Scripts.readable(locale).contains($0) })
        }
        let opts = job.video ?? VideoOptions()
        var windows: [Int: Checks.Windows] = [:]
        func window(_ i: Int) -> Checks.Windows {
            if let w = windows[i] { return w }
            let w = Checks.Windows(frames[i].lines, locale: locale)
            windows[i] = w
            return w
        }
        enum Spec { case literal(String, String), catalog(CatalogCheck) }
        var groups: [(range: VideoRange?, specs: [Spec])] = [(nil,
            job.present.map { .literal("present", $0) } + job.absent.map { .literal("absent", $0) } + job.catalog.map { .catalog($0) })]
        for r in opts.ranges {
            groups.append((r, r.present.map { .literal("present", $0) } + r.absent.map { .literal("absent", $0) } + r.catalog.map { .catalog($0) }))
        }
        for (range, specs) in groups {
            let idx = frames.indices.filter { i in
                guard let range else { return true }
                // The requested time, not the decoded frame's: at 29.97 fps the frame shown at 4.0 s starts at 3.971 s.
                return frames[i].at >= range.start - eps && (range.end.map { frames[i].at <= $0 + eps } ?? true)
            }
            for spec in specs {
                var r: CheckResult
                switch spec {
                case .literal(let kind, let text):
                    r = CheckResult(kind: kind, text: text, verdict: "pass")
                    if unreadable(text) { r.verdict = "unsupported" }
                case .catalog(let c):
                    r = Checks.skeleton(c, verdict: "pass")
                    if c.reason == nil && unreadable(Checks.scriptText(c)) { r.verdict = "unsupported" }
                }
                r.video = true
                r.range = range?.key
                if r.verdict == "unsupported" { env.checks.append(r); continue }
                if idx.isEmpty {
                    r.verdict = "skipped"
                    r.reason = "range-empty"
                    if let range {
                        let d = Diagnostic(
                            "range-empty",
                            "the --expect range \"\(range.key)\" has no sampled frame (every \(fmt(every)) s from \(fmt(opts.from)) s to \(opts.to.map { fmt($0) + " s" } ?? "the end"))",
                            hint: "a smaller --every, or widen the range")
                        if !env.warnings.contains(d) { env.warnings.append(d) }
                    }
                    env.checks.append(r)
                    continue
                }
                var seen: [Int] = []
                var first: CheckResult? = nil
                var best: (Closest, Double)? = nil
                var skipped: CheckResult? = nil
                for i in idx {
                    let (fr, w): (CheckResult, [Diagnostic])
                    switch spec {
                    case .literal(let kind, let text): (fr, w) = Checks.evaluate(kind: kind, text: text, lines: frames[i].lines, locale: locale)
                    case .catalog(let c): (fr, w) = Checks.evaluate(c, windows: window(i), lines: frames[i].lines, locale: locale)
                    }
                    for d in w where !env.warnings.contains(d) { env.warnings.append(d) }
                    if fr.verdict == "skipped" { skipped = fr; break }
                    if fr.box != nil {
                        seen.append(i)
                        if first == nil { first = fr }
                    } else if let c = fr.closest, best == nil || c.distance < best!.0.distance {
                        best = (c, frames[i].t)
                    }
                }
                if var s = skipped {
                    s.video = true
                    s.range = range?.key
                    env.checks.append(s)
                    continue
                }
                if let f = first {
                    r.box = f.box
                    r.line = f.line
                    r.confidence = f.confidence
                    r.firstSeen = frames[seen.first!].t
                    r.lastSeen = frames[seen.last!].t
                    if r.kind == "absent" { r.verdict = "fail" }
                } else if r.kind == "present" {
                    r.verdict = "fail"
                    r.closest = best.map { var c = $0.0; c.t = $0.1; return c }
                }
                env.checks.append(r)
            }
        }
        if env.checks.contains(where: { $0.verdict == "unsupported" }) {
            env.verdict = "unsupported"
            env.error = Diagnostic(
                "unsupported-script", "A check text uses a script the locale \(locale) cannot read.",
                hint: env.warnings.first(where: { $0.code == "locale-script-mismatch" })?.hint)
        } else if env.checks.contains(where: { $0.verdict == "fail" }) {
            env.verdict = "fail"
        }
    }

    static func fmt(_ v: Double) -> String {
        let r = round3(v)
        return r == r.rounded() ? String(Int(r)) : String(r)
    }

    static let callTimeout: DispatchTimeInterval = .seconds(60)

    final class Box<T> {
        let lock = NSLock()
        var value: Result<T, Error>?
    }

    /// Runs an async AVFoundation call from the synchronous engine. A call that stalls past `callTimeout` throws,
    /// so one bad file cannot hold a serve pool slot forever (spec 07 review); the abandoned call is left to finish.
    static func blocking<T>(_ op: @escaping () async throws -> T) throws -> T {
        let box = Box<T>()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            let r: Result<T, Error>
            do { r = .success(try await op()) } catch { r = .failure(error) }
            box.lock.withLock { box.value = r }
            done.signal()
        }
        if done.wait(timeout: .now() + callTimeout) == .timedOut {
            throw Diagnostic("video-timeout", "AVFoundation did not answer within 60 s.")
        }
        box.lock.lock()
        defer { box.lock.unlock() }
        return try box.value!.get()
    }

    struct Opened {
        var asset: AVURLAsset
        var info: VideoInfo
        /// The video track's first and last frame times, unrounded: sampling uses these, the envelope `info`.
        var start: Double
        var end: Double
    }

    /// Opens a video and reads its track (D16): every input error is decided here, before the locale.
    static func open(_ path: String) -> Result<Opened, Diagnostic> {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else {
            return .failure(Diagnostic("input-not-found", "No such file: \(path)"))
        }
        if isDir.boolValue {
            return .failure(Diagnostic(
                "no-videos", "The folder has no .mp4 or .mov videos.", hint: "check the path, or catscan check for images"))
        }
        var st = stat()
        if stat(path, &st) == 0, st.st_mode & S_IFMT != S_IFREG {
            return .failure(Diagnostic("input-unreadable", "Not a regular file: \(path)"))
        }
        let unreadable = Diagnostic(
            "input-unreadable", "Not a readable MP4 or MOV video.", hint: "catscan check \(path) when it is an image")
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let loaded: ([AVAssetTrack], CMTime)
        do {
            loaded = try blocking { (try await asset.load(.tracks), try await asset.load(.duration)) }
        } catch {
            return .failure(unreadable)
        }
        let (tracks, duration) = loaded
        if tracks.isEmpty { return .failure(unreadable) }
        guard let track = tracks.first(where: { $0.mediaType == .video }) else {
            return .failure(Diagnostic(
                "no-video-track", "The file has no video track.",
                hint: "catscan read or catscan check for images; a video needs an MP4 or MOV with a video track"))
        }
        guard let (size, transform, fps, range) = try? blocking({
            (try await track.load(.naturalSize), try await track.load(.preferredTransform), try await track.load(.nominalFrameRate),
             try await track.load(.timeRange))
        }) else { return .failure(unreadable) }
        let upright = CGRect(origin: .zero, size: size).applying(transform)
        guard upright.width.isFinite, upright.height.isFinite, abs(upright.width) < 1e6, abs(upright.height) < 1e6 else {
            return .failure(unreadable)
        }
        let w = Int(abs(upright.width).rounded()), h = Int(abs(upright.height).rounded())
        // The video track's end, not the asset's: a screen recording's audio often runs past the last frame,
        // and a zero-tolerance seek there fails (spec 07 review).
        let seconds = min(duration.seconds, range.end.seconds)
        guard w > 0, h > 0, seconds.isFinite, seconds > 0 else { return .failure(unreadable) }
        if w * h > Engine.maxPixels {
            return .failure(Diagnostic("image-too-large", "The video frames are \(w)x\(h), over the limit of 100 megapixels."))
        }
        let start = range.start.seconds.isFinite ? max(0, range.start.seconds) : 0
        return .success(Opened(
            asset: asset,
            info: VideoInfo(width: w, height: h, fps: (Double(fps) * 100).rounded() / 100, duration: round3(seconds)),
            start: start, end: seconds))
    }

    /// Decodes the frames one ahead of recognition (spec 07 "Recognition"): `consume` gets them in order.
    /// Zero tolerance: each frame comes from the exact time, not the nearest keyframe.
    static func decode(
        _ asset: AVURLAsset, times: [Double], consume: (Int, Result<(CGImage, Double), Error>) -> Bool
    ) {
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        let slots = DispatchSemaphore(value: 2)
        let ready = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var buffer: [Int: Result<(CGImage, Double), Error>] = [:]
        var cancelled = false
        let producer = DispatchGroup()
        producer.enter()
        Thread.detachNewThread {
            defer { producer.leave() }
            for (i, t) in times.enumerated() {
                slots.wait()
                lock.lock()
                let stop = cancelled
                lock.unlock()
                if stop { return }
                let r = Result<(CGImage, Double), Error> {
                    try blocking {
                        let (img, actual) = try await gen.image(at: CMTime(seconds: t, preferredTimescale: 600_000))
                        return (img, actual.seconds)
                    }
                }
                lock.lock()
                buffer[i] = r
                lock.unlock()
                ready.signal()
            }
        }
        for i in times.indices {
            ready.wait()
            lock.lock()
            let r = buffer.removeValue(forKey: i)!
            lock.unlock()
            slots.signal()
            if !consume(i, r) {
                lock.lock()
                cancelled = true
                lock.unlock()
                for _ in times.indices { slots.signal() }
                break
            }
        }
        producer.wait()
    }
}

extension Engine {
    /// `video` (spec 07): open, resolve the locale, then decode and recognize the sampled frames.
    func runVideo(_ job: Job, env e: Envelope, locale: String, finish: (inout Envelope) -> Void) -> Envelope {
        var env = e
        env.video = nil
        let opts = job.video ?? VideoOptions()
        guard let path = job.path else {
            env.verdict = "error"
            env.error = Diagnostic("input-missing", "The request has no path.")
            finish(&env)
            return env
        }
        let opened: Video.Opened
        switch Video.open(path) {
        case .failure(let d):
            env.verdict = "error"
            env.error = d
            finish(&env)
            return env
        case .success(let o): opened = o
        }
        env.video = opened.info
        if let why = languagesError {
            env.verdict = "error"
            env.error = Diagnostic(
                "vision-languages-failed", "Vision could not list its recognition languages: \(why)",
                hint: "rerun; if it persists, report it with the output of catscan --version")
            finish(&env)
            return env
        }
        guard let resolved = resolve(locale) else {
            // D8: the Tesseract fallback does not read video frames.
            env.verdict = "unsupported"
            env.error = Diagnostic(
                "unsupported-language", Tesseract.pack(for: locale) != nil
                    // TODO-065: true for video only; the same locale in a screenshot is read with Tesseract.
                    ? "catscan video does not read the locale \(locale); screenshots of it are read with Tesseract."
                    : "Vision on this Mac cannot read the locale \(locale); catscan video does not use the Tesseract fallback.",
                hint: Languages.corrections[locale.lowercased()].map { "--locale \($0)" } ?? "catscan languages lists the locales this Mac reads")
            env.checks = checkSkeleton(job, verdict: "unsupported")
            finish(&env)
            return env
        }
        if !resolved.exact {
            env.warnings.append(Diagnostic(
                "locale-fallback",
                "The locale \(locale) is not in the language table; reading it as \(resolved.locale) (Vision \(resolved.vision)).",
                hint: "--locale \(resolved.locale)"))
        }
        if !resolved.inTable {
            env.warnings.append(Diagnostic(
                "language-not-in-table",
                "Vision reads \(resolved.vision), which this catscan does not know; checks in its script are not guarded.",
                hint: "upgrade catscan for its script rules"))
        }
        let info = opened.info
        let s = Video.sampleTimes(duration: opened.end, fps: info.fps, opts, start: opened.start)
        if s.over {
            let need = (info.duration / Double(Video.maxSamples) * 1000).rounded(.up) / 1000
            env.verdict = "error"
            env.error = Diagnostic(
                "video-too-many-frames",
                "More than \(Video.maxSamples) samples at --every \(Video.fmt(s.every)); the limit is \(Video.maxSamples).",
                hint: "--every \(Video.fmt(need)), or narrow --from/--to")
            finish(&env)
            return env
        }
        if s.times.isEmpty {
            env.verdict = "error"
            env.error = Diagnostic(
                "no-frames",
                "No frame between --from \(Video.fmt(opts.from)) s and --to \(opts.to.map(Video.fmt) ?? Video.fmt(info.duration)) s; the video is \(Video.fmt(info.duration)) s long.",
                hint: "--from 0")
            finish(&env)
            return env
        }
        if s.clamped {
            env.warnings.append(Diagnostic(
                "every-clamped",
                "--every \(Video.fmt(opts.every)) is shorter than one frame at \(Video.fmt(info.fps)) fps; sampling every frame (\(Video.fmt(s.every)) s)",
                hint: "--every \(Video.fmt(s.every))"))
        }
        var frames: [(t: Double, at: Double, lines: [RecognizedLine])] = []
        var failure: Diagnostic? = nil
        Video.decode(opened.asset, times: s.times) { i, r in
            switch r {
            case .failure:
                failure = Diagnostic(
                    "input-unreadable", "The frame at \(Video.fmt(s.times[i])) s could not be decoded",
                    hint: "re-encode the video as H.264 or HEVC MP4")
                return false
            case .success(let (img, actual)):
                let t = Video.round3(actual.isFinite ? actual : s.times[i])
                // A variable-frame-rate take can return the same frame for two samples (D5): it is read once, and
                // the later sample keeps its own requested time, so ranges still see it.
                if let last = frames.last, last.t == t {
                    frames.append((t, s.times[i], last.lines))
                    return true
                }
                do {
                    frames.append((t, s.times[i], try recognize(img, languages: [resolved.vision, "en-US"], locale: locale)))
                    return true
                } catch {
                    failure = error as? Diagnostic ?? Diagnostic("recognition-failed", "Vision failed: \(error.localizedDescription)")
                    return false
                }
            }
        }
        if let failure {
            env.verdict = "error"
            env.error = failure
            finish(&env)
            return env
        }
        var seenT = Set<Double>()
        let unique = frames.filter { seenT.insert($0.t).inserted }
        env.frames = unique.count
        if opts.frames {
            env.samples = unique.map { f in
                FrameSample(t: f.t, lines: f.lines.map {
                    LineOut(text: $0.text, box: Geometry.box($0.rect), confidence: Geometry.round2($0.confidence))
                })
            }
        }
        Video.evaluate(job, frames: frames, every: s.every, locale: locale, guardScripts: resolved.inTable, env: &env)
        finish(&env)
        return env
    }
}
