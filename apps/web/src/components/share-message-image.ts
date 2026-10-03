import { downloadArtifactBlob } from "../artifact-download.js";
import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";
import { redactShareMessageText } from "./share-redaction.js";

export const MAXIMUM_SHARE_MESSAGE_CHARACTERS = 12_000;
export const MAXIMUM_SHARE_IMAGE_PIXELS = 16_777_216;

const SHARE_IMAGE_MAX_TITLE_CHARACTERS = 120;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export type ShareMessageImageDelivery = "shared" | "dispatched" | "cancelled";

export class ShareMessageImageEmptyError extends Error {
  constructor() {
    super("The selected message has no shareable content.");
    this.name = "ShareMessageImageEmptyError";
  }
}

export class ShareMessageImageTooLargeError extends Error {
  constructor() {
    super("The selected message is too large to export as a readable image.");
    this.name = "ShareMessageImageTooLargeError";
  }
}

export class ShareMessageImageEncodingError extends Error {
  constructor() {
    super("The browser could not encode the message as PNG.");
    this.name = "ShareMessageImageEncodingError";
  }
}

export async function assertPngBlob(blob: Blob, action: BrowserActionContext): Promise<void> {
  assertBrowserActionCurrent(action);
  if (blob.type !== "image/png" || blob.size < PNG_SIGNATURE.length) throw new ShareMessageImageEncodingError();
  const bytes = new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  assertBrowserActionCurrent(action);
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new ShareMessageImageEncodingError();
}

export async function deliverShareMessageImage(
  blob: Blob,
  filename: string,
  title: string,
  action: BrowserActionContext
): Promise<ShareMessageImageDelivery> {
  await assertPngBlob(blob, action);
  assertBrowserActionCurrent(action);
  const ownerWindow = action.ownerDocument.defaultView!;
  const navigator = ownerWindow.navigator;
  const safeTitle = boundedDisplayText(redactShareMessageText(singleLine(title)), SHARE_IMAGE_MAX_TITLE_CHARACTERS) || "Joko";
  const file = typeof ownerWindow.File === "undefined" ? undefined : new ownerWindow.File([blob], filename, { type: "image/png" });
  if (file !== undefined && typeof navigator.share === "function" && navigator.userActivation?.isActive === true) {
    let canShare = false;
    try {
      canShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
    } catch {
      canShare = false;
    }
    if (canShare) {
      assertBrowserActionCurrent(action);
      try {
        // Once issued, preserve the OS result. Retirement only suppresses stale UI feedback.
        await navigator.share({ files: [file], title: safeTitle });
        return "shared";
      } catch (error) {
        if (error !== null && typeof error === "object" && "name" in error && error.name === "AbortError") return "cancelled";
        throw error;
      }
    }
  }

  assertBrowserActionCurrent(action);
  downloadArtifactBlob(blob, filename, action);
  return "dispatched";
}

export function shareMessageImageFilename(sessionName: string, createdAt: number): string {
  const slug = redactShareMessageText(singleLine(sessionName)).toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "task";
  return `joko-${slug}-${safeIsoTimestamp(createdAt)}.png`;
}

function safeIsoTimestamp(value: number): string {
  if (!Number.isFinite(value)) return "message";
  try {
    return new Date(value).toISOString().replace(/[:.]/gu, "-");
  } catch {
    return "message";
  }
}

function singleLine(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function boundedDisplayText(value: string, maximumCharacters: number): string {
  if ([...value].length <= maximumCharacters) return value;
  return `${[...value].slice(0, Math.max(1, maximumCharacters - 1)).join("")}…`;
}
