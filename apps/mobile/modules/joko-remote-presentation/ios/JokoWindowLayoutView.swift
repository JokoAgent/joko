import ExpoModulesCore
import UIKit

/// Transparent observation source sharing the React container's bounds and window.
final class JokoWindowLayoutView: ExpoView {
  let onGeometryChange = EventDispatcher()
  private let geometry = JokoWindowGeometry()
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    geometry.onChange = { [weak self] value in
      guard let payload = value as? [String: Any] else { return }
      self?.onGeometryChange(payload)
    }
    addSubview(geometry)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    geometry.frame = bounds
  }
}
