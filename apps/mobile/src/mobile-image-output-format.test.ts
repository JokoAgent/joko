import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  inspectMobileImageOutputBytes,
  mobileImageOutputExtension,
  mobileImageOutputMediaType
} from "./mobile-image-output-format";

describe("mobile image output formats", () => {
  it("verifies bounded single-image BMP and TIFF dimensions", () => {
    expect(inspectMobileImageOutputBytes(bmp(40, 30), "image/bmp"))
      .toEqual({ mediaType: "image/bmp", width: 40, height: 30 });
    expect(inspectMobileImageOutputBytes(tiff(320, 240), "image/tiff"))
      .toEqual({ mediaType: "image/tiff", width: 320, height: 240 });
    expect(() => inspectMobileImageOutputBytes(tiff(320, 240, 48), "image/tiff"))
      .toThrow(/signature or dimensions/u);
    expect(() => inspectMobileImageOutputBytes(bmp(40, 30), "image/tiff"))
      .toThrow(/signature or dimensions/u);
  });

  it("verifies static AVIF, HEIC, and HEIF brands and ispe dimensions", () => {
    expect(inspectMobileImageOutputBytes(isoImage(["avif"], 80, 60), "image/avif"))
      .toEqual({ mediaType: "image/avif", width: 80, height: 60 });
    expect(inspectMobileImageOutputBytes(isoImage(["mif1", "heic"], 90, 70), "image/heic"))
      .toEqual({ mediaType: "image/heic", width: 90, height: 70 });
    expect(inspectMobileImageOutputBytes(isoImage(["mif1"], 100, 75), "image/heif"))
      .toEqual({ mediaType: "image/heif", width: 100, height: 75 });
    expect(() => inspectMobileImageOutputBytes(isoImage(["avif", "avis"], 80, 60), "image/avif"))
      .toThrow(/signature or dimensions/u);
    expect(() => inspectMobileImageOutputBytes(isoImage(["mif1", "hevc"], 90, 70), "image/heif"))
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

  it("uses an exact output allowlist and canonical extensions", () => {
    expect(mobileImageOutputMediaType(" IMAGE/HEIC ")).toBe("image/heic");
    expect(mobileImageOutputExtension("image/jpeg")).toBe("jpg");
    expect(mobileImageOutputMediaType("image/gif")).toBeUndefined();
    expect(mobileImageOutputMediaType("image/svg+xml")).toBeUndefined();
    expect(mobileImageOutputMediaType("image/x-icon")).toBeUndefined();
  });
});

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(58);
  bytes.set([66, 77]);
  writeU32(bytes, 2, bytes.byteLength, true);
  writeU32(bytes, 10, 54, true);
  writeU32(bytes, 14, 40, true);
  writeU32(bytes, 18, width, true);
  writeU32(bytes, 22, height, true);
  writeU16(bytes, 26, 1, true);
  writeU16(bytes, 28, 24, true);
  return bytes;
}

function tiff(width: number, height: number, nextDirectory = 0): Uint8Array {
  const bytes = new Uint8Array(38);
  bytes.set([73, 73, 42, 0]);
  writeU32(bytes, 4, 8, true);
  writeU16(bytes, 8, 2, true);
  writeTiffLongEntry(bytes, 10, 256, width);
  writeTiffLongEntry(bytes, 22, 257, height);
  writeU32(bytes, 34, nextDirectory, true);
  return bytes;
}

function writeTiffLongEntry(bytes: Uint8Array, offset: number, tag: number, value: number): void {
  writeU16(bytes, offset, tag, true);
  writeU16(bytes, offset + 2, 4, true);
  writeU32(bytes, offset + 4, 1, true);
  writeU32(bytes, offset + 8, value, true);
}

function isoImage(brands: readonly string[], width: number, height: number): Uint8Array {
  const major = brands[0] ?? "";
  const ftyp = box("ftyp", concatenate(ascii(major), new Uint8Array(4), ...brands.slice(1).map(ascii)));
  const ispePayload = new Uint8Array(12);
  writeU32(ispePayload, 4, width, false);
  writeU32(ispePayload, 8, height, false);
  const metadata = box("meta", concatenate(new Uint8Array(4), box("iprp", box("ipco", box("ispe", ispePayload)))));
  return concatenate(ftyp, metadata);
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength);
  writeU32(bytes, 0, bytes.byteLength, false);
  bytes.set(ascii(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

function concatenate(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function writeU16(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  bytes[offset + (littleEndian ? 0 : 1)] = value & 0xff;
  bytes[offset + (littleEndian ? 1 : 0)] = value >>> 8 & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + (littleEndian ? index : 3 - index)] = value >>> (index * 8) & 0xff;
  }
}
