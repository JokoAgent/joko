import { MessageRole, type BlobRef, type Event } from "@joko/contracts";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { normalizeMediaType } from "./workspace-files";
import type { MobileComposerImageEditorSession } from "./mobile-composer-image-editor";

export const MOBILE_IMAGE_GALLERY_MAXIMUM_DIMENSION = 16_384;
export const MOBILE_IMAGE_GALLERY_MAXIMUM_PIXELS = 64 * 1_024 * 1_024;

export type MobileImageGallerySourceKind = "workspace" | "generated" | "timeline";

export interface MobileImageGalleryPage {
  readonly pageId: string;
  readonly title: string;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly blob: BlobRef;
  readonly widthPixels?: number;
  readonly heightPixels?: number;
  readonly source:
    | { readonly kind: "workspace"; readonly relativePath: string; readonly revisionKey: string }
    | { readonly kind: "artifact"; readonly artifactId: string; readonly sessionId: string }
    | {
        readonly kind: "timeline";
        readonly eventId: string;
        readonly messageId: string;
        readonly contentKind: "block" | "inputPart";
        readonly contentIndex: number;
      };
}

export interface MobileImageGalleryPageSummary {
  readonly pageId: string;
  readonly title: string;
  readonly mediaType: MobileImageGalleryPage["mediaType"];
  readonly byteSize: number;
  readonly widthPixels?: number;
  readonly heightPixels?: number;
  readonly sourceEventId?: string;
}

export interface MobileImageGalleryDescriptor {
  readonly leaseId: string;
  readonly sourceKind: MobileImageGallerySourceKind;
  readonly sourceLabel: string;
  readonly pages: readonly MobileImageGalleryPageSummary[];
  readonly initialIndex: number;
}

export interface MobileImageGalleryDecodedImage {
  readonly mediaType: MobileImageGalleryPage["mediaType"];
  readonly width: number;
  readonly height: number;
}

export interface MobileImageGalleryNativeDecode {
  readonly mediaType?: string | null;
  readonly width: number;
  readonly height: number;
  readonly isAnimated?: boolean;
}

export interface MobileImageGalleryPageSession extends MobileComposerImageEditorSession {
  readonly galleryLeaseId: string;
  readonly pageId: string;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly sourceKind: MobileImageGallerySourceKind;
  readonly sourceLabel: string;
  readonly expectedWidthPixels: number;
  readonly expectedHeightPixels: number;
  readonly addable: boolean;
}

export function mobileImageGalleryPageSummary(page: MobileImageGalleryPage): MobileImageGalleryPageSummary {
  return {
    pageId: page.pageId,
    title: page.title,
    mediaType: page.mediaType,
    byteSize: page.byteSize,
    ...(page.widthPixels === undefined ? {} : { widthPixels: page.widthPixels }),
    ...(page.heightPixels === undefined ? {} : { heightPixels: page.heightPixels }),
    ...(page.source.kind === "timeline" ? { sourceEventId: page.source.eventId } : {})
  };
}

export function mobileImageGalleryMediaType(value: string): MobileImageGalleryPage["mediaType"] | undefined {
  const mediaType = normalizeMediaType(value);
  if (mediaType === "image/jpeg" || mediaType === "image/png" || mediaType === "image/webp") return mediaType;
  return undefined;
}

export function mobileImageGalleryPage(input: {
  readonly pageId: string;
  readonly title: string;
  readonly blob: BlobRef | undefined;
  readonly widthPixels?: number;
  readonly heightPixels?: number;
  readonly requireDimensions?: boolean;
  readonly source: MobileImageGalleryPage["source"];
}): MobileImageGalleryPage | undefined {
  const pageId = boundedText(input.pageId, 1_024);
  const blob = input.blob;
  const mediaType = mobileImageGalleryMediaType(blob?.mediaType ?? "");
  if (!pageId || !blob?.blobId || !mediaType || blob.byteSize < 1n
    || blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)
    || blob.byteSize > BigInt(Number.MAX_SAFE_INTEGER)
    || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)) return undefined;
  const widthPixels = positiveDimension(input.widthPixels);
  const heightPixels = positiveDimension(input.heightPixels);
  if (input.requireDimensions && (widthPixels === undefined || heightPixels === undefined)) return undefined;
  if ((widthPixels === undefined) !== (heightPixels === undefined)) return undefined;
  if (widthPixels !== undefined && heightPixels !== undefined) {
    try { assertMobileImageGalleryDimensions(widthPixels, heightPixels); }
    catch { return undefined; }
  }
  const fallback = safeFileName(blob.fileName) || `Image.${extensionFor(mediaType)}`;
  const title = boundedText(input.title, 512) || fallback;
  return {
    pageId,
    title,
    mediaType,
    byteSize: Number(blob.byteSize),
    sha256Hex: blob.sha256Hex,
    blob,
    ...(widthPixels === undefined ? {} : { widthPixels }),
    ...(heightPixels === undefined ? {} : { heightPixels }),
    source: input.source
  };
}

export function mobileTimelineGalleryPages(event: Event): readonly MobileImageGalleryPage[] {
  const payload = event.payload?.kind;
  const sessionId = event.identity?.sessionId ?? "";
  const message = mobileTimelineGalleryMessage(event);
  if (!event.eventId || !sessionId || !message) return [];
  const candidates = payload?.case === "messageCompleted"
    ? payload.value.blocks.map((block, contentIndex) => ({
        contentKind: "block" as const,
        contentIndex,
        image: block.content.case === "image" ? block.content.value : undefined,
        artifact: block.content.case === "artifact" ? block.content.value : undefined
      }))
    : payload?.case === "messageStarted" && payload.value.userInputAccepted
      ? (payload.value.userInput?.parts ?? []).map((part, contentIndex) => ({
          contentKind: "inputPart" as const,
          contentIndex,
          image: part.content.case === "image" ? part.content.value : undefined,
          artifact: undefined
        }))
      : [];
  const pages: MobileImageGalleryPage[] = [];
  const seen = new Set<string>();
  candidates.forEach(({ contentKind, contentIndex, image, artifact }) => {
    const blob = image?.blob ?? artifact?.blob;
    const duplicateKey = blob ? `${blob.blobId}\u001f${blob.sha256Hex}` : "";
    if (!blob || !duplicateKey || seen.has(duplicateKey)) return;
    const page = mobileImageGalleryPage({
      pageId: `${event.eventId}:${message.messageId}:${contentKind}:${contentIndex}:${blob.blobId}`,
      title: image?.altText || artifact?.label || blob.fileName || `Image ${pages.length + 1}`,
      blob,
      ...(image === undefined ? {} : {
        widthPixels: image.widthPixels,
        heightPixels: image.heightPixels
      }),
      source: {
        kind: "timeline",
        eventId: event.eventId,
        messageId: message.messageId,
        contentKind,
        contentIndex
      }
    });
    if (!page) return;
    seen.add(duplicateKey);
    pages.push(page);
  });
  return pages;
}

export function mobileTimelineGalleryMessage(
  event: Event
): { readonly messageId: string; readonly role: MessageRole } | undefined {
  const payload = event.payload?.kind;
  if (payload?.case === "messageCompleted" && payload.value.messageId
    && [MessageRole.USER, MessageRole.ASSISTANT, MessageRole.SYSTEM, MessageRole.TOOL].includes(payload.value.role)) {
    return { messageId: payload.value.messageId, role: payload.value.role };
  }
  if (payload?.case === "messageStarted" && payload.value.messageId
    && payload.value.role === MessageRole.USER && payload.value.userInputAccepted && payload.value.userInput) {
    return { messageId: payload.value.messageId, role: payload.value.role };
  }
  return undefined;
}

export function mobileTimelineGalleryWindowKey(events: readonly Event[]): string {
  const unique = new Map(events.map((event) => [event.eventId, event]));
  return [...unique.values()].map((event) => {
    const payload = event.payload?.kind;
    const message = mobileTimelineGalleryMessage(event);
    const pages = mobileTimelineGalleryPages(event);
    return [
      event.eventId,
      event.cursor?.generation.toString(10) ?? "",
      event.cursor?.sequence.toString(10) ?? "",
      event.identity?.sessionId ?? "",
      payload?.case ?? "",
      message?.messageId ?? "",
      ...pages.flatMap((page) => [page.pageId, page.sha256Hex, page.byteSize.toString(10)])
    ].join("\u001e");
  }).join("\u001f");
}

export function inspectMobileImageGalleryBytes(
  bytes: Uint8Array,
  expectedMediaType: string
): MobileImageGalleryDecodedImage {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12
    || bytes.byteLength > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) {
    throw new Error("The gallery image bytes are invalid or exceed the preview limit.");
  }
  const mediaType = mobileImageGalleryMediaType(expectedMediaType);
  if (!mediaType) throw new Error("This file is not a supported static gallery image.");
  const dimensions = mediaType === "image/png"
    ? pngDimensions(bytes)
    : mediaType === "image/jpeg"
      ? jpegDimensions(bytes)
      : webpDimensions(bytes);
  if (!dimensions) throw new Error("The gallery image signature or dimensions do not match its media type.");
  assertMobileImageGalleryDimensions(dimensions.width, dimensions.height);
  return { mediaType, ...dimensions };
}

export function assertMobileImageGalleryDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MOBILE_IMAGE_GALLERY_MAXIMUM_DIMENSION || height > MOBILE_IMAGE_GALLERY_MAXIMUM_DIMENSION
    || width * height > MOBILE_IMAGE_GALLERY_MAXIMUM_PIXELS) {
    throw new Error("The gallery image dimensions exceed the safe decode limit.");
  }
}

export function sameMobileImageGalleryPage(
  left: MobileImageGalleryPage,
  right: MobileImageGalleryPage
): boolean {
  return left.pageId === right.pageId && left.title === right.title && left.mediaType === right.mediaType
    && left.byteSize === right.byteSize && left.sha256Hex === right.sha256Hex
    && left.widthPixels === right.widthPixels && left.heightPixels === right.heightPixels
    && left.blob.blobId === right.blob.blobId && left.blob.fileName === right.blob.fileName
    && normalizeMediaType(left.blob.mediaType) === normalizeMediaType(right.blob.mediaType)
    && left.blob.byteSize === right.blob.byteSize && left.blob.sha256Hex === right.blob.sha256Hex
    && JSON.stringify(left.source) === JSON.stringify(right.source);
}

function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return undefined;
  let offset = 8;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  while (offset + 12 <= bytes.byteLength) {
    const length = readU32Be(bytes, offset);
    if (length === undefined || length > bytes.byteLength - offset - 12) return undefined;
    const type = ascii(bytes, offset + 4, 4);
    if (type === "acTL") return undefined;
    if (type === "IHDR") {
      if (dimensions || length !== 13) return undefined;
      const width = readU32Be(bytes, offset + 8);
      const height = readU32Be(bytes, offset + 12);
      if (width === undefined || height === undefined) return undefined;
      dimensions = { width, height };
    }
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return dimensions;
}

function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
    const length = readU16Be(bytes, offset);
    if (length === undefined || length < 2 || offset + length > bytes.byteLength) return undefined;
    if (startOfFrame.has(marker)) {
      if (length < 7) return undefined;
      const height = readU16Be(bytes, offset + 3);
      const width = readU16Be(bytes, offset + 5);
      return width === undefined || height === undefined ? undefined : { width, height };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const riffSize = readU32Le(bytes, 4);
  if (riffSize === undefined || riffSize + 8 !== bytes.byteLength) return undefined;
  let offset = 12;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const length = readU32Le(bytes, offset + 4);
    if (length === undefined || length > bytes.byteLength - offset - 8) return undefined;
    const data = offset + 8;
    if (type === "ANIM" || type === "ANMF") return undefined;
    if (type === "VP8X") {
      if (length < 10 || dimensions || (bytes[data]! & 0x02) !== 0) return undefined;
      dimensions = {
        width: 1 + readU24Le(bytes, data + 4),
        height: 1 + readU24Le(bytes, data + 7)
      };
    } else if (type === "VP8 ") {
      if (length < 10 || dimensions || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
        return undefined;
      }
      const width = readU16Le(bytes, data + 6);
      const height = readU16Le(bytes, data + 8);
      if (width === undefined || height === undefined) return undefined;
      dimensions = { width: width & 0x3fff, height: height & 0x3fff };
    } else if (type === "VP8L") {
      if (length < 5 || dimensions || bytes[data] !== 0x2f) return undefined;
      const bits = readU32Le(bytes, data + 1);
      if (bits === undefined) return undefined;
      dimensions = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff)
      };
    }
    offset += 8 + length + (length % 2);
  }
  return dimensions;
}

function positiveDimension(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value : undefined;
}

function boundedText(value: string, maximum: number): string {
  const exact = typeof value === "string" ? value.trim() : "";
  return exact.length > 0 && exact.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(exact) ? exact : "";
}

function safeFileName(value: string): string {
  const exact = boundedText(value, 512);
  return exact && !exact.includes("/") && !exact.includes("\\") ? exact : "";
}

function extensionFor(mediaType: MobileImageGalleryPage["mediaType"]): string {
  return mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "webp";
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readU16Be(bytes: Uint8Array, offset: number): number | undefined {
  return offset >= 0 && offset + 2 <= bytes.byteLength ? bytes[offset]! * 256 + bytes[offset + 1]! : undefined;
}

function readU16Le(bytes: Uint8Array, offset: number): number | undefined {
  return offset >= 0 && offset + 2 <= bytes.byteLength ? bytes[offset]! + bytes[offset + 1]! * 256 : undefined;
}

function readU24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65_536;
}

function readU32Be(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return bytes[offset]! * 16_777_216 + bytes[offset + 1]! * 65_536 + bytes[offset + 2]! * 256 + bytes[offset + 3]!;
}

function readU32Le(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return (bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65_536 + bytes[offset + 3]! * 16_777_216) >>> 0;
}
