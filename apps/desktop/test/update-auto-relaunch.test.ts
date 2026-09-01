import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { DesktopUpdateRelaunchResult, DesktopUpdateStatus } from "../src/channels.js";
import {
  DESKTOP_UPDATE_AUTO_RELAUNCH_BUSY_QUIET_MS,
  DESKTOP_UPDATE_AUTO_RELAUNCH_RESUME_COOLDOWN_MS,
  createDesktopUpdateAutoRelaunchPolicy,
  getDesktopUpdateAutoRelaunchBlockReason,
  isDesktopUpdateActivityQuietForAutoRelaunch,
  type DesktopUpdateAutoRelaunchClock,
  type DesktopUpdateIdleState
} from "../src/update-auto-relaunch.js";

describe("desktop idle auto-relaunch policy", () => {
  it("requires a present sixty-second-old authority timestamp at the final native boundary", () => {
    expect(isDesktopUpdateActivityQuietForAutoRelaunch({
      blocksShutdown: false,
      lastBlockingActivityAtMs: 0
    }, 60_000)).toBe(true);
    expect(isDesktopUpdateActivityQuietForAutoRelaunch({ blocksShutdown: false }, 60_000)).toBe(false);
    expect(isDesktopUpdateActivityQuietForAutoRelaunch({
      blocksShutdown: false,
      lastBlockingActivityAtMs: 1
    }, 60_000)).toBe(false);
    expect(isDesktopUpdateActivityQuietForAutoRelaunch({
      blocksShutdown: true,
      lastBlockingActivityAtMs: 0
    }, 60_000)).toBe(false);
  });
  it("applies the complete cheap, activity, idle, and screen-state gates", () => {
    const base = {
      enabled: true,
      isPackaged: true,
      status: { status: "ready", version: "2.0.0" } as DesktopUpdateStatus,
      relaunching: false,
      busy: false,
      idleTimeSeconds: 600,
      idleState: "idle" as const,
      nowMs: 100_000,
      lastBusyAtMs: null,
      lastResumeAtMs: null
    };
    expect(getDesktopUpdateAutoRelaunchBlockReason(base)).toBeNull();
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, enabled: false })).toBe("disabled");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, isPackaged: false })).toBe("development");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, status: { status: "checking" } })).toBe("not-ready");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, relaunching: true })).toBe("relaunching");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, busy: true })).toBe("busy");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, lastBusyAtMs: 99_999 })).toBe("recent-busy");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, lastResumeAtMs: 99_999 })).toBe("recent-resume");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, idleState: "unknown" })).toBe("screen-state-unknown");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, idleState: "active" })).toBe("user-active");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, idleTimeSeconds: 599 })).toBe("user-active");
    expect(getDesktopUpdateAutoRelaunchBlockReason({ ...base, idleState: "locked" })).toBeNull();
  });

  it("uses Orchestrator's durable last-activity timestamp without adding a synthetic quiet delay", async () => {
    const fixture = policyFixture();
    fixture.clock.nowMs = 120_000;
    fixture.probe.mockResolvedValue({ blocksShutdown: false, lastBlockingActivityAtMs: 1_000 });

    await expect(fixture.policy.evaluate("ready")).resolves.toBe("accepted");
    expect(fixture.request).toHaveBeenCalledOnce();
  });

  it("honors recent blocking activity and waits for the full sixty-second quiet period", async () => {
    const fixture = policyFixture();
    fixture.clock.nowMs = 100_000;
    fixture.probe.mockResolvedValue({ blocksShutdown: false, lastBlockingActivityAtMs: 90_000 });
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("recent-busy");
    expect(fixture.request).not.toHaveBeenCalled();

    fixture.clock.nowMs = 90_000 + DESKTOP_UPDATE_AUTO_RELAUNCH_BUSY_QUIET_MS;
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("accepted");
  });

  it("records an apply-boundary busy verdict and cannot retry inside the quiet period", async () => {
    const fixture = policyFixture();
    fixture.clock.nowMs = 100_000;
    fixture.probe.mockResolvedValue({ blocksShutdown: false, lastBlockingActivityAtMs: 1_000 });
    fixture.request.mockResolvedValueOnce({ accepted: false, reason: "busy" });
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("busy");

    fixture.clock.nowMs += 30_000;
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("recent-busy");
    expect(fixture.request).toHaveBeenCalledOnce();
    fixture.clock.nowMs += 30_000;
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("accepted");
  });

  it("re-snapshots ready and enabled state after the asynchronous authority probe", async () => {
    const fixture = policyFixture();
    const activity = deferred<{ blocksShutdown: boolean; lastBlockingActivityAtMs?: number }>();
    fixture.probe.mockReturnValue(activity.promise);
    const evaluation = fixture.policy.evaluate("poll");
    fixture.status = { status: "idle", availability: "available" };
    activity.resolve({ blocksShutdown: false, lastBlockingActivityAtMs: 0 });
    await expect(evaluation).resolves.toBe("not-ready");
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("fails unknown activity and screen state closed while allowing a locked idle screen", async () => {
    const fixture = policyFixture();
    fixture.probe.mockRejectedValueOnce(new Error("authority unavailable"));
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("busy");
    fixture.clock.nowMs += DESKTOP_UPDATE_AUTO_RELAUNCH_BUSY_QUIET_MS;
    fixture.probe.mockResolvedValue({ blocksShutdown: false, lastBlockingActivityAtMs: 0 });
    fixture.idleState = "unknown";
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("screen-state-unknown");
    fixture.idleState = "locked";
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("accepted");
  });

  it("coalesces evaluations, commits only once, and disposes polling and power listeners", async () => {
    const fixture = policyFixture();
    const activity = deferred<{ blocksShutdown: boolean; lastBlockingActivityAtMs?: number }>();
    fixture.probe.mockReturnValue(activity.promise);
    const first = fixture.policy.evaluate("status-ready");
    const second = fixture.policy.evaluate("poll");
    expect(second).toBe(first);
    activity.resolve({ blocksShutdown: false, lastBlockingActivityAtMs: 0 });
    await expect(first).resolves.toBe("accepted");
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("relaunching");
    expect(fixture.request).toHaveBeenCalledOnce();

    expect(fixture.events.listenerCount("resume")).toBe(1);
    fixture.policy.dispose();
    fixture.policy.dispose();
    expect(fixture.events.listenerCount("resume")).toBe(0);
    expect(fixture.clock.clearInterval).toHaveBeenCalledOnce();
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("disposed");
  });

  it("enforces resume cooldown", async () => {
    const fixture = policyFixture();
    fixture.clock.nowMs = 100_000;
    fixture.events.emit("resume");
    await flushAsync();
    expect(fixture.request).not.toHaveBeenCalled();
    fixture.clock.nowMs += DESKTOP_UPDATE_AUTO_RELAUNCH_RESUME_COOLDOWN_MS - 1;
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("recent-resume");
    fixture.clock.nowMs += 1;
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("accepted");
  });

  it("fails closed when the activity authority omits its durable timestamp", async () => {
    const fixture = policyFixture();
    fixture.probe.mockResolvedValue({ blocksShutdown: false });
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("busy");
    fixture.clock.nowMs += DESKTOP_UPDATE_AUTO_RELAUNCH_BUSY_QUIET_MS * 2;
    await expect(fixture.policy.evaluate("poll")).resolves.toBe("busy");
    expect(fixture.request).not.toHaveBeenCalled();
  });
});

type ActivityDecision = { readonly blocksShutdown: boolean; readonly lastBlockingActivityAtMs?: number };
type MutableClock = DesktopUpdateAutoRelaunchClock & {
  nowMs: number;
  readonly clearInterval: ReturnType<typeof vi.fn<(handle: unknown) => void>>;
};

function policyFixture() {
  const events = new EventEmitter();
  const clock: MutableClock = {
    nowMs: 100_000,
    now: () => clock.nowMs,
    setInterval: vi.fn(() => ({ kind: "poll" })),
    clearInterval: vi.fn()
  };
  const probe = vi.fn<() => Promise<ActivityDecision>>(async () => ({
    blocksShutdown: false,
    lastBlockingActivityAtMs: 0
  }));
  const request = vi.fn<() => Promise<DesktopUpdateRelaunchResult>>(async () => ({ accepted: true }));
  const fixture = {
    status: { status: "ready", version: "2.0.0" } as DesktopUpdateStatus,
    enabled: true,
    idleTimeSeconds: 600,
    idleState: "idle" as DesktopUpdateIdleState,
    events,
    clock,
    probe,
    request,
    policy: undefined as unknown as ReturnType<typeof createDesktopUpdateAutoRelaunchPolicy>
  };
  fixture.policy = createDesktopUpdateAutoRelaunchPolicy({
    isPackaged: true,
    getEnabled: () => fixture.enabled,
    getStatus: () => fixture.status,
    isRelaunching: () => false,
    probeActivity: probe,
    readIdleTimeSeconds: () => fixture.idleTimeSeconds,
    readIdleState: () => fixture.idleState,
    requestRelaunch: request,
    powerEvents: {
      on: (event, listener) => events.on(event, listener),
      removeListener: (event, listener) => events.removeListener(event, listener)
    },
    clock
  });
  return fixture;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
