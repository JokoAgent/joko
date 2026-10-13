import type { RemoteDesktopCapabilities } from "@joko/contracts";

export type MobileRemoteDesktopKeyboardPage = "abc" | "function";

const KEY_CODES = {
  abc: [
    ["Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash"],
    ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0"],
    ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"],
    ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Backspace"],
    ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Space", "Enter"]
  ],
  function: [
    ["Escape", "Tab", "Backquote", "Insert", "Home", "PageUp"],
    ["F1", "F2", "F3", "Delete", "End", "PageDown"],
    ["F4", "F5", "F6", "Backspace", "Space", "Enter"],
    ["F7", "F8", "F9", null, "ArrowUp", null],
    ["F10", "F11", "F12", "ArrowLeft", "ArrowDown", "ArrowRight"]
  ]
} as const;
const MODIFIERS = ["ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft"] as const;

export type MobileRemoteDesktopKeyCode = Exclude<
  (typeof KEY_CODES)[MobileRemoteDesktopKeyboardPage][number][number], null
> | (typeof MODIFIERS)[number];

export interface MobileRemoteDesktopKeyboardKey {
  readonly label: string;
  readonly code: MobileRemoteDesktopKeyCode;
}

const LABELS: Partial<Readonly<Record<MobileRemoteDesktopKeyCode, string>>> = Object.freeze({
  Minus: "− _", Equal: "= +", BracketLeft: "[ {", BracketRight: "] }", Backslash: "\\ |",
  Semicolon: "; :", Quote: "' \"", Comma: ", <", Period: ". >", Slash: "/ ?", Backquote: "` ~",
  Backspace: "⌫", Escape: "Esc", PageUp: "PgUp", PageDown: "PgDn", ControlLeft: "Ctrl", AltLeft: "Alt",
  ShiftLeft: "Shift", MetaLeft: "Meta", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓"
});
const MAC_LABELS: Partial<Readonly<Record<MobileRemoteDesktopKeyCode, string>>> = Object.freeze({
  ControlLeft: "Control", AltLeft: "Option", MetaLeft: "Command", Enter: "Return", Delete: "⌦"
});

/** Platform affects the meaning printed on an existing key, never its wire code. */
export function mobileRemoteDesktopKeyboardLabel(code: MobileRemoteDesktopKeyCode, platform?: string): string {
  if (platform === "darwin" && MAC_LABELS[code] !== undefined) return MAC_LABELS[code]!;
  if (code === "MetaLeft") return platform === "win32" ? "Win" : platform === "linux" ? "Super" : "Meta";
  if (code === "Backspace" && platform !== "darwin") return "Backspace";
  return LABELS[code] ?? code.replace(/^Key|^Digit/u, "");
}

function keyboardRows(rows: readonly (readonly (MobileRemoteDesktopKeyCode | null)[])[]):
readonly (readonly (MobileRemoteDesktopKeyboardKey | null)[])[] {
  return Object.freeze(rows.map(row => Object.freeze(row.map(code => code === null ? null : Object.freeze({
    code, label: mobileRemoteDesktopKeyboardLabel(code)
  })))));
}

export const mobileRemoteDesktopKeyPages: Readonly<Record<MobileRemoteDesktopKeyboardPage,
  readonly (readonly (MobileRemoteDesktopKeyboardKey | null)[])[]>> = Object.freeze({
  abc: keyboardRows(KEY_CODES.abc), function: keyboardRows(KEY_CODES.function)
});

export const mobileRemoteDesktopModifiers: readonly MobileRemoteDesktopKeyboardKey[] = Object.freeze(
  MODIFIERS.map(code => Object.freeze({ code, label: mobileRemoteDesktopKeyboardLabel(code) }))
);

export interface MobileRemoteDesktopShortcut {
  readonly id: "allWindows" | "showDesktop";
  readonly keys: readonly MobileRemoteDesktopKeyCode[];
  readonly labelKey: "allWindows" | "showDesktop";
}

const SHORTCUTS: Readonly<Record<"darwin" | "win32", readonly MobileRemoteDesktopShortcut[]>> = Object.freeze({
  darwin: Object.freeze([
    Object.freeze({ id: "allWindows", labelKey: "allWindows", keys: Object.freeze(["ControlLeft", "ArrowUp"] as const) }),
    Object.freeze({ id: "showDesktop", labelKey: "showDesktop", keys: Object.freeze(["F11"] as const) })
  ]),
  win32: Object.freeze([
    Object.freeze({ id: "allWindows", labelKey: "allWindows", keys: Object.freeze(["MetaLeft", "Tab"] as const) }),
    Object.freeze({ id: "showDesktop", labelKey: "showDesktop", keys: Object.freeze(["MetaLeft", "KeyD"] as const) })
  ])
});
const NO_SHORTCUTS: readonly MobileRemoteDesktopShortcut[] = Object.freeze([]);

/** The controller still authorizes each effect against the live control occurrence. */
export function mobileRemoteDesktopShortcuts(capabilities:
  Pick<RemoteDesktopCapabilities, "platform" | "canControl" | "workspaceNavigation"> | undefined
): readonly MobileRemoteDesktopShortcut[] {
  if (capabilities?.canControl !== true || capabilities.workspaceNavigation === true) return NO_SHORTCUTS;
  return capabilities.platform === "darwin" || capabilities.platform === "win32"
    ? SHORTCUTS[capabilities.platform] : NO_SHORTCUTS;
}
