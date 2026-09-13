import { assertBrowserActionCurrent, type BrowserActionContext } from "./browser-action.js";

export async function writeClipboardText(text: string, context: BrowserActionContext): Promise<void> {
  assertBrowserActionCurrent(context);
  const clipboard = context.ownerDocument.defaultView?.navigator.clipboard;
  if (clipboard?.writeText === undefined) throw new Error("Clipboard unavailable.");
  await clipboard.writeText(text);
}
