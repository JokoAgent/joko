import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { normalizeMediaType } from "./workspace-files";

export const MOBILE_MODEL_PREVIEW_MAXIMUM_FILES = 65;
export const MOBILE_MODEL_PREVIEW_MAXIMUM_REFERENCES = 128;

export type MobileModelPreviewKind = "glb" | "gltf";
export type MobileModelResourceKind = "buffer" | "image";

export interface MobileModelReference {
  readonly uri: string;
  readonly path: string;
  readonly kind: MobileModelResourceKind;
  readonly fileIndex: number;
}

export interface MobileModelFileDescriptor {
  readonly path: string;
  readonly mediaType: string;
  readonly byteOffset: number;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

export interface MobileInspectedModelPreview {
  readonly kind: MobileModelPreviewKind;
  readonly mediaType: "model/gltf-binary" | "model/gltf+json";
  readonly modelPath: string;
  readonly references: readonly Omit<MobileModelReference, "fileIndex">[];
}

export interface MobileModelResourceSnapshot {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256Hex: string;
  readonly bytes: Uint8Array;
}

export interface MobileModelPreviewLease {
  readonly leaseId: string;
  readonly profileId: string;
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: "model/gltf-binary" | "model/gltf+json";
  readonly modelKind: MobileModelPreviewKind;
  readonly modelPath: string;
  readonly localByteSize: number;
  readonly packageSha256Hex: string;
  readonly files: readonly MobileModelFileDescriptor[];
  readonly references: readonly MobileModelReference[];
}

export interface MobileModelPreviewFileSnapshot {
  readonly uri: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
}

export interface MobileModelPreviewFileDriver {
  prepare(): Promise<void>;
  write(fileName: string, bytes: Uint8Array): Promise<MobileModelPreviewFileSnapshot>;
  remove(snapshot: Pick<MobileModelPreviewFileSnapshot, "uri" | "fileName">): Promise<void>;
}

type DigestBytes = (bytes: Uint8Array) => Promise<string>;
type LoadResource = (
  path: string,
  kind: MobileModelResourceKind,
  signal?: AbortSignal
) => Promise<MobileModelResourceSnapshot>;

interface MutableGltfResource {
  readonly uri?: unknown;
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BINARY_CHUNK = 0x004e4942;
const unsupportedDecoderExtensions = new Set([
  "KHR_draco_mesh_compression",
  "KHR_texture_basisu"
]);

export class MobileModelPreviewFiles {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: MobileModelPreviewFileDriver = expoMobileModelPreviewFileDriver,
    private readonly digestBytes: DigestBytes = sha256Hex
  ) {}

  async stage(input: {
    readonly profileId: string;
    readonly leaseId: string;
    readonly modelPath: string;
    readonly mediaType: string;
    readonly expectedSha256Hex: string;
    readonly bytes: Uint8Array;
    readonly loadResource?: LoadResource;
    readonly signal?: AbortSignal;
  }): Promise<MobileModelPreviewLease> {
    const profileId = boundedIdentity(input.profileId, "profile");
    const leaseId = boundedIdentity(input.leaseId, "preview lease");
    if (!/^[0-9a-f]{64}$/u.test(input.expectedSha256Hex)) {
      throw new Error("The model preview SHA-256 identity is invalid.");
    }
    const inspected = inspectMobileModelPreviewBytes(input.bytes, input.mediaType, input.modelPath);
    input.signal?.throwIfAborted();
    if (await this.digestBytes(input.bytes) !== input.expectedSha256Hex) {
      throw new Error("The model preview bytes do not match the authenticated SHA-256 identity.");
    }
    const pathKinds = new Map<string, MobileModelResourceKind>();
    for (const reference of inspected.references) {
      const existing = pathKinds.get(reference.path);
      if (existing !== undefined && existing !== reference.kind) {
        throw new Error("The model uses one dependency as incompatible resource kinds.");
      }
      pathKinds.set(reference.path, reference.kind);
    }
    if (pathKinds.size + 1 > MOBILE_MODEL_PREVIEW_MAXIMUM_FILES) {
      throw new Error("The model preview has too many dependency files.");
    }
    if (pathKinds.size > 0 && !input.loadResource) {
      throw new Error("The model's external dependency files are unavailable from this source.");
    }

    const resources = new Map<string, MobileModelResourceSnapshot>();
    let totalBytes = input.bytes.byteLength;
    for (const [path, kind] of pathKinds) {
      input.signal?.throwIfAborted();
      const resource = await input.loadResource!(path, kind, input.signal);
      input.signal?.throwIfAborted();
      assertModelResource(resource, path, kind);
      if (await this.digestBytes(resource.bytes) !== resource.sha256Hex) {
        throw new Error(`The model dependency ${path} failed SHA-256 verification.`);
      }
      totalBytes += resource.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) {
        throw new Error("The model preview and its dependencies exceed the safe mobile preview budget.");
      }
      resources.set(path, resource);
    }

    const ordered = [
      { path: inspected.modelPath, mediaType: inspected.mediaType, sha256Hex: input.expectedSha256Hex, bytes: input.bytes },
      ...[...resources.values()].sort((left, right) => left.path.localeCompare(right.path, "en"))
    ];
    const files: MobileModelFileDescriptor[] = [];
    const fileIndexes = new Map<string, number>();
    let byteOffset = 0;
    for (const [index, file] of ordered.entries()) {
      fileIndexes.set(file.path, index);
      files.push({
        path: file.path,
        mediaType: normalizeMediaType(file.mediaType),
        byteOffset,
        byteSize: file.bytes.byteLength,
        sha256Hex: file.sha256Hex
      });
      byteOffset += file.bytes.byteLength;
    }
    const packageBytes = new Uint8Array(byteOffset);
    for (const [index, file] of ordered.entries()) packageBytes.set(file.bytes, files[index]!.byteOffset);
    const packageSha256Hex = await this.digestBytes(packageBytes);
    const references = inspected.references.map((reference) => ({
      ...reference,
      fileIndex: fileIndexes.get(reference.path) ?? -1
    }));
    if (references.some((reference) => reference.fileIndex < 1)) {
      throw new Error("The model preview dependency manifest is incomplete.");
    }

    const fileName = `preview-${leaseId}.joko-model`;
    return this.#exclusive(async () => {
      input.signal?.throwIfAborted();
      await this.driver.prepare();
      input.signal?.throwIfAborted();
      let snapshot: MobileModelPreviewFileSnapshot | undefined;
      try {
        snapshot = await this.driver.write(fileName, packageBytes);
        input.signal?.throwIfAborted();
        assertSnapshot(snapshot, fileName, packageBytes.byteLength);
        if (!equalBytes(snapshot.bytes, packageBytes)
          || await this.digestBytes(snapshot.bytes) !== packageSha256Hex) {
          throw new Error("The app-owned model preview package failed readback verification.");
        }
        input.signal?.throwIfAborted();
        return {
          leaseId,
          profileId,
          uri: snapshot.uri,
          fileName,
          mediaType: inspected.mediaType,
          modelKind: inspected.kind,
          modelPath: inspected.modelPath,
          localByteSize: packageBytes.byteLength,
          packageSha256Hex,
          files,
          references
        };
      } catch (error) {
        if (snapshot) await this.driver.remove(snapshot).catch(() => undefined);
        throw error;
      }
    });
  }

  async remove(lease: MobileModelPreviewLease): Promise<void> {
    const exact = assertLease(lease);
    await this.#exclusive(() => this.driver.remove(exact));
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

export function mobileModelPreviewKind(
  mediaType: string,
  sourceName: string
): MobileModelPreviewKind | undefined {
  const exactType = normalizeMediaType(mediaType);
  const extension = sourceExtension(sourceName);
  if (exactType === "model/gltf-binary" && extension === "glb") return "glb";
  if (exactType === "model/gltf+json" && extension === "gltf") return "gltf";
  return undefined;
}

export function inspectMobileModelPreviewBytes(
  bytes: Uint8Array,
  mediaType: string,
  modelPath: string
): MobileInspectedModelPreview {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2
    || bytes.byteLength > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) {
    throw new Error("The model preview bytes exceed the safe mobile preview budget.");
  }
  const kind = mobileModelPreviewKind(mediaType, modelPath);
  if (!kind) throw new Error("The model preview requires matching canonical glTF MIME and filename metadata.");
  const exactPath = canonicalModelPath(modelPath);
  const document = kind === "glb" ? parseGlbDocument(bytes) : parseGltfDocument(bytes);
  const references = inspectGltfDocument(document, exactPath);
  return {
    kind,
    mediaType: kind === "glb" ? "model/gltf-binary" : "model/gltf+json",
    modelPath: exactPath,
    references
  };
}

export function resolveMobileModelResourcePath(modelPath: string, uri: string): string | undefined {
  if (typeof uri !== "string" || uri.length < 1 || uri.length > 2_097_152
    || uri.startsWith("/") || uri.startsWith("\\") || uri.startsWith("//")
    || uri.includes("\\") || /[\u0000-\u001f\u007f]/u.test(uri)
    || /^[a-z][a-z\d+.-]*:/iu.test(uri)) return undefined;
  const rawPath = uri.split(/[?#]/u, 1)[0];
  if (!rawPath) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); }
  catch { return undefined; }
  if (!decoded || decoded.startsWith("/") || decoded.includes("\\")
    || /[\u0000-\u001f\u007f:]/u.test(decoded)) return undefined;
  let modelParts: string[];
  try { modelParts = canonicalModelPath(modelPath).split("/"); }
  catch { return undefined; }
  const output = modelParts.slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (output.length === 0) return undefined;
      output.pop();
    } else {
      if (!safePathPart(part)) return undefined;
      output.push(part);
    }
  }
  if (output.length === 0) return undefined;
  const path = output.join("/");
  return path === canonicalModelPath(modelPath) ? undefined : path;
}

function parseGlbDocument(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength < 20) throw new Error("The GLB preview is too small.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error("The GLB header is invalid.");
  }
  let offset = 12;
  let jsonBytes: Uint8Array | undefined;
  let binaryChunks = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("The GLB chunk header is truncated.");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (length < 1 || length % 4 !== 0 || end > bytes.byteLength) {
      throw new Error("The GLB chunk boundary is invalid.");
    }
    if (!jsonBytes) {
      if (type !== GLB_JSON_CHUNK) throw new Error("The GLB JSON chunk must be first.");
      jsonBytes = bytes.subarray(offset + 8, end);
    } else if (type === GLB_BINARY_CHUNK && binaryChunks === 0) {
      binaryChunks += 1;
    } else {
      throw new Error("The GLB contains unsupported or duplicate chunks.");
    }
    offset = end;
  }
  if (!jsonBytes || offset !== bytes.byteLength) throw new Error("The GLB JSON chunk is missing.");
  let end = jsonBytes.byteLength;
  while (end > 0 && jsonBytes[end - 1] === 0x20) end -= 1;
  return parseGltfJson(jsonBytes.subarray(0, end));
}

function parseGltfDocument(bytes: Uint8Array): Record<string, unknown> {
  return parseGltfJson(bytes);
}

function parseGltfJson(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("The glTF JSON is not valid UTF-8."); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("The glTF JSON document is malformed."); }
  if (!isRecord(value)) throw new Error("The glTF root must be an object.");
  const asset = value["asset"];
  if (!isRecord(asset) || asset["version"] !== "2.0") {
    throw new Error("The model preview requires glTF asset version 2.0.");
  }
  return value;
}

function inspectGltfDocument(
  document: Record<string, unknown>,
  modelPath: string
): Omit<MobileModelReference, "fileIndex">[] {
  const required = document["extensionsRequired"];
  if (required !== undefined && (!Array.isArray(required) || required.length > 64
    || required.some((value) => typeof value !== "string" || !value || value.length > 128))) {
    throw new Error("The glTF required-extension declaration is invalid.");
  }
  if ((required as readonly string[] | undefined)?.some((value) => unsupportedDecoderExtensions.has(value))) {
    throw new Error("This model requires a decoder that is unavailable in the offline mobile viewer.");
  }
  const references: Omit<MobileModelReference, "fileIndex">[] = [];
  const byUri = new Map<string, { readonly path: string; readonly kind: MobileModelResourceKind }>();
  inspectResourceArray(document["buffers"], "buffer", modelPath, references, byUri);
  inspectResourceArray(document["images"], "image", modelPath, references, byUri);
  if (references.length > MOBILE_MODEL_PREVIEW_MAXIMUM_REFERENCES) {
    throw new Error("The glTF document contains too many external resource references.");
  }
  return references;
}

function inspectResourceArray(
  value: unknown,
  kind: MobileModelResourceKind,
  modelPath: string,
  output: Omit<MobileModelReference, "fileIndex">[],
  byUri: Map<string, { readonly path: string; readonly kind: MobileModelResourceKind }>
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 16_384) {
    throw new Error(`The glTF ${kind} table is invalid or oversized.`);
  }
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`The glTF ${kind} table contains an invalid entry.`);
    const uri = (item as MutableGltfResource).uri;
    if (uri === undefined) continue;
    if (typeof uri !== "string" || !uri) throw new Error(`The glTF ${kind} URI is invalid.`);
    if (uri.startsWith("data:")) {
      assertDataUri(uri, kind);
      continue;
    }
    if (uri.length > 2_048) throw new Error(`The glTF ${kind} URI is oversized.`);
    const path = resolveMobileModelResourcePath(modelPath, uri);
    if (!path) throw new Error("The model contains an unavailable or unsafe resource reference.");
    const existing = byUri.get(uri);
    if (existing && (existing.path !== path || existing.kind !== kind)) {
      throw new Error("The model reuses one URI with incompatible resource identities.");
    }
    if (existing) continue;
    byUri.set(uri, { path, kind });
    output.push({ uri, path, kind });
  }
}

function assertDataUri(uri: string, kind: MobileModelResourceKind): void {
  const allowed = kind === "buffer"
    ? /^data:application\/(?:octet-stream|gltf-buffer);base64,/u
    : /^data:image\/(?:png|jpeg);base64,/u;
  const match = allowed.exec(uri);
  if (!match) throw new Error(`The embedded glTF ${kind} uses an unsupported data URI type.`);
  const payload = uri.slice(match[0].length);
  const firstPadding = payload.indexOf("=");
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)
    || firstPadding >= 0 && firstPadding < payload.length - 2) {
    throw new Error(`The embedded glTF ${kind} data URI is malformed.`);
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const byteSize = payload.length / 4 * 3 - padding;
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) {
    throw new Error(`The embedded glTF ${kind} data URI exceeds the safe preview budget.`);
  }
  if (kind === "image") {
    const png = byteSize >= 24
      && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        .every((value, index) => base64Byte(payload, index) === value);
    const jpeg = byteSize >= 4 && base64Byte(payload, 0) === 0xff && base64Byte(payload, 1) === 0xd8
      && base64Byte(payload, byteSize - 2) === 0xff && base64Byte(payload, byteSize - 1) === 0xd9;
    const signatureMatches = match[0].startsWith("data:image/png") ? png : jpeg;
    if (!signatureMatches) throw new Error("The embedded glTF image does not match its declared PNG/JPEG type.");
  }
}

function base64Byte(payload: string, byteIndex: number): number {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const groupStart = Math.floor(byteIndex / 3) * 4;
  const first = alphabet.indexOf(payload[groupStart] ?? "");
  const second = alphabet.indexOf(payload[groupStart + 1] ?? "");
  const third = alphabet.indexOf(payload[groupStart + 2] ?? "A");
  const fourth = alphabet.indexOf(payload[groupStart + 3] ?? "A");
  const group = (first << 18) | (second << 12) | (Math.max(third, 0) << 6) | Math.max(fourth, 0);
  const position = byteIndex % 3;
  return position === 0 ? group >>> 16 & 0xff : position === 1 ? group >>> 8 & 0xff : group & 0xff;
}

function assertModelResource(
  resource: MobileModelResourceSnapshot,
  path: string,
  kind: MobileModelResourceKind
): void {
  if (!resource || resource.path !== path || canonicalModelPath(resource.path) !== path
    || !(resource.bytes instanceof Uint8Array) || resource.bytes.byteLength < 1
    || resource.bytes.byteLength > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
    || !/^[0-9a-f]{64}$/u.test(resource.sha256Hex)) {
    throw new Error(`The model dependency ${path} has invalid authenticated metadata.`);
  }
  const mediaType = normalizeMediaType(resource.mediaType);
  if (kind === "buffer") {
    if (mediaType !== "application/octet-stream" && mediaType !== "application/gltf-buffer") {
      throw new Error(`The model buffer ${path} has an unsupported media type.`);
    }
    return;
  }
  if (mediaType === "image/png") {
    if (!isPng(resource.bytes)) throw new Error(`The model image ${path} does not match image/png.`);
    return;
  }
  if (mediaType === "image/jpeg") {
    if (!isJpeg(resource.bytes)) throw new Error(`The model image ${path} does not match image/jpeg.`);
    return;
  }
  throw new Error(`The model image ${path} has an unsupported media type.`);
}

function canonicalModelPath(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024
    || value.startsWith("/") || value.endsWith("/") || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("The model path is invalid.");
  const parts = value.split("/");
  if (parts.some((part) => !safePathPart(part))) throw new Error("The model path is invalid.");
  return parts.join("/");
}

function safePathPart(value: string): boolean {
  return Boolean(value && value !== "." && value !== ".." && value.length <= 255
    && !/[\u0000-\u001f\u007f:]/u.test(value));
}

function sourceExtension(value: string): string {
  let exact: string;
  try { exact = canonicalModelPath(value); }
  catch { return ""; }
  const leaf = exact.split("/").at(-1) ?? "";
  return /\.([A-Za-z0-9]{1,12})$/u.exec(leaf)?.[1]?.toLocaleLowerCase() ?? "";
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 24
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9;
}

function assertSnapshot(snapshot: MobileModelPreviewFileSnapshot, fileName: string, byteSize: number): void {
  if (!snapshot || typeof snapshot !== "object" || snapshot.fileName !== fileName
    || typeof snapshot.uri !== "string" || !snapshot.uri.startsWith("file://")
    || /[\u0000-\u001f\u007f]/u.test(snapshot.uri) || snapshot.uri.length > 4_096
    || snapshot.byteSize !== byteSize || !(snapshot.bytes instanceof Uint8Array)
    || snapshot.bytes.byteLength !== byteSize) {
    throw new Error("The app-owned model preview file snapshot is invalid.");
  }
}

function assertLease(lease: MobileModelPreviewLease): MobileModelPreviewLease {
  if (!lease || lease.fileName !== `preview-${lease.leaseId}.joko-model`
    || !lease.uri.startsWith("file://") || !Number.isSafeInteger(lease.localByteSize)
    || lease.localByteSize < 2 || lease.localByteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
    || !/^[0-9a-f]{64}$/u.test(lease.packageSha256Hex)
    || mobileModelPreviewKind(lease.mediaType, lease.modelPath) !== lease.modelKind
    || lease.files.length < 1 || lease.files.length > MOBILE_MODEL_PREVIEW_MAXIMUM_FILES
    || lease.references.length > MOBILE_MODEL_PREVIEW_MAXIMUM_REFERENCES) {
    throw new Error("The model preview lease is invalid.");
  }
  boundedIdentity(lease.profileId, "profile");
  boundedIdentity(lease.leaseId, "preview lease");
  return lease;
}

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`The ${label} identity is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { CryptoDigestAlgorithm, digest } = await import("expo-crypto");
  const value = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes).buffer));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const MOBILE_MODEL_PREVIEW_ROOT_DIRECTORY = "joko-model-preview";

const expoMobileModelPreviewFileDriver: MobileModelPreviewFileDriver = {
  async prepare() {
    const { Directory, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_MODEL_PREVIEW_ROOT_DIRECTORY);
    if (root.exists) root.delete();
    root.create({ idempotent: true, intermediates: true });
  },
  async write(fileName, bytes) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_MODEL_PREVIEW_ROOT_DIRECTORY);
    root.create({ idempotent: true, intermediates: true });
    const file = new File(root, fileName);
    if (file.exists) throw new Error("The model preview file identity is already in use.");
    try {
      file.create();
      file.write(bytes);
      const written = await file.bytes();
      return { uri: file.uri, fileName, byteSize: file.size, bytes: written };
    } catch (error) {
      if (file.exists) file.delete();
      throw error;
    }
  },
  async remove(snapshot) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_MODEL_PREVIEW_ROOT_DIRECTORY);
    const file = new File(snapshot.uri);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    if (!file.uri.startsWith(prefix) || file.name !== snapshot.fileName) {
      throw new Error("Refusing to remove a file outside the model preview cache.");
    }
    if (file.exists) file.delete();
  }
};

export const mobileModelPreviewFiles = new MobileModelPreviewFiles();

export const mobileModelPreviewTesting = {
  modelPreviewRootDirectory: MOBILE_MODEL_PREVIEW_ROOT_DIRECTORY
};
