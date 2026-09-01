import { createHash } from "node:crypto";
import { extname } from "node:path";

import type { BlobRef, PortableNativeSession } from "@joko/core";
import type { PersistedEvent } from "@joko/store";

import {
  createPortableSessionManifest,
  decodePortableSessionPackage,
  encodePortableSessionPackage,
  type PortableSessionFidelity,
  type PortableSessionPackage,
  type PortableSessionManifest,
  type PortableSessionWorker
} from "./portable-session-package.js";
import {
  collectPortableProjectionBlobRefs,
  decodePortableSessionProjection,
  encodePortableSessionProjection,
  omitUnavailablePortableProjectionBlobs,
  portableProjectionEventPayloads,
  projectPortableSessionMessages,
  rebindPortableProjectionBlobs,
  type PortableSessionProjection
} from "./portable-session-projection.js";

const DEFAULT_TRANSFER_LIMIT_BYTES = 256 * 1024 * 1024;

export interface PortableCollaborationProjection {
  readonly format: 1;
  readonly workers: readonly PortableSessionWorker[];
  readonly detail: readonly unknown[];
}

export interface PortableMediaMapItem {
  readonly sourceId: string;
  readonly path: string;
  readonly blob: BlobRef;
}

export interface PortableMediaMap {
  readonly format: 1;
  readonly items: readonly PortableMediaMapItem[];
}

export interface PreparedPortableSessionImport {
  readonly manifest: PortableSessionManifest;
  readonly projection: PortableSessionProjection;
  readonly nativeSession?: { readonly bytes: Uint8Array; readonly nativeSessionId?: string };
  readonly media: readonly { readonly sourceId: string; readonly blob: BlobRef; readonly bytes: Uint8Array }[];
  readonly collaboration?: PortableCollaborationProjection;
}

export interface MaterializedPortableSessionImport {
  readonly manifest: PortableSessionManifest;
  readonly projection: PortableSessionProjection;
  readonly events: ReturnType<typeof portableProjectionEventPayloads>;
  readonly nativeSession?: PreparedPortableSessionImport["nativeSession"];
  readonly collaboration?: PortableCollaborationProjection;
}

export interface BuildPortableSessionExportInput {
  readonly applicationVersion: string;
  readonly title: string;
  readonly workspaceKind: "dialogue" | "project";
  readonly backendCapability: string;
  readonly events: readonly Pick<PersistedEvent, "emittedAt" | "payload">[];
  readonly nativeSession?: PortableNativeSession;
  readonly workers?: readonly PortableSessionWorker[];
  readonly workerDetail?: readonly unknown[];
  readonly password?: string;
  readonly excludeMedia?: boolean;
  readonly contentLimitBytes?: number;
  readonly readBlob: (blob: BlobRef) => Promise<{ readonly data: Uint8Array; readonly mimeType: string }>;
  readonly exportedAt?: string;
}

export interface PortableSessionExportBuild {
  readonly bytes: Uint8Array;
  readonly fidelity: PortableSessionFidelity;
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly missingMediaCount: number;
  readonly workerCount: number;
  readonly mediaBytes: number;
}

export class PortableSessionExportTooLargeError extends Error {
  constructor(
    readonly totalBytes: number,
    readonly mediaBytes: number,
    readonly limitBytes: number
  ) {
    super(`Portable Session content exceeds the ${limitBytes}-byte export limit.`);
    this.name = "PortableSessionExportTooLargeError";
  }
}

export async function buildPortableSessionExport(
  input: BuildPortableSessionExportInput
): Promise<PortableSessionExportBuild> {
  const limit = normalizeLimit(input.contentLimitBytes);
  const initialProjection = projectPortableSessionMessages(input.events);
  const requestedBlobs = collectPortableProjectionBlobRefs(initialProjection);
  const availableIds = new Set<string>();
  const mediaEntries: PortableSessionPackage["entries"][number][] = [];
  const mediaMapItems: PortableMediaMapItem[] = [];
  let mediaBytes = 0;

  if (input.excludeMedia !== true) {
    let index = 0;
    for (const [sourceId, blob] of requestedBlobs) {
      try {
        const resolved = await input.readBlob(blob);
        if (resolved.data.byteLength !== blob.byteLength || resolved.mimeType !== blob.mimeType
          || sha256(resolved.data) !== blob.sha256) continue;
        mediaBytes += resolved.data.byteLength;
        if (mediaBytes > limit) throw new PortableSessionExportTooLargeError(mediaBytes, mediaBytes, limit);
        const suffix = safeSuffix(blob.fileName);
        const path = `media/${String(index).padStart(6, "0")}-${blob.sha256}${suffix}`;
        mediaEntries.push({
          path,
          kind: "artifact",
          mediaType: blob.mimeType,
          bytes: resolved.data
        });
        mediaMapItems.push({ sourceId, path, blob });
        availableIds.add(sourceId);
        index += 1;
      } catch (error) {
        if (error instanceof PortableSessionExportTooLargeError) throw error;
        // A stale or missing attachment lowers fidelity without discarding the
        // surrounding message, matching point-in-time export semantics.
      }
    }
  }

  const projection = omitUnavailablePortableProjectionBlobs(initialProjection, availableIds);
  const projectionBytes = encodePortableSessionProjection(projection);
  const missingMediaCount = requestedBlobs.size - availableIds.size;
  const workers = [...(input.workers ?? [])];
  const entries: PortableSessionPackage["entries"][number][] = [{
    path: "projection/messages.json",
    kind: "projection",
    mediaType: "application/json",
    bytes: projectionBytes
  }];
  let nonMediaBytes = projectionBytes.byteLength;
  if (input.nativeSession !== undefined) {
    if (sha256(input.nativeSession.bytes) !== input.nativeSession.sha256) {
      throw new Error("Portable native Session digest does not match its bytes.");
    }
    entries.push({
      path: "native/main.jsonl",
      kind: "native_history",
      mediaType: "application/x-ndjson",
      bytes: input.nativeSession.bytes
    });
    nonMediaBytes += input.nativeSession.bytes.byteLength;
  }
  if (mediaMapItems.length > 0) {
    const mediaMapBytes = Buffer.from(JSON.stringify({ format: 1, items: mediaMapItems } satisfies PortableMediaMap), "utf8");
    entries.push({
      path: "projection/media-map.json",
      kind: "projection",
      mediaType: "application/json",
      bytes: mediaMapBytes
    });
    nonMediaBytes += mediaMapBytes.byteLength;
  }
  if (workers.length > 0) {
    const collaborationBytes = Buffer.from(JSON.stringify({
      format: 1,
      workers,
      detail: [...(input.workerDetail ?? [])]
    } satisfies PortableCollaborationProjection), "utf8");
    entries.push({
      path: "collaboration/workers.json",
      kind: "collaboration",
      mediaType: "application/json",
      bytes: collaborationBytes
    });
    nonMediaBytes += collaborationBytes.byteLength;
  }
  if (nonMediaBytes + mediaBytes > limit) {
    throw new PortableSessionExportTooLargeError(nonMediaBytes + mediaBytes, mediaBytes, limit);
  }
  entries.push(...mediaEntries);

  const fidelity: PortableSessionFidelity = input.nativeSession === undefined
    ? "product_only"
    : missingMediaCount > 0 || workers.length > 0
      ? "partial"
      : "full";
  const manifest = createPortableSessionManifest({
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    applicationVersion: input.applicationVersion,
    title: input.title,
    workspaceKind: input.workspaceKind,
    backendCapability: input.backendCapability,
    fidelity,
    messageCount: projection.messages.length,
    mediaCount: mediaEntries.length,
    ...(input.nativeSession === undefined ? {} : { nativeHistoryEntry: "native/main.jsonl" }),
    ...(workers.length === 0 ? {} : { workers })
  });
  const bytes = encodePortableSessionPackage({ manifest, entries }, {
    ...(input.password === undefined ? {} : { password: input.password }),
    contentLimitBytes: limit
  });
  if (bytes.byteLength > limit) throw new PortableSessionExportTooLargeError(bytes.byteLength, mediaBytes, limit);
  return {
    bytes,
    fidelity,
    messageCount: projection.messages.length,
    mediaCount: mediaEntries.length,
    missingMediaCount,
    workerCount: workers.length,
    mediaBytes
  };
}

export function preparePortableSessionImport(
  bytes: Uint8Array,
  options: { readonly password?: string; readonly contentLimitBytes?: number } = {}
): PreparedPortableSessionImport {
  const decoded = decodePortableSessionPackage(bytes, options);
  const byPath = new Map(decoded.entries.map((entry) => [entry.path, entry] as const));
  const projectionEntry = byPath.get("projection/messages.json");
  if (projectionEntry === undefined || projectionEntry.kind !== "projection"
    || projectionEntry.mediaType !== "application/json") {
    throw new Error("Portable Session package has no valid product message projection.");
  }
  const projection = decodePortableSessionProjection(projectionEntry.bytes);
  const requested = collectPortableProjectionBlobRefs(projection);
  const mediaMapEntry = byPath.get("projection/media-map.json");
  const mediaMap = mediaMapEntry === undefined
    ? { format: 1 as const, items: [] }
    : parseMediaMap(mediaMapEntry);
  const media: { sourceId: string; blob: BlobRef; bytes: Uint8Array }[] = [];
  const mappedIds = new Set<string>();
  for (const item of mediaMap.items) {
    if (mappedIds.has(item.sourceId)) throw new Error("Portable Session media map contains a duplicate source ID.");
    mappedIds.add(item.sourceId);
    const expected = requested.get(item.sourceId);
    if (expected === undefined || !sameBlob(expected, item.blob)) {
      throw new Error("Portable Session media map does not match its message projection.");
    }
    const entry = byPath.get(item.path);
    if (entry === undefined || entry.kind !== "artifact" || entry.mediaType !== item.blob.mimeType
      || entry.bytes.byteLength !== item.blob.byteLength || sha256(entry.bytes) !== item.blob.sha256) {
      throw new Error("Portable Session media entry does not match its declared Blob identity.");
    }
    media.push({ sourceId: item.sourceId, blob: item.blob, bytes: entry.bytes });
  }
  if (mappedIds.size !== requested.size || [...requested.keys()].some((id) => !mappedIds.has(id))) {
    throw new Error("Portable Session message projection contains unmapped media.");
  }

  const nativeEntry = decoded.manifest.nativeHistoryEntry === undefined
    ? undefined
    : byPath.get(decoded.manifest.nativeHistoryEntry);
  if (nativeEntry !== undefined && nativeEntry.kind !== "native_history") {
    throw new Error("Portable Session native history entry has the wrong kind.");
  }
  const collaborationEntry = byPath.get("collaboration/workers.json");
  return {
    manifest: decoded.manifest,
    projection,
    ...(nativeEntry === undefined ? {} : { nativeSession: { bytes: nativeEntry.bytes } }),
    media,
    ...(collaborationEntry === undefined ? {} : { collaboration: parseCollaboration(collaborationEntry, decoded.manifest) })
  };
}

export async function materializePortableSessionImport(
  prepared: PreparedPortableSessionImport,
  storeBlob: (input: {
    readonly bytes: Uint8Array;
    readonly fileName?: string;
    readonly mimeType: string;
    readonly sha256: string;
  }) => Promise<BlobRef>
): Promise<MaterializedPortableSessionImport> {
  const replacements = new Map<string, BlobRef>();
  for (const item of prepared.media) {
    const stored = await storeBlob({
      bytes: item.bytes,
      ...(item.blob.fileName === undefined ? {} : { fileName: item.blob.fileName }),
      mimeType: item.blob.mimeType,
      sha256: item.blob.sha256
    });
    if (stored.sha256 !== item.blob.sha256 || stored.byteLength !== item.blob.byteLength
      || stored.mimeType !== item.blob.mimeType) {
      throw new Error("Receiving Artifact Store returned a mismatched portable media identity.");
    }
    replacements.set(item.sourceId, stored);
  }
  const projection = rebindPortableProjectionBlobs(prepared.projection, replacements);
  return {
    manifest: prepared.manifest,
    projection,
    events: portableProjectionEventPayloads(projection),
    ...(prepared.nativeSession === undefined ? {} : { nativeSession: prepared.nativeSession }),
    ...(prepared.collaboration === undefined ? {} : { collaboration: prepared.collaboration })
  };
}

function parseMediaMap(entry: PortableSessionPackage["entries"][number]): PortableMediaMap {
  if (entry.kind !== "projection" || entry.mediaType !== "application/json") {
    throw new Error("Portable Session media map has the wrong entry kind.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes));
  } catch {
    throw new Error("Portable Session media map is not valid UTF-8 JSON.");
  }
  if (!isRecord(value) || value["format"] !== 1 || !Array.isArray(value["items"])
    || value["items"].length > 10_000) throw new Error("Portable Session media map shape is invalid.");
  const items = value["items"].map((raw): PortableMediaMapItem => {
    if (!isRecord(raw) || typeof raw["sourceId"] !== "string" || raw["sourceId"].trim() === ""
      || typeof raw["path"] !== "string") throw new Error("Portable Session media map item is invalid.");
    const blob = parseBlob(raw["blob"]);
    if (Object.keys(raw).some((key) => !["sourceId", "path", "blob"].includes(key))) {
      throw new Error("Portable Session media map item has unsupported fields.");
    }
    return { sourceId: raw["sourceId"], path: raw["path"], blob };
  });
  if (Object.keys(value).some((key) => !["format", "items"].includes(key))) {
    throw new Error("Portable Session media map has unsupported fields.");
  }
  return { format: 1, items };
}

function parseCollaboration(
  entry: PortableSessionPackage["entries"][number],
  manifest: PortableSessionManifest
): PortableCollaborationProjection {
  if (entry.kind !== "collaboration" || entry.mediaType !== "application/json") {
    throw new Error("Portable Session collaboration entry has the wrong kind.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes));
  } catch {
    throw new Error("Portable Session collaboration entry is not valid UTF-8 JSON.");
  }
  if (!isRecord(value) || value["format"] !== 1 || !Array.isArray(value["workers"])
    || !Array.isArray(value["detail"]) || JSON.stringify(value["workers"]) !== JSON.stringify(manifest.workers ?? [])) {
    throw new Error("Portable Session collaboration projection does not match its manifest.");
  }
  return { format: 1, workers: manifest.workers ?? [], detail: value["detail"] };
}

function parseBlob(value: unknown): BlobRef {
  if (!isRecord(value) || typeof value["id"] !== "string" || value["id"].trim() === ""
    || typeof value["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["sha256"])
    || !Number.isSafeInteger(value["byteLength"]) || Number(value["byteLength"]) < 0
    || typeof value["mimeType"] !== "string" || value["mimeType"].trim() === ""
    || (value["fileName"] !== undefined && typeof value["fileName"] !== "string")) {
    throw new Error("Portable Session media map Blob identity is invalid.");
  }
  if (Object.keys(value).some((key) => !["id", "sha256", "byteLength", "mimeType", "fileName"].includes(key))) {
    throw new Error("Portable Session media map Blob identity has unsupported fields.");
  }
  return {
    id: value["id"],
    sha256: value["sha256"],
    byteLength: Number(value["byteLength"]),
    mimeType: value["mimeType"],
    ...(value["fileName"] === undefined ? {} : { fileName: value["fileName"] })
  };
}

function safeSuffix(fileName: string | undefined): string {
  if (fileName === undefined) return "";
  const suffix = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/u.test(suffix) ? suffix : "";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBlob(left: BlobRef, right: BlobRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256 && left.byteLength === right.byteLength
    && left.mimeType === right.mimeType && left.fileName === right.fileName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_TRANSFER_LIMIT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_TRANSFER_LIMIT_BYTES) {
    throw new RangeError(`Portable Session export limit must be an integer from 1 through ${DEFAULT_TRANSFER_LIMIT_BYTES}.`);
  }
  return limit;
}
