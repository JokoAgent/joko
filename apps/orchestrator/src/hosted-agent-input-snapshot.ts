import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BlobRef } from "@joko/core";

const MAX_BYTES = 256 * 1024 * 1024;
export interface SourceInputFileSnapshot { readonly path: string; readonly fingerprint: string; readonly assertCurrent: () => void }

/** A Source-owned immutable input copy. Neither its private directory nor the
 * original Blob store becomes a native workspace root. */
export async function snapshotSourceInputFile(source: string, destination: string, blob: BlobRef, signal: AbortSignal, guard: () => void): Promise<SourceInputFileSnapshot> {
  validateSourceInputBlob(blob); signal.throwIfAborted(); guard();
  const temporary = `${destination}.${randomUUID()}.tmp`; let staged = false;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); guard();
  if (!samePath(await realpath(dirname(destination)), dirname(destination))) throw new Error("The Source input cache is not canonical.");
  try {
    try { return await inspectSourceInputFile(destination, blob, signal, guard); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await input.stat({ bigint: true }); guard();
      if (!before.isFile() || before.size !== BigInt(blob.byteLength) || !samePath(await realpath(source), source)) throw new Error("The Source input file is not the selected immutable content.");
      const output = await open(temporary, "wx", 0o600); staged = true;
      try {
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(128 * 1024); let total = 0;
        for (;;) {
          signal.throwIfAborted(); guard(); const part = await input.read(buffer, 0, buffer.length, null); if (!part.bytesRead) break;
          total += part.bytesRead; if (total > blob.byteLength) throw new Error("The Source input file changed during capture."); hash.update(buffer.subarray(0, part.bytesRead));
          for (let written = 0; written < part.bytesRead;) { signal.throwIfAborted(); guard(); const next = await output.write(buffer, written, part.bytesRead - written, null); if (!next.bytesWritten) throw new Error("The Source input snapshot could not be written."); written += next.bytesWritten; }
        }
        const after = await input.stat({ bigint: true }), current = await lstat(source, { bigint: true }); signal.throwIfAborted(); guard();
        if (!sameFile(before, after) || !sameFile(before, current) || current.isSymbolicLink() || total !== blob.byteLength || hash.digest("hex") !== blob.sha256
          || !samePath(await realpath(source), source)) throw new Error("The Source input file failed immutable content verification.");
        await output.sync();
      } finally { await output.close(); }
    } finally { await input.close(); }
    signal.throwIfAborted(); guard(); await rename(temporary, destination); staged = false;
    return await inspectSourceInputFile(destination, blob, signal, guard);
  } finally { if (staged) await rm(temporary, { force: true }); }
}

export async function inspectSourceInputFile(path: string, blob: BlobRef, signal: AbortSignal, guard: () => void): Promise<SourceInputFileSnapshot> {
  validateSourceInputBlob(blob); signal.throwIfAborted(); guard();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let observed!: BigIntStats;
  try {
    observed = await file.stat({ bigint: true });
    if (!observed.isFile() || observed.size !== BigInt(blob.byteLength) || !samePath(await realpath(path), path)) throw new Error("The Source input snapshot is unsafe.");
    const hash = createHash("sha256"), bytes = Buffer.allocUnsafe(128 * 1024); let total = 0;
    for (;;) { signal.throwIfAborted(); guard(); const part = await file.read(bytes, 0, bytes.length, null); if (!part.bytesRead) break; total += part.bytesRead;
      if (total > blob.byteLength) throw new Error("The Source input snapshot changed."); hash.update(bytes.subarray(0, part.bytesRead)); }
    if (total !== blob.byteLength || hash.digest("hex") !== blob.sha256 || !sameFile(observed, await file.stat({ bigint: true }))) throw new Error("The Source input snapshot failed integrity verification.");
  } finally { await file.close(); }
  const snapshot = observeSourceInputFile(path, blob);
  if (snapshot.fingerprint !== fingerprint(observed)) throw new Error("The Source input snapshot changed.");
  signal.throwIfAborted(); guard(); snapshot.assertCurrent(); return snapshot;
}
export function observeSourceInputFile(path: string, blob: BlobRef): SourceInputFileSnapshot {
  validateSourceInputBlob(blob); const observed = lstatSync(path, { bigint: true });
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size !== BigInt(blob.byteLength) || !samePath(realpathSync(path), path)) throw new Error("The Source input snapshot is unsafe.");
  const assertCurrent = () => { const current = lstatSync(path, { bigint: true });
    if (current.isSymbolicLink() || !sameFile(observed, current) || !samePath(realpathSync(path), path)) throw new Error("The Source input snapshot changed."); };
  return { path, fingerprint: fingerprint(observed), assertCurrent };
}
export function validateSourceInputBlob(blob: BlobRef): void {
  if (!blob.id || !Number.isSafeInteger(blob.byteLength) || blob.byteLength < 0 || blob.byteLength > MAX_BYTES || !/^[a-f0-9]{64}$/u.test(blob.sha256)
    || typeof blob.mimeType !== "string" || !blob.mimeType || blob.mimeType.length > 256) throw new Error("The Source input Blob identity is invalid.");
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean { return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function fingerprint(value: BigIntStats): string { return createHash("sha256").update([value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":" )).digest("hex"); }
function samePath(a: string, b: string): boolean { return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b); }
