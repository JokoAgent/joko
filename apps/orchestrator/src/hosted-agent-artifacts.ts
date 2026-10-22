import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AdapterContext, BlobRef } from "@joko/core";
import { HostedAgentExchange, type HostedAgentArtifactOffer } from "./hosted-agent-exchange.js";

export const HOSTED_AGENT_ARTIFACT_CHUNK_BYTES = 1024 * 1024;
type Handle = Awaited<ReturnType<typeof open>>;
interface OfferedArtifact { readonly handle: Handle; readonly offer: HostedAgentArtifactOffer }

/** Host-owned descriptors, never model-selected paths in a reverse request. */
export class HostedAgentArtifacts {
  readonly #root: string;
  readonly #maximum: number;
  readonly #assertAuthority: () => void;
  readonly #exchange: HostedAgentExchange;
  readonly #offers = new Map<string, OfferedArtifact>();
  #closed = false;
  constructor(options: { readonly root: string; readonly maximumBytes: number; readonly assertCurrent: () => void; readonly exchange: HostedAgentExchange }) {
    if (!isAbsolute(options.root) || resolve(options.root) !== options.root || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1) throw new Error("Hosted Artifact owner is invalid.");
    this.#root = options.root; this.#maximum = options.maximumBytes; this.#assertAuthority = options.assertCurrent; this.#exchange = options.exchange;
  }
  async store(path: string, signal: AbortSignal, options?: { readonly fileName?: string; readonly mimeType?: string }, operationId?: string): Promise<BlobRef> {
    this.#assertCurrent(); signal.throwIfAborted();
    if (this.#offers.size >= 64) throw new Error("Hosted Artifact capacity is unavailable.");
    const canonical = await realpath(path), suffix = relative(this.#root, canonical), info = await lstat(path);
    if (canonical !== resolve(path) || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || info.isSymbolicLink() || !info.isFile() || info.size > this.#maximum) {
      throw new Error("Hosted Artifact is outside its native owner.");
    }
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const id = randomUUID();
    try {
      const opened = await handle.stat(), current = await stat(canonical); this.#assertCurrent(); signal.throwIfAborted();
      if (opened.dev !== current.dev || opened.ino !== current.ino || opened.size > this.#maximum || !opened.isFile()) throw new Error("Hosted Artifact changed.");
      const hash = createHash("sha256"); let bytes = 0;
      if (opened.size > 0) for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, signal })) {
        this.#assertCurrent(); signal.throwIfAborted(); bytes += chunk.byteLength;
        if (bytes > this.#maximum) throw new Error("Hosted Artifact exceeds its limit."); hash.update(chunk);
      }
      const final = await handle.stat(); this.#assertCurrent();
      if (bytes !== opened.size || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw new Error("Hosted Artifact changed.");
      const fileName = options?.fileName ?? basename(canonical);
      if (!fileName || fileName.length > 1024 || /[\0\r\n]/u.test(fileName)) throw new Error("Hosted Artifact name is invalid.");
      const offer: HostedAgentArtifactOffer = { id, byteLength: bytes, sha256: hash.digest("hex"), fileName,
        ...(options?.mimeType === undefined ? {} : { mimeType: options.mimeType }) };
      this.#offers.set(id, { handle, offer });
      return await this.#exchange.artifact(offer, signal, operationId);
    } finally { this.#offers.delete(id); await handle.close().catch(() => undefined); }
  }
  async read(id: string, offset: number, maximum: number): Promise<{ readonly data: string }> {
    this.#assertCurrent(); const artifact = this.#offers.get(id);
    if (!artifact || !Number.isSafeInteger(offset) || offset < 0 || offset > artifact.offer.byteLength
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > HOSTED_AGENT_ARTIFACT_CHUNK_BYTES) throw new Error("Hosted Artifact chunk is unavailable.");
    const bytes = Buffer.alloc(Math.min(maximum, artifact.offer.byteLength - offset));
    const result = await artifact.handle.read(bytes, 0, bytes.length, offset); this.#assertCurrent();
    if (result.bytesRead !== bytes.length) throw new Error("Hosted Artifact changed.");
    return { data: bytes.toString("base64") };
  }
  async close(): Promise<void> { if (this.#closed) return; this.#closed = true;
    const owned = [...this.#offers.values()]; this.#offers.clear(); await Promise.all(owned.map(value => value.handle.close().catch(() => undefined))); }
  #assertCurrent(): void { if (this.#closed) throw new Error("Hosted Artifact owner closed."); this.#assertAuthority(); }
}

/** Materializes bytes below private task-node storage, verifies them before the
 * original ArtifactStore admits them, and never exposes a host filesystem path. */
export async function receiveHostedAgentArtifact(options: {
  readonly offer: HostedAgentArtifactOffer;
  readonly readChunk: (id: string, offset: number, maximum: number, signal: AbortSignal) => Promise<{ readonly data: string }>;
  readonly context: AdapterContext;
  readonly temporaryRoot: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}): Promise<BlobRef> {
  const { offer, signal } = options;
  if (!offer.id || offer.id.length > 128 || !Number.isSafeInteger(offer.byteLength) || offer.byteLength < 0 || offer.byteLength > options.context.artifactCapacityBytes
    || !/^[0-9a-f]{64}$/u.test(offer.sha256) || typeof offer.fileName !== "string" || !offer.fileName || offer.fileName.length > 1024 || /[\0\r\n]/u.test(offer.fileName)) throw new Error("Hosted Artifact offer is invalid.");
  const assert = () => { signal.throwIfAborted(); options.context.signal.throwIfAborted(); options.assertCurrent(); };
  assert(); await mkdir(options.temporaryRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(options.temporaryRoot), rootInfo = await lstat(options.temporaryRoot);
  if (canonicalRoot !== resolve(options.temporaryRoot) || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Task Artifact staging is unsafe.");
  const directory = await mkdtemp(join(canonicalRoot, "hosted-artifact-")); await chmod(directory, 0o700);
  const path = join(directory, "artifact.bin");
  try {
    const handle = await open(path, "wx", 0o600), hash = createHash("sha256");
    try {
      for (let offset = 0; offset < offer.byteLength;) {
        assert(); const maximum = Math.min(HOSTED_AGENT_ARTIFACT_CHUNK_BYTES, offer.byteLength - offset);
        const result = await options.readChunk(offer.id, offset, maximum, signal); assert();
        if (typeof result.data !== "string" || result.data.length > Math.ceil(maximum / 3) * 4 || result.data.length % 4 !== 0) throw new Error("Hosted Artifact returned invalid bytes.");
        const bytes = Buffer.from(result.data, "base64");
        if (bytes.length !== maximum || bytes.toString("base64") !== result.data) throw new Error("Hosted Artifact returned invalid bytes.");
        hash.update(bytes);
        for (let written = 0; written < bytes.length;) { assert(); const next = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (next.bytesWritten <= 0) throw new Error("Task Artifact staging failed."); written += next.bytesWritten; }
        offset += bytes.length;
      }
      await handle.sync(); assert();
      if (hash.digest("hex") !== offer.sha256) throw new Error("Hosted Artifact checksum changed.");
    } finally { await handle.close(); }
    assert(); const blob = await options.context.storeArtifact(path, { fileName: offer.fileName, ...(offer.mimeType === undefined ? {} : { mimeType: offer.mimeType }) });
    assert(); if (blob.sha256 !== offer.sha256 || blob.byteLength !== offer.byteLength) throw new Error("Task Artifact receipt does not match its bytes.");
    return blob;
  } finally {
    const suffix = relative(canonicalRoot, directory);
    if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Task Artifact cleanup is unsafe.");
    await rm(directory, { recursive: true, force: true });
  }
}
