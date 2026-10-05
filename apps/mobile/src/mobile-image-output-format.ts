import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { assertMobileImageGalleryDimensions, inspectMobileImageGalleryBytes } from "./mobile-image-gallery";
import { inspectMobileBmpBytes, inspectMobileIsoImageBytes, inspectMobileTiffBytes } from "./mobile-image-container";
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
      ? inspectMobileBmpBytes(bytes)
      : mediaType === "image/tiff"
        ? inspectMobileTiffBytes(bytes)
        : inspectMobileIsoImageBytes(bytes, mediaType);
  if (!dimensions || dimensions.originalOnly) throw new Error("The image output signature or dimensions do not match its media type.");
  if ("animated" in dimensions && dimensions.animated === true) {
    throw new Error("Animated images must use original-file sharing rather than static image output.");
  }
  assertMobileImageGalleryDimensions(dimensions.width, dimensions.height);
  if (expectedDimensions
    && (dimensions.width !== expectedDimensions.width || dimensions.height !== expectedDimensions.height)) {
    throw new Error("The image output bytes do not match the native decoder dimensions.");
  }
  return { mediaType, width: dimensions.width, height: dimensions.height };
}
