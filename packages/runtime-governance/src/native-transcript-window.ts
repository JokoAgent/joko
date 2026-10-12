import { lstat, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";

const WINDOW_BYTES = 64 * 1024;
const FIRST_LINE_SKIP_BYTES = 1024 * 1024;

export interface NativeTranscriptFileIdentity {
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
  readonly device: bigint;
  readonly inode: bigint;
}
export interface NativeTranscriptWindow {
  readonly head: readonly string[];
  readonly tail: readonly string[];
  readonly headText: string;
  readonly whole: boolean;
  readonly identity: NativeTranscriptFileIdentity;
}

/** Stable head/tail reads bound both allocation and I/O. A long metadata first
 * line may be skipped, without making a full-file read or returning tool data. */
export async function readNativeTranscriptWindow(path: string, expected?: NativeTranscriptFileIdentity): Promise<NativeTranscriptWindow> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !matches(before, await lstat(path, { bigint: true }))
      || expected !== undefined && !matches(before, expected)) throw unavailable();
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw unavailable();
    const identity = { size: before.size, modifiedAtNanoseconds: before.mtimeNs, device: before.dev, inode: before.ino };
    const read = async (position: number, length: number): Promise<Buffer> => {
      const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      const result = await handle.read(bytes, 0, bytes.length, position);
      return bytes.subarray(0, result.bytesRead);
    };
    const whole = size <= 2 * WINDOW_BYTES;
    const first = await read(0, whole ? 2 * WINDOW_BYTES : WINDOW_BYTES);
    let head = first;
    if (!whole && !first.includes(0x0a)) {
      for (let offset = WINDOW_BYTES; offset < Math.min(size, FIRST_LINE_SKIP_BYTES); offset += WINDOW_BYTES) {
        const part = await read(offset, WINDOW_BYTES);
        const newline = part.indexOf(0x0a);
        if (newline < 0) continue;
        head = await read(offset + newline + 1, WINDOW_BYTES);
        break;
      }
      if (head === first) head = Buffer.alloc(0);
    }
    const tail = whole ? first : await read(Math.max(0, size - WINDOW_BYTES), WINDOW_BYTES);
    if (!matches(before, await handle.stat({ bigint: true })) || !matches(before, await lstat(path, { bigint: true }))) throw unavailable();
    const complete = (bytes: Buffer, trimFirst: boolean, trimLast: boolean): readonly string[] => {
      const lines = bytes.toString("utf8").split(/\r?\n/u);
      if (trimFirst) lines.shift();
      if (trimLast && bytes.at(-1) !== 0x0a) lines.pop();
      return lines.filter((line) => line.trim() !== "");
    };
    return { identity, whole, headText: first.toString("utf8"),
      head: complete(head, false, !whole), tail: complete(tail, !whole, false) };
  } finally { await handle.close(); }
}

function matches(actual: BigIntStats, other: BigIntStats | NativeTranscriptFileIdentity): boolean {
  return actual.isFile() && ("isSymbolicLink" in other ? !other.isSymbolicLink() && other.isFile() : true)
    && actual.size === other.size && actual.mtimeNs === ("mtimeNs" in other ? other.mtimeNs : other.modifiedAtNanoseconds)
    && actual.dev === ("dev" in other ? other.dev : other.device) && actual.ino === ("ino" in other ? other.ino : other.inode);
}
function unavailable(): Error { return new Error("The native transcript source changed or is unavailable. Rescan and retry."); }
