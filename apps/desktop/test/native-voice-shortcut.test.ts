import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NativeVoiceShortcutCaptureSubscriptions,
  NativeVoiceShortcutListener,
  NativeVoiceShortcutRegistration,
  nativeVoiceShortcutReservationAccelerator,
  nativeVoiceShortcutTarget,
  resolveNativeVoiceShortcutBinaryPath,
  type NativeVoiceShortcutStartResult
} from "../src/native-voice-shortcut.js";

const noModifiers = Object.freeze({ meta: false, ctrl: false, alt: false, shift: false, fn: false });

class FakeListenerProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function listenerHarness(
  platform: NodeJS.Platform,
  holdDelayMs = 450,
  onRestartLimitReached?: () => void
): {
  readonly listener: NativeVoiceShortcutListener;
  readonly phases: string[];
  readonly captures: Array<readonly string[]>;
  readonly mouseUps: string[];
  readonly children: FakeListenerProcess[];
  readonly arguments_: Array<readonly string[]>;
} {
  const phases: string[] = [];
  const captures: Array<readonly string[]> = [];
  const mouseUps: string[] = [];
  const children: FakeListenerProcess[] = [];
  const arguments_: Array<readonly string[]> = [];
  const listener = new NativeVoiceShortcutListener({
    platform,
    binaryPath: process.execPath,
    holdDelayMs,
    onPhase: (phase) => phases.push(phase),
    onCaptureKeys: (keys) => captures.push(keys),
    onMouseUp: () => mouseUps.push("released"),
    ...(onRestartLimitReached === undefined ? {} : { onRestartLimitReached }),
    spawnProcess: (_binary, args) => {
      arguments_.push(args);
      const child = new FakeListenerProcess();
      children.push(child);
      return child as unknown as ChildProcess;
    }
  });
  return { listener, phases, captures, mouseUps, children, arguments_ };
}

async function reportReady(
  starting: Promise<unknown>,
  child: FakeListenerProcess
): Promise<void> {
  child.stdout.write("{\"type\":\"ready\"}\n");
  await starting;
}

function childAt(children: readonly FakeListenerProcess[], index: number): FakeListenerProcess {
  const child = children[index];
  if (child === undefined) throw new Error(`Expected listener child ${index}.`);
  return child;
}

describe("native voice shortcut listener", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects native key-up handling for macOS Fn combinations and bare platform keys", () => {
    expect(nativeVoiceShortcutTarget({ code: "KeyA", ...noModifiers, fn: true }, "darwin"))
      .toMatchObject({ code: "KeyA", helperKey: "KeyA" });
    expect(nativeVoiceShortcutTarget({ code: "F24", ...noModifiers }, "darwin"))
      .toMatchObject({ code: "F24", helperKey: "F24" });
    expect(nativeVoiceShortcutTarget({ code: "MetaRight", ...noModifiers }, "darwin"))
      .toMatchObject({ code: "MetaRight", helperKey: "MetaRight" });
    expect(nativeVoiceShortcutTarget({ code: "F24", ...noModifiers }, "win32"))
      .toMatchObject({ code: "F24", helperKey: "F24" });
    expect(nativeVoiceShortcutTarget({ code: "KeyA", ...noModifiers, fn: true }, "win32"))
      .toBeUndefined();
  });

  it("reserves only macOS bare function keys through Electron", () => {
    expect(nativeVoiceShortcutReservationAccelerator({ code: "F16", ...noModifiers }, "darwin")).toBe("F16");
    expect(nativeVoiceShortcutReservationAccelerator({ code: "F16", ...noModifiers }, "win32")).toBeUndefined();
    expect(nativeVoiceShortcutReservationAccelerator({ code: "KeyA", ...noModifiers, fn: true }, "darwin"))
      .toBeUndefined();
  });

  it("matches the exact macOS Fn key set and produces tap and hold phases", async () => {
    vi.useFakeTimers();
    const harness = listenerHarness("darwin");
    const shortcut = { code: "KeyA", ...noModifiers, fn: true };
    const starting = harness.listener.setShortcut(shortcut);
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);

    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\"]}\n");
    expect(harness.phases).toEqual(["start", "tap"]);

    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    await vi.advanceTimersByTimeAsync(450);
    child.stdout.write("{\"type\":\"keys\",\"keys\":[] }\n");
    expect(harness.phases).toEqual(["start", "tap", "start", "end"]);
    harness.listener.dispose();
  });

  it("owns a bounded macOS mouse-up lease without requiring a voice shortcut", async () => {
    const harness = listenerHarness("darwin");
    const armed = harness.listener.armSessionDragRelease();
    const child = childAt(harness.children, 0);
    await reportReady(armed, child);

    child.stdout.write("{\"type\":\"mouse-up\"}\n");
    child.stdout.write("{\"type\":\"mouse-up\"}\n");
    expect(harness.mouseUps).toEqual(["released"]);
    expect(child.killed).toBe(true);
  });

  it("keeps voice observation alive after consuming one mouse-up lease", async () => {
    const harness = listenerHarness("darwin");
    const shortcut = { code: "KeyA", ...noModifiers, fn: true };
    const starting = harness.listener.setShortcut(shortcut);
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    await expect(harness.listener.armSessionDragRelease()).resolves.toEqual({ ok: true });

    child.stdout.write("{\"type\":\"mouse-up\"}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[]}\n");
    expect(harness.mouseUps).toEqual(["released"]);
    expect(harness.phases).toEqual(["start", "tap"]);
    expect(child.killed).toBe(false);
    harness.listener.dispose();
  });

  it("fails a mouse-up lease closed on permission denial or explicit disarm", async () => {
    const denied = listenerHarness("darwin");
    const deniedStart = denied.listener.armSessionDragRelease();
    childAt(denied.children, 0).stdout.write("{\"type\":\"error\",\"code\":\"permission\"}\n");
    await expect(deniedStart).resolves.toEqual({ ok: false, reason: "permission" });
    expect(denied.mouseUps).toEqual([]);

    const disarmed = listenerHarness("darwin");
    const pending = disarmed.listener.armSessionDragRelease();
    const child = childAt(disarmed.children, 0);
    disarmed.listener.disarmSessionDragRelease();
    child.emit("exit", 0, null);
    await expect(pending).resolves.toMatchObject({ ok: false, superseded: true });
    child.stdout.write("{\"type\":\"mouse-up\"}\n");
    expect(disarmed.mouseUps).toEqual([]);
  });

  it("rejects a mouse-up payload with unbounded protocol fields", async () => {
    vi.useFakeTimers();
    const harness = listenerHarness("darwin");
    const starting = harness.listener.armSessionDragRelease();
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    child.stdout.write("{\"type\":\"mouse-up\",\"sessionId\":\"renderer-data\"}\n");

    expect(harness.mouseUps).toEqual([]);
    expect(child.killed).toBe(true);
    harness.listener.disarmSessionDragRelease();
  });

  it("matches Fn plus a function key and every configured modifier exactly", async () => {
    const harness = listenerHarness("darwin");
    const starting = harness.listener.setShortcut({
      code: "F12",
      meta: false,
      ctrl: true,
      alt: false,
      shift: false,
      fn: true
    });
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);

    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"F12\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"ControlRight\",\"F12\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"ControlRight\"]}\n");
    expect(harness.phases).toEqual(["start", "tap"]);
    harness.listener.dispose();
  });

  it("releases a held macOS shortcut when the helper emits a reset snapshot", async () => {
    vi.useFakeTimers();
    const harness = listenerHarness("darwin");
    const starting = harness.listener.setShortcut({ code: "KeyA", ...noModifiers, fn: true });
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    await vi.advanceTimersByTimeAsync(450);
    child.stdout.write("{\"type\":\"keys\",\"keys\":[]}\n");
    expect(harness.phases).toEqual(["start", "end"]);
    harness.listener.dispose();
  });

  it("allows the physical Fn flag for a bare macOS function key only", async () => {
    const harness = listenerHarness("darwin");
    const starting = harness.listener.setShortcut({ code: "F16", ...noModifiers });
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);

    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"F16\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"ShiftLeft\",\"F16\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[]}\n");
    expect(harness.phases).toEqual(["start", "tap"]);
    harness.listener.dispose();
  });

  it("ends a broken native combination and waits for the target's real release", async () => {
    const harness = listenerHarness("darwin");
    const starting = harness.listener.setShortcut({ code: "KeyA", ...noModifiers, fn: true });
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\",\"Other\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[] }\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    child.stdout.write("{\"type\":\"keys\",\"keys\":[] }\n");
    expect(harness.phases).toEqual(["start", "end", "start", "tap"]);
    harness.listener.dispose();
  });

  it("uses the Windows helper protocol for bare F1-F24 and closes on helper crash", async () => {
    vi.useFakeTimers();
    const harness = listenerHarness("win32");
    const starting = harness.listener.setShortcut({ code: "F16", ...noModifiers });
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    expect(harness.arguments_).toEqual([["F16"]]);
    child.stdout.write("{\"type\":\"pressed\",\"pressed\":true}\n");
    child.emit("exit", 1, null);
    expect(harness.phases).toEqual(["start", "end"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.children).toHaveLength(2);
    harness.listener.dispose();
  });

  it("restores F16 before rejecting a failed Windows rebind to F17", async () => {
    const harness = listenerHarness("win32");
    const registration = new NativeVoiceShortcutRegistration(harness.listener);
    const f16 = { code: "F16", ...noModifiers };
    const first = registration.replace(f16);
    await reportReady(first, childAt(harness.children, 0));

    const failedRebind = registration.replace({ code: "F17", ...noModifiers });
    childAt(harness.children, 1).stdout.write("{\"type\":\"error\",\"code\":\"startup\"}\n");
    await vi.waitFor(() => expect(harness.children).toHaveLength(3));
    childAt(harness.children, 2).stdout.write("{\"type\":\"ready\"}\n");

    expect(await failedRebind).toEqual({ ok: false, reason: "unsupported" });
    expect(registration.current()).toEqual(f16);
    expect(harness.arguments_).toEqual([["F16"], ["F17"], ["F16"]]);
    childAt(harness.children, 2).stdout.write("{\"type\":\"pressed\",\"pressed\":true}\n");
    childAt(harness.children, 2).stdout.write("{\"type\":\"pressed\",\"pressed\":false}\n");
    expect(harness.phases).toEqual(["start", "tap"]);
    registration.clear();
  });

  it("reports when a failed Windows rebind cannot restore the prior listener", async () => {
    const harness = listenerHarness("win32");
    const registration = new NativeVoiceShortcutRegistration(harness.listener);
    const first = registration.replace({ code: "F16", ...noModifiers });
    await reportReady(first, childAt(harness.children, 0));

    const failedRebind = registration.replace({ code: "F17", ...noModifiers });
    childAt(harness.children, 1).stdout.write("{\"type\":\"error\",\"code\":\"startup\"}\n");
    await vi.waitFor(() => expect(harness.children).toHaveLength(3));
    childAt(harness.children, 2).stdout.write("{\"type\":\"error\",\"code\":\"startup\"}\n");

    await expect(failedRebind).resolves.toEqual({
      ok: false,
      reason: "unsupported",
      restorationFailed: true
    });
    expect(registration.current()).toBeUndefined();
    registration.clear();
  });

  it("lets a newer asynchronous native rebind supersede an older one", async () => {
    const harness = listenerHarness("win32");
    const registration = new NativeVoiceShortcutRegistration(harness.listener);
    const first = registration.replace({ code: "F16", ...noModifiers });
    await reportReady(first, childAt(harness.children, 0));

    const older = registration.replace({ code: "F17", ...noModifiers });
    const newer = registration.replace({ code: "F18", ...noModifiers });
    childAt(harness.children, 1).emit("exit", 1, null);
    childAt(harness.children, 2).stdout.write("{\"type\":\"ready\"}\n");

    expect(await older).toEqual({ ok: false, reason: "unsupported", superseded: true });
    expect(await newer).toEqual({ ok: true });
    expect(registration.current()).toEqual({ code: "F18", ...noModifiers });
    childAt(harness.children, 2).stdout.write("{\"type\":\"pressed\",\"pressed\":true}\n");
    childAt(harness.children, 2).stdout.write("{\"type\":\"pressed\",\"pressed\":false}\n");
    expect(harness.phases).toEqual(["start", "tap"]);
    registration.clear();
  });

  it("invalidates the committed shortcut after bounded restart recovery is exhausted", async () => {
    vi.useFakeTimers();
    let registration: NativeVoiceShortcutRegistration | undefined;
    const onRestartLimitReached = vi.fn(() => registration?.invalidate());
    const harness = listenerHarness("win32", 450, onRestartLimitReached);
    registration = new NativeVoiceShortcutRegistration(harness.listener);
    const first = registration.replace({ code: "F16", ...noModifiers });
    await reportReady(first, childAt(harness.children, 0));

    childAt(harness.children, 0).emit("exit", 1, null);
    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      const child = childAt(harness.children, harness.children.length - 1);
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(onRestartLimitReached).toHaveBeenCalledOnce();
    expect(registration.current()).toBeUndefined();
    const childCount = harness.children.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.children).toHaveLength(childCount);
    registration.clear();
  });

  it("does not let a superseded capture start stop the latest capture process", async () => {
    const harness = listenerHarness("darwin");
    const older = harness.listener.startCapture();
    harness.listener.stopCapture();
    const newer = harness.listener.startCapture();
    childAt(harness.children, 0).emit("exit", 1, null);
    childAt(harness.children, 1).stdout.write("{\"type\":\"ready\"}\n");

    expect(await older).toEqual({ ok: false, reason: "unsupported", superseded: true });
    expect(await newer).toEqual({ ok: true });
    expect(harness.listener.isReady()).toBe(true);
    childAt(harness.children, 1).stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\"]}\n");
    expect(harness.captures).toEqual([[], ["Fn", "KeyA"]]);
    harness.listener.dispose();
  });

  it("shares one capture lifetime across concurrent renderer subscribers", async () => {
    let resolveStart: ((result: NativeVoiceShortcutStartResult) => void) | undefined;
    const startCapture = vi.fn(() => new Promise<NativeVoiceShortcutStartResult>((resolve) => {
      resolveStart = resolve;
    }));
    const stopCapture = vi.fn();
    const beforeStart = vi.fn(async () => undefined);
    const afterStop = vi.fn();
    const subscriptions = new NativeVoiceShortcutCaptureSubscriptions<number>(
      { startCapture, stopCapture },
      { beforeStart, afterStop }
    );

    const first = subscriptions.start(7);
    const second = subscriptions.start(8);
    await vi.waitFor(() => expect(startCapture).toHaveBeenCalledOnce());
    expect(beforeStart).toHaveBeenCalledOnce();
    expect(subscriptions.subscribers()).toEqual([7, 8]);
    resolveStart?.({ ok: true });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(subscriptions.stop(7)).toBe(false);
    expect(stopCapture).not.toHaveBeenCalled();
    expect(afterStop).not.toHaveBeenCalled();
    expect(subscriptions.subscribers()).toEqual([8]);
    expect(subscriptions.stop(8)).toBe(true);
    expect(stopCapture).toHaveBeenCalledOnce();
    expect(afterStop).toHaveBeenCalledOnce();
  });

  it("does not let a stopped shared start tear down a same-renderer replacement", async () => {
    const starts: Array<(result: NativeVoiceShortcutStartResult) => void> = [];
    const stopCapture = vi.fn();
    const afterStop = vi.fn();
    const subscriptions = new NativeVoiceShortcutCaptureSubscriptions<number>({
      startCapture: () => new Promise((resolve) => { starts.push(resolve); }),
      stopCapture
    }, {
      beforeStart: async () => undefined,
      afterStop
    });

    const first = subscriptions.start(7);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(subscriptions.stop(7)).toBe(true);
    const second = subscriptions.start(7);
    await vi.waitFor(() => expect(starts).toHaveLength(2));

    starts[0]?.({ ok: false, reason: "unsupported", superseded: true });
    await expect(first).resolves.toBe(false);
    expect(subscriptions.subscribers()).toEqual([7]);
    starts[1]?.({ ok: true });
    await expect(second).resolves.toBe(true);
    expect(subscriptions.subscribers()).toEqual([7]);
    expect(stopCapture).toHaveBeenCalledOnce();
    expect(afterStop).toHaveBeenCalledOnce();

    subscriptions.stop(7);
    expect(stopCapture).toHaveBeenCalledTimes(2);
    expect(afterStop).toHaveBeenCalledTimes(2);
  });

  it("reports a shared capture failure to every pending subscriber", async () => {
    let resolveStart: ((result: NativeVoiceShortcutStartResult) => void) | undefined;
    const stopCapture = vi.fn();
    const afterStop = vi.fn();
    const subscriptions = new NativeVoiceShortcutCaptureSubscriptions<number>({
      startCapture: () => new Promise((resolve) => { resolveStart = resolve; }),
      stopCapture
    }, {
      beforeStart: async () => undefined,
      afterStop
    });

    const first = subscriptions.start(7);
    const second = subscriptions.start(8);
    await vi.waitFor(() => expect(resolveStart).toBeDefined());
    resolveStart?.({ ok: false, reason: "permission" });

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(subscriptions.subscribers()).toEqual([]);
    expect(stopCapture).toHaveBeenCalledOnce();
    expect(afterStop).toHaveBeenCalledOnce();
  });

  it("fails closed and restarts after malformed helper output", async () => {
    vi.useFakeTimers();
    const harness = listenerHarness("win32");
    const starting = harness.listener.setShortcut({ code: "F16", ...noModifiers });
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    child.stdout.write("{\"type\":\"pressed\",\"pressed\":true}\n");
    child.stdout.write("not-json\n");
    expect(child.killed).toBe(true);
    expect(harness.phases).toEqual(["start", "end"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.children).toHaveLength(2);
    harness.listener.dispose();
  });

  it("bounds unterminated helper output and restarts the listener", async () => {
    vi.useFakeTimers();
    const harness = listenerHarness("win32");
    const starting = harness.listener.setShortcut({ code: "F16", ...noModifiers });
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    child.stdout.write("x".repeat(64 * 1024 + 1));
    expect(child.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.children).toHaveLength(2);
    harness.listener.dispose();
  });

  it("forwards only bounded helper keys during explicit capture", async () => {
    const harness = listenerHarness("darwin");
    const starting = harness.listener.startCapture();
    const child = childAt(harness.children, 0);
    await reportReady(starting, child);
    child.stdout.write("{\"type\":\"keys\",\"keys\":[\"Fn\",\"KeyA\",\"Other\"]}\n");
    expect(harness.captures).toEqual([["Fn", "KeyA", "Other"]]);
    harness.listener.stopCapture();
    expect(child.killed).toBe(true);
  });

  it("resolves development and packaged helper locations deterministically", () => {
    expect(resolveNativeVoiceShortcutBinaryPath({
      packaged: false,
      platform: "win32",
      resourcesPath: "R:\\resources",
      sourceDirectory: "D:\\app\\dist"
    })).toBe(join("D:\\app\\dist", "native-voice-shortcut", "joko-windows-function-key-listener.exe"));
    expect(resolveNativeVoiceShortcutBinaryPath({
      packaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Joko.app/Contents/Resources",
      sourceDirectory: "/workspace/dist"
    })).toBe(join("/Applications/Joko.app/Contents/Resources", "native-voice-shortcut", "joko-macos-key-listener"));
  });
});
