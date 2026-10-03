import { downloadArtifactBlob } from "../artifact-download.js";
import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";
import type { TimelineItemView } from "../model.js";
import { visibleSelectionQuoteMessageText } from "../selection-quote.js";
import type { RenderedShareImageMessage } from "./share-rendered-message-image.js";
import {
  ShareMessageImageEncodingError,
  type ShareMessageImageDelivery,
  assertPngBlob,
  deliverShareMessageImage,
  shareMessageImageFilename
} from "./share-message-image.js";

export function shareSelectionImageMessages(
  selectedMessages: readonly TimelineItemView[]
): readonly RenderedShareImageMessage[] {
  return selectedMessages.flatMap((item) => {
    if (item.kind !== "user" && item.kind !== "assistant") return [];
    return [{
      id: item.id,
      text: item.kind === "user"
        ? visibleSelectionQuoteMessageText(item.text ?? "", item.quotesEncoded === true)
        : item.text ?? "",
      attachmentNames: item.attachments?.map((attachment) => attachment.fileName || attachment.title) ?? []
    }];
  });
}

export async function copyShareSelectionImagePng(blob: Blob, action: BrowserActionContext): Promise<void> {
  await assertPngBlob(blob, action);
  assertBrowserActionCurrent(action);
  const ownerWindow = action.ownerDocument.defaultView!;
  if (typeof ownerWindow.ClipboardItem === "undefined" || typeof ownerWindow.navigator.clipboard?.write !== "function") {
    throw new ShareMessageImageEncodingError();
  }
  const item = new ownerWindow.ClipboardItem({ "image/png": blob });
  assertBrowserActionCurrent(action);
  // The issued clipboard operation has its own outcome even if the view then closes.
  await ownerWindow.navigator.clipboard.write([item]);
}

export async function downloadShareSelectionImagePng(
  blob: Blob,
  sessionName: string,
  createdAt: number,
  action: BrowserActionContext
): Promise<"dispatched"> {
  await assertPngBlob(blob, action);
  assertBrowserActionCurrent(action);
  downloadArtifactBlob(blob, shareMessageImageFilename(sessionName, createdAt), action);
  return "dispatched";
}

export function deliverShareSelectionImagePng(
  blob: Blob,
  sessionName: string,
  createdAt: number,
  action: BrowserActionContext
): Promise<ShareMessageImageDelivery> {
  return deliverShareMessageImage(blob, shareMessageImageFilename(sessionName, createdAt), sessionName, action);
}
