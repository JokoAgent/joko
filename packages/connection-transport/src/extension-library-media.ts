const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
const FILE_TAG = /^"[a-f0-9]{64}"$/u;

export interface ExtensionLibraryFileMatch {
  readonly tag: string;
  readonly capture?: (tag: string) => void;
}

type ReadCall = { readonly kind: "stat"; readonly path: string }
  | { readonly kind: "read"; readonly path: string; readonly offset: bigint; readonly length: bigint };

interface ReadResult {
  readonly kind: string;
  readonly entry?: { readonly kind: string; readonly path: string; readonly bytes: bigint };
  readonly path?: string;
  readonly content?: Uint8Array;
}

export function extensionLibraryVideoPath(root: URL, url: URL): string | undefined {
  const prefix = `${root.pathname}library/`;
  if (url.origin !== root.origin || url.username || url.password || url.search || !url.pathname.startsWith(prefix)) return undefined;
  try {
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (/\.mp4$/iu.test(path)) return path;
  } catch { /* The ordinary resource resolver owns malformed paths. */ }
}

/** Read one unchanged Library file through its current authenticated session. */
export async function readExtensionLibraryVideo(path: string, maximumBytes: number,
  call: (operation: ReadCall, source: ExtensionLibraryFileMatch) => Promise<ReadResult>, signal: AbortSignal
): Promise<{ readonly chunks: readonly Uint8Array<ArrayBuffer>[]; readonly byteLength: number; readonly mimeType: "video/mp4" }> {
  const stat = async (source: ExtensionLibraryFileMatch): Promise<bigint> => {
    signal.throwIfAborted();
    const result = await call({ kind: "stat", path }, source);
    signal.throwIfAborted();
    if (result.kind !== "stat" || result.entry?.kind !== "file" || result.entry.path !== path) {
      throw new Error("Extension Library video is unavailable.");
    }
    return result.entry.bytes;
  };
  let tag: string | undefined;
  const size = await stat({ tag: "*", capture: value => { tag = value; } });
  if (tag === undefined || !FILE_TAG.test(tag) || size <= 0n || size > BigInt(maximumBytes)) {
    throw new Error("Extension Library video is unavailable or exceeds its budget.");
  }
  const source = { tag }, byteLength = Number(size), chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < byteLength; offset += VIDEO_CHUNK_BYTES) {
    signal.throwIfAborted();
    const length = Math.min(VIDEO_CHUNK_BYTES, byteLength - offset);
    const result = await call({ kind: "read", path, offset: BigInt(offset), length: BigInt(length) }, source);
    signal.throwIfAborted();
    if (result.kind !== "read" || result.path !== path || result.content?.byteLength !== length) {
      throw new Error("Extension Library video changed while it was read.");
    }
    chunks.push(new Uint8Array(result.content));
  }
  if (await stat(source) !== size) throw new Error("Extension Library video changed while it was read.");
  return { chunks, byteLength, mimeType: "video/mp4" };
}
