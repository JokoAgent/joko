export const MOBILE_IMAGE_GALLERY_MAXIMUM_DIMENSION = 16_384;
export const MOBILE_IMAGE_GALLERY_MAXIMUM_PIXELS = 64 * 1_024 * 1_024;

export function assertMobileImageGalleryDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MOBILE_IMAGE_GALLERY_MAXIMUM_DIMENSION || height > MOBILE_IMAGE_GALLERY_MAXIMUM_DIMENSION
    || width * height > MOBILE_IMAGE_GALLERY_MAXIMUM_PIXELS) {
    throw new Error("The gallery image dimensions exceed the safe decode limit.");
  }
}
