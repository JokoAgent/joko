import { describe, expect, it } from "vitest";

import {
  mobileRemoteDesktopKeyboardLabel,
  mobileRemoteDesktopKeyPages,
  mobileRemoteDesktopModifiers,
  mobileRemoteDesktopShortcuts,
  type MobileRemoteDesktopKeyCode
} from "./remote-desktop-keyboard";
import { mobileRemoteDesktopViewerTesting } from "./remote-desktop-viewer";

describe("Mobile Remote Desktop computer keyboard", () => {
  it("covers every existing input key with 49 ABC keys, 28 Function keys and four modifiers", () => {
    const abc = mobileRemoteDesktopKeyPages.abc.flat();
    const functions = mobileRemoteDesktopKeyPages.function.flat();
    expect(abc).toHaveLength(49);
    expect(abc.every(key => key !== null)).toBe(true);
    expect(functions.filter(key => key !== null)).toHaveLength(28);
    expect(functions.filter(key => key === null)).toHaveLength(2);
    expect(mobileRemoteDesktopModifiers.map(key => key.code)).toEqual(["ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft"]);
    const codes = new Set([...abc, ...functions, ...mobileRemoteDesktopModifiers].filter(key => key !== null).map(key => key.code));
    expect(codes.size).toBe(78);
    expect([...codes].sort()).toEqual([...mobileRemoteDesktopViewerTesting.KEY_CODES].sort());
  });

  it("preserves the reachable keyboard row and navigation grouping", () => {
    expect(mobileRemoteDesktopKeyPages.abc.map(row => row.length)).toEqual([10, 10, 10, 10, 9]);
    expect(mobileRemoteDesktopKeyPages.abc[1]!.map(key => key!.code)).toEqual([
      "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0"
    ]);
    expect(mobileRemoteDesktopKeyPages.abc[2]!.map(key => key!.code)).toEqual([
      "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"
    ]);
    expect(mobileRemoteDesktopKeyPages.function.map(row => row.length)).toEqual([6, 6, 6, 6, 6]);
    expect(mobileRemoteDesktopKeyPages.function[3]!.map(key => key?.code ?? null)).toEqual(["F7", "F8", "F9", null, "ArrowUp", null]);
    expect(mobileRemoteDesktopKeyPages.function[4]!.map(key => key!.code)).toEqual(["F10", "F11", "F12", "ArrowLeft", "ArrowDown", "ArrowRight"]);
  });

  it.each([
    ["ControlLeft", "darwin", "Control"], ["AltLeft", "darwin", "Option"], ["MetaLeft", "darwin", "Command"],
    ["Enter", "darwin", "Return"], ["Delete", "darwin", "⌦"], ["Backspace", "darwin", "⌫"],
    ["MetaLeft", "win32", "Win"], ["MetaLeft", "linux", "Super"], ["MetaLeft", undefined, "Meta"],
    ["MetaLeft", "unknown", "Meta"], ["ControlLeft", "linux", "Ctrl"], ["Backspace", "win32", "Backspace"],
    ["KeyQ", "linux", "Q"], ["Digit0", "darwin", "0"], ["ArrowLeft", "win32", "←"], ["F12", "win32", "F12"],
    ["Minus", "linux", "− _"], ["Backslash", "linux", "\\ |"], ["Quote", "win32", "' \""]
  ] as const)("labels %s for %s with its actual key meaning", (code, platform, label) => {
    expect(mobileRemoteDesktopKeyboardLabel(code, platform)).toBe(label);
  });

  it.each([
    ["darwin", [["ControlLeft", "ArrowUp"], ["F11"]]],
    ["win32", [["MetaLeft", "Tab"], ["MetaLeft", "KeyD"]]]
  ] as const)("exposes only the supported %s fixed window shortcuts", (platform, keys) => {
    const shortcuts = mobileRemoteDesktopShortcuts({ platform, canControl: true, workspaceNavigation: false });
    expect(shortcuts.map(shortcut => shortcut.keys)).toEqual(keys);
    expect(shortcuts.map(shortcut => ({ id: shortcut.id, labelKey: shortcut.labelKey }))).toEqual([
      { id: "allWindows", labelKey: "allWindows" }, { id: "showDesktop", labelKey: "showDesktop" }
    ]);
    const keyboard = new Set(mobileRemoteDesktopKeyPages.function.flat().flatMap(key => key === null ? [] : [key.code]));
    for (const shortcut of shortcuts) for (const code of shortcut.keys) {
      expect(mobileRemoteDesktopViewerTesting.KEY_CODES).toContain(code);
      expect(typeof mobileRemoteDesktopKeyboardLabel(code, platform)).toBe("string");
    }
    expect(keyboard.has("F11")).toBe(true);
  });

  it.each(["linux", "unknown", "", "portal"])("does not infer Windows shortcuts for %s", platform => {
    expect(mobileRemoteDesktopShortcuts({ platform, canControl: true, workspaceNavigation: false })).toEqual([]);
  });

  it("hides shortcuts without control capability or when workspace navigation replaces them", () => {
    expect(mobileRemoteDesktopShortcuts(undefined)).toEqual([]);
    for (const platform of ["darwin", "win32"]) {
      expect(mobileRemoteDesktopShortcuts({ platform, canControl: false, workspaceNavigation: false })).toEqual([]);
      expect(mobileRemoteDesktopShortcuts({ platform, canControl: true, workspaceNavigation: true })).toEqual([]);
    }
  });

  it("keeps shared keyboard and shortcut metadata immutable across rendering and press contexts", () => {
    expect(Object.isFrozen(mobileRemoteDesktopKeyPages)).toBe(true);
    for (const rows of Object.values(mobileRemoteDesktopKeyPages)) {
      expect(Object.isFrozen(rows)).toBe(true);
      for (const row of rows) {
        expect(Object.isFrozen(row)).toBe(true);
        for (const key of row) if (key !== null) expect(Object.isFrozen(key)).toBe(true);
      }
    }
    expect(Object.isFrozen(mobileRemoteDesktopModifiers)).toBe(true);
    const shortcuts = mobileRemoteDesktopShortcuts({ platform: "win32", canControl: true, workspaceNavigation: false });
    expect(Object.isFrozen(shortcuts)).toBe(true);
    for (const shortcut of shortcuts) {
      expect(Object.isFrozen(shortcut)).toBe(true);
      expect(Object.isFrozen(shortcut.keys)).toBe(true);
    }
    const code: MobileRemoteDesktopKeyCode = "MetaLeft";
    expect(mobileRemoteDesktopKeyboardLabel(code, "win32")).toBe("Win");
  });
});
