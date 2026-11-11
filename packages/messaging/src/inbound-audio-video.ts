import { extname } from "node:path";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".amr": "audio/amr",
  ".silk": "audio/silk"
};

/** A provider hint for routing into byte verification. */
export function inboundAudioVideoMime(mimeType: string | null, fileName: string): string | null {
  if (mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) return mimeType;
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? null;
}
