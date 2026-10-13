import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { linuxRuntime, type DesktopRemoteDesktopLinuxRuntime } from "./remote-desktop-linux.js";
import { verifyPackagedDesktopRemoteDesktopLinuxCredentials } from "./remote-desktop-native-manifest.js";

export type DesktopRemoteDesktopCredentialLockState = "locked" | "unlocked" | "unavailable";
const PYTHON = "/usr/bin/python3";
export interface DesktopRemoteDesktopLinuxCredentialsRuntime {
  readonly linux: DesktopRemoteDesktopLinuxRuntime;
  script(): Promise<string>;
}

/** Read-only native dependency/session probe; never opens the vault or invokes PAM. */
export async function readDesktopRemoteDesktopLinuxCredentialLockState(signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxCredentialsRuntime = credentialsRuntime()
): Promise<DesktopRemoteDesktopCredentialLockState> {
  try {
    check(signal);
    if (runtime.linux.platform !== "linux" || !await runtime.linux.trustedExecutable(PYTHON)) return "unavailable";
    check(signal);
    const script = await runtime.script(); check(signal);
    const prefix = ["-I", "-B", "-u", script];
    const support = await runtime.linux.execute(PYTHON, [...prefix, "--support"], signal, 1_024, 6_000);
    check(signal);
    if (support.trim() !== "supported") return "unavailable";
    const state = (await runtime.linux.execute(PYTHON, [...prefix, "--lock-state"], signal, 1_024, 6_000)).trim();
    check(signal);
    return state === "locked" || state === "unlocked" ? state : "unavailable";
  } catch { check(signal); return "unavailable"; }
}

export async function resolveDesktopRemoteDesktopLinuxCredentialScript(): Promise<string> {
  if (process.platform !== "linux" || !await linuxRuntime().trustedExecutable(PYTHON)) throw new Error("CREDENTIAL_UNAVAILABLE");
  if (app.isPackaged) return verifyPackagedDesktopRemoteDesktopLinuxCredentials(
    join(process.resourcesPath, "native-remote-desktop"), "linux", process.arch);
  const directory = join(app.getAppPath(), "native", "remote-desktop", "linux-credentials");
  const script = join(directory, "main.py");
  const info = await lstat(script);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(script) !== script) throw new Error("CREDENTIAL_UNAVAILABLE");
  return script;
}

function credentialsRuntime(): DesktopRemoteDesktopLinuxCredentialsRuntime {
  return { linux: linuxRuntime(), script: resolveDesktopRemoteDesktopLinuxCredentialScript };
}
function check(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error("CREDENTIAL_CANCELLED"); }
