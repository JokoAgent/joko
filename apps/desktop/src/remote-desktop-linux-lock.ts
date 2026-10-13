import { spawn } from "node:child_process";
import type { DesktopRemoteDesktopDisplayModeProcess, DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import {
  isDesktopRemoteDesktopWayland, linuxRuntime, readDesktopRemoteDesktopLinuxLockSessionState,
  type DesktopRemoteDesktopLinuxRuntime
} from "./remote-desktop-linux.js";

const LOGINCTL = "/usr/bin/loginctl";
const HYPRCTL = "/usr/bin/hyprctl";
const SESSION_SHELL = "/usr/bin/omarchy-shell";
let locking = false;

export interface DesktopRemoteDesktopLinuxLockRuntime {
  readonly linux: DesktopRemoteDesktopLinuxRuntime;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  spawn(file: string, arguments_: readonly string[]): DesktopRemoteDesktopDisplayModeProcess;
}
interface LockOccurrence {
  readonly runtime: DesktopRemoteDesktopLinuxLockRuntime;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly identity: string;
  readonly session: string;
  readonly hyprland: boolean;
}
interface LockStatus { readonly secure: boolean; readonly passwordPam: boolean }

/** Lock support is independent of screen capture, input and credential support. */
export async function supportsDesktopRemoteDesktopLinuxLock(
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxLockRuntime = lockRuntime()
): Promise<boolean> {
  try {
    const occurrence = occurrenceFor(() => true, signal, runtime);
    await prove(occurrence);
    const status = await optionalStatus(occurrence);
    check(occurrence);
    return status === undefined || status.secure || status.passwordPam;
  } catch {
    if (signal.aborted) throw expired();
    return false;
  }
}

/** Sends one owned-session lock request and confirms its terminal receipt. */
export async function lockDesktopRemoteDesktopLinuxScreen(
  current: () => boolean,
  signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxLockRuntime = lockRuntime()
): Promise<void> {
  if (locking) throw unavailable();
  locking = true;
  let occurrence: LockOccurrence | undefined;
  let dispatched = false;
  try {
    occurrence = occurrenceFor(current, signal, runtime);
    await prove(occurrence);
    const status = await optionalStatus(occurrence);
    check(occurrence);
    if (status !== undefined) {
      if (!status.secure) {
        if (!status.passwordPam) throw unavailable();
        await writeRequest(SESSION_SHELL, ["lock", "lock"], 128, 1_000, true, occurrence,
          () => { dispatched = true; });
      }
      await waitForSecureLock(occurrence, status.secure ? status : undefined);
      return;
    }
    await writeRequest(LOGINCTL, ["lock-session", occurrence.session], 1_024, 3_000, false, occurrence,
      () => { dispatched = true; });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await prove(occurrence) === "locked-logged-in") return;
      if (attempt < 9) await delay(100, occurrence);
    }
    throw failed();
  } catch (error) {
    if (occurrence !== undefined) check(occurrence);
    else if (signal.aborted || !current()) throw expired();
    if (error instanceof Error && error.message === "REMOTE_DESKTOP_LOCK_EXPIRED") throw expired();
    if (!dispatched && error instanceof Error && error.message === "REMOTE_DESKTOP_LOCK_UNAVAILABLE") throw unavailable();
    throw failed();
  } finally {
    // Dispatched commands settle only at actual close, including cancellation and errors.
    locking = false;
  }
}

function identity(runtime: DesktopRemoteDesktopLinuxLockRuntime): string {
  const linux = runtime.linux, environment = linux.environment;
  return JSON.stringify([linux.platform, linux.uid(), linux.effectiveUid(), environment["XDG_SESSION_ID"],
    environment["XDG_SESSION_TYPE"], environment["WAYLAND_DISPLAY"], environment["XDG_RUNTIME_DIR"],
    environment["HYPRLAND_INSTANCE_SIGNATURE"]]);
}
function occurrenceFor(current: () => boolean, signal: AbortSignal,
  runtime: DesktopRemoteDesktopLinuxLockRuntime): LockOccurrence {
  if (signal.aborted || !current()) throw expired();
  const linux = runtime.linux, session = linux.environment["XDG_SESSION_ID"];
  if (!isDesktopRemoteDesktopWayland(linux) || !Number.isSafeInteger(linux.uid()) || (linux.uid() ?? 0) <= 0
    || linux.uid() !== linux.effectiveUid() || !/^[a-zA-Z0-9_-]{1,64}$/u.test(session ?? "")) throw unavailable();
  return { runtime, signal, current, identity: identity(runtime), session: session!,
    hyprland: Boolean(linux.environment["HYPRLAND_INSTANCE_SIGNATURE"]) };
}
function check(occurrence: LockOccurrence): void {
  if (occurrence.signal.aborted || !occurrence.current() || identity(occurrence.runtime) !== occurrence.identity) throw expired();
}
async function prove(occurrence: LockOccurrence): Promise<DesktopRemoteDesktopSessionState> {
  check(occurrence);
  const linux = occurrence.runtime.linux;
  const trusted = await linux.trustedExecutable(LOGINCTL);
  check(occurrence);
  if (!trusted) throw unavailable();
  if (occurrence.hyprland) {
    const compositor = await linux.trustedExecutable(HYPRCTL);
    check(occurrence);
    if (!compositor) throw unavailable();
  }
  const state = await occurrence.runtime.session(occurrence.signal);
  check(occurrence);
  if (state !== "unlocked" && state !== "locked-logged-in") throw unavailable();
  return state;
}
async function status(occurrence: LockOccurrence): Promise<LockStatus> {
  await prove(occurrence);
  const trusted = await occurrence.runtime.linux.trustedExecutable(SESSION_SHELL);
  check(occurrence);
  if (!trusted) throw unavailable();
  await prove(occurrence);
  const raw = await occurrence.runtime.linux.execute(SESSION_SHELL, ["lock", "status"], occurrence.signal, 4_096, 1_000);
  check(occurrence);
  await prove(occurrence);
  if (Buffer.byteLength(raw) > 4_096) throw unavailable();
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
  const record = value as Record<string, unknown>;
  if (typeof record["secure"] !== "boolean" || typeof record["passwordPam"] !== "boolean") throw unavailable();
  return { secure: record["secure"], passwordPam: record["passwordPam"] };
}
async function optionalStatus(occurrence: LockOccurrence): Promise<LockStatus | undefined> {
  if (!occurrence.hyprland) return undefined;
  try { return await status(occurrence); }
  catch {
    check(occurrence);
    await prove(occurrence);
    return undefined;
  }
}
async function waitForSecureLock(occurrence: LockOccurrence, first?: LockStatus): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    const observed = first ?? await status(occurrence);
    first = undefined;
    const state = await prove(occurrence);
    if (observed.secure && state === "locked-logged-in") return;
    await delay(100, occurrence);
  } while (Date.now() < deadline);
  check(occurrence);
  throw failed();
}
async function delay(milliseconds: number, occurrence: LockOccurrence): Promise<void> {
  check(occurrence);
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
  check(occurrence);
}
async function writeRequest(file: string, arguments_: readonly string[], maximumBytes: number, timeoutMs: number,
  requiresOk: boolean, occurrence: LockOccurrence, dispatched: () => void): Promise<void> {
  await prove(occurrence);
  const trusted = await occurrence.runtime.linux.trustedExecutable(file);
  check(occurrence);
  if (!trusted) throw unavailable();
  await prove(occurrence);
  check(occurrence);
  const child = occurrence.runtime.spawn(file, arguments_);
  dispatched();
  await new Promise<void>((resolve, reject) => {
    let stopped = false, output = Buffer.alloc(0);
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      try { child.kill("SIGTERM"); } catch { /* Actual close retains the command owner. */ }
    };
    const data = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (output.length + bytes.length > maximumBytes) { stop(); return; }
      output = Buffer.concat([output, bytes]);
    };
    const timeout = setTimeout(stop, timeoutMs);
    occurrence.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", data); child.stdout.on("error", stop);
    child.stderr.resume(); child.stderr.on("error", stop); child.once("error", stop);
    child.once("close", (exitCode, termination) => {
      clearTimeout(timeout); occurrence.signal.removeEventListener("abort", stop);
      child.stdout.removeListener("data", data); child.stdout.removeListener("error", stop); child.stderr.removeListener("error", stop);
      try {
        check(occurrence);
        const receipt = new TextDecoder("utf-8", { fatal: true }).decode(output);
        if (stopped || exitCode !== 0 || termination !== null || (requiresOk && receipt.trim() !== "ok")) throw failed();
        resolve();
      } catch (error) { reject(error); }
    });
    if (occurrence.signal.aborted) stop();
  });
  await prove(occurrence);
}
function unavailable(): Error { return new Error("REMOTE_DESKTOP_LOCK_UNAVAILABLE"); }
function failed(): Error { return new Error("REMOTE_DESKTOP_LOCK_FAILED"); }
function expired(): Error { return new Error("REMOTE_DESKTOP_LOCK_EXPIRED"); }
function lockRuntime(): DesktopRemoteDesktopLinuxLockRuntime {
  const linux = linuxRuntime();
  return { linux, session: signal => readDesktopRemoteDesktopLinuxLockSessionState(signal, linux),
    spawn: (file, args) => spawn(file, [...args], { stdio: "pipe" }) };
}
