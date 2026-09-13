import type { DesktopUpdateRelaunchResult, DesktopUpdateStatus } from "./channels.js";

export const DESKTOP_UPDATE_AUTO_RELAUNCH_IDLE_SECONDS = 10 * 60;
export const DESKTOP_UPDATE_AUTO_RELAUNCH_BUSY_QUIET_MS = 60_000;
export const DESKTOP_UPDATE_AUTO_RELAUNCH_RESUME_COOLDOWN_MS = 60_000;
export const DESKTOP_UPDATE_AUTO_RELAUNCH_POLL_MS = 30_000;

export type DesktopUpdateIdleState = "active" | "idle" | "locked" | "unknown";

export type DesktopUpdateAutoRelaunchBlockReason =
  | "disabled"
  | "development"
  | "not-ready"
  | "relaunching"
  | "busy"
  | "recent-busy"
  | "recent-resume"
  | "user-active"
  | "screen-state-unknown"
  | "disposed";

export interface DesktopUpdateAutoRelaunchReadiness {
  readonly enabled: boolean;
  readonly isPackaged: boolean;
  readonly status: DesktopUpdateStatus;
  readonly relaunching: boolean;
  readonly busy: boolean;
  readonly idleTimeSeconds: number;
  readonly idleState: DesktopUpdateIdleState;
  readonly nowMs: number;
  readonly lastBusyAtMs: number | null;
  readonly lastResumeAtMs: number | null;
}

export interface DesktopUpdateAutoRelaunchClock {
  readonly now: () => number;
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface DesktopUpdatePowerEvents {
  readonly on: (event: "resume" | "unlock-screen" | "user-did-become-active", listener: () => void) => unknown;
  readonly removeListener: (event: "resume" | "unlock-screen" | "user-did-become-active", listener: () => void) => unknown;
}

export interface DesktopUpdateAutoRelaunchPolicy {
  readonly evaluate: (reason: string) => Promise<DesktopUpdateAutoRelaunchBlockReason | "accepted">;
  readonly notifyBusyStateChanged: () => void;
  readonly dispose: () => void;
}

export interface DesktopUpdateAutoRelaunchPolicyOptions {
  readonly isPackaged: boolean;
  readonly getEnabled: () => boolean;
  readonly getStatus: () => DesktopUpdateStatus;
  readonly isRelaunching: () => boolean;
  /** Rejects on an unknown verdict; recently ended work carries a durable quiet fence. */
  readonly probeActivity: () => Promise<{
    readonly blocksShutdown: boolean;
    readonly lastBlockingActivityAtMs?: number;
  }>;
  readonly readIdleTimeSeconds: () => number;
  readonly readIdleState: () => DesktopUpdateIdleState;
  readonly requestRelaunch: () => Promise<DesktopUpdateRelaunchResult>;
  readonly powerEvents: DesktopUpdatePowerEvents;
  readonly clock?: DesktopUpdateAutoRelaunchClock;
  readonly pollIntervalMs?: number;
}

export function isDesktopUpdateActivityQuietForAutoRelaunch(
  activity: { readonly blocksShutdown: boolean; readonly lastBlockingActivityAtMs?: number },
  nowMs: number
): boolean {
  const lastBlockingActivityAtMs = activity.lastBlockingActivityAtMs;
  return !activity.blocksShutdown && Number.isSafeInteger(nowMs) &&
    lastBlockingActivityAtMs !== undefined && Number.isSafeInteger(lastBlockingActivityAtMs) &&
    lastBlockingActivityAtMs >= 0 && lastBlockingActivityAtMs <= nowMs &&
    nowMs - lastBlockingActivityAtMs >= DESKTOP_UPDATE_AUTO_RELAUNCH_BUSY_QUIET_MS;
}

export function getDesktopUpdateAutoRelaunchBlockReason(
  input: DesktopUpdateAutoRelaunchReadiness
): DesktopUpdateAutoRelaunchBlockReason | null {
  if (!input.enabled) return "disabled";
  if (!input.isPackaged) return "development";
  if (input.status.status !== "ready") return "not-ready";
  if (input.relaunching) return "relaunching";
  if (input.busy) return "busy";
  if (input.lastBusyAtMs !== null && input.nowMs - input.lastBusyAtMs < DESKTOP_UPDATE_AUTO_RELAUNCH_BUSY_QUIET_MS) {
    return "recent-busy";
  }
  if (input.lastResumeAtMs !== null && input.nowMs - input.lastResumeAtMs < DESKTOP_UPDATE_AUTO_RELAUNCH_RESUME_COOLDOWN_MS) {
    return "recent-resume";
  }
  if (input.idleState === "unknown") return "screen-state-unknown";
  if (input.idleState === "active") return "user-active";
  if (!Number.isFinite(input.idleTimeSeconds) || input.idleTimeSeconds < DESKTOP_UPDATE_AUTO_RELAUNCH_IDLE_SECONDS) {
    return "user-active";
  }
  return null;
}

export function createDesktopUpdateAutoRelaunchPolicy(
  options: DesktopUpdateAutoRelaunchPolicyOptions
): DesktopUpdateAutoRelaunchPolicy {
  const clock = options.clock ?? systemClock();
  let lastBusyAtMs: number | null = null;
  let lastResumeAtMs: number | null = null;
  let inFlight: Promise<DesktopUpdateAutoRelaunchBlockReason | "accepted"> | undefined;
  let relaunchCommitted = false;
  let disposed = false;

  const cheapBlockReason = (): DesktopUpdateAutoRelaunchBlockReason | null => {
    if (disposed) return "disposed";
    if (!options.getEnabled()) return "disabled";
    if (!options.isPackaged) return "development";
    if (options.getStatus().status !== "ready") return "not-ready";
    if (relaunchCommitted || options.isRelaunching()) return "relaunching";
    return null;
  };

  const performEvaluation = async (): Promise<DesktopUpdateAutoRelaunchBlockReason | "accepted"> => {
    const cheap = cheapBlockReason();
    if (cheap !== null) return cheap;
    let activity: { readonly blocksShutdown: boolean; readonly lastBlockingActivityAtMs?: number } = {
      blocksShutdown: true
    };
    try {
      activity = await options.probeActivity();
    } catch {
      activity = { blocksShutdown: true };
    }
    if (disposed) return "disposed";

    // The authority probe is asynchronous. Re-snapshot every mutable gate and
    // the system-idle state immediately before crossing the apply boundary.
    const nowMs = clock.now();
    const activityTimestamp = activity.lastBlockingActivityAtMs;
    const timestampValid = activityTimestamp !== undefined && Number.isSafeInteger(activityTimestamp) &&
      activityTimestamp >= 0 && activityTimestamp <= nowMs;
    const busy = activity.blocksShutdown || !timestampValid;
    if (timestampValid) lastBusyAtMs = Math.max(lastBusyAtMs ?? Number.NEGATIVE_INFINITY, activityTimestamp);
    if (busy) {
      lastBusyAtMs = nowMs;
    }
    const block = getDesktopUpdateAutoRelaunchBlockReason({
      enabled: options.getEnabled(),
      isPackaged: options.isPackaged,
      status: options.getStatus(),
      relaunching: relaunchCommitted || options.isRelaunching(),
      busy,
      idleTimeSeconds: safeIdleTime(options.readIdleTimeSeconds),
      idleState: safeIdleState(options.readIdleState),
      nowMs,
      lastBusyAtMs,
      lastResumeAtMs
    });
    if (block !== null) return block;

    relaunchCommitted = true;
    const result = await options.requestRelaunch().catch((): DesktopUpdateRelaunchResult => ({
      accepted: false,
      reason: "apply-failed"
    }));
    if (result.accepted) return "accepted";
    relaunchCommitted = false;
    if (result.reason === "busy") {
      lastBusyAtMs = clock.now();
      return "busy";
    }
    return "not-ready";
  };

  const evaluate = (_reason: string): Promise<DesktopUpdateAutoRelaunchBlockReason | "accepted"> => {
    if (inFlight !== undefined) return inFlight;
    const operation = performEvaluation().finally(() => {
      if (inFlight === operation) inFlight = undefined;
    });
    inFlight = operation;
    return operation;
  };

  const handlePowerActivity = (): void => {
    lastResumeAtMs = clock.now();
    void evaluate("power-activity");
  };
  options.powerEvents.on("resume", handlePowerActivity);
  options.powerEvents.on("unlock-screen", handlePowerActivity);
  options.powerEvents.on("user-did-become-active", handlePowerActivity);
  const poll = clock.setInterval(() => void evaluate("poll"), options.pollIntervalMs ?? DESKTOP_UPDATE_AUTO_RELAUNCH_POLL_MS);

  return Object.freeze({
    evaluate,
    notifyBusyStateChanged: () => {
      lastBusyAtMs = clock.now();
      void evaluate("busy-state-changed");
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clock.clearInterval(poll);
      options.powerEvents.removeListener("resume", handlePowerActivity);
      options.powerEvents.removeListener("unlock-screen", handlePowerActivity);
      options.powerEvents.removeListener("user-did-become-active", handlePowerActivity);
    }
  });
}

function safeIdleTime(read: () => number): number {
  try {
    const value = read();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function safeIdleState(read: () => DesktopUpdateIdleState): DesktopUpdateIdleState {
  try {
    const value = read();
    return value === "active" || value === "idle" || value === "locked" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

function systemClock(): DesktopUpdateAutoRelaunchClock {
  return {
    now: Date.now,
    setInterval: (callback, delayMs) => {
      const handle = setInterval(callback, delayMs);
      handle.unref();
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
  };
}
