import {
  MOBILE_MAXIMUM_ATTACHMENT_BYTES,
  type MobileAttachmentPolicy,
  type MobileComposerAttachment,
  type MobileLocalComposerAttachment,
  type MobilePickedAttachmentCandidate
} from "./mobile-attachments";
import { MobileAttachmentFiles } from "./mobile-attachment-files";
import {
  assertMobileImageDimensions,
  mobileImageFileName,
  mobileImageMediaType,
  mobileImageMediaTypeAccepted,
  mobileRasterMediaTypes,
  normalizeMobileImageFileExtension,
  normalizeMobileImageUri,
  statMobileImageFile
} from "./mobile-image-attachment";

export type MobilePhotoLibraryKind = "recent" | "screenshots";
export type MobilePhotoLibraryAccess = "all" | "limited";

export interface MobilePhotoLibraryAsset {
  readonly id: string;
  readonly fileName: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly creationTime: number;
}

export type MobilePhotoLibraryCatalog =
  | {
      readonly status: "ready";
      readonly access: MobilePhotoLibraryAccess;
      readonly assets: readonly MobilePhotoLibraryAsset[];
    }
  | {
      readonly status: "denied";
      readonly canAskAgain: boolean;
      readonly assets: readonly [];
    }
  | {
      readonly status: "unavailable";
      readonly assets: readonly [];
    };

export interface MobilePhotoLibraryPermission {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
  readonly accessPrivileges?: "all" | "limited" | "none";
}

export interface MobilePhotoLibraryNativeAsset {
  readonly id: string;
  readonly fileName: string;
  readonly uri: string;
  readonly mediaType: "photo" | "video" | "audio" | "unknown" | "pairedVideo";
  readonly width: number;
  readonly height: number;
  readonly creationTime: number;
}

export interface MobilePhotoLibraryResolvedAsset extends MobilePhotoLibraryNativeAsset {
  readonly localUri?: string | null;
}

export interface MobileSystemPhotoAsset {
  readonly uri?: string | null;
  readonly type?: string | null;
  readonly fileName?: string | null;
  readonly mimeType?: string | null;
  readonly fileSize?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
}

export interface MobilePhotoLibraryTemporaryFile {
  readonly uri: string;
  cleanup(): Promise<void>;
}

export interface MobilePhotoLibraryDriver {
  platform(): Promise<string>;
  isAvailable(): Promise<boolean>;
  getPermission(): Promise<MobilePhotoLibraryPermission>;
  requestPermission(): Promise<MobilePhotoLibraryPermission>;
  list(kind: MobilePhotoLibraryKind, first: number): Promise<readonly MobilePhotoLibraryNativeAsset[]>;
  resolve(assetId: string): Promise<MobilePhotoLibraryResolvedAsset>;
  manageLimitedAccess(): Promise<void>;
  openSettings(): Promise<void>;
  pickSystem(selectionLimit: number): Promise<{
    readonly canceled: boolean;
    readonly assets: readonly MobileSystemPhotoAsset[];
  }>;
  stat(uri: string): Promise<number>;
  convertToJpeg(uri: string): Promise<MobilePhotoLibraryTemporaryFile>;
}

const catalogLimits: Record<MobilePhotoLibraryKind, number> = { recent: 24, screenshots: 60 };
const DEFAULT_ASSET_RESOLUTION_TIMEOUT_MS = 60_000;

export class MobilePhotoLibrary {
  constructor(
    private readonly files: MobileAttachmentFiles,
    private readonly driver: MobilePhotoLibraryDriver = expoMobilePhotoLibraryDriver,
    private readonly now: () => number = Date.now,
    private readonly assetResolutionTimeoutMs = DEFAULT_ASSET_RESOLUTION_TIMEOUT_MS
  ) {}

  async directlyBrowsable(): Promise<boolean> {
    return canBrowseMobilePhotoLibraryDirectly(await this.driver.platform());
  }

  async loadCatalog(
    kind: MobilePhotoLibraryKind,
    requestPermission: boolean,
    signal?: AbortSignal
  ): Promise<MobilePhotoLibraryCatalog> {
    assertCatalogKind(kind);
    signal?.throwIfAborted();
    if (!await this.directlyBrowsable()) return { status: "unavailable", assets: [] };
    let available: boolean;
    try { available = await this.driver.isAvailable(); }
    catch { throw new Error("Photo library availability could not be checked."); }
    signal?.throwIfAborted();
    if (!available) return { status: "unavailable", assets: [] };

    let permission: MobilePhotoLibraryPermission;
    try { permission = normalizePermission(await this.driver.getPermission()); }
    catch { throw new Error("Photo library permission could not be checked."); }
    signal?.throwIfAborted();
    if (!permission.granted && permission.canAskAgain && requestPermission) {
      try { permission = normalizePermission(await this.driver.requestPermission()); }
      catch { throw new Error("Photo library permission could not be requested."); }
      signal?.throwIfAborted();
    }
    if (!permission.granted) {
      return { status: "denied", canAskAgain: permission.canAskAgain, assets: [] };
    }
    const access = permission.accessPrivileges === "limited" ? "limited" : "all";
    let values: readonly MobilePhotoLibraryNativeAsset[];
    try { values = await this.driver.list(kind, catalogLimits[kind]); }
    catch { throw new Error(`The ${kind === "recent" ? "recent photo" : "screenshot"} library could not be loaded.`); }
    signal?.throwIfAborted();
    return { status: "ready", access, assets: normalizeCatalog(values, catalogLimits[kind]) };
  }

  async manageLimitedAccess(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!await this.directlyBrowsable()) throw new Error("Direct photo-library access is unavailable on this platform.");
    try { await this.driver.manageLimitedAccess(); }
    catch { throw new Error("The system photo-access manager could not be opened."); }
    signal?.throwIfAborted();
  }

  async openSettings(): Promise<void> {
    try { await this.driver.openSettings(); }
    catch { throw new Error("Joko settings could not be opened."); }
  }

  async pickSystemAndStage(
    profileId: string,
    current: readonly MobileComposerAttachment[],
    policy: MobileAttachmentPolicy,
    newId: () => string,
    signal?: AbortSignal
  ): Promise<readonly MobileLocalComposerAttachment[]> {
    signal?.throwIfAborted();
    if (await this.directlyBrowsable()) {
      throw new Error("The iOS photo library must be opened from its Recent and Screenshots surface.");
    }
    const selectionLimit = assertPhotoSelectionAvailable(current, policy);
    let picked: Awaited<ReturnType<MobilePhotoLibraryDriver["pickSystem"]>>;
    try { picked = await this.driver.pickSystem(selectionLimit); }
    catch { throw new Error("The system photo picker could not be opened."); }
    signal?.throwIfAborted();
    if (picked.canceled) return [];
    if (picked.assets.length === 0) throw new Error("The system photo picker returned no photo.");
    if (picked.assets.length > selectionLimit) {
      throw new Error(`The system photo picker returned more than the ${selectionLimit} remaining attachment slots.`);
    }
    const sources = picked.assets.map((asset) => {
      if (asset.type !== "image") throw new Error("The system photo picker returned media that is not a still image.");
      assertMobileImageDimensions(asset, "The selected photo");
      return asset;
    });
    return this.stageImageSources(profileId, current, policy, sources, newId, signal);
  }

  async stageSelectedAssets(
    profileId: string,
    current: readonly MobileComposerAttachment[],
    policy: MobileAttachmentPolicy,
    assets: readonly MobilePhotoLibraryAsset[],
    newId: () => string,
    signal?: AbortSignal
  ): Promise<readonly MobileLocalComposerAttachment[]> {
    signal?.throwIfAborted();
    if (!await this.directlyBrowsable()) {
      throw new Error("Direct photo-library assets are unavailable on this platform.");
    }
    const selectionLimit = assertPhotoSelectionAvailable(current, policy);
    if (assets.length === 0) throw new Error("Select at least one photo to add.");
    if (assets.length > selectionLimit) {
      throw new Error(`Select no more than the ${selectionLimit} remaining attachment slots.`);
    }
    const selected = normalizeSelectedAssets(assets);
    const sources: MobileSystemPhotoAsset[] = [];
    for (const asset of selected) {
      const resolved = await this.resolveWithTimeout(asset.id, signal);
      signal?.throwIfAborted();
      if (resolved.id !== asset.id || resolved.mediaType !== "photo") {
        throw new Error(`${asset.fileName} changed while its photo-library asset was being resolved.`);
      }
      const resolvedName = mobileImageFileName(
        resolved.fileName,
        resolved.localUri ?? resolved.uri,
        undefined,
        this.now()
      );
      if (resolvedName !== asset.fileName) {
        throw new Error(`${asset.fileName} changed while its photo-library asset was being resolved.`);
      }
      assertMobileImageDimensions(resolved, `The selected photo ${asset.fileName}`);
      const localUri = normalizeMobileImageUri(
        resolved.localUri,
        `${asset.fileName} is not available as a readable local photo yet.`
      );
      if (/^ph:\/\//iu.test(localUri)) {
        throw new Error(`${asset.fileName} is not available as a readable local photo yet.`);
      }
      sources.push({
        uri: localUri,
        type: "image",
        fileName: asset.fileName,
        width: resolved.width,
        height: resolved.height
      });
    }
    return this.stageImageSources(profileId, current, policy, sources, newId, signal);
  }

  private async resolveWithTimeout(assetId: string, signal?: AbortSignal): Promise<MobilePhotoLibraryResolvedAsset> {
    const resolved = this.driver.resolve(assetId);
    resolved.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        resolved,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The photo is taking too long to download from iCloud. Try again after it finishes downloading.")),
            this.assetResolutionTimeoutMs
          );
          if (signal) {
            abortListener = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
            if (signal.aborted) abortListener();
            else signal.addEventListener("abort", abortListener, { once: true });
          }
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  private async stageImageSources(
    profileId: string,
    current: readonly MobileComposerAttachment[],
    policy: MobileAttachmentPolicy,
    sources: readonly MobileSystemPhotoAsset[],
    newId: () => string,
    signal?: AbortSignal
  ): Promise<readonly MobileLocalComposerAttachment[]> {
    const candidates: MobilePickedAttachmentCandidate[] = [];
    const temporaryFiles: MobilePhotoLibraryTemporaryFile[] = [];
    try {
      for (const source of sources) {
        signal?.throwIfAborted();
        const sourceUri = normalizeMobileImageUri(source.uri, "The selected photo is unreadable.");
        const sourceByteSize = await statMobileImageFile(this.driver, sourceUri, "selected photo");
        signal?.throwIfAborted();
        if (source.fileSize !== undefined && source.fileSize !== null
          && (!Number.isSafeInteger(source.fileSize) || source.fileSize < 0
            || source.fileSize > 0 && source.fileSize !== sourceByteSize)) {
          throw new Error("The selected photo changed before it could be staged.");
        }
        if (sourceByteSize > MOBILE_MAXIMUM_ATTACHMENT_BYTES) {
          throw new Error("The selected photo is too large to convert safely on this device.");
        }
        const sourceMediaType = mobileImageMediaType(
          source.mimeType,
          source.fileName,
          sourceUri,
          "The photo library returned media that is not an image."
        );
        const sourceName = mobileImageFileName(
          source.fileName,
          sourceUri,
          sourceMediaType,
          this.now()
        );
        if (sourceMediaType && !mobileRasterMediaTypes.has(sourceMediaType)) {
          throw new Error(`${sourceName} is not a supported raster image.`);
        }
        if (sourceMediaType && mobileImageMediaTypeAccepted(sourceMediaType, policy)) {
          candidates.push({
            uri: sourceUri,
            fileName: normalizeMobileImageFileExtension(sourceName, sourceMediaType),
            mediaType: sourceMediaType,
            byteSize: sourceByteSize
          });
          continue;
        }
        if (!mobileImageMediaTypeAccepted("image/jpeg", policy)) {
          throw new Error(`${sourceName} cannot be converted to an image type accepted by this Backend and model.`);
        }
        let converted: MobilePhotoLibraryTemporaryFile;
        try { converted = await this.driver.convertToJpeg(sourceUri); }
        catch { throw new Error(`${sourceName} could not be converted to a supported JPEG.`); }
        temporaryFiles.push(converted);
        signal?.throwIfAborted();
        const convertedUri = normalizeMobileImageUri(converted.uri, "The converted photo is unreadable.");
        const convertedByteSize = await statMobileImageFile(this.driver, convertedUri, "converted photo");
        signal?.throwIfAborted();
        candidates.push({
          uri: convertedUri,
          fileName: normalizeMobileImageFileExtension(sourceName, "image/jpeg"),
          mediaType: "image/jpeg",
          byteSize: convertedByteSize
        });
      }
      return await this.files.stageCandidates(profileId, current, policy, candidates, newId, signal);
    } finally {
      await Promise.all(temporaryFiles.map((file) => file.cleanup().catch(() => undefined)));
    }
  }
}

export function canBrowseMobilePhotoLibraryDirectly(platform: string): boolean {
  return platform === "ios";
}

export function mobilePhotoLibrarySupported(policy: MobileAttachmentPolicy | undefined): boolean {
  if (!policy?.images) return false;
  return [...mobileRasterMediaTypes].some((mediaType) => mobileImageMediaTypeAccepted(mediaType, policy));
}

function assertPhotoSelectionAvailable(
  current: readonly MobileComposerAttachment[],
  policy: MobileAttachmentPolicy
): number {
  if (!mobilePhotoLibrarySupported(policy)) {
    throw new Error("The current Backend and model do not accept supported photo-library images.");
  }
  const remaining = policy.maximumItems - current.length;
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new Error(`A task message can include at most ${policy.maximumItems} attachments.`);
  }
  return remaining;
}

function assertCatalogKind(value: string): asserts value is MobilePhotoLibraryKind {
  if (value !== "recent" && value !== "screenshots") throw new Error("The photo-library collection is invalid.");
}

function normalizePermission(value: MobilePhotoLibraryPermission): MobilePhotoLibraryPermission {
  if (!value || typeof value !== "object" || typeof value.granted !== "boolean"
    || typeof value.canAskAgain !== "boolean"
    || value.accessPrivileges !== undefined
      && value.accessPrivileges !== "all"
      && value.accessPrivileges !== "limited"
      && value.accessPrivileges !== "none") {
    throw new Error("The photo-library permission response is invalid.");
  }
  if (value.granted && value.accessPrivileges === "none") {
    throw new Error("The photo-library permission response is inconsistent.");
  }
  return { ...value };
}

function normalizeCatalog(
  values: readonly MobilePhotoLibraryNativeAsset[],
  maximumItems: number
): readonly MobilePhotoLibraryAsset[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new Error("The photo library returned an invalid asset page.");
  }
  const ids = new Set<string>();
  return values.map((asset) => {
    const normalized = normalizeNativeAsset(asset);
    if (ids.has(normalized.id)) throw new Error("The photo library returned a duplicate asset identity.");
    ids.add(normalized.id);
    return normalized;
  });
}

function normalizeSelectedAssets(values: readonly MobilePhotoLibraryAsset[]): readonly MobilePhotoLibraryAsset[] {
  const ids = new Set<string>();
  return values.map((asset) => {
    const normalized = normalizeNativeAsset({ ...asset, mediaType: "photo" });
    if (ids.has(normalized.id)) throw new Error("The selected photo identity is duplicated.");
    ids.add(normalized.id);
    return normalized;
  });
}

function normalizeNativeAsset(asset: MobilePhotoLibraryNativeAsset): MobilePhotoLibraryAsset {
  if (!asset || typeof asset !== "object" || asset.mediaType !== "photo") {
    throw new Error("The photo library returned media that is not a photo.");
  }
  const id = typeof asset.id === "string" ? asset.id.trim() : "";
  if (!id || id.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new Error("The photo library returned an invalid asset identity.");
  }
  const uri = normalizeMobileImageUri(asset.uri, "The photo library returned an unreadable preview.");
  const fileName = mobileImageFileName(asset.fileName, uri, undefined, asset.creationTime);
  assertMobileImageDimensions(asset, `The photo-library asset ${fileName}`);
  if (!Number.isSafeInteger(asset.creationTime) || asset.creationTime < 0) {
    throw new Error("The photo library returned an invalid creation time.");
  }
  return {
    id,
    fileName,
    uri,
    width: asset.width,
    height: asset.height,
    creationTime: asset.creationTime
  };
}

const expoMobilePhotoLibraryDriver: MobilePhotoLibraryDriver = {
  async platform() {
    const { Platform } = await import("react-native");
    return Platform.OS;
  },
  async isAvailable() {
    const MediaLibrary = await import("expo-media-library/legacy");
    return MediaLibrary.isAvailableAsync();
  },
  async getPermission() {
    const MediaLibrary = await import("expo-media-library/legacy");
    const permission = await MediaLibrary.getPermissionsAsync(false, ["photo"]);
    return {
      granted: permission.granted,
      canAskAgain: permission.canAskAgain,
      accessPrivileges: permission.accessPrivileges
    };
  },
  async requestPermission() {
    const MediaLibrary = await import("expo-media-library/legacy");
    const permission = await MediaLibrary.requestPermissionsAsync(false, ["photo"]);
    return {
      granted: permission.granted,
      canAskAgain: permission.canAskAgain,
      accessPrivileges: permission.accessPrivileges
    };
  },
  async list(kind, first) {
    const MediaLibrary = await import("expo-media-library/legacy");
    const page = await MediaLibrary.getAssetsAsync({
      first,
      mediaType: [MediaLibrary.MediaType.photo],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      ...(kind === "screenshots" ? { mediaSubtypes: ["screenshot" as const] } : {})
    });
    return page.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.filename,
      uri: asset.uri,
      mediaType: asset.mediaType,
      width: asset.width,
      height: asset.height,
      creationTime: asset.creationTime
    }));
  },
  async resolve(assetId) {
    const MediaLibrary = await import("expo-media-library/legacy");
    const asset = await MediaLibrary.getAssetInfoAsync(assetId, { shouldDownloadFromNetwork: true });
    return {
      id: asset.id,
      fileName: asset.filename,
      uri: asset.uri,
      localUri: asset.localUri,
      mediaType: asset.mediaType,
      width: asset.width,
      height: asset.height,
      creationTime: asset.creationTime
    };
  },
  async manageLimitedAccess() {
    const MediaLibrary = await import("expo-media-library/legacy");
    await MediaLibrary.presentPermissionsPickerAsync(["photo"]);
  },
  async openSettings() {
    const { Linking } = await import("react-native");
    await Linking.openSettings();
  },
  async pickSystem(selectionLimit) {
    const { launchImageLibraryAsync } = await import("expo-image-picker");
    const result = await launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit,
      quality: 1,
      exif: false,
      base64: false
    });
    if (result.canceled) return { canceled: true, assets: [] };
    return {
      canceled: false,
      assets: result.assets.map((asset) => ({
        uri: asset.uri,
        type: asset.type,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
        width: asset.width,
        height: asset.height
      }))
    };
  },
  async stat(uri) {
    const { File } = await import("expo-file-system");
    const file = new File(uri);
    if (!file.exists) throw new Error("Photo file missing.");
    return file.size;
  },
  async convertToJpeg(uri) {
    const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
    const context = ImageManipulator.manipulate(uri);
    let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
    try {
      image = await context.renderAsync();
      const saved = await image.saveAsync({ compress: 0.9, format: SaveFormat.JPEG });
      return {
        uri: saved.uri,
        async cleanup() {
          if (saved.uri === uri) return;
          const { File } = await import("expo-file-system");
          const file = new File(saved.uri);
          if (file.exists) file.delete();
        }
      };
    } finally {
      image?.release();
      context.release();
    }
  }
};

export const mobilePhotoLibraryTesting = {
  catalogLimits,
  defaultAssetResolutionTimeoutMs: DEFAULT_ASSET_RESOLUTION_TIMEOUT_MS
};
