import { sha256 } from "@noble/hashes/sha2.js";
import { randomUUID } from "expo-crypto";
import {
  MOBILE_FILE_SHARE_MAXIMUM_BYTES,
  type AuthorizedBlobDownload
} from "./network";

export type MobileFileSharePhase = "downloading" | "verifying" | "dispatching";

export interface MobileFileShareProgress {
  readonly phase: MobileFileSharePhase;
  readonly bytesCompleted: number;
  readonly totalBytes: number;
}

export interface MobileFileShareTemporaryFile {
  readonly uri: string;
  readonly directoryUri: string;
  readonly fileName: string;
  readonly byteSize: number;
}

export interface MobileFileShareDriver {
  maintain(): Promise<void>;
  sharingAvailable(): Promise<boolean>;
  download(
    source: AuthorizedBlobDownload,
    fileName: string,
    operationId: string,
    onProgress: (bytesCompleted: number) => void,
    signal?: AbortSignal
  ): Promise<MobileFileShareTemporaryFile>;
  verify(
    file: MobileFileShareTemporaryFile,
    maximumBytes: number,
    onProgress: (bytesCompleted: number) => void,
    signal?: AbortSignal
  ): Promise<{ readonly byteSize: number; readonly sha256Hex: string }>;
  remove(file: MobileFileShareTemporaryFile): Promise<void>;
  share(file: MobileFileShareTemporaryFile, mediaType: string): Promise<void>;
}

export interface MobileFileShareRequest {
  readonly source: AuthorizedBlobDownload;
  readonly assertCurrent: () => void | Promise<void>;
  readonly onProgress?: (progress: MobileFileShareProgress) => void;
  readonly onDispatch?: () => void;
  readonly signal?: AbortSignal;
}

export class MobileFileShare {
  private inFlight = false;
  private maintenance?: Promise<void>;

  constructor(
    private readonly driver: MobileFileShareDriver = expoMobileFileShareDriver,
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

  async perform(request: MobileFileShareRequest): Promise<void> {
    request.signal?.throwIfAborted();
    if (this.inFlight) throw new Error("Another file-sharing action is already in progress.");
    const source = normalizeSource(request.source);
    const operationId = safeOperationId(this.newId());
    this.inFlight = true;
    try {
      if (this.maintenance) await this.maintenance;
      await this.driver.maintain();
      request.signal?.throwIfAborted();
      if (!await this.driver.sharingAvailable()) {
        throw new Error("System file sharing is unavailable on this device.");
      }
      request.signal?.throwIfAborted();
      emitProgress(request, "downloading", 0, source.byteSize);
      const file = await this.driver.download(
        source,
        source.fileName,
        operationId,
        (bytesCompleted) => emitProgress(request, "downloading", bytesCompleted, source.byteSize),
        request.signal
      );
      let retainForShare = false;
      try {
        assertTemporaryFile(file, source, operationId);
        request.signal?.throwIfAborted();
        emitProgress(request, "verifying", 0, source.byteSize);
        const verified = await this.driver.verify(
          file,
          source.byteSize,
          (bytesCompleted) => emitProgress(request, "verifying", bytesCompleted, source.byteSize),
          request.signal
        );
        if (verified.byteSize !== source.byteSize || verified.sha256Hex !== source.sha256Hex) {
          throw new Error("The downloaded file failed size or SHA-256 verification.");
        }
        request.signal?.throwIfAborted();
        await request.assertCurrent();
        request.signal?.throwIfAborted();
        emitProgress(request, "dispatching", source.byteSize, source.byteSize);
        request.onDispatch?.();
        await this.driver.share(file, source.mediaType);
        retainForShare = true;
      } finally {
        if (!retainForShare) await this.driver.remove(file);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

function normalizeSource(source: AuthorizedBlobDownload): AuthorizedBlobDownload {
  if (!source || typeof source !== "object" || boundedText(source.blobId, 512) !== source.blobId
    || !safeFileName(source.fileName) || !validMediaType(source.mediaType)
    || !Number.isSafeInteger(source.byteSize) || source.byteSize < 0
    || source.byteSize > MOBILE_FILE_SHARE_MAXIMUM_BYTES
    || !/^[0-9a-f]{64}$/u.test(source.sha256Hex)
    || !authorizedUrl(source.url) || !authorizedHeaders(source.headers)) {
    throw new Error("The authorized file-sharing source is invalid.");
  }
  return {
    ...source,
    fileName: source.fileName.normalize("NFC"),
    mediaType: source.mediaType.trim().toLowerCase(),
    headers: { authorization: source.headers.authorization! }
  };
}

function assertTemporaryFile(
  file: MobileFileShareTemporaryFile,
  source: AuthorizedBlobDownload,
  operationId: string
): void {
  if (!file || typeof file !== "object" || !file.uri || !file.directoryUri
    || file.fileName !== source.fileName || file.byteSize !== source.byteSize
    || !file.directoryUri.endsWith(`/${operationId}`)
    || !file.uri.startsWith(`${file.directoryUri}/`)) {
    throw new Error("The app-owned file-sharing cache identity is invalid.");
  }
}

function emitProgress(
  request: MobileFileShareRequest,
  phase: MobileFileSharePhase,
  bytesCompleted: number,
  totalBytes: number
): void {
  if (!Number.isSafeInteger(bytesCompleted) || bytesCompleted < 0 || bytesCompleted > totalBytes) {
    throw new Error("The file-sharing transfer reported invalid progress.");
  }
  request.onProgress?.({ phase, bytesCompleted, totalBytes });
}

function safeOperationId(value: string): string {
  const exact = boundedText(value, 128);
  if (!exact || !/^[A-Za-z0-9_-]+$/u.test(exact)) {
    throw new Error("The file-sharing cache identity is invalid.");
  }
  return exact;
}

function safeFileName(value: string): boolean {
  const exact = boundedText(value, 512);
  if (!exact || exact !== value || exact === "." || exact === ".."
    || exact.includes("/") || exact.includes("\\")) return false;
  return utf8ByteLength(exact.normalize("NFC")) <= 255;
}

function utf8ByteLength(value: string): number {
  let size = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) return Number.POSITIVE_INFINITY;
      size += 4;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) return Number.POSITIVE_INFINITY;
    else size += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
  }
  return size;
}

function boundedText(value: string, maximum: number): string {
  const exact = typeof value === "string" ? value.trim() : "";
  return exact.length > 0 && exact.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(exact) ? exact : "";
}

function validMediaType(value: string): boolean {
  const exact = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(exact);
}

function authorizedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function authorizedHeaders(value: Readonly<Record<string, string>>): boolean {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1) return false;
  const authorization = value.authorization;
  return typeof authorization === "string" && /^Bearer [^\u0000-\u0020\u007f]+$/u.test(authorization);
}

const FILE_SHARE_ROOT_DIRECTORY = "joko-file-share";
const FILE_SHARE_VERIFY_CHUNK_BYTES = 1024 * 1024;

const expoMobileFileShareDriver: MobileFileShareDriver = {
  async maintain() {
    const { Directory, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.cache, FILE_SHARE_ROOT_DIRECTORY);
    if (directory.exists) directory.delete();
  },
  async sharingAvailable() {
    const Sharing = await import("expo-sharing");
    return Sharing.isAvailableAsync();
  },
  async download(source, fileName, operationId, onProgress, signal) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, FILE_SHARE_ROOT_DIRECTORY);
    root.create({ idempotent: true, intermediates: true });
    const directory = new Directory(root, operationId);
    directory.create();
    const target = new File(directory, fileName);
    let progressError: Error | undefined;
    const progressAbort = new AbortController();
    const transferSignal = signal
      ? AbortSignal.any([signal, progressAbort.signal])
      : progressAbort.signal;
    try {
      const downloaded = await File.downloadFileAsync(source.url, target, {
        headers: { ...source.headers },
        idempotent: false,
        signal: transferSignal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 0 || bytesWritten > source.byteSize
            || totalBytes !== -1 && totalBytes !== source.byteSize) {
            progressError = new Error("The file-sharing download reported invalid progress.");
            progressAbort.abort();
            return;
          }
          onProgress(bytesWritten);
        }
      });
      if (progressError) throw progressError;
      signal?.throwIfAborted();
      if (downloaded.uri !== target.uri || !target.exists || target.size !== source.byteSize) {
        throw new Error("The file-sharing download did not match its authenticated size.");
      }
      onProgress(source.byteSize);
      return {
        uri: target.uri,
        directoryUri: directory.uri.replace(/\/$/u, ""),
        fileName,
        byteSize: target.size
      };
    } catch (error) {
      if (directory.exists) directory.delete();
      if (progressError) throw progressError;
      throw error;
    }
  },
  async verify(temporary, maximumBytes, onProgress, signal) {
    const { Directory, File, FileMode, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, FILE_SHARE_ROOT_DIRECTORY);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    const file = new File(temporary.uri);
    if (!temporary.directoryUri.startsWith(prefix) || !file.uri.startsWith(`${temporary.directoryUri}/`)
      || file.name !== temporary.fileName || !file.exists || file.size !== temporary.byteSize
      || file.size > maximumBytes) {
      throw new Error("The file-sharing verification source is outside its cache lease.");
    }
    const handle = file.open(FileMode.ReadOnly);
    const digest = sha256.create();
    let byteSize = 0;
    try {
      while (byteSize < temporary.byteSize) {
        signal?.throwIfAborted();
        const maximum = Math.min(FILE_SHARE_VERIFY_CHUNK_BYTES, temporary.byteSize - byteSize);
        const chunk = handle.readBytes(maximum);
        if (chunk.byteLength < 1 || chunk.byteLength > maximum) {
          throw new Error("The file-sharing verification source ended unexpectedly.");
        }
        byteSize += chunk.byteLength;
        if (byteSize > maximumBytes) throw new Error("The file-sharing verification source exceeded its byte budget.");
        digest.update(chunk);
        onProgress(byteSize);
      }
    } finally {
      handle.close();
    }
    signal?.throwIfAborted();
    if (!file.exists || file.size !== temporary.byteSize) {
      throw new Error("The file-sharing verification source changed while it was read.");
    }
    return { byteSize, sha256Hex: bytesToHex(digest.digest()) };
  },
  async remove(temporary) {
    const { Directory, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, FILE_SHARE_ROOT_DIRECTORY);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    const directory = new Directory(temporary.directoryUri);
    if (!directory.uri.startsWith(prefix) || directory.uri === root.uri) {
      throw new Error("Refusing to remove a directory outside the file-sharing cache.");
    }
    if (directory.exists) directory.delete();
  },
  async share(file, mediaType) {
    const Sharing = await import("expo-sharing");
    await Sharing.shareAsync(file.uri, { mimeType: mediaType });
  }
};

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export const mobileFileShare = new MobileFileShare();

export const mobileFileShareTesting = {
  rootDirectory: FILE_SHARE_ROOT_DIRECTORY,
  verifyChunkBytes: FILE_SHARE_VERIFY_CHUNK_BYTES
};
