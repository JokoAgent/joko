import ExpoModulesCore
import UIKit

public final class JokoMobileResourcePressureModule: Module {
  private var observer: NSObjectProtocol?
  private var sequence = 0

  public func definition() -> ModuleDefinition {
    Name("JokoMobileResourcePressure")
    Events("onResourcePressure")

    OnCreate {
      self.observer = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.emitPressure()
      }
    }

    OnDestroy {
      if let observer = self.observer {
        NotificationCenter.default.removeObserver(observer)
      }
      self.observer = nil
    }
  }

  private func emitPressure() {
    sequence = sequence == Int.max ? 1 : sequence + 1
    sendEvent("onResourcePressure", [
      "sequence": sequence,
      "severity": "critical",
      "platform": "ios"
    ])
  }
}
