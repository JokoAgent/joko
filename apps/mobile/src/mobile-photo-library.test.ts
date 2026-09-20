import { describe, expect, it, vi } from "vitest";
import {
  MobilePhotoLibrary,
  canBrowseMobilePhotoLibraryDirectly,
  mobilePhotoLibrarySupported,
  type MobilePhotoLibraryAsset,
  type MobilePhotoLibraryDriver
} from "./mobile-photo-library";
import {
  MobileAttachmentFiles,
  type MobileAttachmentFileDriver,
  type MobileAttachmentFileSnapshot
} from "./mobile-attachment-files";
import type { MobileAttachmentPolicy } from "./mobile-attachments";

const jpegPolicy: MobileAttachmentPolicy = {
  images: true,
  files: false,
  maximumItems: 3,
  maximumBytes: 16,
  imageMediaTypes: ["image/jpeg"],
  fileMediaTypes: []
};

const catalogAsset = {
  id: "asset-one",
  fileName: "IMG_0001.JPG",
  uri: "ph://asset-one",
  mediaType: "photo",
  width: 1_200,
  height: 900,
  creationTime: 1_000
} as const;

function fixture(input: {
  platform?: string;
  sources?: Readonly<Record<string, Uint8Array>>;
  catalog?: readonly (typeof catalogAsset)[];
} = {}) {
  const sources = input.sources ?? {
    "content://picker/one.jpg": new Uint8Array([1, 2, 3]),
    "file:///library/IMG_0001.JPG": new Uint8Array([1, 2, 3]),
    "file:///library/IMG_0002.HEIC": new Uint8Array([1, 2, 3, 4]),
    "file:///cache/IMG_0002.jpg": new Uint8Array([2, 3, 4])
  };
  const stored = new Map<string, MobileAttachmentFileSnapshot>();
  const key = (profileId: string, attachmentId: string) => `${profileId}/${attachmentId}`;
  const fileDriver: MobileAttachmentFileDriver = {
    pick: vi.fn(async () => ({ canceled: true, files: [] })),
    stage: vi.fn(async (profileId, attachmentId, uri) => {
      const bytes = sources[uri];
      if (!bytes) throw new Error("missing source");
      const value = {
        uri: `file:///durable/${profileId}/${attachmentId}`,
        byteSize: bytes.byteLength,
        bytes: Uint8Array.from(bytes)
      };
      stored.set(key(profileId, attachmentId), value);
      return value;
    }),
    read: vi.fn(async (profileId, attachmentId) => {
      const value = stored.get(key(profileId, attachmentId));
      if (!value) throw new Error("missing staged file");
      return value;
    }),
    remove: vi.fn(async (profileId, attachmentId) => { stored.delete(key(profileId, attachmentId)); }),
    clearProfile: vi.fn(async () => undefined)
  };
  const cleanup = vi.fn(async () => undefined);
  const driver: MobilePhotoLibraryDriver = {
    platform: vi.fn(async () => input.platform ?? "ios"),
    isAvailable: vi.fn(async () => true),
    getPermission: vi.fn(async () => ({ granted: true, canAskAgain: true, accessPrivileges: "all" as const })),
    requestPermission: vi.fn(async () => ({ granted: true, canAskAgain: true, accessPrivileges: "all" as const })),
    list: vi.fn(async () => input.catalog ?? [catalogAsset]),
    resolve: vi.fn(async (assetId) => ({
      ...catalogAsset,
      id: assetId,
      localUri: "file:///library/IMG_0001.JPG"
    })),
    manageLimitedAccess: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
    pickSystem: vi.fn(async () => ({
      canceled: false,
      assets: [{
        uri: "content://picker/one.jpg",
        type: "image",
        fileName: "one.jpeg",
        mimeType: "image/jpeg",
        fileSize: 3,
        width: 800,
        height: 600
      }]
    })),
    stat: vi.fn(async (uri) => {
      const bytes = sources[uri];
      if (!bytes) throw new Error("missing source");
      return bytes.byteLength;
    }),
    convertToJpeg: vi.fn(async () => ({ uri: "file:///cache/IMG_0002.jpg", cleanup }))
  };
  const files = new MobileAttachmentFiles(
    fileDriver,
    async (bytes) => (bytes[0] === 1 ? "a" : "b").repeat(64),
    () => 5_000
  );
  return { cleanup, driver, fileDriver, files, stored };
}

describe("mobile photo library", () => {
  it("uses direct browsing only on iOS and exposes photos only for an admitted raster policy", () => {
    expect(canBrowseMobilePhotoLibraryDirectly("ios")).toBe(true);
    expect(canBrowseMobilePhotoLibraryDirectly("android")).toBe(false);
    expect(mobilePhotoLibrarySupported(jpegPolicy)).toBe(true);
    expect(mobilePhotoLibrarySupported({ ...jpegPolicy, imageMediaTypes: ["image/png"] })).toBe(true);
    expect(mobilePhotoLibrarySupported({ ...jpegPolicy, imageMediaTypes: ["image/svg+xml"] })).toBe(false);
    expect(mobilePhotoLibrarySupported({ ...jpegPolicy, images: false, files: true })).toBe(false);
    expect(mobilePhotoLibrarySupported(undefined)).toBe(false);
  });

  it("never reads or requests broad library permission on Android", async () => {
    const value = fixture({ platform: "android" });
    await expect(new MobilePhotoLibrary(value.files, value.driver).loadCatalog("recent", true))
      .resolves.toEqual({ status: "unavailable", assets: [] });
    expect(value.driver.isAvailable).not.toHaveBeenCalled();
    expect(value.driver.getPermission).not.toHaveBeenCalled();
    expect(value.driver.requestPermission).not.toHaveBeenCalled();
  });

  it("requests iOS permission only for an explicit load and reports denied or limited access", async () => {
    const denied = fixture();
    vi.mocked(denied.driver.getPermission).mockResolvedValue({
      granted: false, canAskAgain: true, accessPrivileges: "none"
    });
    await expect(new MobilePhotoLibrary(denied.files, denied.driver).loadCatalog("recent", false))
      .resolves.toEqual({ status: "denied", canAskAgain: true, assets: [] });
    expect(denied.driver.requestPermission).not.toHaveBeenCalled();

    const limited = fixture();
    vi.mocked(limited.driver.getPermission).mockResolvedValue({
      granted: false, canAskAgain: true, accessPrivileges: "none"
    });
    vi.mocked(limited.driver.requestPermission).mockResolvedValue({
      granted: true, canAskAgain: true, accessPrivileges: "limited"
    });
    await expect(new MobilePhotoLibrary(limited.files, limited.driver).loadCatalog("screenshots", true))
      .resolves.toEqual({
        status: "ready",
        access: "limited",
        assets: [{
          id: "asset-one", fileName: "IMG_0001.JPG", uri: "ph://asset-one",
          width: 1_200, height: 900, creationTime: 1_000
        }]
      });
    expect(limited.driver.requestPermission).toHaveBeenCalledOnce();
    expect(limited.driver.list).toHaveBeenCalledWith("screenshots", 60);
  });

  it("uses the Android system picker with the exact remaining ordered selection limit", async () => {
    const value = fixture({ platform: "android" });
    const current = [{
      state: "uploaded",
      attachmentId: "existing",
      kind: "image",
      fileName: "existing.jpg",
      mediaType: "image/jpeg",
      byteSize: 3,
      sha256Hex: "c".repeat(64),
      capturedAtUnixMs: 10,
      blobId: "blob-existing"
    }] as const;
    const staged = await new MobilePhotoLibrary(value.files, value.driver).pickSystemAndStage(
      "profile-one", current, jpegPolicy, () => "photo-one"
    );

    expect(value.driver.pickSystem).toHaveBeenCalledWith(2);
    expect(value.driver.getPermission).not.toHaveBeenCalled();
    expect(value.driver.requestPermission).not.toHaveBeenCalled();
    expect(value.fileDriver.stage).toHaveBeenCalledWith(
      "profile-one", "photo-one", "content://picker/one.jpg"
    );
    expect(staged).toEqual([{
      state: "local",
      attachmentId: "photo-one",
      kind: "image",
      fileName: "one.jpg",
      mediaType: "image/jpeg",
      byteSize: 3,
      sha256Hex: "a".repeat(64),
      capturedAtUnixMs: 5_000
    }]);
  });

  it("treats system-picker cancellation as no change and refuses that picker on iOS", async () => {
    const canceled = fixture({ platform: "android" });
    vi.mocked(canceled.driver.pickSystem).mockResolvedValue({ canceled: true, assets: [] });
    const newId = vi.fn(() => "unused");
    await expect(new MobilePhotoLibrary(canceled.files, canceled.driver).pickSystemAndStage(
      "profile", [], jpegPolicy, newId
    )).resolves.toEqual([]);
    expect(newId).not.toHaveBeenCalled();

    const ios = fixture();
    await expect(new MobilePhotoLibrary(ios.files, ios.driver).pickSystemAndStage(
      "profile", [], jpegPolicy, newId
    )).rejects.toThrow(/Recent and Screenshots/u);
    expect(ios.driver.pickSystem).not.toHaveBeenCalled();
  });

  it("rejects system-picker over-return and non-image results before reading any bytes", async () => {
    const over = fixture({ platform: "android" });
    vi.mocked(over.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "content://one", type: "image" },
        { uri: "content://two", type: "image" },
        { uri: "content://three", type: "image" }
      ]
    });
    await expect(new MobilePhotoLibrary(over.files, over.driver).pickSystemAndStage(
      "profile",
      [{
        state: "uploaded", attachmentId: "existing", kind: "image", fileName: "existing.jpg",
        mediaType: "image/jpeg", byteSize: 3, sha256Hex: "c".repeat(64), capturedAtUnixMs: 10,
        blobId: "blob-existing"
      }],
      jpegPolicy,
      () => "unused"
    )).rejects.toThrow(/remaining attachment slots/u);
    expect(over.driver.stat).not.toHaveBeenCalled();

    const video = fixture({ platform: "android" });
    vi.mocked(video.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "content://video", type: "video" }]
    });
    await expect(new MobilePhotoLibrary(video.files, video.driver).pickSystemAndStage(
      "profile", [], jpegPolicy, () => "unused"
    )).rejects.toThrow(/not a still image/u);
    expect(video.driver.stat).not.toHaveBeenCalled();
  });

  it("resolves iCloud-backed iOS assets in selection order, converts HEIC, and cleans temporary bytes", async () => {
    const value = fixture();
    const selected: readonly MobilePhotoLibraryAsset[] = [
      {
        id: "asset-one", fileName: "IMG_0001.JPG", uri: "ph://asset-one",
        width: 1_200, height: 900, creationTime: 1_000
      },
      {
        id: "asset-two", fileName: "IMG_0002.HEIC", uri: "ph://asset-two",
        width: 900, height: 1_200, creationTime: 900
      }
    ];
    vi.mocked(value.driver.resolve).mockImplementation(async (assetId) => assetId === "asset-one"
      ? { ...catalogAsset, localUri: "file:///library/IMG_0001.JPG" }
      : {
          ...catalogAsset,
          id: "asset-two",
          fileName: "IMG_0002.HEIC",
          uri: "ph://asset-two",
          localUri: "file:///library/IMG_0002.HEIC",
          width: 900,
          height: 1_200,
          creationTime: 900
        });
    let id = 0;
    const staged = await new MobilePhotoLibrary(value.files, value.driver).stageSelectedAssets(
      "profile", [], jpegPolicy, selected, () => `photo-${++id}`
    );

    expect(value.driver.resolve).toHaveBeenNthCalledWith(1, "asset-one");
    expect(value.driver.resolve).toHaveBeenNthCalledWith(2, "asset-two");
    expect(value.driver.convertToJpeg).toHaveBeenCalledWith("file:///library/IMG_0002.HEIC");
    expect(value.fileDriver.stage).toHaveBeenNthCalledWith(
      1, "profile", "photo-1", "file:///library/IMG_0001.JPG"
    );
    expect(value.fileDriver.stage).toHaveBeenNthCalledWith(
      2, "profile", "photo-2", "file:///cache/IMG_0002.jpg"
    );
    expect(staged.map(({ fileName, mediaType, byteSize }) => ({ fileName, mediaType, byteSize }))).toEqual([
      { fileName: "IMG_0001.jpg", mediaType: "image/jpeg", byteSize: 3 },
      { fileName: "IMG_0002.jpg", mediaType: "image/jpeg", byteSize: 3 }
    ]);
    expect(value.cleanup).toHaveBeenCalledOnce();
  });

  it("fails atomically for missing local assets, identity drift, and iCloud timeout", async () => {
    const selected = [{
      id: "asset-one", fileName: "IMG_0001.JPG", uri: "ph://asset-one",
      width: 1_200, height: 900, creationTime: 1_000
    }] as const;

    const missing = fixture();
    vi.mocked(missing.driver.resolve).mockResolvedValue({ ...catalogAsset, localUri: undefined });
    await expect(new MobilePhotoLibrary(missing.files, missing.driver).stageSelectedAssets(
      "profile", [], jpegPolicy, selected, () => "photo-one"
    )).rejects.toThrow(/readable local photo/u);
    expect(missing.fileDriver.stage).not.toHaveBeenCalled();

    const changed = fixture();
    vi.mocked(changed.driver.resolve).mockResolvedValue({
      ...catalogAsset, id: "different", localUri: "file:///library/IMG_0001.JPG"
    });
    await expect(new MobilePhotoLibrary(changed.files, changed.driver).stageSelectedAssets(
      "profile", [], jpegPolicy, selected, () => "photo-one"
    )).rejects.toThrow(/changed while/u);

    const timed = fixture();
    vi.mocked(timed.driver.resolve).mockReturnValue(new Promise(() => undefined));
    await expect(new MobilePhotoLibrary(timed.files, timed.driver, Date.now, 10).stageSelectedAssets(
      "profile", [], jpegPolicy, selected, () => "photo-one"
    )).rejects.toThrow(/iCloud/u);
    expect(timed.stored.size).toBe(0);
  });

  it("cancels an in-flight iCloud resolution without adopting a late asset", async () => {
    const value = fixture();
    vi.mocked(value.driver.resolve).mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = new MobilePhotoLibrary(value.files, value.driver).stageSelectedAssets(
      "profile",
      [],
      jpegPolicy,
      [{
        id: "asset-one", fileName: "IMG_0001.JPG", uri: "ph://asset-one",
        width: 1_200, height: 900, creationTime: 1_000
      }],
      () => "unused",
      controller.signal
    );
    controller.abort(new Error("Photo selection was cancelled."));

    await expect(pending).rejects.toThrow(/cancelled/u);
    expect(value.fileDriver.stage).not.toHaveBeenCalled();
    expect(value.stored.size).toBe(0);
  });

  it("cleans every staged and converted file when a later ordered photo fails", async () => {
    const value = fixture({ platform: "android" });
    vi.mocked(value.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///library/IMG_0002.HEIC", type: "image", fileName: "IMG_0002.HEIC",
          mimeType: "image/heic", fileSize: 4, width: 900, height: 1_200
        },
        {
          uri: "content://picker/one.jpg", type: "image", fileName: "one.jpg",
          mimeType: "image/jpeg", fileSize: 4, width: 800, height: 600
        }
      ]
    });
    let id = 0;
    await expect(new MobilePhotoLibrary(value.files, value.driver).pickSystemAndStage(
      "profile", [], jpegPolicy, () => `photo-${++id}`
    )).rejects.toThrow(/changed before/u);
    expect(value.cleanup).toHaveBeenCalledOnce();
    expect(value.stored.size).toBe(0);
  });
});
