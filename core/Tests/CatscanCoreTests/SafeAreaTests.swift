// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import XCTest
@testable import CatscanCore

/// TODO-073: the `fit` rule on synthetic lines and profiles (no Vision). Profile: 100x200 portrait, a cutout at
/// x 40..60, y 5..15, four 10 px corners, a home indicator [35, 190, 30, 2] (grown: x 33..67, y 188..194).
/// Lines without character ranges get even shares of the line box (D23), so 10 characters over 40 px are 4 px each.
final class SafeAreaTests: XCTestCase {
    static func corners(w: Int, h: Int, r: Int) -> [[Int]] {
        var runs: [[Int]] = []
        for y in 0..<r { let n = r - y; runs += [[y, 0, n], [y, w - n, w], [h - 1 - y, 0, n], [h - 1 - y, w - n, w]] }
        return runs
    }

    static let profile = DeviceProfile(
        id: "test-phone", platform: "ios", width: 100, height: 200,
        zones: [.init(kind: "cutout", runs: (5..<15).map { [$0, 40, 60] }, box: nil),
                .init(kind: "corner", runs: corners(w: 100, h: 200, r: 10), box: nil),
                .init(kind: "home-indicator", runs: [], box: [35, 190, 30, 2])],
        landscapeHome: [85, 90, 30, 2])

    func line(_ t: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double) -> RecognizedLine {
        RecognizedLine(text: t, rect: CGRect(x: x, y: y, width: w, height: h), confidence: 0.9)
    }

    func job(_ p: DeviceProfile? = profile) -> FitJob {
        var j = FitJob()
        j.profile = p
        j.version = "2026-11-20"
        return j
    }

    func run(_ j: FitJob, _ lines: [RecognizedLine], w: Int = 100, h: Int = 200) -> Fit.Outcome {
        Fit.evaluate(j, lines: lines, width: w, height: h, path: "s.png")
    }

    /// A 10-character line from x 31 px (4 px per character) at y 6..12: C (39..43) is 3/4 hidden, H (59..63) 1/4.
    var title: RecognizedLine { line("ABCDEFGHIJ", 0.31, 0.03, 0.40, 0.03) }

    func testTitleUnderCutoutReportsItsHiddenLetters() {
        // Value: protects=TODO-073 rule step 2 and Output; fails_when=a hidden letter is missed, an unhidden one listed, or a field drifts; why_new=new rule; seam=Fit.evaluate; no_claim=Vision's character boxes
        let r = run(job(), [title])
        XCTAssertEqual(r.findings.count, 1)
        let f = r.findings[0]
        XCTAssertEqual(f.reason, "cutout")
        XCTAssertEqual(f.hidden, "CDEFG")
        XCTAssertEqual(f.hiddenBox, [0.39, 0.03, 0.2, 0.03])
        XCTAssertEqual(f.zoneBox, [0.4, 0.025, 0.2, 0.05])
        XCTAssertEqual(f.profile, "test-phone")
        XCTAssertEqual(r.reasonsRun, ["cutout", "corner", "home-indicator"])
        XCTAssertEqual(r.deviceProfile, DeviceProfileOut(id: "test-phone", ids: ["test-phone"], orientation: "portrait", matchedBy: "flag", version: "2026-11-20"))
    }

    func testMinHiddenAtAndJustOver() {
        // Value: protects=min_hidden threshold; fails_when=the share comparison flips; why_new=new rule; seam=FitJob.minHidden; no_claim=the 0.5 default's tuning
        var j = job()
        j.minHidden = 0.74
        XCTAssertEqual(run(j, [title]).findings.first?.hidden, "CDEFG")
        j.minHidden = 0.76
        XCTAssertEqual(run(j, [title]).findings.first?.hidden, "DEFG")
        // A single character 1/4 hidden is no finding at the default.
        XCTAssertTrue(run(job(), [line("W", 0.59, 0.03, 0.04, 0.03)]).findings.isEmpty)
    }

    func testSameScreenAtOtherScaleGivesSameFindings() {
        // Value: protects=D14 (normalized zones against normalized boxes); fails_when=pixel math uses the image size instead of the profile's; why_new=new rule; seam=Fit.evaluate width/height; no_claim=Vision's 2x upscale itself
        let a = run(job(), [title]), b = run(job(), [title], w: 300, h: 600), c = run(job(), [title], w: 50, h: 100)
        XCTAssertEqual(a.findings, b.findings)
        XCTAssertEqual(a.findings, c.findings)
    }

    func testCornerAndHomeIndicatorAndFirstZoneOrder() {
        // Value: protects=rule steps 1 and 5; fails_when=the indicator is not grown or a line gets two findings; why_new=new rule; seam=Fit.layout; no_claim=real indicator sizes
        // "WXYZ" in the top-left corner 2 px off the edges: W (2..6) at y 2..6 is in the corner triangle.
        let corner = run(job(), [line("WXYZ", 0.03, 0.01, 0.16, 0.02)])
        XCTAssertEqual(corner.findings.map(\.reason), ["corner"])
        // Just above the grown box (y 188..194): y 186..188 is not covered; y 188..190 is (the bar is at 190..192).
        let home = run(job(), [line("Weiter", 0.40, 0.93, 0.20, 0.01)])
        XCTAssertEqual(home.findings.map(\.reason), [])
        let home2 = run(job(), [line("Weiter", 0.40, 0.94, 0.20, 0.01)])
        XCTAssertEqual(home2.findings.map(\.reason), ["home-indicator"])
    }

    func testSkips() {
        // Value: protects=rule step 4 (no letter, allow, edge, scrolls, offscreen); fails_when=a skipped line is reported; why_new=new rule; seam=Fit.evaluate; no_claim=real scrolled content
        XCTAssertTrue(run(job(), [line("•••", 0.31, 0.03, 0.40, 0.03)]).findings.isEmpty)
        var j = job()
        j.allow = ["ABCDEFGHIJ"]
        XCTAssertTrue(run(j, [title]).findings.isEmpty)
        // Touching the top edge (y 0) next to the cutout's side: content scrolled off, left to `truncated`.
        XCTAssertTrue(run(job(), [line("ABCDEFGHIJ", 0.31, 0.0, 0.40, 0.06)]).findings.isEmpty)
        j = job()
        j.boxes = TruncationJob.Boxes(width: 100, height: 200, elements: [.init(id: "list", rect: CGRect(x: 0, y: 0, width: 1, height: 0.5), scrolls: true)])
        XCTAssertTrue(run(j, [title]).findings.isEmpty)
        j.boxes!.elements[0].scrolls = false
        j.boxes!.elements[0].offscreen = true
        XCTAssertTrue(run(j, [title]).findings.isEmpty)
        j.boxes!.elements[0].offscreen = false
        j.boxes!.elements[0].id = "title"
        let f = run(j, [title]).findings
        XCTAssertEqual(f.first?.element, Finding.Element(id: "title", box: [0, 0, 1, 0.5]))
        j.allow = ["title"]
        XCTAssertTrue(run(j, [title]).findings.isEmpty, "an element id in --allow")
    }

    func testCharacterRangesWinOverEvenShares() {
        // Value: protects=D6 (Vision's character boxes, not the line box); fails_when=ranges are ignored; why_new=new rule; seam=RecognizedLine.rangeBox; no_claim=Vision's real ranges
        var l = title
        // Every character's box sits left of the cutout: no finding though the line box crosses it.
        l.rangeBox = { _ in CGRect(x: 0.1, y: 0.03, width: 0.04, height: 0.03) }
        XCTAssertTrue(run(job(), [l]).findings.isEmpty)
    }

    func testRightToLeftHiddenKeepsStringOrder() {
        // Value: protects=hidden in reading order; fails_when=hidden is built from geometry order; why_new=new rule; seam=Fit.characters; no_claim=bidi layout of mixed runs
        var l = line("אבגדהוזחטי", 0.31, 0.03, 0.40, 0.03)
        let chars = Array(l.text.indices)
        // Right to left: the first character is drawn rightmost.
        l.rangeBox = { r in
            let n = chars.firstIndex(of: r.lowerBound)!
            return CGRect(x: 0.67 - Double(n) * 0.04, y: 0.03, width: 0.04, height: 0.03)
        }
        XCTAssertEqual(run(job(), [l]).findings.first?.hidden, "דהוזח")
    }

    func testControls() {
        // Value: protects=rule step 3, D12 (share, no center rule), controls gate; fails_when=a padded target under min_control is reported or a covered icon missed; why_new=new rule; seam=Fit.evaluate controls; no_claim=real touch targets
        func el(_ id: String, _ r: CGRect, text: String? = nil, scrolls: Bool = false) -> TruncationJob.Element {
            .init(id: id, rect: r, text: text, scrolls: scrolls, control: true)
        }
        var j = job()
        // close: x 0..10, y 0..10 px -> the corner triangle covers 55 of 100 px.
        j.boxes = TruncationJob.Boxes(width: 100, height: 200, elements: [
            el("close", CGRect(x: 0, y: 0, width: 0.1, height: 0.05)),
            // Center (50, 10) inside the cutout, but the 40x40 px target is only 20x10 = 12.5% covered.
            el("menu", CGRect(x: 0.3, y: 0.0, width: 0.4, height: 0.2)),
            el("labelled", CGRect(x: 0.4, y: 0.025, width: 0.2, height: 0.05), text: "OK"),
            el("scrolled", CGRect(x: 0.9, y: 0.0, width: 0.1, height: 0.05), scrolls: true),
        ])
        // "OK" is drawn: Vision reads it inside its element, so the element is checked as text (a text finding), never
        // as a control.
        let ok = line("OK", 0.45, 0.06, 0.1, 0.01)
        let all = run(j, [ok]).findings
        XCTAssertEqual(all.map { [$0.element?.id ?? "-", $0.lineNull ? "control" : "text"] }, [["close", "control"], ["labelled", "text"]])
        let f = all.filter(\.lineNull)
        XCTAssertEqual(f[0].covered, 0.55)
        XCTAssertTrue(f[0].lineNull)
        XCTAssertNil(f[0].hidden)
        j.minControl = 0.6
        XCTAssertFalse(run(j, [ok]).findings.contains(where: \.lineNull))
        j.minControl = 0.25
        j.controls = []
        XCTAssertFalse(run(j, [ok]).findings.contains(where: \.lineNull), "controls off while experimental")
        // D37: per zone; corner controls off leaves the corner's close button unchecked.
        j.controls = ["cutout", "home-indicator"]
        XCTAssertFalse(run(j, [ok]).findings.contains(where: \.lineNull), "corner controls off")
    }

    func testLabelledIconButtonIsAControl() {
        // Value: protects=D38 (a control whose text is only its accessibility label is checked as a control); fails_when=a labelled icon button under a zone is skipped, or a control with drawn text becomes a control finding; why_new=review finding (labelled icons were silently unchecked); seam=Fit.evaluate controls; no_claim=Vision missing drawn text (then the element is a control too)
        var j = job()
        j.boxes = TruncationJob.Boxes(width: 100, height: 200, elements: [
            .init(id: "close", rect: CGRect(x: 0, y: 0, width: 0.1, height: 0.05), text: "Close", control: true),
        ])
        XCTAssertEqual(run(j, []).findings.map { $0.element?.id }, ["close"], "label only: no line inside it")
        XCTAssertTrue(run(j, [line("Close", 0.02, 0.02, 0.06, 0.01)]).findings.allSatisfy { !$0.lineNull }, "drawn: checked as text")
    }

    func testLandscapeRotationAndUnknownSide() {
        // Value: protects=D5 (rotation per side; cutout skipped without a side); fails_when=the cutout lands on the wrong side or runs without one; why_new=new rule; seam=Fit.layout; no_claim=real landscape captures (the profile script checks those)
        // Landscape 200x100: landscape-left puts the cutout on the left edge at x 5..15, y 40..60.
        let left = line("ABCDEFGHIJ", 0.02, 0.45, 0.10, 0.05)
        var j = job()
        j.orientation = "landscape-left"
        XCTAssertEqual(run(j, [left], w: 200, h: 100).findings.map(\.reason), ["cutout"])
        j.orientation = "landscape-right"
        XCTAssertTrue(run(j, [left], w: 200, h: 100).findings.isEmpty)
        j.orientation = nil
        let r = run(j, [left], w: 200, h: 100)
        XCTAssertTrue(r.findings.isEmpty)
        XCTAssertEqual(r.reasonsSkipped, [SkippedReason(reason: "cutout", cause: "orientation-unknown")])
        XCTAssertEqual(r.reasonsRun, ["corner", "home-indicator"])
        XCTAssertEqual(r.warnings.map(\.code), ["orientation-unknown"])
        XCTAssertEqual(r.deviceProfile?.orientation, "landscape")
        // The landscape home indicator box is stored in landscape pixels.
        XCTAssertEqual(run(j, [line("Weiter", 0.43, 0.91, 0.14, 0.02)], w: 200, h: 100).findings.map(\.reason), ["home-indicator"])
    }

    func testZonelessProfileChecksNothing() {
        // Value: protects=a zone-less profile is valid and yields nothing; fails_when=it errors or reports; why_new=new rule; seam=Fit.evaluate; no_claim=none
        let se = DeviceProfile(id: "se", platform: "ios", width: 100, height: 200, zones: [])
        let r = run(job(se), [title])
        XCTAssertTrue(r.findings.isEmpty)
        XCTAssertEqual(r.reasonsRun, [])
        XCTAssertEqual(r.deviceProfile?.id, "se")
    }

    func testMatching() {
        // Value: protects=D3, D4, D10 matching; fails_when=a size, transpose or downscale is missed, Android matches by size, or ambiguity is not intersected; why_new=new matching; seam=Fit.match; no_claim=the shipped table
        var j = job(nil)
        let other = DeviceProfile(id: "other", platform: "ios", width: 100, height: 200, zones: [.init(kind: "cutout", runs: (8..<15).map { [$0, 45, 55] }, box: nil)])
        let android = DeviceProfile(id: "pixel", platform: "android", width: 120, height: 240, zones: Self.profile.zones)
        j.table = [Self.profile, android]
        XCTAssertEqual(Fit.match(j, width: 100, height: 200)?.matchedBy, "size")
        XCTAssertEqual(Fit.match(j, width: 200, height: 100)?.ids, ["test-phone"])
        XCTAssertEqual(Fit.match(j, width: 50, height: 100)?.matchedBy, "scale")
        XCTAssertNil(Fit.match(j, width: 120, height: 240), "Android needs a named profile (D10)")
        XCTAssertNil(Fit.match(j, width: 51, height: 100))
        j.platform = "android"
        XCTAssertNil(Fit.match(j, width: 100, height: 200))
        j.platform = nil
        var same = Self.profile
        same.id = "twin"
        j.table = [Self.profile, same]
        let m = Fit.match(j, width: 100, height: 200)!
        XCTAssertEqual(m.ids, ["test-phone", "twin"])
        XCTAssertFalse(m.ambiguous)
        j.table = [Self.profile, other]
        let a = Fit.match(j, width: 100, height: 200)!
        XCTAssertTrue(a.ambiguous)
        XCTAssertEqual(Fit.zoneRows(a.profile, "cutout").keys.sorted(), Array(8..<15))
        XCTAssertTrue(a.profile.zones.allSatisfy { $0.kind == "cutout" }, "corners and indicator hidden on one only")
        let r = run(j, [title])
        XCTAssertEqual(r.warnings.map(\.code), ["device-ambiguous"])
        XCTAssertEqual(r.findings.first?.hidden, "EF", "only rows 8..14, x 45..55 are hidden on both")
        XCTAssertEqual(r.findings.first?.profile, "test-phone+other", "an intersected check names every candidate")
        let none = run(job(nil), [title], w: 123, h: 456)
        XCTAssertNil(none.deviceProfile)
        XCTAssertEqual(none.reasonsSkipped.map(\.cause), ["device-unknown", "device-unknown", "device-unknown"])
    }

    func testPR2FollowUps() {
        // Value: protects=the PR 2 review follow-ups (symbol-only icons are controls, clickable containers with text are not, upside-down and contradicting orientations skip the cutout and say why, web point sizes never match by downscale, a home indicator needs its landscape box); fails_when=any of those regresses to the PR 1 behavior; why_new=review 2026-11-20 follow-ups; seam=Fit.evaluate, Fit.match, DeviceProfile.parse; no_claim=real dumps (converter tests cover rotation 2)
        var j = job()
        j.boxes = TruncationJob.Boxes(width: 100, height: 200, elements: [
            // "+" is drawn inside the icon: no letter or digit, so it is still a textless control.
            .init(id: "add", rect: CGRect(x: 0, y: 0, width: 0.1, height: 0.05), text: "+", control: true),
            // A clickable row whose child text Vision reads: checked as that text, never again as a control.
            .init(id: "row", rect: CGRect(x: 0.9, y: 0.0, width: 0.1, height: 0.05), control: true),
        ])
        let r = run(j, [line("+", 0.03, 0.02, 0.04, 0.01), line("Go", 0.91, 0.02, 0.06, 0.01)])
        XCTAssertEqual(r.findings.filter(\.lineNull).map { $0.element?.id }, ["add"])

        // uiautomator rotation 2: the cutout is at the bottom of an upright image, so it is skipped and said so.
        var u = job()
        u.orientation = "portrait-upside-down"
        let up = run(u, [title])
        XCTAssertTrue(up.findings.isEmpty)
        XCTAssertEqual(up.reasonsSkipped, [SkippedReason(reason: "cutout", cause: "orientation-unknown")])
        XCTAssertEqual(up.reasonsRun, ["corner", "home-indicator"])
        XCTAssertEqual(up.deviceProfile?.orientation, "portrait-upside-down")
        XCTAssertEqual(up.warnings.first?.message, "s.png was taken upside down (portrait-upside-down), so its cutout is at the bottom; cutout skipped")
        // --orientation portrait on a landscape image: the contradiction is named, not "side unknown".
        var c = job()
        c.orientation = "portrait"
        XCTAssertEqual(run(c, [], w: 200, h: 100).warnings.first?.message, "s.png is landscape but its stated orientation is portrait; cutout skipped")

        // A web viewport at 1x CSS pixels (the profile's point size) is not a downscaled phone screenshot.
        var w = job(nil)
        var p3 = Self.profile
        p3.width = 300; p3.height = 600; p3.scale = 3; p3.zones = []; p3.landscapeHome = nil
        w.table = [p3]
        XCTAssertNil(Fit.match(w, width: 100, height: 200), "point size")
        XCTAssertEqual(Fit.match(w, width: 150, height: 300)?.matchedBy, "scale", "another downscale still matches")
        w.platform = "web"
        XCTAssertNil(Fit.match(w, width: 300, height: 600), "a web run never takes a phone profile")

        // D40: a portrait home indicator without its landscape box is not a valid profile.
        let row: [String: Any] = ["id": "x", "screen": ["width": 100, "height": 200], "zones": [["kind": "home-indicator", "box": [35, 190, 30, 2]]]]
        XCTAssertNil(DeviceProfile.parse(row))
        var withLand = row
        withLand["landscape"] = ["home-indicator": ["box": [85, 90, 30, 2]]]
        XCTAssertNotNil(DeviceProfile.parse(withLand))
        // The point-size guard reads screen.scale from the shipped rows.
        var scaled = withLand
        scaled["screen"] = ["width": 100, "height": 200, "scale": 3]
        XCTAssertEqual(DeviceProfile.parse(scaled)?.scale, 3)

        // A landscape image whose sidecar says upside down has no known side: the cutout is skipped as side unknown.
        var lu = job()
        lu.orientation = "portrait-upside-down"
        let l = run(lu, [], w: 200, h: 100)
        XCTAssertEqual(l.reasonsSkipped, [SkippedReason(reason: "cutout", cause: "orientation-unknown")])
        XCTAssertEqual(l.warnings.first?.message, "s.png is landscape and its side is unknown; cutout skipped")
    }

    func testGivenProfileOfOtherAspectIsAnError() {
        // Value: protects=device-profile-mismatch (exit 4 for that image); fails_when=a wrong profile silently checks; why_new=new diagnostic; seam=Fit.mismatch; no_claim=none
        let r = run(job(), [title], w: 100, h: 210)
        XCTAssertEqual(r.error?.code, "device-profile-mismatch")
        XCTAssertEqual(r.error?.message, "s.png is 100x210 but the profile test-phone is 100x200 (aspect differs by 5.0%)")
    }

    func testEncodingAndServeField() throws {
        // Value: protects=Output shape (null-explicit, line null for a control) and the serve field's errors; fails_when=a field is dropped or a bad profile passes; why_new=new kind; seam=Finding.encode, Server.fitJob; no_claim=none
        var f = Finding(kind: "fit", box: [0, 0, 0.1, 0.05], line: "")
        f.lineNull = true
        f.reason = "corner"
        let o = try JSONSerialization.jsonObject(with: JSONEncoder().encode(f)) as! [String: Any]
        XCTAssertEqual(Set(o.keys), ["kind", "box", "line", "reason", "hidden", "hidden_box", "zone_box", "element", "profile", "covered", "confidence"])
        XCTAssertTrue(o["line"] is NSNull)
        guard case .failure(let d) = Server.fitJob(["profile": ["id": "x"]]) else { return XCTFail() }
        XCTAssertEqual(d.code, "invalid-request")
        guard case .failure = Server.fitJob(["orientation": "upside-down"]) else { return XCTFail() }
        // D39: a uiautomator rotation-2 sidecar reaches the core (protocol 19); the CLI flag never sends it.
        guard case .success(let up) = Server.fitJob(["orientation": "portrait-upside-down"]) else { return XCTFail("upside-down sidecar refused") }
        XCTAssertEqual(up.orientation, "portrait-upside-down")
        guard case .success(let j) = Server.fitJob(["reasons": ["corner"], "orientation": "landscape-left", "controls": false]) else { return XCTFail() }
        XCTAssertEqual(j.reasons, ["corner"])
        XCTAssertEqual(j.controls, [])
        guard case .success(let c) = Server.fitJob(["controls": ["corner"]]) else { return XCTFail() }
        XCTAssertEqual(c.controls, ["corner"])
        guard case .failure = Server.fitJob(["controls": ["notch"]]) else { return XCTFail("an unknown zone is refused") }
        // A zero-width run or one past the screen is refused, never a crash in part() or rotate().
        for runs in [[[5, 40, 40]], [[5, 40, 101]], [[200, 0, 4]]] {
            XCTAssertNil(DeviceProfile.parse(["id": "bad", "screen": ["width": 100, "height": 200], "zones": [["kind": "cutout", "runs": runs]]]), "\(runs)")
        }
        for lh in [[85, 90, 30], [185, 90, 30, 2]] {
            XCTAssertNil(DeviceProfile.parse(["id": "bad", "screen": ["width": 100, "height": 200], "zones": [], "landscape": ["home-indicator": ["box": lh]]]), "\(lh)")
        }
        XCTAssertNotNil(DeviceProfile.parse(["id": "ok", "screen": ["width": 100, "height": 200], "zones": [], "landscape": ["home-indicator": ["box": [85, 90, 30, 2]]]]))
    }
}
