import { describe, expect, it, vi } from "vitest";

import {
  readGlobalVoiceShortcutRegistration,
  publishGlobalVoiceShortcutRegistration,
  subscribeGlobalVoiceShortcutRegistration
} from "../global-voice-shortcut-store.js";
import {
  desktopGlobalVoiceErrorKind,
  desktopGlobalVoiceShortcutPreference,
  consumeDesktopGlobalVoiceShortcutRecoveryFailure,
  publishDesktopGlobalVoiceShortcutRecovered,
  publishDesktopGlobalVoiceShortcutRecoveryFailure
} from "./DesktopGlobalVoiceBridge.js";

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
});
