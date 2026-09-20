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
    convertToJpeg: vi.fn(async () => ({ uri: "file:///camera/converted.jpg", cleanup }))
  };
  const files = new MobileAttachmentFiles(
    fileDriver,
    async (bytes) => (bytes[0] === 1 ? "a" : "b").repeat(64),
    () => 5_000
  );
  return { cameraDriver, fileDriver, cleanup, files, stored };
}

describe("mobile camera attachment", () => {
  it("shows camera only when an exact image policy can accept generated JPEG", () => {
    expect(mobileCameraCaptureSupported(jpegPolicy)).toBe(true);
    expect(mobileCameraCaptureSupported({ ...jpegPolicy, imageMediaTypes: [] })).toBe(true);
    expect(mobileCameraCaptureSupported({ ...jpegPolicy, imageMediaTypes: ["image/png"] })).toBe(false);
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
    expect(fixture.cameraDriver.convertToJpeg).not.toHaveBeenCalled();
  });

  it("converts HEIC to an admitted JPEG, stages the converted bytes, and cleans its temporary file", async () => {
    const asset = {
      ...jpegAsset,
      uri: "file:///camera/photo.heic",
      fileName: "IMG_0001.HEIC",
      mimeType: "image/heic",
      fileSize: 4
    };
    const fixture = cameraFixture(asset, {
      "file:///camera/photo.heic": new Uint8Array([1, 2, 3, 4]),
      "file:///camera/converted.jpg": new Uint8Array([2, 3, 4])
    });

    const staged = await new MobileAttachmentCamera(fixture.files, fixture.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    );

    expect(staged[0]).toMatchObject({
      fileName: "IMG_0001.jpg", mediaType: "image/jpeg", byteSize: 3, sha256Hex: "b".repeat(64)
    });
    expect(fixture.cameraDriver.convertToJpeg).toHaveBeenCalledWith("file:///camera/photo.heic");
    expect(fixture.fileDriver.stage).toHaveBeenCalledWith(
      "profile", "photo-one", "file:///camera/converted.jpg"
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
    expect(fixture.cameraDriver.convertToJpeg).not.toHaveBeenCalled();
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

    const vector = cameraFixture({ ...jpegAsset, mimeType: "image/svg+xml" });
    await expect(new MobileAttachmentCamera(vector.files, vector.cameraDriver).captureAndStage(
      "profile", [], jpegPolicy, () => "photo-one"
    )).rejects.toThrow(/unsupported still-image format/u);
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
});
