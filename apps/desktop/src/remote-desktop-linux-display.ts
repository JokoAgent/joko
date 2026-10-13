import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { RemoteDesktopDisplay, RemoteDesktopDisplayMode } from "@joko/device-peer";
import type { DesktopRemoteDesktopDisplayModeProcess, DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import {
  isDesktopRemoteDesktopWayland, linuxRemoteDesktopDisplay, linuxRuntime,
  readDesktopRemoteDesktopLinuxSessionState, WAYLAND_REMOTE_DESKTOP_DISPLAY_ID,
  type DesktopRemoteDesktopLinuxMonitor, type DesktopRemoteDesktopLinuxRuntime
} from "./remote-desktop-linux.js";

const EXECUTABLE = "/usr/bin/hyprctl";
let changingDisplayMode = false;

export interface DesktopRemoteDesktopLinuxDisplayRuntime {
  readonly linux: DesktopRemoteDesktopLinuxRuntime;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  spawn(file: string, arguments_: readonly string[]): DesktopRemoteDesktopDisplayModeProcess;
}
interface DisplayMonitor extends DesktopRemoteDesktopLinuxMonitor {
  readonly refreshRate: number;
  readonly availableModes: readonly string[];
}
interface ModeEntry extends RemoteDesktopDisplayMode { readonly mode: string }
interface DisplayOccurrence {
  readonly identity: string;
  readonly signal: AbortSignal;
  readonly runtime: DesktopRemoteDesktopLinuxDisplayRuntime;
  readonly allowLocked: boolean;
  readonly current: () => boolean;
}

/** Advertise physical modes only after proving the actual owned compositor and catalog. */
export async function supportsDesktopRemoteDesktopLinuxDisplayModes(
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxDisplayRuntime = displayRuntime()
): Promise<boolean> {
  try {
    const occurrence = occurrenceFor(signal, runtime, true);
    const monitors = await readMonitors(occurrence);
    for (const monitor of monitors) modeEntries(monitor);
    return true;
  } catch { aborted(signal); return false; }
}

export async function readDesktopRemoteDesktopLinuxDisplayModes(
  displayId: string,
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxDisplayRuntime = displayRuntime()
): Promise<readonly RemoteDesktopDisplayMode[]> {
  try {
    const monitor = await readMonitor(displayId, occurrenceFor(signal, runtime, true));
    return Object.freeze(modeEntries(monitor).map(({ id, width, height, current, native }) =>
      Object.freeze({ id, width, height, current, native })));
  } catch { aborted(signal); throw unavailable(); }
}

/** Drains the captured input owner and confirms the compositor's logical geometry. */
export async function setDesktopRemoteDesktopLinuxDisplayMode(
  displayId: string,
  modeId: string,
  beforeChange: () => void | Promise<void>,
  signal: AbortSignal,
  expected?: { readonly width: number; readonly height: number; readonly current?: () => boolean },
  runtime: DesktopRemoteDesktopLinuxDisplayRuntime = displayRuntime()
): Promise<RemoteDesktopDisplay> {
  if (changingDisplayMode) throw busy();
  changingDisplayMode = true;
  try {
    validateModeId(modeId);
    const occurrence = occurrenceFor(signal, runtime, false, expected?.current);
    const monitor = await readMonitor(displayId, occurrence);
    selectedMode(monitor, modeId, expected);
    const lua = await luaSupport(occurrence);
    await prove(occurrence);
    await beforeChange();
    await prove(occurrence);
    // The drain can outlive a hotplug or scale change. Use only a fresh enumerated target.
    const fresh = await readMonitor(displayId, occurrence);
    const mode = selectedMode(fresh, modeId, expected);
    await writeMode(fresh, mode, lua, occurrence);
    return await waitForGeometry(displayId, expected ?? mode, occurrence);
  } catch (error) {
    aborted(signal);
    if (error instanceof Error && ["REMOTE_DESKTOP_DISPLAY_MODE_MISSING", "REMOTE_DESKTOP_LEASE_EXPIRED",
      "REMOTE_DESKTOP_VIEW_ONLY", "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED"].includes(error.message)) throw error;
    throw unavailable();
  } finally { changingDisplayMode = false; }
}

/** Full compositor enumeration validates the saved original, independently of UI selection. */
export async function restoreDesktopRemoteDesktopLinuxDisplayMode(
  displayId: string,
  modeId: string,
  current: () => boolean,
  expected: { readonly width: number; readonly height: number },
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxDisplayRuntime = displayRuntime()
): Promise<RemoteDesktopDisplay> {
  if (changingDisplayMode) throw busy();
  changingDisplayMode = true;
  try {
    validateModeId(modeId);
    const occurrence = occurrenceFor(signal, runtime, true, current);
    const monitor = await readMonitor(displayId, occurrence);
    selectedMode(monitor, modeId, expected);
    const lua = await luaSupport(occurrence);
    const fresh = await readMonitor(displayId, occurrence);
    const mode = selectedMode(fresh, modeId, expected);
    await writeMode(fresh, mode, lua, occurrence);
    return await waitForGeometry(displayId, expected, occurrence);
  } catch { throw new Error("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE"); }
  finally { changingDisplayMode = false; }
}

function occurrenceFor(signal: AbortSignal, runtime: DesktopRemoteDesktopLinuxDisplayRuntime,
  allowLocked = false, current: () => boolean = () => true): DisplayOccurrence {
  const occurrence = { signal, runtime, allowLocked, current, identity: sessionIdentity(runtime.linux) };
  check(occurrence);
  return occurrence;
}
function sessionIdentity(runtime: DesktopRemoteDesktopLinuxRuntime): string {
  const uid = runtime.uid(); const session = runtime.environment["XDG_SESSION_ID"];
  const compositor = runtime.environment["HYPRLAND_INSTANCE_SIGNATURE"];
  if (!isDesktopRemoteDesktopWayland(runtime) || uid === undefined || uid <= 0 || uid !== runtime.effectiveUid()
    || !/^[a-zA-Z0-9_-]{1,64}$/u.test(session ?? "") || !compositor || compositor.length > 256) throw unavailable();
  return JSON.stringify([uid, session, compositor, runtime.environment["WAYLAND_DISPLAY"]]);
}
function check(occurrence: DisplayOccurrence): void {
  aborted(occurrence.signal);
  if (!occurrence.current() || sessionIdentity(occurrence.runtime.linux) !== occurrence.identity) {
    throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
  }
}
async function prove(occurrence: DisplayOccurrence): Promise<void> {
  check(occurrence);
  const trusted = await occurrence.runtime.linux.trustedExecutable(EXECUTABLE);
  check(occurrence);
  if (!trusted) throw unavailable();
  const session = await occurrence.runtime.session(occurrence.signal);
  check(occurrence);
  if (session !== "unlocked" && !(occurrence.allowLocked && session === "locked-logged-in")) {
    throw new Error("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
  }
}
async function readMonitors(occurrence: DisplayOccurrence): Promise<readonly DisplayMonitor[]> {
  await prove(occurrence);
  const raw = await occurrence.runtime.linux.execute(EXECUTABLE, ["-j", "monitors", "all"], occurrence.signal, 128_000, 2_000);
  await prove(occurrence);
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw unavailable();
  const names = new Set<string>();
  return Object.freeze(value.map((candidate): DisplayMonitor => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw unavailable();
    const m = candidate as Record<string, unknown>;
    if (typeof m["name"] !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/u.test(m["name"]) || names.has(m["name"])
      || ![m["width"], m["height"], m["x"], m["y"], m["transform"]].every(Number.isSafeInteger)
      || (m["width"] as number) < 1 || (m["width"] as number) > 16_384
      || (m["height"] as number) < 1 || (m["height"] as number) > 16_384
      || Math.abs(m["x"] as number) > 1_000_000 || Math.abs(m["y"] as number) > 1_000_000
      || typeof m["scale"] !== "number" || !Number.isFinite(m["scale"]) || m["scale"] < 0.25 || m["scale"] > 8
      || typeof m["refreshRate"] !== "number" || !Number.isFinite(m["refreshRate"]) || m["refreshRate"] <= 0 || m["refreshRate"] > 1_000
      || (m["transform"] as number) < 0 || (m["transform"] as number) > 7
      || !Array.isArray(m["availableModes"]) || m["availableModes"].length < 1 || m["availableModes"].length > 256
      || m["availableModes"].some(mode => typeof mode !== "string" || !/^\d{1,5}x\d{1,5}@\d{1,4}(\.\d{1,5})?Hz$/u.test(mode))) {
      throw unavailable();
    }
    names.add(m["name"]);
    const monitor = Object.freeze({ name: m["name"], width: m["width"] as number, height: m["height"] as number,
      x: m["x"] as number, y: m["y"] as number, scale: m["scale"], transform: m["transform"] as number,
      refreshRate: m["refreshRate"], availableModes: Object.freeze(m["availableModes"] as string[]) });
    linuxRemoteDesktopDisplay(monitor);
    return monitor;
  }));
}
async function readMonitor(displayId: string, occurrence: DisplayOccurrence): Promise<DisplayMonitor> {
  const monitors = await readMonitors(occurrence);
  const monitor = displayId === WAYLAND_REMOTE_DESKTOP_DISPLAY_ID && monitors.length === 1 ? monitors[0]
    : monitors.find(candidate => `hyprland:${candidate.name}` === displayId);
  if (monitor === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
  return monitor;
}
function modeEntries(monitor: DisplayMonitor): readonly ModeEntry[] {
  const entries = monitor.availableModes.map((raw) => {
    const [width, height, refreshRate] = raw.slice(0, -2).split(/[x@]/u).map(Number);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! < 1 || height! < 1
      || width! > 16_384 || height! > 16_384 || !Number.isFinite(refreshRate) || refreshRate! <= 0 || refreshRate! > 1_000) throw unavailable();
    const geometry = linuxRemoteDesktopDisplay({ ...monitor, width: width!, height: height! });
    return { id: String(createHash("sha256").update(`${monitor.name}:${raw}`).digest().readUInt32BE(0)),
      width: geometry.width, height: geometry.height, current: false, native: false, mode: raw.slice(0, -2),
      distance: width === monitor.width && height === monitor.height ? Math.abs(refreshRate! - monitor.refreshRate) : Infinity };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw unavailable();
  const current = entries.reduce<typeof entries[number] | undefined>((best, entry) =>
    entry.distance < (best?.distance ?? Infinity) ? entry : best, undefined);
  if (current === undefined || current.distance >= 0.02) throw unavailable();
  return Object.freeze(entries.map(entry => Object.freeze({ id: entry.id, width: entry.width, height: entry.height,
    current: entry === current, native: entry.native, mode: entry.mode })));
}
function validateModeId(modeId: string): void {
  if (!/^[0-9]{1,10}$/u.test(modeId)) throw new Error("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
}
function selectedMode(monitor: DisplayMonitor, modeId: string, expected?: { readonly width: number; readonly height: number }): ModeEntry {
  const mode = modeEntries(monitor).find(candidate => candidate.id === modeId);
  if (mode === undefined || (expected !== undefined && (mode.width !== expected.width || mode.height !== expected.height))) {
    throw new Error("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
  }
  return mode;
}
async function luaSupport(occurrence: DisplayOccurrence): Promise<boolean> {
  await prove(occurrence);
  let supported = false;
  try {
    const raw = await occurrence.runtime.linux.execute(EXECUTABLE, ["eval", "assert(type(hl.monitor) == \"function\")"],
      occurrence.signal, 1_024, 2_000);
    supported = raw.trim() === "ok";
  } catch { check(occurrence); }
  await prove(occurrence);
  return supported;
}
async function writeMode(monitor: DisplayMonitor, mode: ModeEntry, lua: boolean, occurrence: DisplayOccurrence): Promise<void> {
  await prove(occurrence);
  const code = `hl.monitor({output=${JSON.stringify(monitor.name)},mode=${JSON.stringify(mode.mode)},position="${monitor.x}x${monitor.y}",scale=${monitor.scale},transform=${monitor.transform}})`;
  const args = lua ? ["eval", code] : ["keyword", "monitor",
    `${monitor.name},${mode.mode},${monitor.x}x${monitor.y},${monitor.scale},transform,${monitor.transform}`];
  check(occurrence);
  const child = occurrence.runtime.spawn(EXECUTABLE, args);
  // An error, exit, timeout or kill leaves the dispatched geometry unknown until actual close.
  await new Promise<void>((resolve, reject) => {
    let failed = false; let output = Buffer.alloc(0);
    const stop = (): void => { failed = true; try { child.kill("SIGKILL"); } catch { /* Close owns settlement. */ } };
    const data = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (output.length + bytes.length > 1_024) { stop(); return; }
      output = Buffer.concat([output, bytes]);
    };
    const timeout = setTimeout(stop, 3_000);
    occurrence.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", data); child.stdout.on("error", stop);
    child.stderr.resume(); child.stderr.on("error", stop); child.once("error", stop);
    child.once("close", (exitCode, termination) => {
      clearTimeout(timeout); occurrence.signal.removeEventListener("abort", stop);
      child.stdout.removeListener("data", data); child.stdout.removeListener("error", stop); child.stderr.removeListener("error", stop);
      try {
        check(occurrence);
        if (failed || exitCode !== 0 || termination !== null || output.toString("utf8").trim() !== "ok") throw unavailable();
        resolve();
      } catch (error) { reject(error); }
    });
    if (occurrence.signal.aborted) stop();
  });
  await prove(occurrence);
}
async function waitForGeometry(displayId: string, expected: { readonly width: number; readonly height: number },
  occurrence: DisplayOccurrence): Promise<RemoteDesktopDisplay> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const monitor = await readMonitor(displayId, occurrence);
    const observed = linuxRemoteDesktopDisplay(monitor);
    if (observed.width === expected.width && observed.height === expected.height) {
      check(occurrence);
      return Object.freeze({ ...observed, id: displayId });
    }
    if (attempt < 39) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      check(occurrence);
    }
  }
  throw unavailable();
}
function aborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error("REMOTE_DESKTOP_LEASE_EXPIRED"); }
function unavailable(): Error { return new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE"); }
function busy(): Error { return new Error("REMOTE_DESKTOP_DISPLAY_BUSY"); }
function displayRuntime(): DesktopRemoteDesktopLinuxDisplayRuntime {
  const linux = linuxRuntime();
  return { linux, session: signal => readDesktopRemoteDesktopLinuxSessionState(signal, linux),
    spawn: (file, args) => spawn(file, [...args], { stdio: "pipe" }) };
}
