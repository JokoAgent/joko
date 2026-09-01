export const TIMELINE_UNPIN_SCROLLABLE_TOLERANCE_PX = 1;
export const TIMELINE_TOUCH_UP_INTENT_THRESHOLD_PX = 8;
export const TIMELINE_HISTORY_NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "PageUp",
  "ArrowUp",
  "Home"
]);

export function shouldUnpinTimelineOnWheel({
  deltaX,
  deltaY,
  scrollHeight,
  clientHeight
}: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  if (deltaY >= 0) return false;
  if (Math.abs(deltaY) < Math.abs(deltaX)) return false;
  return scrollHeight - clientHeight > TIMELINE_UNPIN_SCROLLABLE_TOLERANCE_PX;
}

export function shouldUnpinTimelineOnUpIntent({
  scrollHeight,
  clientHeight
}: {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  return scrollHeight - clientHeight > TIMELINE_UNPIN_SCROLLABLE_TOLERANCE_PX;
}

export function hasNestedTimelineScrollerThatCanMoveUp(
  root: HTMLElement,
  target: EventTarget | null
): boolean {
  const view = root.ownerDocument.defaultView;
  if (view === null) return false;
  let element: HTMLElement | null;
  if (target instanceof view.HTMLElement) element = target;
  else if (target instanceof view.Node) element = target.parentElement;
  else element = null;

  while (element !== null && element !== root) {
    if (!root.contains(element)) return false;
    const overflowY = view.getComputedStyle(element).overflowY;
    const canScroll = (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
      && element.scrollHeight - element.clientHeight > TIMELINE_UNPIN_SCROLLABLE_TOLERANCE_PX
      && element.scrollTop > TIMELINE_UNPIN_SCROLLABLE_TOLERANCE_PX;
    if (canScroll) return true;
    element = element.parentElement;
  }
  return false;
}

export function isEditableTimelineKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT"
    || target.isContentEditable === true;
}
