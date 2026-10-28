import { randomUUID } from "node:crypto";
import { readWorkerWorkspaceBinding } from "../collaboration-worker-workspace.js";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { OperationalStore } from "@joko/store";
import type { BridgeToolCallContext } from "../mcp-router.js";
import type { WorkspaceService } from "../workspace-service.js";
import type { ExtensionCardScope } from "./service.js";
import type { RemoteFileAuthority } from "../remote-execution-router.js";
import type { RemoteWorkspaceBinding } from "@joko/core";
import type { ExtraDirectoryManager } from "../extra-directory-manager.js";

export const EXTENSION_FILE_MAXIMUM = 256 * 1024 * 1024;
export const EXTENSION_DIRECTORY_FILE_MAXIMUM = 50 * 1024 * 1024;
export const EXTENSION_DIRECTORY_MAXIMUM = 500 * 1024 * 1024;
const TTL = 10 * 60_000, MAX_FILES = 500, MAX_SAVE_USES = 16, MAX_SAVE_BYTES = 512 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg", ".idea", ".vscode", ".DS_Store", "__pycache__", ".next", ".turbo", ".cache"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db", ".gitignore", ".gitattributes", ".npmrc"]);
const excludedFile = (name: string) => EXCLUDED_FILES.has(name) || name === ".env" || name.startsWith(".env.");
export interface ExtensionFileWorkspace { readonly root: string; readonly assertCurrent: () => void; readonly remote?: RemoteFileAuthority; readonly signal?: AbortSignal;
  readonly extraRoots?: readonly { readonly path: string; readonly access: "read_only" | "read_write" }[] }
interface File { readonly absolute: string; readonly relative: string; readonly size: number; readonly read?: () => Promise<Uint8Array> }
interface Deposit { readonly owner: string; readonly expiresAt: number; readonly current: () => void; readonly root: string; readonly workspace: ExtensionFileWorkspace }
interface DirectoryDeposit extends Deposit { readonly files: readonly File[] }
interface SaveDeposit extends Deposit { uses: number; bytes: number }
export interface ExtensionDirectoryTransfer { readonly files: readonly { readonly relPath: string; readonly size: number; read(): Promise<Uint8Array> }[] }
const owner = (scope: ExtensionCardScope) => JSON.stringify([scope.extensionId, scope.authorityKey, scope.sessionId, scope.sessionCreatedAt, scope.targetId]);
const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
function within(root: string, file: string): boolean {
  const relative = path.relative(process.platform === "win32" ? root.toLowerCase() : root, process.platform === "win32" ? file.toLowerCase() : file);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The host captures the actual task workspace; a remote path is never treated
 * as a local path. Registration and trust remain live throughout a transfer. */
export async function captureExtensionFileWorkspace(store: OperationalStore, workspaces: Pick<WorkspaceService, "listRegistrations">, context: BridgeToolCallContext,
  captureRemote?: (binding: RemoteWorkspaceBinding, signal?: AbortSignal) => Promise<RemoteFileAuthority>, signal?: AbortSignal,
  extraDirectories?: Pick<ExtraDirectoryManager, "resolveSelection" | "listForTarget">): Promise<ExtensionFileWorkspace> {
  const session = store.getSession(context.sessionId).descriptor, target = store.getTarget(context.targetId);
  const metadata = target.metadata as { workspaceId?: unknown } | undefined;
  const workerWorkspace = readWorkerWorkspaceBinding(store, session.id);
  const workspaceId = workerWorkspace?.workspaceId ?? session.worktree?.workspaceId ?? (typeof metadata?.workspaceId === "string" ? metadata.workspaceId : context.targetId);
  const registration = workspaces.listRegistrations().find(value => value.id === workspaceId);
  if (!registration || !registration.trusted || !target.descriptor.trusted) throw new Error("A trusted task workspace is required for file transfer.");
  const binding = JSON.stringify(target.descriptor.remoteWorkspace);
  const remote = registration.remote ? await captureRemote?.(registration.remote.binding, signal) : undefined;
  if (registration.remote && !remote) throw new Error("The remote file transport is unavailable.");
  // These approvals name paths on the service node. Never reinterpret them on
  // a remote machine merely because it uses the same spelling or path style.
  const selectedExtras = () => {
    if (registration.remote || !extraDirectories) return [];
    const calls = store.listQueueItems({ sessionId: context.sessionId, states: ["dispatching", "backend_accepted"], limit: 100 });
    const selections = calls.map(call => extraDirectories.resolveSelection(context.targetId, call.executionOverrides?.extraDirectoryIds));
    const available = selections.length ? selections[0]! : extraDirectories.listForTarget(context.targetId);
    return available.filter(directory => selections.every(selection => selection.some(value => value.id === directory.id && value.path === directory.path && value.access === directory.access)));
  };
  const extraSnapshot = selectedExtras(), extraIdentity = JSON.stringify(extraSnapshot, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  const assertCurrent = () => {
    signal?.throwIfAborted(); remote?.assertCurrent();
    const current = store.getSession(context.sessionId).descriptor, selected = store.getTarget(context.targetId).descriptor;
    if (!workspaces.listRegistrations().includes(registration) || !registration.trusted || !selected.trusted || JSON.stringify(selected.remoteWorkspace) !== binding
      || current.createdAt !== session.createdAt || current.targetId !== context.targetId || current.binding.generation !== context.generation
      || current.archived || current.deletedAt !== undefined || current.worktree?.workspaceId !== session.worktree?.workspaceId
      || JSON.stringify(readWorkerWorkspaceBinding(store, current.id)) !== JSON.stringify(workerWorkspace)
      || store.findPendingSessionLifecycleCleanup(context.sessionId) || store.findSessionRuntimePolicy(context.sessionId)?.policy === "review_read_only") throw new Error("Extension file authority changed.");
    if (JSON.stringify(selectedExtras(), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value) !== extraIdentity) throw new Error("Approved extension file directories changed.");
  };
  assertCurrent(); return { root: registration.root, assertCurrent, extraRoots: extraSnapshot.map(({ path, access }) => ({ path, access })), ...(remote ? { remote } : {}), ...(signal ? { signal } : {}) };
}

/** Short-lived host-only capabilities. File bytes and absolute paths never
 * enter the isolated page; receipts cannot be moved to another task/source. */
export class ExtensionFileDeposits {
  readonly #directories = new Map<string, DirectoryDeposit>();
  readonly #saves = new Map<string, SaveDeposit>();
  constructor(private readonly now: () => number = Date.now) {}
  #sweep(): void {
    for (const records of [this.#directories, this.#saves]) for (const [token, value] of records) if (value.expiresAt <= this.now()) records.delete(token);
  }
  retire(authorityKey: string): void {
    for (const records of [this.#directories, this.#saves]) for (const [token, value] of records) if ((JSON.parse(value.owner) as string[])[1] === authorityKey) records.delete(token);
  }
  async prepare(scope: ExtensionCardScope, arguments_: Readonly<Record<string, unknown>>, workspace: ExtensionFileWorkspace, assertCurrent: () => void): Promise<Readonly<Record<string, unknown>>> {
    if (arguments_.dir_deposit !== undefined || arguments_.save_deposit !== undefined) throw new Error("File receipts are issued by the host.");
    const { dir, save_dir, ...rest } = arguments_;
    const args: Record<string, unknown> = { ...rest };
    const current = () => { workspace.assertCurrent(); assertCurrent(); };
    current(); this.#sweep();
    if (this.#directories.size + this.#saves.size >= 256) throw new Error("Extension file capacity reached. Retry after current transfers finish.");
    const remote = workspace.remote, api = remote?.pathStyle === "posix" ? path.posix : remote?.pathStyle === "win32" ? path.win32 : path;
    const canonical = (value: string) => remote ? remote.files.realpath(value, workspace.signal) : realpath(value);
    const isWithin = (parent: string, child: string) => {
      const fold = (value: string) => api === path.win32 || !remote && process.platform === "win32" ? value.toLowerCase() : value;
      const relative = api.relative(fold(parent), fold(child));
      return relative === "" || relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
    };
    const root = await canonical(workspace.root); current();
    const extraRoots = await Promise.all((workspace.extraRoots ?? []).map(async approved => {
      const resolved = await canonical(approved.path); current();
      if (!samePath(resolved, approved.path)) throw new Error("An approved extension directory changed.");
      return { path: resolved, access: approved.access };
    }));
    const resolve = async (value: unknown, write: boolean) => {
      if (typeof value !== "string" || !api.isAbsolute(value) || value.length > 4096 || value.includes("\0")) throw new Error("An absolute task workspace path is required.");
      const resolved = await canonical(value); current();
      if (!isWithin(root, resolved) && !extraRoots.some(approved => (!write || approved.access === "read_write") && isWithin(approved.path, resolved))) throw new Error("File transfers must remain inside the approved task workspace and its permitted directories.");
      return resolved;
    };
    const issued: string[] = [];
    try {
      if (dir !== undefined) {
        const directory = await resolve(dir, false), files: File[] = []; let total = 0;
        const add = (absolute: string, relative: string, size: number) => {
          if (excludedFile(api.basename(absolute))) return;
          if (size > EXTENSION_DIRECTORY_FILE_MAXIMUM || files.length >= MAX_FILES || (total += size) > EXTENSION_DIRECTORY_MAXIMUM) throw new Error("Directory transfer exceeds its file or byte budget.");
          const read = remote ? async () => {
            current();
            if (await canonical(directory) !== directory || !isWithin(directory, await canonical(absolute))) throw new Error("The remote transfer path changed.");
            const before = await remote.files.stat(absolute, workspace.signal); current();
            if (before.kind !== "file" || before.size > EXTENSION_DIRECTORY_FILE_MAXIMUM) throw new Error("The remote transfer file changed.");
            const bytes = await remote.files.read({ path: absolute, maximumBytes: EXTENSION_DIRECTORY_FILE_MAXIMUM, ...(workspace.signal ? { signal: workspace.signal } : {}) }); current();
            const after = await remote.files.stat(absolute, workspace.signal); current();
            if (JSON.stringify(before) !== JSON.stringify(after) || bytes.byteLength !== before.size || await canonical(directory) !== directory || !isWithin(directory, await canonical(absolute))) throw new Error("The remote transfer file changed.");
            current(); return bytes;
          } : undefined;
          files.push({ absolute, relative, size, ...(read ? { read } : {}) });
        };
        const info = remote ? await remote.files.stat(directory, workspace.signal) : await lstat(directory); current();
        const walk = async (absolute: string): Promise<void> => {
          current();
          if (await canonical(directory) !== directory || !isWithin(directory, await canonical(absolute))) throw new Error("The transfer directory changed.");
          const entries = remote ? await remote.files.list(absolute, workspace.signal) : await readdir(absolute, { withFileTypes: true }); current();
          for (const entry of entries) {
            if (!entry.name || entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\\")) throw new Error("The transfer directory entry is invalid.");
            const file = api.join(absolute, entry.name);
            const directoryEntry = "kind" in entry ? entry.kind === "directory" : entry.isDirectory(), fileEntry = "kind" in entry ? entry.kind === "file" : entry.isFile();
            if (directoryEntry && !EXCLUDED_DIRECTORIES.has(entry.name)) await walk(file);
            else if (fileEntry && !excludedFile(entry.name)) {
              const info = remote ? await remote.files.stat(file, workspace.signal) : await lstat(file); current();
              if ("kind" in info ? info.kind === "file" : info.isFile()) add(file, api.relative(directory, file).split(api.sep).join("/"), info.size);
            }
          }
        };
        if ("kind" in info ? info.kind === "file" : info.isFile()) add(directory, api.basename(directory), info.size);
        else if ("kind" in info ? info.kind === "directory" : info.isDirectory()) await walk(directory);
        else throw new Error("The transfer path must be a file or directory.");
        if (!files.length) throw new Error("No transferable files were found.");
        current(); const token = randomUUID(); issued.push(token);
        this.#directories.set(token, { owner: owner(scope), expiresAt: this.now() + TTL, current, root: directory, workspace, files });
        args.dir_deposit = { token, file_count: files.length, total_bytes: total, rel_paths: files.map(file => file.relative) };
      }
      if (save_dir !== undefined) {
        const directory = await resolve(save_dir, true), info = remote ? await remote.files.stat(directory, workspace.signal) : await lstat(directory); current();
        if (!("kind" in info ? info.kind === "directory" : info.isDirectory())) throw new Error("The save path must be an existing directory.");
        const token = randomUUID(); issued.push(token);
        this.#saves.set(token, { owner: owner(scope), expiresAt: this.now() + TTL, current, root: directory, workspace, uses: MAX_SAVE_USES, bytes: MAX_SAVE_BYTES });
        args.save_deposit = { token, dir_name: api.basename(directory) };
      }
      current(); return args;
    } catch (error) { for (const token of issued) { this.#directories.delete(token); this.#saves.delete(token); } throw error; }
  }
  take(scope: ExtensionCardScope, token: string): ExtensionDirectoryTransfer | undefined {
    this.#sweep(); const entry = this.#directories.get(token);
    if (!entry || entry.owner !== owner(scope)) return;
    entry.current(); this.#directories.delete(token);
    return { files: entry.files.map(file => ({ relPath: file.relative, size: file.size, read: async () => {
      entry.current();
      if (file.read) return file.read();
      if (!samePath(await realpath(entry.root), entry.root) || !within(entry.root, await realpath(file.absolute))) throw new Error("The transferred file changed.");
      const handle = await open(file.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat(), actual = await stat(file.absolute); entry.current();
        if (!before.isFile() || before.size > EXTENSION_DIRECTORY_FILE_MAXIMUM || actual.dev !== before.dev || actual.ino !== before.ino
          || !samePath(await realpath(entry.root), entry.root) || !within(entry.root, await realpath(file.absolute))) throw new Error("The transferred file changed.");
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.byteLength) { entry.current(); const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await handle.stat(), current = await stat(file.absolute); entry.current();
        if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.dev !== before.dev || current.ino !== before.ino
          || !samePath(await realpath(entry.root), entry.root) || !within(entry.root, await realpath(file.absolute))) throw new Error("The transferred file changed.");
        return bytes;
      } finally { await handle.close(); }
    } })) };
  }
  async write(scope: ExtensionCardScope, token: string, suggested: string, bytes: Uint8Array, current: () => void): Promise<string | undefined> {
    this.#sweep(); const entry = this.#saves.get(token);
    if (!entry || entry.owner !== owner(scope) || entry.uses <= 0 || entry.bytes < bytes.byteLength || bytes.byteLength > EXTENSION_FILE_MAXIMUM) return;
    entry.current(); current();
    // Reserve synchronously, so concurrent downloads cannot exceed the budget.
    entry.uses--; entry.bytes -= bytes.byteLength;
    const name = sanitizeExtensionSaveName(suggested), extension = path.extname(name), stem = name.slice(0, name.length - extension.length);
    const remote = entry.workspace.remote;
    if (remote) {
      const api = remote.pathStyle === "win32" ? path.win32 : path.posix;
      for (let index = 0; index < 10_000; index++) {
        entry.current(); current();
        if (await remote.files.realpath(entry.root, entry.workspace.signal) !== entry.root) return;
        const candidate = index ? `${stem} (${index})${extension}` : name, target = api.join(entry.root, candidate);
        let existing;
        try { existing = await remote.files.stat(target, entry.workspace.signal); } catch { entry.current(); current(); }
        if (existing) continue;
        entry.current(); current();
        // The transport performs exclusive creation at the target host. A lost
        // acknowledgement is never reissued under a different filename.
        await remote.files.write({ path: target, content: bytes, createOnly: true, ...(entry.workspace.signal ? { signal: entry.workspace.signal } : {}) });
        entry.current(); current();
        const actual = await remote.files.stat(target, entry.workspace.signal);
        if (actual.kind !== "file" || actual.size !== bytes.byteLength || await remote.files.realpath(entry.root, entry.workspace.signal) !== entry.root || await remote.files.realpath(target, entry.workspace.signal) !== target) throw new Error("The remote save destination changed.");
        entry.current(); current(); return candidate;
      }
      return;
    }
    for (let index = 0; index < 10_000; index++) {
      entry.current(); current(); if (!samePath(await realpath(entry.root), entry.root)) return;
      const candidate = index ? `${stem} (${index})${extension}` : name, target = path.join(entry.root, candidate);
      let handle;
      try { handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o666); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      const opened = await handle.stat(); let accepted = false;
      try {
        const validate = async () => {
          entry.current(); current(); const actual = await stat(target);
          if (!opened.isFile() || !samePath(await realpath(entry.root), entry.root) || !samePath(path.dirname(await realpath(target)), entry.root)
            || actual.dev !== opened.dev || actual.ino !== opened.ino) throw new Error("The save destination changed.");
          entry.current(); current();
        };
        await validate(); await handle.writeFile(bytes); await validate(); await handle.close(); accepted = true;
        return candidate;
      } finally {
        if (!accepted) {
          await handle.truncate(0).catch(() => undefined); await handle.close().catch(() => undefined);
          const actual = await lstat(target).catch(() => undefined);
          if (actual?.dev === opened.dev && actual?.ino === opened.ino) await unlink(target).catch(() => undefined);
        }
      }
    }
    return;
  }
}
export function sanitizeExtensionSaveName(raw: string): string {
  let name = (raw.split(/[\\/]/u).at(-1) ?? "").replace(/[\u0000-\u001f<>:"|?*]/gu, "").replace(/^\.+/u, "").replace(/[. ]+$/u, "").trim();
  if (!name) return "download";
  name = name.slice(-128);
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) ? `_${name}` : name;
}

export function extensionFileToolSchema(inputSchema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { ...inputSchema, properties: { ...(inputSchema.properties as Record<string, unknown> | undefined),
    dir: { type: "string", description: "Absolute file or directory in the task workspace to transfer to this plugin. The host sends file bytes directly; the plugin receives only a short-lived receipt." },
    save_dir: { type: "string", description: "Existing absolute directory in the task workspace for downloaded files. The host saves without overwriting existing files; the plugin receives only a short-lived receipt." } } };
}
