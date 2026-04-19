import ExpoModulesCore
import AVFoundation
import UIKit

/// Expo Module: StereoCameraView を提供する。
/// CAReplicatorLayer で 1 つの AVCaptureVideoPreviewLayer を 2 複製、横並び配置。
public class CameraMirrorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CameraMirrorModule")

    View(StereoCameraView.self) {
      Prop("gutter") { (view: StereoCameraView, value: CGFloat) in
        view.gutter = value
        view.setNeedsLayout()
      }
    }

    AsyncFunction("takePicture") { (viewTag: Int, promise: Promise) in
      DispatchQueue.main.async {
        guard let view = Self.resolveView(viewTag: viewTag) else {
          promise.reject("ERR_VIEW", "StereoCameraView(\(viewTag)) not found")
          return
        }
        view.takePicture { result in
          switch result {
          case .success(let uri): promise.resolve(uri)
          case .failure(let err): promise.reject("ERR_CAPTURE", err.localizedDescription)
          }
        }
      }
    }
  }

  /// React-Native の viewTag から StereoCameraView を取得 (旧 bridge / Fabric どちらでも拾えるよう保険)。
  private static func resolveView(viewTag: Int) -> StereoCameraView? {
    // ExpoModulesCore 経由で root から探索
    guard let root = UIApplication.shared.connectedScenes
      .compactMap({ ($0 as? UIWindowScene)?.windows.first { $0.isKeyWindow } })
      .first?.rootViewController?.view else { return nil }
    return findView(tag: viewTag, in: root)
  }

  private static func findView(tag: Int, in view: UIView) -> StereoCameraView? {
    if view.tag == tag, let stereo = view as? StereoCameraView { return stereo }
    for sub in view.subviews {
      if let hit = findView(tag: tag, in: sub) { return hit }
    }
    return nil
  }
}
