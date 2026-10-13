import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { RemoteDesktopDisplay } from "@joko/device-peer";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import { isDesktopRemoteDesktopWayland, linuxRemoteDesktopDisplay, linuxRuntime,
  readDesktopRemoteDesktopLinuxMonitors, readDesktopRemoteDesktopLinuxSessionState,
  type DesktopRemoteDesktopLinuxMonitor, type DesktopRemoteDesktopLinuxRuntime } from "./remote-desktop-linux.js";
import { verifyPackagedDesktopRemoteDesktopBinary } from "./remote-desktop-native-manifest.js";

const PYTHON = "/usr/bin/python3";
const HYPRCTL = "/usr/bin/hyprctl";
const NEVER_ABORTED = new AbortController().signal;
let active: LinuxViewerDisplay | undefined;

export interface DesktopRemoteDesktopLinuxViewerDisplayHandle {
  readonly displayId?: string;
  resize(width: number, height: number, current: () => boolean): Promise<RemoteDesktopDisplay>;
  restore(current: () => boolean): Promise<RemoteDesktopDisplay>;
  dispose(): void;
}
export interface DesktopRemoteDesktopLinuxViewerDisplayRuntime {
  readonly linux: DesktopRemoteDesktopLinuxRuntime;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  script(): Promise<string>;
  monitors(signal: AbortSignal, includeMirrored?: boolean): Promise<readonly DesktopRemoteDesktopLinuxMonitor[]>;
  spawn(file: string, arguments_: readonly string[]): ChildProcessWithoutNullStreams;
}

export async function supportsDesktopRemoteDesktopLinuxViewerDisplay(signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxViewerDisplayRuntime = viewerRuntime()): Promise<boolean> {
  try {
    const identity = sessionIdentity(runtime.linux);
    await proof(runtime, identity, () => true, signal, true);
    await runtime.script();
    await proof(runtime, identity, () => true, signal, true);
    const monitors = await runtime.monitors(signal);
    await proof(runtime, identity, () => true, signal, true);
    return monitors.length > 0;
  } catch { aborted(signal); return false; }
}

export async function createDesktopRemoteDesktopLinuxViewerDisplay(sourceId: string, current: () => boolean,
  onFailure: () => void, signal: AbortSignal = NEVER_ABORTED,
  runtime: DesktopRemoteDesktopLinuxViewerDisplayRuntime = viewerRuntime()): Promise<DesktopRemoteDesktopLinuxViewerDisplayHandle> {
  if (active !== undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
  const owner = new LinuxViewerDisplay(sourceId, current, onFailure, signal, runtime);
  active = owner;
  try { await owner.start(); return owner; }
  catch (error) { owner.dispose(); if (!owner.dispatched && active === owner) active = undefined; throw error; }
}

class LinuxViewerDisplay implements DesktopRemoteDesktopLinuxViewerDisplayHandle {
  readonly #sourceId: string;
  readonly #initialCurrent: () => boolean;
  readonly #onFailure: () => void;
  readonly #signal: AbortSignal;
  readonly #runtime: DesktopRemoteDesktopLinuxViewerDisplayRuntime;
  readonly #identity: string;
  #original: DesktopRemoteDesktopLinuxMonitor | undefined;
  #snapshotTaken = false;
  #child: ChildProcessWithoutNullStreams | undefined;
  #close: Promise<number | null> | undefined;
  #actualClosed = false;
  #disposed = false;
  #notified = false;
  #id: string | undefined = `hyprland:JokoRemote-${randomBytes(8).toString("hex")}`;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #termination: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<RemoteDesktopDisplay> | undefined;
  #rejectPending: (() => void) | undefined;
  readonly #aborted = (): void => { this.#fail(); };

  constructor(sourceId: string, current: () => boolean, onFailure: () => void, signal: AbortSignal,
    runtime: DesktopRemoteDesktopLinuxViewerDisplayRuntime) {
    this.#sourceId = sourceId; this.#initialCurrent = current; this.#onFailure = onFailure;
    this.#signal = signal; this.#runtime = runtime; this.#identity = sessionIdentity(runtime.linux);
  }
  get displayId(): string | undefined { return this.#id; }
  get dispatched(): boolean { return this.#child !== undefined; }

  async start(): Promise<void> {
    await this.#proof(this.#initialCurrent);
    const monitors = await this.#runtime.monitors(this.#signal);
    await this.#proof(this.#initialCurrent);
    const original = this.#sourceId === "wayland-portal" && monitors.length === 1 ? monitors[0]
      : monitors.find(monitor => `hyprland:${monitor.name}` === this.#sourceId);
    if (original === undefined || original.name.startsWith("JokoRemote-")) throw unavailable();
    this.#original = original;
    const script = await this.#runtime.script();
    await this.#proof(this.#initialCurrent);
    if (!this.#initialCurrent() || this.#signal.aborted || this.#identity !== sessionIdentity(this.#runtime.linux)) {
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
    const child = this.#runtime.spawn(PYTHON, ["-I", "-u", script, original.name, this.#id!.slice(9)]); this.#child = child;
    this.#close = new Promise(resolve => child.once("close", code => {
      this.#actualClosed = true; clearInterval(this.#heartbeat); clearTimeout(this.#termination);
      this.#signal.removeEventListener("abort", this.#aborted);
      this.#rejectPending?.(); if (!this.#disposed) this.#fail(); resolve(code);
    }));
    child.stderr.resume(); child.stderr.on("error", () => this.#fail());
    child.stdin.on("error", () => this.#fail()); child.stdout.on("error", () => this.#fail());
    child.once("error", () => this.#fail()); child.once("exit", () => { if (!this.#disposed) this.#fail(); });
    this.#signal.addEventListener("abort", this.#aborted, { once: true });
    this.#heartbeat = setInterval(() => {
      if (this.#disposed) return;
      if (!this.#initialCurrent() || this.#signal.aborted) { this.#fail(); return; }
      try { child.stdin.write('{"op":"ping"}\n'); } catch { this.#fail(); }
    }, 2_000);
    this.#heartbeat.unref?.();
  }

  async resize(width: number, height: number, current: () => boolean): Promise<RemoteDesktopDisplay> {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 320 || width > 2560 || height > 2560) {
      throw unavailable();
    }
    if (this.#disposed || this.#actualClosed) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    if (this.#writing !== undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_BUSY");
    const writing = this.#resize(width, height, current); this.#writing = writing;
    try { return await writing; }
    catch (error) { this.dispose(); throw error; }
    finally { if (this.#writing === writing) this.#writing = undefined; }
  }
  async #resize(width: number, height: number, current: () => boolean): Promise<RemoteDesktopDisplay> {
    await this.#proof(current);
    if (!this.#snapshotTaken) {
      const monitors = await this.#runtime.monitors(this.#signal, true);
      await this.#proof(current);
      const source = monitors.find(monitor => monitor.name === this.#original?.name);
      if (source === undefined) throw unavailable();
      this.#original = source;
      this.#snapshotTaken = true;
    }
    const child = this.#child;
    if (child === undefined || this.#disposed || this.#actualClosed) throw unavailable();
    if (!current() || this.#signal.aborted || this.#identity !== sessionIdentity(this.#runtime.linux)) {
      throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    }
    const receipt = await new Promise<RemoteDesktopDisplay>((resolve, reject) => {
      let buffer = Buffer.alloc(0); let settled = false;
      const finish = (value?: RemoteDesktopDisplay): void => {
        if (settled) return; settled = true;
        clearTimeout(timer); child.stdout.removeListener("data", receive); this.#rejectPending = undefined;
        if (value === undefined) reject(unavailable()); else resolve(value);
      };
      const receive = (chunk: Buffer): void => {
        if (buffer.length + chunk.length > 4_096) { finish(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        if (!buffer.includes(10)) return;
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
          const d = value as Record<string, unknown>;
          if (Object.keys(d).sort().join(",") !== "height,id,name,width" || typeof d["id"] !== "string"
            || !/^hyprland:JokoRemote-[a-f0-9]{16}$/u.test(d["id"]) || d["name"] !== d["id"].slice(9)
            || d["width"] !== width || d["height"] !== height || (this.#id !== undefined && d["id"] !== this.#id)) throw unavailable();
          finish(Object.freeze({ id: d["id"], name: d["name"] as string, width, height }));
        } catch { finish(); }
      };
      const timer = setTimeout(() => finish(), 8_000);
      child.stdout.on("data", receive); this.#rejectPending = () => finish();
      try { child.stdin.write(`${JSON.stringify({ width, height })}\n`); } catch { finish(); }
    });
    await this.#proof(current);
    const monitors = await this.#runtime.monitors(this.#signal);
    await this.#proof(current);
    const monitor = monitors.find(candidate => `hyprland:${candidate.name}` === receipt.id);
    if (monitor === undefined) throw unavailable();
    const actual = linuxRemoteDesktopDisplay(monitor);
    if (actual.width !== width || actual.height !== height) throw unavailable();
    this.#id = actual.id;
    return actual;
  }

  async restore(current: () => boolean): Promise<RemoteDesktopDisplay> {
    this.dispose();
    await this.#writing?.catch(() => undefined);
    if (this.#close === undefined) throw unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([this.#close, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), 12_000);
      })]);
      await this.#proof(current, true);
      if (!this.#actualClosed || code !== 0 || this.#original === undefined) throw unavailable();
      const monitors = await this.#runtime.monitors(NEVER_ABORTED, true);
      await this.#proof(current, true);
      if (monitors.some(candidate => `hyprland:${candidate.name}` === this.#id)) throw unavailable();
      const source = monitors.find(candidate => candidate.name === this.#original!.name);
      // Physical unplug removes the remaining geometry; the helper still removes its own output.
      const actual = linuxRemoteDesktopDisplay(source ?? this.#original);
      const original = linuxRemoteDesktopDisplay(this.#original);
      if (source !== undefined && (actual.width !== original.width || actual.height !== original.height
        || source.x !== this.#original.x || source.y !== this.#original.y || source.scale !== this.#original.scale
        || source.transform !== this.#original.transform)) throw unavailable();
      if (active === this) active = undefined;
      this.#id = undefined;
      return Object.freeze({ ...actual, id: this.#sourceId });
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; clearInterval(this.#heartbeat); this.#rejectPending?.();
    this.#signal.removeEventListener("abort", this.#aborted);
    const child = this.#child;
    if (child === undefined || this.#actualClosed) return;
    try { child.stdin.end(); } catch { /* SIGTERM also executes the same restoration finally block. */ }
    this.#termination = setTimeout(() => { if (!this.#actualClosed) { try { child.kill("SIGTERM"); } catch { /* Restore remains owed. */ } } }, 10_000);
    this.#termination.unref?.();
  }
  #fail(): void {
    this.dispose(); if (!this.#notified) { this.#notified = true; this.#onFailure(); }
  }
  async #proof(current: () => boolean, restoring = false): Promise<void> {
    if (!restoring && this.#disposed) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    await proof(this.#runtime, this.#identity, current, restoring ? NEVER_ABORTED : this.#signal, restoring);
    if (!restoring && this.#disposed) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
  }
}

function sessionIdentity(runtime: DesktopRemoteDesktopLinuxRuntime): string {
  const session = runtime.environment["XDG_SESSION_ID"], compositor = runtime.environment["HYPRLAND_INSTANCE_SIGNATURE"], uid = runtime.uid();
  if (!isDesktopRemoteDesktopWayland(runtime) || !/^[a-zA-Z0-9_-]{1,64}$/u.test(session ?? "") || !compositor
    || uid === undefined || uid <= 0 || uid !== runtime.effectiveUid()) throw unavailable();
  return JSON.stringify([uid, session, compositor, runtime.environment["WAYLAND_DISPLAY"]]);
}
async function proof(runtime: DesktopRemoteDesktopLinuxViewerDisplayRuntime, identity: string, current: () => boolean,
  signal: AbortSignal, allowLocked: boolean): Promise<void> {
  const check = (): void => {
    aborted(signal);
    if (!current() || identity !== sessionIdentity(runtime.linux)) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
  };
  check();
  for (const path of [PYTHON, HYPRCTL, "/usr/bin/grim"]) {
    const trusted = await runtime.linux.trustedExecutable(path); check(); if (!trusted) throw unavailable();
  }
  const session = await runtime.session(signal); check();
  if (session !== "unlocked" && !(allowLocked && session === "locked-logged-in")) throw unavailable();
}
function aborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error("REMOTE_DESKTOP_LEASE_EXPIRED"); }
function unavailable(): Error { return new Error("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE"); }
function viewerRuntime(): DesktopRemoteDesktopLinuxViewerDisplayRuntime {
  const linux = linuxRuntime();
  return {
    linux, session: signal => readDesktopRemoteDesktopLinuxSessionState(signal, linux),
    monitors: (signal, all) => readDesktopRemoteDesktopLinuxMonitors(signal, linux, all),
    spawn: (file, args) => spawn(file, [...args], { stdio: "pipe" }),
    script: async () => {
      if (app.isPackaged) return verifyPackagedDesktopRemoteDesktopBinary(join(process.resourcesPath, "native-remote-desktop"),
        "viewer-display", "linux-viewer-display.py", "linux", process.arch);
      const path = join(app.getAppPath(), "native", "remote-desktop", "linux-viewer-display.py");
      const [metadata, canonical, bytes] = await Promise.all([lstat(path), realpath(path), readFile(path)]);
      if (!metadata.isFile() || metadata.isSymbolicLink() || canonical !== path || bytes.length < 1 || bytes.length > 128_000
        || !new TextDecoder("utf-8", { fatal: true }).decode(bytes).startsWith("#!/usr/bin/python3\n")) throw unavailable();
      return path;
    }
  };
}
