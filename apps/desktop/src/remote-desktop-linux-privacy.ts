import { app, nativeTheme } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import { readDesktopRemoteDesktopLinuxSessionState, supportsDesktopRemoteDesktopLinuxCapture } from "./remote-desktop-linux.js";
import { verifyPackagedDesktopRemoteDesktopPrivacy } from "./remote-desktop-native-manifest.js";

const execute = promisify(execFile);
const unavailable = (): Error => new Error("REMOTE_DESKTOP_PRIVACY_UNAVAILABLE");
const expired = (): Error => new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");

interface PrivacyArtifact {
  readonly path: string;
  readonly metadata: { readonly version: string; readonly hash: string; readonly source: string };
}

export interface DesktopRemoteDesktopLinuxPrivacyRuntime {
  nativeRoute(): boolean;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  version(): Promise<unknown>;
  artifact(): Promise<PrivacyArtifact>;
  call(request: Record<string, unknown>): Promise<string>;
  plugin(operation: "load" | "unload", path: string): Promise<void>;
  labels(): readonly string[];
  dark(): boolean;
}

async function run(arguments_: string[]): Promise<string> {
  return (await execute("/usr/bin/hyprctl", arguments_, { timeout: 3_000, maxBuffer: 16_384, encoding: "utf8" })).stdout.trim();
}

const runtime: DesktopRemoteDesktopLinuxPrivacyRuntime = {
  nativeRoute: supportsDesktopRemoteDesktopLinuxCapture,
  session: readDesktopRemoteDesktopLinuxSessionState,
  version: async () => JSON.parse(await run(["-j", "version"])) as unknown,
  artifact: () => verifyPackagedDesktopRemoteDesktopPrivacy(app.isPackaged
    ? join(process.resourcesPath, "native-remote-desktop")
    : fileURLToPath(new URL("./native-remote-desktop/", import.meta.url)), process.platform, process.arch),
  call: request => run(["joko-privacy", JSON.stringify(request)]),
  plugin: async (operation, path) => { await run(["plugin", operation, path]); },
  labels: () => privacyLabels(app.getLocale()),
  dark: () => nativeTheme.shouldUseDarkColors
};

function authorized(current: () => boolean, signal: AbortSignal): boolean {
  try { return !signal.aborted && current(); } catch { return false; }
}

function check(current: () => boolean, signal: AbortSignal): void {
  if (!authorized(current, signal)) throw expired();
}

async function artifactForSession(current: () => boolean, signal: AbortSignal,
  native: DesktopRemoteDesktopLinuxPrivacyRuntime): Promise<PrivacyArtifact> {
  check(current, signal);
  if (!native.nativeRoute() || await native.session(signal) !== "unlocked") throw unavailable();
  check(current, signal);
  const version = await native.version();
  check(current, signal);
  if (typeof version !== "object" || version === null || Array.isArray(version)) throw unavailable();
  const value = version as Record<string, unknown>;
  if (value["version"] !== "0.56.2" || typeof value["commit"] !== "string"
    || !/^[a-f0-9]{40}$/u.test(value["commit"]) || value["dirty"] !== false) throw unavailable();
  const artifact = await native.artifact();
  check(current, signal);
  if (artifact.metadata.version !== value["version"] || artifact.metadata.hash !== value["commit"]
    || !/^[a-f0-9]{64}$/u.test(artifact.metadata.source)) throw unavailable();
  return artifact;
}

export async function supportsDesktopRemoteDesktopLinuxPrivacy(signal: AbortSignal,
  native: DesktopRemoteDesktopLinuxPrivacyRuntime = runtime): Promise<boolean> {
  try { await artifactForSession(() => true, signal, native); return true; }
  catch { if (signal.aborted) throw expired(); return false; }
}

/** Plugin load/unload can reload compositor configuration, so only a pre-lease
 * caller may opt into it. A toggle requires the exact already loaded source. */
export async function prepareDesktopRemoteDesktopLinuxPrivacy(current: () => boolean, signal: AbortSignal,
  allowLoad = false, native: DesktopRemoteDesktopLinuxPrivacyRuntime = runtime): Promise<void> {
  try {
    const artifact = await artifactForSession(current, signal, native);
    const identity = `ready:${artifact.metadata.source}`;
    const existing = await native.call({ op: "probe" }).catch(() => "");
    check(current, signal);
    if (existing !== identity && !allowLoad) throw unavailable();
    if (existing.startsWith("ready:") && existing !== identity) {
      const retired = await native.call({ op: "retire" });
      check(current, signal);
      if (!isAbsolute(retired) || retired.length > 4_096 || retired.includes("\0")
        || !retired.endsWith("/joko-hyprland-privacy.so")) throw unavailable();
      await native.plugin("unload", retired);
      check(current, signal);
    }
    if (existing !== identity) {
      check(current, signal);
      await native.plugin("load", artifact.path);
      check(current, signal);
    }
    const deadline = Date.now() + 3_000;
    let state = await native.call({ op: "probe" });
    check(current, signal);
    while (state === `loading:${artifact.metadata.source}` && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      check(current, signal);
      state = await native.call({ op: "probe" });
      check(current, signal);
    }
    if (state !== identity) throw unavailable();
  } catch {
    check(current, signal);
    throw unavailable();
  }
}

interface PrivacyOccurrence {
  readonly owner: object;
  readonly displayId: string;
  readonly token: string;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  retired: boolean;
  acknowledged: boolean;
  startSettled: boolean;
  start?: Promise<string>;
  setting?: Promise<void>;
  cleanup?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  pausing?: Promise<() => Promise<void>>;
  resume?: () => Promise<void>;
}

export interface DesktopRemoteDesktopLinuxPrivacyDependencies {
  stopped(owner: object): Promise<void>;
  suspendInput(current: () => boolean, signal: AbortSignal): Promise<() => Promise<void>>;
}

/** The compositor owns physical coverage/input exclusion and its six-second
 * watchdog. Each captured owner joins actual native and input cleanup. */
export class DesktopRemoteDesktopLinuxPrivacyScreen {
  readonly #dependencies: DesktopRemoteDesktopLinuxPrivacyDependencies;
  readonly #native: DesktopRemoteDesktopLinuxPrivacyRuntime;
  readonly #occurrences = new Set<PrivacyOccurrence>();
  #active: PrivacyOccurrence | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(dependencies: DesktopRemoteDesktopLinuxPrivacyDependencies,
    native: DesktopRemoteDesktopLinuxPrivacyRuntime = runtime) {
    this.#dependencies = dependencies;
    this.#native = native;
  }

  get active(): boolean { return this.#active !== undefined; }

  set(owner: object, displayId: string, current: () => boolean, signal: AbortSignal): Promise<void> {
    if (!authorized(current, signal)) return Promise.reject(expired());
    if (this.#active !== undefined) {
      if (this.#active.owner === owner && this.#active.displayId === displayId && this.#valid(this.#active)) {
        return this.#active.setting ?? Promise.resolve();
      }
      return Promise.reject(unavailable());
    }
    const occurrence: PrivacyOccurrence = {
      owner, displayId, current, signal, token: randomBytes(16).toString("hex"),
      retired: false, acknowledged: false, startSettled: false,
      abort: () => { void this.release(owner).catch(() => undefined); }
    };
    this.#active = occurrence;
    this.#occurrences.add(occurrence);
    signal.addEventListener("abort", occurrence.abort, { once: true });
    const result = this.#tail.then(async () => {
      try {
        for (const previous of this.#occurrences) {
          if (previous !== occurrence && previous.retired) await this.#cleanup(previous);
        }
        this.#check(occurrence);
        await prepareDesktopRemoteDesktopLinuxPrivacy(() => this.#valid(occurrence), signal, false, this.#native);
        this.#check(occurrence);
        const start = this.#native.call({ op: "start", token: occurrence.token,
          labels: this.#native.labels(), dark: this.#native.dark() });
        occurrence.start = start;
        let state: string;
        try { state = await start; } finally { occurrence.startSettled = true; }
        const deadline = Date.now() + 2_000;
        this.#check(occurrence);
        while (state === "starting" && Date.now() < deadline) {
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          this.#check(occurrence);
          state = await this.#native.call({ op: "ping", token: occurrence.token });
          this.#check(occurrence);
        }
        if (state !== "active") throw unavailable();
        occurrence.acknowledged = true;
        this.#schedule(occurrence);
      } catch {
        const wasCurrent = this.#valid(occurrence);
        this.#retire(occurrence);
        await this.#cleanup(occurrence);
        if (!wasCurrent) throw expired();
        throw unavailable();
      }
    });
    occurrence.setting = result;
    this.#tail = result.catch(() => undefined);
    return result;
  }

  release(owner: object): Promise<void> {
    const occurrences = [...this.#occurrences].filter(occurrence => occurrence.owner === owner);
    for (const occurrence of occurrences) this.#retire(occurrence);
    return Promise.all(occurrences.map(occurrence => this.#cleanup(occurrence))).then(() => undefined);
  }

  #valid(occurrence: PrivacyOccurrence): boolean {
    return this.#active === occurrence && !occurrence.retired && authorized(occurrence.current, occurrence.signal);
  }

  #check(occurrence: PrivacyOccurrence): void { if (!this.#valid(occurrence)) throw expired(); }

  #retire(occurrence: PrivacyOccurrence): void {
    occurrence.retired = true;
    clearTimeout(occurrence.timer);
    occurrence.timer = undefined;
    occurrence.signal.removeEventListener("abort", occurrence.abort);
    if (this.#active === occurrence) this.#active = undefined;
  }

  #cleanup(occurrence: PrivacyOccurrence): Promise<void> {
    if (occurrence.cleanup) return occurrence.cleanup;
    const result = (async () => {
      try {
        const start = occurrence.start;
        if (start) {
          if (!occurrence.startSettled) {
            // A release can precede the start's actual effect. Join its receipt
            // and then stop the same token again before admitting a replacement.
            const early = this.#native.call({ op: "stop", token: occurrence.token }).catch(() => "unavailable");
            await start.catch(() => undefined);
            await early;
          }
          if (await this.#native.call({ op: "stop", token: occurrence.token }) !== "off") throw unavailable();
        }
        let resume = occurrence.resume;
        if (occurrence.pausing) {
          try { resume = await occurrence.pausing; }
          catch { if (authorized(occurrence.current, occurrence.signal)) throw unavailable(); }
        }
        if (resume && authorized(occurrence.current, occurrence.signal)
          && (this.#active === undefined || this.#active === occurrence)) await resume();
        occurrence.resume = undefined;
        occurrence.pausing = undefined;
        this.#occurrences.delete(occurrence);
      } catch { throw unavailable(); }
    })();
    occurrence.cleanup = result;
    void result.catch(() => { if (occurrence.cleanup === result) occurrence.cleanup = undefined; });
    return result;
  }

  #schedule(occurrence: PrivacyOccurrence): void {
    if (!this.#valid(occurrence)) return;
    occurrence.timer = setTimeout(() => { void this.#poll(occurrence).catch(() => undefined); }, 250);
    occurrence.timer.unref?.();
  }

  async #poll(occurrence: PrivacyOccurrence): Promise<void> {
    if (!this.#valid(occurrence)) {
      this.#retire(occurrence);
      await this.#cleanup(occurrence);
      return;
    }
    try {
      const state = await this.#native.call({ op: "ping", token: occurrence.token });
      this.#check(occurrence);
      if (state === "pending") {
        const pausing = this.#dependencies.suspendInput(() => this.#valid(occurrence), occurrence.signal);
        occurrence.pausing = pausing;
        const resume = await pausing;
        occurrence.resume = resume;
        occurrence.pausing = undefined;
        this.#check(occurrence);
        if (await this.#native.call({ op: "confirm", token: occurrence.token }) !== "confirming") throw unavailable();
        this.#check(occurrence);
      } else if (state === "resume") {
        await occurrence.resume?.();
        this.#check(occurrence);
        occurrence.resume = undefined;
        if (await this.#native.call({ op: "resume", token: occurrence.token }) !== "active") throw unavailable();
        this.#check(occurrence);
      } else if (state === "disconnect") {
        await this.#finish(occurrence);
        return;
      } else if (state !== "active" && state !== "confirming") throw unavailable();
      this.#schedule(occurrence);
    } catch {
      if (this.#valid(occurrence)) await this.#finish(occurrence);
      else { this.#retire(occurrence); await this.#cleanup(occurrence); }
    }
  }

  async #finish(occurrence: PrivacyOccurrence): Promise<void> {
    try { await this.#dependencies.stopped(occurrence.owner); }
    finally { this.#retire(occurrence); await this.#cleanup(occurrence); }
  }
}

function privacyLabels(locale: string): readonly string[] {
  return locale.toLowerCase().startsWith("zh")
    ? ["此屏幕已隐藏，远程查看仍在继续。", "按键或点击以断开远程查看。", "断开远程查看？",
      "断开后此屏幕将恢复显示。若已启用退出锁屏，系统也将锁定。", "取消", "断开"]
    : ["This screen is hidden while remote viewing continues.", "Press a key or click to disconnect remote viewing.",
      "Disconnect remote viewing?", "Disconnecting restores this screen. The system also locks if lock on exit is enabled.", "Cancel", "Disconnect"];
}
