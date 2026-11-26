import ActivityKit
import CryptoKit
import ExpoModulesCore
import Foundation
import UIKit
import WidgetKit

public final class JokoHomeSurfacesModule: Module {
  private let bridge = DispatchTime.now().uptimeNanoseconds

  public func definition() -> ModuleDefinition {
    Name("JokoHomeSurfaces")
    Events("onWidgetRefresh")
    OnStartObserving("onWidgetRefresh") {
      DispatchQueue.main.async {
        JokoHomeWidgetRefresh.shared.observe(bridge: self.bridge) { [weak self] id, expired in
          self?.sendEvent("onWidgetRefresh", ["id": id, "expired": expired])
        }
      }
    }
    OnStopObserving("onWidgetRefresh") {
      DispatchQueue.main.async { JokoHomeWidgetRefresh.shared.stopObserving(bridge: self.bridge) }
    }
    AsyncFunction("apply") { (sequence: Int, owner: String?, usage: String?, task: String?, mayStart: Bool) async throws in
      try await JokoHomeSurfaces.shared.apply(bridge: self.bridge, sequence: sequence, owner: owner, usage: usage, task: task, mayStart: mayStart)
    }
    AsyncFunction("pendingWidgetRefresh") { () async -> String? in
      await MainActor.run { JokoHomeWidgetRefresh.shared.pendingId }
    }
    AsyncFunction("completeWidgetRefresh") { (id: String, sequence: Int, owner: String?, usage: String?) async throws in
      try await JokoHomeSurfaces.shared.completeRefresh(id: id, bridge: self.bridge, sequence: sequence, owner: owner, usage: usage)
    }
  }
}

@MainActor
private final class JokoHomeSurfaces {
  static let shared = JokoHomeSurfaces()
  private var latestBridge: UInt64 = 0
  private var latest = 0
  private let dismissalSetting = "joko.homeSurfaces.dismissedActivity"
  private var activityObservation: Task<Void, Never>?
  private var observedActivityId: String?

  func apply(bridge: UInt64, sequence: Int, owner: String?, usage: String?, task: String?, mayStart: Bool) async throws {
    guard accept(bridge: bridge, sequence: sequence) else { return }
    let owner = owner.flatMap { JokoHomeSurfaceProjection.validOwner($0) ? $0 : nil }
    let widget = Result { try synchronizeWidget(owner: owner, usage: usage) }
    await synchronizeActivity(bridge: bridge, sequence: sequence, owner: owner, task: task, mayStart: mayStart)
    try widget.get()
  }

  func completeRefresh(id: String, bridge: UInt64, sequence: Int, owner: String?, usage: String?) throws {
    let refresh = JokoHomeWidgetRefresh.shared
    guard refresh.pendingId == id, accept(bridge: bridge, sequence: sequence) else { return }
    guard let owner, let usage, JokoHomeSurfaceProjection.validOwner(owner) else {
      refresh.finish(id: id, success: false)
      return
    }
    do {
      try synchronizeWidget(owner: owner, usage: usage)
      refresh.finish(id: id, success: true)
    } catch {
      refresh.finish(id: id, success: false)
      throw error
    }
  }

  private func accept(bridge: UInt64, sequence: Int) -> Bool {
    guard bridge > latestBridge || (bridge == latestBridge && sequence > latest) else { return false }
    latestBridge = bridge
    latest = sequence
    return true
  }

  private func synchronizeWidget(owner: String?, usage: String?) throws {
    guard let file = JokoHomeSurfaceProjection.file else { return }
    let current = JokoHomeSurfaceProjection.read()
    let sameOwner = owner != nil && current?.owner == owner
    var changed = false
    if !sameOwner || usage == "", FileManager.default.fileExists(atPath: file.path) {
      try FileManager.default.removeItem(at: file)
      changed = true
    }
    if let owner, let usage, let bytes = usage.data(using: .utf8),
       let next = JokoHomeSurfaceProjection.decode(bytes), next.owner == owner,
       next.expiration > Date(), next.expiration.timeIntervalSinceNow <= 20 * 60, next != current {
      try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      changed = true
    }
    if changed {
      WidgetCenter.shared.reloadTimelines(ofKind: JokoHomeSurfaceProjection.quotaKind)
      WidgetCenter.shared.reloadTimelines(ofKind: JokoHomeSurfaceProjection.usageKind)
    }
  }

  private func synchronizeActivity(bridge: UInt64, sequence: Int, owner: String?, task: String?, mayStart: Bool) async {
    if #available(iOS 17.0, *) {
      let state = task.flatMap { value -> JokoTaskActivityAttributes.ContentState? in
        guard value.utf8.count <= 4096,
              let next = try? JSONDecoder().decode(JokoTaskActivityAttributes.ContentState.self, from: Data(value.utf8)),
              next.valid, next.expiration > Date(), next.expiration.timeIntervalSinceNow <= 5 * 60 else { return nil }
        return next
      }
      let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
      let expected = owner.flatMap { owner in state.map { dismissalKey(owner: owner, task: $0.link) } }
      var dismissed = UserDefaults.standard.string(forKey: dismissalSetting)
      if dismissed != nil && (owner == nil || (mayStart && expected != dismissed)) {
        UserDefaults.standard.removeObject(forKey: dismissalSetting)
        dismissed = nil
      }
      var existing: Activity<JokoTaskActivityAttributes>?
      for activity in Activity<JokoTaskActivityAttributes>.activities {
        guard bridge == latestBridge && sequence == latest else { return }
        if enabled, let owner, let state, activity.attributes.owner == owner,
           activity.attributes.task == state.link, existing == nil, dismissed != expected {
          existing = activity
        } else if enabled && task == nil && !mayStart && owner != nil
                    && activity.attributes.owner == owner && activity.content.staleDate.map({ $0 > Date() }) == true {
          observe(activity)
          continue
        } else {
          stopObserving(activity.id)
          await activity.end(nil, dismissalPolicy: .immediate)
        }
      }
      guard bridge == latestBridge && sequence == latest, enabled, let owner, let state, expected != dismissed else { return }
      let content = ActivityContent(state: state, staleDate: state.expiration)
      if let existing {
        observe(existing)
        if existing.content.state != state { await existing.update(content) }
      } else if mayStart && UIApplication.shared.applicationState == .active {
        if let created = try? Activity.request(attributes: JokoTaskActivityAttributes(owner: owner, task: state.link), content: content) {
          observe(created)
        }
      }
    }
  }

  @available(iOS 17.0, *)
  private func observe(_ activity: Activity<JokoTaskActivityAttributes>) {
    guard observedActivityId != activity.id else { return }
    activityObservation?.cancel()
    observedActivityId = activity.id
    activityObservation = Task { @MainActor [weak self] in
      for await state in activity.activityStateUpdates {
        guard let self, !Task.isCancelled, self.observedActivityId == activity.id else { return }
        if state == .dismissed {
          let key = self.dismissalKey(owner: activity.attributes.owner, task: activity.attributes.task)
          UserDefaults.standard.set(key, forKey: self.dismissalSetting)
          self.stopObserving(activity.id)
          return
        }
        if state == .ended {
          self.stopObserving(activity.id)
          return
        }
      }
    }
  }

  private func stopObserving(_ id: String) {
    guard observedActivityId == id else { return }
    activityObservation?.cancel()
    activityObservation = nil
    observedActivityId = nil
  }

  private func dismissalKey(owner: String, task: String) -> String {
    SHA256.hash(data: Data("\(owner)\n\(task)".utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
