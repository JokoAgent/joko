import { StdioJsonRpcTransport } from "@joko/adapter-codex";
import { createChildRuntimeEnvironment, DurableProcessOwner, type DurableProcessOwnerOptions } from "@joko/runtime-governance";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionMainViewAuthority } from "../extension-main-view-manager.js";
import type { ExtensionNodeDescriptor } from "../extension-surface-manifest.js";
import { inspectPiPackageCatalog } from "../pi-package-compatibility.js";
import type { PiResourceManager } from "../resource-manager.js";
import { VerifiedExtensionDownloads, type DownloadResponse, type VerifiedDownloadOwner } from "./verified-downloads.js";

type JsonValue = Parameters<StdioJsonRpcTransport["respond"]>[1];
type FileLease = Awaited<ReturnType<VerifiedExtensionDownloads["acquire"]>>;

export interface ExtensionNodeOwner extends VerifiedDownloadOwner {
  readonly installation: ExtensionMainViewAuthority;
  readonly worker: ExtensionNodeDescriptor;
  readonly downloadHosts: readonly string[];
}

interface Options {
  readonly rootDirectory: string;
  readonly generation: number;
  readonly supervisor: DurableProcessOwnerOptions["supervisor"];
  readonly resources: Pick<PiResourceManager, "acquireInstalledPackage">;
  readonly redact: (value: string) => string;
  readonly openDownload?: (url: URL, signal: AbortSignal) => Promise<DownloadResponse>;
}

/** The browser can ask a separately approved packaged worker to process its
 * downloads. Only the worker receives paths from live host leases. */
export class ExtensionNodeWorkers {
  private readonly downloads: VerifiedExtensionDownloads;
  private readonly owner: DurableProcessOwner;
  private readonly active = new Set<Promise<unknown>>();
  private readonly cleanup = new Set<() => Promise<void>>();
  private readonly busy = new Map<string, number>();
  private prepared: Promise<string> | undefined;

  constructor(private readonly options: Options) {
    this.downloads = new VerifiedExtensionDownloads(join(options.rootDirectory, "downloads"), options.openDownload);
    this.owner = new DurableProcessOwner({ rootDirectory: join(options.rootDirectory, "processes"),
      instanceId: "extension-node-workers", generation: options.generation, recoverStale: true, supervisor: options.supervisor });
  }

  async download(owner: ExtensionNodeOwner, input: Record<string, unknown>): Promise<unknown> {
    await this.prepare();
    if (owner.downloadHosts.length === 0) throw new Error("Verified downloads require an approved HTTPS host.");
    return { ok: true, ...(await this.downloads.start(owner, owner.downloadHosts, input)) };
  }

  async cancelDownload(owner: ExtensionNodeOwner, id: unknown): Promise<void> {
    await this.downloads.cancel(owner, id);
  }

  async request(owner: ExtensionNodeOwner, input: Record<string, unknown>): Promise<{ readonly ok: true; readonly result: JsonValue }> {
    const invocation = parseInvocation(owner.worker, input);
    owner.signal.throwIfAborted();
    owner.assertCurrent();
    const scope = owner.installation.extensionId;
    const running = this.busy.get(scope) ?? 0;
    if (running >= 2 || this.active.size + this.cleanup.size >= 8) throw new Error("Extension worker capacity is in use.");
    this.busy.set(scope, running + 1);
    const result = this.invoke(owner, invocation);
    this.active.add(result);
    try { return { ok: true, result: await result }; }
    finally {
      this.active.delete(result);
      const remaining = (this.busy.get(scope) ?? 1) - 1;
      if (remaining === 0) this.busy.delete(scope); else this.busy.set(scope, remaining);
    }
  }

  retire(authorityKey: string): void { this.downloads.retire(authorityKey); }

  async drain(): Promise<void> {
    await Promise.allSettled(this.active);
    const pending = [...this.cleanup];
    try { await Promise.all(pending.map(async cleanup => { await cleanup(); this.cleanup.delete(cleanup); })); }
    finally { await this.downloads.drain(); }
  }

  private prepare(): Promise<string> {
    this.prepared ??= this.recover().catch(error => { this.prepared = undefined; throw error; });
    return this.prepared;
  }

  private async recover(): Promise<string> {
    const parent = await realpath(dirname(this.options.rootDirectory));
    const root = join(parent, basename(this.options.rootDirectory));
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root || !((await lstat(root)).isDirectory())) throw new Error("Extension worker storage must be private and canonical.");
    await this.owner.prepare(5_000);
    const workers = join(root, "workers"), downloads = join(root, "downloads");
    await Promise.all([mkdir(workers, { recursive: true, mode: 0o700 }), mkdir(downloads, { recursive: true, mode: 0o700 })]);
    if (await realpath(workers) !== workers || await realpath(downloads) !== downloads) throw new Error("Extension worker storage directories changed.");
    for (const entry of await readdir(workers, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^job-[A-Za-z0-9]{6}$/u.test(entry.name)) throw new Error("An extension worker directory is unsafe.");
      await rm(join(workers, entry.name), { recursive: true, force: true });
    }
    for (const entry of await readdir(downloads, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.blob$/u.test(entry.name)) throw new Error("An extension download cache entry is unsafe.");
      await rm(join(downloads, entry.name), { force: true });
    }
    return workers;
  }

  private async invoke(owner: ExtensionNodeOwner, input: WorkerInvocation): Promise<JsonValue> {
    const files = new Map<string, FileLease>();
    let transport: StdioJsonRpcTransport | undefined;
    let directory: string | undefined;
    let installed: Awaited<ReturnType<PiResourceManager["acquireInstalledPackage"]>> | undefined;
    const finish = async () => {
      await transport?.forceClose();
      for (const file of files.values()) file.release();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      await installed?.release();
    };
    try {
      const workers = await this.prepare();
      const surface = owner.installation;
      owner.signal.throwIfAborted();
      owner.assertCurrent();
      for (const [name, token] of Object.entries(input.downloadTokens)) files.set(name, await this.downloads.acquire(owner, token));
      const signal = AbortSignal.any([owner.signal, ...[...files.values()].map(file => file.signal), AbortSignal.timeout(input.timeoutMs)]);
      const current = () => { signal.throwIfAborted(); owner.assertCurrent(); };
      current();
      installed = await this.options.resources.acquireInstalledPackage({ resourceId: surface.resourceId, backendId: surface.backendId,
        expectedResourceVersion: surface.resourceRevision, expectedDiscoveredRevision: surface.discoveredRevision,
        expectedPackageIdentity: surface.packageName,
        ...(surface.packageVersion === undefined ? {} : { expectedPackageVersion: surface.packageVersion }) });
      directory = await mkdtemp(join(workers, "job-"));
      const root = join(directory, "package");
      await mkdir(root, { mode: 0o700 });
      await installed.snapshotTo(root, signal);
      const inspected = (await inspectPiPackageCatalog(root)).extensions.find(extension => extension.relativePath === surface.extensionEntry)?.runtime?.node;
      if (JSON.stringify(inspected) !== JSON.stringify(owner.worker)) throw new Error("The packaged worker declaration changed.");
      const paths = [...files.values()].map(file => file.path);
      if ([root, ...paths].some(path => path.includes("*"))) throw new Error("Extension worker file permissions require literal paths.");
      await installed.assertCurrent(signal);
      current();
      transport = new StdioJsonRpcTransport({ command: process.execPath,
        args: ["--permission", `--allow-fs-read=${root}`, ...paths.map(path => `--allow-fs-read=${path}`), resolve(root, ...owner.worker.entry.split("/"))],
        cwd: root, processOwner: this.owner, maxLineBytes: 256 * 1024, maxBufferedBytes: 512 * 1024, maxOutboundBytes: 256 * 1024,
        env: createChildRuntimeEnvironment({ overrides: { HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory,
          APPDATA: directory, TEMP: directory, TMP: directory, TMPDIR: directory, SSH_AUTH_SOCK: undefined,
          HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
          ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) } }).environment });
      await transport.start({ onExit: () => undefined, onNotification: () => undefined,
        onRequest: request => transport!.respondError(request.id, -32601, "Worker callbacks are unavailable.") });
      const downloads = Object.fromEntries([...files].map(([name, lease]) => [name, lease.path]));
      const result = await transport.request(input.method, { ...input.params, ...(files.size === 0 ? {} : { downloads }) }, {
        signal, timeoutMs: input.timeoutMs, beforeDispatch: current, beforeDispatchAsync: async () => {
          await installed!.assertCurrent(signal);
          await Promise.all([...files.values()].map(file => file.assertCurrent()));
          current();
        }
      });
      await Promise.all([...files.values()].map(file => file.assertCurrent()));
      current();
      const serialized = JSON.stringify(result);
      const redacted = [directory, ...paths].reduce((text, path) => text.split(JSON.stringify(path).slice(1, -1)).join("[host file]"), serialized);
      return JSON.parse(this.options.redact(redacted)) as JsonValue;
    } finally {
      try { await finish(); }
      catch (error) { this.cleanup.add(finish); throw error; }
    }
  }
}

interface WorkerInvocation {
  readonly method: string;
  readonly params: Record<string, JsonValue>;
  readonly downloadTokens: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

function parseInvocation(worker: ExtensionNodeDescriptor, input: Record<string, unknown>): WorkerInvocation {
  const { method, params = {}, downloadTokens = {}, timeoutMs = 30_000 } = input;
  if (Object.keys(input).some(key => !["method", "params", "downloadTokens", "timeoutMs"].includes(key))
    || typeof method !== "string" || !worker.methods.includes(method) || !record(params) || Object.hasOwn(params, "downloads")
    || !record(downloadTokens) || typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("Extension worker request is invalid or undeclared.");
  }
  const entries = Object.entries(downloadTokens);
  if (entries.length > 8 || entries.some(([name, token]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) || ["constructor", "prototype"].includes(name)
    || typeof token !== "string" || !/^[a-f0-9-]{36}$/u.test(token))) throw new Error("Invalid verified download receipts.");
  return { method, params: params as Record<string, JsonValue>, downloadTokens: downloadTokens as Record<string, string>, timeoutMs };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
