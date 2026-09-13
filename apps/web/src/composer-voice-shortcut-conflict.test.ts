import { describe, expect, it } from "vitest";

import type { AppShortcutPlatform } from "./app-shortcuts.js";
import { composerVoiceShortcutsConflict } from "./composer-voice-shortcut-conflict.js";
import type { ComposerSendShortcutPreference } from "./local-state.js";
import type { VoiceInputShortcutCombo, VoiceInputShortcutPreference } from "./voice-input-preferences.js";

const ctrlEnter: VoiceInputShortcutCombo = {
  code: "Enter",
  key: "Enter",
  meta: false,
  ctrl: true,
  alt: false,
  shift: false,
  fn: false
};

describe("composerVoiceShortcutsConflict", () => {
  it.each([
    ["plain-send Ctrl+Enter", "enter", "win32", ctrlEnter],
    ["macOS Command+Enter", "modifier-enter", "darwin", { ...ctrlEnter, meta: true, ctrl: false }],
    ["macOS Ctrl+Enter", "modifier-enter", "darwin", ctrlEnter],
    ["Windows Ctrl+Enter", "modifier-enter", "win32", ctrlEnter],
    ["Windows Ctrl+NumpadEnter", "modifier-enter", "win32", { ...ctrlEnter, code: "NumpadEnter" }],
    ["Linux Ctrl+Enter", "modifier-enter", "linux", ctrlEnter]
  ] as const)("detects %s", (_name, preference, platform, shortcut) => {
    expect(composerVoiceShortcutsConflict(preference, shortcut, platform)).toBe(true);
  });

  it.each([
    ["disabled voice input", "modifier-enter", "disabled", "win32"],
    ["Command+Enter outside macOS", "modifier-enter", { ...ctrlEnter, meta: true, ctrl: false }, "win32"],
    ["plain Enter", "modifier-enter", { ...ctrlEnter, ctrl: false }, "linux"],
    ["Alt+Enter", "modifier-enter", { ...ctrlEnter, alt: true }, "linux"],
    ["Shift+Enter", "modifier-enter", { ...ctrlEnter, shift: true }, "linux"],
    ["Fn+Enter", "modifier-enter", { ...ctrlEnter, fn: true }, "darwin"],
    ["another key", "modifier-enter", { ...ctrlEnter, code: "KeyK", key: "k" }, "win32"]
  ] as const)("does not flag %s", (
    _name,
    preference: ComposerSendShortcutPreference,
    shortcut: VoiceInputShortcutPreference,
    platform: AppShortcutPlatform
  ) => {
    expect(composerVoiceShortcutsConflict(preference, shortcut, platform)).toBe(false);
  });
});
