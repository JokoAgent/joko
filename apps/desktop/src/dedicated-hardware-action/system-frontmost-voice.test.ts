import { describe, expect, it, vi } from "vitest";

import {
  SystemFrontmostVoiceController,
  type SystemFrontmostVoiceBackend,
  type SystemFrontmostVoiceSource
} from "./system-frontmost-voice.js";
import type {
  VoiceLeaseReleaseKind,
  VoiceLeaseSnapshot,
  VoicePressLease
} from "./voice-lease.js";
import type {
  SystemFrontmostInputRunner,
  SystemFrontmostInputTarget
} from "./system-frontmost-input.js";
import type {
  DedicatedHardwareVoiceActivationKind,
  DedicatedHardwareVoiceReleaseKind,
  DedicatedHardwareVoiceRoutedEvent
} from "./routed-actions.js";

function target(): SystemFrontmostInputTarget {
  return Object.freeze({ platform: "win32", nativeId: "42", processId: 9001 }) as SystemFrontmostInputTarget;
}

function voicePress(
  activationId = "1",
  ownerActivationId = activationId,
  activationKind: DedicatedHardwareVoiceActivationKind = "start"
): DedicatedHardwareVoiceRoutedEvent {
  return {
    kind: "button", phase: "press", action: { kind: "voice" },
    activationId, ownerActivationId, activationKind, releaseKind: null
  };
}

function voiceRelease(
  activationId = "1",
  ownerActivationId = activationId,
  activationKind: DedicatedHardwareVoiceActivationKind = "start",
  releaseKind: DedicatedHardwareVoiceReleaseKind = "tap"
): DedicatedHardwareVoiceRoutedEvent {
  return releaseKind === "cancel"
    ? {
      kind: "button", phase: "cancel", action: { kind: "voice" },
      activationId, ownerActivationId, activationKind, releaseKind
    }
    : {
      kind: "button", phase: "release", action: { kind: "voice" },
      activationId, ownerActivationId, activationKind, releaseKind
    };
}

function harness(capture: () => SystemFrontmostInputTarget = target): {
  readonly controller: SystemFrontmostVoiceController;
  readonly runner: SystemFrontmostInputRunner;
  readonly setSnapshot: (value: VoiceLeaseSnapshot<SystemFrontmostVoiceSource>) => void;
  readonly release: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly failures: unknown[];
} {
  let snapshot: VoiceLeaseSnapshot<SystemFrontmostVoiceSource> = { state: "idle" };
  let activation = 0;
  let generation = 0;
  const release = vi.fn((
    _lease: VoicePressLease<SystemFrontmostVoiceSource>,
    _kind: VoiceLeaseReleaseKind
  ) => true);
  const cancel = vi.fn(() => true);
  const backend: SystemFrontmostVoiceBackend = {
    snapshot: () => snapshot,
    press: () => {
      if (snapshot.state === "idle") {
        generation += 1;
        snapshot = { state: "recording", generation, source: "hardware" };
        return {
          accepted: true,
          effect: "start",
          lease: { source: "hardware", activation: ++activation, recordingGeneration: generation }
        };
      }
      return {
        accepted: true,
        effect: "toggle-complete",
        lease: { source: "hardware", activation: ++activation, recordingGeneration: snapshot.generation }
      };
    },
    release: (lease, kind) => release(lease, kind),
    cancelHardware: () => cancel()
  };
  const runner: SystemFrontmostInputRunner = {
    captureTarget: vi.fn(capture),
    postReturn: vi.fn(async () => undefined),
    postPaste: vi.fn(async () => undefined),
    postScroll: vi.fn(async () => undefined)
  };
  const failures: unknown[] = [];
  return {
    controller: new SystemFrontmostVoiceController(runner, backend, {
      onFailure: (error) => failures.push(error)
    }),
    runner,
    setSnapshot: (value) => { snapshot = value; },
    release,
    cancel,
    failures
  };
}

describe("SystemFrontmostVoiceController", () => {
  it("captures at press and pastes only to that recording target", async () => {
    const state = harness();
    expect(state.controller.handle(voicePress())).toBe(true);
    expect(state.controller.handle(voiceRelease())).toBe(true);
    expect(state.controller.hasTargetForActiveRecording()).toBe(true);
    await expect(state.controller.postPasteForActiveRecording()).resolves.toBe(true);
    expect(state.runner.postPaste).toHaveBeenCalledWith(expect.objectContaining({ nativeId: "42", processId: 9001 }));
  });

  it("treats an immediate release as a short tap without a late start", () => {
    const state = harness();
    expect(state.controller.handle(voicePress())).toBe(true);
    expect(state.controller.handle(voiceRelease())).toBe(true);
    expect(state.controller.hasTargetForActiveRecording()).toBe(true);
    expect(state.release).toHaveBeenCalledWith(expect.anything(), "tap");
  });

  it("does not let hardware complete or paste a shortcut-owned recording", async () => {
    const state = harness();
    state.setSnapshot({ state: "recording", generation: 7, source: "shortcut" });
    expect(state.controller.handle(voicePress())).toBe(false);
    await expect(state.controller.postPasteForActiveRecording()).resolves.toBe(false);
    expect(state.runner.captureTarget).not.toHaveBeenCalled();
    expect(state.runner.postPaste).not.toHaveBeenCalled();
  });

  it("reuses the original target for a second hardware toggle press", async () => {
    const state = harness();
    state.controller.handle(voicePress());
    state.controller.handle(voiceRelease());
    expect(state.controller.handle(voicePress("2", "1", "toggle-finish"))).toBe(true);
    expect(state.runner.captureTarget).toHaveBeenCalledTimes(1);
    expect(state.controller.handle(voiceRelease("2", "1", "toggle-finish"))).toBe(true);
    await expect(state.controller.postPasteForActiveRecording()).resolves.toBe(true);
  });

  it("cancels and retires without replaying capture or paste", async () => {
    const state = harness();
    state.controller.handle(voicePress());
    state.controller.cancel();
    expect(state.cancel).toHaveBeenCalledTimes(1);
    await expect(state.controller.postPasteForActiveRecording()).resolves.toBe(false);
  });

  it("cancels a retained short-tap recording from its exact owner activation", () => {
    const state = harness();
    state.controller.handle(voicePress());
    state.controller.handle(voiceRelease());
    expect(state.controller.handle(voiceRelease("1", "1", "start", "cancel"))).toBe(true);
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.controller.handle(voiceRelease("1", "2", "start", "cancel"))).toBe(false);
  });

  it("fails closed when target paste fails", async () => {
    const state = harness();
    vi.mocked(state.runner.postPaste).mockRejectedValueOnce(new Error("PID mismatch"));
    state.controller.handle(voicePress());
    expect(await state.controller.postPasteForActiveRecording()).toBe(false);
    expect(state.failures).toHaveLength(1);
  });

  it("consumes the Main-classified hold without measuring time again", () => {
    const state = harness();
    state.controller.handle(voicePress());
    expect(state.controller.handle(voiceRelease("1", "1", "start", "hold"))).toBe(true);
    expect(state.release).toHaveBeenCalledWith(expect.anything(), "hold");
  });

  it("rejects a completion from a different physical activation", () => {
    const state = harness();
    expect(state.controller.handle(voicePress())).toBe(true);
    expect(state.controller.handle(voiceRelease("2", "1"))).toBe(false);
    expect(state.release).not.toHaveBeenCalled();
    expect(state.controller.handle(voiceRelease())).toBe(true);
  });

  it("fails the press synchronously when atomic target capture fails", () => {
    const state = harness(() => { throw new Error("capture unavailable"); });
    expect(state.controller.handle(voicePress())).toBe(false);
    expect(state.failures).toHaveLength(1);
    expect(state.release).not.toHaveBeenCalled();
  });
});
