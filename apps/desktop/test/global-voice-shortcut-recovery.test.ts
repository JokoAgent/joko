import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GlobalVoiceShortcutRecovery,
  type GlobalVoiceShortcutRecoveryTarget
} from "../src/global-voice-shortcut-recovery.js";

const f16 = Object.freeze({
  code: "F16",
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  fn: false
});
const fnA = Object.freeze({
  code: "KeyA",
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  fn: true
});

describe("global voice shortcut recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preflights and registers the latest target after permission is granted", async () => {
    let target: GlobalVoiceShortcutRecoveryTarget = { kind: "register", revision: 1, shortcut: fnA };
    let resolvePermission: ((status: "granted") => void) | undefined;
    const preflight = vi.fn(() => new Promise<"granted">((resolve) => { resolvePermission = resolve; }));
    const register = vi.fn(async () => "registered" as const);
    const onRecovered = vi.fn();
    const recovery = new GlobalVoiceShortcutRecovery({
      platform: "darwin",
      getTarget: () => target,
      preflight,
      register,
      onFailure: vi.fn(),
      onRecovered
    });

    const running = recovery.request();
    target = { kind: "register", revision: 2, shortcut: f16 };
    resolvePermission?.("granted");
    await running;

    expect(register).toHaveBeenCalledWith(f16, 2);
    expect(register).not.toHaveBeenCalledWith(fnA, 1);
    expect(onRecovered).toHaveBeenCalledOnce();
    recovery.dispose();
  });

  it("guards recording and pending starts, then performs a tail retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let target: GlobalVoiceShortcutRecoveryTarget = { kind: "none" };
    const preflight = vi.fn(async () => "granted" as const);
    const register = vi.fn(async () => "registered" as const);
    const recovery = new GlobalVoiceShortcutRecovery({
      platform: "darwin",
      getTarget: () => target,
      preflight,
      register,
      onFailure: vi.fn(),
      onRecovered: vi.fn()
    });

    await recovery.request();
    expect(preflight).not.toHaveBeenCalled();
    target = { kind: "wait" };
    await recovery.request();
    target = { kind: "register", revision: 1, shortcut: fnA };
    await vi.advanceTimersByTimeAsync(5_000);

    expect(preflight).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(fnA, 1);
    recovery.dispose();
  });

  it("rate-limits dense focus events but keeps the last request as a tail run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const preflight = vi.fn(async () => "denied" as const);
    const recovery = new GlobalVoiceShortcutRecovery({
      platform: "darwin",
      getTarget: () => ({ kind: "register", revision: 1, shortcut: fnA }),
      preflight,
      register: vi.fn(async () => "registered" as const),
      onFailure: vi.fn(),
      onRecovered: vi.fn()
    });

    await recovery.request();
    vi.setSystemTime(1_000);
    await recovery.request();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(preflight).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(preflight).toHaveBeenCalledTimes(2);
    recovery.dispose();
  });

  it("reports unknown preflight failures only while the target is still pending", async () => {
    const onFailure = vi.fn();
    let target: GlobalVoiceShortcutRecoveryTarget = { kind: "register", revision: 1, shortcut: fnA };
    const recovery = new GlobalVoiceShortcutRecovery({
      platform: "darwin",
      getTarget: () => target,
      preflight: async () => "unknown",
      register: vi.fn(async () => "registered" as const),
      onFailure,
      onRecovered: vi.fn()
    });

    await recovery.request();
    expect(onFailure).toHaveBeenCalledOnce();
    target = { kind: "none" };
    await recovery.request();
    expect(onFailure).toHaveBeenCalledOnce();
    recovery.dispose();
  });

  it("does not report a failed attempt after settings supersede its revision", async () => {
    let target: GlobalVoiceShortcutRecoveryTarget = { kind: "register", revision: 1, shortcut: fnA };
    let resolveRegistration: ((result: "failed") => void) | undefined;
    const onFailure = vi.fn();
    const recovery = new GlobalVoiceShortcutRecovery({
      platform: "darwin",
      getTarget: () => target,
      preflight: async () => "granted",
      register: () => new Promise((resolve) => { resolveRegistration = resolve; }),
      onFailure,
      onRecovered: vi.fn()
    });

    const running = recovery.request();
    await vi.waitFor(() => expect(resolveRegistration).toBeDefined());
    target = { kind: "register", revision: 2, shortcut: f16 };
    resolveRegistration?.("failed");
    await running;

    expect(onFailure).not.toHaveBeenCalled();
    recovery.dispose();
  });
});
