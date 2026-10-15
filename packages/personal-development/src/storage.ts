import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PersonalDevelopmentError } from "./types.js";

export const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
export const HASH = /^[0-9a-f]{40,64}$/u;
export const DIGEST = /^[0-9a-f]{64}$/u;
export const SOURCE_REPOSITORY = "https://github.com/JokoAgent/joko.git";
export const PERSONAL_BRANCH = "joko-personal";
export const GIT_IDENTITY = ["-c", "user.name=Joko", "-c", "user.email=personal-development@localhost.invalid", "-c", "commit.gpgSign=false", "-c", "core.editor=true"] as const;
export function identity(value: string): string {
  if (!ID.test(value)) throw new PersonalDevelopmentError("INVALID_ARGUMENT"); return value;
}
export function inside(root: string, value: string): boolean {
  const rel = relative(resolve(root), resolve(value)); return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
export async function ordinaryDirectory(path: string): Promise<void> {
  const absolute = resolve(path); const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) throw new PersonalDevelopmentError("UNSAFE_PATH");
}
export function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
export async function safeRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new PersonalDevelopmentError("UNSAFE_PATH");
  await mkdir(root, { recursive: true }); await ordinaryDirectory(root); return resolve(root);
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function managedPath(root: string, path: string, allowMissing = false): Promise<string> {
  const absolute = resolve(path);
  if (!inside(root, absolute) || samePath(root, absolute)) throw new PersonalDevelopmentError("UNSAFE_PATH");
  let cursor = absolute;
  for (;;) {
    if (await exists(cursor)) {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !inside(await realpath(root), await realpath(cursor))) throw new PersonalDevelopmentError("UNSAFE_PATH");
    } else if (!allowMissing) throw new PersonalDevelopmentError("UNSAFE_PATH");
    cursor = dirname(cursor); if (samePath(cursor, root)) break;
  }
  return absolute;
}
export async function removeManaged(root: string, path: string): Promise<void> {
  const absolute = await managedPath(root, path, true);
  // The resolved target is checked before every recursive removal.
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
export async function readJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new PersonalDevelopmentError("STATE_INVALID");
  const handle = await open(path, "r");
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) throw new PersonalDevelopmentError("STATE_INVALID");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally { await handle.close(); }
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await ordinaryDirectory(dirname(path));
  const temporary = join(dirname(path), `.write-${randomUUID()}.json`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function fileDigest(path: string): Promise<string> {
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new PersonalDevelopmentError("ARTIFACT_CHANGED");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}
/** Hash the complete asar:false runtime, including internal link destinations and executable modes. */
export async function directoryDigest(root: string): Promise<string> {
  await ordinaryDirectory(root); const canonical = await realpath(root); const hash = createHash("sha256");
  let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (++entries > 300_000) throw new PersonalDevelopmentError("ARTIFACT_CHANGED");
      const path = join(directory, name); const info = await lstat(path); const rel = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) {
        const target = await readlink(path); if (!inside(canonical, await realpath(path))) throw new PersonalDevelopmentError("UNSAFE_PATH");
        hash.update(`L\0${rel}\0${target}\0`);
      } else if (info.isDirectory()) { hash.update(`D\0${rel}\0`); await visit(path); }
      else if (info.isFile()) { hash.update(`F\0${rel}\0${info.mode & 0o111}\0${await fileDigest(path)}\0`); }
      else throw new PersonalDevelopmentError("ARTIFACT_CHANGED");
    }
  };
  await visit(root); return hash.digest("hex");
}
