import type { UiPreferences } from "./local-state.js";

const APPEARANCE_PREFERENCES_CHANNEL = "joko:appearance-preferences:v1";
const APPEARANCE_PREFERENCES_CHANGED = "appearance-preferences-changed";

/** A content-free hint: receivers always reload and validate their own durable record. */
export function publishAppearancePreferencesChange(): void {
  try {
    const channel = new BroadcastChannel(APPEARANCE_PREFERENCES_CHANNEL);
    channel.postMessage({ kind: APPEARANCE_PREFERENCES_CHANGED });
    channel.close();
  } catch { /* Preference persistence remains usable when cross-window messaging is unavailable. */ }
}

export function subscribeAppearancePreferencesChange(onChange: () => void): () => void {
  try {
    const channel = new BroadcastChannel(APPEARANCE_PREFERENCES_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === 1
        && (value as Record<string, unknown>)["kind"] === APPEARANCE_PREFERENCES_CHANGED) onChange();
    };
    return () => channel.close();
  } catch { return () => undefined; }
}

export function sameAppearanceProjection(left: UiPreferences, right: UiPreferences): boolean {
  return left.theme === right.theme
    && left.uiFamily === right.uiFamily
    && left.codeFamily === right.codeFamily
    && left.uiSize === right.uiSize
    && left.codeSize === right.codeSize
    && left.windowZoom === right.windowZoom;
}

export function withAppearanceProjection(current: UiPreferences, source: UiPreferences): UiPreferences {
  if (sameAppearanceProjection(current, source)) return current;
  return {
    ...current,
    theme: source.theme,
    uiFamily: source.uiFamily,
    codeFamily: source.codeFamily,
    uiSize: source.uiSize,
    codeSize: source.codeSize,
    windowZoom: source.windowZoom
  };
}
