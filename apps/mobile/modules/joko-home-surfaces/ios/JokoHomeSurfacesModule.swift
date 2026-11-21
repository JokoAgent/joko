import ActivityKit
import ExpoModulesCore
import Foundation
import UIKit
import WidgetKit

public final class JokoHomeSurfacesModule: Module {
  private let surfaces = JokoHomeSurfaces()

  public func definition() -> ModuleDefinition {
    Name("JokoHomeSurfaces")
    AsyncFunction("apply") { (sequence: Int, owner: String?, usage: String?, task: String?, mayStart: Bool) async throws in
      try await self.surfaces.apply(sequence: sequence, owner: owner, usage: usage, task: task, mayStart: mayStart)
    }
  }
}

private actor JokoHomeSurfaces {
  private var latest = 0

  func apply(sequence: Int, owner: String?, usage: String?, task: String?, mayStart: Bool) async throws {
    guard sequence > latest else { return }
    latest = sequence
    let owner = owner.flatMap { JokoHomeSurfaceProjection.validOwner($0) ? $0 : nil }
    let widget = Result { try synchronizeWidget(owner: owner, usage: usage) }
    await synchronizeActivity(sequence: sequence, owner: owner, task: task, mayStart: mayStart)
    try widget.get()
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

  private func synchronizeActivity(sequence: Int, owner: String?, task: String?, mayStart: Bool) async {
    if #available(iOS 17.0, *) {
      let state = task.flatMap { value -> JokoTaskActivityAttributes.ContentState? in
        guard value.utf8.count <= 4096,
              let next = try? JSONDecoder().decode(JokoTaskActivityAttributes.ContentState.self, from: Data(value.utf8)),
              next.valid, next.expiration > Date(), next.expiration.timeIntervalSinceNow <= 5 * 60 else { return nil }
        return next
      }
      let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
      var existing: Activity<JokoTaskActivityAttributes>?
      for activity in Activity<JokoTaskActivityAttributes>.activities {
        guard sequence == latest else { return }
        if enabled, let owner, let state, activity.attributes.owner == owner,
           activity.attributes.task == state.link, existing == nil {
          existing = activity
        } else if enabled && task == nil && !mayStart && owner != nil
                    && activity.attributes.owner == owner && activity.content.staleDate.map({ $0 > Date() }) == true {
          continue
        } else {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
      }
      guard sequence == latest, enabled, let owner, let state else { return }
      let content = ActivityContent(state: state, staleDate: state.expiration)
      if let existing {
        if existing.content.state != state { await existing.update(content) }
      } else if mayStart {
        await MainActor.run {
          guard UIApplication.shared.applicationState == .active else { return }
          _ = try? Activity.request(attributes: JokoTaskActivityAttributes(owner: owner, task: state.link), content: content)
        }
      }
    }
  }
}
