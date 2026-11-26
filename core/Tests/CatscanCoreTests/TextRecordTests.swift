// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import Foundation
import XCTest
@testable import CatscanCore

/// TODO-038 T1 and D1-D3: the text record built from literal recognized lines.
final class TextRecordTests: XCTestCase {
    let full = TextRecordJob(mode: "full")

    func rec(_ lines: [String], _ locale: String = "en", _ job: TextRecordJob? = nil) -> TextRecord {
        TextRecord.make(lines, locale: locale, job: job ?? full)
    }

    func testClockMaskedDigitsKept() {
        // Value: protects=D3 (clocks masked, other digits compared); fails_when=the clock mask is dropped or masks every digit; why_new=new; seam=none; no_claim=Vision reads
        XCTAssertEqual(rec(["9:41", "Price 4,99 €"]).digest, rec(["10:05 PM", "Price 4,99 €"]).digest)
        XCTAssertEqual(rec(["9:41"]).lines, ["#"])
        XCTAssertNotEqual(rec(["Price 4,99 €"]).digest, rec(["Price 4,98 €"]).digest)
        XCTAssertNotEqual(rec(["3 lives left"]).digest, rec(["5 lives left"]).digest)
    }

    func testIgnorePatternsBecomeHash() throws {
        // Value: protects=--baseline-ignore (matches on normalized lines become #); fails_when=patterns run before normalization or are skipped; why_new=new; seam=none; no_claim=JS reading the file
        let job = TextRecordJob(mode: "full", ignore: [try NSRegularExpression(pattern: "id [0-9a-f]{6}")], ignoreDigest: "sha256:abc")
        let a = rec(["Install ID 1A2B3C", "Settings"], "en", job), b = rec(["Install ID 9f8e7d", "Settings"], "en", job)
        XCTAssertEqual(a.digest, b.digest)
        XCTAssertEqual(a.lines, ["install #", "settings"])
        XCTAssertEqual(a.ignore, "sha256:abc")
        XCTAssertNotEqual(rec(["Install ID 1A2B3C"]).digest, rec(["Install ID 9f8e7d"]).digest)
    }

    func testPunctuationAndDiacriticsAreJitter() {
        // Value: protects=D1/D2 (punctuation dropped, diacritics folded); fails_when=tokens keep marks or punctuation; why_new=new; seam=none; no_claim=missing glyphs (TODO-036)
        XCTAssertEqual(rec(["Żywieniowe «plan»!"], "pl").digest, rec(["zywieniowe plan"], "pl").digest)
        XCTAssertEqual(rec(["Café, s'il vous plaît"], "fr").tokens, ["cafe", "il", "plait", "s", "vous"])
        XCTAssertNotEqual(rec(["Start game"]).digest, rec(["Stop game"]).digest)
    }

    func testSplitAndJoinedLinesAreEqualAndOrderFree() {
        // Value: protects=D1 (lines joined, tokens sorted); fails_when=tokens are per line or keep order; why_new=new; seam=none; no_claim=unspaced scripts
        XCTAssertEqual(rec(["Continue with", "Google"]).digest, rec(["Continue with Google"]).digest)
        XCTAssertEqual(rec(["B", "A"]).digest, rec(["A", "B"]).digest)
        XCTAssertNotEqual(rec(["A", "B"]).digest, rec(["A"]).digest) // a removed line is a change
    }

    func testMarksThatChangeTheWordAreKept() {
        // Value: protects=review fix (marks fold only on Latin, Greek, Cyrillic; currency kept; all-masked is empty); fails_when=dakuten, Thai tones or nukta fold, a currency swap or a screen masked to # reads unchanged; why_new=red-team finding; seam=none; no_claim=Vietnamese tones (Latin, folded by D2)
        XCTAssertNotEqual(rec(["バス"], "ja").digest, rec(["パス"], "ja").digest)
        XCTAssertNotEqual(rec(["ข้าว"], "th").digest, rec(["ขาว"], "th").digest)
        XCTAssertNotEqual(rec(["फ़ोन खोलें"], "hi").digest, rec(["फोन खोलें"], "hi").digest)
        XCTAssertEqual(rec(["Ελληνικά"], "el").digest, rec(["Ελληνικα"], "el").digest)
        XCTAssertNotEqual(rec(["Price $9.99"]).digest, rec(["Price €9.99"]).digest)
        XCTAssertEqual(rec(["9:41"]).tokens, [])
        XCTAssertEqual(rec(["anything"], "en", TextRecordJob(mode: "full", ignore: [try! NSRegularExpression(pattern: ".+")])).tokens, [])
    }

    func testUnspacedScriptsOneTokenPerLine() {
        // Value: protects=T1 (ja, zh one token per line, punctuation dropped); fails_when=CJK lines are split into characters or joined; why_new=new; seam=none; no_claim=ko, th real screens
        XCTAssertEqual(rec(["設定を開く。", "ホーム"], "ja").tokens, ["ホーム", "設定を開く"])
        XCTAssertEqual(rec(["开始 游戏"], "zh-Hans").tokens, ["开始游戏"])
        XCTAssertNotEqual(rec(["开始游戏"], "zh-Hans").digest, rec(["结束游戏"], "zh-Hans").digest)
    }

    func testDigestStableAndModes() {
        // Value: protects=digest format and --text-record digest; fails_when=the digest is not sha256 of tokens joined by newlines, or digest mode keeps text; why_new=new; seam=JS validate recomputes it; no_claim=none
        let r = rec(["Hello world"])
        XCTAssertEqual(r.digest, TextRecord.digest(["hello", "world"]))
        XCTAssertEqual(TextRecord.digest(["hello", "world"]), "sha256:" + "26c60a61d01db5836ca70fefd44a6a016620413c8ef5f259a6c5612d4f79d3b8")
        let d = rec(["Hello world"], "en", TextRecordJob(mode: "digest"))
        XCTAssertNil(d.tokens)
        XCTAssertNil(d.lines)
        XCTAssertEqual(d.digest, r.digest)
        let json = String(decoding: try! JSONEncoder().encode(d), as: UTF8.self)
        XCTAssertFalse(json.contains("tokens"))
        XCTAssertFalse(json.contains("lines"))
        XCTAssertEqual(rec([]).tokens, [])
    }

    func testServeRequestParsingAndEnvelope() throws {
        // Value: protects=serve text_record field and the envelope key; fails_when=a bad mode or pattern is accepted, or text is emitted unasked; why_new=new; seam=Server.textRecordJob; no_claim=Vision reads
        if case .success = Server.textRecordJob(["mode": "none"]) { XCTFail("none must be rejected") }
        if case .success = Server.textRecordJob(["mode": "full", "ignore": ["("]]) { XCTFail("bad regex must be rejected") }
        guard case .success(let t) = Server.textRecordJob(["mode": "digest", "ignore": ["\\d+"], "ignore_digest": "sha256:x"]) else { return XCTFail() }
        XCTAssertEqual(t.mode, "digest")
        XCTAssertEqual(t.ignore.count, 1)
        XCTAssertEqual(t.ignoreDigest, "sha256:x")
        let host = HostInfo(chip: "x", arch: "arm64", host_class: "x", macos: "27", vision_revision: 3)
        var env = Envelope(command: "check", path: "a.png", verdict: "error", engine: "e", locale: "en", image: nil, host: host)
        XCTAssertFalse(String(decoding: JSONLine.encode(env), as: UTF8.self).contains("\"text\""))
        env.textAsked = true
        XCTAssertTrue(String(decoding: JSONLine.encode(env), as: UTF8.self).contains("\"text\":null"))
    }
}
