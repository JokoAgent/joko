import { describe, expect, it } from "vitest";

import {
  DesktopGlobalShortcutRegistration,
  desktopGlobalVoiceAccelerator,
  isDesktopGlobalVoiceNativeCandidate,
  parseDesktopGlobalVoiceShortcut
} from "../src/global-voice-shortcut.js";

describe("global voice shortcut", () => {
  it("maps layout-independent application combinations to Electron accelerators", () => {
    expect(desktopGlobalVoiceAccelerator({ code: "Space", meta: false, ctrl: true, alt: false, shift: true, fn: false }))
      .toBe("Control+Shift+Space");
    expect(desktopGlobalVoiceAccelerator({ code: "KeyM", meta: true, ctrl: false, alt: true, shift: false, fn: false }))
      .toBe("Super+Alt+M");
    expect(desktopGlobalVoiceAccelerator({ code: "F16", meta: false, ctrl: false, alt: false, shift: false, fn: false }))
      .toBe("F16");
  });

  it("fails closed for printable bare keys and unknown codes", () => {
    expect(desktopGlobalVoiceAccelerator({ code: "KeyM", meta: false, ctrl: false, alt: false, shift: false, fn: false }))
      .toBeUndefined();
    expect(desktopGlobalVoiceAccelerator({ code: "MediaRecord", meta: false, ctrl: true, alt: false, shift: false, fn: false }))
      .toBeUndefined();
    expect(() => parseDesktopGlobalVoiceShortcut({ code: "KeyM", meta: false, ctrl: false, alt: false, shift: false, fn: false }))
      .toThrow("unsupported");
  });

  it("accepts native-only macOS bare modifier candidates without inventing an Electron accelerator", () => {
    const shortcut = { code: "MetaRight", meta: false, ctrl: false, alt: false, shift: false, fn: false };
    expect(isDesktopGlobalVoiceNativeCandidate(shortcut)).toBe(true);
    expect(desktopGlobalVoiceAccelerator(shortcut)).toBeUndefined();
    expect(parseDesktopGlobalVoiceShortcut(shortcut)).toEqual(shortcut);
    expect(isDesktopGlobalVoiceNativeCandidate({ ...shortcut, code: "ShiftRight" })).toBe(false);
    expect(isDesktopGlobalVoiceNativeCandidate({ ...shortcut, meta: true })).toBe(false);
  });

  it("accepts only the exact bounded preference shape", () => {
    expect(parseDesktopGlobalVoiceShortcut("disabled")).toBe("disabled");
    expect(parseDesktopGlobalVoiceShortcut({ code: "Space", meta: false, ctrl: true, alt: false, shift: true, fn: false }))
      .toEqual({ code: "Space", meta: false, ctrl: true, alt: false, shift: true, fn: false });
    expect(() => parseDesktopGlobalVoiceShortcut({ code: "Space", meta: false, ctrl: true, alt: false, shift: true, fn: false, extra: true }))
      .toThrow("invalid");
  });

  it("accepts macOS Fn combinations only through the native candidate path", () => {
    const shortcut = { code: "KeyA", meta: false, ctrl: false, alt: false, shift: false, fn: true };
    expect(isDesktopGlobalVoiceNativeCandidate(shortcut)).toBe(true);
    expect(desktopGlobalVoiceAccelerator(shortcut)).toBeUndefined();
    expect(parseDesktopGlobalVoiceShortcut(shortcut)).toEqual(shortcut);
  });

  it("preserves the committed accelerator when a rebind is rejected", () => {
    const registered = new Set<string>();
    const registration = new DesktopGlobalShortcutRegistration({
      isRegistered: (accelerator) => registered.has(accelerator),
      register: (accelerator) => {
        if (accelerator === "Control+Shift+Space") return false;
        registered.add(accelerator);
        return true;
      },
      unregister: (accelerator) => registered.delete(accelerator)
    });

    expect(registration.replace("F16", () => undefined)).toBe(true);
    expect(registration.replace("Control+Shift+Space", () => undefined)).toBe(false);
    expect(registration.current()).toBe("F16");
    expect(registered).toEqual(new Set(["F16"]));
  });

  it("prepares, rolls back, commits, and clears a native bare-F reservation transactionally", () => {
    const registered = new Set<string>();
    const registration = new DesktopGlobalShortcutRegistration({
      isRegistered: (accelerator) => registered.has(accelerator),
      register: (accelerator) => {
        if (registered.has(accelerator)) return false;
        registered.add(accelerator);
        return true;
      },
      unregister: (accelerator) => registered.delete(accelerator)
    });
    expect(registration.replace("F16", () => undefined)).toBe(true);

    const failed = registration.prepareReplacement("F17", () => undefined);
    expect(failed).toBeDefined();
    expect(registered).toEqual(new Set(["F16", "F17"]));
    expect(registration.current()).toBe("F16");
    failed?.rollback();
    expect(registered).toEqual(new Set(["F16"]));
    expect(registration.current()).toBe("F16");

    const accepted = registration.prepareReplacement("F17", () => undefined);
    accepted?.commit();
    expect(registered).toEqual(new Set(["F17"]));
    expect(registration.current()).toBe("F17");
    registration.clear();
    expect(registered).toEqual(new Set());
    expect(registration.current()).toBeUndefined();
  });

  it("keeps a shared prepared reservation alive when an older async attempt rolls back", () => {
    const registered = new Set<string>();
    const registration = new DesktopGlobalShortcutRegistration({
      isRegistered: (accelerator) => registered.has(accelerator),
      register: (accelerator) => {
        registered.add(accelerator);
        return true;
      },
      unregister: (accelerator) => registered.delete(accelerator)
    });
    expect(registration.replace("F16", () => undefined)).toBe(true);
    const older = registration.prepareReplacement("F17", () => undefined);
    const newer = registration.prepareReplacement("F17", () => undefined);
    older?.rollback();
    expect(registered).toEqual(new Set(["F16", "F17"]));
    newer?.commit();
    expect(registered).toEqual(new Set(["F17"]));
  });
});
