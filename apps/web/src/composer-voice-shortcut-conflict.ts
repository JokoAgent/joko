import type { AppShortcutPlatform } from "./app-shortcuts.js";
import type { ComposerSendShortcutPreference } from "./local-state.js";
import type { VoiceInputShortcutPreference } from "./voice-input-preferences.js";

export function composerVoiceShortcutsConflict(
  composerShortcut: ComposerSendShortcutPreference,
  voiceShortcut: VoiceInputShortcutPreference,
  platform: AppShortcutPlatform
): boolean {
  if (voiceShortcut === "disabled") return false;
  if (voiceShortcut.fn || (voiceShortcut.code !== "Enter" && voiceShortcut.code !== "NumpadEnter")) return false;
  if (voiceShortcut.alt || voiceShortcut.shift) return false;
  if (composerShortcut === "enter") return true;
  return voiceShortcut.ctrl || (platform === "darwin" && voiceShortcut.meta);
}
