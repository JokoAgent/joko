import type {
  DesktopGlobalVoiceShortcut,
  DesktopGlobalVoiceShortcutPreference
} from "./channels.js";

const FUNCTION_KEY = /^F(?:[1-9]|1\d|2[0-4])$/u;
const KEY_CODE = /^Key([A-Z])$/u;
const DIGIT_CODE = /^Digit([0-9])$/u;
const NUMPAD_CODE = /^Numpad([0-9])$/u;
const MAC_BARE_MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "Fn"
]);
const MAC_NATIVE_NAMED_KEYS = new Set([
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
  "Semicolon", "Quote", "Comma", "Period", "Slash", "Space", "Tab", "Enter",
  "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"
]);

const NAMED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Space: "Space",
  Tab: "Tab",
  Enter: "Return",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/"
});

export interface DesktopGlobalShortcutBackend {
  readonly isRegistered: (accelerator: string) => boolean;
  readonly register: (accelerator: string, callback: () => void) => boolean;
  readonly unregister: (accelerator: string) => void;
}

export interface PreparedDesktopGlobalShortcutReplacement {
  readonly commit: () => void;
  readonly rollback: () => void;
}

/** Commits a replacement only after Electron has accepted the new binding. */
export class DesktopGlobalShortcutRegistration {
  #accelerator: string | undefined;
  readonly #prepared = new Map<string, number>();

  constructor(private readonly backend: DesktopGlobalShortcutBackend) {}

  current(): string | undefined {
    return this.#accelerator;
  }

  replace(accelerator: string, callback: () => void): boolean {
    const prepared = this.prepareReplacement(accelerator, callback);
    if (prepared === undefined) return false;
    prepared.commit();
    return true;
  }

  /** Keep the old binding alive until the caller commits an asynchronous replacement. */
  prepareReplacement(
    accelerator: string,
    callback: () => void
  ): PreparedDesktopGlobalShortcutReplacement | undefined {
    if (this.#accelerator === accelerator && this.backend.isRegistered(accelerator)) {
      return settledPreparedReplacement();
    }
    const preparedCount = this.#prepared.get(accelerator) ?? 0;
    if (preparedCount === 0 && !this.backend.register(accelerator, callback)) return undefined;
    this.#prepared.set(accelerator, preparedCount + 1);
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        const previous = this.#accelerator;
        this.#accelerator = accelerator;
        this.#releasePrepared(accelerator);
        if (previous !== undefined && previous !== accelerator) this.backend.unregister(previous);
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.#releasePrepared(accelerator);
      }
    };
  }

  clear(): void {
    const previous = this.#accelerator;
    this.#accelerator = undefined;
    if (previous !== undefined) this.backend.unregister(previous);
    for (const accelerator of this.#prepared.keys()) {
      if (accelerator !== previous) this.backend.unregister(accelerator);
    }
    this.#prepared.clear();
  }


  #releasePrepared(accelerator: string): void {
    const remaining = (this.#prepared.get(accelerator) ?? 1) - 1;
    if (remaining > 0) {
      this.#prepared.set(accelerator, remaining);
      return;
    }
    this.#prepared.delete(accelerator);
    if (this.#accelerator !== accelerator) this.backend.unregister(accelerator);
  }
}

function settledPreparedReplacement(): PreparedDesktopGlobalShortcutReplacement {
  return { commit: () => undefined, rollback: () => undefined };
}

export function parseDesktopGlobalVoiceShortcut(value: unknown): DesktopGlobalVoiceShortcutPreference {
  if (value === "disabled") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Global voice shortcut is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "alt,code,ctrl,fn,meta,shift"
    || typeof candidate["code"] !== "string"
    || candidate["code"].length === 0
    || candidate["code"].length > 32
    || typeof candidate["meta"] !== "boolean"
    || typeof candidate["ctrl"] !== "boolean"
    || typeof candidate["alt"] !== "boolean"
    || typeof candidate["shift"] !== "boolean"
    || typeof candidate["fn"] !== "boolean") {
    throw new TypeError("Global voice shortcut is invalid.");
  }
  const shortcut = Object.freeze({
    code: candidate["code"],
    meta: candidate["meta"],
    ctrl: candidate["ctrl"],
    alt: candidate["alt"],
    shift: candidate["shift"],
    fn: candidate["fn"]
  });
  if (desktopGlobalVoiceAccelerator(shortcut) === undefined && !isDesktopGlobalVoiceNativeCandidate(shortcut)) {
    throw new TypeError("Global voice shortcut is unsupported.");
  }
  return shortcut;
}

export function isDesktopGlobalVoiceNativeCandidate(shortcut: DesktopGlobalVoiceShortcut): boolean {
  if (MAC_BARE_MODIFIER_CODES.has(shortcut.code)) {
    return !shortcut.meta && !shortcut.ctrl && !shortcut.alt && !shortcut.shift && !shortcut.fn;
  }
  return shortcut.fn && (/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1\d|2[0-4]))$/u.test(shortcut.code)
    || MAC_NATIVE_NAMED_KEYS.has(shortcut.code));
}

export function desktopGlobalVoiceAccelerator(shortcut: DesktopGlobalVoiceShortcut): string | undefined {
  if (shortcut.fn) return undefined;
  const key = acceleratorKey(shortcut.code);
  if (key === undefined) return undefined;
  const hasModifier = shortcut.meta || shortcut.ctrl || shortcut.alt || shortcut.shift;
  if (!hasModifier && !FUNCTION_KEY.test(key)) return undefined;
  const modifiers = [
    shortcut.meta ? "Super" : undefined,
    shortcut.ctrl ? "Control" : undefined,
    shortcut.alt ? "Alt" : undefined,
    shortcut.shift ? "Shift" : undefined
  ].filter((value): value is string => value !== undefined);
  return [...modifiers, key].join("+");
}

function acceleratorKey(code: string): string | undefined {
  const keyMatch = KEY_CODE.exec(code);
  if (keyMatch !== null) return keyMatch[1];
  const digitMatch = DIGIT_CODE.exec(code);
  if (digitMatch !== null) return digitMatch[1];
  const numpadMatch = NUMPAD_CODE.exec(code);
  if (numpadMatch !== null) return `num${numpadMatch[1]}`;
  if (FUNCTION_KEY.test(code)) return code;
  return NAMED_KEYS[code];
}
