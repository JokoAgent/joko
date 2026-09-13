import {
  appShortcutCombosEqual,
  currentAppShortcutPlatform,
  formatAppShortcutCombo,
  isAppShortcutComboBindable,
  matchesAppShortcutEvent,
  normalizeAppShortcutCombo,
  type AppShortcutCombo,
  type AppShortcutPlatform
} from "./app-shortcuts.js";
import {
  EMPTY_VOICE_INPUT_DICTIONARY,
  MAXIMUM_VOICE_DICTIONARY_ENTRIES,
  MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS,
  mergeManualVoiceDictionaryTerms,
  normalizeVoiceInputDictionaryState,
  voiceDictionaryTermsForRefinement,
  type VoiceInputDictionaryState
} from "./voice-input-dictionary.js";

export interface VoiceInputShortcutCombo extends AppShortcutCombo {
  readonly fn: boolean;
}

export type VoiceInputShortcutPreference = VoiceInputShortcutCombo | "disabled";

const MAC_BARE_VOICE_MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "Fn"
]);
const MAC_NATIVE_MODIFIER_CODES = new Set([
  ...MAC_BARE_VOICE_MODIFIER_CODES,
  "ShiftLeft",
  "ShiftRight"
]);
const MAC_NATIVE_VOICE_KEY_CODES = new Set([
  ...Array.from({ length: 26 }, (_value, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_value, index) => `Digit${index}`),
  ...Array.from({ length: 24 }, (_value, index) => `F${index + 1}`),
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
  "Semicolon", "Quote", "Comma", "Period", "Slash", "Space", "Tab", "Enter",
  "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"
]);

export interface VoiceInputPreferences {
  readonly locale: string;
  readonly deviceId?: string;
  readonly shortcut: VoiceInputShortcutPreference;
  readonly refinementInstructions: string;
  readonly dictionary: VoiceInputDictionaryState;
  readonly dictionaryTerms: readonly string[];
  readonly autoDictionaryEnabled: boolean;
  readonly playInteractionSound: boolean;
  readonly fastActivationEnabled: boolean;
  readonly muteOtherSounds: boolean;
}

export const DEFAULT_VOICE_INPUT_PREFERENCES: VoiceInputPreferences = Object.freeze({
  locale: "auto",
  shortcut: defaultVoiceInputShortcut(),
  refinementInstructions: "",
  dictionary: EMPTY_VOICE_INPUT_DICTIONARY,
  dictionaryTerms: Object.freeze([]),
  autoDictionaryEnabled: true,
  playInteractionSound: true,
  fastActivationEnabled: false,
  muteOtherSounds: true
});

export const MAXIMUM_VOICE_REFINEMENT_INSTRUCTIONS_CHARACTERS = 1_000;
export { MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS };
export const MAXIMUM_VOICE_DICTIONARY_TERMS = MAXIMUM_VOICE_DICTIONARY_ENTRIES;
export const MAXIMUM_VOICE_DICTIONARY_CHARACTERS = MAXIMUM_VOICE_DICTIONARY_ENTRIES * MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS;
export const MAXIMUM_VOICE_DICTIONARY_CSV_BYTES = 5 * 1024 * 1024;
export const VOICE_INPUT_LOCALES = Object.freeze(["zh-CN", "zh-TW", "en", "ja", "ko"] as const);

export type VoiceDictionaryCsvParseResult =
  | { readonly ok: true; readonly terms: readonly string[]; readonly duplicateRows: number; readonly skippedTooLong: number }
  | { readonly ok: false; readonly reason: "empty" | "invalid" };

const STORAGE_KEY = "joko.voice-input.preferences.v1";
const CHANGE_EVENT = "joko:voice-input-preferences";

export function readVoiceInputPreferences(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): VoiceInputPreferences {
  if (storage === undefined) return DEFAULT_VOICE_INPUT_PREFERENCES;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return value === null ? DEFAULT_VOICE_INPUT_PREFERENCES : parseVoiceInputPreferences(JSON.parse(value));
  } catch {
    return DEFAULT_VOICE_INPUT_PREFERENCES;
  }
}

export function writeVoiceInputPreferences(
  patch: Partial<VoiceInputPreferences>,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = browserStorage()
): VoiceInputPreferences {
  const current = readVoiceInputPreferences(storage);
  let merged: Partial<VoiceInputPreferences> = { ...current, ...patch };
  if (patch.dictionaryTerms !== undefined && patch.dictionary === undefined) {
    const dictionary = mergeManualVoiceDictionaryTerms(current.dictionary, patch.dictionaryTerms);
    if (dictionary !== undefined) merged = { ...merged, dictionary };
  }
  const next = normalizeWritableVoiceInputPreferences(merged);
  if (storage !== undefined) storage.setItem(STORAGE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  return next;
}

export function subscribeVoiceInputPreferences(listener: (value: VoiceInputPreferences) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onLocalChange = (event: Event): void => {
    if (event instanceof CustomEvent) listener(parseVoiceInputPreferences(event.detail));
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) listener(readVoiceInputPreferences());
  };
  window.addEventListener(CHANGE_EVENT, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function voiceInputLocale(preferences: Pick<VoiceInputPreferences, "locale">): string | undefined {
  if (preferences.locale === "auto") return undefined;
  try {
    const values = Intl.getCanonicalLocales(preferences.locale);
    return values.length === 1 ? values[0] : undefined;
  } catch {
    return undefined;
  }
}

export function matchesVoiceInputShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">,
  preference: VoiceInputShortcutPreference,
  _platform = typeof navigator === "undefined" ? "" : navigator.platform
): boolean {
  return preference !== "disabled" && !preference.fn && matchesAppShortcutEvent(event, preference);
}

export function releasesVoiceInputShortcut(
  event: Pick<KeyboardEvent, "code">,
  preference: VoiceInputShortcutPreference,
  _platform = typeof navigator === "undefined" ? "" : navigator.platform
): boolean {
  if (preference === "disabled") return false;
  if (preference.fn) return false;
  if (event.code === preference.code) return true;
  if (preference.shift && (event.code === "ShiftLeft" || event.code === "ShiftRight")) return true;
  if (preference.alt && (event.code === "AltLeft" || event.code === "AltRight")) return true;
  if (preference.ctrl && (event.code === "ControlLeft" || event.code === "ControlRight")) return true;
  return preference.meta && (event.code === "MetaLeft" || event.code === "MetaRight");
}

export function formatVoiceInputShortcut(preference: VoiceInputShortcutPreference, platform = ""): string {
  if (preference === "disabled") return "";
  const nativeModifierLabel = MAC_BARE_VOICE_MODIFIER_LABELS[preference.code];
  if (nativeModifierLabel !== undefined && isVoiceInputBareModifierShortcut(preference)) return nativeModifierLabel;
  const formatted = formatAppShortcutCombo(preference, voiceShortcutPlatform(platform));
  return preference.fn ? `Fn+${formatted}` : formatted;
}

export function isVoiceInputBareModifierCode(code: string): boolean {
  return MAC_BARE_VOICE_MODIFIER_CODES.has(code);
}

export function isVoiceInputMacNativeModifierCode(code: string): boolean {
  return MAC_NATIVE_MODIFIER_CODES.has(code);
}

export function createVoiceInputBareModifierShortcut(code: string): VoiceInputShortcutCombo | undefined {
  if (!isVoiceInputBareModifierCode(code)) return undefined;
  return Object.freeze({ code, meta: false, ctrl: false, alt: false, shift: false, fn: false });
}

export function createVoiceInputShortcutFromMacNativeKeys(
  keys: readonly string[]
): VoiceInputShortcutCombo | undefined {
  if (keys.includes("Other")) return undefined;
  const unique = new Set(keys);
  if (unique.size !== keys.length) return undefined;
  if (keys.length === 1) return createVoiceInputBareModifierShortcut(keys[0] ?? "");
  if (!unique.has("Fn")) return undefined;
  const nonModifiers = keys.filter((key) => !MAC_NATIVE_MODIFIER_CODES.has(key));
  if (nonModifiers.length !== 1 || !MAC_NATIVE_VOICE_KEY_CODES.has(nonModifiers[0] ?? "")) return undefined;
  return Object.freeze({
    code: nonModifiers[0] as string,
    meta: unique.has("MetaLeft") || unique.has("MetaRight"),
    ctrl: unique.has("ControlLeft") || unique.has("ControlRight"),
    alt: unique.has("AltLeft") || unique.has("AltRight"),
    shift: unique.has("ShiftLeft") || unique.has("ShiftRight"),
    fn: true
  });
}

export function defaultVoiceInputShortcut(
  platform: AppShortcutPlatform = currentAppShortcutPlatform()
): VoiceInputShortcutCombo {
  return Object.freeze(platform === "darwin"
    ? { code: "Space", meta: false, ctrl: false, alt: true, shift: false, fn: false }
    : { code: "Space", meta: false, ctrl: true, alt: false, shift: true, fn: false });
}

export function voiceInputShortcutsEqual(left: VoiceInputShortcutPreference, right: VoiceInputShortcutPreference): boolean {
  return left === "disabled" || right === "disabled"
    ? left === right
    : appShortcutCombosEqual(left, right) && left.fn === right.fn;
}

export function parseVoiceInputPreferences(value: unknown): VoiceInputPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_VOICE_INPUT_PREFERENCES;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(",");
  if (
    (keys !== "autoDictionaryEnabled,dictionary,dictionaryTerms,fastActivationEnabled,locale,muteOtherSounds,playInteractionSound,refinementInstructions,shortcut"
      && keys !== "autoDictionaryEnabled,deviceId,dictionary,dictionaryTerms,fastActivationEnabled,locale,muteOtherSounds,playInteractionSound,refinementInstructions,shortcut")
    || typeof candidate["autoDictionaryEnabled"] !== "boolean"
    || typeof candidate["playInteractionSound"] !== "boolean"
    || typeof candidate["fastActivationEnabled"] !== "boolean"
    || typeof candidate["muteOtherSounds"] !== "boolean"
    || typeof candidate["locale"] !== "string"
  ) return DEFAULT_VOICE_INPUT_PREFERENCES;
  const locale = normalizeLocale(candidate["locale"]);
  const shortcut = normalizeVoiceInputShortcut(candidate["shortcut"]);
  const deviceId = normalizeDeviceId(candidate["deviceId"]);
  const refinementInstructions = normalizeRefinementInstructions(candidate["refinementInstructions"]);
  const dictionaryTerms = normalizeDictionaryTerms(candidate["dictionaryTerms"]);
  const dictionary = normalizeVoiceInputDictionaryState(candidate["dictionary"]);
  const currentDictionaryTerms = dictionary === undefined ? undefined : voiceDictionaryTermsForRefinement(dictionary);
  if (
    locale !== candidate["locale"]
    || shortcut === undefined
    || (Object.hasOwn(candidate, "deviceId") && deviceId !== candidate["deviceId"])
    || (Object.hasOwn(candidate, "refinementInstructions") && refinementInstructions !== candidate["refinementInstructions"])
    || dictionaryTerms === undefined
    || dictionary === undefined
    || currentDictionaryTerms === undefined
    || dictionaryTerms.length !== currentDictionaryTerms.length
    || dictionaryTerms.some((term, index) => term !== currentDictionaryTerms[index])
  ) return DEFAULT_VOICE_INPUT_PREFERENCES;
  return Object.freeze({
    locale,
    shortcut,
    ...(deviceId === undefined ? {} : { deviceId }),
    refinementInstructions,
    dictionary,
    dictionaryTerms: currentDictionaryTerms,
    autoDictionaryEnabled: candidate["autoDictionaryEnabled"],
    playInteractionSound: candidate["playInteractionSound"],
    fastActivationEnabled: candidate["fastActivationEnabled"],
    muteOtherSounds: candidate["muteOtherSounds"]
  });
}

function normalizeWritableVoiceInputPreferences(value: Partial<VoiceInputPreferences>): VoiceInputPreferences {
  const locale = normalizeLocale(value.locale);
  const shortcut = normalizeVoiceInputShortcut(value.shortcut) ?? defaultVoiceInputShortcut();
  const deviceId = normalizeDeviceId(value.deviceId);
  const refinementInstructions = normalizeRefinementInstructions(value.refinementInstructions);
  const dictionary = normalizeVoiceInputDictionaryState(value.dictionary)
    ?? EMPTY_VOICE_INPUT_DICTIONARY;
  const playInteractionSound = value.playInteractionSound !== false;
  const fastActivationEnabled = value.fastActivationEnabled === true;
  const muteOtherSounds = value.muteOtherSounds !== false;
  return Object.freeze({
    locale,
    shortcut,
    ...(deviceId === undefined ? {} : { deviceId }),
    refinementInstructions,
    dictionary,
    dictionaryTerms: voiceDictionaryTermsForRefinement(dictionary),
    autoDictionaryEnabled: value.autoDictionaryEnabled !== false,
    playInteractionSound,
    fastActivationEnabled,
    muteOtherSounds
  });
}

function normalizeVoiceInputShortcut(value: unknown): VoiceInputShortcutPreference | undefined {
  if (value === "disabled") return value;
  if (!hasCurrentVoiceInputShortcutShape(value)) return undefined;
  const nativeModifier = normalizeVoiceInputBareModifierShortcut(value);
  if (nativeModifier !== undefined) return nativeModifier;
  const normalized = normalizeAppShortcutCombo(value);
  if (normalized === undefined || typeof value !== "object" || value === null) return undefined;
  const fn = (value as Record<string, unknown>)["fn"] === true;
  if (fn ? !MAC_NATIVE_VOICE_KEY_CODES.has(normalized.code) : !isAppShortcutComboBindable(normalized)) return undefined;
  return Object.freeze({ ...normalized, fn });
}

function normalizeVoiceInputBareModifierShortcut(value: unknown): VoiceInputShortcutCombo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["code"] !== "string" || !isVoiceInputBareModifierCode(candidate["code"])) return undefined;
  if (candidate["meta"] !== false || candidate["ctrl"] !== false
    || candidate["alt"] !== false || candidate["shift"] !== false || candidate["fn"] === true) return undefined;
  if (candidate["key"] !== undefined && (typeof candidate["key"] !== "string" || candidate["key"].length > 32)) {
    return undefined;
  }
  return Object.freeze({
    code: candidate["code"],
    ...(typeof candidate["key"] === "string" ? { key: candidate["key"] } : {}),
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    fn: false
  });
}

function hasCurrentVoiceInputShortcutShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(",");
  return (keys === "alt,code,ctrl,fn,meta,shift" || keys === "alt,code,ctrl,fn,key,meta,shift")
    && typeof candidate["code"] === "string"
    && typeof candidate["meta"] === "boolean"
    && typeof candidate["ctrl"] === "boolean"
    && typeof candidate["alt"] === "boolean"
    && typeof candidate["shift"] === "boolean"
    && typeof candidate["fn"] === "boolean"
    && (!Object.hasOwn(candidate, "key") || typeof candidate["key"] === "string");
}

function isVoiceInputBareModifierShortcut(value: VoiceInputShortcutCombo): boolean {
  return isVoiceInputBareModifierCode(value.code)
    && !value.meta
    && !value.ctrl
    && !value.alt
    && !value.shift
    && !value.fn;
}

const MAC_BARE_VOICE_MODIFIER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  MetaLeft: "Left ⌘",
  MetaRight: "Right ⌘",
  AltLeft: "Left ⌥",
  AltRight: "Right ⌥",
  ControlLeft: "Left ⌃",
  ControlRight: "Right ⌃",
  Fn: "Fn"
});

function voiceShortcutPlatform(value: string): AppShortcutPlatform {
  if (/mac|iphone|ipad|ipod|darwin/iu.test(value)) return "darwin";
  if (/win/iu.test(value)) return "win32";
  return currentAppShortcutPlatform();
}

function normalizeLocale(value: unknown): string {
  if (value === "auto") return "auto";
  if (typeof value !== "string" || value.length === 0 || value.length > 35) return "auto";
  try {
    const locales = Intl.getCanonicalLocales(value);
    const locale = locales.length === 1 ? locales[0] : undefined;
    if (locale === undefined) return "auto";
    if (locale === "zh-CN" || locale === "zh-TW") return locale;
    const language = new Intl.Locale(locale).language.toLocaleLowerCase("en-US");
    return VOICE_INPUT_LOCALES.includes(language as typeof VOICE_INPUT_LOCALES[number]) ? language : "auto";
  } catch {
    return "auto";
  }
}

function normalizeDeviceId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function normalizeRefinementInstructions(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n?/gu, "\n");
  if (normalized.length > MAXIMUM_VOICE_REFINEMENT_INSTRUCTIONS_CHARACTERS || /\u0000/u.test(normalized)) return "";
  return normalized;
}

function normalizeDictionaryTerms(value: unknown): readonly string[] | undefined {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAXIMUM_VOICE_DICTIONARY_TERMS) return undefined;
  const terms: string[] = [];
  const seen = new Set<string>();
  let characters = 0;
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const term = item.replace(/\s+/gu, " ").trim();
    if (term.length === 0) continue;
    if (term.length > MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS || /[\u0000-\u001f\u007f]/u.test(term)) return undefined;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    characters += term.length;
    if (characters > MAXIMUM_VOICE_DICTIONARY_CHARACTERS) return undefined;
    seen.add(key);
    terms.push(term);
  }
  return Object.freeze(terms);
}

export function parseVoiceDictionaryCsv(value: string): VoiceDictionaryCsvParseResult {
  const rows = parseCsvRows(value.replace(/^\uFEFF/u, ""));
  if (rows === undefined) return { ok: false, reason: "invalid" };
  const terms: string[] = [];
  const seen = new Set<string>();
  let duplicateRows = 0;
  let skippedTooLong = 0;
  for (const row of rows) {
    if (row.some((field) => /\u0000/u.test(field))) return { ok: false, reason: "invalid" };
    const populated = row.map((field) => field.trim()).filter((field) => field.length > 0);
    if (populated.length === 0) continue;
    if (populated.length !== 1) return { ok: false, reason: "invalid" };
    const term = normalizeDictionaryTerm(populated[0]!);
    if (term === undefined) {
      skippedTooLong += 1;
      continue;
    }
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) {
      duplicateRows += 1;
      continue;
    }
    seen.add(key);
    terms.push(term);
  }
  return terms.length === 0
    ? { ok: false, reason: "empty" }
    : { ok: true, terms: Object.freeze(terms), duplicateRows, skippedTooLong };
}

function normalizeDictionaryTerm(value: string): string | undefined {
  const term = value.replace(/\s+/gu, " ").trim();
  if (
    term.length === 0 || term.length > MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS
    || /[\u0000-\u001f\u007f]/u.test(term)
  ) return undefined;
  return term;
}

function parseCsvRows(value: string): readonly (readonly string[])[] | undefined {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  const finishField = (): void => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      if (character !== '"') {
        field += character;
        continue;
      }
      if (value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        closedQuote = true;
      }
      continue;
    }
    if (character === '"') {
      if (field.length !== 0 || closedQuote) return undefined;
      quoted = true;
      continue;
    }
    if (character === ",") {
      finishField();
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      finishRow();
      continue;
    }
    if (closedQuote) {
      if (/\s/u.test(character)) continue;
      return undefined;
    }
    field += character;
  }
  if (quoted) return undefined;
  if (field.length > 0 || row.length > 0 || closedQuote) finishRow();
  return rows;
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try { return window.localStorage; } catch { return undefined; }
}
