import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createWdaBuildCacheKey, createWdaOwnerFingerprint } from "./wda-build-plan.js";
import { WdaProcessExecutor, type WdaProcessExecutorOptions, type WdaProcessExit } from "./wda-child-process.js";
import { WdaLoopbackClient, type WdaDriverHealth, type WdaDriverSession } from "./wda-loopback-client.js";
import { preparePinnedWdaSource, type PreparedWdaSource, type PrepareWdaSourceOptions } from "./wda-source.js";
import { WDA_SOURCE_PIN } from "./wda-source-pin.js";

const BUILD_MARKER = ".joko-wda-build.json";
const buildFlights = new Map<string, Promise<void>>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export type WdaManagerErrorCode = "UNSUPPORTED_PLATFORM" | "INVALID_CONFIGURATION" | "INSTANCE_BUSY" | "DEVICE_BUSY" |
  "CANCELLED" | "BUILD_FAILED" | "BUILD_TIMEOUT" | "BUILD_INCOMPLETE" | "PORT_UNAVAILABLE" | "START_TIMEOUT" |
  "START_FAILED" | "STALE_PROCESS" | "SESSION_CLEANUP_FAILED" | "CLEANUP_REQUIRED";

export class WdaManagerError extends Error {
  constructor(readonly code: WdaManagerErrorCode, message: string) { super(message); }
}

export interface WdaRunningDriver {
  readonly instanceId: string;
  readonly simulatorUdid: string;
  readonly leaseId: string;
  readonly pid: number;
  readonly controlPort: number;
  readonly mjpegPort: number;
  readonly sourceRevision: string;
  readonly buildCacheKey: string;
  readonly driverSessionId: string;
  readonly health: WdaDriverHealth;
  readonly state: "ready" | "exited";
}

interface OwnedChild {
  readonly pid: number;
  readonly exited: Promise<WdaProcessExit>;
  readonly isExited: boolean;
  stop(): Promise<void>;
}

interface Executor {
  build(signal?: AbortSignal): Promise<void>;
  launch(signal?: AbortSignal): OwnedChild;
  retryPendingBuildCleanup?(): Promise<void>;
}

const buildCleanup = new Map<string, Executor>();

interface DriverClient {
  probe(signal?: AbortSignal): Promise<WdaDriverHealth>;
  createSession(signal?: AbortSignal): Promise<WdaDriverSession>;
  deleteSession(id: string, signal?: AbortSignal): Promise<void>;
}

export interface WdaDriverManagerOptions {
  readonly archivePath: string;
  readonly cacheRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly startTimeoutMs?: number;
  readonly prepareSource?: (options: PrepareWdaSourceOptions) => Promise<PreparedWdaSource>;
  readonly createExecutor?: (options: WdaProcessExecutorOptions) => Executor;
  readonly createClient?: (input: { readonly controlPort: number; readonly cacheRoot: string;
    readonly instanceId: string; readonly simulatorUdid: string }) => DriverClient;
  readonly allocatePort?: () => Promise<number>;
  readonly clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
}

export interface WdaDriverStartOptions {
  readonly instanceId: string;
  readonly simulatorUdid: string;
  readonly runtimeIdentifier: string;
  readonly xcodeBuild: string;
  readonly architecture: "arm64" | "x86_64";
  readonly signal?: AbortSignal;
}

interface ActiveDriver { readonly snapshot: WdaRunningDriver; readonly child: OwnedChild; readonly client: DriverClient }

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WdaManagerError("CANCELLED", "Driver start was cancelled.");
}

async function waitForSharedBuild(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  if (!signal) return work;
  return new Promise<void>((resolveWait, reject) => {
    const onAbort = (): void => { signal.removeEventListener("abort", onAbort);
      reject(new WdaManagerError("CANCELLED", "Driver build wait was cancelled.")); };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(() => { signal.removeEventListener("abort", onAbort); resolveWait(); }, error => {
      signal.removeEventListener("abort", onAbort); reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

function safeRoot(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new WdaManagerError("INVALID_CONFIGURATION", "Driver cache root is invalid.");
  }
  return resolve(value);
}

function validStart(options: WdaDriverStartOptions): void {
  if (!options.instanceId || options.instanceId.length > 128 || options.instanceId.trim() !== options.instanceId ||
      /[\0\r\n]/u.test(options.instanceId) || !UUID.test(options.simulatorUdid) ||
      !/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[A-Za-z0-9-]{1,100}$/u.test(options.runtimeIdentifier) ||
      !/^[A-Za-z0-9.()-]{1,100}$/u.test(options.xcodeBuild) ||
      !["arm64", "x86_64"].includes(options.architecture)) {
    throw new WdaManagerError("INVALID_CONFIGURATION", "Driver start identity is invalid.");
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    return address.port;
  } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
}

function defaultClock(): NonNullable<WdaDriverManagerOptions["clock"]> {
  return { now: () => performance.now(), sleep: (ms, signal) => new Promise((resolveSleep, reject) => {
    if (signal?.aborted) { reject(new WdaManagerError("CANCELLED", "Driver start was cancelled.")); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(new WdaManagerError("CANCELLED", "Driver start was cancelled.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolveSleep(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  }) };
}

async function hasBuildProduct(derivedDataPath: string): Promise<boolean> {
  try {
    const products = join(derivedDataPath, "Build", "Products");
    const info = await lstat(products);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const items = await readdir(products, { withFileTypes: true });
    for (const item of items) {
      if (!item.isFile() || !item.name.endsWith(".xctestrun") || item.isSymbolicLink()) continue;
      const product = await lstat(join(products, item.name));
      if (product.isFile() && !product.isSymbolicLink() && product.size > 0) return true;
    }
    return false;
  } catch { return false; }
}

async function buildMarkerMatches(derivedDataPath: string, identity: Record<string, string>): Promise<boolean> {
  try {
    const info = await lstat(join(derivedDataPath, BUILD_MARKER));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) return false;
    const marker: unknown = JSON.parse(await readFile(join(derivedDataPath, BUILD_MARKER), "utf8"));
    return marker !== null && typeof marker === "object" && !Array.isArray(marker) &&
      Object.keys(marker).sort().join(",") === Object.keys(identity).sort().join(",") &&
      Object.entries(identity).every(([key, value]) => (marker as Record<string, unknown>)[key] === value) &&
      await hasBuildProduct(derivedDataPath);
  } catch { return false; }
}

async function ensureBuild(derivedDataPath: string, identity: Record<string, string>, executor: Executor,
  signal?: AbortSignal): Promise<void> {
  if (buildCleanup.has(derivedDataPath)) {
    throw new WdaManagerError("CLEANUP_REQUIRED", "An earlier driver build needs verified cleanup.");
  }
  const previous = buildFlights.get(derivedDataPath);
  if (previous) { await waitForSharedBuild(previous, signal); cancelled(signal); return; }
  const work = (async () => {
    if (await buildMarkerMatches(derivedDataPath, identity)) return;
    cancelled(signal);
    const buildsRoot = dirname(derivedDataPath);
    if (!/^[0-9a-f]{64}$/u.test(derivedDataPath.slice(buildsRoot.length + 1))) {
      throw new WdaManagerError("INVALID_CONFIGURATION", "Driver build cache path is invalid.");
    }
    await rm(derivedDataPath, { recursive: true, force: true });
    await mkdir(derivedDataPath, { recursive: true, mode: 0o700 });
    try { await executor.build(signal); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "STOP_FAILED") {
        buildCleanup.set(derivedDataPath, executor);
        throw new WdaManagerError("CLEANUP_REQUIRED", "Driver build child needs verified cleanup.");
      }
      cancelled(signal);
      if (error instanceof Error && "code" in error && error.code === "BUILD_TIMEOUT") {
        throw new WdaManagerError("BUILD_TIMEOUT", "Driver build timed out.");
      }
      throw new WdaManagerError("BUILD_FAILED", "Driver build did not complete.");
    }
    cancelled(signal);
    if (!await hasBuildProduct(derivedDataPath)) {
      throw new WdaManagerError("BUILD_INCOMPLETE", "Driver build produced no test runner.");
    }
    const temporary = join(derivedDataPath, `.joko-build-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, join(derivedDataPath, BUILD_MARKER));
    } finally { await rm(temporary, { force: true }); }
  })();
  buildFlights.set(derivedDataPath, work);
  try { await work; } finally { if (buildFlights.get(derivedDataPath) === work) buildFlights.delete(derivedDataPath); }
}

export class WdaDriverManager {
  readonly #options: WdaDriverManagerOptions;
  readonly #cacheRoot: string;
  readonly #clock: NonNullable<WdaDriverManagerOptions["clock"]>;
  readonly #running = new Map<string, ActiveDriver>();
  readonly #starting = new Set<string>();
  readonly #deviceOwners = new Map<string, string>();
  readonly #retiring = new Map<string, OwnedChild>();
  readonly #retiringBuildPaths = new Map<string, string>();
  readonly #stopping = new Map<string, Promise<void>>();

  constructor(options: WdaDriverManagerOptions) {
    this.#options = options;
    this.#cacheRoot = safeRoot(options.cacheRoot);
    this.#clock = options.clock ?? defaultClock();
    const startTimeoutMs = options.startTimeoutMs ?? 90_000;
    if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1 || startTimeoutMs > 180_000) {
      throw new WdaManagerError("INVALID_CONFIGURATION", "Driver start timeout is invalid.");
    }
  }

  get(instanceId: string): WdaRunningDriver | null {
    const active = this.#running.get(instanceId);
    return active ? { ...active.snapshot, state: active.child.isExited ? "exited" : "ready" } : null;
  }

  async start(options: WdaDriverStartOptions): Promise<WdaRunningDriver> {
    if ((this.#options.platform ?? process.platform) !== "darwin") {
      throw new WdaManagerError("UNSUPPORTED_PLATFORM", "Driver requires local macOS.");
    }
    validStart(options);
    cancelled(options.signal);
    const normalizedUdid = options.simulatorUdid.toUpperCase();
    if (this.#starting.has(options.instanceId) || this.#running.has(options.instanceId) ||
        this.#retiring.has(options.instanceId) || this.#retiringBuildPaths.has(options.instanceId) ||
        this.#stopping.has(options.instanceId)) {
      throw new WdaManagerError("INSTANCE_BUSY", "Driver instance is already active.");
    }
    if (this.#deviceOwners.has(normalizedUdid)) {
      throw new WdaManagerError("DEVICE_BUSY", "Simulator device already has an owned driver.");
    }
    this.#starting.add(options.instanceId);
    this.#deviceOwners.set(normalizedUdid, options.instanceId);
    let child: OwnedChild | undefined;
    let client: DriverClient | undefined;
    let session: WdaDriverSession | undefined;
    let derivedDataPath: string | undefined;
    try {
      await mkdir(this.#cacheRoot, { recursive: true, mode: 0o700 });
      const cacheInfo = await lstat(this.#cacheRoot);
      if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) {
        throw new WdaManagerError("INVALID_CONFIGURATION", "Driver cache root is unsafe.");
      }
      const prepare = this.#options.prepareSource ?? preparePinnedWdaSource;
      const prepared = await prepare({ archivePath: this.#options.archivePath,
        cacheRoot: join(this.#cacheRoot, "sources"), signal: options.signal });
      cancelled(options.signal);
      if (prepared.revision !== WDA_SOURCE_PIN.revision ||
          prepared.checkoutPath !== join(this.#cacheRoot, "sources", WDA_SOURCE_PIN.revision) ||
          prepared.projectPath !== join(prepared.checkoutPath, "WebDriverAgent.xcodeproj")) {
        throw new WdaManagerError("INVALID_CONFIGURATION", "Driver source did not match the pinned checkout.");
      }
      const ownerFingerprint = createWdaOwnerFingerprint({ cacheRoot: this.#cacheRoot,
        instanceId: options.instanceId, simulatorUdid: options.simulatorUdid });
      const buildCacheKey = createWdaBuildCacheKey({ sourceRevision: prepared.revision,
        xcodeBuild: options.xcodeBuild, runtimeIdentifier: options.runtimeIdentifier,
        architecture: options.architecture, ownerFingerprint });
      const buildsRoot = join(this.#cacheRoot, "builds");
      await mkdir(buildsRoot, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(buildsRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new WdaManagerError("INVALID_CONFIGURATION", "Driver build cache root is unsafe.");
      }
      derivedDataPath = join(buildsRoot, buildCacheKey);
      const allocate = this.#options.allocatePort ?? allocateLoopbackPort;
      let controlPort: number;
      let mjpegPort: number;
      try {
        controlPort = await allocate();
        cancelled(options.signal);
        mjpegPort = await allocate();
        for (let attempt = 0; mjpegPort === controlPort && attempt < 3; attempt += 1) {
          cancelled(options.signal);
          mjpegPort = await allocate();
        }
      } catch {
        cancelled(options.signal);
        throw new WdaManagerError("PORT_UNAVAILABLE", "Driver ports could not be allocated.");
      }
      if (![controlPort, mjpegPort].every(value => Number.isSafeInteger(value) && value >= 1024 && value <= 65_535) ||
          controlPort === mjpegPort) throw new WdaManagerError("PORT_UNAVAILABLE", "Driver ports could not be allocated.");
      cancelled(options.signal);
      const executorOptions: WdaProcessExecutorOptions = { cacheRoot: this.#cacheRoot,
        instanceId: options.instanceId, checkoutPath: prepared.checkoutPath, derivedDataPath,
        simulatorUdid: options.simulatorUdid, architecture: options.architecture,
        controlPort, mjpegPort, platform: this.#options.platform };
      const executor = this.#options.createExecutor?.(executorOptions) ?? new WdaProcessExecutor(executorOptions);
      const identity = { buildCacheKey, sourceRevision: prepared.revision, xcodeBuild: options.xcodeBuild,
        runtimeIdentifier: options.runtimeIdentifier, architecture: options.architecture, ownerFingerprint };
      await ensureBuild(derivedDataPath, identity, executor, options.signal);
      cancelled(options.signal);
      child = executor.launch(options.signal);
      client = this.#options.createClient?.({ controlPort, cacheRoot: this.#cacheRoot,
        instanceId: options.instanceId, simulatorUdid: options.simulatorUdid }) ??
        new WdaLoopbackClient({ controlPort, cacheRoot: this.#cacheRoot,
          instanceId: options.instanceId, simulatorUdid: options.simulatorUdid, timeoutMs: 5_000 });
      const deadline = this.#clock.now() + (this.#options.startTimeoutMs ?? 90_000);
      let health: WdaDriverHealth | undefined;
      while (this.#clock.now() < deadline) {
        cancelled(options.signal);
        if (child.isExited) throw new WdaManagerError("START_FAILED", "Driver process exited before readiness.");
        try {
          const observed = await client.probe(options.signal);
          if (observed.ready) { health = observed; break; }
        } catch (error) {
          cancelled(options.signal);
          if (error instanceof Error && "code" in error &&
              ["OWNER_MISMATCH", "PROTOCOL_ERROR"].includes(String(error.code))) {
            throw new WdaManagerError("START_FAILED", "Driver ownership or health response is invalid.");
          }
        }
        await this.#clock.sleep(500, options.signal);
      }
      cancelled(options.signal);
      if (!health) throw new WdaManagerError("START_TIMEOUT", "Driver did not become ready in time.");
      session = await client.createSession(options.signal);
      cancelled(options.signal);
      if (this.#clock.now() >= deadline) throw new WdaManagerError("START_TIMEOUT", "Driver session setup exceeded its time limit.");
      if (child.isExited) throw new WdaManagerError("START_FAILED", "Driver process exited during session creation.");
      const snapshot: WdaRunningDriver = { instanceId: options.instanceId,
        simulatorUdid: normalizedUdid, leaseId: randomUUID(), pid: child.pid,
        controlPort, mjpegPort, sourceRevision: prepared.revision, buildCacheKey,
        driverSessionId: session.id, health, state: "ready" };
      this.#running.set(options.instanceId, { snapshot, child, client });
      return snapshot;
    } catch (error) {
      if (session && client) await client.deleteSession(session.id).catch(() => undefined);
      if (child) {
        try { await child.stop(); }
        catch {
          this.#retiring.set(options.instanceId, child);
          throw new WdaManagerError("CLEANUP_REQUIRED", "Driver child needs verified cleanup before retry.");
        }
      }
      if (error instanceof WdaManagerError && error.code === "CLEANUP_REQUIRED" && derivedDataPath &&
          buildCleanup.has(derivedDataPath)) {
        this.#retiringBuildPaths.set(options.instanceId, derivedDataPath);
        throw error;
      }
      cancelled(options.signal);
      if (error instanceof WdaManagerError) throw error;
      throw new WdaManagerError("START_FAILED", "Driver could not start.");
    } finally {
      this.#starting.delete(options.instanceId);
      if (!this.#running.has(options.instanceId) && !this.#retiring.has(options.instanceId) &&
          !this.#retiringBuildPaths.has(options.instanceId) && this.#deviceOwners.get(normalizedUdid) === options.instanceId) {
        this.#deviceOwners.delete(normalizedUdid);
      }
    }
  }

  async stop(instanceId: string, leaseId: string): Promise<void> {
    const active = this.#running.get(instanceId);
    if (!active) return;
    if (active.snapshot.leaseId !== leaseId) throw new WdaManagerError("STALE_PROCESS", "Driver instance lease changed.");
    const existing = this.#stopping.get(instanceId);
    if (existing) return existing;
    const task = (async () => {
      let sessionFailed = false;
      if (!active.child.isExited) {
        try { await active.client.deleteSession(active.snapshot.driverSessionId); }
        catch { sessionFailed = true; }
      }
      try { await active.child.stop(); }
      catch {
        this.#retiring.set(instanceId, active.child);
        throw new WdaManagerError("CLEANUP_REQUIRED", "Driver child needs verified cleanup.");
      }
      if (this.#running.get(instanceId) === active) this.#running.delete(instanceId);
      if (this.#deviceOwners.get(active.snapshot.simulatorUdid) === instanceId) {
        this.#deviceOwners.delete(active.snapshot.simulatorUdid);
      }
      if (sessionFailed) throw new WdaManagerError("SESSION_CLEANUP_FAILED", "Driver session cleanup was not confirmed.");
    })();
    this.#stopping.set(instanceId, task);
    try { await task; } finally { if (this.#stopping.get(instanceId) === task) this.#stopping.delete(instanceId); }
  }

  async retryOwnedCleanup(instanceId: string): Promise<void> {
    const buildPath = this.#retiringBuildPaths.get(instanceId);
    if (buildPath) {
      const executor = buildCleanup.get(buildPath);
      if (executor && !executor.retryPendingBuildCleanup) {
        throw new WdaManagerError("CLEANUP_REQUIRED", "Driver build child has no verified cleanup route.");
      }
      await executor?.retryPendingBuildCleanup?.();
      if (buildCleanup.get(buildPath) === executor) buildCleanup.delete(buildPath);
      this.#retiringBuildPaths.delete(instanceId);
    }
    const child = this.#retiring.get(instanceId);
    if (child) {
      await child.stop();
      if (this.#retiring.get(instanceId) === child) this.#retiring.delete(instanceId);
      if (this.#running.get(instanceId)?.child === child) this.#running.delete(instanceId);
    }
    if (!this.#running.has(instanceId) && !this.#retiring.has(instanceId) && !this.#retiringBuildPaths.has(instanceId)) {
      for (const [udid, owner] of this.#deviceOwners) if (owner === instanceId) this.#deviceOwners.delete(udid);
    }
  }
}
