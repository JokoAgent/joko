import type { WeChatTransientMedia } from "./model.js";
import { weChatInvalid, weChatMalformed } from "./errors.js";

export interface WeChatDetectedMedia {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}

export function classifyWeChatOutbound(input: {
  readonly kind: "image" | "file";
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}): { readonly kind: "image" | "video" | "file"; readonly fileName: string } {
  const name = safeWeChatFileName(input.fileName, "wechat-file.bin");
  if (input.kind === "image") {
    if (detectImage(input.bytes) === null) throw weChatInvalid("WeChat image format is unsupported.");
    return { kind: "image", fileName: name };
  }
  return { kind: isMp4(input.bytes) ? "video" : "file", fileName: name };
}

export function detectWeChatDownloadedMedia(ref: WeChatTransientMedia, bytes: Uint8Array): WeChatDetectedMedia {
  switch (ref.kind) {
    case "image": {
      const found = detectImage(bytes);
      if (found === null) throw weChatMalformed("WeChat image format is unsupported.", false);
      return { bytes, fileName: `wechat-image${found.extension}`, mimeType: found.mimeType };
    }
    case "video":
      if (!isMp4(bytes)) throw weChatMalformed("WeChat video format is unsupported.", false);
      return { bytes, fileName: safeWeChatFileName(ref.fileName, "wechat-video.mp4"), mimeType: "video/mp4" };
    case "voice":
      switch (ref.voiceEncoding) {
        case 6:
          if (!starts(bytes, "RIFF") || !starts(bytes.subarray(8), "WAVE")) throw weChatMalformed("WeChat voice WAV is invalid.", false);
          return { bytes, fileName: "wechat-voice.wav", mimeType: "audio/wav" };
        case 7:
          if (!starts(bytes, "ID3") && !(bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) {
            throw weChatMalformed("WeChat voice MP3 is invalid.", false);
          }
          return { bytes, fileName: "wechat-voice.mp3", mimeType: "audio/mpeg" };
        case 8:
          if (!starts(bytes, "OggS")) throw weChatMalformed("WeChat voice Ogg is invalid.", false);
          return { bytes, fileName: "wechat-voice.ogg", mimeType: "audio/ogg" };
        default:
          throw weChatMalformed("WeChat voice encoding is unsupported.", false);
      }
    case "file": {
      const fileName = safeWeChatFileName(ref.fileName, "wechat-file.bin");
      return { bytes, fileName, mimeType: mimeForName(fileName) };
    }
  }
}

export function safeWeChatFileName(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_")
    .replace(/[. ]+$/gu, "").trim().slice(0, 180);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : fallback;
}

function detectImage(bytes: Uint8Array): { readonly extension: string; readonly mimeType: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && starts(bytes.subarray(1), "PNG\r\n\u001a\n")) return { extension: ".png", mimeType: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: ".jpg", mimeType: "image/jpeg" };
  if (starts(bytes, "GIF87a") || starts(bytes, "GIF89a")) return { extension: ".gif", mimeType: "image/gif" };
  if (bytes.length >= 12 && starts(bytes, "RIFF") && starts(bytes.subarray(8), "WEBP")) return { extension: ".webp", mimeType: "image/webp" };
  return null;
}

function isMp4(bytes: Uint8Array): boolean { return bytes.length >= 12 && starts(bytes.subarray(4), "ftyp"); }

function starts(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false;
  for (let index = 0; index < value.length; index += 1) if (bytes[index] !== value.charCodeAt(index)) return false;
  return true;
}

function mimeForName(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  const known: Record<string, string> = {
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".pdf": "application/pdf", ".zip": "application/zip", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return known[extension] ?? "application/octet-stream";
}
