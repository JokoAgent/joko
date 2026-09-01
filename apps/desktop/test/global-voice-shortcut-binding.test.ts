import { describe, expect, it, vi } from "vitest";

import type { DesktopGlobalVoiceShortcut } from "../src/channels.js";
import { DesktopGlobalVoiceShortcutBinding } from "../src/global-voice-shortcut-binding.js";
import { DesktopGlobalShortcutRegistration } from "../src/global-voice-shortcut.js";
import {
  NativeVoiceShortcutRegistration,
  type NativeVoiceShortcutStartResult
} from "../src/native-voice-shortcut.js";

const noModifiers = Object.freeze({ meta: false, ctrl: false, alt: false, shift: false, fn: false });
const f15 = Object.freeze({ code: "F15", ...noModifiers });
const f16 = Object.freeze({ code: "F16", ...noModifiers });
const f17 = Object.freeze({ code: "F17", ...noModifiers });
const controlSpace = Object.freeze({ code: "Space", ...noModifiers, ctrl: true });
const controlV = Object.freeze({ code: "KeyV", ...noModifiers, ctrl: true });

interface PendingNativeStart {
  readonly shortcut: DesktopGlobalVoiceShortcut;
  readonly resolve: (result: NativeVoiceShortcutStartResult) => void;
}

function bindingHarness(): {
  readonly binding: DesktopGlobalVoiceShortcutBinding;
  readonly nativeRegistration: NativeVoiceShortcutRegistration;
  readonly pending: PendingNativeStart[];
  readonly registeredAccelerators: Set<string>;
  readonly blockedAccelerators: Set<string>;
  readonly nativeActive: () => DesktopGlobalVoiceShortcut | undefined;
  readonly electronTriggerCount: () => number;
  readonly triggerElectron: (accelerator: string) => boolean;
} {
  const pending: PendingNativeStart[] = [];
  const registeredAccelerators = new Set<string>();
  const blockedAccelerators = new Set<string>();
  const electronCallbacks = new Map<string, () => void>();
  let electronTriggerCount = 0;
  let nativeGeneration = 0;
  let nativeActive: DesktopGlobalVoiceShortcut | undefined;
  const nativeRegistration = new NativeVoiceShortcutRegistration({
    setShortcut: (shortcut) => {
      const generation = ++nativeGeneration;
      return new Promise((resolve) => {
        pending.push({
          shortcut,
          resolve: (result) => {
            if (generation === nativeGeneration && result.ok) nativeActive = shortcut;
            resolve(result);
          }
        });
      });
    },
    clearShortcut: () => {
      nativeGeneration += 1;
      nativeActive = undefined;
    }
  });
  const electronRegistration = new DesktopGlobalShortcutRegistration({
    isRegistered: (accelerator) => registeredAccelerators.has(accelerator),
    register: (accelerator, callback) => {
      if (blockedAccelerators.has(accelerator) || registeredAccelerators.has(accelerator)) return false;
      registeredAccelerators.add(accelerator);
      electronCallbacks.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => {
      electronCallbacks.delete(accelerator);
      registeredAccelerators.delete(accelerator);
    }
  });
  const binding = new DesktopGlobalVoiceShortcutBinding({
    platform: "darwin",
    nativeRegistration,
    electronRegistration,
    nativeTargetAvailable: (shortcut) => /^F(?:[1-9]|1\d|2[0-4])$/u.test(shortcut.code),
    nativeReservationAccelerator: (shortcut) => shortcut.code,
    electronAccelerator: (shortcut) => shortcut.code,
    onElectronTrigger: () => { electronTriggerCount += 1; },
    onNativeReservationTrigger: () => undefined
  });
  return {
    binding,
    nativeRegistration,
    pending,
    registeredAccelerators,
    blockedAccelerators,
    nativeActive: () => nativeActive,
    electronTriggerCount: () => electronTriggerCount,
    triggerElectron: (accelerator) => {
      const callback = electronCallbacks.get(accelerator);
      callback?.();
      return callback !== undefined;
    }
  };
}

async function acceptPending(harness: ReturnType<typeof bindingHarness>, index: number): Promise<void> {
  await vi.waitFor(() => expect(harness.pending[index]).toBeDefined());
  harness.pending[index]?.resolve({ ok: true });
}

describe("global voice shortcut binding transaction", () => {
  it("keeps the complete accepted binding when a queued reservation conflicts", async () => {
    const harness = bindingHarness();
    const initial = harness.binding.register(f15);
    await acceptPending(harness, 0);
    await expect(initial).resolves.toEqual({ accepted: true, activation: "hold" });

    const delayed = harness.binding.register(f16);
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2));
    harness.blockedAccelerators.add("F17");
    const conflicted = harness.binding.register(f17);
    expect(harness.pending).toHaveLength(2);

    harness.pending[1]?.resolve({ ok: true });
    await expect(delayed).resolves.toEqual({ accepted: true, activation: "hold" });
    await expect(conflicted).resolves.toEqual({ accepted: false, reason: "in-use" });

    expect(harness.binding.desiredSnapshot()).toEqual({ revision: 2, shortcut: f16 });
    expect(harness.nativeRegistration.current()).toEqual(f16);
    expect(harness.nativeActive()).toEqual(f16);
    expect(harness.registeredAccelerators).toEqual(new Set(["F16"]));
  });

  it("prevents a newer request from completing out of order", async () => {
    const harness = bindingHarness();
    const older = harness.binding.register(f16);
    const newer = harness.binding.register(f17);
    let newerSettled = false;
    void newer.finally(() => { newerSettled = true; });

    await vi.waitFor(() => expect(harness.pending).toHaveLength(1));
    expect(harness.pending[0]?.shortcut).toEqual(f16);
    expect(newerSettled).toBe(false);
    harness.pending[0]?.resolve({ ok: true });
    await expect(older).resolves.toEqual({ accepted: true, activation: "hold" });

    await vi.waitFor(() => expect(harness.pending).toHaveLength(2));
    expect(harness.pending[1]?.shortcut).toEqual(f17);
    expect(newerSettled).toBe(false);
    harness.pending[1]?.resolve({ ok: true });
    await expect(newer).resolves.toEqual({ accepted: true, activation: "hold" });
    expect(harness.binding.desiredSnapshot().shortcut).toEqual(f17);
    expect(harness.nativeRegistration.current()).toEqual(f17);
    expect(harness.registeredAccelerators).toEqual(new Set(["F17"]));
  });

  it("lets a queued disable become the final complete state", async () => {
    const harness = bindingHarness();
    const first = harness.binding.register(f16);
    const disabled = harness.binding.register("disabled");
    await acceptPending(harness, 0);
    await expect(first).resolves.toEqual({ accepted: true, activation: "hold" });
    await expect(disabled).resolves.toEqual({ accepted: true, activation: "toggle" });

    expect(harness.binding.desiredSnapshot().shortcut).toBe("disabled");
    expect(harness.nativeRegistration.current()).toBeUndefined();
    expect(harness.nativeActive()).toBeUndefined();
    expect(harness.registeredAccelerators).toEqual(new Set());
  });

  it("keeps a permission-blocked preference pending and recovers it later", async () => {
    const harness = bindingHarness();
    const initial = harness.binding.register(f15);
    await acceptPending(harness, 0);
    await initial;

    const permissionBlocked = harness.binding.register(f16);
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2));
    harness.pending[1]?.resolve({ ok: false, reason: "permission" });
    await vi.waitFor(() => expect(harness.pending).toHaveLength(3));
    harness.pending[2]?.resolve({ ok: true });
    await expect(permissionBlocked).resolves.toEqual({ accepted: false, reason: "permission" });

    const desired = harness.binding.desiredSnapshot();
    expect(desired.shortcut).toEqual(f16);
    expect(harness.nativeRegistration.current()).toBeUndefined();
    expect(harness.nativeActive()).toBeUndefined();
    expect(harness.registeredAccelerators).toEqual(new Set());

    const recovered = harness.binding.recover(f16, desired.revision, () => true);
    await vi.waitFor(() => expect(harness.pending).toHaveLength(4));
    harness.pending[3]?.resolve({ ok: true });
    await expect(recovered).resolves.toBe("registered");
    expect(harness.nativeRegistration.current()).toEqual(f16);
    expect(harness.registeredAccelerators).toEqual(new Set(["F16"]));
  });

  it("fails closed when both a native replacement and restoration fail", async () => {
    const harness = bindingHarness();
    const initial = harness.binding.register(f15);
    await acceptPending(harness, 0);
    await initial;
    const previousDesired = harness.binding.desiredSnapshot();

    const failed = harness.binding.register(f16);
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2));
    harness.pending[1]?.resolve({ ok: false, reason: "unsupported" });
    await vi.waitFor(() => expect(harness.pending).toHaveLength(3));
    harness.pending[2]?.resolve({ ok: false, reason: "unsupported" });
    await expect(failed).resolves.toEqual({ accepted: false, reason: "unsupported" });

    expect(harness.binding.desiredSnapshot()).toEqual(previousDesired);
    expect(harness.nativeRegistration.current()).toBeUndefined();
    expect(harness.nativeActive()).toBeUndefined();
    expect(harness.registeredAccelerators).toEqual(new Set());

    const recovered = harness.binding.recover(f15, previousDesired.revision, () => true);
    await vi.waitFor(() => expect(harness.pending).toHaveLength(4));
    harness.pending[3]?.resolve({ ok: true });
    await expect(recovered).resolves.toBe("registered");
    expect(harness.nativeRegistration.current()).toEqual(f15);
    expect(harness.registeredAccelerators).toEqual(new Set(["F15"]));
  });

  it("clears a dead native pair without discarding its desired recovery target", async () => {
    const harness = bindingHarness();
    const initial = harness.binding.register(f15);
    await acceptPending(harness, 0);
    await initial;
    const desired = harness.binding.desiredSnapshot();

    expect(harness.binding.invalidateNativeBinding()).toBe(true);
    expect(harness.binding.desiredSnapshot()).toEqual(desired);
    expect(harness.nativeRegistration.current()).toBeUndefined();
    expect(harness.registeredAccelerators).toEqual(new Set());

    const recovered = harness.binding.recover(f15, desired.revision, () => true);
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2));
    harness.pending[1]?.resolve({ ok: true });
    await expect(recovered).resolves.toBe("registered");
    expect(harness.nativeRegistration.current()).toEqual(f15);
    expect(harness.registeredAccelerators).toEqual(new Set(["F15"]));
  });

  it("invalidates an in-flight transaction during lifecycle cleanup", async () => {
    const harness = bindingHarness();
    const starting = harness.binding.register(f16);
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1));
    harness.binding.clear();
    harness.pending[0]?.resolve({ ok: true });

    await expect(starting).resolves.toEqual({ accepted: false, reason: "unsupported" });
    expect(harness.binding.desiredSnapshot().shortcut).toBe("disabled");
    expect(harness.nativeRegistration.current()).toBeUndefined();
    expect(harness.nativeActive()).toBeUndefined();
    expect(harness.registeredAccelerators).toEqual(new Set());
  });

  it("releases an ordinary accelerator during recording and restores it without changing desired state", async () => {
    const harness = bindingHarness();
    await expect(harness.binding.register(controlSpace)).resolves.toEqual({
      accepted: true,
      activation: "toggle"
    });
    const desired = harness.binding.desiredSnapshot();
    expect(harness.triggerElectron("Space")).toBe(true);
    expect(harness.electronTriggerCount()).toBe(1);

    await harness.binding.suspend("shortcut-recording");
    expect(harness.binding.desiredSnapshot()).toEqual(desired);
    expect(harness.registeredAccelerators).toEqual(new Set());
    expect(harness.triggerElectron("Space")).toBe(false);
    expect(harness.electronTriggerCount()).toBe(1);

    await expect(harness.binding.resume("shortcut-recording")).resolves.toBe("registered");
    expect(harness.binding.desiredSnapshot()).toEqual(desired);
    expect(harness.registeredAccelerators).toEqual(new Set(["Space"]));
    expect(harness.triggerElectron("Space")).toBe(true);
    expect(harness.electronTriggerCount()).toBe(2);
  });

  it("restores the latest accepted desired shortcut after overlapping recording suspensions", async () => {
    const harness = bindingHarness();
    await harness.binding.register(controlSpace);
    await harness.binding.suspend("application-shortcut-recording");
    await harness.binding.suspend("native-shortcut-capture");

    await expect(harness.binding.register(controlV)).resolves.toEqual({
      accepted: true,
      activation: "toggle"
    });
    expect(harness.binding.desiredSnapshot().shortcut).toEqual(controlV);
    expect(harness.registeredAccelerators).toEqual(new Set());

    await expect(harness.binding.resume("application-shortcut-recording")).resolves.toBe("superseded");
    expect(harness.registeredAccelerators).toEqual(new Set());
    await expect(harness.binding.resume("native-shortcut-capture")).resolves.toBe("registered");
    expect(harness.registeredAccelerators).toEqual(new Set(["KeyV"]));
    expect(harness.binding.desiredSnapshot().shortcut).toEqual(controlV);
  });

  it("keeps a reloaded binding suspended while another renderer is still recording", async () => {
    const harness = bindingHarness();
    await harness.binding.register(controlSpace);

    harness.binding.clear();
    await harness.binding.suspend("application-shortcut-recording");
    await expect(harness.binding.register(controlV)).resolves.toEqual({
      accepted: true,
      activation: "toggle"
    });

    expect(harness.binding.desiredSnapshot().shortcut).toEqual(controlV);
    expect(harness.registeredAccelerators).toEqual(new Set());
    await expect(harness.binding.resume("application-shortcut-recording")).resolves.toBe("registered");
    expect(harness.registeredAccelerators).toEqual(new Set(["KeyV"]));
  });
});
