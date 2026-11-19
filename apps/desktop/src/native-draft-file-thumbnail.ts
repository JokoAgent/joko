import { mkdtemp, realpath, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { draftDocumentAttachmentType, NATIVE_DRAFT_THUMBNAIL_INPUT_BYTES } from "@joko/contracts";
import { atomicWritePrivateFile } from "@joko/device-peer/private-files";
import { isSafeNativeFileName } from "./native-file-opener.js";

const MAXIMUM_PENDING = 4;
const TIMEOUT_MS = 4_000;
let pending = 0;

export async function readNativeDraftFileThumbnail(input: unknown, options: {
  readonly temporaryDirectory: string;
  readonly isCurrent: () => boolean;
  readonly render: (path: string) => Promise<string | undefined>;
}): Promise<string | undefined> {
  if (pending >= MAXIMUM_PENDING || !options.isCurrent() || typeof input !== "object" || input === null
    || Object.keys(input).sort().join(",") !== "bytes,name" || !("name" in input) || typeof input.name !== "string"
    || !isSafeNativeFileName(input.name) || draftDocumentAttachmentType(input.name) === undefined
    || !("bytes" in input) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0
    || input.bytes.byteLength > NATIVE_DRAFT_THUMBNAIL_INPUT_BYTES) return undefined;

  const { name, bytes } = input;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(undefined); }, TIMEOUT_MS);
  });
  const current = (): boolean => !expired && options.isCurrent();
  pending += 1;
  let directory: string | undefined, staged: string | undefined;
  const thumbnail = (async (): Promise<string | undefined> => {
    try {
      const root = await realpath(options.temporaryDirectory);
      if (!current()) return undefined;
      directory = await mkdtemp(join(root, "joko-draft-thumbnail-"));
      if (!current()) return undefined;
      staged = join(directory, name);
      await atomicWritePrivateFile(staged, bytes);
      if (!current()) return undefined;
      const result = await options.render(staged);
      return current() ? result : undefined;
    } catch {
      return undefined;
    } finally {
      if (staged !== undefined) await unlink(staged).catch(() => undefined);
      if (directory !== undefined) await rmdir(directory).catch(() => undefined);
      pending -= 1;
    }
  })();
  try {
    const result = await Promise.race([thumbnail, timeout]);
    return current() ? result : undefined;
  }
  finally { clearTimeout(timer); }
}
