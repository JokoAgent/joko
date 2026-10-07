import { type BlobRef, type Event } from "@joko/contracts";
import { mobileTimelineContent, type MobileTimelineContentSource } from "./mobile-timeline-content";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { bytesToDataUri, normalizeMediaType } from "./workspace-files";
import type { MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import { decodeMobileBase64 } from "./mobile-image-annotation";
import { inspectMobileGifBytes } from "./mobile-image-gif";
import { inspectMobileSvgBytes } from "./mobile-image-svg";
import { inspectMobileBmpBytes, inspectMobileIsoImageBytes, inspectMobileTiffBytes, type MobileImageContainer } from "./mobile-image-container";
import { inspectMobileIconBytes } from "./mobile-image-icon";
import { assertMobileImageGalleryDimensions } from "./mobile-image-dimensions";

export { assertMobileImageGalleryDimensions, MOBILE_IMAGE_GALLERY_MAXIMUM_DIMENSION, MOBILE_IMAGE_GALLERY_MAXIMUM_PIXELS } from "./mobile-image-dimensions";

const imageExtensions = {
  "image/jpeg": "jpg", "image/png": "png", "image/apng": "apng", "image/webp": "webp",
  "image/gif": "gif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico", "image/avif": "avif", "image/heic": "heic", "image/heif": "heif", "image/tiff": "tiff"
} as const;

export type MobileImageGallerySourceKind = "workspace" | "generated" | "timeline";

export interface MobileImageGalleryPage {
  readonly pageId: string;
  readonly title: string;
  readonly mediaType: keyof typeof imageExtensions;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly blob: BlobRef;
  readonly widthPixels?: number;
  readonly heightPixels?: number;
  readonly source:
    | { readonly kind: "workspace"; readonly relativePath: string; readonly revisionKey: string }
    | { readonly kind: "artifact"; readonly artifactId: string; readonly sessionId: string }
    | MobileTimelineContentSource;
}

export interface MobileImageGalleryPageSummary {
  readonly pageId: string;
  readonly title: string;
  readonly mediaType: MobileImageGalleryPage["mediaType"];
  readonly byteSize: number;
  readonly sha256Hex: string;
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
  readonly nativeQuarterTurn?: true;
  readonly animated?: boolean;
  readonly originalOnly?: boolean;
  readonly previewMarkup?: string;
  readonly previewBytes?: Uint8Array;
  readonly previewMediaType?: string;
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
  readonly expectedAnimated: boolean;
  readonly addable: boolean;
}

export function mobileImageGalleryPageSummary(page: MobileImageGalleryPage): MobileImageGalleryPageSummary {
  return {
    pageId: page.pageId,
    title: page.title,
    mediaType: page.mediaType,
    byteSize: page.byteSize,
    sha256Hex: page.sha256Hex,
    ...(page.widthPixels === undefined ? {} : { widthPixels: page.widthPixels }),
    ...(page.heightPixels === undefined ? {} : { heightPixels: page.heightPixels }),
    ...("eventId" in page.source ? { sourceEventId: page.source.eventId } : {})
  };
}

export function mobileImageGalleryMediaType(value: string): MobileImageGalleryPage["mediaType"] | undefined {
  const mediaType = normalizeMediaType(value);
  return Object.hasOwn(imageExtensions, mediaType) ? mediaType as MobileImageGalleryPage["mediaType"] : undefined;
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
  const pages: MobileImageGalleryPage[] = [];
  const seen = new Set<string>();
  mobileTimelineContent(event).forEach(({ source, blob, label, image }) => {
    const duplicateKey = `${blob.blobId}\u001f${blob.sha256Hex}`;
    if (!blob || !duplicateKey || seen.has(duplicateKey)) return;
    const page = mobileImageGalleryPage({
      pageId: source.kind === "timeline"
        ? `${source.eventId}:${source.messageId}:${source.contentKind}:${source.contentIndex}:${blob.blobId}`
        : JSON.stringify([source.eventId, source.kind, source.kind === "tool" ? source.contentIndex : 0, blob.blobId]),
      title: label || blob.fileName || `Image ${pages.length + 1}`,
      blob,
      ...(image === undefined ? {} : {
        widthPixels: image.widthPixels,
        heightPixels: image.heightPixels
      }),
      source
    });
    if (!page) return;
    seen.add(duplicateKey);
    pages.push(page);
  });
  return pages;
}

export function mobileTimelineGalleryWindowKey(events: readonly Event[]): string {
  const unique = new Map(events.map((event) => [event.eventId, event]));
  return [...unique.values()].map((event) => {
    const payload = event.payload?.kind;
    const pages = mobileTimelineGalleryPages(event);
    return [
      event.eventId,
      event.cursor?.generation.toString(10) ?? "",
      event.cursor?.sequence.toString(10) ?? "",
      event.identity?.sessionId ?? "",
      payload?.case ?? "",
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
  if (!mediaType) throw new Error("This file is not a supported gallery image.");
  if (mediaType === "image/svg+xml") {
    const svg = inspectMobileSvgBytes(bytes, (base64, embeddedType) => {
      inspectMobileImageGalleryBytes(decodeMobileBase64(base64, MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES), embeddedType);
    });
    assertMobileImageGalleryDimensions(svg.width, svg.height);
    return { mediaType, width: svg.width, height: svg.height, previewMarkup: svg.markup };
  }
  const dimensions: MobileImageContainer | undefined = mediaType === "image/png" || mediaType === "image/apng"
    ? pngDimensions(bytes)
    : mediaType === "image/jpeg"
      ? jpegDimensions(bytes)
      : mediaType === "image/gif" ? inspectMobileGifBytes(bytes)
      : mediaType === "image/webp" ? webpDimensions(bytes)
      : mediaType === "image/bmp" ? inspectMobileBmpBytes(bytes)
      : mediaType === "image/tiff" ? inspectMobileTiffBytes(bytes)
      : mediaType === "image/x-icon" || mediaType === "image/vnd.microsoft.icon"
        ? inspectMobileIconBytes(bytes, (png) => inspectMobileImageGalleryBytes(png, "image/png"))
        : inspectMobileIsoImageBytes(bytes, mediaType);
  if (!dimensions || mediaType === "image/apng" && dimensions.animated !== true) {
    throw new Error("The gallery image signature or dimensions do not match its media type.");
  }
  assertMobileImageGalleryDimensions(dimensions.width, dimensions.height);
  return { mediaType, width: dimensions.width, height: dimensions.height,
    ...("nativeQuarterTurn" in dimensions && dimensions.nativeQuarterTurn === true ? { nativeQuarterTurn: true } : {}),
    ...(dimensions.animated === true ? { animated: true } : {}),
    ...(dimensions.originalOnly === true ? { originalOnly: true } : {}),
    ...(dimensions.previewBytes ? { previewBytes: dimensions.previewBytes } : {}),
    ...(mediaType === "image/apng" || mediaType === "image/x-icon" || mediaType === "image/vnd.microsoft.icon" ? { previewMediaType: "image/png" } : {}) };
}

export function mobileImageGalleryDimensionsMatch(
  image: { readonly width: number; readonly height: number; readonly nativeQuarterTurn?: true },
  width: number,
  height: number
): boolean {
  // Static PNG/WebP decoders differ in EXIF handling; only the declared quarter turn is admissible.
  return width === image.width && height === image.height
    || image.nativeQuarterTurn === true && width === image.height && height === image.width;
}

export function confirmMobileImageGalleryCanvas(
  image: MobileImageGalleryDecodedImage,
  native: { readonly width: number; readonly height: number }
): MobileImageGalleryDecodedImage {
  if (!mobileImageGalleryDimensionsMatch(image, native.width, native.height)) {
    throw new Error("The native image dimensions do not match the inspected canvas.");
  }
  const { nativeQuarterTurn, ...confirmed } = image;
  return nativeQuarterTurn ? { ...confirmed, width: native.width, height: native.height } : confirmed;
}

export function mobileImageGalleryPreviewUri(bytes: Uint8Array, decoded: MobileImageGalleryDecodedImage): string {
  const preview = decoded.previewBytes ?? (decoded.previewMarkup === undefined ? bytes : new TextEncoder().encode(decoded.previewMarkup));
  return bytesToDataUri(preview, decoded.previewMediaType ?? decoded.mediaType);
}

export function mobileImageGalleryNativeAnimationMatches(mediaType: string, expectedAnimated: boolean, nativeAnimated: boolean | undefined): boolean {
  // Android reports every GIF drawable as Animatable, including a single-frame GIF. GIF output always preserves its container.
  return expectedAnimated ? nativeAnimated === true : normalizeMediaType(mediaType) === "image/gif" || nativeAnimated !== true;
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

function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number; readonly animated?: boolean; readonly nativeQuarterTurn?: true } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return undefined;
  let offset = 8;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  let animationFrames: number | undefined; let frames = 0; let sequence = 0;
  let imageData = false; let frameData = false; let inFrame = false;
  let orientation: number | undefined;
  while (offset + 12 <= bytes.byteLength) {
    const length = readU32Be(bytes, offset);
    if (length === undefined || length > bytes.byteLength - offset - 12) return undefined;
    const type = ascii(bytes, offset + 4, 4);
    const data = offset + 8;
    if (!dimensions && type !== "IHDR") return undefined;
    if (type === "IHDR") {
      if (dimensions || length !== 13) return undefined;
      const width = readU32Be(bytes, offset + 8);
      const height = readU32Be(bytes, offset + 12);
      if (width === undefined || height === undefined) return undefined;
      dimensions = { width, height };
    } else if (type === "eXIf") {
      if (orientation !== undefined) return undefined;
      orientation = exifOrientation(bytes.subarray(data, data + length));
      if (orientation === undefined) return undefined;
    } else if (type === "acTL") {
      const count = readU32Be(bytes, data);
      if (animationFrames !== undefined || imageData || length !== 8 || !count || count > 4_096) return undefined;
      animationFrames = count;
    } else if (type === "fcTL") {
      if (!animationFrames || !dimensions || length !== 26 || (inFrame && !frameData)
        || readU32Be(bytes, data) !== sequence++) return undefined;
      const width = readU32Be(bytes, data + 4)!; const height = readU32Be(bytes, data + 8)!;
      const left = readU32Be(bytes, data + 12)!; const top = readU32Be(bytes, data + 16)!;
      if (!width || !height || left + width > dimensions.width || top + height > dimensions.height
        || bytes[data + 24]! > 2 || bytes[data + 25]! > 1 || ++frames > animationFrames) return undefined;
      inFrame = true; frameData = false;
    } else if (type === "fdAT") {
      if (!animationFrames || !inFrame || length <= 4 || readU32Be(bytes, data) !== sequence++) return undefined;
      frameData = true;
    } else if (type === "IDAT") {
      imageData = true; if (inFrame) frameData = true;
    }
    offset += 12 + length;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.byteLength || !dimensions
        || (animationFrames !== undefined && (frames !== animationFrames || !frameData))) return undefined;
      return { ...dimensions, ...(animationFrames !== undefined ? { animated: true } : {}),
        ...(animationFrames === undefined && (orientation ?? 1) >= 5 ? { nativeQuarterTurn: true } : {}) };
    }
  }
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  let orientation: number | undefined;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) return undefined;
    // Header dimensions are provisional until the native decoder confirms actual pixels.
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
    const length = readU16Be(bytes, offset);
    if (length === undefined || length < 2 || offset + length > bytes.byteLength) return undefined;
    if (startOfFrame.has(marker)) {
      if (length < 7) return undefined;
      const height = readU16Be(bytes, offset + 3);
      const width = readU16Be(bytes, offset + 5);
      if (!width || !height || dimensions && (dimensions.width !== width || dimensions.height !== height)) return undefined;
      dimensions = { width, height };
    } else if (marker === 0xe1 && ascii(bytes, offset + 2, 6) === "Exif\0\0") {
      if (orientation !== undefined) return undefined;
      orientation = exifOrientation(bytes.subarray(offset + 8, offset + length));
      if (orientation === undefined) return undefined;
    }
    offset += length;
  }
  if (!dimensions) return undefined;
  return (orientation ?? 1) >= 5 ? { width: dimensions.height, height: dimensions.width } : dimensions;
}

function exifOrientation(bytes: Uint8Array): number | undefined {
  const order = ascii(bytes, 0, 2);
  if (bytes.byteLength < 8 || order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return undefined;
  const directory = view.getUint32(4, little);
  if (directory < 8 || directory + 2 > bytes.byteLength) return undefined;
  const count = view.getUint16(directory, little);
  if (count > 4_096 || directory + 2 + count * 12 + 4 > bytes.byteLength) return undefined;
  let orientation: number | undefined;
  for (let index = 0; index < count; index++) {
    const offset = directory + 2 + index * 12;
    if (view.getUint16(offset, little) !== 0x0112) continue;
    if (orientation !== undefined || view.getUint16(offset + 2, little) !== 3
      || view.getUint32(offset + 4, little) !== 1) return undefined;
    orientation = view.getUint16(offset + 8, little);
    if (orientation < 1 || orientation > 8) return undefined;
  }
  // Only IFD0 describes the primary image; thumbnail and Exif subdirectories do not own its canvas.
  return orientation ?? 1;
}

function webpDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number; readonly animated?: boolean; readonly nativeQuarterTurn?: true } | undefined {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const riffSize = readU32Le(bytes, 4);
  if (riffSize === undefined || riffSize + 8 !== bytes.byteLength) return undefined;
  let offset = 12;
  let dimensions: { readonly width: number; readonly height: number } | undefined;
  let extended = false; let animated = false; let animationControl = false; let frames = 0; let bitmap = false;
  let orientation: number | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const length = readU32Le(bytes, offset + 4);
    if (length === undefined || length + length % 2 > bytes.byteLength - offset - 8) return undefined;
    const data = offset + 8;
    if (type === "VP8X") {
      if (length !== 10 || dimensions || offset !== 12 || (bytes[data]! & 0xc1) !== 0
        || bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) return undefined;
      extended = true; animated = (bytes[data]! & 0x02) !== 0;
      dimensions = {
        width: 1 + readU24Le(bytes, data + 4),
        height: 1 + readU24Le(bytes, data + 7)
      };
    } else if (type === "EXIF") {
      if (orientation !== undefined) return undefined;
      const metadata = bytes.subarray(data, data + length);
      orientation = exifOrientation(ascii(metadata, 0, 6) === "Exif\0\0" ? metadata.subarray(6) : metadata);
      if (orientation === undefined) return undefined;
    } else if (type === "ANIM") {
      if (!animated || animationControl || frames || length !== 6) return undefined;
      animationControl = true;
    } else if (type === "ANMF") {
      if (!animated || !animationControl || !dimensions || length < 24 || ++frames > 4_096) return undefined;
      const left = 2 * readU24Le(bytes, data); const top = 2 * readU24Le(bytes, data + 3);
      const width = 1 + readU24Le(bytes, data + 6); const height = 1 + readU24Le(bytes, data + 9);
      if (left + width > dimensions.width || top + height > dimensions.height || bytes[data + 15]! > 3) return undefined;
      let frameOffset = data + 16; let frameBitmap = false; let frameAlpha = false;
      while (frameOffset + 8 <= data + length) {
        const frameType = ascii(bytes, frameOffset, 4); const frameLength = readU32Le(bytes, frameOffset + 4)!;
        if (frameLength + frameLength % 2 > data + length - frameOffset - 8) return undefined;
        if (frameType === "VP8 " || frameType === "VP8L") {
          const frame = webpBitmapDimensions(bytes, frameOffset + 8, frameLength, frameType);
          if (frameBitmap || frameType === "VP8L" && frameAlpha
            || !frame || frame.width !== width || frame.height !== height) return undefined;
          frameBitmap = true;
        } else if (frameType === "ALPH") {
          if (frameAlpha || frameBitmap) return undefined;
          frameAlpha = true;
        } else {
          // Extension chunks may only trail the complete frame bitstream.
          if (!frameBitmap || ["VP8X", "ICCP", "ANIM", "ANMF", "EXIF", "XMP "].includes(frameType)) return undefined;
        }
        frameOffset += 8 + frameLength + frameLength % 2;
      }
      if (!frameBitmap || frameOffset !== data + length) return undefined;
    } else if (type === "VP8 " || type === "VP8L") {
      if (bitmap || animated) return undefined;
      const frame = webpBitmapDimensions(bytes, data, length, type);
      if (!frame || (extended && dimensions && (frame.width !== dimensions.width || frame.height !== dimensions.height))) return undefined;
      bitmap = true; dimensions ??= frame;
    }
    offset += 8 + length + (length % 2);
  }
  return dimensions && offset === bytes.byteLength && (!animated || animationControl && frames > 0)
    ? { ...dimensions, ...(animated ? { animated: true } : {}),
      ...(!animated && (orientation ?? 1) >= 5 ? { nativeQuarterTurn: true } : {}) } : undefined;
}

function webpBitmapDimensions(bytes: Uint8Array, data: number, length: number, type: string): { readonly width: number; readonly height: number } | undefined {
  if (type === "VP8 ") {
    if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return undefined;
    return { width: readU16Le(bytes, data + 6)! & 0x3fff, height: readU16Le(bytes, data + 8)! & 0x3fff };
  }
  if (length < 5 || bytes[data] !== 0x2f) return undefined;
  const bits = readU32Le(bytes, data + 1)!;
  return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
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
  return imageExtensions[mediaType];
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
