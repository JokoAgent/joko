import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app, screen } from "electron";
import type { RemoteDesktopDisplay, RemoteDesktopViewerDisplayHandle } from "@joko/device-peer";

const NEVER_ABORTED = new AbortController().signal;
const builds = new WeakMap<DesktopRemoteDesktopMacViewerDisplayRuntime, Map<string, Promise<string>>>();
let active: MacViewerDisplay | undefined;
let nativeRuntime: DesktopRemoteDesktopMacViewerDisplayRuntime | undefined;

export interface DesktopRemoteDesktopMacViewerDisplayRuntime {
  readonly platform: string;
  readonly packaged: boolean;
  readonly arch: string;
  readonly appPath: string;
  readonly userData: string;
  readFile(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exec(file: string, args: readonly string[], timeout: number): Promise<string>;
  spawn(file: string): ChildProcessWithoutNullStreams;
  displays(): readonly Pick<Electron.Display, "id" | "size" | "label">[];
  delay(milliseconds: number): Promise<void>;
}

/** CoreGraphics SPI is restricted to an unpackaged macOS development host. */
export async function supportsDesktopRemoteDesktopMacViewerDisplay(signal: AbortSignal = NEVER_ABORTED,
  runtime: DesktopRemoteDesktopMacViewerDisplayRuntime = runtimePort()): Promise<boolean> {
  try { await binary(runtime, signal); checkAbort(signal); return true; }
  catch { checkAbort(signal); return false; }
}

export async function createDesktopRemoteDesktopMacViewerDisplay(sourceDisplayId: string, current: () => boolean,
  onFailure: () => void, signal: AbortSignal = NEVER_ABORTED,
  runtime: DesktopRemoteDesktopMacViewerDisplayRuntime = runtimePort()): Promise<RemoteDesktopViewerDisplayHandle> {
  requireDevelopment(runtime); checkAbort(signal);
  if (active !== undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
  const owner = new MacViewerDisplay(sourceDisplayId, current, onFailure, signal, runtime);
  active = owner;
  try { await owner.start(); return owner; }
  catch (error) {
    owner.dispose();
    if (!owner.dispatched) { if (active === owner) active = undefined; }
    else await owner.restore(() => true).catch(() => undefined);
    throw error;
  }
}

async function binary(runtime: DesktopRemoteDesktopMacViewerDisplayRuntime, signal: AbortSignal): Promise<string> {
  requireDevelopment(runtime); checkAbort(signal);
  const source = join(runtime.appPath, "native", "remote-desktop", "macos-viewer-display.m");
  const bytes = await observe(runtime.readFile(source), signal); checkAbort(signal);
  const digest = createHash("sha256").update(bytes).update(runtime.arch).digest("hex");
  const directory = join(runtime.userData, "remote-desktop", "native", digest);
  const target = join(directory, "joko-viewer-display");
  let cache = builds.get(runtime);
  if (cache === undefined) { cache = new Map(); builds.set(runtime, cache); }
  let building = cache.get(target);
  if (building === undefined) {
    const capturedCache = cache;
    building = (async () => {
      if (!await runtime.exists(target)) {
        await runtime.mkdir(directory);
        const temporary = `${target}.${process.pid}.tmp`;
        try {
          await runtime.exec("clang", ["-fobjc-arc", "-framework", "Foundation", "-framework", "CoreGraphics", source, "-o", temporary], 60_000);
          await runtime.rename(temporary, target);
        } finally { await runtime.remove(temporary).catch(() => undefined); }
      }
      const reply: unknown = JSON.parse(await runtime.exec(target, ["--probe"], 5_000));
      if (typeof reply !== "object" || reply === null || Array.isArray(reply)
        || Object.keys(reply).join(",") !== "available" || (reply as { available?: unknown }).available !== true) throw unavailable();
      return target;
    })().catch(() => { capturedCache.delete(target); throw unavailable(); });
    cache.set(target, building);
  }
  const executable = await observe(building, signal); checkAbort(signal); requireDevelopment(runtime);
  return executable;
}

class MacViewerDisplay implements RemoteDesktopViewerDisplayHandle {
  readonly #sourceId: string;
  readonly #initialCurrent: () => boolean;
  readonly #onFailure: () => void;
  readonly #signal: AbortSignal;
  readonly #runtime: DesktopRemoteDesktopMacViewerDisplayRuntime;
  #original: Pick<Electron.Display, "id" | "size" | "label"> | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #id: number | undefined;
  #exited = false;
  #disposed = false;
  #notified = false;
  #termination: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<RemoteDesktopDisplay> | undefined;
  #restoring: Promise<RemoteDesktopDisplay> | undefined;
  #restored: RemoteDesktopDisplay | undefined;
  #rejectPending: (() => void) | undefined;
  readonly #aborted = (): void => { this.#fail(); };

  constructor(sourceId: string, current: () => boolean, onFailure: () => void, signal: AbortSignal,
    runtime: DesktopRemoteDesktopMacViewerDisplayRuntime) {
    this.#sourceId = sourceId; this.#initialCurrent = current; this.#onFailure = onFailure;
    this.#signal = signal; this.#runtime = runtime;
  }
  get displayId(): string | undefined { return this.#id === undefined ? undefined : String(this.#id); }
  get dispatched(): boolean { return this.#child !== undefined; }

  async start(): Promise<void> {
    this.#proof(this.#initialCurrent);
    if (!/^[1-9][0-9]{0,9}$/u.test(this.#sourceId) || Number(this.#sourceId) > 0xffff_ffff) throw unavailable();
    const executable = await binary(this.#runtime, this.#signal);
    this.#proof(this.#initialCurrent);
    const source = this.#runtime.displays().find(display => String(display.id) === this.#sourceId);
    if (source === undefined || !Number.isSafeInteger(source.size.width) || source.size.width < 1
      || !Number.isSafeInteger(source.size.height) || source.size.height < 1) throw unavailable();
    this.#original = { ...source, size: { ...source.size } };
    const child = this.#runtime.spawn(executable); this.#child = child;
    child.once("exit", () => {
      this.#exited = true; clearTimeout(this.#termination); this.#rejectPending?.();
      this.#signal.removeEventListener("abort", this.#aborted);
      if (!this.#disposed) this.#fail();
    });
    child.once("error", () => this.#fail());
    child.stderr.resume(); child.stderr.on("error", () => this.#fail());
    child.stdout.on("error", () => this.#fail()); child.stdin.on("error", () => this.#fail());
    this.#signal.addEventListener("abort", this.#aborted, { once: true });
    this.#proof(this.#initialCurrent);
  }

  async resize(width: number, height: number, current: () => boolean): Promise<RemoteDesktopDisplay> {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 320 || width > 2560 || height > 2560) throw unavailable();
    this.#proof(current);
    if (this.#writing !== undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    const writing = this.#resize(width, height, current); this.#writing = writing;
    try { return await writing; }
    catch (error) { this.#fail(); throw error; }
    finally { if (this.#writing === writing) this.#writing = undefined; }
  }

  async #resize(width: number, height: number, current: () => boolean): Promise<RemoteDesktopDisplay> {
    const child = this.#child;
    if (child === undefined) throw unavailable();
    const result = await new Promise<{ id: number; logicalWidth: number; logicalHeight: number }>((resolve, reject) => {
      let buffer = Buffer.alloc(0), settled = false;
      const finish = (value?: { id: number; logicalWidth: number; logicalHeight: number }): void => {
        if (settled) return; settled = true;
        clearTimeout(timer); child.stdout.off("data", receive); this.#rejectPending = undefined;
        if (value === undefined) reject(unavailable()); else resolve(value);
      };
      const receive = (chunk: Buffer): void => {
        if (buffer.length + chunk.length > 4_096) { finish(); return; }
        buffer = Buffer.concat([buffer, chunk]); if (!buffer.includes(10)) return;
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
          const row = value as Record<string, unknown>;
          // Retain a reported owner ID even when the rest of the receipt is invalid: release is still owed.
          if (Number.isSafeInteger(row["id"]) && (row["id"] as number) > 0 && (row["id"] as number) <= 0xffff_ffff
            && String(row["id"]) !== this.#sourceId && (this.#id === undefined || this.#id === row["id"])) this.#id = row["id"] as number;
          if (Object.keys(row).sort().join(",") !== "height,id,logicalHeight,logicalWidth,width"
            || row["id"] !== this.#id || row["width"] !== width || row["height"] !== height
            || !validDimension(row["logicalWidth"]) || !validDimension(row["logicalHeight"])
            || Math.abs(row["logicalWidth"] * height - row["logicalHeight"] * width) > Math.max(width, height)) throw unavailable();
          finish({ id: row["id"] as number, logicalWidth: row["logicalWidth"], logicalHeight: row["logicalHeight"] });
        } catch { finish(); }
      };
      const timer = setTimeout(() => finish(), 8_000);
      child.stdout.on("data", receive); this.#rejectPending = () => finish();
      try {
        this.#proof(current);
        child.stdin.write(`${JSON.stringify({ sourceDisplayId: this.#sourceId, width, height })}\n`);
      } catch { finish(); }
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      this.#proof(current);
      const actual = this.#runtime.displays().find(display => display.id === result.id);
      if (actual?.size.width === result.logicalWidth && actual.size.height === result.logicalHeight) {
        this.#proof(current);
        return Object.freeze({ id: String(actual.id), name: actual.label || "Joko Remote Desktop", width: actual.size.width, height: actual.size.height });
      }
      await this.#runtime.delay(50);
    }
    throw unavailable();
  }

  async restore(current: () => boolean): Promise<RemoteDesktopDisplay> {
    this.dispose();
    if (!current()) throw expired();
    if (this.#restored !== undefined) return this.#restored;
    let restoring = this.#restoring;
    if (restoring === undefined) { restoring = this.#restore(current); this.#restoring = restoring; }
    try { const value = await restoring; if (!current()) throw expired(); return value; }
    finally { if (this.#restoring === restoring) this.#restoring = undefined; }
  }
  async #restore(current: () => boolean): Promise<RemoteDesktopDisplay> {
    await this.#writing?.catch(() => undefined);
    if (this.#child === undefined || this.#original === undefined) throw unavailable();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!current()) throw expired();
      const displays = this.#runtime.displays();
      const source = displays.find(display => String(display.id) === this.#sourceId);
      // Actual process exit releases its CoreGraphics object even if the resize reply was lost.
      const released = this.#id === undefined || !displays.some(display => display.id === this.#id);
      if (this.#exited && released && (source === undefined
        || (source.size.width === this.#original.size.width && source.size.height === this.#original.size.height))) {
        if (!current()) throw expired();
        this.#restored = Object.freeze({ id: this.#sourceId, name: source?.label || this.#original.label || "Display",
          width: source?.size.width ?? this.#original.size.width, height: source?.size.height ?? this.#original.size.height });
        if (active === this) active = undefined;
        this.#id = undefined;
        return this.#restored;
      }
      await this.#runtime.delay(50);
    }
    throw unavailable();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#rejectPending?.(); this.#signal.removeEventListener("abort", this.#aborted);
    const child = this.#child;
    if (child === undefined || this.#exited) return;
    try { child.stdin.end(); } catch { /* SIGTERM uses the helper's same restore path. */ }
    this.#termination = setTimeout(() => {
      if (!this.#exited) { try { child.kill("SIGTERM"); } catch { /* Actual release remains owed. */ } }
    }, 1_500);
    this.#termination.unref?.();
  }
  #fail(): void { this.dispose(); if (!this.#notified) { this.#notified = true; this.#onFailure(); } }
  #proof(current: () => boolean): void {
    checkAbort(this.#signal);
    if (this.#disposed || this.#exited || !this.#initialCurrent() || !current()) throw expired();
    requireDevelopment(this.#runtime);
  }
}

function requireDevelopment(runtime: DesktopRemoteDesktopMacViewerDisplayRuntime): void {
  if (runtime.platform !== "darwin" || runtime.packaged) throw unavailable();
}
function validDimension(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 4096; }
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? expired(); }
function expired(): Error { return new Error("REMOTE_DESKTOP_LEASE_EXPIRED"); }
function unavailable(): Error { return new Error("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE"); }
function observe<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal === NEVER_ABORTED) return promise;
  return new Promise((resolve, reject) => {
    const aborted = (): void => { signal.removeEventListener("abort", aborted); reject(signal.reason ?? expired()); };
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(value => { signal.removeEventListener("abort", aborted); if (signal.aborted) aborted(); else resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}
function runtimePort(): DesktopRemoteDesktopMacViewerDisplayRuntime {
  nativeRuntime ??= {
    platform: process.platform, packaged: app.isPackaged, arch: process.arch, appPath: app.getAppPath(), userData: app.getPath("userData"),
    readFile, exists: async path => { try { await access(path); return true; } catch { return false; } },
    mkdir: async path => { await mkdir(path, { recursive: true }); }, rename, remove: unlink,
    exec: (file, args, timeout) => new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout, maxBuffer: 4_096 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    }),
    spawn: file => spawn(file, [], { stdio: "pipe" }), displays: () => screen.getAllDisplays(),
    delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  };
  return nativeRuntime;
}
