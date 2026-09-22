import { Buffer } from "node:buffer";
import path from "node:path";

import { MessagingTransportError } from "../types.js";

export const WECOM_MAXIMUM_IMAGE_BYTES = 10 * 1_024 * 1_024;
export const WECOM_MAXIMUM_MEDIA_BYTES = 50 * 1_024 * 1_024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export function safeWeComFileName(value: string | undefined, fallback: string): string {
  const sanitized = path.basename(value?.trim() || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_")
    .replace(/[ .]+$/gu, "")
    .slice(0, 160);
  const name = sanitized || fallback;
  return WINDOWS_RESERVED.test(name) ? `_${name}`.slice(0, 160) : name;
}

export function mimeTypeForWeComFile(fileName: string): string {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export function validateWeComDownload(input: {
  readonly bytes: Buffer;
  readonly fileName: string | undefined;
  readonly fallbackName: string;
  readonly maximumBytes: number;
}): { readonly bytes: Uint8Array; readonly fileName: string; readonly mimeType: string } {
  if (input.bytes.byteLength < 1) throw invalidInput("WeCom downloaded an empty attachment.");
  if (input.bytes.byteLength > input.maximumBytes) {
    throw new MessagingTransportError("payload_too_large", "WeCom attachment exceeds the channel limit.", {
      retryable: false,
      effect: "none"
    });
  }
  const fileName = safeWeComFileName(input.fileName, input.fallbackName);
  return { bytes: input.bytes, fileName, mimeType: mimeTypeForWeComFile(fileName) };
}

export function classifyWeComOutbound(input: {
  readonly kind: "image" | "file";
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}): { readonly buffer: Buffer; readonly fileName: string; readonly mediaType: "image" | "file" | "voice" | "video" } {
  const fileName = safeWeComFileName(input.fileName, input.kind === "image" ? "image.jpg" : "attachment");
  const buffer = Buffer.from(input.bytes);
  if (buffer.byteLength < 1) throw invalidInput("WeCom attachment is empty.");
  if (buffer.byteLength > WECOM_MAXIMUM_MEDIA_BYTES) {
    throw new MessagingTransportError("payload_too_large", "WeCom attachment exceeds 50 MiB.", {
      retryable: false,
      effect: "none"
    });
  }
  const mimeType = input.mimeType.trim().toLowerCase() || mimeTypeForWeComFile(fileName);
  const mediaType = input.kind === "image" && mimeType.startsWith("image/")
    && buffer.byteLength <= WECOM_MAXIMUM_IMAGE_BYTES
    ? "image"
    : mimeType.startsWith("video/")
      ? "video"
      : mimeType.startsWith("audio/")
        ? "voice"
        : "file";
  return { buffer, fileName, mediaType };
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
