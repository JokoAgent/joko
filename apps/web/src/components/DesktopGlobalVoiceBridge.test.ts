import { describe, expect, it, vi } from "vitest";

import {
  readGlobalVoiceShortcutRegistration,
  publishGlobalVoiceShortcutRegistration,
  subscribeGlobalVoiceShortcutRegistration
} from "../global-voice-shortcut-store.js";
import {
  createDesktopGlobalVoiceGenerationRuntime,
  desktopGlobalVoiceErrorKind,
  desktopGlobalVoiceShortcutPreference,
  consumeDesktopGlobalVoiceShortcutRecoveryFailure,
  publishDesktopGlobalVoiceShortcutRecovered,
  publishDesktopGlobalVoiceShortcutRecoveryFailure,
  type DesktopGlobalVoiceMediaSessionPort
} from "./DesktopGlobalVoiceBridge.js";
import type { VoiceMediaSessionUpdate } from "../voice-input-media.js";

describe("desktop global voice bridge", () => {
  it("maps capture failures to bounded shell-safe error kinds", () => {
    expect(desktopGlobalVoiceErrorKind("unsupported")).toBe("unsupported");
    expect(desktopGlobalVoiceErrorKind("permissionDenied")).toBe("permission");
    expect(desktopGlobalVoiceErrorKind("deviceBusy")).toBe("microphone");
    expect(desktopGlobalVoiceErrorKind("captureFailed")).toBe("microphone");
    expect(desktopGlobalVoiceErrorKind("audioLimit")).toBe("service");
    expect(desktopGlobalVoiceErrorKind(undefined)).toBe("service");
  });

  it("retains the latest system registration result for a Settings surface mounted later", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGlobalVoiceShortcutRegistration(listener);
    publishGlobalVoiceShortcutRegistration({ accepted: false, reason: "in-use" });
    expect(listener).toHaveBeenCalledOnce();
    expect(readGlobalVoiceShortcutRegistration()).toEqual({ accepted: false, reason: "in-use" });
    unsubscribe();
    publishGlobalVoiceShortcutRegistration({ accepted: true, activation: "toggle" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("projects only the exact desktop shortcut contract and retains the Fn bit", () => {
    expect(desktopGlobalVoiceShortcutPreference({
      code: "KeyA",
      key: "a",
      meta: false,
      ctrl: false,
      alt: false,
      shift: false,
      fn: true
    })).toEqual({ code: "KeyA", meta: false, ctrl: false, alt: false, shift: false, fn: true });
  });

  it("projects exhausted native recovery into renderer-visible registration state", () => {
    publishGlobalVoiceShortcutRegistration({ accepted: true, activation: "hold" });
    publishDesktopGlobalVoiceShortcutRecoveryFailure();
    expect(readGlobalVoiceShortcutRegistration()).toEqual({ accepted: false, reason: "unsupported" });
  });

  it("consumes recovery failures that predate bridge mounting and publishes later recovery", async () => {
    await consumeDesktopGlobalVoiceShortcutRecoveryFailure(async () => ({ failed: true }));
    expect(readGlobalVoiceShortcutRegistration()).toEqual({ accepted: false, reason: "unsupported" });
    publishDesktopGlobalVoiceShortcutRecovered();
    expect(readGlobalVoiceShortcutRegistration()).toEqual({ accepted: true, activation: "hold" });
  });

  it("does not let a stale consumed failure overwrite a newer recovered signal", async () => {
    let resolveSnapshot: ((snapshot: { readonly failed: boolean }) => void) | undefined;
    let signalGeneration = 0;
    const capturedGeneration = signalGeneration;
    const consuming = consumeDesktopGlobalVoiceShortcutRecoveryFailure(
      () => new Promise((resolve) => { resolveSnapshot = resolve; }),
      () => capturedGeneration === signalGeneration
    );
    signalGeneration += 1;
    publishDesktopGlobalVoiceShortcutRecovered();
    resolveSnapshot?.({ failed: true });
    await consuming;
    expect(readGlobalVoiceShortcutRegistration()).toEqual({ accepted: true, activation: "hold" });
  });

  it("echoes the Main-issued generation on every status and commit", async () => {
    const fixture = generationRuntime();
    expect(fixture.runtime.handleCommand({ type: "start", generation: "7" })).toBe(true);
    await flushMicrotasks();
    const session = fixture.sessions[0]!;
    session.emit({ state: "starting" });
    session.emit(updateWithSession("listening", { draft: { text: "Draft" } }));
    expect(fixture.runtime.handleCommand({ type: "submit", generation: "6" })).toBe(false);
    expect(fixture.runtime.handleCommand({ type: "submit", generation: "7" })).toBe(true);
    await flushMicrotasks();
    expect(session.stop).toHaveBeenCalledOnce();
    session.emit(updateWithSession("submitting", { result: { text: "Final text" } }));
    session.emit(updateWithSession("done", { outcome: "completed", result: { text: "Final text" } }));
    await flushMicrotasks();
    expect(fixture.runtime.handleCommand({ type: "start", generation: "8" })).toBe(true);
    await flushMicrotasks();
    fixture.sessions[1]!.emit(updateWithSession("error", {}, "deviceBusy"));

    expect(fixture.publish.mock.calls.map(([status]) => status)).toEqual([
      { state: "starting", generation: "7" },
      { state: "listening", generation: "7", transcript: "Draft" },
      { state: "submitting", generation: "7", transcript: "Final text" },
      { state: "error", generation: "8", errorKind: "microphone" }
    ]);
    expect(fixture.commit).toHaveBeenCalledExactlyOnceWith({ generation: "7", text: "Final text" });
    expect(fixture.recordSession).toHaveBeenCalledOnce();
  });

  it("retires old updates and cancel completion without projecting them onto a newer generation", async () => {
    const fixture = generationRuntime();
    expect(fixture.runtime.handleCommand({ type: "start", generation: "1" })).toBe(true);
    await flushMicrotasks();
    const first = fixture.sessions[0]!;
    first.emit({ state: "starting" });

    expect(fixture.runtime.handleCommand({ type: "start", generation: "2" })).toBe(true);
    await flushMicrotasks();
    const second = fixture.sessions[1]!;
    second.emit({ state: "starting" });
    expect(first.cancel).toHaveBeenCalledOnce();
    first.emit(updateWithSession("error", { outcome: "failed" }, "deviceBusy"));
    first.emit(updateWithSession("done", { outcome: "completed", result: { text: "Stale result" } }));
    first.emit({ state: "cancelled" });
    first.resolveCancel();
    await flushMicrotasks();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.publish.mock.calls.map(([status]) => status)).toEqual([
      { state: "starting", generation: "1" },
      { state: "starting", generation: "2" }
    ]);

    expect(fixture.runtime.handleCommand({ type: "cancel", generation: "1" })).toBe(false);
    expect(fixture.runtime.handleCommand({ type: "cancel", generation: "2" })).toBe(true);
    expect(fixture.runtime.handleCommand({ type: "retry", generation: "3" })).toBe(true);
    await flushMicrotasks();
    const third = fixture.sessions[2]!;
    third.emit({ state: "starting" });
    second.resolveCancel();
    await flushMicrotasks();
    expect(fixture.publish).not.toHaveBeenCalledWith({ state: "idle", generation: "2" });
    expect(fixture.runtime.handleCommand({ type: "retry", generation: "3" })).toBe(false);
    expect(fixture.runtime.handleCommand({ type: "retry", generation: "2" })).toBe(false);

    expect(fixture.runtime.handleCommand({ type: "cancel", generation: "3" })).toBe(true);
    third.resolveCancel();
    await flushMicrotasks();
    expect(fixture.publish).toHaveBeenLastCalledWith({ state: "idle", generation: "3" });
  });

  it("does not let a stale commit failure publish an error for the replacement generation", async () => {
    const commitResult = deferred<boolean>();
    const fixture = generationRuntime(vi.fn(() => commitResult.promise));
    expect(fixture.runtime.handleCommand({ type: "start", generation: "10" })).toBe(true);
    await flushMicrotasks();
    fixture.sessions[0]!.emit(updateWithSession("done", {
      outcome: "completed",
      result: { text: "First result" }
    }));
    await flushMicrotasks();
    expect(fixture.commit).toHaveBeenCalledExactlyOnceWith({ generation: "10", text: "First result" });

    expect(fixture.runtime.handleCommand({ type: "retry", generation: "11" })).toBe(true);
    await flushMicrotasks();
    fixture.sessions[1]!.emit({ state: "starting" });
    commitResult.resolve(false);
    await flushMicrotasks();
    expect(fixture.publish).not.toHaveBeenCalledWith({
      state: "error",
      generation: "11",
      errorKind: "insertion"
    });
    expect(fixture.publish).not.toHaveBeenCalledWith({
      state: "error",
      generation: "10",
      errorKind: "insertion"
    });
  });
});

interface FakeMediaSession {
  readonly emit: (update: VoiceMediaSessionUpdate) => void;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly resolveCancel: () => void;
}

function generationRuntime(commit = vi.fn(async () => true)) {
  const sessions: FakeMediaSession[] = [];
  const publish = vi.fn<(status: JokoDesktopGlobalVoiceStatus) => void>();
  const recordSession = vi.fn();
  const runtime = createDesktopGlobalVoiceGenerationRuntime({
    createSession: (emit) => {
      const cancellation = deferred<void>();
      const session: FakeMediaSession = {
        emit,
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        cancel: vi.fn(() => cancellation.promise),
        dispose: vi.fn(async () => undefined),
        resolveCancel: () => cancellation.resolve(undefined)
      };
      sessions.push(session);
      return session as DesktopGlobalVoiceMediaSessionPort;
    },
    publish,
    commit,
    recordSession
  });
  return { runtime, sessions, publish, commit, recordSession };
}

function updateWithSession(
  state: VoiceMediaSessionUpdate["state"],
  session: object,
  errorCode?: "deviceBusy"
): VoiceMediaSessionUpdate {
  return {
    state,
    session,
    ...(errorCode === undefined ? {} : { error: { code: errorCode } })
  } as unknown as VoiceMediaSessionUpdate;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => { resolve = next; }), resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
