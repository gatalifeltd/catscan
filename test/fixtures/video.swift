// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Fixture videos with known text at known times, written with AVAssetWriter and drawn with Core Text (spec 07 D12).
// Usage: swiftc -O test/fixtures/video.swift -o .build/video && .build/video <videos.json> <outdir>
// Prints one line per video; a codec this host cannot encode prints "skip <name>: <reason>" and writes nothing.
// Needs macOS 26 and the Xcode 26 SDK (AVAssetWriter receiver API); the product itself still runs on macOS 15 (TODO-023 D4).
import AVFoundation
import CoreGraphics
import CoreText
import Foundation

struct Label: Decodable { let text: String; let from: Double; let to: Double; let x: Double; let y: Double; let size: Double }
struct Video: Decodable {
    let name: String
    let codec: String // h264 | hevc
    let width: Int // upright size
    let height: Int
    let fps: Int
    let duration: Double
    let rotate: Int? // 90: stored landscape with a 90 degree preferredTransform, like a phone recording
    let audio: Double? // seconds of silent LPCM audio (MOV only); longer than duration, like a screen recording
    let labels: [Label]
}

setbuf(stdout, nil)
let a = CommandLine.arguments
let videos = try JSONDecoder().decode([Video].self, from: Data(contentsOf: URL(fileURLWithPath: a[1])))
let out = URL(fileURLWithPath: a[2])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

/// The upright frame at time t: white, with every label whose [from, to) contains t.
func frame(_ v: Video, at t: Double) -> CGImage {
    let ctx = CGContext(
        data: nil, width: v.width, height: v.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: v.width, height: v.height))
    for l in v.labels where l.from <= t && t < l.to {
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, l.size, nil)
        let attr = NSAttributedString(string: l.text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1),
        ])
        ctx.textPosition = CGPoint(x: l.x, y: Double(v.height) - l.y - l.size)
        CTLineDraw(CTLineCreateWithAttributedString(attr), ctx)
    }
    return ctx.makeImage()!
}

func write(_ v: Video) throws -> String? {
    let url = out.appendingPathComponent(v.name)
    try? FileManager.default.removeItem(at: url)
    let rotated = v.rotate == 90
    let (sw, sh) = rotated ? (v.height, v.width) : (v.width, v.height)
    let type: AVFileType = url.pathExtension.lowercased() == "mov" ? .mov : .mp4
    let writer = try AVAssetWriter(outputURL: url, fileType: type)
    let settings: [String: Any] = [
        AVVideoCodecKey: v.codec == "hevc" ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
        AVVideoWidthKey: sw, AVVideoHeightKey: sh,
    ]
    guard writer.canApply(outputSettings: settings, forMediaType: .video) else {
        return "this host cannot encode \(v.codec)"
    }
    // Receivers, not add/adaptor/isReadyForMoreMediaData: those are deprecated in the macOS 27 SDK (TODO-023).
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    // Display = stored rotated 90 degrees clockwise, as an iPhone portrait recording.
    if rotated { input.transform = CGAffineTransform(rotationAngle: .pi / 2) }
    let video = writer.inputPixelBufferReceiver(for: input, pixelBufferAttributes: CVPixelBufferCreationAttributes(
        pixelFormatType: CVPixelFormatType(rawValue: kCVPixelFormatType_32ARGB), size: CVImageSize(width: sw, height: sh)))
    var audio: AVAssetWriterInput.SampleBufferReceiver? = nil
    if v.audio != nil {
        let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        audio = writer.inputReceiver(for: a)
    }
    // Silence, `n` samples at 16 kHz from sample `start`.
    var asbd = AudioStreamBasicDescription(
        mSampleRate: 16000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked, mBytesPerPacket: 2,
        mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
    var audioFormat: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                   magicCookie: nil, extensions: nil, formatDescriptionOut: &audioFormat)
    var audioDone = 0
    let audioTotal = Int((v.audio ?? 0) * 16000)
    // Samples in the next audio buffer: sizes the buffer and advances the clock once it is accepted (TODO-023 D2).
    func audioChunk() -> Int { min(1600, audioTotal - audioDone) }
    func audioBuffer() -> CMReadySampleBuffer<CMSampleBuffer.DynamicContent> {
        let n = audioChunk()
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: n * 2, blockAllocator: nil,
                                           customBlockSource: nil, offsetToData: 0, dataLength: n * 2, flags: 0, blockBufferOut: &block)
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: n * 2)
        var sb: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block!, formatDescription: audioFormat!, sampleCount: n,
            presentationTimeStamp: CMTime(value: CMTimeValue(audioDone), timescale: 16000), packetDescriptions: nil,
            sampleBufferOut: &sb)
        return CMReadySampleBuffer(unsafeBuffer: sb!)
    }
    func videoBuffer(_ i: Int) throws -> CVReadOnlyPixelBuffer {
        var pb = try video.pixelBufferPool!.makeMutablePixelBuffer()
        pb.accessUnsafeMutableRawPlaneBytes { planes in
            let ctx = CGContext(
                data: planes[0].bytes.baseAddress, width: sw, height: sh, bitsPerComponent: 8,
                bytesPerRow: planes[0].properties.bytesPerRow, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
            if rotated {
                // Stored = upright turned 90 degrees counterclockwise, so the clockwise transform shows it upright.
                ctx.translateBy(x: 0, y: CGFloat(sh))
                ctx.rotate(by: -.pi / 2)
            }
            ctx.draw(frame(v, at: Double(i) / Double(v.fps)), in: CGRect(x: 0, y: 0, width: v.width, height: v.height))
        }
        return CVReadOnlyPixelBuffer(pb)
    }
    do { try writer.start() } catch { return "writer failed: \(error.localizedDescription)" }
    writer.startSession(atSourceTime: .zero)
    let count = Int((v.duration * Double(v.fps)).rounded())
    // Feed whichever input is ready, earliest time first, and never wait on one input alone: the writer
    // interleaves and can hold one input until the other catches up. appendImmediately returns false when
    // its input is not ready, so a refused buffer is kept and offered again.
    var i = 0
    var videoOpen = true, audioOpen = audio != nil
    var pendingVideo: CVReadOnlyPixelBuffer? = nil
    var pendingAudio: CMReadySampleBuffer<CMSampleBuffer.DynamicContent>? = nil
    func tryVideo() throws -> Bool {
        if pendingVideo == nil { pendingVideo = try videoBuffer(i) }
        guard try video.appendImmediately(pendingVideo!, with: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(v.fps)))
        else { return false }
        pendingVideo = nil
        i += 1
        if i == count { video.finish(); videoOpen = false }
        return true
    }
    func tryAudio() throws -> Bool {
        if pendingAudio == nil { pendingAudio = audioBuffer() }
        guard try audio!.appendImmediately(pendingAudio!) else { return false }
        pendingAudio = nil
        audioDone += audioChunk()
        if audioDone >= audioTotal { audio!.finish(); audioOpen = false }
        return true
    }
    // A failed append ends this video only, reported as "writer failed" like before the receivers (TODO-023 D5).
    var appendError: Error? = nil
    do {
        while videoOpen || audioOpen {
            if writer.status == .failed { break }
            let videoFirst = videoOpen && (!audioOpen || Double(i) / Double(v.fps) <= Double(audioDone) / 16000)
            let progressed = videoFirst
                ? (try tryVideo() || (audioOpen && (try tryAudio())))
                : (try tryAudio() || (videoOpen && (try tryVideo())))
            if !progressed { usleep(1000) }
        }
    } catch { appendError = error }
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if let e = appendError { return "writer failed: \(e.localizedDescription)" }
    return writer.status == .completed ? nil : "writer failed: \(writer.error?.localizedDescription ?? "unknown")"
}

for v in videos {
    if let why = try write(v) { print("skip \(v.name): \(why)") } else { print("wrote \(v.name)") }
}
