import { describe, expect, it, vi } from "vitest";

import {
  APP_SHORTCUT_DEFINITION_LIST,
  APP_SHORTCUT_IDS,
  SWITCH_SESSION_SHORTCUT_IDS,
  appShortcutCombosEqual,
  appShortcutScopesOverlap,
  comboToElectronAccelerator,
  createAppShortcutComboFromEvent,
  effectiveAppShortcutCombos,
  eventMatchesAppShortcut,
  findAppShortcutConflict,
  formatAppShortcutCombo,
  isAppShortcutComboBindable,
  isAppShortcutAvailableOnPlatform,
  normalizeAppShortcutOverrides,
  validateAppShortcutCombo,
  visibleAppShortcutDefinitions,
  withAppShortcutOverride,
  type AppShortcutCombo,
  type AppShortcutId
} from "./app-shortcuts.js";
import { createAppShortcutKeydownListener } from "./use-app-shortcut.js";
import { acquireStartupUpdateInteractionBarrier } from "./startup-update-interaction.js";

const ctrlF: AppShortcutCombo = { code: "KeyF", meta: false, ctrl: true, alt: false, shift: false };
const ctrlG: AppShortcutCombo = { code: "KeyG", meta: false, ctrl: true, alt: false, shift: false };

describe("application shortcut registry", () => {
  it("registers every executable action and only excludes the documented server-local terminal action", () => {
    expect(APP_SHORTCUT_IDS).toHaveLength(26);
    expect(APP_SHORTCUT_DEFINITION_LIST.map((definition) => definition.id)).toEqual(APP_SHORTCUT_IDS);
    expect(APP_SHORTCUT_DEFINITION_LIST.map((definition) => definition.id)).not.toContain("open-terminal");
    expect(SWITCH_SESSION_SHORTCUT_IDS).toHaveLength(9);
  });

  it("keeps platform defaults and exact physical-key matching", () => {
    expect(effectiveAppShortcutCombos("new-maker", {}, "win32")).toEqual([
      { code: "KeyN", meta: false, ctrl: true, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("toggle-sidebar", {}, "darwin")).toEqual([
      { code: "KeyB", meta: true, ctrl: false, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("cycle-permission-mode", {}, "linux")).toEqual([
      { code: "Tab", meta: false, ctrl: false, alt: false, shift: true }
    ]);
    expect(effectiveAppShortcutCombos("right-tab-prev", {}, "darwin")).toEqual([
      { code: "BracketLeft", meta: true, ctrl: false, alt: false, shift: true },
      { code: "Tab", meta: false, ctrl: true, alt: false, shift: true }
    ]);
    expect(effectiveAppShortcutCombos("right-tab-next", {}, "win32")).toEqual([
      { code: "PageDown", meta: false, ctrl: true, alt: false, shift: false },
      { code: "Tab", meta: false, ctrl: true, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("find-in-page", {}, "win32")).toEqual([ctrlF]);
    expect(effectiveAppShortcutCombos("find-in-page", {}, "darwin")).toEqual([
      { code: "KeyF", meta: true, ctrl: false, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("search-in-project", {}, "linux")).toEqual([
      { code: "KeyF", meta: false, ctrl: true, alt: false, shift: true }
    ]);
    expect(effectiveAppShortcutCombos("save-file", {}, "win32")).toEqual([
      { code: "KeyS", meta: false, ctrl: true, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("zoom-in", {}, "linux")).toEqual([
      { code: "Equal", meta: false, ctrl: true, alt: false, shift: false },
      { code: "Equal", meta: false, ctrl: true, alt: false, shift: true },
      { code: "NumpadAdd", meta: false, ctrl: true, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("zoom-out", {}, "win32")).toEqual([
      { code: "Minus", meta: false, ctrl: true, alt: false, shift: false },
      { code: "NumpadSubtract", meta: false, ctrl: true, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("zoom-reset", {}, "darwin")).toEqual([]);
    expect(effectiveAppShortcutCombos("browser-focus-url", {}, "win32")).toEqual([
      { code: "KeyL", meta: false, ctrl: true, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("browser-back", {}, "win32")).toEqual([
      { code: "ArrowLeft", meta: false, ctrl: false, alt: true, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("browser-forward", {}, "darwin")).toEqual([
      { code: "ArrowRight", meta: false, ctrl: false, alt: true, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("browser-reload", {}, "linux")).toEqual([
      { code: "KeyR", meta: false, ctrl: true, alt: false, shift: false },
      { code: "F5", meta: false, ctrl: false, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("switch-session-9", {}, "darwin")).toEqual([
      { code: "Digit9", meta: true, ctrl: false, alt: false, shift: false }
    ]);
    expect(eventMatchesAppShortcut("find-in-page", keyEvent(), {}, "win32")).toBe(true);
    expect(eventMatchesAppShortcut("find-in-page", keyEvent({ code: "KeyG" }), {}, "win32")).toBe(false);
  });

  it("converts only safely representable physical keys to Electron accelerators", () => {
    expect(comboToElectronAccelerator(
      { code: "KeyB", meta: true, ctrl: false, alt: false, shift: false },
      "darwin"
    )).toBe("Command+B");
    expect(comboToElectronAccelerator(
      { code: "Equal", meta: true, ctrl: false, alt: false, shift: true },
      "darwin"
    )).toBe("Shift+Command+=");
    expect(comboToElectronAccelerator(
      { code: "ArrowLeft", meta: false, ctrl: false, alt: true, shift: false },
      "win32"
    )).toBe("Alt+Left");
    expect(comboToElectronAccelerator(
      { code: "NumpadAdd", meta: false, ctrl: true, alt: false, shift: false },
      "win32"
    )).toBeNull();
  });

  it("keeps platform availability and the settings surface aligned with executable definitions", () => {
    expect(APP_SHORTCUT_DEFINITION_LIST.find((definition) => definition.id === "new-maker")?.menuBacked).toBe(true);
    expect(APP_SHORTCUT_DEFINITION_LIST.find((definition) => definition.id === "open-settings")?.menuBacked).toBe(true);
    expect(APP_SHORTCUT_DEFINITION_LIST.find((definition) => definition.id === "toggle-sidebar")?.menuBacked).toBeUndefined();
    expect(isAppShortcutAvailableOnPlatform("open-settings", "darwin")).toBe(true);
    expect(isAppShortcutAvailableOnPlatform("open-settings", "win32")).toBe(false);
    expect(isAppShortcutAvailableOnPlatform("zoom-in", "darwin")).toBe(false);
    expect(isAppShortcutAvailableOnPlatform("zoom-in", "linux")).toBe(true);
    expect(effectiveAppShortcutCombos("open-settings", {}, "darwin")).toEqual([
      { code: "Comma", meta: true, ctrl: false, alt: false, shift: false }
    ]);
    expect(effectiveAppShortcutCombos("open-settings", {}, "win32")).toEqual([]);
    const commandJ = { code: "KeyJ", meta: true, ctrl: false, alt: false, shift: false };
    expect(effectiveAppShortcutCombos(
      "open-settings",
      withAppShortcutOverride({}, "open-settings", commandJ, "darwin"),
      "darwin"
    )).toEqual([commandJ]);

    const visible = visibleAppShortcutDefinitions("linux");
    expect(visible.map((definition) => definition.id)).toEqual([
      "new-maker",
      "toggle-sidebar",
      "cycle-permission-mode",
      "right-tab-prev",
      "right-tab-next",
      "find-in-page",
      "search-in-project",
      "zoom-in",
      "zoom-out",
      "zoom-reset",
      "browser-focus-url",
      "browser-back",
      "browser-forward",
      "browser-reload"
    ]);
    expect(visibleAppShortcutDefinitions("darwin").map((definition) => definition.id)).toEqual([
      "new-maker",
      "toggle-sidebar",
      "cycle-permission-mode",
      "right-tab-prev",
      "right-tab-next",
      "find-in-page",
      "search-in-project",
      "browser-focus-url",
      "browser-back",
      "browser-forward",
      "browser-reload"
    ]);
  });

  it("rejects Darwin menu-backed bindings that Electron cannot express", () => {
    const numpad = { code: "NumpadAdd", meta: true, ctrl: false, alt: false, shift: false };
    expect(validateAppShortcutCombo("new-maker", numpad, {}, "darwin")).toEqual({ kind: "menu-inexpressible" });
    expect(validateAppShortcutCombo("toggle-sidebar", numpad, {}, "darwin")).toBeNull();
    expect(() => withAppShortcutOverride({}, "new-maker", numpad, "darwin")).toThrow(
      "cannot be expressed as a macOS menu accelerator"
    );
  });

  it("rebinds, disables, and restores each action without mutating the previous preference snapshot", () => {
    const rebound = withAppShortcutOverride({}, "find-in-page", ctrlG);
    expect(eventMatchesAppShortcut("find-in-page", keyEvent(), rebound, "win32")).toBe(false);
    expect(eventMatchesAppShortcut("find-in-page", keyEvent({ code: "KeyG" }), rebound, "win32")).toBe(true);

    const disabled = withAppShortcutOverride(rebound, "find-in-page", null);
    expect(effectiveAppShortcutCombos("find-in-page", disabled, "win32")).toEqual([]);
    expect(rebound["find-in-page"]).toEqual(ctrlG);

    const restored = withAppShortcutOverride(disabled, "find-in-page", undefined);
    expect(effectiveAppShortcutCombos("find-in-page", restored, "win32")).toEqual([ctrlF]);
  });

  it.each(APP_SHORTCUT_DEFINITION_LIST
    .filter((definition) => definition.rebindable && isAppShortcutAvailableOnPlatform(definition.id, "win32"))
    .map((definition) => definition.id))(
    "supports rebind and explicit disable for %s",
    (id: AppShortcutId) => {
      const combo = { code: "KeyG", meta: false, ctrl: true, alt: true, shift: false };
      const rebound = withAppShortcutOverride({}, id, combo, "win32");
      expect(effectiveAppShortcutCombos(id, rebound, "win32")).toEqual([combo]);
      expect(effectiveAppShortcutCombos(id, withAppShortcutOverride(rebound, id, null, "win32"), "win32")).toEqual([]);
    }
  );

  it("keeps close non-rebindable and lets explicit user bindings claim numbered session defaults", () => {
    expect(() => withAppShortcutOverride({}, "close-tab-or-window", ctrlG, "win32")).toThrow(
      "The application shortcut cannot be changed on this platform."
    );
    expect(normalizeAppShortcutOverrides({ "close-tab-or-window": null }, "win32")).toEqual({});

    const ctrlOne = { code: "Digit1", meta: false, ctrl: true, alt: false, shift: false };
    const overrides = withAppShortcutOverride({}, "find-in-page", ctrlOne, "win32");
    expect(findAppShortcutConflict("find-in-page", ctrlOne, {}, "win32")).toBeNull();
    expect(effectiveAppShortcutCombos("switch-session-1", overrides, "win32")).toEqual([]);
    expect(effectiveAppShortcutCombos("find-in-page", overrides, "win32")).toEqual([ctrlOne]);
  });

  it("models overlapping shortcut scopes", () => {
    expect(appShortcutScopesOverlap("app", "browser")).toBe(true);
    expect(appShortcutScopesOverlap("browser", "workdir-doc")).toBe(true);
    expect(appShortcutScopesOverlap("composer", "workdir-doc")).toBe(true);
    expect(appShortcutScopesOverlap("browser", "composer")).toBe(false);
  });

  it("rejects already-owned, repeated, and composing events before handlers run", () => {
    for (const blocked of [
      keyEvent({ defaultPrevented: true }),
      keyEvent({ repeat: true }),
      keyEvent({ isComposing: true })
    ]) {
      expect(eventMatchesAppShortcut("find-in-page", blocked, {}, "win32")).toBe(false);
    }
  });

  it("hot-updates one mounted capture listener and only consumes accepted handlers", () => {
    let combos: readonly AppShortcutCombo[] = [ctrlF];
    let accepted = true;
    let recording = false;
    const handler = vi.fn(() => accepted);
    const listener = createAppShortcutKeydownListener({
      getCombos: () => combos,
      getHandler: () => handler,
      isRecording: () => recording,
      stopImmediate: true
    });

    const original = spyKeyEvent();
    listener(original.event);
    expect(handler).toHaveBeenCalledOnce();
    expect(original.preventDefault).toHaveBeenCalledOnce();
    expect(original.stopPropagation).toHaveBeenCalledOnce();
    expect(original.stopImmediatePropagation).toHaveBeenCalledOnce();

    combos = [ctrlG];
    listener(spyKeyEvent().event);
    expect(handler).toHaveBeenCalledOnce();
    const rebound = spyKeyEvent({ code: "KeyG" });
    listener(rebound.event);
    expect(handler).toHaveBeenCalledTimes(2);

    accepted = false;
    const yielded = spyKeyEvent({ code: "KeyG" });
    listener(yielded.event);
    expect(yielded.preventDefault).not.toHaveBeenCalled();
    recording = true;
    listener(spyKeyEvent({ code: "KeyG" }).event);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("does not run Ctrl/Cmd+N renderer actions while startup update owns interaction", () => {
    const handler = vi.fn(() => true);
    const listener = createAppShortcutKeydownListener({
      getCombos: () => [
        { code: "KeyN", meta: false, ctrl: true, alt: false, shift: false },
        { code: "KeyN", meta: true, ctrl: false, alt: false, shift: false }
      ],
      getHandler: () => handler
    });
    const release = acquireStartupUpdateInteractionBarrier();
    try {
      listener(spyKeyEvent({ code: "KeyN", ctrlKey: true }).event);
      listener(spyKeyEvent({ code: "KeyN", ctrlKey: false, metaKey: true }).event);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      release();
    }
    listener(spyKeyEvent({ code: "KeyN", ctrlKey: true }).event);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("drops unknown and invalid persisted entries while preserving null disable", () => {
    expect(normalizeAppShortcutOverrides({
      "find-in-page": null,
      "search-in-project": { code: "KeyP", ctrl: 1, alt: false, meta: false, shift: true },
      "save-file": { code: "MetaLeft", meta: true },
      "close-tab-or-window": ctrlG,
      "open-settings": null,
      "zoom-in": { code: "KeyW", ctrl: true },
      "provider-only": ctrlG
    }, "win32")).toEqual({
      "find-in-page": null,
      "search-in-project": { code: "KeyP", ctrl: true, alt: false, meta: false, shift: true }
    });
    expect(normalizeAppShortcutOverrides({
      "new-maker": { code: "KeyJ", meta: false, ctrl: false, alt: false, shift: false },
      "toggle-sidebar": { code: "KeyJ", meta: false, ctrl: false, alt: false, shift: true }
    }, "darwin")).toEqual({});
    expect(() => withAppShortcutOverride({}, "new-maker", {
      code: "KeyJ", meta: false, ctrl: false, alt: false, shift: false
    }, "darwin")).toThrow("combination is invalid");
  });

  it("formats recorded physical keys for macOS and other platforms", () => {
    const combo = { code: "KeyP", key: "p", meta: true, ctrl: false, alt: true, shift: true };
    expect(formatAppShortcutCombo(combo, "darwin")).toBe("⌥⇧⌘P");
    expect(formatAppShortcutCombo(combo, "win32")).toBe("Alt+Shift+Meta+P");
    expect(formatAppShortcutCombo({ ...ctrlF, code: "ArrowDown" }, "linux")).toBe("Ctrl+↓");
  });

  it("waits on pure modifiers and enforces the bare-key binding rule", () => {
    expect(createAppShortcutComboFromEvent(recordedEvent({ code: "ControlLeft", key: "Control", ctrlKey: true }))).toBeNull();
    expect(isAppShortcutComboBindable({ code: "KeyQ", key: "q", meta: false, ctrl: false, alt: false, shift: false })).toBe(false);
    expect(isAppShortcutComboBindable({ code: "F12", key: "F12", meta: false, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isAppShortcutComboBindable({ code: "Tab", key: "Tab", meta: false, ctrl: false, alt: false, shift: true })).toBe(true);
    expect(isAppShortcutComboBindable({ code: "KeyQ", key: "Q", meta: false, ctrl: false, alt: false, shift: true })).toBe(false);
  });

  it("rejects system-reserved and conflicting combinations before persistence", () => {
    const ctrlSpace = { code: "Space", key: " ", meta: false, ctrl: true, alt: false, shift: false };
    expect(validateAppShortcutCombo("find-in-page", ctrlSpace, {}, "win32")).toEqual({ kind: "system-reserved" });
    const commandQ = { code: "KeyQ", key: "q", meta: true, ctrl: false, alt: false, shift: false };
    expect(validateAppShortcutCombo("find-in-page", commandQ, {}, "darwin")).toEqual({ kind: "system-reserved" });

    const ctrlShiftF = { code: "KeyF", key: "f", meta: false, ctrl: true, alt: false, shift: true };
    expect(findAppShortcutConflict("find-in-page", ctrlShiftF, {}, "win32")).toBe("search-in-project");
    expect(validateAppShortcutCombo("find-in-page", ctrlShiftF, {}, "win32")).toEqual({
      kind: "conflict",
      conflictingId: "search-in-project"
    });
    expect(validateAppShortcutCombo("find-in-page", ctrlG, {}, "win32")).toBeNull();
    expect(appShortcutCombosEqual(ctrlG, { ...ctrlG })).toBe(true);
  });
});

function keyEvent(overrides: Partial<Pick<KeyboardEvent,
  "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented"
>> = {}) {
  return {
    code: "KeyF",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...overrides
  };
}

function spyKeyEvent(overrides: Parameters<typeof keyEvent>[0] = {}) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const stopImmediatePropagation = vi.fn();
  return {
    event: {
      ...keyEvent(overrides),
      preventDefault,
      stopPropagation,
      stopImmediatePropagation
    } as unknown as KeyboardEvent,
    preventDefault,
    stopPropagation,
    stopImmediatePropagation
  };
}

function recordedEvent(overrides: Partial<Pick<KeyboardEvent,
  "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>> = {}) {
  return {
    code: "KeyF",
    key: "f",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    ...overrides
  };
}
