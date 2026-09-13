export interface ComposerPointerPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export interface ComposerFocusSnapshot {
  readonly isDestroyed: boolean;
  readonly isEditable: boolean;
  readonly isFocused: boolean;
  readonly caretAtDocStart: boolean;
}

export type ComposerBlankFocusIntent = "none" | "keep-caret" | "doc-end";

export function isComposerBlankPointerTarget(
  target: EventTarget | null,
  container: Element,
  editorDom: Element | null,
  point: ComposerPointerPoint
): boolean {
  if (!(target instanceof Element) || !container.contains(target)) return false;
  const bounds = container.getBoundingClientRect();
  if (
    point.clientX < bounds.left
    || point.clientX > bounds.right
    || point.clientY < bounds.top
    || point.clientY > bounds.bottom
  ) return false;
  if (editorDom !== null && (target === editorDom || editorDom.contains(target))) return false;
  for (let node: Element | null = target; node !== null && node !== container; node = node.parentElement) {
    if (isFocusableComposerDescendant(node)) return false;
    if (node instanceof HTMLElement && node.draggable) return false;
  }
  return true;
}

export function resolveComposerBlankFocusIntent(
  snapshot: ComposerFocusSnapshot | null
): ComposerBlankFocusIntent {
  if (snapshot === null || snapshot.isDestroyed || !snapshot.isEditable || snapshot.isFocused) return "none";
  return snapshot.caretAtDocStart ? "doc-end" : "keep-caret";
}

function isFocusableComposerDescendant(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tagName = element.tagName.toLowerCase();
  if (["button", "input", "select", "textarea", "summary"].includes(tagName)) return true;
  if (tagName === "a" && element.hasAttribute("href")) return true;
  if (element.tabIndex >= 0) return true;
  return [
    "button",
    "textbox",
    "searchbox",
    "combobox",
    "menuitem",
    "tab",
    "checkbox",
    "radio",
    "switch",
    "option"
  ].includes(element.getAttribute("role") ?? "");
}
