import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import type { RemoteDesktopDisplay } from "@joko/device-peer";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import { verifyPackagedDesktopRemoteDesktopBinary } from "./remote-desktop-native-manifest.js";

const exec = promisify(execFile);
export const WAYLAND_REMOTE_DESKTOP_DISPLAY_ID = "wayland-portal";
const HYPRCTL = "/usr/bin/hyprctl";
const LOGINCTL = "/usr/bin/loginctl";
const GRIM = "/usr/bin/grim";

export interface DesktopRemoteDesktopLinuxMonitor {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly transform: number;
}
export interface DesktopRemoteDesktopLinuxRuntime {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  uid(): number | undefined;
  effectiveUid(): number | undefined;
  executable(path: string): boolean;
  trustedExecutable(path: string): Promise<boolean>;
  execute(file: string, arguments_: readonly string[], signal: AbortSignal, maximumBytes: number, timeout: number): Promise<string>;
}

export function isDesktopRemoteDesktopWayland(runtime: DesktopRemoteDesktopLinuxRuntime = linuxRuntime()): boolean {
  return runtime.platform === "linux" && (runtime.environment["XDG_SESSION_TYPE"] === "wayland"
    || Boolean(runtime.environment["WAYLAND_DISPLAY"]));
}
export function supportsDesktopRemoteDesktopLinuxCapture(runtime: DesktopRemoteDesktopLinuxRuntime = linuxRuntime()): boolean {
  return isDesktopRemoteDesktopWayland(runtime) && Boolean(runtime.environment["HYPRLAND_INSTANCE_SIGNATURE"])
    && runtime.executable(GRIM);
}

/** Read current owned login and compositor state without locker, PAM or keyring access. */
export async function readDesktopRemoteDesktopLinuxSessionState(
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxRuntime = linuxRuntime()
): Promise<DesktopRemoteDesktopSessionState> {
  return readLinuxSessionState(signal, runtime, false);
}

/** Terminal Wayland lock receipt only; this never admits locked portal or X11 pixels. */
export async function readDesktopRemoteDesktopLinuxLockSessionState(
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxRuntime = linuxRuntime()
): Promise<DesktopRemoteDesktopSessionState> {
  return readLinuxSessionState(signal, runtime, true);
}

async function readLinuxSessionState(signal: AbortSignal, runtime: DesktopRemoteDesktopLinuxRuntime,
  terminalLock: boolean): Promise<DesktopRemoteDesktopSessionState> {
  try {
    aborted(signal);
    const uid = runtime.uid(); const session = runtime.environment["XDG_SESSION_ID"];
    const sessionType = isDesktopRemoteDesktopWayland(runtime) ? "wayland"
      : runtime.platform === "linux" && runtime.environment["XDG_SESSION_TYPE"] === "x11" ? "x11" : undefined;
    if (sessionType === undefined || uid === undefined || uid <= 0
      || uid !== runtime.effectiveUid() || !/^[a-zA-Z0-9_-]{1,64}$/u.test(session ?? "")
      || !await runtime.trustedExecutable(LOGINCTL)) return "unsupported";
    const raw = await runtime.execute(LOGINCTL, ["show-session", session!, "-p", "User", "-p", "Active",
      "-p", "Remote", "-p", "Type", "-p", "LockedHint"], signal, 4_096, 2_000);
    aborted(signal);
    const properties = new Map<string, string>();
    for (const line of raw.trim().split("\n")) {
      const pair = /^([A-Za-z]+)=(.*)$/u.exec(line);
      if (pair === null || properties.has(pair[1]!)) return "unknown";
      properties.set(pair[1]!, pair[2]!);
    }
    if (properties.size !== 5 || properties.get("User") !== String(uid)
      || properties.get("Active") !== "yes" || properties.get("Remote") !== "no"
      || properties.get("Type") !== sessionType || !["yes", "no"].includes(properties.get("LockedHint") ?? "")) {
      return "unsupported";
    }
    if (sessionType === "x11") {
      // Chromium captures only an ordinary owned desktop; X11 never grants locked viewing or native effects.
      return properties.get("LockedHint") === "no" ? "unlocked" : "unsupported";
    }
    if (!runtime.environment["HYPRLAND_INSTANCE_SIGNATURE"]) {
      // Portal pixels still require the exact local consent stream; this never authorizes input.
      return properties.get("LockedHint") === "yes" ? terminalLock ? "locked-logged-in" : "unsupported" : "unlocked";
    }
    if (!await runtime.trustedExecutable(HYPRCTL)) return "unknown";
    const value: unknown = JSON.parse(await runtime.execute(HYPRCTL, ["-j", "monitors"], signal, 128_000, 2_000));
    aborted(signal);
    if (!Array.isArray(value) || value.length < 1 || value.length > 32) return "unknown";
    const blockers: string[][] = [];
    for (const monitor of value) {
      if (typeof monitor !== "object" || monitor === null || Array.isArray(monitor)) return "unknown";
      const items: unknown = monitor.solitaryBlockedBy;
      if (!Array.isArray(items) || items.length > 32 || items.some(item => typeof item !== "string" || item.length > 128)) {
        return "unknown";
      }
      blockers.push(items);
    }
    if (blockers.some(items => items.includes("LOCK"))) return "locked-logged-in";
    return blockers.some(items => !items.includes("WORKSPACE")) ? "unlocked" : "unknown";
  } catch {
    aborted(signal);
    return "unknown";
  }
}

export async function readDesktopRemoteDesktopLinuxMonitors(
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxRuntime = linuxRuntime(),
  includeMirrored = false
): Promise<readonly DesktopRemoteDesktopLinuxMonitor[]> {
  try {
    aborted(signal);
    if (!isDesktopRemoteDesktopWayland(runtime) || !runtime.environment["HYPRLAND_INSTANCE_SIGNATURE"]
      || !await runtime.trustedExecutable(HYPRCTL)) throw new Error("invalid");
    const value: unknown = JSON.parse(await runtime.execute(HYPRCTL,
      includeMirrored ? ["-j", "monitors", "all"] : ["-j", "monitors"], signal, 128_000, 2_000));
    aborted(signal);
    if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("invalid");
    const names = new Set<string>();
    return Object.freeze(value.map((candidate): DesktopRemoteDesktopLinuxMonitor => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error("invalid");
      const m = candidate as Record<string, unknown>;
      if (typeof m["name"] !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/u.test(m["name"]) || names.has(m["name"])
        || ![m["width"], m["height"], m["x"], m["y"], m["transform"]].every(Number.isSafeInteger)
        || (m["width"] as number) < 1 || (m["width"] as number) > 16_384
        || (m["height"] as number) < 1 || (m["height"] as number) > 16_384
        || Math.abs(m["x"] as number) > 1_000_000 || Math.abs(m["y"] as number) > 1_000_000
        || typeof m["scale"] !== "number" || !Number.isFinite(m["scale"]) || m["scale"] < 0.25 || m["scale"] > 8
        || (m["transform"] as number) < 0 || (m["transform"] as number) > 7) throw new Error("invalid");
      names.add(m["name"]);
      const monitor = Object.freeze({ name: m["name"], width: m["width"] as number, height: m["height"] as number,
        x: m["x"] as number, y: m["y"] as number, scale: m["scale"], transform: m["transform"] as number });
      linuxRemoteDesktopDisplay(monitor);
      return monitor;
    }));
  } catch {
    aborted(signal);
    throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
  }
}

export function linuxRemoteDesktopDisplay(monitor: DesktopRemoteDesktopLinuxMonitor): RemoteDesktopDisplay {
  const width = Math.round((monitor.transform % 2 ? monitor.height : monitor.width) / monitor.scale);
  const height = Math.round((monitor.transform % 2 ? monitor.width : monitor.height) / monitor.scale);
  if (width < 1 || height < 1 || width > 32_768 || height > 32_768) throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
  return Object.freeze({ id: `hyprland:${monitor.name}`, name: monitor.name, width, height });
}

export function linuxRemoteDesktopInputMapping(monitors: readonly DesktopRemoteDesktopLinuxMonitor[], displayId: string) {
  const selected = monitors.find(monitor => linuxRemoteDesktopDisplay(monitor).id === displayId);
  if (selected === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
  const left = Math.min(...monitors.map(monitor => monitor.x)); const top = Math.min(...monitors.map(monitor => monitor.y));
  const width = Math.max(...monitors.map(monitor => monitor.x + linuxRemoteDesktopDisplay(monitor).width)) - left;
  const height = Math.max(...monitors.map(monitor => monitor.y + linuxRemoteDesktopDisplay(monitor).height)) - top;
  const size = linuxRemoteDesktopDisplay(selected);
  return (x: number, y: number) => ({
    x: (selected.x - left + x * (size.width - 1)) / width,
    y: (selected.y - top + y * (size.height - 1)) / height
  });
}

export async function readDesktopRemoteDesktopLinuxMonitor(displayId: string, signal: AbortSignal, includeMirrored = false) {
  const monitors = await readDesktopRemoteDesktopLinuxMonitors(signal, linuxRuntime(), includeMirrored);
  const monitor = displayId === WAYLAND_REMOTE_DESKTOP_DISPLAY_ID && monitors.length === 1 ? monitors[0]
    : monitors.find(candidate => `hyprland:${candidate.name}` === displayId);
  if (monitor === undefined) throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
  return monitor;
}

const building = new Map<"input" | "capture", Promise<string>>();
export async function resolveDesktopRemoteDesktopLinuxBinary(kind: "input" | "capture"): Promise<string> {
  if (process.platform !== "linux") throw new Error("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  const name = `joko-linux-remote-desktop-${kind}`;
  if (app.isPackaged) return verifyPackagedDesktopRemoteDesktopBinary(
    join(process.resourcesPath, "native-remote-desktop"), kind, name, "linux", process.arch);
  const existing = building.get(kind); if (existing !== undefined) return existing;
  const pending = (async () => {
    const root = join(app.getAppPath(), "native", "remote-desktop", `linux-${kind}`);
    const files = kind === "input" ? ["main.c", "build.mjs", "virtual-keyboard-unstable-v1.xml", "wlr-virtual-pointer-unstable-v1.xml"]
      : ["main.c", "cursor.h", "build.mjs", "wlr-screencopy-unstable-v1.xml", "ext-image-copy-capture-v1.xml",
          "ext-image-capture-source-v1.xml", "ext-foreign-toplevel-list-v1.xml"];
    const digest = createHash("sha256").update(process.arch);
    for (const file of files) digest.update(await readFile(join(root, file)));
    const directory = join(app.getPath("userData"), "remote-desktop", "native", digest.digest("hex"));
    const binary = join(directory, name);
    try { await access(binary, constants.X_OK); return binary; } catch { /* Build this source snapshot. */ }
    await mkdir(directory, { recursive: true });
    await exec(process.execPath, [join(root, "build.mjs"), directory], {
      timeout: 60_000, maxBuffer: 64_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    await access(binary, constants.X_OK); return binary;
  })();
  building.set(kind, pending);
  try { return await pending; } finally { if (building.get(kind) === pending) building.delete(kind); }
}

export interface DesktopRemoteDesktopLinuxHelperRuntime {
  supported(): boolean;
  resolveBinary(kind: "input" | "capture"): Promise<string>;
  execute(binary: string, command: string, signal: AbortSignal): Promise<string>;
}
export async function readDesktopRemoteDesktopLinuxInputSupport(signal: AbortSignal,
  runtime?: DesktopRemoteDesktopLinuxHelperRuntime): Promise<boolean> {
  return readHelperSupport("input", "--check", signal, runtime);
}
export async function readDesktopRemoteDesktopLinuxCursorSupport(signal: AbortSignal,
  runtime?: DesktopRemoteDesktopLinuxHelperRuntime): Promise<boolean> {
  return readHelperSupport("capture", "--cursor-check", signal, runtime);
}
async function readHelperSupport(kind: "input" | "capture", command: string, signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxHelperRuntime = {
    supported: supportsDesktopRemoteDesktopLinuxCapture, resolveBinary: resolveDesktopRemoteDesktopLinuxBinary,
    execute: async (binary, argument, cancellation) =>
      (await exec(binary, [argument], { timeout: 3_000, maxBuffer: 1_024, signal: cancellation })).stdout
  }): Promise<boolean> {
  if (!runtime.supported()) return false;
  try {
    const binary = await runtime.resolveBinary(kind); aborted(signal);
    const stdout = await runtime.execute(binary, command, signal);
    aborted(signal); return stdout.trim() === "ready";
  } catch { aborted(signal); return false; }
}

export function linuxRuntime(): DesktopRemoteDesktopLinuxRuntime {
  return {
    platform: process.platform, environment: process.env,
    uid: () => process.getuid?.(), effectiveUid: () => process.geteuid?.(),
    executable: (path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } },
    trustedExecutable: async (path) => {
      try { const file = await stat(path); return file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0 && (file.mode & 0o111) !== 0; }
      catch { return false; }
    },
    execute: async (file, arguments_, signal, maximumBytes, timeout) =>
      (await exec(file, [...arguments_], { signal, maxBuffer: maximumBytes, timeout })).stdout
  };
}
function aborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error("REMOTE_DESKTOP_LEASE_EXPIRED"); }
