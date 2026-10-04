import {
  APP_SHORTCUT_IDS,
  type AppShortcutCombo,
  type AppShortcutOverrideValue
} from "./app-shortcuts.js";
import type { UiPreferences } from "./local-state.js";

const APP_SHORTCUT_PREFERENCES_CHANNEL = "joko:app-shortcut-preferences:v1";
const APP_SHORTCUT_PREFERENCES_CHANGED = "app-shortcut-preferences-changed";

/** A content-free hint: receivers always reload and validate their own durable record. */
export function publishAppShortcutPreferencesChange(): void {
  try {
    const channel = new BroadcastChannel(APP_SHORTCUT_PREFERENCES_CHANNEL);
    channel.postMessage({ kind: APP_SHORTCUT_PREFERENCES_CHANGED });
    channel.close();
  } catch { /* Preference persistence remains usable when cross-window messaging is unavailable. */ }
}

export function subscribeAppShortcutPreferencesChange(onChange: () => void): () => void {
  try {
    const channel = new BroadcastChannel(APP_SHORTCUT_PREFERENCES_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === 1
        && (value as Record<string, unknown>)["kind"] === APP_SHORTCUT_PREFERENCES_CHANGED) onChange();
    };
    return () => channel.close();
  } catch { return () => undefined; }
}

export function sameAppShortcutProjection(left: UiPreferences, right: UiPreferences): boolean {
  return APP_SHORTCUT_IDS.every((id) => sameOverride(
    left.appShortcutOverrides[id],
    right.appShortcutOverrides[id]
  ));
}

export function withAppShortcutProjection(current: UiPreferences, source: UiPreferences): UiPreferences {
  if (sameAppShortcutProjection(current, source)) return current;
  return {
    ...current,
    appShortcutOverrides: { ...source.appShortcutOverrides }
  };
}

function sameOverride(left: AppShortcutOverrideValue | undefined, right: AppShortcutOverrideValue | undefined): boolean {
  if (left === undefined || right === undefined || left === null || right === null) return left === right;
  return sameNormalizedCombo(left, right);
}

function sameNormalizedCombo(left: AppShortcutCombo, right: AppShortcutCombo): boolean {
  return left.code === right.code
    && left.key === right.key
    && left.meta === right.meta
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift;
}
