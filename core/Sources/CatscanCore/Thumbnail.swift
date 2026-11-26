// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The `thumbnail` serve request (spec 18 D6): a JPEG of an image, or of a video frame at an exact time, scaled to
/// `max_edge` on the long edge, upright. The report embeds it, so Node needs no image library (spec 25).
public struct ThumbnailJob {
    public var path: String
    public var maxEdge: Int
    public var quality: Double
    public var t: Double?
}

public struct ThumbnailResponse: Encodable {
    public var id: String?
    public var width: Int
    public var height: Int
    public var jpeg: String

    enum K: String, CodingKey { case id, width, height, jpeg }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(jpeg, forKey: .jpeg)
    }
}

public enum Thumbnail {
    public static func parse(_ obj: [String: Any]) -> Result<ThumbnailJob, Diagnostic> {
        func bad(_ m: String) -> Result<ThumbnailJob, Diagnostic> { .failure(Diagnostic("invalid-request", m)) }
        guard obj["image"] == nil, let p = obj["path"] as? String, !p.isEmpty else {
            return bad("A thumbnail request needs path; image is not accepted.")
        }
        guard let e = obj["max_edge"] as? NSNumber, !(obj["max_edge"] is Bool), e.doubleValue == e.doubleValue.rounded(),
            e.intValue >= 1, e.intValue <= 8192
        else { return bad("max_edge must be an integer from 1 to 8192.") }
        guard let q = obj["quality"] as? NSNumber, !(obj["quality"] is Bool), q.doubleValue > 0, q.doubleValue <= 1 else {
            return bad("quality must be a number above 0, up to 1.")
        }
        var t: Double? = nil
        if let v = obj["t"], !(v is NSNull) {
            guard let n = v as? NSNumber, !(v is Bool), n.doubleValue.isFinite, n.doubleValue >= 0 else {
                return bad("t must be a number of seconds, 0 or more.")
            }
            t = n.doubleValue
        }
        return .success(ThumbnailJob(path: p, maxEdge: e.intValue, quality: q.doubleValue, t: t))
    }

    public static func make(_ job: ThumbnailJob) -> Result<(Int, Int, Data), Diagnostic> {
        let img: CGImage
        switch job.t == nil ? image(job) : frame(job) {
        case .success(let i): img = i
        case .failure(let d): return .failure(d)
        }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            return .failure(Diagnostic("internal", "Cannot create a JPEG encoder."))
        }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: job.quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return .failure(Diagnostic("internal", "JPEG encoding failed.")) }
        return .success((img.width, img.height, data as Data))
    }

    static func regularFile(_ path: String) -> Diagnostic? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else {
            return Diagnostic("input-not-found", "No such file: \(path)")
        }
        var st = stat()
        if isDir.boolValue || (stat(path, &st) == 0 && st.st_mode & S_IFMT != S_IFREG) {
            return Diagnostic("input-unreadable", "Not a regular file: \(path)")
        }
        return nil
    }

    /// ImageIO with the EXIF orientation applied, like recognition (Engine.decode); never scaled up.
    static func image(_ job: ThumbnailJob) -> Result<CGImage, Diagnostic> {
        if let d = regularFile(job.path) { return .failure(d) }
        let unreadable = Diagnostic("input-unreadable", "Not a readable image: \(job.path)")
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: job.path) as CFURL, nil), CGImageSourceGetCount(src) > 0,
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
            let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int
        else { return .failure(unreadable) }
        if w * h > Engine.maxPixels {
            return .failure(Diagnostic("image-too-large", "The image is \(w)x\(h), over the limit of 100 megapixels."))
        }
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(job.maxEdge, max(w, h)),
        ] as CFDictionary) else { return .failure(unreadable) }
        return .success(img)
    }

    /// A frame at the exact time, as `video` reads it (zero tolerance, track transform applied).
    static func frame(_ job: ThumbnailJob) -> Result<CGImage, Diagnostic> {
        let opened: Video.Opened
        switch Video.open(job.path) {
        case .success(let o): opened = o
        case .failure(let d): return .failure(d)
        }
        let gen = AVAssetImageGenerator(asset: opened.asset)
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        let edge = Double(min(job.maxEdge, max(opened.info.width, opened.info.height)))
        gen.maximumSize = CGSize(width: edge, height: edge)
        let t = min(max(job.t!, opened.start), opened.end)
        do {
            let img = try Video.blocking {
                try await gen.image(at: CMTime(seconds: t, preferredTimescale: 600_000)).image
            }
            return .success(img)
        } catch let d as Diagnostic {
            return .failure(d)
        } catch {
            return .failure(Diagnostic("input-unreadable", "Cannot read the frame at \(t) s of \(job.path)."))
        }
    }
}
