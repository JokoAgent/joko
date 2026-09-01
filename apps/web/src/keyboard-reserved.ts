import type { AppShortcutCombo, AppShortcutPlatform } from "./app-shortcuts.js";

/**
 * Platform-reserved shortcut rules, expressed with KeyboardEvent.code
 * so recording stays independent of the active keyboard layout.
 */
export function isSystemReservedShortcut(
  input: AppShortcutCombo,
  platform: AppShortcutPlatform
): boolean {
  if (platform === "darwin") return isMacReservedShortcut(input);
  if (platform === "win32") return isWindowsReservedShortcut(input);
  return false;
}

function isMacReservedShortcut(input: AppShortcutCombo): boolean {
  const onlyCommand = input.meta && !input.ctrl && !input.alt && !input.shift;
  const commandShift = input.meta && input.shift && !input.ctrl && !input.alt;
  const commandAlt = input.meta && input.alt && !input.ctrl && !input.shift;
  const commandCtrl = input.meta && input.ctrl && !input.alt && !input.shift;
  if (onlyCommand) {
    return new Set([
      "KeyA",
      "KeyC",
      "KeyV",
      "KeyX",
      "KeyZ",
      "Comma",
      "KeyQ",
      "KeyH",
      "KeyM",
      "KeyW",
      "Digit0",
      "Equal",
      "Minus"
    ]).has(input.code);
  }
  if (commandShift) return input.code === "KeyZ" || input.code === "Equal";
  if (commandAlt) return input.code === "KeyH";
  if (commandCtrl) return input.code === "KeyF";
  return false;
}

function isWindowsReservedShortcut(input: AppShortcutCombo): boolean {
  const { code } = input;
  const ctrlOnly = input.ctrl && !input.alt && !input.shift && !input.meta;
  const altOnly = input.alt && !input.ctrl && !input.shift && !input.meta;
  const ctrlAlt = input.ctrl && input.alt && !input.shift && !input.meta;

  if (ctrlOnly && code === "Space") return true;
  if (altOnly && new Set(["Tab", "F4", "Escape"]).has(code)) return true;
  if (ctrlAlt && code === "Delete") return true;
  if (!input.meta) return false;

  const onlyMeta = !input.ctrl && !input.alt && !input.shift;
  const metaShift = input.shift && !input.ctrl && !input.alt;
  const metaCtrl = input.ctrl && !input.shift && !input.alt;
  const metaAlt = input.alt && !input.ctrl && !input.shift;
  const metaCtrlShift = input.ctrl && input.shift && !input.alt;

  if (onlyMeta) {
    if (/^Digit[0-9]$/.test(code)) return true;
    return new Set([
      "KeyA", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK",
      "KeyL", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyV",
      "KeyW", "KeyX", "KeyZ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Comma",
      "Period", "Semicolon", "Slash", "Tab", "Space", "Home", "Escape", "Minus", "Equal",
      "PrintScreen", "Pause"
    ]).has(code);
  }
  if (metaShift) {
    return new Set(["KeyA", "KeyS", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]).has(code);
  }
  if (metaCtrl) {
    return new Set(["KeyC", "KeyD", "KeyF", "KeyQ", "KeyV", "Enter", "Space", "ArrowLeft", "ArrowRight", "F4"]).has(code);
  }
  if (metaAlt) return new Set(["KeyB", "KeyD", "KeyH", "KeyK", "ArrowUp", "ArrowDown"]).has(code);
  if (metaCtrlShift) return code === "KeyB";
  return false;
}
