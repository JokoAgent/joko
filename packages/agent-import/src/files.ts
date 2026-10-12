import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { AgentImportError, type ImportFile, type ImportItem } from "./types.js";
import { visitSnapshotJson } from "./snapshotJson.js";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ITEM_BYTES = 128 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const MAX_DISCOVERY_METADATA_BYTES = 4 * 1024 * 1024;

/** One shared budget is charged before every snapshot allocation. */
export function createImportBudget(limit = MAX_SNAPSHOT_BYTES, assertOwner: () => void = () => {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new AgentImportError("SOURCE_SNAPSHOT_TOO_LARGE");
  let remaining = limit;
  const reserve = (size: number): void => {
    assertOwner();
    if (!Number.isSafeInteger(size) || size < 0 || size > remaining) throw new AgentImportError("SOURCE_SNAPSHOT_TOO_LARGE");
    remaining -= size;
  };
  return { reserve, reserveFile(size: number) { reserve(size + 256); } };
}
export type ImportReadBudget = ReturnType<typeof createImportBudget>;

export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Hash file bytes directly, with bounded metadata work between ownership checks. */
export async function snapshotFingerprintAsync(items: ImportItem[], assertOwner: () => void = () => {}): Promise<string> {
  const hash = createHash("sha256"); let chunk = "";
  await visitSnapshotJson(items, bytes => createHash("sha256").update(bytes).digest("hex"), text => {
    chunk += text;
    if (chunk.length >= 16 * 1024) { hash.update(chunk); chunk = ""; }
  }, assertOwner);
  if (chunk) hash.update(chunk); return hash.digest("hex");
}
export async function reserveSnapshotItems(items: ImportItem[], budget: ImportReadBudget, assertOwner: () => void = () => {}): Promise<void> {
  await visitSnapshotJson(items, bytes => { budget.reserveFile(bytes.length); return null; },
    text => budget.reserve(Buffer.byteLength(text)), assertOwner);
}
export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve native declarations on the host; callers never supply renderer paths. */
export async function readImportFile(root: string, file: string, budget?: ImportReadBudget,
  sharedDocumentRoots: readonly string[] = []): Promise<ImportFile> {
  const realRoot = await fs.realpath(root); const realFile = await fs.realpath(file);
  if (!inside(realRoot, realFile)) {
    if (!sharedDocumentRoots.some(directory => inside(directory, realFile)) || !inside(path.resolve(root), path.resolve(file))
      || !inside(realRoot, await fs.realpath(path.dirname(file))) || !(await fs.lstat(file)).isSymbolicLink()) {
      throw new AgentImportError("SOURCE_LINK_OUTSIDE_FOLDER");
    }
  }
  if (!(await fs.lstat(realFile)).isFile()) throw new AgentImportError("SOURCE_NOT_REGULAR_FILE");
  const handle = await fs.open(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AgentImportError("SOURCE_NOT_REGULAR_FILE");
    if (info.size > MAX_FILE_BYTES) throw new AgentImportError("SOURCE_FILE_TOO_LARGE");
    budget?.reserveFile(info.size); budget?.reserve(Buffer.byteLength(path.relative(root, file)));
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1)); let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > info.size) throw new AgentImportError("SOURCE_CHANGED");
    return { name: path.relative(root, file).split(path.sep).join("/"), bytes: bytes.subarray(0, size), executable: (info.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}

export async function optionalText(root: string, file: string, budget?: ImportReadBudget): Promise<string | undefined> {
  try { return (await readImportFile(root, file, budget)).bytes.toString("utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Stream only the selected subtree, retaining complete files and per-item read failures. */
export async function readImportTree(root: string, include: (name: string) => boolean = () => true, budget?: ImportReadBudget,
  onError?: (name: string, error: unknown, kind: "file" | "directory" | "unknown") => void,
  directory = root, sharedDocumentRoots: readonly string[] = []): Promise<ImportFile[]> {
  const result: ImportFile[] = []; const visited = new Set<string>(); let size = 0; const realRoot = await fs.realpath(root);
  const visit = async (dir: string): Promise<void> => {
    const real = await fs.realpath(dir);
    if (!inside(realRoot, real)) throw new AgentImportError("SOURCE_LINK_OUTSIDE_FOLDER");
    if (visited.has(real)) throw new AgentImportError("SOURCE_LINK_CYCLE");
    visited.add(real);
    try {
      budget?.reserve(128 + Buffer.byteLength(path.relative(root, dir)));
      for await (const entry of await fs.opendir(dir)) {
        if (entry.name === ".git" || entry.name === "__pycache__" || entry.name === ".DS_Store") continue;
        const file = path.join(dir, entry.name); const name = path.relative(root, file).split(path.sep).join("/");
        budget?.reserve(128 + Buffer.byteLength(name));
        let kind: "file" | "directory" | "unknown" = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "unknown" : "file";
        try {
          const target = entry.isSymbolicLink() ? await fs.stat(file) : entry;
          kind = target.isDirectory() ? "directory" : "file";
          if (target.isDirectory()) await visit(file);
          else if (include(name)) {
            const item = await readImportFile(root, file, budget, sharedDocumentRoots); size += item.bytes.length;
            if (size > MAX_ITEM_BYTES) throw new AgentImportError("SOURCE_ITEM_TOO_LARGE");
            result.push(item);
          }
        } catch (error) {
          if (!onError || error instanceof AgentImportError && error.code === "SOURCE_SNAPSHOT_TOO_LARGE") throw error;
          onError(name, error, kind);
        }
      }
    } finally { visited.delete(real); }
  };
  if (!inside(path.resolve(root), path.resolve(directory))) throw new AgentImportError("SOURCE_LINK_OUTSIDE_FOLDER");
  await visit(directory); return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeImportFiles(root: string, files: readonly ImportFile[], assertOwner: () => void = () => {}): Promise<void> {
  assertOwner();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    assertOwner();
    const target = path.resolve(root, file.name);
    if (!inside(root, target) || target === root) throw new AgentImportError('INVALID_TARGET');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // The importer validates these exact native interpreter targets; preserve
    // their location so dynamic libraries and pyvenv.cfg still resolve normally.
    if (file.interpreterLink) {
      if (!/(?:^|\/)(?:\.venv|venv)\/(?:bin|Scripts)\/python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(file.name) || !path.isAbsolute(file.interpreterLink)) throw new AgentImportError('INVALID_TARGET');
      await fs.symlink(file.interpreterLink, target, 'file');
      continue;
    }
    // Imports write into newly allocated directories; never follow a pre-existing entry.
    const handle = await fs.open(target, 'wx', file.executable ? 0o700 : 0o600);
    try { await handle.writeFile(file.bytes); } finally { await handle.close(); }
    assertOwner();
  }
}
