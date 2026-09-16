import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWritePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./secure-files.js";
import type { DesktopCopyFileRequest, DesktopCopyFileResult } from "./channels.js";

export const FILE_COPY_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const FILE_COPY_TOTAL_BYTES = 512 * 1024 * 1024;
export const FILE_COPY_MAXIMUM_FILES = 32;
export const FILE_COPY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const HELPER_TIMEOUT_MS = 10_000;
const MAXIMUM_REQUESTS = 1_024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const WINDOWS_SCRIPT = "param([Parameter(Mandatory=$true)][string]$LiteralPath)\n$ErrorActionPreference = 'Stop'\nSet-Clipboard -LiteralPath $LiteralPath\n";
const MAC_SCRIPT = "on run argv\nset the clipboard to (POSIX file (item 1 of argv))\nend run\n";

interface Entry {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly state: "prepared" | "dispatched" | "retained";
  /** A recorded PID may only prove absence; existence does not prove identity. */
  readonly pid?: number;
  readonly retainUntil?: number;
}
export interface NativeFileActionScope {
  readonly id: string;
  readonly isCurrent: () => boolean;
}
export interface FileCopyHelperResult {
  readonly status: "copied" | "failed" | "unknown";
  readonly dispatched: boolean;
  readonly closed: boolean;
}
export interface NativeFileClipboardOptions {
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly execute?: (path: string, signal: AbortSignal, recordSpawn: (pid: number) => Promise<void>) => Promise<FileCopyHelperResult>;
  readonly processExists?: (pid: number) => boolean | "unknown";
  readonly now?: () => number;
  readonly timeoutMs?: number;
}
interface Request {
  readonly scope: NativeFileActionScope;
  readonly digest: string;
  readonly abort: AbortController;
  readonly result: Promise<DesktopCopyFileResult>;
}

/** A single app-owned writer. Clipboard files survive their requesting renderer. */
export class NativeFileClipboard {
  readonly #options: NativeFileClipboardOptions;
  readonly #requests = new Map<string, Request>();
  readonly #now: () => number;
  readonly #manifest: string;
  #entries: Entry[] = [];
  #initialization: Promise<void> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #pendingBytes = 0;
  #pendingFiles = 0;
  #closed = false;
  #uncertainHelper = false;

  constructor(options: NativeFileClipboardOptions) {
    if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory) throw new Error("Clipboard storage must be an absolute private directory.");
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#manifest = join(options.directory, "files.json");
  }

  copy(value: unknown, scope: NativeFileActionScope): Promise<DesktopCopyFileResult> {
    const input = parseDesktopCopyFileRequest(value);
    const key = `${scope.id}\0${input.requestId}`;
    const digest = createHash("sha256").update(input.file.name).update("\0").update(input.file.mediaType).update("\0").update(input.file.bytes).digest("hex");
    const existing = this.#requests.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) return Promise.reject(new TypeError("The file copy request identity was reused with different content."));
      return existing.result;
    }
    if (this.#closed || !scope.isCurrent()) return Promise.resolve({ status: "cancelled" });
    if (!fileCopySupported(this.#options.platform)) return Promise.resolve({ status: "unavailable" });
    if (this.#uncertainHelper) return Promise.resolve({ status: "blocked" });
    if (this.#requests.size >= MAXIMUM_REQUESTS || this.#pendingFiles >= FILE_COPY_MAXIMUM_FILES || this.#pendingBytes + input.file.bytes.byteLength > FILE_COPY_TOTAL_BYTES) {
      return Promise.resolve({ status: "failed", reason: "capacity" });
    }
    const bytes = Uint8Array.from(input.file.bytes);
    const abort = new AbortController();
    this.#pendingBytes += bytes.byteLength;
    this.#pendingFiles += 1;
    const current = (): boolean => !this.#closed && !abort.signal.aborted && scope.isCurrent();
    const result = this.#tail.then(async (): Promise<DesktopCopyFileResult> => {
      if (!current()) return { status: "cancelled" };
      if (this.#uncertainHelper) return { status: "blocked" };
      try {
        await this.#initialize();
        await this.#cleanExpired();
        if (!current()) return { status: "cancelled" };
        if (this.#uncertainHelper) return { status: "blocked" };
        if (this.#entries.length + this.#pendingFiles > FILE_COPY_MAXIMUM_FILES || this.#entries.reduce((total, entry) => total + entry.bytes, 0) + this.#pendingBytes > FILE_COPY_TOTAL_BYTES) return { status: "failed", reason: "capacity" };
        return await this.#execute(input.file.name, bytes, abort, current);
      } catch {
        return { status: "failed", reason: "storage" };
      }
    }).finally(() => {
      this.#pendingBytes -= bytes.byteLength;
      this.#pendingFiles -= 1;
    });
    this.#tail = result.catch(() => undefined);
    this.#requests.set(key, { scope, digest, abort, result });
    return result;
  }

  cancel(requestId: string, scopeId: string): void {
    if (!UUID.test(requestId)) throw new TypeError("Invalid file copy request identity.");
    this.#requests.get(`${scopeId}\0${requestId}`)?.abort.abort();
  }

  retireScope(scopeId: string): void {
    for (const request of this.#requests.values()) if (request.scope.id === scopeId) request.abort.abort();
  }

  dispose(): void {
    this.#closed = true;
    this.cancelPending();
  }

  cancelPending(): void {
    for (const request of this.#requests.values()) request.abort.abort();
  }

  async #initialize(): Promise<void> {
    this.#initialization ??= (async () => {
      await ensurePrivateDirectory(this.#options.directory);
      const bytes = await readPrivateFile(this.#manifest);
      this.#entries = bytes === undefined ? [] : parseManifest(bytes);
      // A PID known to be absent proves the old helper cannot write again. A
      // present/reused PID, denied probe or missing identity never releases it.
      this.#entries = this.#entries.map((entry) => entry.state === "dispatched" && entry.pid !== undefined && (this.#options.processExists ?? processExists)(entry.pid) === false
        ? { ...entry, state: "retained", retainUntil: this.#now() + FILE_COPY_RETENTION_MS } : entry);
      this.#uncertainHelper = this.#entries.some((entry) => entry.state === "dispatched");
      await this.#persist();
    })();
    return this.#initialization;
  }

  async #persist(): Promise<void> {
    await atomicWritePrivateFile(this.#manifest, Buffer.from(JSON.stringify({ version: 1, entries: this.#entries })));
  }

  async #remove(entry: Entry): Promise<void> {
    const directory = join(this.#options.directory, entry.id);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info !== undefined) {
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) throw new Error("Clipboard file directory changed.");
      const path = join(directory, entry.name);
      const file = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (file !== undefined) {
        if (!file.isFile() || file.isSymbolicLink() || !samePath(await realpath(path), path)) throw new Error("Clipboard file changed.");
        await unlink(path);
      }
      // No recursive deletion or discovery of files outside the exact manifest.
      await rmdir(directory);
    }
    this.#entries = this.#entries.filter((value) => value !== entry);
    await this.#persist();
  }

  async #cleanExpired(): Promise<void> {
    for (const entry of [...this.#entries]) if (entry.state === "prepared" || (entry.state === "retained" && entry.retainUntil !== undefined && entry.retainUntil <= this.#now())) await this.#remove(entry);
  }

  async #execute(name: string, bytes: Uint8Array, abort: AbortController, current: () => boolean): Promise<DesktopCopyFileResult> {
    let entry: Entry = { id: randomUUID(), name, bytes: bytes.byteLength, state: "prepared" };
    this.#entries.push(entry);
    await this.#persist();
    const directory = join(this.#options.directory, entry.id);
    const path = join(directory, name);
    let dispatched = false;
    try {
      await ensurePrivateDirectory(directory);
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      if (!current()) return { status: "cancelled" };
      // Reserve unknown retention before the first possible OS mutation.
      const reserved: Entry = { ...entry, state: "dispatched" };
      this.#entries[this.#entries.indexOf(entry)] = reserved;
      entry = reserved;
      await this.#persist();
      if (!current()) return { status: "cancelled" };
      const execute = this.#options.execute ?? ((filePath, signal, recordSpawn) => runFileCopyHelper(this.#options.directory, this.#options.platform, filePath, signal, recordSpawn));
      let recordedPid = false;
      const recordSpawn = async (pid: number): Promise<void> => {
        if (recordedPid || abort.signal.aborted || this.#closed || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid clipboard helper process identity.");
        recordedPid = true;
        const running: Entry = { ...entry, pid };
        this.#entries[this.#entries.indexOf(entry)] = running;
        entry = running;
        await this.#persist();
      };
      dispatched = true;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<FileCopyHelperResult>((resolveTimeout) => {
        timer = setTimeout(() => { timedOut = true; this.#uncertainHelper = true; abort.abort(); resolveTimeout({ status: "unknown", dispatched: true, closed: false }); }, this.#options.timeoutMs ?? HELPER_TIMEOUT_MS);
      });
      const operation = Promise.resolve().then(() => execute(path, abort.signal, recordSpawn)).catch((): FileCopyHelperResult => ({ status: "unknown", dispatched: true, closed: false }));
      void operation.then((result) => {
        if (!timedOut || !result.closed || this.#closed) return;
        const endedId = entry.id;
        const reconciliation = this.#tail.then(async () => {
          if (this.#closed) return;
          const running = this.#entries.find((value) => value.id === endedId);
          if (running === undefined || running.state !== "dispatched") return;
          this.#entries[this.#entries.indexOf(running)] = { ...running, state: "retained", retainUntil: this.#now() + FILE_COPY_RETENTION_MS };
          await this.#persist();
          this.#uncertainHelper = this.#entries.some((value) => value.state === "dispatched");
        });
        this.#tail = reconciliation.catch(() => { this.#uncertainHelper = true; });
      });
      const result = await Promise.race([operation, timeout]);
      if (timer !== undefined) clearTimeout(timer);
      dispatched = result.dispatched;
      if (!dispatched) return current() ? { status: "failed", reason: "helper" } : { status: "cancelled" };
      if (!result.closed) { this.#uncertainHelper = true; return { status: "unknown" }; }
      const retained: Entry = { ...entry, state: "retained", retainUntil: this.#now() + FILE_COPY_RETENTION_MS };
      this.#entries[this.#entries.indexOf(entry)] = retained;
      entry = retained;
      try { await this.#persist(); } catch { this.#uncertainHelper = true; return { status: "unknown" }; }
      return result.status === "copied" ? { status: "copied" } : { status: "unknown" };
    } catch {
      return dispatched ? { status: "unknown" } : { status: "failed", reason: "storage" };
    } finally {
      if (!dispatched) await this.#remove(entry).catch(() => undefined);
    }
  }
}

export function fileCopySupported(platform: NodeJS.Platform): boolean { return platform === "win32" || platform === "darwin"; }

export function parseDesktopCopyFileRequest(value: unknown): DesktopCopyFileRequest {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "file,requestId" || typeof value.requestId !== "string" || !UUID.test(value.requestId) || !isRecord(value.file)) throw new TypeError("Invalid file copy request.");
  const file = value.file;
  if (Object.keys(file).sort().join(",") !== "bytes,mediaType,name" || typeof file.name !== "string" || !safeFileName(file.name) || typeof file.mediaType !== "string" || file.mediaType.length > 255 || !/^[\w.+-]+\/[\w.+-]+$/u.test(file.mediaType) || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength > FILE_COPY_MAXIMUM_BYTES) throw new TypeError("Invalid file copy payload.");
  return { requestId: value.requestId, file: { name: file.name, mediaType: file.mediaType, bytes: file.bytes } };
}

function safeFileName(name: string): boolean {
  return name.length > 0 && name.trim() === name && Buffer.byteLength(name, "utf8") <= 240 && !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(name) && !/[. ]$/u.test(name) && name !== "." && name !== ".." && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}
function parseManifest(bytes: Uint8Array): Entry[] {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > FILE_COPY_MAXIMUM_FILES) throw new Error("Invalid clipboard file manifest.");
  const ids = new Set<string>();
  let total = 0;
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !UUID.test(entry.id) || ids.has(entry.id) || typeof entry.name !== "string" || !safeFileName(entry.name) || typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > FILE_COPY_MAXIMUM_BYTES || (entry.state !== "prepared" && entry.state !== "dispatched" && entry.state !== "retained") || (entry.pid !== undefined && (entry.state === "prepared" || typeof entry.pid !== "number" || !Number.isSafeInteger(entry.pid) || entry.pid <= 0)) || (entry.state === "retained" ? (typeof entry.retainUntil !== "number" || !Number.isSafeInteger(entry.retainUntil) || entry.retainUntil < 0) : entry.retainUntil !== undefined)) throw new Error("Invalid clipboard file record.");
    ids.add(entry.id);
    total += entry.bytes;
  }
  if (total > FILE_COPY_TOTAL_BYTES) throw new Error("Clipboard file manifest exceeds its capacity.");
  return value.entries as Entry[];
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }

function processExists(pid: number): boolean | "unknown" {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown"; }
}

async function runFileCopyHelper(directory: string, platform: NodeJS.Platform, path: string, signal: AbortSignal, recordSpawn: (pid: number) => Promise<void>): Promise<FileCopyHelperResult> {
  const script = join(directory, platform === "win32" ? "copy-file.ps1" : "copy-file.applescript");
  try { await atomicWritePrivateFile(script, Buffer.from(platform === "win32" ? WINDOWS_SCRIPT : MAC_SCRIPT)); }
  catch { return { status: "failed", dispatched: false, closed: true }; }
  if (signal.aborted) return { status: "failed", dispatched: false, closed: true };
  const systemRoot = process.env.SystemRoot;
  if (platform === "win32" && (systemRoot === undefined || !isAbsolute(systemRoot))) return { status: "failed", dispatched: false, closed: true };
  const command = platform === "win32" ? join(systemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/usr/bin/osascript";
  const args = platform === "win32" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-LiteralPath", path] : [script, path];
  return new Promise((resolveResult) => {
    if (signal.aborted) { resolveResult({ status: "failed", dispatched: false, closed: true }); return; }
    let dispatched = false;
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    dispatched = child.pid !== undefined;
    const recorded = child.pid === undefined ? Promise.resolve() : recordSpawn(child.pid);
    // Attach both outcomes immediately; a persistence failure cannot become an
    // unhandled rejection while the OS helper still owns the clipboard action.
    const recording = recorded.then(() => undefined, () => undefined);
    const finish = (result: FileCopyHelperResult): void => { void recording.then(() => resolveResult(result)); };
    // A failed kill is not proof of exit. Keep the process owned until close;
    // the outer deadline quarantines this writer if exit cannot be confirmed.
    const abort = (): void => { try { child.kill(); } catch { /* Await close or the owner deadline. */ } };
    signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => { dispatched = true; if (signal.aborted) abort(); });
    child.on("error", () => {
      if (!dispatched) { signal.removeEventListener("abort", abort); finish({ status: "failed", dispatched: false, closed: true }); }
    });
    child.once("close", (code) => { signal.removeEventListener("abort", abort); finish({ status: code === 0 ? "copied" : dispatched ? "unknown" : "failed", dispatched, closed: true }); });
  });
}
