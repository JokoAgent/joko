import ExpoModulesCore
import UIKit

public final class JokoMessageSelectionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JokoMessageSelection")
    View(JokoSelectableMessageText.self) {
      Events("onQuoteSelection")
      Prop("registration") { (view: JokoSelectableMessageText, value: String) in view.registration = value }
      Prop("quoteLabel") { (view: JokoSelectableMessageText, value: String) in view.quoteLabel = value }
      Prop("body") { (view: JokoSelectableMessageText, value: String) in view.body = value }
      Prop("ink") { (view: JokoSelectableMessageText, value: UIColor) in view.ink = value }
      Prop("fontSize") { (view: JokoSelectableMessageText, value: Double) in view.fontSize = CGFloat(value) }
      Prop("lineHeight") { (view: JokoSelectableMessageText, value: Double) in view.lineHeight = CGFloat(value) }
    }
  }
}

final class JokoSelectableMessageText: ExpoView, UITextViewDelegate {
  let onQuoteSelection = EventDispatcher()
  var registration = ""
  var quoteLabel = ""
  var body = "" { didSet { if body != oldValue { updateBody() } } }
  var ink = UIColor.label { didSet { if ink != oldValue { updateBody() } } }
  var fontSize: CGFloat = 15 { didSet { if fontSize != oldValue { updateBody() } } }
  var lineHeight: CGFloat = 22 { didSet { if lineHeight != oldValue { updateBody() } } }

  private let textView = UITextView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.delegate = self
    addSubview(textView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
  }

  private func updateBody() {
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    textView.attributedText = NSAttributedString(string: body, attributes: [
      .font: UIFont.systemFont(ofSize: fontSize), .foregroundColor: ink, .paragraphStyle: paragraph
    ])
  }

  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    guard range.length > 0, !quoteLabel.isEmpty, !registration.isEmpty else { return nil }
    let original = registration
    let action = UIAction(title: quoteLabel) { [weak self] _ in self?.quoteSelection(registration: original) }
    return UIMenu(children: [action] + suggestedActions)
  }

  private func quoteSelection(registration original: String) {
    guard registration == original, window != nil else { return }
    let range = textView.selectedRange
    let text = (textView.text ?? "") as NSString
    guard range.location != NSNotFound, range.location <= text.length, range.length > 0,
      range.length <= text.length - range.location else { return }
    onQuoteSelection(["registration": original, "start": range.location, "end": NSMaxRange(range),
      "text": text.substring(with: range)])
    DispatchQueue.main.async { [weak self] in
      guard let self, self.registration == original, self.textView.selectedRange == range else { return }
      self.textView.selectedTextRange = nil
    }
  }
}
