// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// Spec 07: sampling (D5, D17), aggregation over frames (D2, D7) and the serve fields (D3), without decoding.
final class VideoTests: XCTestCase {
    func line(_ text: String, y: Double = 0.4) -> RecognizedLine {
        RecognizedLine(text: text, rect: CGRect(x: 0.1, y: y, width: 0.5, height: 0.05), confidence: 0.95)
    }

    func opts(every: Double = 0.5, from: Double = 0, to: Double? = nil) -> VideoOptions {
        var o = VideoOptions()
        o.every = every
        o.from = from
        o.to = to
        return o
    }

    func testSampleGrid() {
        // Value: protects=D5 sample times (from + k*every, t <= to, t < duration); fails_when=an off-by-one adds t == duration or drops t == to; why_new=new; seam=none; no_claim=decoder actual times (integration)
        XCTAssertEqual(Video.sampleTimes(duration: 6, fps: 30, opts()).times.count, 12)
        XCTAssertEqual(Video.sampleTimes(duration: 6, fps: 30, opts()).times.last, 5.5)
        XCTAssertEqual(Video.sampleTimes(duration: 6, fps: 30, opts(from: 1, to: 2)).times, [1, 1.5, 2])
        XCTAssertEqual(Video.sampleTimes(duration: 2, fps: 30, opts(to: 9)).times, [0, 0.5, 1, 1.5])
        XCTAssertEqual(Video.sampleTimes(duration: 2, fps: 30, opts(from: 2)).times, [])
        // 0.1 * 3 is 0.30000000000000004: the bound still includes it.
        XCTAssertEqual(Video.sampleTimes(duration: 1, fps: 30, opts(every: 0.1, to: 0.3)).times.count, 4)
    }

    func testTrackStartBoundsTheFirstSample() {
        // Value: protects=a video track that starts late is never sought before its first frame; fails_when=sampling starts at --from 0 regardless of the track start; why_new=review finding (Codex + native); seam=none; no_claim=a real edit-list file
        // The grid stays from + k * every (D5): a track starting at 1.2 s is first sampled at 1.5 s.
        XCTAssertEqual(Video.sampleTimes(duration: 3, fps: 10, opts(), start: 1.2).times, [1.5, 2, 2.5])
        XCTAssertEqual(Video.sampleTimes(duration: 3, fps: 10, opts(), start: 1.5).times, [1.5, 2, 2.5])
        XCTAssertEqual(Video.sampleTimes(duration: 3, fps: 10, opts(), start: 1.5000001).times, [2, 2.5]) // never before start
        XCTAssertEqual(Video.sampleTimes(duration: 3, fps: 10, opts(from: 2), start: 1.2).times, [2, 2.5])
        XCTAssertEqual(Video.sampleTimes(duration: 0.1, fps: 100, opts(every: 0.01), start: 0.07).times.first, 0.07)
    }

    func testEveryClampedToOneFrame() {
        let s = Video.sampleTimes(duration: 1, fps: 10, opts(every: 0.01))
        XCTAssertTrue(s.clamped)
        XCTAssertEqual(s.every, 0.1, accuracy: 1e-9)
        XCTAssertEqual(s.times.count, 10)
        XCTAssertFalse(Video.sampleTimes(duration: 1, fps: 10, opts(every: 0.1)).clamped)
    }

    func testSampleCap() {
        // Value: protects=D17 20,000-sample cap; fails_when=the loop stops checking the cap and a long take runs for hours; why_new=new; seam=none; no_claim=none beyond protects
        XCTAssertTrue(Video.sampleTimes(duration: 20_001, fps: 30, opts(every: 1)).over)
        XCTAssertFalse(Video.sampleTimes(duration: 20_000, fps: 30, opts(every: 1)).over)
    }

    func run(_ job: Job, _ frames: [(Double, [RecognizedLine])]) -> Envelope {
        var env = Envelope(command: "video", path: "t.mp4", verdict: "pass", engine: "e", locale: "en", image: nil,
                           host: HostInfo(chip: "c", arch: "a", host_class: "physical", macos: "1 (b)", vision_revision: 3))
        Video.evaluate(job, frames: frames.map { (t: $0.0, at: $0.0, lines: $0.1) }, every: job.video?.every ?? 0.5, locale: "en",
                       guardScripts: true, env: &env)
        return env
    }

    let take: [(Double, [RecognizedLine])] = [
        (0, []), (0.5, []), (1, [RecognizedLine(text: "KEY_RAW", rect: .init(x: 0.1, y: 0.7, width: 0.5, height: 0.05), confidence: 0.9)]),
        (1.5, []), (2, [RecognizedLine(text: "GAME OVER", rect: .init(x: 0.2, y: 0.4, width: 0.5, height: 0.05), confidence: 1)]),
        (2.5, [RecognizedLine(text: "GAME OVER", rect: .init(x: 0.2, y: 0.4, width: 0.5, height: 0.05), confidence: 0.8)]),
        (3, [RecognizedLine(text: "GAME 0VER!", rect: .init(x: 0.2, y: 0.4, width: 0.5, height: 0.05), confidence: 0.5)]),
    ]

    func testPresentAndAbsentOverFrames() {
        // Value: protects=D2 aggregation (any frame for present, no frame for absent, first/last seen, first frame's box); fails_when=aggregation reads only one frame or the last; why_new=new; seam=none; no_claim=Vision output (integration)
        var job = Job(command: "video")
        job.present = ["GAME OVER", "GAME OVR"]
        job.absent = ["KEY_RAW", "Settings"]
        let env = run(job, take)
        XCTAssertEqual(env.verdict, "fail")
        let c = env.checks
        XCTAssertEqual(c.map(\.verdict), ["pass", "fail", "fail", "pass"])
        XCTAssertEqual(c[0].firstSeen, 2)
        XCTAssertEqual(c[0].lastSeen, 2.5)
        XCTAssertEqual(c[0].confidence, 1) // the first frame found, not the last
        XCTAssertEqual(c[0].box, [0.2, 0.4, 0.5, 0.05])
        XCTAssertNil(c[1].firstSeen)
        XCTAssertEqual(c[1].closest?.t, 2) // the closest line over all frames; the first wins ties
        XCTAssertEqual(c[2].firstSeen, 1)
        XCTAssertEqual(c[2].lastSeen, 1) // shown on one sampled frame only: still a failure
        XCTAssertNil(c[3].firstSeen)
    }

    func testRangesLimitFramesAndEmptyRangeIsSkipped() {
        // Value: protects=D7 inclusive ranges, open end and range-empty skip with its warning; fails_when=a bound turns exclusive or an empty range passes silently; why_new=new; seam=none; no_claim=none beyond protects
        var job = Job(command: "video")
        var o = VideoOptions()
        var a = VideoRange(key: "0-1", start: 0, end: 1); a.absent = ["GAME OVER", "KEY_RAW"]
        var b = VideoRange(key: "2-", start: 2, end: nil); b.present = ["GAME OVER"]
        var e = VideoRange(key: "0.6-0.9", start: 0.6, end: 0.9); e.present = ["x"]
        o.ranges = [a, b, e]
        job.video = o
        let env = run(job, take)
        XCTAssertEqual(env.checks.map(\.verdict), ["pass", "fail", "pass", "skipped"])
        XCTAssertEqual(env.checks.map(\.range), ["0-1", "0-1", "2-", "0.6-0.9"])
        XCTAssertEqual(env.checks[1].firstSeen, 1) // end bound inclusive
        XCTAssertEqual(env.checks[3].reason, "range-empty")
        XCTAssertEqual(env.warnings.map(\.code), ["range-empty"])
        XCTAssertEqual(env.verdict, "fail")
    }

    func testCatalogAndUnsupportedChecks() {
        var job = Job(command: "video")
        job.catalog = [CatalogCheck(kind: "present", key: "over", text: "GAME OVER", alternatives: [["GAME OVER"]])]
        job.absent = ["設定"]
        let env = run(job, take)
        XCTAssertEqual(env.checks[0].verdict, "unsupported")
        XCTAssertEqual(env.checks[1].verdict, "pass")
        XCTAssertEqual(env.checks[1].key, "over")
        XCTAssertEqual(env.checks[1].firstSeen, 2)
        XCTAssertEqual(env.verdict, "unsupported")
    }

    func testSkippedCatalogCheckIsReportedOnce() {
        // Value: protects=a catalog check skipped on every frame (catalog-missing) is one skipped result with its range, never pass or fail; fails_when=the per-frame skip is folded into the seen/unseen aggregation; why_new=only literal checks were aggregated in tests; seam=none; no_claim=none beyond protects
        var job = Job(command: "video")
        var o = VideoOptions()
        var r = VideoRange(key: "0-", start: 0, end: nil)
        r.catalog = [CatalogCheck(kind: "absent", key: "gone", text: "x", alternatives: [], reason: "catalog-missing")]
        o.ranges = [r]
        job.video = o
        let env = run(job, take)
        XCTAssertEqual(env.checks.count, 1)
        XCTAssertEqual(env.checks[0].verdict, "skipped")
        XCTAssertEqual(env.checks[0].reason, "catalog-missing")
        XCTAssertEqual(env.checks[0].range, "0-")
        XCTAssertEqual(env.warnings.map(\.code), ["catalog-missing"])
        XCTAssertEqual(env.verdict, "pass")
    }

    func testRangesUseTheRequestedTime() {
        // Value: protects=ranges match the requested sample time, not the decoder's earlier frame time (29.97 fps); fails_when=range filtering reads the actual frame time and "4-6" loses the 4.0 s sample; why_new=review finding; seam=none; no_claim=real 29.97 fps decode
        var job = Job(command: "video")
        var o = VideoOptions()
        var r = VideoRange(key: "4-6", start: 4, end: 6); r.present = ["GAME OVER"]
        o.ranges = [r]
        job.video = o
        var env = Envelope(command: "video", path: "t.mp4", verdict: "pass", engine: "e", locale: "en", image: nil,
                           host: HostInfo(chip: "c", arch: "a", host_class: "physical", macos: "1 (b)", vision_revision: 3))
        Video.evaluate(job, frames: [(t: 3.971, at: 4, lines: [line("GAME OVER")])], every: 0.5, locale: "en", guardScripts: true, env: &env)
        XCTAssertEqual(env.checks[0].verdict, "pass")
        XCTAssertEqual(env.checks[0].firstSeen, 3.971)
    }

    func testDuplicateFrameKeepsItsRequestedTime() {
        // Value: protects=a VFR frame returned for two samples still counts for a range starting at the later sample; fails_when=the duplicate sample is dropped with its requested time; why_new=review finding (Codex + native); seam=none; no_claim=real VFR decode
        var job = Job(command: "video")
        var o = VideoOptions()
        var r = VideoRange(key: "4-4.4", start: 4, end: 4.4); r.absent = ["KEY_RAW"]
        o.ranges = [r]
        job.video = o
        let key = [RecognizedLine(text: "KEY_RAW", rect: .init(x: 0.1, y: 0.7, width: 0.5, height: 0.05), confidence: 0.9)]
        var env = Envelope(command: "video", path: "t.mp4", verdict: "pass", engine: "e", locale: "en", image: nil,
                           host: HostInfo(chip: "c", arch: "a", host_class: "physical", macos: "1 (b)", vision_revision: 3))
        Video.evaluate(job, frames: [(t: 3.5, at: 3.5, lines: key), (t: 3.5, at: 4, lines: key)], every: 0.5, locale: "en",
                       guardScripts: true, env: &env)
        XCTAssertEqual(env.checks[0].verdict, "fail")
    }

    func testEnvelopeEncodesVideoFields() throws {
        // Value: protects=D12 envelope (image null, video, frames, first_seen/last_seen null when unseen); fails_when=encode drops a null or the video keys; why_new=new; seam=none; no_claim=none beyond protects
        var job = Job(command: "video")
        job.present = ["GAME OVR"]
        var env = run(job, take)
        env.video = VideoInfo(width: 720, height: 1280, fps: 10, duration: 4)
        env.frames = 7
        let o = try JSONSerialization.jsonObject(with: JSONLine.encode(env)) as! [String: Any]
        XCTAssertTrue(o["image"] is NSNull)
        XCTAssertEqual(o["frames"] as? Int, 7)
        XCTAssertNil(o["samples"])
        let c = (o["checks"] as! [[String: Any]])[0]
        XCTAssertTrue(c["first_seen"] is NSNull)
        XCTAssertNil(c["range"])
        XCTAssertEqual((c["closest"] as? [String: Any])?["t"] as? Double, 2)
        let img = try JSONSerialization.jsonObject(with: JSONLine.encode(Envelope(
            command: "check", path: "a.png", verdict: "pass", engine: "e", locale: "en", image: nil, host: env.host))) as! [String: Any]
        XCTAssertNil(img["video"]) // image envelopes are unchanged
    }

    func testServeVideoFields() {
        // Value: protects=D3 request validation (numbers, booleans, ranges) as invalid-request; fails_when=a malformed field reaches the engine; why_new=new; seam=none; no_claim=the serve loop (test/video.test.js drives it)
        func opts(_ o: [String: Any]) -> VideoOptions? { try? Server.videoOptions(o).get() }
        let o = opts(["every": 0.25, "from": 1, "to": 3, "frames": true, "ranges": [["key": "0-1", "start": 0, "end": 1, "present": ["x"]], ["key": "2-", "start": 2, "end": NSNull(), "absent": ["y"]]]])
        XCTAssertEqual(o?.every, 0.25)
        XCTAssertEqual(o?.to, 3)
        XCTAssertEqual(o?.frames, true)
        XCTAssertEqual(o?.ranges.map(\.key), ["0-1", "2-"])
        XCTAssertNil(o?.ranges[1].end)
        XCTAssertEqual(opts(["every": 1])?.every, 1) // a JSON 1 is a number, not true
        for bad: [String: Any] in [
            ["every": 0], ["every": true], ["every": "1"], ["from": -1], ["from": 2, "to": 2], ["frames": 1],
            ["ranges": [["key": "a", "start": 2, "end": 1]]], ["ranges": [["start": 0]]], ["ranges": [["key": "a", "start": 0, "present": [3]]]],
        ] {
            XCTAssertNil(opts(bad), "\(bad)")
        }
    }
}
