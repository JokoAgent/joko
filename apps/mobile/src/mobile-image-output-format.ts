import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { assertMobileImageGalleryDimensions, inspectMobileImageGalleryBytes } from "./mobile-image-gallery";
import { normalizeMediaType } from "./workspace-files";

export type MobileImageOutputMediaType =
  | "image/avif"
  | "image/bmp"
  | "image/heic"
  | "image/heif"
  | "image/jpeg"
  | "image/png"
  | "image/tiff"
  | "image/webp";

const outputExtensions: Readonly<Record<MobileImageOutputMediaType, string>> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp"
};

export function mobileImageOutputMediaType(value: string): MobileImageOutputMediaType | undefined {
  const mediaType = normalizeMediaType(value);
  return Object.hasOwn(outputExtensions, mediaType) ? mediaType as MobileImageOutputMediaType : undefined;
}

export function mobileImageOutputExtension(mediaType: MobileImageOutputMediaType): string {
  return outputExtensions[mediaType];
}

export function inspectMobileImageOutputBytes(
  bytes: Uint8Array,
  expectedMediaType: string,
  expectedDimensions?: { readonly width: number; readonly height: number }
): { readonly mediaType: MobileImageOutputMediaType; readonly width: number; readonly height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12
    || bytes.byteLength > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) {
    throw new Error("The image output bytes are invalid or exceed the output limit.");
  }
  const mediaType = mobileImageOutputMediaType(expectedMediaType);
  if (!mediaType) throw new Error("This static image format is not supported for native output.");
  const dimensions = mediaType === "image/jpeg" || mediaType === "image/png" || mediaType === "image/webp"
    ? inspectMobileImageGalleryBytes(bytes, mediaType)
    : mediaType === "image/bmp"
      ? bmpDimensions(bytes)
      : mediaType === "image/tiff"
        ? tiffDimensions(bytes)
        : isoImageDimensions(bytes, mediaType, expectedDimensions);
  if (!dimensions) throw new Error("The image output signature or dimensions do not match its media type.");
  assertMobileImageGalleryDimensions(dimensions.width, dimensions.height);
  if (expectedDimensions
    && (dimensions.width !== expectedDimensions.width || dimensions.height !== expectedDimensions.height)) {
    throw new Error("The image output bytes do not match the native decoder dimensions.");
  }
  return { mediaType, width: dimensions.width, height: dimensions.height };
}

function bmpDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (ascii(bytes, 0, 2) !== "BM") return undefined;
  const fileSize = readU32(bytes, 2, true);
  const pixelOffset = readU32(bytes, 10, true);
  const dibSize = readU32(bytes, 14, true);
  if (fileSize !== bytes.byteLength || pixelOffset === undefined || pixelOffset < 26
    || pixelOffset >= bytes.byteLength || dibSize === undefined || 14 + dibSize > bytes.byteLength) return undefined;
  if (dibSize === 12) {
    const width = readU16(bytes, 18, true);
    const height = readU16(bytes, 20, true);
    const planes = readU16(bytes, 22, true);
    return width && height && planes === 1 ? { width, height } : undefined;
  }
  if (dibSize < 40) return undefined;
  const width = readI32(bytes, 18, true);
  const signedHeight = readI32(bytes, 22, true);
  const planes = readU16(bytes, 26, true);
  const bitsPerPixel = readU16(bytes, 28, true);
  if (width === undefined || width < 1 || signedHeight === undefined || signedHeight === 0
    || planes !== 1 || bitsPerPixel === undefined || bitsPerPixel < 1) return undefined;
  return { width, height: Math.abs(signedHeight) };
}

function tiffDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  const byteOrder = ascii(bytes, 0, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return undefined;
  if (readU16(bytes, 2, littleEndian) !== 42) return undefined;
  const directoryOffset = readU32(bytes, 4, littleEndian);
  if (directoryOffset === undefined || directoryOffset < 8 || directoryOffset + 2 > bytes.byteLength) return undefined;
  const entryCount = readU16(bytes, directoryOffset, littleEndian);
  if (entryCount === undefined || entryCount > 4_096) return undefined;
  const entriesEnd = directoryOffset + 2 + entryCount * 12;
  if (entriesEnd + 4 > bytes.byteLength || readU32(bytes, entriesEnd, littleEndian) !== 0) return undefined;
  let width: number | undefined;
  let height: number | undefined;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = directoryOffset + 2 + index * 12;
    const tag = readU16(bytes, offset, littleEndian);
    if (tag !== 256 && tag !== 257) continue;
    const type = readU16(bytes, offset + 2, littleEndian);
    const count = readU32(bytes, offset + 4, littleEndian);
    if (count !== 1 || type !== 3 && type !== 4) return undefined;
    const value = type === 3
      ? readU16(bytes, offset + 8, littleEndian)
      : readU32(bytes, offset + 8, littleEndian);
    if (value === undefined || value < 1) return undefined;
    if (tag === 256) width = value;
    else height = value;
  }
  return width === undefined || height === undefined ? undefined : { width, height };
}

function isoImageDimensions(
  bytes: Uint8Array,
  mediaType: "image/avif" | "image/heic" | "image/heif",
  expectedDimensions?: { readonly width: number; readonly height: number }
): { readonly width: number; readonly height: number } | undefined {
  let brands: readonly string[] | undefined;
  const dimensions = new Map<string, { readonly width: number; readonly height: number }>();
  const visit = (start: number, end: number, depth: number): boolean => {
    if (depth > 8) return false;
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) return false;
      const size = readU32(bytes, offset, false);
      const type = ascii(bytes, offset + 4, 4);
      if (size === undefined || size < 8 || offset + size > end) return false;
      const boxEnd = offset + size;
      if (type === "ftyp") {
        if (depth !== 0 || brands || size < 16 || (size - 16) % 4 !== 0) return false;
        const exact = [ascii(bytes, offset + 8, 4)];
        for (let brandOffset = offset + 16; brandOffset < boxEnd; brandOffset += 4) {
          exact.push(ascii(bytes, brandOffset, 4));
        }
        if (exact.some((brand) => !/^[\x20-\x7e]{4}$/u.test(brand))) return false;
        brands = exact;
      } else if (type === "ispe") {
        if (size !== 20) return false;
        const width = readU32(bytes, offset + 12, false);
        const height = readU32(bytes, offset + 16, false);
        if (width === undefined || height === undefined || width < 1 || height < 1) return false;
        dimensions.set(`${width}x${height}`, { width, height });
      } else if (type === "meta" || type === "iprp" || type === "ipco") {
        const childStart = offset + 8 + (type === "meta" ? 4 : 0);
        if (childStart > boxEnd || !visit(childStart, boxEnd, depth + 1)) return false;
      }
      offset = boxEnd;
    }
    return offset === end;
  };
  if (!visit(0, bytes.byteLength, 0) || !brands || dimensions.size === 0) return undefined;
  const exactBrands = new Set(brands);
  const sequenceBrands = ["avis", "hevc", "hevx", "msf1"];
  if (sequenceBrands.some((brand) => exactBrands.has(brand))) return undefined;
  if (mediaType === "image/avif" && !exactBrands.has("avif")) return undefined;
  if (mediaType === "image/heic" && !exactBrands.has("heic") && !exactBrands.has("heix")) return undefined;
  if (mediaType === "image/heif" && !exactBrands.has("mif1")) return undefined;
  if (expectedDimensions) return dimensions.get(`${expectedDimensions.width}x${expectedDimensions.height}`);
  return [...dimensions.values()].sort((left, right) => right.width * right.height - left.width * left.height)[0];
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readU16(bytes: Uint8Array, offset: number, littleEndian: boolean): number | undefined {
  if (offset < 0 || offset + 2 > bytes.byteLength) return undefined;
  return littleEndian
    ? bytes[offset]! + bytes[offset + 1]! * 256
    : bytes[offset]! * 256 + bytes[offset + 1]!;
}

function readU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return littleEndian
    ? (bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65_536
      + bytes[offset + 3]! * 16_777_216) >>> 0
    : bytes[offset]! * 16_777_216 + bytes[offset + 1]! * 65_536
      + bytes[offset + 2]! * 256 + bytes[offset + 3]!;
}

function readI32(bytes: Uint8Array, offset: number, littleEndian: boolean): number | undefined {
  const value = readU32(bytes, offset, littleEndian);
  return value === undefined ? undefined : value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
}
