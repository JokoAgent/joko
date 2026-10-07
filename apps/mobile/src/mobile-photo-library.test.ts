import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
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
import { MOBILE_MAXIMUM_ATTACHMENT_BYTES, type MobileAttachmentPolicy } from "./mobile-attachments";

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
    stageBytes: vi.fn(async () => { throw new Error("not used"); }),
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
    convertImage: vi.fn(async (_uri, mediaType) => ({
      uri: mediaType === "image/png" ? "file:///cache/converted.png" : "file:///cache/IMG_0002.jpg",
      cleanup
    }))
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
    expect(mobilePhotoLibrarySupported({ ...jpegPolicy, imageMediaTypes: ["image/avif"] })).toBe(false);
    expect(mobilePhotoLibrarySupported({ ...jpegPolicy, imageMediaTypes: ["image/svg+xml"] })).toBe(false);
    expect(mobilePhotoLibrarySupported({ ...jpegPolicy, imageMediaTypes: ["image/x-adobe-dng"] })).toBe(false);
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
    expect(value.driver.convertImage).toHaveBeenCalledWith("file:///library/IMG_0002.HEIC", "image/jpeg");
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

  it.each([
    ["ios", "JPEG", "image/png", "filename"],
    ["android", "JPEG", "image/png", "MIME"],
    ["ios", "AVIF", "image/png", "filename"],
    ["android", "AVIF", "image/png", "MIME"],
    ["ios", "AVIF", "image/jpeg", "filename"],
    ["android", "AVIF", "image/jpeg", "MIME"],
    ["ios", "DNG", "image/png", "filename"],
    ["ios", "DNG", "image/jpeg", "filename"],
    ["android", "DNG", "image/png", "MIME"],
    ["android", "DNG", "image/jpeg", "MIME"],
    ["android", "DNG", "image/png", "filename"],
    ["android", "DNG", "image/jpeg", "filename"]
  ] as const)("imports %s %s photos through an admitted %s conversion from %s", async (platform, format, targetMediaType, declaration) => {
    // DNG rows verify provider routing and staging with mocks, not native RAW decoding.
    const sourceBytes = format === "AVIF" ? await realAvifBytes() : new Uint8Array([1, 2, 3]);
    const outputBytes = format === "AVIF"
      ? Uint8Array.from(await sharp(sourceBytes).toFormat(targetMediaType === "image/png" ? "png" : "jpeg").toBuffer())
      : new Uint8Array([2, 3, 4, 5]);
    const sourceMediaType = format === "AVIF" ? "image/avif" : format === "DNG" ? "image/x-adobe-dng" : "image/jpeg";
    const sourceExtension = format === "AVIF" ? "avif" : format === "DNG" ? "dng" : "jpg";
    const sourceUri = platform === "android"
      ? `content://picker/one.${sourceExtension}` : `file:///library/IMG_0001.${sourceExtension.toUpperCase()}`;
    const sourceName = platform === "android" ? `one.${sourceExtension}` : `IMG_0001.${sourceExtension.toUpperCase()}`;
    const outputUri = targetMediaType === "image/png" ? "file:///cache/converted.png" : "file:///cache/IMG_0002.jpg";
    const value = fixture({
      platform,
      sources: {
        [sourceUri]: sourceBytes,
        [outputUri]: outputBytes
      }
    });
    vi.mocked(value.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [{ uri: sourceUri, type: "image", fileName: sourceName,
        ...(declaration === "MIME" ? { mimeType: sourceMediaType } : {}),
        fileSize: sourceBytes.byteLength, width: 7, height: 5 }]
    });
    vi.mocked(value.driver.resolve).mockResolvedValue({
      ...catalogAsset, fileName: sourceName, localUri: sourceUri, width: 7, height: 5
    });
    const library = new MobilePhotoLibrary(value.files, value.driver);
    const policy = {
      ...jpegPolicy,
      maximumBytes: 65_536,
      imageMediaTypes: format === "DNG"
        ? [sourceMediaType, targetMediaType, ...(targetMediaType === "image/jpeg" ? ["image/png"] : [])]
        : [targetMediaType]
    };
    const staged = platform === "android"
      ? await library.pickSystemAndStage("profile", [], policy, () => "photo-one")
      : await library.stageSelectedAssets("profile", [], policy,
          [{ ...catalogAsset, fileName: sourceName, width: 7, height: 5 }], () => "photo-one");

    expect(staged[0]).toMatchObject({
      fileName: `${platform === "android" ? "one" : "IMG_0001"}.${targetMediaType === "image/png" ? "png" : "jpg"}`,
      mediaType: targetMediaType,
      byteSize: outputBytes.byteLength,
      sha256Hex: "b".repeat(64)
    });
    expect(value.driver.convertImage).toHaveBeenCalledWith(sourceUri, targetMediaType);
    expect(value.fileDriver.stage).toHaveBeenCalledWith("profile", "photo-one", outputUri);
    expect(value.stored.get("profile/photo-one")?.bytes).toEqual(outputBytes);
    if (format === "AVIF") {
      expect(await sharp(sourceBytes).metadata()).toMatchObject({ width: 7, height: 5, compression: "av1" });
      expect(await sharp(outputBytes).metadata()).toMatchObject({
        format: targetMediaType === "image/png" ? "png" : "jpeg", width: 7, height: 5
      });
    }
    expect(value.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    { imageMediaTypes: ["image/x-adobe-dng"] },
    { imageMediaTypes: ["image/x-adobe-dng", "image/webp"] }
  ])("never adopts provider RAW originals without a JPEG or PNG conversion target: $imageMediaTypes", async ({ imageMediaTypes }) => {
    const value = fixture({ platform: "android" });
    vi.mocked(value.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "content://picker/one.jpg", type: "image", fileName: "one.dng", mimeType: "image/x-adobe-dng" }]
    });
    const policy = { ...jpegPolicy, imageMediaTypes };
    const onlyRaw = imageMediaTypes.length === 1;
    await expect(new MobilePhotoLibrary(value.files, value.driver).pickSystemAndStage(
      "profile", [], policy, () => "unused"
    )).rejects.toThrow(onlyRaw ? /do not accept supported photo-library images/u : /cannot be converted/u);
    expect(value.driver.pickSystem).toHaveBeenCalledTimes(onlyRaw ? 0 : 1);
    expect(value.driver.convertImage).not.toHaveBeenCalled();
    expect(value.fileDriver.stage).not.toHaveBeenCalled();
    expect(value.stored.size).toBe(0);
  });

  it.each([
    { source: "SVG MIME", uri: "content://picker/one.jpg", fileName: "one.jpg", mimeType: "image/svg+xml" },
    { source: "SVG filename", uri: "content://picker/opaque", fileName: "one.SVG" },
    { source: "SVG URI", uri: "content://picker/one.svg?selection=1" },
    { source: "non-image MIME", uri: "content://picker/one.jpg", fileName: "one.jpg", mimeType: "application/pdf" }
  ])("rejects $source before conversion or durable staging", async ({ source, ...asset }) => {
    const value = fixture({ platform: "android", sources: { [asset.uri]: new Uint8Array([1, 2, 3]) } });
    vi.mocked(value.driver.pickSystem).mockResolvedValue({ canceled: false, assets: [{ ...asset, type: "image" }] });
    await expect(new MobilePhotoLibrary(value.files, value.driver).pickSystemAndStage(
      "profile", [], { ...jpegPolicy, imageMediaTypes: ["image/jpeg", "image/svg+xml"] }, () => "unused"
    )).rejects.toThrow(source === "non-image MIME" ? /not an image/u : /not a supported raster/u);
    expect(value.driver.convertImage).not.toHaveBeenCalled();
    expect(value.fileDriver.stage).not.toHaveBeenCalled();
    expect(value.stored.size).toBe(0);
  });

  it.each([
    { source: "changed", byteSize: 4, fileSize: 3 },
    { source: "over budget", byteSize: MOBILE_MAXIMUM_ATTACHMENT_BYTES + 1, fileSize: 0 }
  ])("rejects $source provider RAW bytes before native conversion", async ({ source, byteSize, fileSize }) => {
    const value = fixture({ platform: "android" });
    vi.mocked(value.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "content://picker/one.jpg", type: "image", fileName: "one.dng", mimeType: "image/x-adobe-dng", fileSize }]
    });
    vi.mocked(value.driver.stat).mockResolvedValue(byteSize);
    await expect(new MobilePhotoLibrary(value.files, value.driver).pickSystemAndStage(
      "profile", [], jpegPolicy, () => "unused"
    )).rejects.toThrow(source === "changed" ? /changed before/u : /too large to convert safely/u);
    expect(value.driver.convertImage).not.toHaveBeenCalled();
    expect(value.fileDriver.stage).not.toHaveBeenCalled();
  });

  it.each(["failure", "cancellation"] as const)("cleans prepared provider images on later conversion %s without adopting the batch", async (outcome) => {
    const sourceOne = "content://picker/one.dng";
    const sourceTwo = "content://picker/two.dng";
    const outputUri = "file:///cache/IMG_0002.jpg";
    const value = fixture({ platform: "android", sources: {
      [sourceOne]: new Uint8Array([1, 2, 3]),
      [sourceTwo]: new Uint8Array([1, 2, 3]),
      [outputUri]: new Uint8Array([2, 3, 4])
    } });
    vi.mocked(value.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [sourceOne, sourceTwo].map((uri) => ({ uri, type: "image", mimeType: "image/x-adobe-dng" }))
    });
    const controller = new AbortController();
    vi.mocked(value.driver.convertImage)
      .mockResolvedValueOnce({ uri: outputUri, cleanup: value.cleanup })
      .mockImplementationOnce(async () => {
        if (outcome === "failure") throw new Error("Native decoder rejected these bytes.");
        controller.abort(new Error("Photo import cancelled."));
        return { uri: "file:///cache/second.jpg", cleanup: value.cleanup };
      });
    const newId = vi.fn(() => "unused");
    await expect(new MobilePhotoLibrary(value.files, value.driver).pickSystemAndStage(
      "profile", [], jpegPolicy, newId, controller.signal
    )).rejects.toThrow(outcome === "failure" ? /could not be converted/u : /cancelled/u);
    expect(value.driver.convertImage).toHaveBeenCalledTimes(2);
    expect(value.cleanup).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 2);
    expect(newId).not.toHaveBeenCalled();
    expect(value.fileDriver.stage).not.toHaveBeenCalled();
    expect(value.stored.size).toBe(0);
  });

  it("keeps an admitted PNG original and cleans cancelled conversion output", async () => {
    const sourceBytes = new Uint8Array([1, 2, 3]);
    const sourceMediaType = "image/png";
    const sourceUri = "content://picker/one.png";
    const value = fixture({
      platform: "android",
      sources: {
        [sourceUri]: sourceBytes,
        "content://picker/one.jpg": new Uint8Array([1, 2, 3]),
        "file:///cache/converted.png": new Uint8Array([2, 3, 4])
      }
    });
    vi.mocked(value.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [{ uri: sourceUri, type: "image", fileName: "one.png", mimeType: sourceMediaType }]
    });
    const policy = { ...jpegPolicy, maximumBytes: 65_536, imageMediaTypes: [sourceMediaType] };
    const library = new MobilePhotoLibrary(value.files, value.driver);
    await expect(library.pickSystemAndStage("profile", [], policy, () => "photo-one"))
      .resolves.toMatchObject([{
        fileName: "one.png", mediaType: sourceMediaType,
        byteSize: sourceBytes.byteLength, sha256Hex: "a".repeat(64)
      }]);
    expect(value.driver.convertImage).not.toHaveBeenCalled();
    expect(value.stored.get("profile/photo-one")?.bytes).toEqual(sourceBytes);

    vi.mocked(value.driver.pickSystem).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "content://picker/one.jpg", type: "image", fileName: "one.jpg", mimeType: "image/jpeg" }]
    });
    const controller = new AbortController();
    vi.mocked(value.driver.convertImage).mockImplementation(async () => {
      controller.abort(new Error("Photo import cancelled."));
      return { uri: "file:///cache/converted.png", cleanup: value.cleanup };
    });
    await expect(library.pickSystemAndStage("profile", [], { ...policy, imageMediaTypes: ["image/png"] }, () => "photo-two", controller.signal))
      .rejects.toThrow(/cancelled/u);
    expect(value.cleanup).toHaveBeenCalledOnce();
    expect(value.fileDriver.stage).toHaveBeenCalledTimes(1);
    expect(value.stored.size).toBe(1);
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

async function realAvifBytes(): Promise<Uint8Array> {
  return Uint8Array.from(await sharp({ create: { width: 7, height: 5, channels: 3, background: "#ff9800" } })
    .avif().toBuffer());
}
