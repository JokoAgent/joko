import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { redactSecrets, type AdapterContext } from "@joko/core";
import { isShareCredentialPath, textSpellsOutSecret } from "./hosted-agent-credentials.js";

export interface HostedProjectFile { readonly path: string; readonly content: string }
export interface SourceProjectFilesOptions {
  readonly assertCurrent?: () => void;
  /** Current Source resource/skill policy, never inferred from directory names. */
  readonly resourceAllowed?: (file: { readonly relativePath: string; readonly absolutePath: string; readonly realPath: string }, context: AdapterContext) => boolean | Promise<boolean>;
}
const INSTRUCTIONS = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", "AGENTS.override.md"] as const;
const SETTINGS = [".claude/settings.json", ".claude/settings.local.json"] as const;
const DIRECTORIES = [".claude/skills", ".claude/agents", ".claude/commands", ".claude/rules", ".agents/skills", ".codex/skills", ".pi/skills", ".pi/prompts"] as const;
const MAX_FILES = 128, MAX_FILE_BYTES = 512 * 1024, MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_JSON_BYTES = 6 * 1024 * 1024, VIRTUAL_PATH_RESERVE_BYTES = 128 * 1024;
const MAX_DEPTH = 6, MAX_CANDIDATES = 4096;
const MANIFEST = ".joko-project-snapshot.json", MAX_MANIFEST_BYTES = 1024 * 1024;
const locks = new Map<string, Promise<void>>();
interface Candidate { readonly path: string; readonly absolutePath: string; readonly entry: boolean; readonly resource: boolean }
interface ManifestEntry { readonly path: string; readonly sha256: string; readonly previousSha256?: string }

/** Bounded Source-only collection. No ancestor, HOME, source-tree scan or
 * instruction-import expansion occurs. Missing/unsafe candidates are skipped;
 * stale authority interrupts the entire snapshot. */
export async function snapshotSourceProjectFiles(context: AdapterContext, options: SourceProjectFilesOptions = {}): Promise<readonly HostedProjectFile[]> {
  const guard = () => { context.signal.throwIfAborted(); options.assertCurrent?.(); };
  guard();
  if (!context.target.trusted || context.target.remoteWorkspace || context.hostedExecution) throw new Error("Project instructions require a trusted Source workspace.");
  const root = await canonicalDirectory(context.target.workspaceRoot, guard);
  const personalInstructions = context.appendSystemPrompt;
  if (personalInstructions !== undefined && personalInstructions.length > 1024 * 1024) throw new Error("Source instructions exceed their limit.");
  if (contextBytes([], personalInstructions) > MAX_CONTEXT_JSON_BYTES - VIRTUAL_PATH_RESERVE_BYTES) throw new Error("Source instructions exceed their limit.");
  const out: HostedProjectFile[] = [], measured: HostedProjectFile[] = [], candidates: Candidate[] = [];
  let bytes = 0, visited = 0;
  const add = async (candidate: Candidate, settings = false): Promise<void> => {
    guard(); if (out.length >= MAX_FILES) return;
    try {
      const actual = await realpath(candidate.absolutePath); guard();
      if (!inside(actual, root) || !settings && (isShareCredentialPath(candidate.absolutePath) || isShareCredentialPath(actual))
        || settings && key(actual) !== key(candidate.absolutePath) && isShareCredentialPath(actual)) return;
      if (candidate.resource && !await options.resourceAllowed?.({ relativePath: candidate.path, absolutePath: candidate.absolutePath, realPath: actual }, context)) return;
      guard();
      const data = await readInside(root, candidate.path, MAX_FILE_BYTES, guard, true);
      if (!data) return;
      let content = decodeText(data);
      if (content === undefined) return;
      if (settings) { const sanitized = sanitizeSettings(content); if (sanitized === undefined) return; content = sanitized; }
      if (hasCredentials(content)) return;
      // Budget the largest Host-safe import form. Keeping an approved relative
      // import active can only reduce this size; no candidate is truncated.
      const bounded = instructionContent(content, candidate.path, new Set()), size = Buffer.byteLength(bounded);
      if (size > MAX_FILE_BYTES || bytes + size > MAX_TOTAL_BYTES || contextBytes([...measured, { path: candidate.path, content: bounded }], personalInstructions) > MAX_CONTEXT_JSON_BYTES - VIRTUAL_PATH_RESERVE_BYTES) return;
      guard(); out.push({ path: candidate.path, content }); measured.push({ path: candidate.path, content: bounded }); bytes += size;
    } catch { guard(); }
  };
  for (const name of INSTRUCTIONS) await add({ path: name, absolutePath: path.join(root, ...name.split("/")), entry: true, resource: false });
  for (const name of SETTINGS) await add({ path: name, absolutePath: path.join(root, ...name.split("/")), entry: true, resource: false }, true);
  const scan = async (prefix: string, within: string, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
    guard(); if (depth > MAX_DEPTH || visited >= MAX_CANDIDATES) return;
    const relative = within ? `${prefix}/${within}` : prefix, directory = path.join(root, ...relative.split("/"));
    let entries: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      const actual = await realpath(directory); guard();
      if (!inside(actual, root) || key(actual) === key(root) || ancestors.has(key(actual)) || isShareCredentialPath(actual)) return;
      const next = new Set(ancestors).add(key(actual)); entries = await opendir(directory);
      for await (const entry of entries) {
        guard(); if (++visited > MAX_CANDIDATES) break;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const child = within ? `${within}/${entry.name}` : entry.name, relativePath = `${prefix}/${child}`;
        if (!allowedPath(relativePath)) continue;
        const absolutePath = path.join(directory, entry.name);
        try {
          const linked = entry.isSymbolicLink() ? await lstat(await realpath(absolutePath)) : undefined;
          if (linked?.isDirectory() || entry.isDirectory()) await scan(prefix, child, depth + 1, next);
          else if (linked?.isFile() || entry.isFile()) {
            const parts = child.split("/"), skills = prefix.endsWith("/skills");
            candidates.push({ path: relativePath, absolutePath, resource: prefix !== ".claude/rules",
              entry: skills ? parts.length === 2 && parts[1] === "SKILL.md" || parts.length === 1 && /\.md$/iu.test(parts[0]!) : /\.md$/iu.test(parts.at(-1)!) });
          }
        } catch { guard(); }
      }
      entries = undefined;
    } catch { guard(); }
    finally { await entries?.close().catch(() => {}); }
  };
  for (const directory of DIRECTORIES) if (directory === ".claude/rules" || options.resourceAllowed) await scan(directory, "", 0, new Set());
  for (const entry of [true, false]) for (const candidate of candidates) if (candidate.entry === entry) await add(candidate);
  guard(); return out;
}

export interface HostedProjectMaterialization {
  readonly root: string;
  readonly files: readonly HostedProjectFile[];
  readonly assertCurrent: () => void;
  /** Included only in the aggregate size check; never written to the workspace. */
  readonly personalInstructions?: string;
}
/** Writes only this run's approved snapshots and its private ownership manifest.
 * Files changed by an SDK/user are preserved and require explicit recovery;
 * an older manifest cannot authorize deletion of unknown workspace content. */
export async function materializeHostedProjectFiles(input: HostedProjectMaterialization): Promise<readonly HostedProjectFile[]> {
  const guard = input.assertCurrent, root = await canonicalDirectory(input.root, guard), lockKey = key(root);
  const prior = locks.get(lockKey) ?? Promise.resolve();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const queued = prior.catch(() => {}).then(() => held); locks.set(lockKey, queued);
  await prior.catch(() => {});
  try { return await materialize(root, input.files, guard, input.personalInstructions); }
  finally { release(); if (locks.get(lockKey) === queued) locks.delete(lockKey); }
}
async function materialize(root: string, files: readonly HostedProjectFile[], guard: () => void, personalInstructions?: string): Promise<readonly HostedProjectFile[]> {
  guard();
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error("Hosted project snapshots exceed their limit.");
  if (personalInstructions !== undefined && (typeof personalInstructions !== "string" || personalInstructions.length > 1024 * 1024)) throw new Error("Hosted project instructions exceed their limit.");
  let bytes = 0; const unique = new Set<string>();
  for (const file of files) {
    if (!file || !allowedPath(file.path) || !SETTINGS.includes(file.path as typeof SETTINGS[number]) && isShareCredentialPath(`/${file.path}`)
      || typeof file.content !== "string" || file.content.includes("\0") || hasCredentials(file.content)) throw new Error("Hosted project snapshot is invalid.");
    const size = Buffer.byteLength(file.content); bytes += size;
    if (size > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES || unique.has(key(file.path))) throw new Error("Hosted project snapshots exceed their limit."); unique.add(key(file.path));
    if (SETTINGS.includes(file.path as typeof SETTINGS[number]) && sanitizeSettings(file.content) !== file.content) throw new Error("Hosted project settings are not sanitized.");
  }
  const prepared = files.map(file => ({ path: file.path, content: instructionContent(file.content, file.path, unique) }));
  if (prepared.some(file => Buffer.byteLength(file.content) > MAX_FILE_BYTES) || prepared.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > MAX_TOTAL_BYTES) throw new Error("Hosted project snapshots exceed their limit.");
  const virtual = prepared.map(file => ({ path: path.join(root, ...file.path.split("/")), content: file.content }));
  if (contextBytes(virtual, personalInstructions) > MAX_CONTEXT_JSON_BYTES) throw new Error("Hosted project instructions exceed their limit.");
  const previous = await readManifest(root, guard);
  const prior = new Map(previous.map(entry => [key(entry.path), entry]));
  // Validate the entire old/new ownership set before modifying any snapshot.
  const existing = new Map<string, string>();
  for (const entry of previous) { const digest = await assertOwned(root, entry, guard); if (digest) existing.set(key(entry.path), digest); }
  for (const file of prepared) {
    const data = await readInside(root, file.path, MAX_FILE_BYTES, guard, false);
    if (data && !prior.has(key(file.path))) throw new Error("An unowned workspace file conflicts with project instructions.");
  }
  const next: ManifestEntry[] = prepared.map(file => ({ path: file.path, sha256: sha(file.content) }));
  // Record cleanup ownership before effects. Interrupted materializations retain
  // enough old/new identities for a later explicit retry, without broad scans.
  const journal = [...previous.filter(entry => !unique.has(key(entry.path)) && existing.has(key(entry.path))), ...next.map(entry => {
    const previousSha256 = existing.get(key(entry.path));
    return previousSha256 && previousSha256 !== entry.sha256 ? { ...entry, previousSha256 } : entry;
  })];
  if (journal.length > MAX_FILES * 2) throw new Error("Hosted project ownership manifest exceeds its limit.");
  await writeInside(root, MANIFEST, Buffer.from(JSON.stringify({ format: 1, files: journal })), guard, true);
  for (const entry of previous) if (!unique.has(key(entry.path))) {
    const digest = await assertOwned(root, entry, guard); guard(); if (!digest) continue;
    await unlink(path.join(root, ...entry.path.split("/"))).catch(error => { if (!missing(error)) throw error; }); guard();
  }
  for (const file of prepared) await writeInside(root, file.path, Buffer.from(file.content), guard, false, existing.get(key(file.path)) ?? null);
  await writeInside(root, MANIFEST, Buffer.from(JSON.stringify({ format: 1, files: next })), guard, true);
  guard(); return virtual;
}
async function readManifest(root: string, guard: () => void): Promise<readonly ManifestEntry[]> {
  const data = await readInside(root, MANIFEST, MAX_MANIFEST_BYTES, guard, false);
  if (!data) return [];
  let parsed: unknown; try { parsed = JSON.parse(data.toString("utf8")); } catch { throw new Error("Hosted project ownership manifest is invalid."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hosted project ownership manifest is invalid.");
  const value = parsed as Record<string, unknown>;
  if (value.format !== 1 || !Array.isArray(value.files) || value.files.length > MAX_FILES * 2) throw new Error("Hosted project ownership manifest is invalid.");
  const seen = new Set<string>();
  return value.files.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Hosted project ownership manifest is invalid.");
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !allowedPath(file.path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || file.previousSha256 !== undefined && (typeof file.previousSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.previousSha256)) || seen.has(key(file.path))) throw new Error("Hosted project ownership manifest is invalid.");
    seen.add(key(file.path)); return { path: file.path, sha256: file.sha256, ...(file.previousSha256 === undefined ? {} : { previousSha256: file.previousSha256 as string }) };
  });
}
async function assertOwned(root: string, entry: ManifestEntry, guard: () => void): Promise<string | undefined> {
  const data = await readInside(root, entry.path, MAX_FILE_BYTES, guard, false);
  const digest = data && sha(data);
  if (digest && digest !== entry.sha256 && digest !== entry.previousSha256) throw new Error("Hosted project instructions were modified outside their snapshot.");
  return digest;
}
async function canonicalDirectory(value: string, guard: () => void): Promise<string> {
  guard(); if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Hosted project root is invalid.");
  const resolved = path.resolve(value), info = await lstat(resolved); guard();
  const actual = await realpath(resolved); guard();
  if (!info.isDirectory() || info.isSymbolicLink() || key(actual) !== key(resolved)) throw new Error("Hosted project root is not canonical.");
  return actual;
}
async function readInside(root: string, relative: string, maximum: number, guard: () => void, followLinks: boolean): Promise<Buffer | undefined> {
  const candidate = path.join(root, ...relative.split("/")); let file: FileHandle | undefined;
  try {
    guard();
    if (!followLinks) {
      if (!await checkParents(root, relative, guard, false, true)) return undefined;
      const leaf = await lstat(candidate); guard();
      if (!leaf.isFile() || leaf.isSymbolicLink()) throw new Error("Project file is not regular.");
    }
    const actual = await realpath(candidate); guard();
    if (!inside(actual, root)) throw new Error("Project file escapes its workspace.");
    const leaf = await lstat(followLinks ? actual : candidate); guard();
    if (!leaf.isFile() || leaf.isSymbolicLink()) throw new Error("Project file is not regular.");
    file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); guard();
    const before = await file.stat({ bigint: true }); guard();
    if (!before.isFile() || before.size > BigInt(maximum) || !followLinks && before.nlink !== 1n) throw new Error("Project file exceeds its limit.");
    const data = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < data.length) { const got = await file.read(data, length, data.length - length, length); guard(); if (!got.bytesRead) break; length += got.bytesRead; }
    const after = await file.stat({ bigint: true }), now = await lstat(actual, { bigint: true }); guard();
    if (!sameFile(before, after) || !sameFile(after, now) || after.size !== BigInt(length) || key(await realpath(candidate)) !== key(actual)) throw new Error("Project file changed while being read.");
    guard(); return data.subarray(0, length);
  } catch (error) { guard(); if (missing(error)) return undefined; throw error; }
  finally { await file?.close(); }
}
async function checkParents(root: string, relative: string, guard: () => void, create: boolean, allowMissing = false): Promise<boolean> {
  let directory = await canonicalDirectory(root, guard);
  for (const part of relative.split("/").slice(0, -1)) {
    directory = path.join(directory, part); guard();
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    let info;
    try { info = await lstat(directory); guard(); }
    catch (error) { guard(); if (allowMissing && missing(error)) return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Hosted project directory is unsafe.");
    const actual = await realpath(directory); guard();
    if (!inside(actual, root) || key(actual) !== key(directory)) throw new Error("Hosted project directory is unsafe.");
  }
  return true;
}
async function writeInside(root: string, relative: string, data: Buffer, guard: () => void, manifest = false, expected?: string | null): Promise<void> {
  guard(); if (manifest ? relative !== MANIFEST || data.length > MAX_MANIFEST_BYTES : !allowedPath(relative) || data.length > MAX_FILE_BYTES) throw new Error("Hosted project write is invalid.");
  await checkParents(root, relative, guard, true); const target = path.join(root, ...relative.split("/"));
  const temporary = path.join(path.dirname(target), `.joko-project-${randomUUID()}.tmp`);
  let file: FileHandle | undefined, identity: BigIntStats | undefined;
  try {
    const before = await lstat(target, { bigint: true }).catch(error => { if (!missing(error)) throw error; return undefined; }); guard();
    const current = await readInside(root, relative, manifest ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES, guard, false);
    if (expected !== undefined && current && (expected === null || sha(current) !== expected)) throw new Error("Hosted project write target changed outside its snapshot.");
    const checked = await lstat(target, { bigint: true }).catch(error => { if (!missing(error)) throw error; return undefined; }); guard();
    if (before ? !checked || !sameFile(before, checked) : checked) throw new Error("Hosted project write target changed outside its snapshot.");
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    identity = await file.stat({ bigint: true }); guard();
    if (!identity.isFile() || identity.nlink !== 1n) throw new Error("Hosted project write target is unsafe.");
    await file.writeFile(data); await file.sync(); await file.close(); file = undefined; guard();
    await checkParents(root, relative, guard, false);
    const leaf = await lstat(target, { bigint: true }).catch(error => { if (!missing(error)) throw error; return undefined; }); guard();
    if (before ? !leaf || leaf.isSymbolicLink() || !sameFile(before, leaf) : leaf) throw new Error("Hosted project write target changed outside its snapshot.");
    await rename(temporary, target); guard();
  } finally {
    await file?.close();
    // Only this invocation's random temporary inode may be removed. Interrupted
    // atomic replacements leave the old or new complete file owned by journal.
    const leftover = await lstat(temporary, { bigint: true }).catch(error => { if (!missing(error)) throw error; return undefined; });
    if (identity && leftover && !leftover.isSymbolicLink() && leftover.dev === identity.dev && leftover.ino === identity.ino) await unlink(temporary);
  }
}
function allowedPath(value: string): boolean {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\\") || value.startsWith("/")) return false;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part === ".git" || part === "node_modules" || /[<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) return false;
  if (INSTRUCTIONS.includes(value as typeof INSTRUCTIONS[number]) || SETTINGS.includes(value as typeof SETTINGS[number])) return true;
  return DIRECTORIES.some(directory => value.startsWith(`${directory}/`) && value.slice(directory.length + 1).split("/").length <= MAX_DEPTH + 1);
}
function sanitizeSettings(content: string): string | undefined {
  let value: unknown; try { value = JSON.parse(content); } catch { return undefined; }
  const permissions = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).permissions : undefined;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return undefined;
  const kept: Record<string, string[]> = {};
  for (const name of ["allow", "deny", "ask"]) {
    const rules = (permissions as Record<string, unknown>)[name];
    if (Array.isArray(rules)) kept[name] = rules.filter((rule): rule is string => typeof rule === "string" && !!rule && rule.length <= 4096).slice(0, 512);
  }
  return Object.values(kept).some(rules => rules.length) ? JSON.stringify({ permissions: kept }, null, 2) : undefined;
}
function protectImports(text: string, file: string, approved: ReadonlySet<string>): string {
  let fence: string | undefined;
  return text.split(/(\r?\n)/u).map(line => {
    const marker = /^\s*(```|~~~)/u.exec(line)?.[1];
    if (fence) { if (marker === fence) fence = undefined; return line; }
    if (marker) { fence = marker; return line; }
    return line.split(/(`+[^`]*`+)/u).map((part, index) => index % 2 ? part : part.replace(/(^|[\s(])@([^\s`'"()<>[\]{}]+)/gu, (whole, prefix: string, candidate: string) => {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), candidate.replaceAll("\\", "/")));
      return !/^(?:[~\/]|[A-Za-z]:)/u.test(candidate) && allowedPath(relative) && approved.has(key(relative)) ? whole : `${prefix}\`@${candidate}\``;
    })).join("");
  }).join("");
}
function instructionContent(text: string, file: string, approved: ReadonlySet<string>): string { return /\.(?:md|markdown|txt)$/iu.test(file) ? protectImports(text, file, approved) : text; }
function contextBytes(files: readonly HostedProjectFile[], instructions?: string): number { return Buffer.byteLength(JSON.stringify({ instructions, files })); }
function hasCredentials(content: string): boolean { return textSpellsOutSecret(content) || redactSecrets(content) !== content; }
function decodeText(data: Buffer): string | undefined { if (data.includes(0)) return undefined; try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return undefined; } }
function sha(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function key(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
function inside(child: string, parent: string): boolean { const relative = path.relative(parent, child); return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs; }
function missing(error: unknown): boolean { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }
