import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ randomUUID: () => "native-id" }));
vi.mock("expo-modules-core", () => ({ requireNativeModule: vi.fn() }));
vi.mock("react-native", () => ({
  PermissionsAndroid: {
    PERMISSIONS: { WRITE_EXTERNAL_STORAGE: "android.permission.WRITE_EXTERNAL_STORAGE" },
    RESULTS: { GRANTED: "granted", NEVER_ASK_AGAIN: "never_ask_again" },
    request: vi.fn()
  },
  Platform: { OS: "ios", Version: 18 }
}));

import { encodeMobileBase64 } from "./mobile-image-annotation";
import {
  MobileImageOutput,
  type MobileImageOutputDriver,
  type MobileImageOutputSource,
  type MobileImageOutputTemporaryFile
} from "./mobile-image-output";

const temporary: MobileImageOutputTemporaryFile = {
  uri: "file:///cache/joko-image-output/photo-id.png",
  fileName: "photo-id.png"
};

describe("mobile image output", () => {
  it("copies verified PNG bytes to the image clipboard without materializing a file", async () => {
    const driver = createDriver();
    const output = new MobileImageOutput(driver, () => "id");
    const source = pngSource();

    await output.perform("copy", source);

    expect(driver.maintain).toHaveBeenCalledTimes(1);
    expect(driver.copyImage).toHaveBeenCalledWith(encodeMobileBase64(source.bytes));
    expect(driver.writeTemporary).not.toHaveBeenCalled();
  });

  it("requires a verified same-size PNG or JPEG render before copying WebP", async () => {
    const driver = createDriver();
    const output = new MobileImageOutput(driver, () => "id");
    const source = webpSource();

    await expect(output.perform("copy", source)).rejects.toThrow(/rendered as PNG or JPEG/u);
    await expect(output.perform("copy", source, {
      bytes: png(41, 30), mediaType: "image/png", width: 41, height: 30
    })).rejects.toThrow(/source dimensions/u);

    const rendered = png(40, 30);
    await output.perform("copy", source, {
      bytes: rendered, mediaType: "image/png", width: 40, height: 30
    });
    expect(driver.copyImage).toHaveBeenLastCalledWith(encodeMobileBase64(rendered));
  });

  it("removes save materializations on success and on native failure", async () => {
    const driver = createDriver();
    const output = new MobileImageOutput(driver, () => "id");

    await output.perform("save", pngSource());
    expect(driver.writeTemporary).toHaveBeenCalledWith("photo-id.png", "image/png", expect.any(Uint8Array));
    expect(driver.saveImage).toHaveBeenCalledWith(temporary, "image/png");
    expect(driver.removeTemporary).toHaveBeenCalledWith(temporary);

    const failure = createDriver({
      saveImage: vi.fn(async () => { throw new Error("permission denied"); })
    });
    await expect(new MobileImageOutput(failure, () => "id").perform("save", pngSource()))
      .rejects.toThrow(/permission denied/u);
    expect(failure.removeTemporary).toHaveBeenCalledWith(temporary);
  });

  it("checks sharing availability before writing and retains a successful share file for deferred cleanup", async () => {
    const unavailable = createDriver({ sharingAvailable: vi.fn(async () => false) });
    await expect(new MobileImageOutput(unavailable, () => "id").perform("share", pngSource()))
      .rejects.toThrow(/unavailable/u);
    expect(unavailable.writeTemporary).not.toHaveBeenCalled();

    const driver = createDriver();
    await new MobileImageOutput(driver, () => "id").perform("share", pngSource());
    expect(driver.shareImage).toHaveBeenCalledWith(temporary, "image/png");
    expect(driver.removeTemporary).not.toHaveBeenCalled();
  });

  it("permits only one output action at a time", async () => {
    let release: (() => void) | undefined;
    const driver = createDriver({
      copyImage: vi.fn(() => new Promise<void>((resolve) => { release = resolve; }))
    });
    const output = new MobileImageOutput(driver, () => "id");
    const first = output.perform("copy", pngSource());
    await vi.waitFor(() => expect(driver.copyImage).toHaveBeenCalledTimes(1));

    await expect(output.perform("copy", pngSource())).rejects.toThrow(/already in progress/u);
    release?.();
    await first;
  });

  it("fails closed before native output for cancellation, invalid actions, and byte drift", async () => {
    const driver = createDriver();
    const output = new MobileImageOutput(driver, () => "id");
    const controller = new AbortController();
    controller.abort();
    await expect(output.perform("copy", pngSource(), undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
    await expect(output.perform("print" as never, pngSource())).rejects.toThrow(/action is invalid/u);
    await expect(output.perform("copy", { ...pngSource(), bytes: Uint8Array.of(1, 2, 3) }))
      .rejects.toThrow(/source is invalid/u);
    await expect(output.perform("copy", { ...pngSource(), width: 39 }))
      .rejects.toThrow(/decoder dimensions/u);
    expect(driver.copyImage).not.toHaveBeenCalled();
    expect(driver.writeTemporary).not.toHaveBeenCalled();
  });
});

function createDriver(overrides: Partial<MobileImageOutputDriver> = {}): MobileImageOutputDriver & {
  [K in keyof MobileImageOutputDriver]: ReturnType<typeof vi.fn>;
} {
  return {
    maintain: vi.fn(async () => undefined),
    copyImage: vi.fn(async () => undefined),
    writeTemporary: vi.fn(async () => temporary),
    removeTemporary: vi.fn(async () => undefined),
    saveImage: vi.fn(async () => undefined),
    sharingAvailable: vi.fn(async () => true),
    shareImage: vi.fn(async () => undefined),
    ...overrides
  } as MobileImageOutputDriver & {
    [K in keyof MobileImageOutputDriver]: ReturnType<typeof vi.fn>;
  };
}

function pngSource(): MobileImageOutputSource {
  const bytes = png(40, 30);
  return {
    leaseId: "lease",
    fileName: "photo.png",
    mediaType: "image/png",
    byteSize: bytes.byteLength,
    sha256Hex: "a".repeat(64),
    bytes,
    width: 40,
    height: 30
  };
}

function webpSource(): MobileImageOutputSource {
  const bytes = webp(40, 30);
  return {
    ...pngSource(),
    fileName: "photo.webp",
    mediaType: "image/webp",
    byteSize: bytes.byteLength,
    bytes
  };
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  writeU32Be(bytes, 8, 13);
  bytes.set([73, 72, 68, 82], 12);
  writeU32Be(bytes, 16, width);
  writeU32Be(bytes, 20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  writeU32Be(bytes, 33, 0);
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70], 0);
  writeU32Le(bytes, 4, 22);
  bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8);
  writeU32Le(bytes, 16, 10);
  writeU24Le(bytes, 24, width - 1);
  writeU24Le(bytes, 27, height - 1);
  return bytes;
}

function writeU24Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
}

function writeU32Be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24 & 0xff;
  bytes[offset + 1] = value >>> 16 & 0xff;
  bytes[offset + 2] = value >>> 8 & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeU32Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
  bytes[offset + 3] = value >>> 24 & 0xff;
}
