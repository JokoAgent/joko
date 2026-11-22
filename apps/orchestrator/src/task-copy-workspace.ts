import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { create as createTar, extract as extractTar, list as listTar } from "tar";
import { isWorkspaceDirectoryArchiveName, workspaceDirectoryArchiveNameKey, WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES } from "@joko/contracts";
import { captureTaskCopyRepository, restoreTaskCopyRepository, type TaskCopyRepository } from "@joko/worktree";

const manifestName = "manifest.json";
const repositoryName = "repository.bundle";
const MAXIMUM_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAXIMUM_PATH_LENGTH = 2_048;
const MAXIMUM_PATH_DEPTH = 64;
const MAXIMUM_REPORTED_SKIPS = 100;

type WorkspaceEntry =
  | { readonly kind: "directory"; readonly path: string; readonly mode: number }
  | { readonly kind: "file"; readonly path: string; readonly mode: number; readonly size: number; readonly sha256: string }
  | { readonly kind: "link"; readonly path: string; readonly target: string };
type InventoryEntry = { readonly absolute: string; readonly path: string; readonly identity: BigIntStats; readonly link?: string };
type SkipReason = "nonportable" | "collision" | "external_link" | "unsupported" | "link_unavailable";
export interface TaskCopySkippedFile { readonly path: string; readonly reason: SkipReason }
export interface TaskCopyWorkspaceSummary { readonly skippedCount: number; readonly skipped: readonly TaskCopySkippedFile[] }
interface WorkspaceManifest extends TaskCopyWorkspaceSummary {
  readonly format: 1;
  readonly entries: readonly WorkspaceEntry[];
  readonly repository?: TaskCopyRepository;
}

interface WorkspaceFence { readonly signal: AbortSignal; readonly assertCurrent: () => void }
type WorkspaceCopyBudget = WorkspaceFence & { readonly maximumBytes: number };

/** Materialize a private transport artifact from the exact effective workspace. */
export async function captureTaskCopyWorkspace(input: WorkspaceCopyBudget & {
  readonly root: string;
  readonly stage: string;
  readonly excludedRoots: readonly string[];
}): Promise<{ readonly archive: string; readonly uncompressedBytes: number }> {
  const root = await realpath(input.root), stage = await realpath(input.stage);
  if (relative(root, stage) === "" || contained(root, stage)) throw new Error("Choose a workspace outside the node’s private copy storage.");
  const policy = workspacePolicy(input);
  const excluded = new Set(input.excludedRoots.filter(path => contained(root, path)).map(path => relative(root, path).split(/[\\/]/u).join("/")));
  const repository = await captureTaskCopyRepository(root, join(stage, "repository-objects"), join(stage, repositoryName), input);
  const source = await inventory(root, excluded, policy.check);
  if (repository) policy.count(Number((await lstat(join(stage, repositoryName), { bigint: true })).size));
  const entries: WorkspaceEntry[] = [];
  const names = [manifestName];
  if (repository) names.push(repositoryName);
  for (const item of source.entries) {
    policy.check();
    const mode = Number(item.identity.mode & 0o777n);
    if (item.identity.isDirectory()) entries.push({ kind: "directory", path: item.path, mode });
    else if (item.link !== undefined) entries.push({ kind: "link", path: item.path, target: item.link });
    else {
      const size = Number(item.identity.size), name = partName(entries.length);
      policy.count(size);
      const sha256 = await copyFileBytes(item.absolute, join(stage, name), item.identity, 0o600, policy.check);
      entries.push({ kind: "file", path: item.path, mode, size, sha256 });
      names.push(name);
    }
  }
  const manifest: WorkspaceManifest = { format: 1, entries, ...source.summary, ...(repository ? { repository: repository.repository } : {}) };
  const encoded = Buffer.from(JSON.stringify(manifest));
  if (encoded.length > MAXIMUM_MANIFEST_BYTES) throw new Error("The copied workspace contains too much path metadata.");
  policy.count(encoded.length);
  await writeFile(join(stage, manifestName), encoded, { flag: "wx", mode: 0o600 });
  const archive = join(stage, "workspace.tar.gz");
  await createTar({ cwd: stage, file: archive, gzip: true, portable: true, noMtime: true, strict: true }, names);
  if ((await lstat(archive)).size > input.maximumBytes) throw new Error("The compressed workspace exceeds the copy limit.");
  await repository?.verifySource();
  const current = await inventory(root, excluded, policy.check);
  if (!sameIdentity(source.identity, current.identity) || source.entries.length !== current.entries.length
    || source.entries.some((entry, index) => { const value = current.entries[index];
      return !value || entry.path !== value.path || entry.link !== value.link || !sameIdentity(entry.identity, value.identity);
    })) throw changed();
  policy.check();
  return { archive, uncompressedBytes: policy.bytes };
}

/** Restore a digest-checked artifact into the copying operation’s empty, private target directory. */
export async function restoreTaskCopyWorkspace(input: WorkspaceCopyBudget & {
  readonly archive: string;
  readonly stage: string;
  readonly destination: string;
}): Promise<TaskCopyWorkspaceSummary & { readonly uncompressedBytes: number }> {
  const policy = workspacePolicy(input);
  if ((await readdir(input.stage)).length !== 0 || (await readdir(input.destination)).length !== 0) {
    throw new Error("A task copy requires new staging and destination directories.");
  }
  const wireEntries = new Map<string, number>();
  await listTar({ file: input.archive, strict: true, onReadEntry(entry) {
    policy.check();
    const { path, size, type } = entry;
    if (type !== "File" || wireEntries.has(path) || (path !== manifestName && path !== repositoryName && !/^part-[0-9]{1,5}$/u.test(path))
      || wireEntries.size >= WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES + 2 || path === manifestName && size > MAXIMUM_MANIFEST_BYTES) {
      throw invalid();
    }
    policy.count(size);
    wireEntries.set(path, size);
  } });
  if (!wireEntries.has(manifestName)) throw invalid();
  await extractTar({ cwd: input.stage, file: input.archive, strict: true, preservePaths: false, noMtime: true,
    filter(path, entry) { policy.check(); if (!("type" in entry) || entry.type !== "File" || wireEntries.get(path) !== entry.size) throw invalid(); return true; } });
  const manifest = parseManifest(JSON.parse(await readFile(join(input.stage, manifestName), "utf8")), wireEntries);
  const entries = new Map(manifest.entries.map(entry => [workspaceDirectoryArchiveNameKey(entry.path), entry]));
  const extraSkipped: TaskCopySkippedFile[] = [];
  // Parents are created before children. Links are materialized after ordinary paths are written.
  for (const [index, entry] of manifest.entries.entries()) {
    policy.check();
    const target = pathWithin(input.destination, entry.path);
    if (entry.kind === "directory") await mkdir(target, { mode: 0o700 });
    if (entry.kind !== "file") continue;
    const source = join(input.stage, partName(index));
    const stat = await lstat(source, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(entry.size)
      || await copyFileBytes(source, target, stat, entry.mode, policy.check) !== entry.sha256) throw invalid();
  }
  if (manifest.repository) await restoreTaskCopyRepository(input.destination, join(input.stage, repositoryName), manifest.repository, input);
  for (const entry of manifest.entries) {
    if (entry.kind !== "link") continue;
    const resolved = resolveLink(entry, entries);
    if (resolved === undefined) throw invalid();
    const kind = entries.get(workspaceDirectoryArchiveNameKey(resolved))?.kind === "directory" ? "dir" : "file";
    try { await symlink(entry.target, pathWithin(input.destination, entry.path), kind); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      extraSkipped.push({ path: entry.path, reason: "link_unavailable" });
    }
  }
  if (process.platform !== "win32") {
    for (const entry of [...manifest.entries].reverse()) {
      policy.check();
      if (entry.kind === "directory") await chmod(pathWithin(input.destination, entry.path), entry.mode);
    }
  }
  policy.check();
  return { uncompressedBytes: policy.bytes, skippedCount: manifest.skippedCount + extraSkipped.length,
    skipped: [...manifest.skipped, ...extraSkipped].slice(0, MAXIMUM_REPORTED_SKIPS) };
}

async function inventory(root: string, excluded: ReadonlySet<string>, check: () => void) {
  const identity = await lstat(root, { bigint: true });
  if (!identity.isDirectory()) throw changed();
  const entries: InventoryEntry[] = [];
  const folded = new Map<string, { readonly kind: "directory" | "file" | "link"; readonly path: string; readonly target?: string }>();
  const skipped: TaskCopySkippedFile[] = [];
  let visited = 0, skippedCount = 0;
  const skip = (path: string, reason: SkipReason) => {
    skippedCount++;
    if (skipped.length < MAXIMUM_REPORTED_SKIPS) skipped.push({ path: path.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, MAXIMUM_PATH_LENGTH), reason });
  };
  const walk = async (relativeDir: string) => {
    const directory = relativeDir ? pathWithin(root, relativeDir) : root;
    if (relative(directory, await realpath(directory)) !== "") throw changed();
    for (const name of (await readdir(directory)).sort()) {
      check();
      const path = relativeDir ? `${relativeDir}/${name}` : name;
      if (name.toLowerCase() === ".git" || excluded.has(path)) continue;
      if (++visited > WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES) throw new Error("The workspace contains too many entries to copy.");
      if (!validPath(path)) { skip(path, "nonportable"); continue; }
      const key = workspaceDirectoryArchiveNameKey(path);
      if (folded.has(key)) { skip(path, "collision"); continue; }
      const absolute = pathWithin(root, path), identity = await lstat(absolute, { bigint: true });
      if (identity.isDirectory()) {
        folded.set(key, { kind: "directory", path });
        entries.push({ absolute, path, identity });
        await walk(path);
      } else if (identity.isFile()) {
        folded.set(key, { kind: "file", path });
        entries.push({ absolute, path, identity });
      } else if (identity.isSymbolicLink()) {
        const link = await readlink(absolute);
        folded.set(key, { kind: "link", path, target: link });
        entries.push({ absolute, path, identity, link });
      } else skip(path, "unsupported");
    }
  };
  await walk("");
  const kept = entries.filter(entry => {
    if (entry.link === undefined || resolveLink({ path: entry.path, target: entry.link }, folded) !== undefined) return true;
    skip(entry.path, "external_link");
    return false;
  });
  return { identity, entries: kept, summary: { skippedCount, skipped } };
}

function parseManifest(value: unknown, parts: ReadonlyMap<string, number>): WorkspaceManifest {
  const raw = record(value);
  if (raw?.["format"] !== 1 || !Array.isArray(raw["entries"]) || raw["entries"].length > WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES
    || typeof raw["skippedCount"] !== "number" || !Number.isSafeInteger(raw["skippedCount"]) || raw["skippedCount"] < 0
    || !Array.isArray(raw["skipped"]) || raw["skipped"].length > Math.min(raw["skippedCount"], MAXIMUM_REPORTED_SKIPS)) throw invalid();
  const skipped: TaskCopySkippedFile[] = raw["skipped"].map(value => {
    const item = record(value);
    if (typeof item?.["path"] !== "string" || item["path"].length > MAXIMUM_PATH_LENGTH || typeof item["reason"] !== "string"
      || !["nonportable", "collision", "external_link", "unsupported"].includes(item["reason"])) throw invalid();
    return { path: item["path"], reason: item["reason"] as SkipReason };
  });
  const repository = raw["repository"] === undefined ? undefined : record(raw["repository"]);
  if ((repository === undefined) !== !parts.has(repositoryName) || (raw["repository"] !== undefined && repository === undefined)) throw invalid();
  const seen = new Map<string, WorkspaceEntry>();
  let fileCount = 0;
  const entries = raw["entries"].map((value, index): WorkspaceEntry => {
    const entry = record(value);
    if (!entry || !validPath(entry["path"])) throw invalid();
    const path = entry["path"], key = workspaceDirectoryArchiveNameKey(path), parent = path.split("/").slice(0, -1).join("/");
    const parentEntry = seen.get(workspaceDirectoryArchiveNameKey(parent));
    if (seen.has(key) || parent && (parentEntry?.kind !== "directory" || parentEntry.path !== parent)) throw invalid();
    let checked: WorkspaceEntry;
    if (entry["kind"] === "link" && typeof entry["target"] === "string") checked = { kind: "link", path, target: entry["target"] };
    else {
      const mode = entry["mode"];
      if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw invalid();
      if (entry["kind"] === "directory") checked = { kind: "directory", path, mode };
      else {
        const size = entry["size"], sha256 = entry["sha256"];
        if (entry["kind"] !== "file" || typeof size !== "number" || parts.get(partName(index)) !== size
          || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) throw invalid();
        checked = { kind: "file", path, mode, size, sha256 };
        fileCount++;
      }
    }
    seen.set(key, checked);
    return checked;
  });
  if (parts.size !== fileCount + (repository ? 2 : 1)
    || entries.some(entry => entry.kind === "link" && resolveLink(entry, seen) === undefined)) throw invalid();
  return { format: 1, entries, skipped, skippedCount: raw["skippedCount"],
    ...(repository === undefined ? {} : { repository: repository as unknown as TaskCopyRepository }) };
}

function resolveLink(link: { readonly path: string; readonly target: string }, entries: ReadonlyMap<string, { readonly kind: WorkspaceEntry["kind"]; readonly target?: string }>): string | undefined {
  const relativeTarget = (target: string) => target.length > 0 && target.length <= MAXIMUM_PATH_LENGTH && !/[\\:\u0000-\u001f]/u.test(target) && !target.startsWith("/");
  if (!relativeTarget(link.target)) return undefined;
  const resolved = link.path.split("/").slice(0, -1);
  let pending = link.target.split("/"), hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") { if (resolved.pop() === undefined) return undefined; continue; }
    if (!isWorkspaceDirectoryArchiveName(part)) return undefined;
    resolved.push(part);
    const next = entries.get(workspaceDirectoryArchiveNameKey(resolved.join("/")))?.target;
    if (next === undefined) continue;
    if (++hops > 40 || !relativeTarget(next)) return undefined;
    resolved.pop();
    pending = [...next.split("/"), ...pending];
  }
  return resolved.join("/");
}

async function copyFileBytes(source: string, destination: string, identity: BigIntStats, mode: number, check: () => void): Promise<string> {
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (relative(source, await realpath(source)) !== "" || !sameIdentity(identity, await input.stat({ bigint: true }))) throw changed();
    const output = await open(destination, "wx", mode);
    try {
      const hash = createHash("sha256"), bytes = Buffer.allocUnsafe(128 * 1024);
      let offset = 0;
      for (;;) {
        check();
        const part = await input.read(bytes, 0, bytes.byteLength, null);
        if (part.bytesRead === 0) break;
        offset += part.bytesRead;
        if (BigInt(offset) > identity.size) throw changed();
        hash.update(bytes.subarray(0, part.bytesRead));
        for (let written = 0; written < part.bytesRead;) {
          const { bytesWritten } = await output.write(bytes, written, part.bytesRead - written, null);
          if (bytesWritten <= 0) throw new Error("A workspace copy file could not be written.");
          written += bytesWritten;
        }
      }
      if (BigInt(offset) !== identity.size || !sameIdentity(identity, await input.stat({ bigint: true }))
        || !sameIdentity(identity, await lstat(source, { bigint: true })) || relative(source, await realpath(source)) !== "") throw changed();
      if (process.platform !== "win32") await output.chmod(mode);
      await output.sync();
      return hash.digest("hex");
    } finally { await output.close(); }
  } finally { await input.close(); }
}

function workspacePolicy(input: WorkspaceCopyBudget) {
  let bytes = 0;
  return { get bytes() { return bytes; }, check: () => { input.signal.throwIfAborted(); input.assertCurrent(); }, count: (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || (bytes += size) > input.maximumBytes) throw new Error("Workspace data exceeds the copy limit.");
  } };
}

function validPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAXIMUM_PATH_LENGTH) return false;
  const components = value.split("/");
  return components.length <= MAXIMUM_PATH_DEPTH && components.every(isWorkspaceDirectoryArchiveName);
}

function pathWithin(root: string, path: string): string {
  const absolute = join(root, ...path.split("/"));
  if (!contained(root, absolute)) throw invalid();
  return absolute;
}

function contained(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== "" && !isAbsolute(local) && local.split(/[\\/]/u)[0] !== "..";
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function partName(index: number): string { return `part-${index}`; }
function changed(): Error { return new Error("The original workspace changed during capture. Try again when its files are idle."); }
function invalid(): Error { return new Error("The workspace copy does not match its approved archive."); }
