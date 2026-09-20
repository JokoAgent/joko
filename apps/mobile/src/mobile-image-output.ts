import { randomUUID } from "expo-crypto";
import { PermissionsAndroid, Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import {
  encodeMobileBase64,
  sniffMobileImageMediaType
} from "./mobile-image-annotation";
import { inspectMobileImageGalleryBytes } from "./mobile-image-gallery";
import {
  inspectMobileImageOutputBytes,
  mobileImageOutputExtension,
  mobileImageOutputMediaType
} from "./mobile-image-output-format";

export type MobileImageOutputAction = "copy" | "save" | "share";

export interface MobileImageOutputSource {
  readonly leaseId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface MobileImageOutputRenderedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
}

export interface MobileImageOutputTemporaryFile {
  readonly uri: string;
  readonly fileName: string;
}

export interface MobileImageOutputDriver {
  maintain(): Promise<void>;
  copyImage(base64: string): Promise<void>;
  writeTemporary(fileName: string, mediaType: string, bytes: Uint8Array): Promise<MobileImageOutputTemporaryFile>;
  removeTemporary(file: MobileImageOutputTemporaryFile): Promise<void>;
  saveImage(file: MobileImageOutputTemporaryFile, mediaType: string): Promise<void>;
  sharingAvailable(): Promise<boolean>;
  shareImage(file: MobileImageOutputTemporaryFile, mediaType: string): Promise<void>;
}

export class MobileImageOutput {
  private inFlight = false;
  private maintenance?: Promise<void>;

  constructor(
    private readonly driver: MobileImageOutputDriver = expoMobileImageOutputDriver,
    private readonly newId: () => string = randomUUID
  ) {}

  async maintain(): Promise<void> {
    if (this.inFlight) return;
    if (!this.maintenance) {
      const maintenance = this.driver.maintain().finally(() => {
        if (this.maintenance === maintenance) this.maintenance = undefined;
      });
      this.maintenance = maintenance;
    }
    await this.maintenance;
  }

  async perform(
    action: MobileImageOutputAction,
    source: MobileImageOutputSource,
    rendered?: MobileImageOutputRenderedImage,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (action !== "copy" && action !== "save" && action !== "share") {
      throw new Error("The image output action is invalid.");
    }
    if (this.inFlight) throw new Error("Another image output action is already in progress.");
    const exactSource = normalizeSource(source);
    const exactRendered = rendered ? normalizeRendered(rendered) : undefined;
    if (exactRendered && (exactRendered.width !== exactSource.width || exactRendered.height !== exactSource.height)) {
      throw new Error("The rendered image output does not match the verified source dimensions.");
    }
    const output = exactRendered ?? exactSource;
    this.inFlight = true;
    try {
      if (this.maintenance) await this.maintenance;
      await this.driver.maintain();
      signal?.throwIfAborted();
      if (action === "copy") {
        if (output.mediaType !== "image/jpeg" && output.mediaType !== "image/png") {
          throw new Error("This image must be rendered as PNG or JPEG before it can be copied.");
        }
        await this.driver.copyImage(encodeMobileBase64(output.bytes));
        return;
      }
      if (action === "share" && !await this.driver.sharingAvailable()) {
        throw new Error("System image sharing is unavailable on this device.");
      }
      signal?.throwIfAborted();
      const fileName = outputFileName(
        rendered ? markedFileName(exactSource.fileName) : exactSource.fileName,
        output.mediaType,
        this.newId()
      );
      const file = await this.driver.writeTemporary(fileName, output.mediaType, output.bytes);
      let retainForShare = false;
      try {
        signal?.throwIfAborted();
        if (action === "save") await this.driver.saveImage(file, output.mediaType);
        else {
          await this.driver.shareImage(file, output.mediaType);
          retainForShare = true;
        }
      } finally {
        if (!retainForShare) await this.driver.removeTemporary(file);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

function normalizeSource(source: MobileImageOutputSource): MobileImageOutputSource {
  if (!source || typeof source !== "object" || !boundedText(source.leaseId, 1_024)
    || !safeFileName(source.fileName) || !/^[0-9a-f]{64}$/u.test(source.sha256Hex)
    || !(source.bytes instanceof Uint8Array) || !Number.isSafeInteger(source.byteSize)
    || source.byteSize < 1 || source.byteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
    || source.bytes.byteLength !== source.byteSize) {
    throw new Error("The verified image output source is invalid.");
  }
  const inspected = inspectMobileImageOutputBytes(source.bytes, source.mediaType, {
    width: source.width,
    height: source.height
  });
  return { ...source, mediaType: inspected.mediaType, bytes: Uint8Array.from(source.bytes) };
}

function normalizeRendered(value: MobileImageOutputRenderedImage): MobileImageOutputRenderedImage {
  if (!value || typeof value !== "object" || !(value.bytes instanceof Uint8Array)
    || value.bytes.byteLength < 1 || value.bytes.byteLength > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
    || value.mediaType !== "image/jpeg" && value.mediaType !== "image/png"
    || sniffMobileImageMediaType(value.bytes) !== value.mediaType) {
    throw new Error("The rendered image output is invalid.");
  }
  const inspected = inspectMobileImageGalleryBytes(value.bytes, value.mediaType);
  if (inspected.width !== value.width || inspected.height !== value.height) {
    throw new Error("The rendered image output dimensions are invalid.");
  }
  return { ...value, bytes: Uint8Array.from(value.bytes) };
}

function outputFileName(fileName: string, mediaType: string, id: string): string {
  const extension = outputExtension(mediaType, fileName);
  const leaf = safeFileName(fileName) || `image.${extension}`;
  const base = leaf.replace(/\.[^.]+$/u, "").replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "").slice(0, 96) || "image";
  const suffix = boundedText(id, 128).replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 64);
  if (!suffix) throw new Error("The image output identity is invalid.");
  return `${base}-${suffix}.${extension}`;
}

function outputExtension(mediaType: string, fileName: string): string {
  const exact = mobileImageOutputMediaType(mediaType);
  if (!exact) throw new Error(`This image type has no safe file extension for native output: ${safeFileName(fileName)}`);
  return mobileImageOutputExtension(exact);
}

function markedFileName(fileName: string): string {
  const leaf = safeFileName(fileName) || "image";
  const base = leaf.replace(/\.[^.]+$/u, "").slice(0, 180) || "image";
  return `${base}-marked.png`;
}

function boundedText(value: string, maximum: number): string {
  const exact = typeof value === "string" ? value.trim() : "";
  return exact.length > 0 && exact.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(exact) ? exact : "";
}

function safeFileName(value: string): string {
  const exact = boundedText(value, 512);
  return exact && !exact.includes("/") && !exact.includes("\\") ? exact : "";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

interface NativeAndroidImageOutput {
  saveImage(localUri: string, fileName: string, mediaType: string): Promise<void>;
}

const outputRootDirectory = "joko-image-output";

const expoMobileImageOutputDriver: MobileImageOutputDriver = {
  async maintain() {
    const { Directory, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.cache, outputRootDirectory);
    if (directory.exists) directory.delete();
  },
  async copyImage(base64) {
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setImageAsync(base64);
  },
  async writeTemporary(fileName, _mediaType, bytes) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.cache, outputRootDirectory);
    directory.create({ idempotent: true, intermediates: true });
    const file = new File(directory, fileName);
    if (file.exists) throw new Error("The image output file identity is already in use.");
    try {
      file.create();
      file.write(bytes);
      const written = await file.bytes();
      if (!equalBytes(bytes, written)) throw new Error("The app-owned image output file failed verification.");
      return { uri: file.uri, fileName };
    } catch (error) {
      if (file.exists) file.delete();
      throw error;
    }
  },
  async removeTemporary(file) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, outputRootDirectory);
    const target = new File(file.uri);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    if (!target.uri.startsWith(prefix)) throw new Error("Refusing to remove a file outside the image output cache.");
    if (target.exists) target.delete();
  },
  async saveImage(file, mediaType) {
    if (Platform.OS === "ios") {
      const MediaLibrary = await import("expo-media-library/legacy");
      if (!await MediaLibrary.isAvailableAsync()) throw new Error("Saving images is unavailable on this device.");
      let permission = await MediaLibrary.getPermissionsAsync(true);
      if (!permission.granted) {
        if (!permission.canAskAgain) throw new Error("Photo-library add access is denied in system Settings.");
        permission = await MediaLibrary.requestPermissionsAsync(true);
      }
      if (!permission.granted) throw new Error("Photo-library add access was not granted.");
      await MediaLibrary.saveToLibraryAsync(file.uri);
      return;
    }
    if (Platform.OS !== "android") throw new Error("Saving images is unavailable on this platform.");
    const version = typeof Platform.Version === "number" ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
    if (Number.isFinite(version) && version <= 28) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
        {
          title: "Save image",
          message: "Allow Joko to save this image to your photo library.",
          buttonPositive: "Allow",
          buttonNegative: "Cancel"
        }
      );
      if (result !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error(result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
          ? "Photo-library write access is denied in system Settings."
          : "Photo-library write access was not granted.");
      }
    }
    const native = requireNativeModule<NativeAndroidImageOutput>("JokoImageOutput");
    await native.saveImage(file.uri, file.fileName, mediaType);
  },
  async sharingAvailable() {
    const Sharing = await import("expo-sharing");
    return Sharing.isAvailableAsync();
  },
  async shareImage(file, mediaType) {
    const Sharing = await import("expo-sharing");
    const UTI = mediaType === "image/jpeg" ? "public.jpeg"
      : mediaType === "image/png" ? "public.png"
        : mediaType === "image/webp" ? "org.webmproject.webp"
          : undefined;
    await Sharing.shareAsync(file.uri, { mimeType: mediaType, ...(UTI ? { UTI } : {}) });
  }
};

export const mobileImageOutput = new MobileImageOutput();

export const mobileImageOutputTesting = {
  outputFileName,
  outputRootDirectory
};
