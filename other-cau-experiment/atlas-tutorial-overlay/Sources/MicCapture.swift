import Foundation
import AVFoundation

protocol MicCaptureDelegate: AnyObject {
    func audioChunk(data: Data)
    func audioEnded()
}

class MicCapture: NSObject {

    weak var delegate: MicCaptureDelegate?

    private let audioEngine = AVAudioEngine()
    private var isCapturing = false

    // VAD state
    private var isSpeaking = false
    private var silenceStartTime: Date?
    private let silenceThreshold: TimeInterval = 1.5
    private let rmsThreshold: Float = 0.01

    // Buffering
    private var audioBuffer = Data()
    private let chunkSize = 4096  // samples

    // Target format: 16kHz mono 16-bit PCM
    private var targetFormat: AVAudioFormat = {
        AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    }()

    override init() {
        super.init()
        NSLog("[AtlasOverlay] MicCapture: initialized")
    }

    func startCapture() {
        guard !isCapturing else {
            NSLog("[AtlasOverlay] MicCapture: already capturing")
            return
        }

        // Request microphone permission
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            beginCapture()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                if granted {
                    DispatchQueue.main.async { self?.beginCapture() }
                } else {
                    NSLog("[AtlasOverlay] MicCapture: microphone permission denied")
                }
            }
        case .denied, .restricted:
            NSLog("[AtlasOverlay] MicCapture: microphone permission denied or restricted")
        @unknown default:
            NSLog("[AtlasOverlay] MicCapture: unknown authorization status")
        }
    }

    private func beginCapture() {
        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            NSLog("[AtlasOverlay] MicCapture: failed to create audio converter from %@ to 16kHz", inputFormat.description)
            return
        }

        // Buffer size: approximately 256ms at input sample rate
        let bufferSize = AVAudioFrameCount(inputFormat.sampleRate * 0.256)

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, time in
            guard let self = self else { return }
            self.processBuffer(buffer, converter: converter)
        }

        do {
            try audioEngine.start()
            isCapturing = true
            isSpeaking = false
            silenceStartTime = nil
            audioBuffer = Data()
            NSLog("[AtlasOverlay] MicCapture: capture started, input format: %@", inputFormat.description)
        } catch {
            NSLog("[AtlasOverlay] MicCapture: failed to start audio engine: %@", error.localizedDescription)
            inputNode.removeTap(onBus: 0)
        }
    }

    func stopCapture() {
        guard isCapturing else { return }

        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        isCapturing = false
        isSpeaking = false
        silenceStartTime = nil
        audioBuffer = Data()
        NSLog("[AtlasOverlay] MicCapture: capture stopped")
    }

    private func processBuffer(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter) {
        // Convert to 16kHz mono 16-bit PCM
        let frameCapacity = AVAudioFrameCount(targetFormat.sampleRate * Double(buffer.frameLength) / buffer.format.sampleRate + 1)
        guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCapacity) else { return }

        var conversionError: NSError?
        var inputConsumed = false

        let status = converter.convert(to: convertedBuffer, error: &conversionError) { inNumPackets, outStatus in
            if inputConsumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            inputConsumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        if status == .error || conversionError != nil {
            NSLog("[AtlasOverlay] MicCapture: conversion error: %@", conversionError?.localizedDescription ?? "unknown")
            return
        }

        guard convertedBuffer.frameLength > 0 else { return }

        // Extract raw PCM bytes
        let frameCount = Int(convertedBuffer.frameLength)
        guard let int16ChannelData = convertedBuffer.int16ChannelData else { return }

        let pcmData = Data(bytes: int16ChannelData[0], count: frameCount * 2)

        // VAD: compute RMS
        let rms = computeRMS(int16Ptr: int16ChannelData[0], frameCount: frameCount)
        detectVoiceActivity(rms: rms)

        // Accumulate audio and send in chunks
        audioBuffer.append(pcmData)
        while audioBuffer.count >= chunkSize * 2 {
            let chunk = audioBuffer.prefix(chunkSize * 2)
            audioBuffer = audioBuffer.dropFirst(chunkSize * 2)
            DispatchQueue.main.async { [weak self] in
                self?.delegate?.audioChunk(data: Data(chunk))
            }
        }
    }

    private func computeRMS(int16Ptr: UnsafeMutablePointer<Int16>, frameCount: Int) -> Float {
        var sumSquares: Float = 0
        for i in 0..<frameCount {
            let sample = Float(int16Ptr[i]) / Float(Int16.max)
            sumSquares += sample * sample
        }
        return sqrt(sumSquares / Float(frameCount))
    }

    private func detectVoiceActivity(rms: Float) {
        let now = Date()

        if rms > rmsThreshold {
            isSpeaking = true
            silenceStartTime = nil
        } else {
            if isSpeaking {
                if silenceStartTime == nil {
                    silenceStartTime = now
                } else if let silenceStart = silenceStartTime,
                          now.timeIntervalSince(silenceStart) >= silenceThreshold {
                    isSpeaking = false
                    silenceStartTime = nil
                    NSLog("[AtlasOverlay] MicCapture: silence detected after speech, calling audioEnded")
                    DispatchQueue.main.async { [weak self] in
                        self?.delegate?.audioEnded()
                    }
                }
            }
        }
    }
}
