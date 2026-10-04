import ExpoModulesCore
import UIKit

public final class JokoScreenshotMonitorModule: Module {
  private var screenshotObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("JokoScreenshotMonitor")
    Events("onScreenshot")

    OnStartObserving("onScreenshot") { self.startObservingScreenshots() }
    OnStopObserving("onScreenshot") { self.stopObservingScreenshots() }
    OnDestroy { self.stopObservingScreenshots() }
  }

  private func startObservingScreenshots() {
    guard screenshotObserver == nil else { return }
    screenshotObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.userDidTakeScreenshotNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      guard UIApplication.shared.applicationState == .active else { return }
      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      guard let root = scenes.filter({ $0.activationState == .foregroundActive })
        .flatMap({ $0.windows }).first(where: { $0.isKeyWindow })?.rootViewController,
        !self.hasPresentedOverlay(root) else { return }
      self.sendEvent("onScreenshot", ["capturedAt": Date().timeIntervalSince1970 * 1_000])
    }
  }

  private func stopObservingScreenshots() {
    guard let screenshotObserver else { return }
    NotificationCenter.default.removeObserver(screenshotObserver)
    self.screenshotObserver = nil
  }

  private func hasPresentedOverlay(_ controller: UIViewController) -> Bool {
    return controller.presentedViewController != nil || controller.children.contains { hasPresentedOverlay($0) }
  }
}
