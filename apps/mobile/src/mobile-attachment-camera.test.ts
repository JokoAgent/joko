import { describe, expect, it, vi } from "vitest";
import {
  MobileAttachmentCamera,
  isMobileIosCameraSimulator,
  mobileCameraCaptureSupported,
  type MobileAttachmentCameraDriver,
  type MobileCameraAsset
} from "./mobile-attachment-camera";
import {
  MobileAttachmentFiles,
  type MobileAttachmentFileDriver,
  type MobileAttachmentFileSnapshot
} from "./mobile-attachment-files";
import type { MobileAttachmentPolicy } from "./mobile-attachments";

const jpegPolicy: MobileAttachmentPolicy = {
  images: true,
  files: false,
  maximumItems: 2,
  maximumBytes: 16,
  imageMediaTypes: ["image/jpeg"],
  fileMediaTypes: []
};

const jpegAsset = {
  uri: "file:///camera/photo.jpeg",
  type: "image",
  fileName: "Camera/photo.jpeg",
  mimeType: "IMAGE/JPEG",
  fileSize: 3,
  width: 800,
  height: 600,
  pairedVideo: false
} satisfies MobileCameraAsset;

function cameraFixture(
  asset: MobileCameraAsset = jpegAsset,
  sources: Readonly<Record<string, Uint8Array>> = {
    "file:///camera/photo.jpeg": new Uint8Array([1, 2, 3])
  }
) {
  const stored = new Map<string, MobileAttachmentFileSnapshot>();
  const fileDriver: MobileAttachmentFileDriver = {
    pick: vi.fn(async () => ({ canceled: true, files: [] })),
    stage: vi.fn(async (profileId, attachmentId, uri) => {
      const bytes = sources[uri];
      if (!bytes) throw new Error("missing source");
      const snapshot = {
        uri: `file:///durable/${profileId}/${attachmentId}`,
        byteSize: bytes.byteLength,
        bytes: Uint8Array.from(bytes)
      };
      stored.set(`${profileId}/${attachmentId}`, snapshot);
      return snapshot;
    }),
    stageBytes: vi.fn(async () => { throw new Error("not used"); }),
    read: vi.fn(async (profileId, attachmentId) => {
      const snapshot = stored.get(`${profileId}/${attachmentId}`);
      if (!snapshot) throw new Error("missing staged file");
      return snapshot;
    }),
    remove: vi.fn(async (profileId, attachmentId) => { stored.delete(`${profileId}/${attachmentId}`); }),
    clearProfile: vi.fn(async () => undefined)
  };
  const cleanup = vi.fn(async () => undefined);
  const cameraDriver: MobileAttachmentCameraDriver = {
    isAvailable: vi.fn(async () => true),
    requestPermission: vi.fn(async () => ({ granted: true, status: "granted" })),
    capture: vi.fn(async () => ({ canceled: false, assets: [asset] })),
    stat: vi.fn(async (uri) => {
      const bytes = sources[uri];
      if (!bytes) throw new Error("missing source");
      return bytes.byteLength;
    }),
    convertImage: vi.fn(async (_uri, mediaType) => ({
      uri: mediaType === "image/png" ? "file:///camera/converted.png" : "file:///camera/converted.jpg",
      cleanup
    }))
  };
  const files = new MobileAttachmentFiles(
    fileDriver,
    async (bytes) => (bytes[0] === 1 ? "a" : "b").repeat(64),
    () => 5_000
  );
  return { cameraDriver, fileDriver, cleanup, files, stored };
}

describe("mobile camera attachment", () => {
  it("shows camera when the exact image policy can accept generated JPEG or PNG", () => {
    expect(mobileCameraCaptureSupported(jpegPolicy)).toBe(true);
    expect(mobileCameraCaptureSupported({ ...jpegPolicy, imageMediaTypes: [] })).toBe(true);
    expect(mobileCameraCaptureSupported({ ...jpegPolicy, imageMediaTypes: ["image/png"] })).toBe(true);
    expect(mobileCameraCaptureSupported({ ...jpegPolicy, imageMediaTypes: ["image/webp"] })).toBe(false);
    expect(mobileCameraCaptureSupported({ ...jpegPolicy, imageMediaTypes: ["image/x-adobe-dng"] })).toBe(false);
    expect(mobileCameraCaptureSupported({ ...jpegPolicy, images: false, files: true })).toBe(false);
    expect(mobileCameraCaptureSupported(undefined)).toBe(false);
  });

  it("blocks the iOS simulator without treating Android emulators or devices as unavailable", () => {
    expect(isMobileIosCameraSimulator("ios", "file:///Users/me/Library/Developer/CoreSimulator/Devices/x/data/"))
      .toBe(true);
    expect(isMobileIosCameraSimulator("ios", "file:///var/mobile/Containers/Data/Application/x/"))
      .toBe(false);
    expect(isMobileIosCameraSimulator("android", "file:///CoreSimulator/fake/"))
      .toBe(false);
  });

  it("does not launch or stage after unavailability, denied permission, or cancellation", async () => {
    const unavailable = cameraFixture();
    vi.mocked(unavailable.cameraDriver.isAvailable).mockResolvedValue(false);
    await expect(new MobileAttachmentCamera(unavailable.files, unavailable.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/unavailable/u);
    expect(unavailable.cameraDriver.requestPermission).not.toHaveBeenCalled();

    const denied = cameraFixture();
    vi.mocked(denied.cameraDriver.requestPermission).mockResolvedValue({ granted: false, status: "limited" });
    await expect(new MobileAttachmentCamera(denied.files, denied.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/permission is required/u);
    expect(denied.cameraDriver.capture).not.toHaveBeenCalled();

    const canceled = cameraFixture();
    vi.mocked(canceled.cameraDriver.capture).mockResolvedValue({ canceled: true, assets: [] });
    const newId = vi.fn(() => "photo-one");
    await expect(new MobileAttachmentCamera(canceled.files, canceled.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, newId
    )).resolves.toEqual([]);
    expect(newId).not.toHaveBeenCalled();
    expect(canceled.fileDriver.stage).not.toHaveBeenCalled();
  });

  it("stages one admitted still image with normalized name, bytes, hash, and exact profile", async () => {
    const fixture = cameraFixture({ ...jpegAsset, fileSize: 0 });
    const camera = new MobileAttachmentCamera(fixture.files, fixture.cameraDriver, () => 7_000);

    await expect(camera.captureAndStage("profile-one", [], jpegPolicy, () => "photo-one")).resolves.toEqual([{
      state: "local",
      attachmentId: "photo-one",
      kind: "image",
      fileName: "photo.jpg",
      mediaType: "image/jpeg",
      byteSize: 3,
      sha256Hex: "a".repeat(64),
      capturedAtUnixMs: 5_000
    }]);

    expect(fixture.fileDriver.stage).toHaveBeenCalledWith(
      "profile-one", "photo-one", "file:///camera/photo.jpeg"
    );
    expect(fixture.cameraDriver.convertImage).not.toHaveBeenCalled();
  });

  it.each([
    { source: "HEIC", sourceExtension: "heic", mimeType: "image/heic" },
    { source: "explicit provider DNG", sourceExtension: "dng", mimeType: "image/x-adobe-dng" },
    { source: "missing-MIME DNG", sourceExtension: "dng", mimeType: undefined }
  ].flatMap((source) => [
    { ...source, accepted: ["image/jpeg", "image/png", "image/x-adobe-dng"], target: "image/jpeg" as const, extension: "jpg" },
    { ...source, accepted: ["image/png", "image/x-adobe-dng"], target: "image/png" as const, extension: "png" }
  ]))("converts $source to $target, stages only converted bytes, and cleans its temporary file", async ({ sourceExtension, mimeType, accepted, target, extension }) => {
    const sourceUri = `file:///camera/photo.${sourceExtension}`;
    const asset = {
      ...jpegAsset,
      uri: sourceUri,
      fileName: `IMG_0001.${sourceExtension.toUpperCase()}`,
      mimeType,
      fileSize: 4
    };
    const fixture = cameraFixture(asset, {
      [sourceUri]: new Uint8Array([1, 2, 3, 4]),
      [`file:///camera/converted.${extension}`]: new Uint8Array([2, 3, 4])
    });

    const staged = await new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], { ...jpegPolicy, imageMediaTypes: accepted }, () => "photo-one"
    );

    expect(staged[0]).toMatchObject({
      fileName: `IMG_0001.${extension}`, mediaType: target, byteSize: 3, sha256Hex: "b".repeat(64)
    });
    expect(fixture.cameraDriver.convertImage).toHaveBeenCalledExactlyOnceWith(sourceUri, target);
    expect(fixture.fileDriver.stage).toHaveBeenCalledWith(
      "profile", "photo-one", `file:///camera/converted.${extension}`
    );
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it("preserves an explicitly admitted HEIC raster without lossy conversion", async () => {
    const asset = {
      ...jpegAsset,
      uri: "file:///camera/photo.heic",
      fileName: "photo.heic",
      mimeType: "image/heic",
      fileSize: 3
    };
    const fixture = cameraFixture(asset, {
      "file:///camera/photo.heic": new Uint8Array([1, 2, 3])
    });
    const policy = { ...jpegPolicy, imageMediaTypes: ["image/jpeg", "image/heic"] };

    const staged = await new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], policy, () => "photo-one"
    );

    expect(staged[0]).toMatchObject({ fileName: "photo.heic", mediaType: "image/heic" });
    expect(fixture.cameraDriver.convertImage).not.toHaveBeenCalled();
  });

  it("rejects non-still, multiple, changed, or malformed camera results before durable adoption", async () => {
    const video = cameraFixture({ ...jpegAsset, type: "video" });
    await expect(new MobileAttachmentCamera(video.files, video.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/not a single still image/u);

    const multiple = cameraFixture();
    vi.mocked(multiple.cameraDriver.capture).mockResolvedValue({
      canceled: false,
      assets: [jpegAsset, { ...jpegAsset, uri: "file:///camera/second.jpg" }]
    });
    await expect(new MobileAttachmentCamera(multiple.files, multiple.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/exactly one/u);

    const changed = cameraFixture({ ...jpegAsset, fileSize: 4 });
    await expect(new MobileAttachmentCamera(changed.files, changed.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/changed before/u);

    const malformed = cameraFixture({ ...jpegAsset, width: 0 });
    await expect(new MobileAttachmentCamera(malformed.files, malformed.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/invalid width/u);
  });

  it.each([
    { source: "explicit SVG", uri: "file:///camera/photo.svg", fileName: "photo.svg", mimeType: "image/svg+xml" },
    { source: "missing-MIME SVG filename", uri: "file:///camera/photo", fileName: "photo.svg", mimeType: undefined },
    { source: "missing-MIME SVG URI", uri: "file:///camera/photo.svg", fileName: undefined, mimeType: undefined },
    { source: "non-image MIME", uri: "file:///camera/photo.pdf", fileName: "photo.pdf", mimeType: "application/pdf" }
  ])("rejects $source before conversion or staging", async ({ uri, fileName, mimeType }) => {
    const fixture = cameraFixture({ ...jpegAsset, uri, fileName, mimeType }, { [uri]: new Uint8Array([1, 2, 3]) });
    const newId = vi.fn(() => "photo-one");
    await expect(new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, newId
    )).rejects.toThrow(/unsupported still-image format|not an image/u);
    expect(fixture.cameraDriver.convertImage).not.toHaveBeenCalled();
    expect(fixture.fileDriver.stage).not.toHaveBeenCalled();
    expect(newId).not.toHaveBeenCalled();
  });

  it("does not request the camera for a provider-only image policy", async () => {
    const fixture = cameraFixture();
    await expect(new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], { ...jpegPolicy, imageMediaTypes: ["image/x-adobe-dng"] }, () => "photo-one"
    )).rejects.toThrow(/do not accept supported camera images/u);
    expect(fixture.cameraDriver.isAvailable).not.toHaveBeenCalled();
    expect(fixture.cameraDriver.requestPermission).not.toHaveBeenCalled();
    expect(fixture.fileDriver.stage).not.toHaveBeenCalled();
  });

  it("cleans conversion output when its final size exceeds policy and normalizes native failures", async () => {
    const asset = {
      ...jpegAsset,
      uri: "file:///camera/photo.heic",
      fileName: "photo.heic",
      mimeType: "image/heic"
    };
    const fixture = cameraFixture(asset, {
      "file:///camera/photo.heic": new Uint8Array([1, 2, 3]),
      "file:///camera/converted.jpg": new Uint8Array(17).fill(2)
    });
    await expect(new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/attachment limit/u);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.stored.size).toBe(0);

    const nativeError = cameraFixture();
    vi.mocked(nativeError.cameraDriver.capture).mockRejectedValue(new Error("native stack detail"));
    await expect(new MobileAttachmentCamera(nativeError.files, nativeError.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow("The device camera could not take a photo.");
    expect(nativeError.fileDriver.stage).not.toHaveBeenCalled();
  });

  it.each([
    { source: "JPEG", uri: "file:///camera/photo.jpeg", fileName: "photo.jpeg", mimeType: "image/jpeg", target: "image/png" as const, extension: "png" },
    { source: "provider DNG", uri: "file:///camera/photo.dng", fileName: "photo.dng", mimeType: "image/x-adobe-dng", target: "image/jpeg" as const, extension: "jpg" },
    { source: "provider DNG", uri: "file:///camera/photo.dng", fileName: "photo.dng", mimeType: "image/x-adobe-dng", target: "image/png" as const, extension: "png" }
  ])("cancels a $source to $target import after conversion and cleans the unused output", async ({ uri, fileName, mimeType, target, extension }) => {
    const outputUri = `file:///camera/converted.${extension}`;
    const fixture = cameraFixture({ ...jpegAsset, uri, fileName, mimeType }, {
      [uri]: new Uint8Array([1, 2, 3]),
      [outputUri]: new Uint8Array([2, 3, 4])
    });
    const controller = new AbortController();
    vi.mocked(fixture.cameraDriver.convertImage).mockImplementation(async () => {
      controller.abort(new Error("Camera import cancelled."));
      return { uri: outputUri, cleanup: fixture.cleanup };
    });

    await expect(new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], { ...jpegPolicy, imageMediaTypes: [target, "image/x-adobe-dng"] }, () => "photo-one", controller.signal
    )).rejects.toThrow(/cancelled/u);
    expect(fixture.cameraDriver.convertImage).toHaveBeenCalledWith(uri, target);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.fileDriver.stage).not.toHaveBeenCalled();
    expect(fixture.stored.size).toBe(0);
  });

  it.each(["image/jpeg", "image/png"] as const)("does not stage provider image bytes when native %s conversion fails", async (target) => {
    const uri = "file:///camera/photo.dng";
    const fixture = cameraFixture({ ...jpegAsset, uri, fileName: "photo.dng", mimeType: "image/x-adobe-dng" }, {
      [uri]: new Uint8Array([1, 2, 3])
    });
    vi.mocked(fixture.cameraDriver.convertImage).mockRejectedValue(new Error("native decoder rejected provider bytes"));
    const newId = vi.fn(() => "photo-one");
    await expect(new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], { ...jpegPolicy, imageMediaTypes: [target, "image/x-adobe-dng"] }, newId
    )).rejects.toThrow("The captured photo could not be converted to a supported image.");
    expect(fixture.cameraDriver.convertImage).toHaveBeenCalledExactlyOnceWith(uri, target);
    expect(fixture.fileDriver.stage).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(newId).not.toHaveBeenCalled();
    expect(fixture.stored.size).toBe(0);
  });
});
