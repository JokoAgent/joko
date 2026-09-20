import {
  normalizeAttachmentMediaType,
  normalizeMobileAttachmentFileName,
  type MobileAttachmentPolicy
} from "./mobile-attachments";
import { classifyMobileAttachment } from "./mobile-attachments";

export interface MobileImageDimensions {
  readonly width?: number | null;
  readonly height?: number | null;
}

export interface MobileImageStatDriver {
  stat(uri: string): Promise<number>;
}

export const mobileRasterMediaTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence"
]);

export function normalizeMobileImageUri(value: string | null | undefined, message: string): string {
  const uri = typeof value === "string" ? value.trim() : "";
  if (!uri || uri.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(uri)) throw new Error(message);
  return uri;
}

export function assertMobileImageDimensions(value: MobileImageDimensions, subject: string): void {
  for (const [label, dimension] of [["width", value.width], ["height", value.height]] as const) {
    if (dimension !== undefined && dimension !== null
      && (!Number.isSafeInteger(dimension) || dimension <= 0)) {
      throw new Error(`${subject} has an invalid ${label}.`);
    }
  }
}

export async function statMobileImageFile(
  driver: MobileImageStatDriver,
  uri: string,
  label: string
): Promise<number> {
  let byteSize: number;
  try { byteSize = await driver.stat(uri); }
  catch { throw new Error(`The ${label} could not be read.`); }
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error(`The ${label} is empty or has an invalid size.`);
  }
  return byteSize;
}

export function mobileImageMediaType(
  mediaType: string | null | undefined,
  fileName: string | null | undefined,
  uri: string,
  notImageMessage: string
): string | undefined {
  if (typeof mediaType === "string" && mediaType.trim()) {
    const normalized = normalizeAttachmentMediaType(mediaType);
    if (!normalized.startsWith("image/")) throw new Error(notImageMessage);
    return normalized;
  }
  const extension = mobileImageExtension(typeof fileName === "string" && fileName.trim() ? fileName : uri);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (["png", "gif", "webp", "heic", "heif"].includes(extension)) return `image/${extension}`;
  if (extension === "bmp") return "image/bmp";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  return undefined;
}

export function mobileImageFileName(
  fileName: string | null | undefined,
  uri: string,
  mediaType: string | undefined,
  capturedAtUnixMs: number,
  fallbackPrefix = "joko-photo"
): string {
  const explicit = typeof fileName === "string" ? fileName.trim() : "";
  if (explicit) return normalizeMobileAttachmentFileName(explicit);
  const uriLeaf = uri.split(/[?#]/u)[0]!.split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (uriLeaf) {
    try { return normalizeMobileAttachmentFileName(uriLeaf); }
    catch { /* Fall through to a controlled name. */ }
  }
  if (!Number.isSafeInteger(capturedAtUnixMs) || capturedAtUnixMs < 0) {
    throw new Error("The selected photo time is invalid.");
  }
  return `${fallbackPrefix}-${capturedAtUnixMs}.${mobileImageExtensionForMediaType(mediaType ?? "image/jpeg")}`;
}

export function mobileImageMediaTypeAccepted(mediaType: string, policy: MobileAttachmentPolicy): boolean {
  try { return classifyMobileAttachment(mediaType, policy) === "image"; }
  catch { return false; }
}

export function normalizeMobileImageFileExtension(fileName: string, mediaType: string): string {
  const normalized = normalizeMobileAttachmentFileName(fileName);
  const extension = mobileImageExtension(normalized);
  const withoutExtension = extension ? normalized.slice(0, -(extension.length + 1)) : normalized;
  const base = withoutExtension || "joko-photo";
  return `${base}.${mobileImageExtensionForMediaType(mediaType)}`;
}

export function mobileImageExtension(value: string): string {
  const leaf = value.split(/[?#]/u)[0]!.split(/[\\/]/u).at(-1) ?? "";
  const extension = leaf.lastIndexOf(".");
  return extension >= 0 ? leaf.slice(extension + 1).toLowerCase() : "";
}

export function mobileImageExtensionForMediaType(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/bmp") return "bmp";
  if (mediaType === "image/tiff") return "tiff";
  if (mediaType === "image/heic") return "heic";
  if (mediaType === "image/heif") return "heif";
  if (mediaType === "image/heic-sequence") return "heic";
  if (mediaType === "image/heif-sequence") return "heif";
  return "img";
}
