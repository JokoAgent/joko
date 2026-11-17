import { assertBrowserActionCurrent, type BrowserActionContext } from "./browser-action.js";

export async function writeClipboardText(text: string, context: BrowserActionContext): Promise<void> {
  assertBrowserActionCurrent(context);
  const clipboard = context.ownerDocument.defaultView?.navigator.clipboard;
  if (clipboard?.writeText === undefined) throw new Error("Clipboard unavailable.");
  await clipboard.writeText(text);
}

/** Synchronous copy for a user action on the explicitly enabled HTTP Web surface. */
export function copyTextOnInsecureHttp(text: string, trigger: HTMLElement): boolean {
  const owner = trigger.ownerDocument;
  const ownerWindow = owner.defaultView;
  if (ownerWindow?.isSecureContext !== false || owner.location.protocol !== "http:" || !trigger.isConnected
    || ownerWindow.navigator.userActivation?.isActive === false || typeof owner.execCommand !== "function") return false;
  const focused = owner.activeElement as HTMLElement | null;
  const selection = owner.getSelection();
  const ranges = selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
  const backward = selection !== null && ranges.length === 1 && selection.anchorNode === ranges[0]!.endContainer
    && selection.anchorOffset === ranges[0]!.endOffset;
  const input = owner.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.style.cssText = "position:fixed;inset:0 auto auto 0;opacity:0;pointer-events:none;width:1px;height:1px";
  owner.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    return owner.execCommand("copy");
  } finally {
    input.remove();
    if (focused?.isConnected) focused.focus?.({ preventScroll: true });
    if (selection !== null && ranges.length > 0) {
      selection.removeAllRanges();
      if (backward) {
        const range = ranges[0]!;
        selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
      } else {
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
}
