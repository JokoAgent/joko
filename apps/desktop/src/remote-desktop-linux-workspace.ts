import type { RemoteDesktopSystemAction } from "@joko/device-peer";

import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import {
  linuxRuntime,
  readDesktopRemoteDesktopLinuxMonitors,
  readDesktopRemoteDesktopLinuxSessionState,
  supportsDesktopRemoteDesktopLinuxCapture,
  type DesktopRemoteDesktopLinuxMonitor,
  type DesktopRemoteDesktopLinuxRuntime
} from "./remote-desktop-linux.js";

const HYPRCTL = "/usr/bin/hyprctl";
const MENU = "/usr/bin/omarchy";
const MENU_HELPER = "/usr/bin/omarchy-menu";
const UNAVAILABLE = "REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE";
const EXPIRED = "REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED";

export interface DesktopRemoteDesktopLinuxWorkspaceRuntime {
  readonly linux: DesktopRemoteDesktopLinuxRuntime;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
}

function workspaceRuntime(): DesktopRemoteDesktopLinuxWorkspaceRuntime {
  const linux = linuxRuntime();
  return { linux, session: (signal) => readDesktopRemoteDesktopLinuxSessionState(signal, linux) };
}

/** Capability probes do not dispatch, change focus, or open a menu. */
export async function readDesktopRemoteDesktopLinuxWorkspaceSupport(signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxWorkspaceRuntime = workspaceRuntime()
): Promise<{ readonly workspaceNavigation: boolean; readonly systemMenu: boolean }> {
  try {
    const identity = ownedIdentity(runtime.linux);
    if (identity === undefined || !supportsDesktopRemoteDesktopLinuxCapture(runtime.linux)
      || !await runtime.linux.trustedExecutable(HYPRCTL)) return unsupported();
    checkSignal(signal);
    if (await runtime.session(signal) !== "unlocked") return unsupported();
    const monitors = await readDesktopRemoteDesktopLinuxMonitors(signal, runtime.linux, true);
    const systemMenu = await menuSupport(runtime.linux);
    checkSignal(signal);
    if (identity !== ownedIdentity(runtime.linux) || monitors.length === 0
      || await runtime.session(signal) !== "unlocked") return unsupported();
    checkSignal(signal);
    return Object.freeze({ workspaceNavigation: true, systemMenu });
  } catch {
    checkSignal(signal);
    return unsupported();
  }
}

/** Navigate the current leased output without depending on local key bindings. */
export class DesktopRemoteDesktopLinuxWorkspace {
  readonly #runtime: DesktopRemoteDesktopLinuxWorkspaceRuntime;
  #tail: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #stopping: Promise<void> | undefined;
  #lua: boolean | undefined;
  #syntaxIdentity: string | undefined;

  constructor(runtime: DesktopRemoteDesktopLinuxWorkspaceRuntime = workspaceRuntime()) {
    this.#runtime = runtime;
  }

  request(action: RemoteDesktopSystemAction, displayId: string, current: () => boolean,
    signal: AbortSignal): Promise<void> {
    const generation = this.#generation;
    const identity = ownedIdentity(this.#runtime.linux);
    if (this.#stopping !== undefined) return Promise.reject(new Error(EXPIRED));
    const assertCurrent = (): void => {
      checkSignal(signal);
      if (generation !== this.#generation || !current() || identity !== ownedIdentity(this.#runtime.linux)) {
        throw new Error(EXPIRED);
      }
    };
    const operation = this.#tail.catch(() => {}).then(async () => {
      let selected: DesktopRemoteDesktopLinuxMonitor | undefined;
      const check = async (): Promise<void> => {
        assertCurrent();
        if (identity === undefined || !supportsDesktopRemoteDesktopLinuxCapture(this.#runtime.linux)
          || !await this.#runtime.linux.trustedExecutable(HYPRCTL)) throw new Error(UNAVAILABLE);
        assertCurrent();
        const monitors = await readDesktopRemoteDesktopLinuxMonitors(signal, this.#runtime.linux, true);
        assertCurrent();
        const monitor = monitors.find(candidate => `hyprland:${candidate.name}` === displayId);
        if (monitor === undefined || selected !== undefined && !sameMonitor(selected, monitor)) {
          throw new Error(UNAVAILABLE);
        }
        selected ??= monitor;
        if (action === "systemMenu" && !await menuSupport(this.#runtime.linux)) throw new Error(UNAVAILABLE);
        assertCurrent();
        if (await this.#runtime.session(signal) !== "unlocked") throw new Error(UNAVAILABLE);
        assertCurrent();
      };
      try {
        if (action !== "workspaceLeft" && action !== "workspaceRight" && action !== "systemMenu") {
          throw new Error(UNAVAILABLE);
        }
        await check();
        if (this.#syntaxIdentity !== identity) {
          this.#syntaxIdentity = identity;
          this.#lua = undefined;
        }
        await this.#dispatch("focusmonitor", selected!.name, check, signal);
        await check();
        if (action === "systemMenu") {
          await this.#runtime.linux.execute(MENU, ["menu", "toggle"], signal, 16_384, 2_000);
        } else {
          // Relative navigation includes empty workspaces on the selected monitor.
          await this.#dispatch("workspace", action === "workspaceLeft" ? "r-1" : "r+1", check, signal);
        }
        await check();
      } catch (error) {
        assertCurrent();
        if (error instanceof Error && error.message === EXPIRED) throw error;
        throw new Error(UNAVAILABLE);
      }
    });
    this.#tail = operation;
    return operation;
  }

  /** Retire queued actions and wait for an already issued process to exit. */
  stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    this.#generation += 1;
    const stopped = this.#tail.catch(() => {}).then(() => {});
    this.#stopping = stopped;
    void stopped.finally(() => { if (this.#stopping === stopped) this.#stopping = undefined; });
    return stopped;
  }

  async #dispatch(name: "focusmonitor" | "workspace", value: string, check: () => Promise<void>,
    signal: AbortSignal): Promise<void> {
    // Probe the newer typed dispatcher without any mutation. An issued effect
    // is never retried with another syntax if its result is unavailable.
    this.#lua ??= await this.#runtime.linux.execute(HYPRCTL,
      ["eval", 'assert(type(hl.dsp.focus) == "function")'], signal, 512_000, 2_000)
      .then(result => result.trim() === "ok", () => false);
    await check();
    if (!/^[A-Za-z0-9_.:+-]{1,128}$/u.test(value)) throw new Error(UNAVAILABLE);
    const field = name === "focusmonitor" ? "monitor" : "workspace";
    const arguments_ = this.#lua
      ? ["eval", `hl.dispatch(hl.dsp.focus({${field}=${JSON.stringify(value)}}))`]
      : ["dispatch", name, value];
    if ((await this.#runtime.linux.execute(HYPRCTL, arguments_, signal, 512_000, 2_000)).trim() !== "ok") {
      throw new Error(UNAVAILABLE);
    }
  }
}

function ownedIdentity(runtime: DesktopRemoteDesktopLinuxRuntime): string | undefined {
  const uid = runtime.uid(), effectiveUid = runtime.effectiveUid(), environment = runtime.environment;
  if (uid === undefined || uid <= 0 || uid !== effectiveUid
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(environment["XDG_SESSION_ID"] ?? "")
    || !environment["HYPRLAND_INSTANCE_SIGNATURE"]) return undefined;
  return JSON.stringify([uid, effectiveUid, environment["XDG_SESSION_ID"], environment["XDG_SESSION_TYPE"],
    environment["WAYLAND_DISPLAY"], environment["HYPRLAND_INSTANCE_SIGNATURE"]]);
}
function sameMonitor(first: DesktopRemoteDesktopLinuxMonitor, second: DesktopRemoteDesktopLinuxMonitor): boolean {
  return first.name === second.name && first.width === second.width && first.height === second.height
    && first.x === second.x && first.y === second.y && first.scale === second.scale && first.transform === second.transform;
}
async function menuSupport(runtime: DesktopRemoteDesktopLinuxRuntime): Promise<boolean> {
  return await runtime.trustedExecutable(MENU) && await runtime.trustedExecutable(MENU_HELPER);
}
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw new Error(EXPIRED); }
function unsupported() { return Object.freeze({ workspaceNavigation: false, systemMenu: false }); }
