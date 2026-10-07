import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { animatedPngBytes, bmpBytes, tiffBytes, isoImageBytes } from "./test/image-formats";
import {
  inspectMobileImageOutputBytes,
  mobileImageOutputExtension,
  mobileImageOutputMediaType
} from "./mobile-image-output-format";

describe("mobile image output formats", () => {
  it("rejects animated PNG and WebP from static output even when MIME and canvas dimensions match", async () => {
    expect(() => inspectMobileImageOutputBytes(animatedPngBytes(), "image/png", { width: 1, height: 1 })).toThrow(/Animated/u);
    const moving = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } })
      .webp({ delay: [100, 100], loop: 0 }).toBuffer();
    expect(() => inspectMobileImageOutputBytes(moving, "image/webp", { width: 1, height: 1 })).toThrow(/Animated/u);
  });
  it("verifies bounded single-image BMP and TIFF dimensions", () => {
    expect(inspectMobileImageOutputBytes(bmpBytes(40, 30), "image/bmp"))
      .toEqual({ mediaType: "image/bmp", width: 40, height: 30 });
    expect(inspectMobileImageOutputBytes(tiffBytes(320, 240), "image/tiff"))
      .toEqual({ mediaType: "image/tiff", width: 320, height: 240 });
    expect(() => inspectMobileImageOutputBytes(tiffBytes(320, 240, { additionalPages: 1 }), "image/tiff"))
      .toThrow(/signature or dimensions/u);
    expect(() => inspectMobileImageOutputBytes(bmpBytes(40, 30), "image/tiff"))
      .toThrow(/signature or dimensions/u);
  });

  it("verifies static AVIF, HEIC, and HEIF brands and ispe dimensions", () => {
    expect(inspectMobileImageOutputBytes(isoImageBytes(["avif"], 80, 60), "image/avif"))
      .toEqual({ mediaType: "image/avif", width: 80, height: 60 });
    expect(inspectMobileImageOutputBytes(isoImageBytes(["mif1", "heic"], 90, 70), "image/heic"))
      .toEqual({ mediaType: "image/heic", width: 90, height: 70 });
    expect(inspectMobileImageOutputBytes(isoImageBytes(["mif1"], 100, 75), "image/heif"))
      .toEqual({ mediaType: "image/heif", width: 100, height: 75 });
    expect(() => inspectMobileImageOutputBytes(isoImageBytes(["avif", "avis"], 80, 60), "image/avif"))
      .toThrow(/signature or dimensions/u);
    expect(() => inspectMobileImageOutputBytes(isoImageBytes(["mif1", "hevc"], 90, 70), "image/heif"))
      .toThrow(/signature or dimensions/u);
  });

  it("accepts real pinned-codec AVIF and TIFF output", async () => {
    const input = sharp({ create: { width: 7, height: 5, channels: 3, background: "#ff9800" } });
    const [avif, tiffBytes] = await Promise.all([
      input.clone().avif().toBuffer(),
      input.clone().tiff().toBuffer()
    ]);
    expect(inspectMobileImageOutputBytes(new Uint8Array(avif), "image/avif"))
      .toEqual({ mediaType: "image/avif", width: 7, height: 5 });
    expect(inspectMobileImageOutputBytes(new Uint8Array(tiffBytes), "image/tiff"))
      .toEqual({ mediaType: "image/tiff", width: 7, height: 5 });
  });

  it("refuses thumbnail decoder dimensions and applies the primary image transforms", () => {
    const bytes = isoImageBytes(["avif"], 80, 60, { thumbnail: { width: 200, height: 150 }, crop: { width: 40, height: 30 }, rotate: 1 });
    expect(inspectMobileImageOutputBytes(bytes, "image/avif", { width: 30, height: 40 })).toEqual({ mediaType: "image/avif", width: 30, height: 40 });
    expect(() => inspectMobileImageOutputBytes(bytes, "image/avif", { width: 200, height: 150 })).toThrow(/native decoder dimensions/u);
  });

  it("uses an exact output allowlist and canonical extensions", () => {
    expect(mobileImageOutputMediaType(" IMAGE/HEIC ")).toBe("image/heic");
    expect(mobileImageOutputExtension("image/jpeg")).toBe("jpg");
    expect(mobileImageOutputMediaType("image/gif")).toBeUndefined();
    expect(mobileImageOutputMediaType("image/svg+xml")).toBeUndefined();
    expect(mobileImageOutputMediaType("image/x-icon")).toBeUndefined();
  });
});
