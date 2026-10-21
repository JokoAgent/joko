import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PartnerHomeFile } from "./partner-home-files.js";
import { PartnerHomeError, type PartnerHomeMoveRecord } from "./partner-home-owner.js";

interface SnapshotMetadata { readonly version: 1; readonly requestId: string; readonly fingerprint: string;
  readonly partnerId: string; readonly throughCursor: string; readonly readThroughCursor: string;
  readonly unavailableArtifactIds: readonly string[];
  readonly profile: { readonly identity: string; readonly user: string; readonly instructions: string };
  readonly files: readonly { readonly name: string; readonly sha256: string; readonly bytes: number }[]; }
export interface PartnerHomeSnapshot { readonly files: readonly PartnerHomeFile[]; readonly metadata: SnapshotMetadata; }

/** Seals only the portable whitelist before a target effect. Retry never resnapshots a partially moved owner. */
export class PartnerHomeSnapshots {
  constructor(private readonly root: string) {}
  async read(move: PartnerHomeMoveRecord, assertCurrent: () => void): Promise<PartnerHomeSnapshot | undefined> {
    const root = join(resolve(this.root), hash(move.requestId)); assertCurrent();
    let raw: string;
    try { await regular(join(root, "manifest.json"), 8 * 1024 * 1024); raw = await readFile(join(root, "manifest.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    assertCurrent(); const metadata = parse(raw, move), files: PartnerHomeFile[] = [];
    await canonical(root); assertCurrent(); let total = 0;
    for (const file of metadata.files) {
      const leaf = path(root, file.name); await regular(leaf, file.bytes); const bytes = await readFile(leaf); assertCurrent();
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256 || (total += bytes.length) > 128 * 1024 * 1024) invalid();
      files.push({ name: file.name, bytes });
    }
    return { metadata, files };
  }
  async seal(move: PartnerHomeMoveRecord, input: Omit<SnapshotMetadata, "version" | "requestId" | "fingerprint" | "partnerId" | "files">,
    files: readonly PartnerHomeFile[], assertCurrent: () => void): Promise<PartnerHomeSnapshot> {
    const prior = await this.read(move, assertCurrent); if (prior) return prior;
    const root = join(resolve(this.root), hash(move.requestId)); await mkdir(root, { recursive: true, mode: 0o700 }); await canonical(root); assertCurrent();
    if (files.reduce((bytes, file) => bytes + file.bytes.length, 0) > 128 * 1024 * 1024) invalid();
    const metadata: SnapshotMetadata = { version: 1, requestId: move.requestId, fingerprint: move.fingerprint, partnerId: move.partnerId,
      ...input, files: files.map(file => ({ name: file.name, sha256: hash(file.bytes), bytes: file.bytes.length })) };
    parse(JSON.stringify(metadata), move);
    for (const file of files) {
      const leaf = path(root, file.name); await mkdir(dirname(leaf), { recursive: true, mode: 0o700 }); await canonical(dirname(leaf)); assertCurrent();
      await atomic(leaf, file.bytes); assertCurrent();
    }
    await atomic(join(root, "manifest.json"), Buffer.from(JSON.stringify(metadata))); assertCurrent();
    return (await this.read(move, assertCurrent))!;
  }
}
async function atomic(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${file}.${randomUUID()}.pending`; await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }); await rename(temporary, file);
}
async function canonical(directory: string): Promise<void> {
  const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) invalid();
}
async function regular(file: string, maximum: number): Promise<void> {
  const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.size > 64 * 1024 * 1024) invalid();
  await canonical(dirname(file));
}
function path(root: string, name: string): string {
  if (!name || name === "manifest.json" || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")
    || /[\u0000-\u001f\u007f:]/u.test(name)) invalid();
  return join(root, ...name.split("/"));
}
function parse(raw: string, move: PartnerHomeMoveRecord): SnapshotMetadata {
  try {
    const value = JSON.parse(raw) as SnapshotMetadata;
    if (!value || Object.keys(value).some(key => !["version", "requestId", "fingerprint", "partnerId", "throughCursor", "readThroughCursor", "unavailableArtifactIds", "profile", "files"].includes(key))
      || value.version !== 1 || value.requestId !== move.requestId || value.fingerprint !== move.fingerprint || value.partnerId !== move.partnerId
      || !/^(0|[1-9][0-9]{0,19})$/u.test(value.throughCursor) || !/^(0|[1-9][0-9]{0,19})$/u.test(value.readThroughCursor)
      || !Array.isArray(value.unavailableArtifactIds) || value.unavailableArtifactIds.length > 20_000
      || value.unavailableArtifactIds.some(id => typeof id !== "string" || !id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id))
      || new Set(value.unavailableArtifactIds).size !== value.unavailableArtifactIds.length
      || !value.profile || Object.keys(value.profile).length !== 3 || [value.profile.identity, value.profile.user, value.profile.instructions].some(item => typeof item !== "string")
      || !Array.isArray(value.files) || value.files.length > 20_000 || new Set(value.files.map(file => file.name)).size !== value.files.length) invalid();
    for (const file of value.files) {
      if (!file || Object.keys(file).length !== 3 || typeof file.name !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 64 * 1024 * 1024) invalid();
      path("/snapshot", file.name);
    }
    return value;
  } catch { return invalid(); }
}
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(): never { throw new PartnerHomeError("preparation-failed", "The sealed Partner home data is invalid or unavailable."); }
