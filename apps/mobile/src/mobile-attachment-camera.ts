import {
  MOBILE_MAXIMUM_ATTACHMENT_BYTES,
  classifyMobileAttachment,
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

export interface MobileCameraAsset {
  readonly uri?: string | null;
  readonly type?: string | null;
  readonly fileName?: string | null;
  readonly mimeType?: string | null;
  readonly fileSize?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly pairedVideo: boolean;
}

export interface MobileCameraTemporaryFile {
  readonly uri: string;
  cleanup(): Promise<void>;
}

export interface MobileAttachmentCameraDriver {
  isAvailable(): Promise<boolean>;
  requestPermission(): Promise<{ readonly granted: boolean; readonly status?: string }>;
  capture(): Promise<{
    readonly canceled: boolean;
    readonly assets: readonly MobileCameraAsset[];
  }>;
  stat(uri: string): Promise<number>;
  convertToJpeg(uri: string): Promise<MobileCameraTemporaryFile>;
}

export class MobileAttachmentCamera {
  constructor(
    private readonly files: MobileAttachmentFiles,
    private readonly driver: MobileAttachmentCameraDriver = expoMobileAttachmentCameraDriver,
    private readonly now: () => number = Date.now
  ) {}

  async captureAndStage(
    profileId: string,
    current: readonly MobileComposerAttachment[],
    policy: MobileAttachmentPolicy,
    newId: () => string,
    signal?: AbortSignal
  ): Promise<readonly MobileLocalComposerAttachment[]> {
    signal?.throwIfAborted();
    if (!mobileCameraCaptureSupported(policy)) {
      throw new Error("The current Backend and model do not accept camera JPEG images.");
    }
    if (current.length >= policy.maximumItems) {
      throw new Error(`A task message can include at most ${policy.maximumItems} attachments.`);
    }

    let available: boolean;
    try { available = await this.driver.isAvailable(); }
    catch { throw new Error("The device camera availability could not be checked."); }
    signal?.throwIfAborted();
    if (!available) throw new Error("The camera is unavailable on this device.");

    let permission: Awaited<ReturnType<MobileAttachmentCameraDriver["requestPermission"]>>;
    try { permission = await this.driver.requestPermission(); }
    catch { throw new Error("Camera permission could not be requested."); }
    signal?.throwIfAborted();
    if (!permission.granted) {
      throw new Error("Camera permission is required to take a task attachment photo.");
    }

    let captured: Awaited<ReturnType<MobileAttachmentCameraDriver["capture"]>>;
    try { captured = await this.driver.capture(); }
    catch { throw new Error("The device camera could not take a photo."); }
    signal?.throwIfAborted();
    if (captured.canceled) return [];
    if (captured.assets.length !== 1) throw new Error("The camera must return exactly one photo.");
    const asset = captured.assets[0]!;
    if (asset.type !== "image" || asset.pairedVideo) {
      throw new Error("The camera returned media that is not a single still image.");
    }
    assertMobileImageDimensions(asset, "The captured photo");

    const sourceUri = normalizeMobileImageUri(asset.uri, "The camera returned an unreadable photo.");
    const sourceByteSize = await statMobileImageFile(this.driver, sourceUri, "captured photo");
    signal?.throwIfAborted();
    if (asset.fileSize !== undefined && asset.fileSize !== null
      && (!Number.isSafeInteger(asset.fileSize) || asset.fileSize < 0
        || asset.fileSize > 0 && asset.fileSize !== sourceByteSize)) {
      throw new Error("The captured photo changed before it could be staged.");
    }
    if (sourceByteSize > MOBILE_MAXIMUM_ATTACHMENT_BYTES) {
      throw new Error("The captured photo is too large to convert safely on this device.");
    }

    const sourceMediaType = mobileImageMediaType(
      asset.mimeType,
      asset.fileName,
      sourceUri,
      "The camera returned media that is not an image."
    );
    const sourceName = mobileImageFileName(asset.fileName, sourceUri, sourceMediaType, this.now());
    if (sourceMediaType && !mobileRasterMediaTypes.has(sourceMediaType)) {
      throw new Error("The camera returned an unsupported still-image format.");
    }
    if (sourceMediaType && mobileImageMediaTypeAccepted(sourceMediaType, policy)) {
      return this.files.stageCandidates(profileId, current, policy, [{
        uri: sourceUri,
        fileName: normalizeMobileImageFileExtension(sourceName, sourceMediaType),
        mediaType: sourceMediaType,
        byteSize: sourceByteSize
      }], newId, signal);
    }

    let converted: MobileCameraTemporaryFile | undefined;
    try {
      try { converted = await this.driver.convertToJpeg(sourceUri); }
      catch { throw new Error("The captured photo could not be converted to a supported JPEG."); }
      signal?.throwIfAborted();
      const convertedUri = normalizeMobileImageUri(converted.uri, "The converted photo is unreadable.");
      const convertedByteSize = await statMobileImageFile(this.driver, convertedUri, "converted photo");
      signal?.throwIfAborted();
      const candidate: MobilePickedAttachmentCandidate = {
        uri: convertedUri,
        fileName: normalizeMobileImageFileExtension(sourceName, "image/jpeg"),
        mediaType: "image/jpeg",
        byteSize: convertedByteSize
      };
      return await this.files.stageCandidates(profileId, current, policy, [candidate], newId, signal);
    } finally {
      if (converted) await converted.cleanup().catch(() => undefined);
    }
  }
}

export function mobileCameraCaptureSupported(policy: MobileAttachmentPolicy | undefined): boolean {
  if (!policy?.images) return false;
  try { return classifyMobileAttachment("image/jpeg", policy) === "image"; }
  catch { return false; }
}

export function isMobileIosCameraSimulator(platform: string, documentUri: string | undefined): boolean {
  return platform === "ios" && (documentUri ?? "").includes("/CoreSimulator/");
}

const expoMobileAttachmentCameraDriver: MobileAttachmentCameraDriver = {
  async isAvailable() {
    const [{ Platform }, { Paths }] = await Promise.all([
      import("react-native"),
      import("expo-file-system")
    ]);
    return !isMobileIosCameraSimulator(Platform.OS, Paths.document.uri);
  },
  async requestPermission() {
    const { requestCameraPermissionsAsync } = await import("expo-image-picker");
    const permission = await requestCameraPermissionsAsync();
    return { granted: permission.granted, status: permission.status };
  },
  async capture() {
    const { launchCameraAsync } = await import("expo-image-picker");
    const result = await launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
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
        height: asset.height,
        pairedVideo: asset.pairedVideoAsset != null
      }))
    };
  },
  async stat(uri) {
    const { File } = await import("expo-file-system");
    const file = new File(uri);
    if (!file.exists) throw new Error("Camera file missing.");
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
