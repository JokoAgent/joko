import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";

export interface BrowserUploadFileIdentity {
  readonly fileName?: string;
  readonly byteLength: number;
  readonly sha256: string;
}

const SELECTION_PREFIX = "selection-";

/** Scavenge only this profile's cache after Chromium has opened the profile. */
export async function prepareBrowserUploadRoot(profileDirectory: string): Promise<string> {
  const root = join(await realpath(profileDirectory), "joko-upload-cache");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertUploadRoot(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^selection-[a-zA-Z0-9]{6}$/u.test(entry.name)) {
      await removeBrowserUploadSelection(join(root, entry.name));
    }
  }
  return root;
}

export async function stageBrowserUploadSelection(
  root: string,
  paths: readonly string[],
  identities: readonly BrowserUploadFileIdentity[],
  assertCurrent: () => void
): Promise<{ readonly directory: string; readonly files: readonly string[] }> {
  if (paths.length !== identities.length) throw new Error("Browser upload file identities are incomplete.");
  await assertUploadRoot(root);
  assertCurrent();
  const directory = await mkdtemp(join(root, SELECTION_PREFIX));
  const files: string[] = [];
  try {
    for (const [index, source] of paths.entries()) {
      const identity = identities[index]!;
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isFile() || sourceInfo.size !== identity.byteLength || !/^[a-f0-9]{64}$/iu.test(identity.sha256)) {
        throw new Error("Browser upload source no longer matches its registered file.");
      }
      const parent = join(directory, String(index));
      await mkdir(parent);
      const destination = join(parent, uploadFileName(identity.fileName ?? basename(source)));
      assertCurrent();
      await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const copied = await lstat(destination);
      if (!copied.isFile() || copied.size !== identity.byteLength) {
        throw new Error("Browser upload staging has the wrong length.");
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(destination)) hash.update(chunk);
      if (hash.digest("hex") !== identity.sha256.toLowerCase()) {
        throw new Error("Browser upload staging does not match the registered bytes.");
      }
      assertCurrent();
      files.push(destination);
    }
    return { directory, files };
  } catch (error) {
    await removeBrowserUploadSelection(directory).catch(() => undefined);
    throw error;
  }
}

export function removeBrowserUploadSelection(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function assertUploadRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Browser upload staging is unavailable.");
  }
}

function uploadFileName(value: string): string {
  const leaf = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim();
  const portable = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]|$)/iu.test(leaf) ? `_${leaf}` : leaf;
  let end = 0;
  let bytes = 0;
  for (const character of portable) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 255) break;
    bytes += size;
    end += character.length;
  }
  return portable.slice(0, end).replace(/[.\s]+$/u, "") || "attachment";
}
