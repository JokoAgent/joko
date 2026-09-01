import { isSystemReservedShortcut } from "./keyboard-reserved.js";

/**
 * Application shortcut registry for executable Joko Web actions.
 *
 * Defaults and user overrides share one normalized representation based on
 * KeyboardEvent.code so shortcuts remain independent of the active keyboard layout.
 * Missing overrides inherit the registry default; null explicitly disables
 * the action. Server-local OS actions and actions for which the current typed
 * Web contract has no executable operation are deliberately absent.
 */
export const APP_SHORTCUT_IDS = [
  "new-maker",
  "toggle-sidebar",
  "cycle-permission-mode",
  "close-tab-or-window",
  "right-tab-prev",
  "right-tab-next",
  "open-settings",
  "find-in-page",
  "search-in-project",
  "save-file",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "browser-focus-url",
  "browser-back",
  "browser-forward",
  "browser-reload",
  "switch-session-1",
  "switch-session-2",
  "switch-session-3",
  "switch-session-4",
  "switch-session-5",
  "switch-session-6",
  "switch-session-7",
  "switch-session-8",
  "switch-session-9"
] as const;

export const SWITCH_SESSION_SHORTCUT_IDS = [
  "switch-session-1",
  "switch-session-2",
  "switch-session-3",
  "switch-session-4",
  "switch-session-5",
  "switch-session-6",
  "switch-session-7",
  "switch-session-8",
  "switch-session-9"
] as const satisfies readonly AppShortcutId[];

export type AppShortcutId = (typeof APP_SHORTCUT_IDS)[number];
export type AppShortcutPlatform = "darwin" | "win32" | "linux";
export type AppShortcutScope = "app" | "workdir-doc" | "browser" | "composer";

export interface AppShortcutCombo {
  readonly code: string;
  readonly key?: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export type AppShortcutOverrideValue = AppShortcutCombo | null;
export type AppShortcutOverrides = Partial<Record<AppShortcutId, AppShortcutOverrideValue>>;

export interface AppShortcutDefinition {
  readonly id: AppShortcutId;
  readonly scope: AppShortcutScope;
  readonly labelKey: `settings.shortcuts.items.${AppShortcutId}.label`;
  readonly descriptionKey: `settings.shortcuts.items.${AppShortcutId}.description`;
  readonly rebindable: boolean;
  readonly hiddenInSettings?: boolean;
  readonly menuBacked?: boolean;
  /** Session-slot conveniences yield to an explicit user binding. */
  readonly yieldsToUserBindings?: boolean;
  readonly platforms?: readonly AppShortcutPlatform[];
  readonly defaultCombos: (platform: AppShortcutPlatform) => readonly AppShortcutCombo[];
}

const APP_SHORTCUT_ID_SET = new Set<string>(APP_SHORTCUT_IDS);
const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "Fn",
  "FnLock",
  "CapsLock"
]);

const CORE_SHORTCUT_DEFINITIONS: readonly AppShortcutDefinition[] = [
  definition("new-maker", "app", (platform) => [modCombo("KeyN", platform)], { menuBacked: true }),
  definition("toggle-sidebar", "app", (platform) => [modCombo("KeyB", platform)]),
  definition("cycle-permission-mode", "composer", () => [combo("Tab", { shift: true })]),
  definition("close-tab-or-window", "app", (platform) => [modCombo("KeyW", platform)], {
    rebindable: false,
    hiddenInSettings: true
  }),
  definition("right-tab-prev", "app", (platform) => platform === "darwin"
    ? [combo("BracketLeft", { meta: true, shift: true }), combo("Tab", { ctrl: true, shift: true })]
    : [combo("PageUp", { ctrl: true }), combo("Tab", { ctrl: true, shift: true })]),
  definition("right-tab-next", "app", (platform) => platform === "darwin"
    ? [combo("BracketRight", { meta: true, shift: true }), combo("Tab", { ctrl: true })]
    : [combo("PageDown", { ctrl: true }), combo("Tab", { ctrl: true })]),
  definition("open-settings", "app", () => [combo("Comma", { meta: true })], {
    hiddenInSettings: true,
    menuBacked: true,
    platforms: ["darwin"]
  }),
  definition("find-in-page", "app", (platform) => [modCombo("KeyF", platform)]),
  definition("search-in-project", "workdir-doc", (platform) => [modCombo("KeyF", platform, { shift: true })]),
  definition("save-file", "workdir-doc", (platform) => [modCombo("KeyS", platform)], {
    hiddenInSettings: true
  }),
  // macOS delegates these three defaults to native menu roles. The renderer
  // registry therefore owns them only on Windows and Linux.
  definition("zoom-in", "app", () => [
    combo("Equal", { ctrl: true }),
    combo("Equal", { ctrl: true, shift: true }),
    combo("NumpadAdd", { ctrl: true })
  ], { platforms: ["win32", "linux"] }),
  definition("zoom-out", "app", () => [
    combo("Minus", { ctrl: true }),
    combo("NumpadSubtract", { ctrl: true })
  ], { platforms: ["win32", "linux"] }),
  definition("zoom-reset", "app", () => [
    combo("Digit0", { ctrl: true }),
    combo("Numpad0", { ctrl: true })
  ], { platforms: ["win32", "linux"] }),
  definition("browser-focus-url", "browser", (platform) => [modCombo("KeyL", platform)]),
  definition("browser-back", "browser", () => [combo("ArrowLeft", { alt: true })]),
  definition("browser-forward", "browser", () => [combo("ArrowRight", { alt: true })]),
  definition("browser-reload", "browser", (platform) => [modCombo("KeyR", platform), combo("F5")])
];

const SESSION_SHORTCUT_DEFINITIONS: readonly AppShortcutDefinition[] = SWITCH_SESSION_SHORTCUT_IDS.map(
  (id, index) => definition(id, "app", (platform) => [modCombo(`Digit${index + 1}`, platform)], {
    hiddenInSettings: true,
    yieldsToUserBindings: true
  })
);

/** Settings presentation order, excluding documented actions that cannot execute here. */
export const APP_SHORTCUT_DEFINITION_LIST: readonly AppShortcutDefinition[] = [
  ...CORE_SHORTCUT_DEFINITIONS,
  ...SESSION_SHORTCUT_DEFINITIONS
];

export const APP_SHORTCUT_DEFINITIONS: Readonly<Record<AppShortcutId, AppShortcutDefinition>> = Object.fromEntries(
  APP_SHORTCUT_DEFINITION_LIST.map((definitionValue) => [definitionValue.id, definitionValue])
) as Readonly<Record<AppShortcutId, AppShortcutDefinition>>;

export function visibleAppShortcutDefinitions(
  platform: AppShortcutPlatform = currentAppShortcutPlatform()
): readonly AppShortcutDefinition[] {
  return APP_SHORTCUT_DEFINITION_LIST.filter((definitionValue) =>
    definitionValue.hiddenInSettings !== true && isAppShortcutAvailableOnPlatform(definitionValue.id, platform));
}

export function isAppShortcutId(value: unknown): value is AppShortcutId {
  return typeof value === "string" && APP_SHORTCUT_ID_SET.has(value);
}

export function isAppShortcutAvailableOnPlatform(id: AppShortcutId, platform: AppShortcutPlatform): boolean {
  const platforms = APP_SHORTCUT_DEFINITIONS[id].platforms;
  return platforms === undefined || platforms.includes(platform);
}

export function normalizeAppShortcutCombo(value: unknown): AppShortcutCombo | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["code"] !== "string" || candidate["code"].trim() === "" || MODIFIER_CODES.has(candidate["code"])) {
    return undefined;
  }
  return {
    code: candidate["code"],
    ...(typeof candidate["key"] === "string" ? { key: candidate["key"] } : {}),
    meta: Boolean(candidate["meta"]),
    ctrl: Boolean(candidate["ctrl"]),
    alt: Boolean(candidate["alt"]),
    shift: Boolean(candidate["shift"])
  };
}

/** Select only known, structurally valid, rebindable persisted overrides. */
export function normalizeAppShortcutOverrides(
  value: unknown,
  platform: AppShortcutPlatform = currentAppShortcutPlatform()
): AppShortcutOverrides {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: AppShortcutOverrides = {};
  for (const [id, override] of Object.entries(value as Record<string, unknown>)) {
    if (!isAppShortcutId(id)) continue;
    const definitionValue = APP_SHORTCUT_DEFINITIONS[id];
    if (!definitionValue.rebindable || !isAppShortcutAvailableOnPlatform(id, platform)) continue;
    if (override === null) {
      normalized[id] = null;
      continue;
    }
    const normalizedCombo = normalizeAppShortcutCombo(override);
    if (normalizedCombo === undefined || !isAppShortcutComboBindable(normalizedCombo)
      || collidesWithNonRebindableDefault(normalizedCombo, platform)) continue;
    normalized[id] = normalizedCombo;
  }
  return normalized;
}

/** Return a new override map. undefined restores the registry default. */
export function withAppShortcutOverride(
  overrides: AppShortcutOverrides,
  id: AppShortcutId,
  value: AppShortcutOverrideValue | undefined,
  platform: AppShortcutPlatform = currentAppShortcutPlatform()
): AppShortcutOverrides {
  const definitionValue = APP_SHORTCUT_DEFINITIONS[id];
  if (!definitionValue.rebindable || !isAppShortcutAvailableOnPlatform(id, platform)) {
    throw new Error("The application shortcut cannot be changed on this platform.");
  }
  const next = { ...overrides };
  if (value === undefined) {
    delete next[id];
    return next;
  }
  if (value === null) {
    next[id] = null;
    return next;
  }
  const normalized = normalizeAppShortcutCombo(value);
  if (normalized === undefined || !isAppShortcutComboBindable(normalized)
    || collidesWithNonRebindableDefault(normalized, platform)) {
    throw new Error("The application shortcut combination is invalid.");
  }
  if (definitionValue.menuBacked === true && platform === "darwin"
    && comboToElectronAccelerator(normalized, platform) === null) {
    throw new Error("The application shortcut cannot be expressed as a macOS menu accelerator.");
  }
  next[id] = normalized;
  return next;
}

export function effectiveAppShortcutCombos(
  id: AppShortcutId,
  overrides: AppShortcutOverrides | undefined,
  platform: AppShortcutPlatform = currentAppShortcutPlatform()
): readonly AppShortcutCombo[] {
  if (!isAppShortcutAvailableOnPlatform(id, platform)) return [];
  const override = overrides?.[id];
  if (override === null) return [];
  if (override !== undefined) return [override];
  const definitionValue = APP_SHORTCUT_DEFINITIONS[id];
  const defaults = definitionValue.defaultCombos(platform);
  if (definitionValue.yieldsToUserBindings !== true) return defaults;
  return defaults.filter((defaultCombo) => !APP_SHORTCUT_DEFINITION_LIST.some((otherDefinition) => {
    if (otherDefinition.id === id || !appShortcutScopesOverlap(definitionValue.scope, otherDefinition.scope)) return false;
    const otherOverride = overrides?.[otherDefinition.id];
    return otherOverride !== undefined && otherOverride !== null && appShortcutCombosEqual(defaultCombo, otherOverride);
  }));
}

export function getAppShortcutDefinition(id: AppShortcutId): AppShortcutDefinition {
  return APP_SHORTCUT_DEFINITIONS[id];
}

export function matchesAppShortcutEvent(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  comboValue: AppShortcutCombo
): boolean {
  return event.code === comboValue.code
    && event.metaKey === comboValue.meta
    && event.ctrlKey === comboValue.ctrl
    && event.altKey === comboValue.alt
    && event.shiftKey === comboValue.shift;
}

export function eventMatchesAppShortcut(
  id: AppShortcutId,
  event: Pick<KeyboardEvent,
    "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented"
  >,
  overrides: AppShortcutOverrides | undefined,
  platform: AppShortcutPlatform = currentAppShortcutPlatform()
): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  return effectiveAppShortcutCombos(id, overrides, platform).some((comboValue) => matchesAppShortcutEvent(event, comboValue));
}

export function currentAppShortcutPlatform(platform = desktopOrNavigatorPlatform()): AppShortcutPlatform {
  if (/mac|iphone|ipad|ipod|darwin/iu.test(platform)) return "darwin";
  if (/win/iu.test(platform)) return "win32";
  return "linux";
}

function desktopOrNavigatorPlatform(): string {
  if (typeof window !== "undefined" && typeof window.jokoDesktop?.platform === "string") return window.jokoDesktop.platform;
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function definition(
  id: AppShortcutId,
  scope: AppShortcutScope,
  defaultCombos: AppShortcutDefinition["defaultCombos"],
  options: Partial<Pick<AppShortcutDefinition, "rebindable" | "hiddenInSettings" | "menuBacked" | "yieldsToUserBindings" | "platforms">> = {}
): AppShortcutDefinition {
  return {
    id,
    scope,
    labelKey: `settings.shortcuts.items.${id}.label`,
    descriptionKey: `settings.shortcuts.items.${id}.description`,
    rebindable: true,
    defaultCombos,
    ...options
  };
}

function combo(
  code: string,
  modifiers: Partial<Pick<AppShortcutCombo, "meta" | "ctrl" | "alt" | "shift">> = {}
): AppShortcutCombo {
  return {
    code,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    ...modifiers
  };
}

function modCombo(
  code: string,
  platform: AppShortcutPlatform,
  extra: Partial<Pick<AppShortcutCombo, "meta" | "ctrl" | "alt" | "shift">> = {}
): AppShortcutCombo {
  return combo(code, {
    meta: platform === "darwin",
    ctrl: platform !== "darwin",
    ...extra
  });
}

const DISPLAY_KEY_LABELS: Readonly<Record<string, string>> = {
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  Numpad0: "Num 0"
};

const ELECTRON_ACCELERATOR_KEY_BY_CODE: Readonly<Record<string, string>> = {
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right"
};

/** Returns null when a physical-key combo has no safe Electron spelling. */
export function comboToElectronAccelerator(
  comboValue: AppShortcutCombo,
  platform: AppShortcutPlatform
): string | null {
  const letter = comboValue.code.match(/^Key([A-Z])$/)?.[1];
  const digit = comboValue.code.match(/^Digit([0-9])$/)?.[1];
  const key = letter
    ?? digit
    ?? (/^F([1-9]|1[0-9]|2[0-4])$/.test(comboValue.code) ? comboValue.code : undefined)
    ?? ELECTRON_ACCELERATOR_KEY_BY_CODE[comboValue.code];
  if (key === undefined) return null;
  const parts: string[] = [];
  if (comboValue.ctrl) parts.push("Ctrl");
  if (comboValue.alt) parts.push("Alt");
  if (comboValue.shift) parts.push("Shift");
  if (comboValue.meta) parts.push(platform === "darwin" ? "Command" : "Super");
  parts.push(key);
  return parts.join("+");
}

/** Cross-platform label for a physical-key shortcut. */
export function formatAppShortcutCombo(comboValue: AppShortcutCombo, platform: AppShortcutPlatform): string {
  const keyLabel = displayKeyForCode(comboValue.code, comboValue.key);
  if (platform === "darwin") {
    const parts: string[] = [];
    if (comboValue.ctrl) parts.push("⌃");
    if (comboValue.alt) parts.push("⌥");
    if (comboValue.shift) parts.push("⇧");
    if (comboValue.meta) parts.push("⌘");
    parts.push(keyLabel);
    return parts.join("");
  }
  const parts: string[] = [];
  if (comboValue.ctrl) parts.push("Ctrl");
  if (comboValue.alt) parts.push("Alt");
  if (comboValue.shift) parts.push("Shift");
  if (comboValue.meta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

function displayKeyForCode(code: string, key?: string): string {
  const explicit = DISPLAY_KEY_LABELS[code];
  if (explicit !== undefined) return explicit;
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter !== undefined) return letter;
  const digit = code.match(/^Digit([0-9])$/)?.[1];
  if (digit !== undefined) return digit;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (key !== undefined && key.length === 1 && key !== " ") return key.toUpperCase();
  return key ?? code;
}

/** Pure modifier events keep recording active until a main key is pressed. */
export function createAppShortcutComboFromEvent(event: Pick<KeyboardEvent,
  "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>): AppShortcutCombo | null {
  if (event.code === "" || MODIFIER_CODES.has(event.code)) return null;
  return {
    code: event.code,
    key: event.key,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  };
}

const SHIFT_ONLY_ALLOWED_CODES = /^(Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F([1-9]|1[0-9]|2[0-4]))$/;

/** Bare-key bindings are limited to F1-F24 or Shift plus a non-printing key. */
export function isAppShortcutComboBindable(comboValue: AppShortcutCombo): boolean {
  if (comboValue.meta || comboValue.ctrl || comboValue.alt) return true;
  if (comboValue.shift) return SHIFT_ONLY_ALLOWED_CODES.test(comboValue.code);
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(comboValue.code);
}

export function appShortcutCombosEqual(a: AppShortcutCombo, b: AppShortcutCombo): boolean {
  return a.code === b.code
    && a.meta === b.meta
    && a.ctrl === b.ctrl
    && a.alt === b.alt
    && a.shift === b.shift;
}

const OVERLAPPING_SCOPE_PAIRS = new Set(["browser:workdir-doc", "composer:workdir-doc"]);

export function appShortcutScopesOverlap(a: AppShortcutScope, b: AppShortcutScope): boolean {
  if (a === "app" || b === "app" || a === b) return true;
  return OVERLAPPING_SCOPE_PAIRS.has([a, b].sort().join(":"));
}

export function findAppShortcutConflict(
  id: AppShortcutId,
  comboValue: AppShortcutCombo,
  overrides: AppShortcutOverrides,
  platform: AppShortcutPlatform
): AppShortcutId | null {
  const selfDefinition = APP_SHORTCUT_DEFINITIONS[id];
  for (const otherDefinition of APP_SHORTCUT_DEFINITION_LIST) {
    if (otherDefinition.id === id || !isAppShortcutAvailableOnPlatform(otherDefinition.id, platform)) continue;
    if (!appShortcutScopesOverlap(selfDefinition.scope, otherDefinition.scope)) continue;
    if (otherDefinition.yieldsToUserBindings === true && overrides[otherDefinition.id] === undefined) continue;
    if (effectiveAppShortcutCombos(otherDefinition.id, overrides, platform).some((candidate) => appShortcutCombosEqual(candidate, comboValue))) {
      return otherDefinition.id;
    }
  }
  return null;
}

export type AppShortcutValidationIssue =
  | { readonly kind: "not-bindable" }
  | { readonly kind: "system-reserved" }
  | { readonly kind: "menu-inexpressible" }
  | { readonly kind: "conflict"; readonly conflictingId: AppShortcutId };

/** Shared preflight used by recording UI; null means the combo may be saved. */
export function validateAppShortcutCombo(
  id: AppShortcutId,
  comboValue: AppShortcutCombo,
  overrides: AppShortcutOverrides,
  platform: AppShortcutPlatform
): AppShortcutValidationIssue | null {
  if (!isAppShortcutComboBindable(comboValue)) return { kind: "not-bindable" };
  if (isSystemReservedShortcut(comboValue, platform)) return { kind: "system-reserved" };
  if (collidesWithNonRebindableDefault(comboValue, platform)) return { kind: "system-reserved" };
  if (APP_SHORTCUT_DEFINITIONS[id].menuBacked === true && platform === "darwin"
    && comboToElectronAccelerator(comboValue, platform) === null) return { kind: "menu-inexpressible" };
  const conflictingId = findAppShortcutConflict(id, comboValue, overrides, platform);
  return conflictingId === null ? null : { kind: "conflict", conflictingId };
}

function collidesWithNonRebindableDefault(comboValue: AppShortcutCombo, platform: AppShortcutPlatform): boolean {
  return APP_SHORTCUT_DEFINITION_LIST.some((definitionValue) =>
    !definitionValue.rebindable
    && isAppShortcutAvailableOnPlatform(definitionValue.id, platform)
    && definitionValue.defaultCombos(platform).some((candidate) => appShortcutCombosEqual(candidate, comboValue)));
}
