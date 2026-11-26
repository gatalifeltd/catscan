// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import Foundation

public let catscanVersion = "1.0.0"
public let serveProtocol = 23 // 2: catalog checks and inventory (spec 02); 3: untranslated (spec 17 D21); 4: video (spec 07 D3); 5: truncated (spec 06 D22); 6: thumbnail (spec 18 D6); 7: overlap (spec 12 D1); 8: truncated reason overflow (TODO-036 D1); 9: text_record (TODO-038 T1); 10: pseudo (TODO-039 T2); 11: overlap boxes and allow, boxes graphic (TODO-046); 12: overlap occlusion, boxes panel and scrolls (TODO-049); 13: wrong_language (TODO-036 T2); 14: formats (TODO-036 T3); 15: uncatalogued (TODO-036 T4); 16: overlap stacked (TODO-067); 17: glyphs (TODO-036 T5); 18: fit (TODO-073); 19: fit orientation portrait-upside-down (TODO-073 D39); 20: fit wrapped and orphan (TODO-074); 21: contrast (TODO-054); 23: overlap geometry, stacked default-on (TODO-067 D17)

/// A warning, or the error of an input (spec 00, "Warnings and errors").
public struct Diagnostic: Encodable, Equatable, Error {
    public var code: String
    public var message: String
    public var hint: String?

    public init(_ code: String, _ message: String, hint: String? = nil) {
        self.code = code
        self.message = message
        self.hint = hint
    }
}

public struct LineOut: Encodable {
    public var text: String
    public var box: [Double]
    public var confidence: Double
    public var contrast: LineContrast? = nil // TODO-054: `contrast` envelopes only (absent elsewhere)
}

public struct Closest: Encodable {
    public var line: String
    public var box: [Double]
    public var distance: Int
    public var t: Double? = nil // video: the frame time of the closest line (spec 07 D2)
}

public struct CheckResult: Encodable {
    public var kind: String // present | absent
    public var text: String
    public var verdict: String // pass | fail | skipped | unsupported
    public var box: [Double]? = nil
    public var line: String? = nil
    public var confidence: Double? = nil
    public var closest: Closest? = nil
    public var reason: String? = nil
    /// Catalog checks only (spec 02 D19): the key and the file it came from.
    public var key: String? = nil
    public var catalog: String? = nil
    /// Video checks only (spec 07 D2, D7): first and last frame time it was found, and the --expect range.
    public var video = false
    public var firstSeen: Double? = nil
    public var lastSeen: Double? = nil
    public var range: String? = nil

    enum K: String, CodingKey {
        case kind, text, verdict, box, line, confidence, closest, reason, key, catalog, first_seen, last_seen, range
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(text, forKey: .text)
        try c.encode(verdict, forKey: .verdict)
        try c.encode(box, forKey: .box) // null when nothing was located
        try c.encode(line, forKey: .line)
        try c.encode(confidence, forKey: .confidence)
        if kind == "present" && verdict == "fail" { try c.encode(closest, forKey: .closest) }
        try c.encodeIfPresent(reason, forKey: .reason)
        try c.encodeIfPresent(key, forKey: .key)
        try c.encodeIfPresent(catalog, forKey: .catalog)
        if video {
            try c.encode(firstSeen, forKey: .first_seen)
            try c.encode(lastSeen, forKey: .last_seen)
            try c.encodeIfPresent(range, forKey: .range)
        }
    }
}

/// A `@key` check (spec 02): the Node layer parses the catalog and sends the raw fragments of every
/// alternative; the core normalizes, drops short fragments and matches (spec 02 D1).
public struct CatalogCheck {
    public var kind: String // present | absent; ignored in an inventory
    public var key: String
    public var catalog: String?
    public var text: String
    public var alternatives: [[String]]
    public var reason: String? // set: the check is skipped with it (catalog-missing, catalog-string-capped)

    public init(kind: String, key: String, catalog: String? = nil, text: String, alternatives: [[String]], reason: String? = nil) {
        self.kind = kind
        self.key = key
        self.catalog = catalog
        self.text = text
        self.alternatives = alternatives
        self.reason = reason
    }
}

/// `--all-keys` (spec 02 D10, D17): which catalog strings an image shows. Lists are sorted by key.
public struct Inventory: Encodable, Equatable {
    public struct Found: Encodable, Equatable {
        public var key: String
        public var line: String
        public var box: [Double]
    }
    public struct Skipped: Encodable, Equatable {
        public var key: String
        public var reason: String
    }
    public var found: [Found] = []
    public var not_found: [String] = []
    public var skipped: [Skipped] = []
}

public struct ImageSize: Encodable {
    public var width: Int
    public var height: Int
}

/// The machine (spec 00): the same object in every output. CI identity belongs to the results file (spec 27).
public struct HostInfo: Encodable {
    public var chip: String
    public var arch: String
    public var host_class: String
    public var macos: String // "<version> (<build>)"
    public var vision_revision: Int
}

/// What a finding command reports (spec 00 "JSON result"); fields per kind follow spec 17 D25.
public struct Finding: Encodable, Equatable {
    /// truncated: the element a line was matched to (spec 06 D8).
    public struct Element: Encodable, Equatable {
        public var id: String?
        public var box: [Double]

        enum K: String, CodingKey { case id, box }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: K.self)
            try c.encode(id, forKey: .id)
            try c.encode(box, forKey: .box)
        }
    }

    /// overlap: one of the two lines (spec 12 D7), or one of the two elements (TODO-046: `text` and `confidence`
    /// null for a graphic, `element` set).
    public struct OverlapLine: Encodable, Equatable {
        public var text: String?
        public var box: [Double]
        public var confidence: Double?
        public var element: Element? = nil

        enum K: String, CodingKey { case text, box, confidence, element }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: K.self)
            try c.encode(text, forKey: .text)
            try c.encode(box, forKey: .box)
            try c.encode(confidence, forKey: .confidence)
            try c.encodeIfPresent(element, forKey: .element)
        }
    }

    public var kind: String // untranslated | raw-key | placeholder | truncated | overlap
    public var box: [Double]?
    public var line: String
    public var key: String? = nil
    public var keys: [String]? = nil // D13: several keys share the base text
    public var catalog: String? = nil
    public var base: String? = nil
    public var expected: String? = nil // untranslated: null when the target has no string
    public var token: String? = nil
    public var reason: String? = nil // truncated: ellipsis | prefix | edge | overflow | screen-edge
    public var element: Element? = nil
    public var confidence: Double? = nil
    public var a: OverlapLine? = nil
    public var b: OverlapLine? = nil
    public var overlap: Double? = nil
    public var signal: String? = nil // boxes (OCR lines, spec 12; the garbled signal was dropped, D21) | elements (TODO-046) | sheets (TODO-072) | stacked (TODO-067)
    /// TODO-067 D9, D13: which correction branch found a stacked line, and the production read of its box (null: dropped).
    public var stackedEvidence: [String]? = nil
    public var corrected: String? = nil
    public var overflow: Double? = nil // truncated overflow: line heights past the element (TODO-036)
    // TODO-039 T2 (D14): pseudo-cut side and lost part, hardcoded evidence, pseudo-not-applied trait share and lines.
    public var side: String? = nil
    public var lost: String? = nil
    public var evidence: String? = nil
    public var traits: Double? = nil
    public var lines: Int? = nil
    // TODO-036 T2 (D19): wrong-language's language, the run locale and the other locale's file that matched.
    public var language: String? = nil
    public var expectedLanguage: String? = nil
    public var evidenceCatalog: String? = nil
    // TODO-036 T3 (D20): format/currency rule, price field and product, currencies seen and the storefront's.
    public var rule: String? = nil
    public var field: String? = nil
    public var product: String? = nil
    public var currencies: [String]? = nil
    public var expectedCurrency: String? = nil
    /// TODO-036 T4: the closest catalog string to an uncatalogued line (normalized distance below 0.5).
    public struct Nearest: Encodable, Equatable {
        public var key: String
        public var text: String
        public var distance: Double
    }
    public var nearest: Nearest? = nil
    public var chars: [String]? = nil // missing-glyphs: the characters drawn as tofu (TODO-036 T5)
    // TODO-073: fit's hidden characters, their union, the zone's box, the profile, a control's covered share.
    public var hidden: String? = nil
    public var hiddenBox: [Double]? = nil
    public var zoneBox: [Double]? = nil
    public var profile: String? = nil
    public var covered: Double? = nil
    public var lineNull = false // fit: a textless control has `line: null`
    // TODO-054: low-contrast and busy-background: measured ratio, its threshold and size class, the sRGB colours, the
    // busy edge share, and the device scale with its source (D6, D10).
    public var ratio: Double? = nil
    public var threshold: Double? = nil
    public var size: String? = nil
    public var ink: String? = nil
    public var background: String? = nil
    public var edges: Double? = nil
    public var scale: Double? = nil
    public var scaleSource: String? = nil
    // TODO-074: the wrap reasons' row counts, the base screenshot and the orphan word.
    public var rows: Int? = nil
    public var baseRows: Int? = nil
    public var basePath: String? = nil
    public var orphan: String? = nil

    public init(kind: String, box: [Double]?, line: String) {
        self.kind = kind
        self.box = box
        self.line = line
    }

    enum K: String, CodingKey {
        case kind, box, line, key, keys, catalog, base, expected, token, reason, element, confidence, a, b, overlap, signal, overflow,
            side, lost, evidence, traits, lines, language, rule, field, product, currencies, nearest, corrected, chars, hidden, profile, covered,
            ratio, threshold, size, ink, background, edges, scale, rows, orphan
        case scaleSource = "scale_source"
        case hiddenBox = "hidden_box", zoneBox = "zone_box", baseRows = "base_rows", basePath = "base_path"
        case stackedEvidence = "stacked_evidence"
        case expectedLanguage = "expected_language", evidenceCatalog = "evidence_catalog", expectedCurrency = "expected_currency"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(kind, forKey: .kind)
        if kind == "pseudo-not-applied" { // TODO-039 D14: a per-image finding, no line (box null, as missing)
            try c.encode(box, forKey: .box)
            try c.encode(traits, forKey: .traits)
            try c.encode(lines, forKey: .lines)
            return
        }
        if kind == "fit", reason == "wrapped" || reason == "orphan" { // TODO-074 "Finding"
            try c.encode(box, forKey: .box)
            try c.encode(line, forKey: .line)
            try c.encode(reason, forKey: .reason)
            try c.encode(element, forKey: .element)
            try c.encode(rows, forKey: .rows)
            if reason == "wrapped" {
                try c.encode(baseRows, forKey: .baseRows)
                try c.encode(evidence, forKey: .evidence)
                try c.encode(basePath, forKey: .basePath)
                if key != nil { // D18: paired through the catalog
                    try c.encode(key, forKey: .key)
                    try c.encode(catalog, forKey: .catalog)
                }
            } else {
                try c.encode(orphan, forKey: .orphan)
                try c.encode(evidence, forKey: .evidence)
            }
            try c.encode(confidence, forKey: .confidence)
            return
        }
        if kind == "fit" { // TODO-073 "Output": every field, null when it does not apply (a control has no line)
            try c.encode(box, forKey: .box)
            try c.encode(lineNull ? nil : line, forKey: .line)
            try c.encode(reason, forKey: .reason)
            try c.encode(hidden, forKey: .hidden)
            try c.encode(hiddenBox, forKey: .hiddenBox)
            try c.encode(zoneBox, forKey: .zoneBox)
            try c.encode(element, forKey: .element)
            try c.encode(profile, forKey: .profile)
            try c.encode(covered, forKey: .covered)
            try c.encode(confidence, forKey: .confidence)
            return
        }
        if kind == "low-contrast" || kind == "busy-background" { // TODO-054 "Outputs": every field, null when unknown
            try c.encode(box, forKey: .box)
            try c.encode(line, forKey: .line)
            for (k, v) in [(K.ratio, ratio), (.threshold, threshold)] { try c.encode(v, forKey: k) }
            try c.encode(size, forKey: .size)
            try c.encode(ink, forKey: .ink)
            try c.encode(background, forKey: .background)
            try c.encode(edges, forKey: .edges)
            try c.encode(scale, forKey: .scale)
            try c.encode(scaleSource, forKey: .scaleSource)
            try c.encode(confidence, forKey: .confidence)
            return
        }
        try c.encode(box, forKey: .box)
        try c.encode(line, forKey: .line)
        if kind == "untranslated" {
            try c.encode(key, forKey: .key)
            try c.encodeIfPresent(keys, forKey: .keys)
            try c.encode(catalog, forKey: .catalog)
            try c.encode(base, forKey: .base)
            try c.encode(expected, forKey: .expected)
        } else if kind == "raw-key" { // TODO-031: the catalog key(s) a line was matched to, when known
            try c.encodeIfPresent(key, forKey: .key)
            try c.encodeIfPresent(keys, forKey: .keys)
        }
        try c.encodeIfPresent(token, forKey: .token)
        if kind == "truncated" { // D22: every field, null when unknown
            try c.encode(reason, forKey: .reason)
            try c.encode(element, forKey: .element)
            try c.encode(expected, forKey: .expected)
            try c.encode(confidence, forKey: .confidence)
            if reason == "overflow" { try c.encode(overflow, forKey: .overflow) }
            if reason == "pseudo-cut" { // TODO-039 D14
                try c.encode(side, forKey: .side)
                try c.encode(lost, forKey: .lost)
                try c.encode(key, forKey: .key)
                try c.encode(catalog, forKey: .catalog)
            }
        }
        if kind == "wrong-language" { // TODO-036 T2: key, catalog, expected and evidence_catalog only with catalog evidence
            try c.encode(language, forKey: .language)
            try c.encode(expectedLanguage, forKey: .expectedLanguage)
            try c.encode(evidence, forKey: .evidence)
            try c.encode(confidence, forKey: .confidence)
            if evidence == "catalog" {
                try c.encode(key, forKey: .key)
                try c.encodeIfPresent(keys, forKey: .keys)
                try c.encode(catalog, forKey: .catalog)
                try c.encode(expected, forKey: .expected)
                try c.encode(evidenceCatalog, forKey: .evidenceCatalog)
            }
        }
        if kind == "hardcoded" { // TODO-039 D14: key, catalog and expected with evidence "base"
            try c.encode(evidence, forKey: .evidence)
            try c.encodeIfPresent(key, forKey: .key)
            try c.encodeIfPresent(catalog, forKey: .catalog)
            try c.encodeIfPresent(expected, forKey: .expected)
        }
        if kind == "uncatalogued" { // TODO-036 T4: the recognizer's project language and the closest string, null when none
            try c.encode(language, forKey: .language)
            try c.encode(nearest, forKey: .nearest)
        }
        if kind == "missing-glyphs" { // TODO-036 T5: element and key null when the expected text had none
            try c.encode(expected, forKey: .expected)
            try c.encode(chars, forKey: .chars)
            try c.encode(element, forKey: .element)
            try c.encode(key, forKey: .key)
        }
        if kind == "format" { // TODO-036 T3: the rule and the locale's CLDR rendering of the value
            try c.encode(rule, forKey: .rule)
            try c.encode(expected, forKey: .expected)
        }
        if kind == "currency" { // D20: expected_currency null only for mixed without a storefront
            try c.encode(rule, forKey: .rule)
            try c.encode(currencies, forKey: .currencies)
            try c.encode(expectedCurrency, forKey: .expectedCurrency)
        }
        if kind == "price" { // D8: disagrees with the supplied price file
            try c.encode(field, forKey: .field)
            try c.encodeIfPresent(product, forKey: .product)
            try c.encode(expected, forKey: .expected)
        }
        if kind == "overlap" || kind == "occluded" { // D7; TODO-049 D1: the same shape
            try c.encode(a, forKey: .a)
            try c.encode(b, forKey: .b)
            try c.encode(overlap, forKey: .overlap)
            try c.encode(signal, forKey: .signal)
            if signal == "stacked" { // TODO-067 D9: b and overlap are null, the two reads say what was found
                try c.encode(stackedEvidence, forKey: .stackedEvidence)
                try c.encode(corrected, forKey: .corrected)
            }
        }
    }
}

/// The per-input result (spec 00, "JSON result").
public struct Envelope: Encodable {
    public var command: String
    public var path: String?
    public var verdict: String // pass | fail | unsupported | error
    public var engine: String
    public var locale: String
    public var image: ImageSize?
    public var screen: String? = nil // from --refs (spec 19) or --layout (spec 27); null until those land
    /// TODO-075 D21: the device label and its platform; the CLI sets them from --device or a `{device}/` layout.
    public var device: String? = nil
    public var platform: String? = nil
    /// TODO-076: the text-size label; the CLI sets it from --text-size or a `{text_size}/` layout.
    public var textSize: String? = nil
    public var host: HostInfo
    public var ms: Int = 0
    public var checks: [CheckResult] = []
    public var findings: [Finding] = []
    public var warnings: [Diagnostic] = []
    public var lines: [LineOut]? = nil // read only
    public var inventory: Inventory? = nil // check --all-keys only
    public var error: Diagnostic? = nil
    /// `video` only (spec 07 D12, D15): the take, the number of recognized frames and, with frames: true, each frame.
    public var video: VideoInfo? = nil
    public var frames: Int? = nil
    public var samples: [FrameSample]? = nil
    /// TODO-038 T1: set when the request asked for a text record; null when nothing was read (error, video).
    public var textAsked = false
    public var text: TextRecord? = nil
    /// TODO-039 T2: the run checked a pseudo-localized build (`--pseudo`); encoded only when true.
    public var pseudo = false
    /// TODO-036 T3: `formats` with a price file: amounts exempt from the price rule as "was" prices.
    public var priceExempt: Int? = nil
    /// TODO-073 (D22, D25): `fit` only: the matched profile (null: none) and which reasons ran or were skipped.
    public var deviceProfile: DeviceProfileOut? = nil
    public var reasonsRun: [String] = []
    public var reasonsSkipped: [SkippedReason] = []
    /// TODO-074 D9: per-element rows, only when the request asked (`fit.wrap.element_rows`); internal, the CLI drops it.
    public var elementRows: [ElementRows]? = nil
    /// Set only in `serve`, where every response carries the request id.
    public var id: String?? = nil

    enum K: String, CodingKey {
        case schema, catscan, command, path, verdict, engine, locale, image, screen, device, platform, textSize = "text_size", host, ms, checks, findings, warnings,
            lines, inventory, error, video, frames, samples, text, pseudo, id
        case priceExempt = "price_exempt"
        case deviceProfile = "device_profile", reasonsRun = "reasons_run", reasonsSkipped = "reasons_skipped", elementRows = "element_rows"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(1, forKey: .schema)
        try c.encode(catscanVersion, forKey: .catscan)
        try c.encode(command, forKey: .command)
        try c.encode(path, forKey: .path)
        try c.encode(verdict, forKey: .verdict)
        try c.encode(engine, forKey: .engine)
        try c.encode(locale, forKey: .locale)
        try c.encode(image, forKey: .image)
        try c.encode(screen, forKey: .screen)
        try c.encode(device, forKey: .device)
        try c.encode(platform, forKey: .platform)
        try c.encode(textSize, forKey: .textSize)
        if command == "fit" {
            try c.encode(deviceProfile, forKey: .deviceProfile)
            try c.encode(reasonsRun, forKey: .reasonsRun)
            try c.encode(reasonsSkipped, forKey: .reasonsSkipped)
            try c.encodeIfPresent(elementRows, forKey: .elementRows)
        }
        try c.encode(host, forKey: .host)
        try c.encode(ms, forKey: .ms)
        try c.encode(checks, forKey: .checks)
        try c.encode(findings, forKey: .findings)
        try c.encode(warnings, forKey: .warnings)
        try c.encodeIfPresent(lines, forKey: .lines)
        try c.encodeIfPresent(inventory, forKey: .inventory)
        try c.encodeIfPresent(error, forKey: .error)
        if command == "video" {
            try c.encode(video, forKey: .video)
            try c.encode(frames ?? 0, forKey: .frames)
            try c.encodeIfPresent(samples, forKey: .samples)
        }
        if textAsked { try c.encode(text, forKey: .text) }
        if pseudo { try c.encode(true, forKey: .pseudo) }
        if command == "formats", error == nil { try c.encode(priceExempt, forKey: .priceExempt) }
        if let id { try c.encode(id, forKey: .id) }
    }
}

/// A `serve` response that is not an envelope: malformed or oversized request lines.
public struct ErrorResponse: Encodable {
    public var id: String?
    public var error: Diagnostic

    enum K: String, CodingKey { case id, error }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        try c.encode(error, forKey: .error)
    }
}

public struct ReadyLine: Encodable {
    public var id: String? = nil
    public var type = "ready"
    public var catscan = catscanVersion
    public var `protocol` = serveProtocol
    /// TODO-032: the client derives its watchdog from this and builds a `core-timeout` envelope from engine and host.
    public var visionTimeout: Double
    public var engine: String
    public var host: HostInfo

    public init(visionTimeout: Double, engine: String, host: HostInfo) {
        self.visionTimeout = visionTimeout
        self.engine = engine
        self.host = host
    }

    enum K: String, CodingKey { case id, type, catscan, `protocol`, vision_timeout_s, engine, host }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        try c.encode(type, forKey: .type)
        try c.encode(catscan, forKey: .catscan)
        try c.encode(`protocol`, forKey: .protocol)
        try c.encode(visionTimeout, forKey: .vision_timeout_s)
        try c.encode(engine, forKey: .engine)
        try c.encode(host, forKey: .host)
    }
}

public enum JSONLine {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    public static func encode<T: Encodable>(_ v: T) -> Data {
        var d = (try? encoder.encode(v)) ?? Data("{\"id\":null,\"error\":{\"code\":\"internal\",\"message\":\"encode failed\"}}".utf8)
        d.append(0x0A)
        return d
    }
}
