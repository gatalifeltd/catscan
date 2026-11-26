// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import CoreGraphics
import CoreText
import XCTest
@testable import CatscanCore

/// TODO-054 T1: the estimator on generated bitmaps (no Vision: the line box is the drawn text's box).
final class ContrastTests: XCTestCase {
    struct C { var r, g, b: Double; var cg: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: 1) } }
    static func grey(_ v: Int) -> C { C(r: Double(v) / 255, g: Double(v) / 255, b: Double(v) / 255) }
    static func L(_ c: C) -> Double { Contrast.luminance(UInt8((c.r * 255).rounded()), UInt8((c.g * 255).rounded()), UInt8((c.b * 255).rounded())) }
    static func truth(_ a: C, _ b: C) -> Double { Contrast.ratio(L(a), L(b)) }

    /// One line of text on a canvas; `paint` draws the background. Returns the image and the line box (normalized, top left).
    func draw(_ text: String, ink: C, font: String = "HelveticaNeue", px: Double = 40, space: CGColorSpace? = nil,
              paint: ((CGContext, Int, Int) -> Void)? = nil, bg: C = C(r: 1, g: 1, b: 1), runs: [(String, C)]? = nil,
              stroke: C? = nil) -> (CGImage, CGRect) {
        let f = CTFontCreateWithName(font as CFString, px, nil)
        let s = NSMutableAttributedString()
        for (t, c) in runs ?? [(text, ink)] {
            var a: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): f, .init(kCTForegroundColorAttributeName as String): c.cg]
            if let stroke {
                a[.init(kCTStrokeColorAttributeName as String)] = stroke.cg
                a[.init(kCTStrokeWidthAttributeName as String)] = -6
            }
            s.append(NSAttributedString(string: t, attributes: a))
        }
        let line = CTLineCreateWithAttributedString(s)
        var asc: CGFloat = 0, desc: CGFloat = 0
        let tw = CTLineGetTypographicBounds(line, &asc, &desc, nil)
        let W = Int(tw + px * 4), H = Int(px * 4)
        let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: space ?? CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        if let paint { paint(ctx, W, H) } else {
            ctx.setFillColor(bg.cg)
            ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        }
        let x = 2 * px, base = 1.6 * px
        ctx.textPosition = CGPoint(x: x, y: base)
        CTLineDraw(line, ctx)
        let top = Double(H) - (base + Double(asc)) // the box Vision would give: ascent to descent
        let rect = CGRect(x: x / Double(W), y: top / Double(H), width: tw / Double(W), height: Double(asc + desc) / Double(H))
        return (ctx.makeImage()!, rect)
    }

    func measure(_ d: (CGImage, CGRect)) -> Contrast.Measure? {
        let (img, r) = d
        let W = Double(img.width), H = Double(img.height)
        return Contrast.measure(img, box: CGRect(x: r.minX * W, y: r.minY * H, width: r.width * W, height: r.height * H), others: [])
    }

    func evaluate(_ d: (CGImage, CGRect), text: String = "Forgot password?", confidence: Double = 1, job: ContrastJob = ContrastJob()) -> Contrast.Result {
        Contrast.evaluate(job, lines: [RecognizedLine(text: text, rect: d.1, confidence: confidence)], image: d.0, locale: "en")
    }

    func testGreyAndColourPairsWithinOnePercentLightAndDark() throws {
        // Value: protects=D1 ink core and D5 polarity-free split; fails_when=ink falls back to the class mean (11% low), the classes swap on dark mode, or luminance is not WCAG's; why_new=new; seam=none; no_claim=Vision box placement (bench/contrast.js)
        let pairs: [(C, C)] = [(Self.grey(0x76), Self.grey(0xFF)), (Self.grey(0x99), Self.grey(0xFF)), (Self.grey(0xEE), C(r: 0.11, g: 0.11, b: 0.118)),
                               (Self.grey(0x8E), C(r: 0.11, g: 0.11, b: 0.118)), (C(r: 1, g: 1, b: 1), C(r: 0.2, g: 0.6, b: 0.3)), (C(r: 0.8, g: 0.1, b: 0.1), C(r: 1, g: 0.95, b: 0.8))]
        for (ink, bg) in pairs {
            let m = try XCTUnwrap(measure(draw("Forgot password?", ink: ink, font: "HelveticaNeue-Bold", px: 40, bg: bg)))
            let t = Self.truth(ink, bg)
            XCTAssertEqual(m.ratio, t, accuracy: t * 0.01, "\(ink) on \(bg)")
            XCTAssertFalse(m.uncertain)
            XCTAssertFalse(m.busy)
        }
    }

    func testThinAntiAliasedStrokeWithinThreePercent() throws {
        // Value: protects=D1 p90 ink core on 1-2 px strokes (spec "Ink and background" step 4); fails_when=the ink is a class mean or median; why_new=new; seam=none; no_claim=thinner than 22 px Thin
        let ink = Self.grey(0x80), bg = Self.grey(0xFF)
        let m = try XCTUnwrap(measure(draw("Notifications", ink: ink, font: "HelveticaNeue-Thin", px: 22, bg: bg)))
        XCTAssertEqual(m.ratio, Self.truth(ink, bg), accuracy: Self.truth(ink, bg) * 0.03)
    }

    func testGradientTakesTheWorstSegment() throws {
        // Value: protects=D3 segment minimum; fails_when=the whole-box split is used alone (overstates contrast on a gradient); why_new=new; seam=none; no_claim=vertical gradients
        let ink = Self.grey(0x55), from = Self.grey(0xFF), to = Self.grey(0x90)
        let d = draw("Continue to checkout now", ink: ink, px: 30, paint: { ctx, w, _ in
            let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [from.cg, to.cg] as CFArray, locations: [0, 1])!
            ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: w, y: 0), options: [])
        })
        let m = try XCTUnwrap(measure(d))
        XCTAssertLessThan(m.ratio, Self.truth(ink, from) * 0.8) // nearer the far end than the white start
        XCTAssertGreaterThan(m.ratio, Self.truth(ink, to) * 0.95)
    }

    func testTwoInkColoursInOneSegmentAreUncertainNeverAFinding() throws {
        // Value: protects=D17 bimodal ink is uncertain; fails_when=the bimodal test or the uncertain gate in evaluate is dropped; why_new=new; seam=none; no_claim=two colours of equal luminance (ratio is the same)
        var runs: [(String, C)] = []
        for (i, ch) in "WWWWWWWWWWWW".enumerated() { runs.append((String(ch), i % 2 == 0 ? Self.grey(0x20) : Self.grey(0xC8))) }
        let d = draw("", ink: Self.grey(0), px: 40, runs: runs)
        let m = try XCTUnwrap(measure(d))
        XCTAssertTrue(m.uncertain)
        let r = evaluate(d, text: "WWWWWWWWWWWW")
        XCTAssertTrue(r.findings.isEmpty)
        XCTAssertEqual(r.lines.first?.contrast?.uncertain, true)
    }

    func testRunsOfTwoColoursFarApartAreJudgedPerSegment() throws {
        // Value: protects=D17 a mixed line whose runs fall in different segments is judged on its worse run (probe: gold label and grey text); fails_when=a mixed line is wholly uncertain or the better run hides the worse; why_new=new; seam=none; no_claim=runs closer than two line heights
        let d = draw("", ink: Self.grey(0), px: 30, runs: [("SCHILD DES TAGES ", Self.grey(0x10)), ("Rekord heute", Self.grey(0xB0))])
        let m = try XCTUnwrap(measure(d))
        XCTAssertEqual(m.ratio, Self.truth(Self.grey(0xB0), Self.grey(0xFF)), accuracy: 0.15)
    }

    func testBusyInsideAndRingAndTheirCounterexamples() throws {
        // Value: protects=D4, D19 busy is edge density inside the box away from ink and in the ring, other lines cut out; fails_when=variance replaces edges (gradient flags), ink edges count, or neighbour lines are not cut out; why_new=new; seam=none; no_claim=real photos (bench/contrast-real.js)
        func stripes(_ ctx: CGContext, _ r: CGRect) {
            for (k, i) in stride(from: r.minX, to: r.maxX, by: 6).enumerated() {
                ctx.setFillColor(Self.grey(k % 2 == 0 ? 0xB0 : 0xFF).cg)
                ctx.fill(CGRect(x: i, y: r.minY, width: 6, height: r.height))
            }
        }
        // Texture only under the text (photo under the line): busy.
        let under = draw("Play now", ink: Self.grey(0), px: 40, paint: { ctx, w, h in
            ctx.setFillColor(Self.grey(0xFF).cg); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            stripes(ctx, CGRect(x: 70, y: 50, width: Double(w) - 140, height: 60))
        })
        XCTAssertTrue(try XCTUnwrap(measure(under)).busy)
        // A smooth gradient: not busy.
        let grad = draw("Play now", ink: Self.grey(0), px: 40, paint: { ctx, w, _ in
            let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [Self.grey(0xFF).cg, Self.grey(0xA0).cg] as CFArray, locations: [0, 1])!
            ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: w, y: 0), options: [])
        })
        XCTAssertFalse(try XCTUnwrap(measure(grad)).busy)
        // An icon beside the text on a solid button: not busy.
        let icon = draw("Play now", ink: Self.grey(0xFF), px: 40, paint: { ctx, w, h in
            ctx.setFillColor(C(r: 0.1, g: 0.5, b: 0.2).cg); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.setFillColor(Self.grey(0xFF).cg); ctx.fillEllipse(in: CGRect(x: 30, y: 60, width: 36, height: 36))
        })
        XCTAssertFalse(try XCTUnwrap(measure(icon)).busy)
        // Another line in the ring is cut out: a text block above is not texture.
        let (img, r) = draw("Play now", ink: Self.grey(0), px: 40)
        let W = Double(img.width), H = Double(img.height)
        let box = CGRect(x: r.minX * W, y: r.minY * H, width: r.width * W, height: r.height * H)
        let neighbour = box.offsetBy(dx: 0, dy: -box.height * 0.6)
        XCTAssertFalse(try XCTUnwrap(Contrast.measure(img, box: box, others: [neighbour])).busy)
    }

    func testDisplayP3IsConvertedToSRGB() throws {
        // Value: protects=spec "Ink and background" step 1 (iOS screenshots are Display P3); fails_when=pixels are read without colour conversion; why_new=new; seam=none; no_claim=other ICC profiles
        let p3 = CGColorSpace(name: CGColorSpace.displayP3)!
        let bgP3 = CGColor(colorSpace: p3, components: [0.85, 0.05, 0.05, 1])!
        let d = draw("Forgot password?", ink: C(r: 1, g: 1, b: 1), font: "HelveticaNeue-Bold", px: 40, space: p3, paint: { ctx, w, h in
            ctx.setFillColor(bgP3); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        })
        let s = try XCTUnwrap(bgP3.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components)
        let expected = Self.truth(C(r: 1, g: 1, b: 1), C(r: Double(max(0, min(1, s[0]))), g: Double(max(0, min(1, s[1]))), b: Double(max(0, min(1, s[2])))))
        let naive = Self.truth(C(r: 1, g: 1, b: 1), C(r: 0.85, g: 0.05, b: 0.05))
        XCTAssertGreaterThan(abs(expected - naive) / naive, 0.05) // the test can tell the two apart
        XCTAssertEqual(try XCTUnwrap(measure(d)).ratio, expected, accuracy: expected * 0.02)
    }

    func testSizeBoundAtScalesAndUnknown() {
        // Value: protects=D6 precision-first size: normal only below the bold limit at the largest plausible size, uncertain judged at 3:1; fails_when=the median replaces the bound or unknown scale is assumed large; why_new=new; seam=none; no_claim=the 0.81/0.95 constants themselves (probe)
        XCTAssertEqual(Contrast.sizeClass(heightPx: 0.95 * 15 * 3, scale: 3), "normal") // 15 pt at 3x
        XCTAssertEqual(Contrast.sizeClass(heightPx: 0.95 * 25 * 2, scale: 2), "large") // 25 pt at 2x (24 sits on the bound)
        XCTAssertEqual(Contrast.sizeClass(heightPx: 0.95 * 20 * 2, scale: 2), "uncertain") // could be 14 pt bold
        // A 24-unit line at 2x read with an unknown scale (1) is never judged at 4.5:1.
        XCTAssertNotEqual(Contrast.sizeClass(heightPx: 0.95 * 24 * 2, scale: 1), "normal")
        XCTAssertEqual(Contrast.sizeClass(heightPx: 10, scale: 1), "normal")
    }

    func testLevelsMarginAndTheFindingFields() throws {
        // Value: protects=D2 margin at threshold/1.02, D10 AAA thresholds, D6 relaxed lines warned (D29), finding fields; fails_when=the margin moves, AAA uses AA numbers, or the size-uncertain warning drops; why_new=new; seam=none; no_claim=text rendering of the warning (core-js)
        XCTAssertEqual(Contrast.thresholds(level: "AA").normal, 4.5)
        XCTAssertEqual(Contrast.thresholds(level: "AAA").normal, 7)
        XCTAssertEqual(Contrast.thresholds(level: "AAA").large, 4.5)
        // #777 on white is 4.48:1, inside the margin: not a finding at AA; #999 (2.85:1) is.
        var job = ContrastJob()
        job.scale = 3
        let ok = evaluate(draw("Forgot password?", ink: Self.grey(0x77), font: "HelveticaNeue-Bold", px: 36), job: job)
        XCTAssertTrue(ok.findings.isEmpty, "\(ok.lines)")
        let bad = evaluate(draw("Forgot password?", ink: Self.grey(0x99), font: "HelveticaNeue-Bold", px: 36), job: job)
        let f = try XCTUnwrap(bad.findings.first)
        XCTAssertEqual(f.kind, "low-contrast")
        XCTAssertEqual(f.threshold, 4.5)
        XCTAssertEqual(f.size, "normal")
        XCTAssertEqual(f.background, "#FFFFFF")
        XCTAssertEqual(f.scaleSource, "none")
        XCTAssertEqual(try XCTUnwrap(f.ratio), 2.85, accuracy: 0.05)
        job.level = "AAA"
        XCTAssertEqual(evaluate(draw("Forgot password?", ink: Self.grey(0x77), font: "HelveticaNeue-Bold", px: 36), job: job).findings.first?.threshold, 7)
        // A line of uncertain size that fails 4.5:1 and passes 3:1 is not a finding but is warned.
        var j2 = ContrastJob()
        j2.scale = 2
        let rel = evaluate(draw("Forgot password?", ink: Self.grey(0x88), px: 30), job: j2)
        XCTAssertTrue(rel.findings.isEmpty)
        XCTAssertEqual(rel.warnings.map(\.code), ["contrast-size-uncertain"])
        XCTAssertEqual(rel.lines.first?.contrast?.size, "uncertain")
    }

    func testSkipsNotTextTooSmallAllowDisabledAndCovered() {
        // Value: protects=spec not-text filter, D7 disabled and allow, D15 covered text, D25 skipped reasons; fails_when=a rule stops skipping or skips without a reason; why_new=new; seam=none; no_claim=real-screen value of each rule (bench/contrast-real.js)
        let d = draw("Forgot password?", ink: Self.grey(0xC0), px: 40)
        XCTAssertNotEqual(evaluate(d, confidence: 0.3).lines.first?.contrast?.skipped, "not-text") // D33: confidence alone never skips
        XCTAssertEqual(evaluate(d, text: "••").lines.first?.contrast?.skipped, "not-text")
        var allow = ContrastJob()
        allow.allow = ["forgot password?"]
        XCTAssertEqual(evaluate(d, job: allow).lines.first?.contrast?.skipped, "allow")
        let r = d.1
        let el = TruncationJob.Element(id: "b", rect: r.insetBy(dx: -0.01, dy: -0.01), text: "Forgot password?", enabled: false)
        var dis = ContrastJob()
        dis.boxes = TruncationJob.Boxes(width: 1, height: 1, elements: [el])
        XCTAssertEqual(evaluate(d, job: dis).lines.first?.contrast?.skipped, "disabled")
        let text = TruncationJob.Element(id: "t", rect: r.insetBy(dx: -0.01, dy: -0.01), text: "Forgot password?")
        let sheet = TruncationJob.Element(id: "sheet", rect: CGRect(x: 0, y: 0, width: 1, height: 1), panel: true)
        var cov = ContrastJob()
        cov.boxes = TruncationJob.Boxes(width: 1, height: 1, elements: [text, sheet])
        let c = evaluate(d, job: cov)
        XCTAssertEqual(c.lines.first?.contrast?.skipped, "covered")
        XCTAssertEqual(c.warnings.map(\.code), ["contrast-behind-scrim"])
        // The same panel listed before the text is its background, not a cover.
        cov.boxes = TruncationJob.Boxes(width: 1, height: 1, elements: [sheet, text])
        XCTAssertNil(evaluate(d, job: cov).lines.first?.contrast?.skipped)
        // A line under 4 px is too small.
        let tiny = RecognizedLine(text: "Forgot password?", rect: CGRect(x: r.minX, y: r.minY, width: r.width, height: 3 / Double(d.0.height)), confidence: 1)
        XCTAssertEqual(Contrast.evaluate(ContrastJob(), lines: [tiny], image: d.0, locale: "en").lines.first?.contrast?.skipped, "too-small")
    }
}
