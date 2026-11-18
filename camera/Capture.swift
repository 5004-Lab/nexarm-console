import AVFoundation
import CoreImage
import CoreMedia
import Foundation

func externalCameras() -> [AVCaptureDevice] {
    let kind: AVCaptureDevice.DeviceType
    if #available(macOS 14.0, *) {
        kind = .external
    } else {
        kind = .externalUnknown
    }
    return AVCaptureDevice.DiscoverySession(deviceTypes: [kind], mediaType: .video, position: .unspecified).devices
}

let devices = externalCameras()
if CommandLine.arguments.contains("--list-json") {
    let details = devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
    let body = try JSONSerialization.data(withJSONObject: details)
    try FileHandle.standardOutput.write(contentsOf: body)
    exit(0)
}
if CommandLine.arguments.contains("--list") {
    for device in devices {
        print("\(device.localizedName)\t\(device.uniqueID)")
    }
    exit(0)
}
let configured = CommandLine.arguments.dropFirst().first
let camera = devices.first { device in
    if let name = configured {
        return device.uniqueID == name || device.localizedName.localizedCaseInsensitiveContains(name)
    }
    return ["icspring", "nexarm"].contains { device.localizedName.localizedCaseInsensitiveContains($0) }
}
guard let camera else { exit(20) }

switch AVCaptureDevice.authorizationStatus(for: .video) {
case .authorized: break
case .notDetermined:
    let gate = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .video) { granted in
        if !granted { exit(21) }
        gate.signal()
    }
    gate.wait()
default: exit(21)
}

final class Capture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let host = CMClockGetHostTimeClock()
    let context = CIContext()
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let pipe = FileHandle.standardOutput
    var nextFrame = 0.0

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = CMClockGetTime(host).seconds
        guard now >= nextFrame, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        nextFrame = now + 1.0 / 16.0
        let pts: CMTime
        if #available(macOS 12.0, *), let clock = session.synchronizationClock {
            pts = clock.convertTime(sample.presentationTimeStamp, to: host)
        } else {
            pts = sample.presentationTimeStamp
        }
        let capture = pts.seconds.isFinite && abs(pts.seconds - now) < 1 ? pts.seconds : now
        let image = CIImage(cvPixelBuffer: pixels)
        let scale = min(1.0, 640.0 / image.extent.width)
        let source = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let quality = CIImageRepresentationOption(rawValue: "kCGImageDestinationLossyCompressionQuality")
        guard let jpeg = context.jpegRepresentation(of: source, colorSpace: colorSpace, options: [quality: 0.73]) else { return }
        var stamp = capture.bitPattern.bigEndian
        var size = UInt32(jpeg.count).bigEndian
        var frame = Data(bytes: &stamp, count: 8)
        frame.append(Data(bytes: &size, count: 4))
        frame.append(jpeg)
        do { try pipe.write(contentsOf: frame) } catch { exit(0) }
    }

    func open(_ camera: AVCaptureDevice) throws -> Bool {
        let input = try AVCaptureDeviceInput(device: camera)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: DispatchQueue(label: "nexarm.camera.frames"))
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
        guard session.canAddInput(input), session.canAddOutput(output) else { return false }
        session.addInput(input)
        session.addOutput(output)
        return true
    }
}
let capture = Capture()
guard (try? capture.open(camera)) == true else { exit(22) }
let disconnect = NotificationCenter.default.addObserver(
    forName: AVCaptureDevice.wasDisconnectedNotification, object: camera, queue: nil
) { _ in exit(20) }
let runtimeError = NotificationCenter.default.addObserver(
    forName: AVCaptureSession.runtimeErrorNotification, object: capture.session, queue: nil
) { _ in exit(22) }
capture.session.startRunning()
RunLoop.main.run()
