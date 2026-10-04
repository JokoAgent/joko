import type { UiPreferences } from "./local-state.js";

const LOCALE_PREFERENCE_CHANNEL = "joko:locale-preference:v1";
const LOCALE_PREFERENCE_CHANGED = "locale-preference-changed";

/** A content-free hint: receivers always reload and validate their own durable record. */
export function publishLocalePreferenceChange(): void {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(LOCALE_PREFERENCE_CHANNEL);
    channel.postMessage({ kind: LOCALE_PREFERENCE_CHANGED });
  } catch {
    // The durable preference remains committed when cross-document messaging is unavailable.
  } finally {
    try { channel?.close(); } catch { /* Closing a failed channel is also best-effort. */ }
  }
}

export function subscribeLocalePreferenceChange(onChange: () => void): () => void {
  let channel: BroadcastChannel | undefined;
  let live = true;
  try {
    channel = new BroadcastChannel(LOCALE_PREFERENCE_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!live || !isLocalePreferenceMessage(event.data)) return;
      onChange();
    };
  } catch {
    live = false;
    try { channel?.close(); } catch { /* A partially initialized channel is best-effort. */ }
    return () => undefined;
  }
  return () => {
    if (!live) return;
    live = false;
    channel.onmessage = null;
    try { channel.close(); } catch { /* Cleanup stays idempotent if close is unavailable. */ }
  };
}

export function sameLocalePreference(left: UiPreferences, right: UiPreferences): boolean {
  return left.locale === right.locale;
}

export function withLocalePreference(current: UiPreferences, source: UiPreferences): UiPreferences {
  if (sameLocalePreference(current, source)) return current;
  return { ...current, locale: source.locale };
}

function isLocalePreferenceMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>)["kind"] === LOCALE_PREFERENCE_CHANGED;
}
