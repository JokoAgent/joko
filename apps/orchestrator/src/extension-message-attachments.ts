import { createHash } from "node:crypto";
import type { BlobRef } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import { sniffMediaMime } from "./extension-cards/media-sniff.js";

const MAXIMUM = 20 * 1024 * 1024;
let inFlightBytes = 0;
export interface ExtensionMessageImage { readonly data: Buffer; readonly mimeType: string; readonly sha256: string; readonly name: string }
const invalid = (): never => { throw Object.assign(new Error("Plugin images are invalid."), { code: "INVALID_ATTACHMENTS" }); };

/** Shared tasks/targets budget includes decoding and time waiting for receipt locks. */
export async function withExtensionMessageImages<T>(value: unknown, use: (images: readonly ExtensionMessageImage[]) => Promise<T>): Promise<T> {
  if (value !== undefined && (!Array.isArray(value) || value.length > 4)) invalid();
  const attachments = (value ?? []) as readonly Record<string, unknown>[];
  let bytes = 0;
  for (const item of attachments) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["base64", "name"].includes(key))
      || typeof item.base64 !== "string" || !item.base64.length || item.base64.length > Math.ceil(MAXIMUM / 3) * 4
      || item.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.base64)
      || item.name !== undefined && (typeof item.name !== "string" || !item.name.trim() || item.name.length > 200 || /[\\/\0-\x1f\x7f]/u.test(item.name))) invalid();
    const base64 = item.base64 as string;
    bytes += base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  }
  if (bytes > MAXIMUM) invalid();
  if (inFlightBytes + bytes > MAXIMUM * 2) throw Object.assign(new Error("Plugin image delivery is busy."), { code: "TASK_BUSY" });
  inFlightBytes += bytes;
  try {
    const images = attachments.map(item => {
      const data = Buffer.from(item.base64 as string, "base64"), mimeType = sniffMediaMime(data);
      if (data.toString("base64") !== item.base64 || !mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return invalid();
      return { data, mimeType, sha256: createHash("sha256").update(data).digest("hex"),
        name: typeof item.name === "string" ? item.name : `image.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}` };
    });
    return await use(images);
  } finally { inFlightBytes -= bytes; }
}

export async function stageExtensionMessageImages(images: readonly ExtensionMessageImage[], artifacts: Pick<ArtifactStore, "ingestBytes">,
  store: OperationalStore, assertCurrent: () => void) {
  const blobs: BlobRef[] = [];
  try {
    for (const image of images) {
      assertCurrent();
      const artifact = await artifacts.ingestBytes(image.data, { fileName: image.name, mimeType: image.mimeType, expiresAt: Date.now() + 10 * 60_000 });
      blobs.push({ id: artifact.id, sha256: artifact.sha256, byteLength: artifact.byteLength, mimeType: artifact.mimeType,
        ...(artifact.fileName === undefined ? {} : { fileName: artifact.fileName }) }); assertCurrent();
    }
    return { images: blobs.map(blob => ({ blob })), adopt: (transaction: OperationalStore, accepted: { readonly sessionId: string; readonly runId: string }) => {
      assertCurrent(); for (const blob of blobs) transaction.adoptSessionArtifact({ blob, sessionId: accepted.sessionId, runId: accepted.runId });
    }, release: () => store.releaseArtifactStaging(blobs.map(blob => blob.id)) };
  } catch (error) { store.releaseArtifactStaging(blobs.map(blob => blob.id)); throw error; }
}
