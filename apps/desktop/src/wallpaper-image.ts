import sharp from "sharp";

export const WALLPAPER_MAXIMUM_BYTES = 20 * 1024 * 1024;
export const WALLPAPER_MAXIMUM_DIMENSION = 3840;

export class DesktopWallpaperError extends Error {
  constructor(readonly code: "INVALID_IMAGE" | "REVISION_CONFLICT" | "UNAVAILABLE") {
    super(code === "INVALID_IMAGE" ? "Choose a valid PNG, JPEG or WebP image within the wallpaper limits."
      : code === "REVISION_CONFLICT" ? "The wallpaper settings changed. Refresh before trying again."
        : "The desktop wallpaper operation could not be confirmed.");
    this.name = "DesktopWallpaperError";
  }
}

/** Decode the actual raster, apply orientation, strip metadata and retain one static frame. */
export async function prepareWallpaperImage(bytes: Uint8Array): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }> {
  if (bytes.byteLength === 0 || bytes.byteLength > WALLPAPER_MAXIMUM_BYTES) throw new DesktopWallpaperError("INVALID_IMAGE");
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("Invalid raster format.");
    const result = await image.rotate()
      .resize({ width: WALLPAPER_MAXIMUM_DIMENSION, height: WALLPAPER_MAXIMUM_DIMENSION, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    if (result.data.byteLength === 0 || result.data.byteLength > WALLPAPER_MAXIMUM_BYTES
      || !validDimension(result.info.width) || !validDimension(result.info.height)) throw new Error("Invalid raster result.");
    return Object.freeze({ bytes: new Uint8Array(result.data), width: result.info.width, height: result.info.height });
  } catch { throw new DesktopWallpaperError("INVALID_IMAGE"); }
}

export function validWallpaperImageId(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
export async function assertStoredWallpaperImage(bytes: Uint8Array, width: number, height: number): Promise<void> {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (metadata.format !== "webp" || metadata.width !== width || metadata.height !== height
      || (metadata.pages ?? 1) !== 1 || !validDimension(width) || !validDimension(height)) throw new Error("Invalid stored raster.");
  } catch { throw new DesktopWallpaperError("UNAVAILABLE"); }
}
export function desktopWallpaperImageUrl(id: string): string {
  if (!validWallpaperImageId(id)) throw new DesktopWallpaperError("UNAVAILABLE");
  return `joko-wallpaper://image/${id}.webp`;
}
export function validDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= WALLPAPER_MAXIMUM_DIMENSION;
}
