import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { prepareWallpaperImage, WALLPAPER_MAXIMUM_BYTES } from "./wallpaper-image.js";

describe("Desktop wallpaper raster", () => {
  it.each(["png", "jpeg", "webp"] as const)("decodes actual %s bytes into a static WebP without enlarging", async format => {
    const source = await sharp({ create: { width: 32, height: 16, channels: 3, background: "#164a7b" } }).toFormat(format).toBuffer();
    const result = await prepareWallpaperImage(source);
    const metadata = await sharp(result.bytes).metadata();
    expect(result).toMatchObject({ width: 32, height: 16 });
    expect(metadata).toMatchObject({ format: "webp", width: 32, height: 16 });
    expect(metadata.pages ?? 1).toBe(1);
  });
  it("applies JPEG orientation and strips embedded metadata", async () => {
    const source = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#7b3216" } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const result = await prepareWallpaperImage(source);
    expect(result).toMatchObject({ width: 20, height: 40 });
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
  });
  it("fits the maximum side to 3840 while retaining aspect", async () => {
    const source = await sharp({ create: { width: 4000, height: 100, channels: 3, background: "#166a7b" } }).png().toBuffer();
    expect(await prepareWallpaperImage(source)).toMatchObject({ width: 3840, height: 96 });
  });
  it("rejects unsupported raster, spoofed SVG, empty and oversized input with finite errors", async () => {
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } }).gif().toBuffer();
    for (const bytes of [gif, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'),
      new Uint8Array(), Buffer.from("not raster bytes"), new Uint8Array(WALLPAPER_MAXIMUM_BYTES + 1)]) {
      await expect(prepareWallpaperImage(bytes)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    }
  });
  it("rejects actual PNG dimensions exceeding the forty megapixel decoder limit", async () => {
    const source = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(source.byteLength).toBeLessThan(WALLPAPER_MAXIMUM_BYTES);
    await expect(prepareWallpaperImage(source)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });
});
