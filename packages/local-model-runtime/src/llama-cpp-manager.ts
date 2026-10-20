import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { totalmem } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalRuntimeError } from "./errors.js";
import { assertActiveOwner, assertPathWithin } from "./security.js";
import type { RuntimeOwnerGeneration } from "./types.js";
import { LLAMA_CPP_CATALOG, llamaCppRecommendation } from "./llama-cpp-catalog.js";
import { downloadLlamaCppAsset, hfDownloadUrl, llamaCppPlatform, LlamaCppResumeReadError, resolveHfRepository, resolveLlamaCppRelease, selectGgufShards } from "./llama-cpp-downloads.js";
import { extractLlamaCppArchive, llamaCppProcessCommand, probeLlamaCppOwner, readLlamaCppRecord, startLlamaCppOwnerProof, terminateLlamaCppTree, validLlamaCppOwnerIdentity, withLlamaCppMutationLock, type LlamaCppOwnerIdentity, type LlamaCppOwnerProof } from "./llama-cpp-process.js";
import { LLAMA_CPP_MANAGED_ORIGIN, LLAMA_CPP_MANAGED_PORT, LlamaCppRuntimeError, type LlamaCppModel, type LlamaCppOperation, type LlamaCppRepository, type LlamaCppRuntimeOptions, type LlamaCppSelection, type LlamaCppSnapshot, type LlamaCppTransferTarget } from "./llama-cpp-types.js";
import { assertLlamaCppSelection, llamaCppModelId, llamaCppModelPreset, sameLlamaCppSelection } from "./llama-cpp-validation.js";

type MutableOperation = { -readonly [P in keyof LlamaCppOperation]: LlamaCppOperation[P] };
interface Installed { readonly version: string; readonly binary: string }
interface RuntimeOwnerRecord { readonly format: 1; readonly identity: LlamaCppOwnerIdentity; readonly preset: string }
interface Retirement { readonly child: ChildProcess; readonly completed: Promise<void>; readonly controller: AbortController }
const RECORD_KEYS = ["file", "format", "id", "repository", "revision", "shards", "sizeBytes"];
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const sameOwner = (left: RuntimeOwnerGeneration, right: RuntimeOwnerGeneration) => left.ownerId === right.ownerId && left.generation === right.generation;

/** Disk inventory and process ownership are independent. Reading this engine never
 * creates a Provider or starts a router; only explicit mutations enter its lock. */
export class LlamaCppRuntimeManager {
  readonly #options: LlamaCppRuntimeOptions;
  readonly #root: string;
  readonly #models: string;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  #operation: MutableOperation | undefined;
  #operationOwner: RuntimeOwnerGeneration | undefined;
  #operationAbort: AbortController | undefined;
  #transferAbort: AbortController | undefined;
  #flight: Promise<unknown> | undefined;
  #wakeDownload: (() => void) | undefined;
  #child: ChildProcess | undefined;
  #proof: LlamaCppOwnerProof | undefined;
  #ready = false;
  #retirement: Retirement | undefined;
  #stopping = false;
  #disposed = false;
  #starting: Promise<void> | undefined;

  constructor(options: LlamaCppRuntimeOptions) {
    this.#options = options; this.#root = join(options.dataRoot, "llamacpp-runtime"); this.#models = join(this.#root, "models");
    this.#platform = options.platform ?? process.platform; this.#arch = options.arch ?? process.arch;
  }
  #assert(owner: RuntimeOwnerGeneration): void { assertActiveOwner(owner, this.#options.currentOwner); }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  async #directories(): Promise<void> {
    await mkdir(this.#models, { recursive: true, mode: 0o700 });
    for (const directory of [this.#root, this.#models]) if ((await lstat(directory)).isSymbolicLink()) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime directory is unavailable.");
  }
  async #installed(): Promise<Installed | undefined> {
    let value: unknown;
    try { value = await readLlamaCppRecord(join(this.#root, "current.json")); } catch (error) { if (missing(error) || error instanceof SyntaxError) return undefined; throw error; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join() !== "binary,format,version" || row["format"] !== 1 || typeof row["binary"] !== "string" || typeof row["version"] !== "string" || !/^(b\d+|v\d+\.\d+\.\d+)$/u.test(row["version"])) return undefined;
    const file = join(this.#root, row["binary"]); assertPathWithin(this.#root, file);
    try {
      const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) return undefined;
      const binary = await realpath(file); assertPathWithin(await realpath(this.#root), binary);
      if (basename(binary) !== (this.#platform === "win32" ? "llama-server.exe" : "llama-server")) return undefined;
      return { version: row["version"], binary };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async #inventory(): Promise<readonly LlamaCppModel[]> {
    let entries: string[];
    try { entries = await readdir(this.#models); } catch (error) { if (missing(error)) return []; throw error; }
    const models: LlamaCppModel[] = [];
    for (const id of entries.filter(value => /^model-[a-f0-9]{24}$/u.test(value)).sort()) {
      const root = join(this.#models, id), info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) continue;
      let value: unknown;
      try { value = await readLlamaCppRecord(join(root, "model.json")); } catch (error) { if (missing(error) || error instanceof SyntaxError) continue; throw error; }
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (Object.keys(row).sort().join() !== RECORD_KEYS.join() || row["format"] !== 1 || row["id"] !== id || typeof row["repository"] !== "string" || typeof row["file"] !== "string" || !/^[a-f0-9]{40}$/u.test(String(row["revision"])) || !Number.isSafeInteger(row["sizeBytes"]) || Number(row["sizeBytes"]) <= 0 || !Array.isArray(row["shards"])) continue;
      const model = row as unknown as LlamaCppModel;
      try { assertLlamaCppSelection(model); } catch { continue; }
      if (llamaCppModelId(model) !== id || model.shards.length === 0 || model.shards.length > 256 || model.shards.some(shard => Object.keys(shard).sort().join() !== "name,sha256,sizeBytes" || !Number.isSafeInteger(shard.sizeBytes) || shard.sizeBytes <= 0 || !/^[a-f0-9]{64}$/u.test(shard.sha256))) continue;
      let complete = true;
      try {
        const expected = selectGgufShards(model.shards, model.file);
        if (expected.length !== model.shards.length || new Set(model.shards.map(shard => basename(shard.name))).size !== model.shards.length || model.shards.reduce((sum, shard) => sum + shard.sizeBytes, 0) !== model.sizeBytes) continue;
        for (const shard of expected) {
          const file = join(root, basename(shard.name)); assertPathWithin(root, file);
          const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== shard.sizeBytes) { complete = false; break; }
        }
      } catch (error) { if (missing(error)) complete = false; else if (error instanceof LocalRuntimeError || error instanceof Error && ["MODEL_INCOMPLETE", "INVALID_MODEL", "MODEL_NOT_FOUND"].includes(error.message)) complete = false; else throw error; }
      if (complete) models.push({ id: model.id, repository: model.repository, file: model.file, revision: model.revision, shards: model.shards, sizeBytes: model.sizeBytes });
    }
    return models;
  }
  async #external(): Promise<"alive" | "ended" | "unknown"> {
    if (this.#proof) return "ended";
    let value: unknown;
    try { value = await readLlamaCppRecord(join(this.#root, "server-owner.json")); } catch (error) { if (missing(error)) return "ended"; return "unknown"; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return "unknown";
    const row = value as Partial<RuntimeOwnerRecord>;
    if (Object.keys(row).sort().join() !== "format,identity,preset" || row.format !== 1 || typeof row.preset !== "string" || !validLlamaCppOwnerIdentity(row.identity)) return "unknown";
    return await probeLlamaCppOwner(row.identity);
  }
  async #healthy(signal?: AbortSignal): Promise<boolean> {
    try { const response = await (this.#options.healthFetch ?? this.#options.fetchStreaming)(`${LLAMA_CPP_MANAGED_ORIGIN}/health`, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1500)]), redirect: "error" }); await response.body?.cancel(); return response.ok; } catch { return false; }
  }
  async snapshot(owner: RuntimeOwnerGeneration): Promise<LlamaCppSnapshot> {
    this.#assert(owner);
    const [installed, models, external] = await Promise.all([this.#installed(), this.#inventory(), this.#external()]);
    const owned = this.#child !== undefined;
    const running = owned && this.#ready && !this.#retirement || external === "alive" && await this.#healthy(); this.#assert(owner);
    const blockedReason = this.#retirement ? "stop_unconfirmed" : external === "unknown" ? "ownership_unknown" : external === "alive" ? "owned_elsewhere" : this.#operation || this.#stopping ? "operation_busy" : undefined;
    return { installed: installed !== undefined, supported: llamaCppPlatform(this.#platform, this.#arch) !== null, running,
      canManageRuntime: owned, canConfigure: !this.#disposed && !this.#retirement && external === "ended", canPauseDownload: this.#operation?.kind === "download" && this.#operationOwner !== undefined && sameOwner(owner, this.#operationOwner),
      ...(blockedReason ? { blockedReason } : {}), ...(installed ? { version: installed.version } : {}), models,
      ...(this.#operation ? { operation: { ...this.#operation } } : {}), catalog: LLAMA_CPP_CATALOG,
      recommendation: llamaCppRecommendation(this.#platform, this.#arch, (this.#options.totalMemoryBytes ?? totalmem)(), this.#options.chip?.()) };
  }
  async listRepositoryFiles(owner: RuntimeOwnerGeneration, repository: string, signal?: AbortSignal): Promise<LlamaCppRepository> {
    this.#assert(owner);
    try {
      const result = await resolveHfRepository(repository, signal ?? new AbortController().signal, this.#options.fetchStreaming); this.#assert(owner); signal?.throwIfAborted();
      return result;
    } catch (error) { throw mapped(error); }
  }
  #exclusive<T>(owner: RuntimeOwnerGeneration, kind: LlamaCppOperation["kind"], selection: LlamaCppSelection | undefined, effect: (signal: AbortSignal) => Promise<T>, waitMs = 0): Promise<T> {
    this.#assert(owner);
    if (this.#disposed || this.#stopping || this.#retirement || this.#flight) return Promise.reject(new LlamaCppRuntimeError("INSTALL_BUSY", this.#retirement ? "STOP_TIMEOUT" : "BUSY", "The runtime operation is unavailable."));
    const controller = new AbortController(); this.#operationAbort = controller; this.#operationOwner = { ...owner };
    this.#operation = { transferId: randomUUID(), kind, completed: 0, total: 0, ...(selection ? { selection: { ...selection } } : {}) };
    let flight!: Promise<T>;
    flight = (async () => {
      try {
        await this.#directories();
        return await withLlamaCppMutationLock(this.#root, controller.signal, waitMs, async () => {
          this.#assert(owner); controller.signal.throwIfAborted(); await this.#options.validateConnection(owner); this.#assert(owner); controller.signal.throwIfAborted();
          const external = await this.#external(); this.#assert(owner); controller.signal.throwIfAborted();
          if (external !== "ended") throw new LlamaCppRuntimeError("RUNTIME_ERROR", external === "alive" ? "OWNED_ELSEWHERE" : "OWNER_UNKNOWN", "Another instance owns this runtime.");
          return await effect(controller.signal);
        });
      } catch (error) { throw mapped(error); }
      finally { if (this.#flight === flight) { this.#operation = undefined; this.#operationOwner = undefined; this.#operationAbort = undefined; this.#transferAbort = undefined; this.#wakeDownload = undefined; this.#flight = undefined; } }
    })();
    this.#flight = flight; return flight;
  }
  async #freeDisk(directory: string, bytes: number): Promise<void> {
    const free = this.#options.freeDiskBytes ? await this.#options.freeDiskBytes(directory) : await statfs(directory).then(stat => Number(stat.bavail) * Number(stat.bsize));
    if (!Number.isFinite(free) || free < bytes + 512 * 1024 * 1024) throw new LocalRuntimeError("DISK_SPACE_LOW", "There is not enough free disk space.");
  }
  #progress(owner: RuntimeOwnerGeneration, signal: AbortSignal, completed: number, total: number, started: number): void {
    this.#assert(owner); signal.throwIfAborted(); if (this.#operation) { this.#operation.completed = completed; this.#operation.total = total; this.#operation.bytesPerSecond = completed / Math.max(1, (this.#now() - started) / 1000); }
  }
  async #changed(owner: RuntimeOwnerGeneration): Promise<void> { this.#assert(owner); const models = await this.#inventory(); this.#assert(owner); await this.#options.onModelsChanged?.(owner, models); this.#assert(owner); }
  install(owner: RuntimeOwnerGeneration): Promise<void> {
    return this.#exclusive(owner, "install", undefined, async signal => {
      if (await this.#installed()) return;
      const asset = await resolveLlamaCppRelease(signal, this.#options.fetchStreaming, this.#platform, this.#arch); this.#assert(owner); signal.throwIfAborted(); await this.#freeDisk(this.#root, asset.size);
      const staging = join(this.#root, `.install-${randomUUID()}`), published = join(this.#root, `release-${asset.version}-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
      let promoted = false;
      try {
        const archivePath = join(staging, asset.name), destination = join(staging, "extracted"), started = this.#now();
        await downloadLlamaCppAsset(asset, archivePath, "github", signal, bytes => this.#progress(owner, signal, bytes, asset.size, started), false, this.#options.fetchStreaming);
        const binary = await (this.#options.extractArchive ?? extractLlamaCppArchive)({ archivePath, destination, platform: this.#platform, signal });
        const extracted = await lstat(destination);
        if (!extracted.isDirectory() || extracted.isSymbolicLink()) throw new LocalRuntimeError("ARCHIVE_REJECTED", "The runtime extraction directory is unavailable.");
        const canonicalDestination = await realpath(destination), canonicalBinary = await realpath(binary);
        assertPathWithin(await realpath(staging), canonicalDestination);
        assertPathWithin(canonicalDestination, canonicalBinary); this.#assert(owner); signal.throwIfAborted();
        const binaryRelative = relative(canonicalDestination, canonicalBinary); await rename(destination, published);
        this.#assert(owner); signal.throwIfAborted(); await atomicRecord(join(this.#root, "current.json"), { format: 1, version: asset.version, binary: relative(this.#root, join(published, binaryRelative)) }); promoted = true;
        await this.#changed(owner);
      } finally { await rm(staging, { recursive: true, force: true }); if (!promoted) await rm(published, { recursive: true, force: true }); }
    });
  }
  download(owner: RuntimeOwnerGeneration, selection: LlamaCppSelection): Promise<void> {
    assertLlamaCppSelection(selection);
    return this.#exclusive(owner, "download", selection, async signal => {
      const existing = (await this.#inventory()).find(model => model.id === llamaCppModelId(selection)); if (existing) { await this.#changed(owner); return; }
      const repository = await resolveHfRepository(selection.repository, signal, this.#options.fetchStreaming), shards = selectGgufShards(repository.files, selection.file);
      const total = shards.reduce((sum, shard) => sum + shard.sizeBytes, 0); if (!Number.isSafeInteger(total)) throw new Error("MODEL_INCOMPLETE");
      if (new Set(shards.map(shard => basename(shard.name))).size !== shards.length) throw new Error("MODEL_INCOMPLETE");
      this.#assert(owner); signal.throwIfAborted(); await this.#freeDisk(this.#models, total);
      const model: LlamaCppModel = { ...selection, file: shards[0]!.name, id: llamaCppModelId(selection), sizeBytes: total, revision: repository.revision, shards };
      const staging = join(this.#models, `.download-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
      const started = this.#now(); let completed = 0;
      try {
        for (const shard of shards) {
          for (;;) {
            this.#assert(owner); signal.throwIfAborted();
            if (this.#operation?.paused) { await this.#waitForResume(signal); continue; }
            const transfer = new AbortController(); this.#transferAbort = transfer;
            try {
              await downloadLlamaCppAsset({ size: shard.sizeBytes, sha256: shard.sha256, url: hfDownloadUrl(selection.repository, repository.revision, shard.name) }, join(staging, basename(shard.name)), "hf", AbortSignal.any([signal, transfer.signal]), bytes => this.#progress(owner, signal, completed + bytes, total, started), true, this.#options.fetchStreaming);
              break;
            } catch (error) {
              if (signal.aborted) throw error;
              if (error instanceof LlamaCppResumeReadError) { if (this.#operation) this.#operation.paused = true; continue; }
              if (transfer.signal.reason === "DOWNLOAD_PAUSED") continue;
              throw error;
            } finally { if (this.#transferAbort === transfer) this.#transferAbort = undefined; }
          }
          completed += shard.sizeBytes;
        }
        this.#assert(owner); signal.throwIfAborted(); await atomicRecord(join(staging, "model.json"), { format: 1, ...model });
        this.#assert(owner); signal.throwIfAborted();
        try { await rename(staging, join(this.#models, model.id)); }
        catch (error) { if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || !(await this.#inventory()).some(existing => existing.id === model.id)) throw error; }
        await this.#changed(owner);
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }
  async #waitForResume(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await new Promise<void>((resolvePromise, reject) => {
      const abort = () => { cleanup(); reject(signal.reason); }, cleanup = () => { signal.removeEventListener("abort", abort); if (this.#wakeDownload === wake) this.#wakeDownload = undefined; }, wake = () => { cleanup(); resolvePromise(); };
      this.#wakeDownload = wake; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
  }
  #transfer(owner: RuntimeOwnerGeneration, target: LlamaCppTransferTarget, downloadOnly: boolean): void {
    this.#assert(owner);
    if (!this.#operation || !this.#operationOwner || !sameOwner(owner, this.#operationOwner) || this.#operation.transferId !== target.transferId || !sameLlamaCppSelection(this.#operation.selection, target.selection) || downloadOnly && this.#operation.kind !== "download") throw new LlamaCppRuntimeError("RUNTIME_ERROR", "TRANSFER_CHANGED", "The selected transfer changed.");
  }
  async pause(owner: RuntimeOwnerGeneration, target: LlamaCppTransferTarget): Promise<void> { this.#transfer(owner, target, true); this.#operation!.paused = true; this.#operation!.bytesPerSecond = 0; this.#transferAbort?.abort("DOWNLOAD_PAUSED"); }
  async resume(owner: RuntimeOwnerGeneration, target: LlamaCppTransferTarget): Promise<void> { this.#transfer(owner, target, true); this.#operation!.paused = false; this.#wakeDownload?.(); }
  async cancel(owner: RuntimeOwnerGeneration, target: LlamaCppTransferTarget): Promise<void> { this.#transfer(owner, target, false); await this.#cancelFlight(); this.#assert(owner); }
  async #cancelFlight(): Promise<void> {
    const flight = this.#flight; this.#operationAbort?.abort(new LocalRuntimeError("OPERATION_CANCELLED", "The runtime operation was cancelled.")); this.#wakeDownload?.();
    if (flight) { try { await flight; } catch (error) { if (!(error instanceof LocalRuntimeError && ["OPERATION_CANCELLED", "OWNER_CHANGED"].includes(error.code))) throw error; } }
  }
  async #preset(owner: RuntimeOwnerGeneration, signal: AbortSignal): Promise<string> {
    const models = await this.#inventory(); this.#assert(owner); signal.throwIfAborted();
    const lines = ["version = 1", "[*]", "ctx-size = 32768", ...models.flatMap(model => ["", ...llamaCppModelPreset(model, this.#options.contextLimits?.(model) ?? [])])];
    const preset = lines.join("\n") + "\n"; await atomicText(join(this.#root, "models.ini"), preset); this.#assert(owner); signal.throwIfAborted(); return preset;
  }
  start(owner: RuntimeOwnerGeneration, options: { readonly restart?: boolean; readonly signal?: AbortSignal } = {}): Promise<void> {
    this.#assert(owner); if (this.#starting) return this.#starting;
    if (this.#child && this.#ready && !options.restart && !this.#retirement && !this.#stopping) return Promise.resolve();
    const flight = (async () => {
      if (!options.restart && !this.#retirement && !this.#stopping && await this.#external() === "alive" && await this.#healthy(options.signal)) { this.#assert(owner); options.signal?.throwIfAborted(); return; }
      await this.#exclusive(owner, "start", undefined, async internalSignal => {
        const signal = options.signal ? AbortSignal.any([internalSignal, options.signal]) : internalSignal;
        const installed = await this.#installed(); if (!installed) throw new LlamaCppRuntimeError("MODEL_NOT_FOUND", "NOT_INSTALLED", "Install the local runtime first.");
        if (this.#child) await this.#stopChild(); this.#assert(owner); signal.throwIfAborted();
        if (await portOccupied(LLAMA_CPP_MANAGED_PORT)) throw new LocalRuntimeError("PORT_CONFLICT", "The managed runtime port is already in use.");
        const preset = await this.#preset(owner, signal), command = llamaCppProcessCommand(installed.binary, ["--host", "127.0.0.1", "--port", String(LLAMA_CPP_MANAGED_PORT), "--models-dir", this.#models, "--models-max", "1", "--models-preset", join(this.#root, "models.ini"), "--parallel", "1", "--jinja"], this.#platform);
        const env = Object.fromEntries(Object.entries(this.#options.environment ?? process.env).filter(([key]) => !/^(LLAMA_|HF_TOKEN$|ENV$|BASH_ENV$)/u.test(key))); env["LLAMA_CACHE"] = join(this.#root, "cache");
        const child = (this.#options.spawnProcess ?? spawn)(command.binary, command.args, { cwd: dirname(installed.binary), env, detached: this.#platform !== "win32", windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
        this.#child = child; this.#ready = false;
        let spawnError: Error | undefined; child.on("error", error => { spawnError = error; });
        try {
          let healthy = false;
          for (let i = 0; i < (this.#options.startPollCount ?? 120); i++) {
            this.#assert(owner); signal.throwIfAborted(); if (spawnError || child.exitCode !== null || child.signalCode !== null || this.#child !== child) throw spawnError ?? new Error("START_FAILED");
            if (await this.#healthy(signal)) { healthy = true; break; } await delay(this.#options.startPollMs ?? 250, undefined, { signal });
          }
          if (!healthy) throw new Error("START_FAILED");
          const proof = await startLlamaCppOwnerProof(); let adopted = false;
          try {
            this.#assert(owner); signal.throwIfAborted(); if (this.#child !== child || child.exitCode !== null || child.signalCode !== null) throw new Error("START_FAILED");
            await atomicRecord(join(this.#root, "server-owner.json"), { format: 1, identity: proof.identity, preset } satisfies RuntimeOwnerRecord);
            this.#assert(owner); signal.throwIfAborted(); if (this.#child !== child || child.exitCode !== null || child.signalCode !== null) throw new Error("START_FAILED");
            this.#proof = proof; this.#ready = true; adopted = true;
          } finally { if (!adopted) await proof.close(); }
          child.once("exit", () => { this.#ready = false; if (this.#child === child && !this.#retirement) this.#beginRetirement(child); });
          await this.#changed(owner);
        } catch (error) { await this.#stopChild(); throw error; }
      }, 35000);
    })().finally(() => { if (this.#starting === flight) this.#starting = undefined; });
    this.#starting = flight; return flight;
  }
  #beginRetirement(child: ChildProcess): Retirement {
    if (this.#retirement) return this.#retirement;
      this.#ready = false; const proof = this.#proof, controller = new AbortController();
      const exited = new Promise<void>(resolvePromise => {
        if (child.exitCode !== null || child.signalCode !== null) resolvePromise(); else { const done = () => { child.off("exit", done); child.off("close", done); resolvePromise(); }; child.once("exit", done); child.once("close", done); }
      });
      const tree = this.#platform === "win32" ? child.exitCode !== null || child.signalCode !== null ? Promise.resolve(false) : (this.#options.terminateTree ?? (value => terminateLlamaCppTree(value, this.#platform)))(child).catch(() => false) : Promise.resolve(true);
      if (this.#platform !== "win32") child.kill("SIGTERM");
      const force = this.#platform !== "win32" ? setTimeout(() => { if (child.exitCode === null && child.signalCode === null) void (this.#options.terminateTree ?? (value => terminateLlamaCppTree(value, this.#platform)))(child).catch(() => undefined); }, 1500) : undefined;
      force?.unref();
      const completed = Promise.all([exited, tree]).then(async ([, treeEnded]) => {
        if (!treeEnded && !controller.signal.aborted) await new Promise<void>(resolvePromise => controller.signal.addEventListener("abort", () => resolvePromise(), { once: true }));
        clearTimeout(force); await proof?.close();
        if (this.#child === child) { this.#child = undefined; this.#proof = undefined; this.#ready = false; }
        if (this.#retirement?.child === child) this.#retirement = undefined;
      });
      const retirement = { child, completed, controller }; this.#retirement = retirement;
      // A timed-out caller no longer awaits this promise. Keep late errors observed
      // while retaining the captured retirement record for an explicit retry.
      void completed.catch(() => undefined); return retirement;
  }
  async #stopChild(): Promise<void> {
    const child = this.#child; if (!child) return;
    const previous = this.#retirement, retirement = this.#beginRetirement(child);
    if (previous && this.#platform === "win32" && child.exitCode === null && child.signalCode === null) {
      if (await (this.#options.terminateTree ?? (value => terminateLlamaCppTree(value, this.#platform)))(child).catch(() => false)) retirement.controller.abort();
    }
    const timeout = this.#options.stopTimeoutMs ?? 4000; let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([retirement.completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LlamaCppRuntimeError("RUNTIME_ERROR", "STOP_TIMEOUT", "The local runtime has not confirmed its stop.")), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async stop(owner: RuntimeOwnerGeneration): Promise<void> {
    this.#assert(owner); if (this.#stopping) throw new LlamaCppRuntimeError("INSTALL_BUSY", "BUSY", "The runtime is stopping."); this.#stopping = true;
    try {
      await this.#cancelFlight();
      if (!this.#child) { const external = await this.#external(); this.#assert(owner); if (external !== "ended") throw new LlamaCppRuntimeError("RUNTIME_ERROR", external === "alive" ? "OWNED_ELSEWHERE" : "OWNER_UNKNOWN", "Another instance owns this runtime."); }
      await this.#stopChild(); this.#assert(owner);
    } finally { this.#stopping = false; }
  }
  configure<T>(owner: RuntimeOwnerGeneration, effect: () => Promise<T>): Promise<T> { return this.#exclusive(owner, "start", undefined, async signal => { this.#assert(owner); signal.throwIfAborted(); const result = await effect(); this.#assert(owner); signal.throwIfAborted(); return result; }); }
  async remove<T>(owner: RuntimeOwnerGeneration, effect: () => Promise<T>): Promise<T> {
    this.#assert(owner); if (this.#stopping) throw new LlamaCppRuntimeError("INSTALL_BUSY", "BUSY", "The runtime is stopping."); this.#stopping = true;
    try {
      await this.#cancelFlight(); await this.#stopChild(); await this.#directories();
      return await withLlamaCppMutationLock(this.#root, new AbortController().signal, 0, async () => {
        this.#assert(owner); await this.#options.validateConnection(owner); this.#assert(owner);
        const external = await this.#external(); if (external !== "ended") throw new LlamaCppRuntimeError("RUNTIME_ERROR", external === "alive" ? "OWNED_ELSEWHERE" : "OWNER_UNKNOWN", "Another instance owns this runtime.");
        const result = await effect(); this.#assert(owner); return result;
      });
    } finally { this.#stopping = false; }
  }
  async dispose(owner: RuntimeOwnerGeneration): Promise<void> { this.#assert(owner); this.#disposed = true; this.#stopping = true; try { await this.#cancelFlight(); await this.#stopChild(); } finally { this.#stopping = false; } }
}

async function atomicText(file: string, value: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, value, { flag: "wx", mode: 0o600 }); await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
}
async function atomicRecord(file: string, value: unknown): Promise<void> { await atomicText(file, JSON.stringify(value)); }
async function portOccupied(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolvePromise => { const socket = createConnection({ host: "127.0.0.1", port }); const done = (result: boolean) => { socket.destroy(); resolvePromise(result); }; socket.once("connect", () => done(true)); socket.once("error", (error: NodeJS.ErrnoException) => done(error.code !== "ECONNREFUSED")); socket.setTimeout(1000, () => done(true)); });
}
function mapped(error: unknown): Error {
  if (error instanceof LocalRuntimeError) return error;
  if (error instanceof Error && error.name === "AbortError") return new LocalRuntimeError("OPERATION_CANCELLED", "The runtime operation was cancelled.");
  const message = error instanceof Error ? error.message : "";
  if (message === "UNSUPPORTED") return new LocalRuntimeError("UNSUPPORTED_PLATFORM", "The local runtime is unsupported on this platform.");
  if (message === "MODEL_INCOMPLETE") return new LlamaCppRuntimeError("MODEL_INVALID", "MODEL_INCOMPLETE", "The selected model has incomplete shards.");
  if (["INVALID_MODEL", "MODEL_NOT_FOUND"].includes(message)) return new LlamaCppRuntimeError("MODEL_INVALID", "INVALID_MODEL", "The selected model is unavailable.");
  if (message === "RELEASE_UNAVAILABLE") return new LlamaCppRuntimeError("MODEL_NOT_FOUND", "RELEASE_UNAVAILABLE", "The official runtime release is unavailable.");
  if (error instanceof LlamaCppResumeReadError) return new LlamaCppRuntimeError("DOWNLOAD_REJECTED", "RESUME_READ_FAILED", "The paused download prefix is unavailable.");
  if (message.startsWith("DOWNLOAD_")) return new LlamaCppRuntimeError(message === "DOWNLOAD_TIMEOUT" ? "DOWNLOAD_TIMEOUT" : message === "DOWNLOAD_CHECKSUM" ? "CHECKSUM_MISMATCH" : "DOWNLOAD_REJECTED", "DOWNLOAD_FAILED", "The verified download did not complete.");
  return new LocalRuntimeError("RUNTIME_ERROR", "The local runtime operation did not complete.");
}
