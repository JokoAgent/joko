import { describe, expect, it, vi } from "vitest";
import {
  MobileMediaPreviewFiles,
  inspectMobileMediaPreviewBytes,
  mobileMediaPreviewKind,
  type MobileMediaPreviewFileDriver
} from "./mobile-media-preview";

describe("mobile media preview bytes", () => {
  it.each([
    ["movie.mp4", "video/mp4", isoMedia("isom", "vide"), "video", "mp4"],
    ["clip.m4v", "video/x-m4v", isoMedia("M4V ", "vide"), "video", "m4v"],
    ["camera.mov", "video/quicktime", isoMedia("qt  ", "vide"), "video", "mov"],
    ["demo.webm", "video/webm", concat([0x1a, 0x45, 0xdf, 0xa3], "webm\u0000V_VP9"), "video", "webm"],
    ["voice.mp3", "audio/mpeg", new Uint8Array([0xff, 0xfb, 0x90, 0x64]), "audio", "mp3"],
    ["voice.m4a", "audio/mp4", isoMedia("M4A ", "soun"), "audio", "m4a"],
    ["voice.wav", "audio/wav", concat("RIFF", [0, 0, 0, 0], "WAVE"), "audio", "wav"],
    ["voice.aac", "audio/aac", new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0]), "audio", "aac"],
    ["voice.ogg", "audio/ogg", concat("OggS", [0, 0, 0, 0], "OpusHead"), "audio", "ogg"],
    ["voice.flac", "audio/flac", concat("fLaC", [0, 0, 0, 0]), "audio", "flac"]
  ])("accepts a verified %s container", (name, mediaType, bytes, kind, extension) => {
    expect(inspectMobileMediaPreviewBytes(bytes, mediaType, name)).toEqual({
      mediaType,
      mediaKind: kind,
      extension
    });
    expect(mobileMediaPreviewKind(mediaType)).toBe(kind);
  });

  it("rejects unsupported, extension-confused, signature-confused and track-confused inputs", () => {
    expect(() => inspectMobileMediaPreviewBytes(new Uint8Array([1, 2, 3, 4]), "video/avi", "clip.avi"))
      .toThrow(/No safe mobile/u);
    expect(() => inspectMobileMediaPreviewBytes(isoMedia("isom", "vide"), "video/mp4", "clip.mp3"))
      .toThrow(/extension/u);
    expect(() => inspectMobileMediaPreviewBytes(concat("RIFF", [0, 0, 0, 0], "WAVE"), "audio/mpeg", "clip.mp3"))
      .toThrow(/container/u);
    expect(() => inspectMobileMediaPreviewBytes(isoMedia("M4A ", "soun"), "video/mp4", "clip.mp4"))
      .toThrow(/container/u);
    expect(() => inspectMobileMediaPreviewBytes(isoMedia("isom", "vide"), "audio/mp4", "clip.m4a"))
      .toThrow(/container/u);
    expect(() => inspectMobileMediaPreviewBytes(concat([0x1a, 0x45, 0xdf, 0xa3], "webm\u0000A_OPUS"), "video/webm", "clip.webm"))
      .toThrow(/container/u);
  });
});

describe("mobile media preview app cache", () => {
  it("writes a controlled opaque file and verifies exact readback before returning a lease", async () => {
    const bytes = isoMedia("isom", "vide");
    const driver = fixtureDriver();
    const files = new MobileMediaPreviewFiles(driver.value, async () => "a".repeat(64));

    await expect(files.stage(
      "mobile-profile",
      "lease-1",
      "../../forged.mp4",
      "video/mp4",
      "a".repeat(64),
      bytes
    )).resolves.toEqual({
      leaseId: "lease-1",
      profileId: "mobile-profile",
      uri: "file:///cache/preview-lease-1.mp4",
      fileName: "preview-lease-1.mp4",
      mediaType: "video/mp4",
      mediaKind: "video",
      localByteSize: bytes.byteLength,
      sha256Hex: "a".repeat(64)
    });
    expect(driver.value.prepare).toHaveBeenCalledOnce();
    expect(driver.value.write).toHaveBeenCalledWith("preview-lease-1.mp4", bytes);
  });

  it("fails closed and removes a written file on readback mismatch or cancellation", async () => {
    const bytes = isoMedia("isom", "vide");
    const mismatch = fixtureDriver(new Uint8Array(bytes.byteLength));
    const mismatchFiles = new MobileMediaPreviewFiles(mismatch.value, async () => "a".repeat(64));
    await expect(mismatchFiles.stage(
      "mobile-profile", "lease-2", "clip.mp4", "video/mp4", "a".repeat(64), bytes
    )).rejects.toThrow(/readback/u);
    expect(mismatch.value.remove).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const cancelled = fixtureDriver(undefined, () => controller.abort());
    const cancelledFiles = new MobileMediaPreviewFiles(cancelled.value, async () => "a".repeat(64));
    await expect(cancelledFiles.stage(
      "mobile-profile", "lease-3", "clip.mp4", "video/mp4", "a".repeat(64), bytes, controller.signal
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.value.remove).toHaveBeenCalledOnce();
  });

  it("rejects a SHA mismatch before touching cache storage", async () => {
    const driver = fixtureDriver();
    const files = new MobileMediaPreviewFiles(driver.value, async () => "b".repeat(64));
    await expect(files.stage(
      "mobile-profile", "lease-4", "clip.mp4", "video/mp4", "a".repeat(64), isoMedia("isom", "vide")
    )).rejects.toThrow(/SHA-256/u);
    expect(driver.value.prepare).not.toHaveBeenCalled();
    expect(driver.value.write).not.toHaveBeenCalled();
  });
});

function fixtureDriver(readback?: Uint8Array, afterWrite?: () => void): {
  readonly value: MobileMediaPreviewFileDriver;
} {
  return {
    value: {
      prepare: vi.fn(async () => undefined),
      write: vi.fn(async (fileName, bytes) => {
        afterWrite?.();
        const exact = readback ?? Uint8Array.from(bytes);
        return {
          uri: `file:///cache/${fileName}`,
          fileName,
          byteSize: exact.byteLength,
          bytes: exact
        };
      }),
      remove: vi.fn(async () => undefined)
    }
  };
}

function isoMedia(brand: string, handler: "soun" | "vide"): Uint8Array {
  const bytes = new Uint8Array(48);
  writeUint32(bytes, 0, 24);
  writeAscii(bytes, 4, "ftyp");
  writeAscii(bytes, 8, brand);
  writeAscii(bytes, 16, "isom");
  writeUint32(bytes, 24, 24);
  writeAscii(bytes, 28, "hdlr");
  writeAscii(bytes, 40, handler);
  return bytes;
}

function concat(...parts: readonly (string | readonly number[])[]): Uint8Array {
  const values = parts.flatMap((part) => typeof part === "string"
    ? [...part].map((value) => value.charCodeAt(0))
    : [...part]);
  return new Uint8Array(values);
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}
