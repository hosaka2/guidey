import ExpoModulesCore
import AVFoundation
import UIKit

/// 片目 UIView: layer を AVSampleBufferDisplayLayer に差し替え、
/// 自前で CMSampleBuffer を enqueue して動画を描画する。
/// AVCaptureVideoPreviewLayer を 2 枚ぶら下げる方式より確実。
private class EyeView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

/// ステレオカメラ: 1 つの AVCaptureSession + AVCaptureVideoDataOutput からの
/// CMSampleBuffer を、2 枚の AVSampleBufferDisplayLayer に両方 enqueue して
/// 両目に同じ映像を出す。CAReplicatorLayer も AVCaptureVideoPreviewLayer の
/// 複製も使わない最も堅牢な iOS パターン。
public class StereoCameraView: ExpoView {
  public var gutter: CGFloat = 8 {
    didSet { setNeedsLayout() }
  }

  private let session = AVCaptureSession()
  private let leftEye = EyeView()
  private let rightEye = EyeView()
  private let photoOutput = AVCapturePhotoOutput()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let sessionQueue = DispatchQueue(label: "camera-mirror.session")
  private let videoQueue = DispatchQueue(label: "camera-mirror.video", qos: .userInteractive)
  private var frameDelegate: FrameDelegate?
  private var photoDelegates: [PhotoDelegate] = []
  private var configured = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black

    for eye in [leftEye, rightEye] {
      eye.backgroundColor = .black
      eye.displayLayer.videoGravity = .resizeAspectFill
      addSubview(eye)
    }
    NSLog("[camera-mirror] init (eyes=%d)", subviews.count)

    requestAuthorizationIfNeeded { [weak self] granted in
      NSLog("[camera-mirror] authorization=%@", granted ? "YES" : "NO")
      guard granted else { return }
      self?.configureSession()
    }
  }

  deinit {
    sessionQueue.async { [session] in
      if session.isRunning { session.stopRunning() }
    }
  }

  // MARK: - Layout

  public override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    let h = bounds.height
    guard w > 0, h > 0 else { return }

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let halfW = (w - gutter) / 2
    leftEye.frame = CGRect(x: 0, y: 0, width: halfW, height: h)
    rightEye.frame = CGRect(x: halfW + gutter, y: 0, width: halfW, height: h)
    CATransaction.commit()

    NSLog("[camera-mirror] layout w=%.0f h=%.0f halfW=%.0f running=%@",
          w, h, halfW, session.isRunning ? "YES" : "NO")
  }

  // MARK: - Permission

  private func requestAuthorizationIfNeeded(completion: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      completion(true)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { ok in
        DispatchQueue.main.async { completion(ok) }
      }
    default:
      completion(false)
    }
  }

  // MARK: - Session

  private func configureSession() {
    sessionQueue.async { [weak self] in
      guard let self = self, !self.configured else { return }

      self.session.beginConfiguration()
      self.session.sessionPreset = .hd1280x720

      guard
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
        let input = try? AVCaptureDeviceInput(device: device),
        self.session.canAddInput(input)
      else {
        self.session.commitConfiguration()
        NSLog("[camera-mirror] failed to add input")
        return
      }
      self.session.addInput(input)

      // 静止画 (takePicture) 用
      if self.session.canAddOutput(self.photoOutput) {
        self.session.addOutput(self.photoOutput)
      }

      // 動画 (両目 display layer 用)
      let delegate = FrameDelegate(
        leftLayer: self.leftEye.displayLayer,
        rightLayer: self.rightEye.displayLayer
      )
      self.frameDelegate = delegate
      self.videoOutput.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
      ]
      self.videoOutput.alwaysDiscardsLateVideoFrames = true
      self.videoOutput.setSampleBufferDelegate(delegate, queue: self.videoQueue)
      if self.session.canAddOutput(self.videoOutput) {
        self.session.addOutput(self.videoOutput)
      }

      // フレーム側の orientation を landscapeRight 固定 (BottomBar 付きの VR 横持ち想定)
      if let connection = self.videoOutput.connection(with: .video),
         connection.isVideoOrientationSupported {
        connection.videoOrientation = .landscapeRight
      }

      self.session.commitConfiguration()
      self.session.startRunning()
      self.configured = true
      NSLog("[camera-mirror] session running=%@", self.session.isRunning ? "YES" : "NO")
      DispatchQueue.main.async { self.setNeedsLayout() }
    }
  }

  // MARK: - Capture

  public enum CaptureResult {
    case success(String)
    case failure(Error)
  }

  public func takePicture(completion: @escaping (CaptureResult) -> Void) {
    sessionQueue.async { [weak self] in
      guard let self = self, self.configured else {
        DispatchQueue.main.async {
          completion(.failure(NSError(domain: "camera-mirror", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "session not ready"])))
        }
        return
      }
      let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      var delegate: PhotoDelegate!
      delegate = PhotoDelegate { [weak self] result in
        DispatchQueue.main.async {
          completion(result)
          self?.photoDelegates.removeAll { $0 === delegate }
        }
      }
      self.photoDelegates.append(delegate)
      self.photoOutput.capturePhoto(with: settings, delegate: delegate)
    }
  }
}

// MARK: - FrameDelegate

/// video data output から受け取った CMSampleBuffer を両目に enqueue する。
private class FrameDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private weak var leftLayer: AVSampleBufferDisplayLayer?
  private weak var rightLayer: AVSampleBufferDisplayLayer?
  private var logged = false

  init(leftLayer: AVSampleBufferDisplayLayer, rightLayer: AVSampleBufferDisplayLayer) {
    self.leftLayer = leftLayer
    self.rightLayer = rightLayer
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    if !logged {
      NSLog("[camera-mirror] first frame arrived")
      logged = true
    }
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if let l = self.leftLayer, l.isReadyForMoreMediaData {
        l.enqueue(sampleBuffer)
      }
      if let r = self.rightLayer, r.isReadyForMoreMediaData {
        r.enqueue(sampleBuffer)
      }
    }
  }
}

// MARK: - PhotoDelegate

private class PhotoDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private let completion: (StereoCameraView.CaptureResult) -> Void
  init(completion: @escaping (StereoCameraView.CaptureResult) -> Void) {
    self.completion = completion
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    if let error = error {
      completion(.failure(error)); return
    }
    guard let data = photo.fileDataRepresentation() else {
      completion(.failure(NSError(domain: "camera-mirror", code: -2,
        userInfo: [NSLocalizedDescriptionKey: "no photo data"])))
      return
    }
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let url = dir.appendingPathComponent("stereo-\(UUID().uuidString).jpg")
    do {
      try data.write(to: url)
      completion(.success(url.absoluteString))
    } catch {
      completion(.failure(error))
    }
  }
}
