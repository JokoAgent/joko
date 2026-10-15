import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WorktreeServiceError } from "./errors.js";
import { isEntryLayoutSafe, samePath, validEntryId, validateOrdinaryDirectory, validateWorktreeState } from "./state.js";

const heldResources = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const SLOT = /^wt-[0-9a-f]{24}$/u;
const REPOSITORY = /^repo-[0-9a-f]{20}$/u;
const cancellations = new Map<string, Set<() => void>>();

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function busy(): WorktreeServiceError { return new WorktreeServiceError("SESSION_CONFLICT", "The project worktree is in use or being reclaimed."); }

/** Alias-independent identity also survives a temporarily absent restore leaf. */
async function physicalKey(value: string): Promise<string> {
  let cursor = resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      const physical = join(await realpath(cursor), ...suffix);
      return process.platform === "win32" ? physical.toLowerCase() : physical;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function boundedJson(file: string, maximum = 16_384): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || !samePath(await realpath(file), file)) throw busy();
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maximum) throw busy();
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > maximum) throw busy();
    return JSON.parse(text) as unknown;
  } finally { await handle.close(); }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
interface LockRecord { readonly format: 1; readonly pid: number; readonly nonce: string }
function lockRecord(value: unknown): value is LockRecord {
  return record(value) && Object.keys(value).length === 3 && value["format"] === 1
    && Number.isSafeInteger(value["pid"]) && Number(value["pid"]) > 0
    && typeof value["nonce"] === "string" && UUID.test(value["nonce"]);
}
function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function pause(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>(resolveWait => setTimeout(resolveWait, 40));
  signal?.throwIfAborted();
}
async function releaseLock(directory: string, nonce: string): Promise<void> {
  const owner = await boundedJson(join(directory, "owner.json"));
  if (!lockRecord(owner) || owner.nonce !== nonce || owner.pid !== process.pid) throw busy();
  await unlink(join(directory, "owner.json"));
  await rmdir(directory);
}

/** A short deletion/selection lock. Its recovery never releases a source writer. */
export async function withWorktreeSourceLock<T>(value: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const key = await physicalKey(value);
  const inherited = heldResources.getStore();
  if (inherited?.get(key)?.active) { signal?.throwIfAborted(); return task(); }
  const user = typeof process.getuid === "function" ? process.getuid() : 0;
  const directory = join(tmpdir(), `joko-worktree-${user}-${createHash("sha256").update(key).digest("hex")}.lock`);
  const gate = `${directory}.reclaim`;
  const deadline = Date.now() + 10_000;
  let nonce: string | undefined;
  while (nonce === undefined) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw busy();
    if (await exists(gate)) { await pause(signal); continue; }
    const candidate = randomUUID();
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
      await validateOrdinaryDirectory(directory, "STORAGE_UNSAFE", "The worktree resource lock changed unsafely.");
      const handle = await open(join(directory, "owner.json"), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ format: 1, pid: process.pid, nonce: candidate } satisfies LockRecord)); await handle.sync(); }
      finally { await handle.close(); }
      if (await exists(gate)) { await releaseLock(directory, candidate); await pause(signal); continue; }
      nonce = candidate;
    } catch (error) {
      if (created) throw error;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: unknown;
      try { owner = await boundedJson(join(directory, "owner.json")); } catch { await pause(signal); continue; }
      if (!lockRecord(owner) || !processAbsent(owner.pid)) { await pause(signal); continue; }
      let heldGate = false;
      try {
        await mkdir(gate, { mode: 0o700 }); heldGate = true;
        const current = await boundedJson(join(directory, "owner.json"));
        if (!lockRecord(current) || current.nonce !== owner.nonce || current.pid !== owner.pid || !processAbsent(current.pid)) continue;
        const retired = `${directory}.retired-${current.nonce}`;
        await rename(directory, retired);
        await unlink(join(retired, "owner.json"));
        await rmdir(retired);
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code !== "EEXIST" && !missing(recoveryError)) throw recoveryError;
      } finally { if (heldGate) await rmdir(gate); }
    }
  }
  const token = { active: true };
  try { return await heldResources.run(new Map([...(inherited ?? []), [key, token]]), task); }
  finally { token.active = false; await releaseLock(directory, nonce); }
}

interface OwnedSource { readonly root: string; readonly storage: string; readonly entryId: string; readonly status: string }
async function ownedSource(project: string): Promise<OwnedSource | undefined> {
  let root = resolve(project);
  for (;;) {
    const parent = dirname(root);
    if (SLOT.test(basename(root)) && REPOSITORY.test(basename(parent))) {
      const storage = dirname(parent);
      const state = validateWorktreeState(await boundedJson(join(storage, "state.json"), 10 * 1024 * 1024));
      const entry = state.entries.find(item => samePath(item.path, root));
      if (!entry || !isEntryLayoutSafe(storage, entry)) throw busy();
      return { root, storage, entryId: entry.id, status: entry.status };
    }
    if (parent === root) return undefined;
    root = parent;
  }
}
function useDirectory(source: OwnedSource): string { return join(source.storage, "source-uses", source.entryId); }

export interface WorktreeSourceUse {
  readonly projectRoot: string;
  readonly receipt?: WorktreeSourceUseReceipt;
  verify(): Promise<void>;
  /** Unknown native writers retain their durable pin; no timeout/PID cleanup. */
  release(input: { readonly writerRetired: boolean }): Promise<void>;
}
export interface WorktreeSourceUseReceipt {
  readonly format: 1; readonly id: string; readonly entryId: string; readonly ownerId: string; readonly projectRoot: string;
}

/** A trusted writer owner supplies exact retirement proof before calling.
 * Recovery never selects by PID, age, another writer, or a directory scan. */
export async function releaseRetiredWorktreeSourceUse(receipt: WorktreeSourceUseReceipt): Promise<void> {
  if (receipt.format !== 1 || !UUID.test(receipt.id) || !validEntryId(receipt.entryId)
    || !receipt.ownerId || receipt.ownerId.length > 512 || receipt.ownerId.includes("\0")
    || !isAbsolute(receipt.projectRoot) || receipt.projectRoot.includes("\0")) throw busy();
  const source = await ownedSource(receipt.projectRoot);
  if (source === undefined || source.entryId !== receipt.entryId) throw busy();
  await withWorktreeSourceLock(source.root, async () => {
    const current = await ownedSource(receipt.projectRoot);
    if (current?.entryId !== receipt.entryId || !samePath(current.root, source.root)) throw busy();
    const directory = useDirectory(source);
    if (!await exists(directory)) return;
    await validateOrdinaryDirectory(directory, "STORAGE_UNSAFE", "The project source lease directory changed unsafely.");
    const file = join(directory, `${receipt.id}.json`);
    if (await exists(file)) {
      const body = await boundedJson(file);
      if (!record(body) || body["format"] !== 1 || body["id"] !== receipt.id || body["entryId"] !== receipt.entryId
        || body["ownerId"] !== receipt.ownerId || typeof body["projectRoot"] !== "string"
        || !samePath(body["projectRoot"], receipt.projectRoot)) throw busy();
      await unlink(file);
    }
    await unlink(`${file}.cancel`).catch(error => { if (!missing(error)) throw error; });
  });
}

/** Source selection changes neither the product task nor the source checkout owner. */
export async function acquireWorktreeSourceUse(projectRoot: string, ownerId: string, controller: AbortController,
  options?: { readonly id: string }): Promise<WorktreeSourceUse> {
  if (!ownerId || ownerId.length > 512 || ownerId.includes("\0")) throw new WorktreeServiceError("INVALID_ARGUMENT", "Project source owner identity is invalid.");
  if (options !== undefined && !UUID.test(options.id)) throw new WorktreeServiceError("INVALID_ARGUMENT", "Project source use identity is invalid.");
  const project = await realpath(resolve(projectRoot));
  await validateOrdinaryDirectory(project, "PATH_UNSAFE", "The selected project source is unavailable.");
  const selected = await ownedSource(project);
  let retired = false;
  let stopped = false;
  let useFile: string | undefined;
  let useId: string | undefined;
  let cancel: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const verify = async (): Promise<void> => {
    controller.signal.throwIfAborted();
    if (stopped || retired || !samePath(await realpath(project), project)) throw busy();
    await validateOrdinaryDirectory(project, "PATH_UNSAFE", "The selected project source changed unsafely.");
    if (selected) {
      const current = await ownedSource(project);
      if (!current || current.entryId !== selected.entryId || !samePath(current.root, selected.root)
        || !["active", "restored", "preserved"].includes(current.status) || useFile && await exists(`${useFile}.cancel`)) throw busy();
    }
  };
  if (selected) {
    await withWorktreeSourceLock(selected.root, async () => {
      await verify();
      const directory = useDirectory(selected);
      const pending = await readdir(directory).catch(error => { if (missing(error)) return []; throw error; });
      if (pending.some(file => file.endsWith(".cancel"))) throw busy();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await validateOrdinaryDirectory(directory, "STORAGE_UNSAFE", "The project source lease directory changed unsafely.");
      useId = options?.id ?? randomUUID(); useFile = join(directory, `${useId}.json`);
      const handle = await open(useFile, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ format: 1, id: useId, entryId: selected.entryId, ownerId, projectRoot: project })); await handle.sync(); }
      finally { await handle.close(); }
    }, controller.signal);
    const key = await physicalKey(selected.root);
    cancel = () => controller.abort();
    const listeners = cancellations.get(key) ?? new Set<() => void>();
    listeners.add(cancel); cancellations.set(key, listeners);
    poll = setInterval(() => {
      if (!stopped) void exists(`${useFile}.cancel`).then(pending => { if (pending) controller.abort(); }, () => controller.abort());
    }, 1_000);
    poll.unref();
  }
  return {
    projectRoot: project,
    ...(selected === undefined || useId === undefined ? {} : { receipt: { format: 1 as const, id: useId, entryId: selected.entryId, ownerId, projectRoot: project } }),
    verify,
    release: async ({ writerRetired }) => {
      if (retired) return;
      stopped = true;
      if (poll) clearInterval(poll);
      if (selected && cancel) {
        const key = await physicalKey(selected.root);
        const listeners = cancellations.get(key); listeners?.delete(cancel);
        if (listeners?.size === 0) cancellations.delete(key);
      }
      if (!writerRetired || !useFile || !useId || !selected) { retired = writerRetired; return; }
      await withWorktreeSourceLock(selected.root, async () => {
        const body = await boundedJson(useFile!);
        if (!record(body) || body["format"] !== 1 || body["id"] !== useId || body["entryId"] !== selected.entryId
          || body["ownerId"] !== ownerId || body["projectRoot"] !== project) throw busy();
        await unlink(useFile!);
        await unlink(`${useFile}.cancel`).catch(error => { if (!missing(error)) throw error; });
        retired = true;
      });
    }
  };
}

/** Called inside the same physical lock before release, restore or startup removal. */
export async function cancelWorktreeSourceUses(root: string): Promise<boolean> {
  const source = await ownedSource(root).catch(error => { if (missing(error)) return undefined; throw error; });
  if (!source) return false;
  const directory = useDirectory(source);
  let files: string[];
  try {
    // Check absence before the directory validator converts filesystem errors
    // to a safety failure. An unused checkout has no source-use directory.
    await lstat(directory);
    await validateOrdinaryDirectory(directory, "STORAGE_UNSAFE", "The project source lease directory changed unsafely.");
    files = await readdir(directory);
  } catch (error) { if (missing(error)) return false; throw error; }
  const pins = files.filter(file => file.endsWith(".json"));
  if (pins.length === 0 && files.length === 0) return false;
  for (const file of pins.slice(0, 1_024)) {
    if (!UUID.test(file.slice(0, -5))) continue;
    const flag = await open(join(directory, `${file}.cancel`), "wx", 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error;
    });
    if (flag) { try { await flag.writeFile("cancel\n"); await flag.sync(); } finally { await flag.close(); } }
  }
  for (const listener of cancellations.get(await physicalKey(root)) ?? []) listener();
  return true;
}
