import BackgroundTasks
import ExpoModulesCore
import UIKit
import WidgetKit

@MainActor
final class JokoHomeWidgetRefresh {
  static let shared = JokoHomeWidgetRefresh()

  private let identifier = Bundle.main.object(forInfoDictionaryKey: "JokoHomeSurfaceRefresh") as? String
  private var current: (id: String, task: BGAppRefreshTask)?
  private var registered = false
  var onChange: ((String, Bool) -> Void)?

  var pendingId: String? { current?.id }

  func register() {
    guard let identifier, !registered else { return }
    registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
      Task { @MainActor in
        guard let refresh = task as? BGAppRefreshTask else {
          task.setTaskCompleted(success: false)
          return
        }
        self.receive(refresh)
      }
    }
  }

  func schedule() {
    guard let identifier, registered else { return }
    WidgetCenter.shared.getCurrentConfigurations { result in
      guard case .success(let widgets) = result else { return }
      Task { @MainActor in
        guard widgets.contains(where: { $0.kind == JokoHomeSurfaceProjection.quotaKind || $0.kind == JokoHomeSurfaceProjection.usageKind }) else {
          BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
          return
        }
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
      }
    }
  }

  func finish(id: String, success: Bool) {
    guard let active = current, active.id == id else { return }
    current = nil
    active.task.expirationHandler = nil
    active.task.setTaskCompleted(success: success)
    schedule()
  }

  private func receive(_ task: BGAppRefreshTask) {
    if let current { expire(id: current.id) }
    guard UIApplication.shared.isProtectedDataAvailable else {
      task.setTaskCompleted(success: false)
      schedule()
      return
    }
    let id = UUID().uuidString
    current = (id, task)
    task.expirationHandler = { [weak self] in
      Task { @MainActor in self?.expire(id: id) }
    }
    onChange?(id, false)
  }

  private func expire(id: String) {
    guard current?.id == id else { return }
    onChange?(id, true)
    finish(id: id, success: false)
  }
}

public final class JokoHomeWidgetRefreshDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    MainActor.assumeIsolated { JokoHomeWidgetRefresh.shared.register() }
    return true
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    MainActor.assumeIsolated { JokoHomeWidgetRefresh.shared.schedule() }
  }
}
