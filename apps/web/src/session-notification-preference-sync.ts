import type { UiPreferences } from "./local-state.js";

const SESSION_NOTIFICATION_PREFERENCE_CHANNEL = "joko:session-notification-preference:v1";
const SESSION_NOTIFICATION_PREFERENCE_CHANGED = "session-notification-preference-changed";

/** A content-free hint: receivers always reload and validate their own durable record. */
export function publishSessionNotificationPreferenceChange(): void {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(SESSION_NOTIFICATION_PREFERENCE_CHANNEL);
    channel.postMessage({ kind: SESSION_NOTIFICATION_PREFERENCE_CHANGED });
  } catch {
    // The durable preference remains committed when cross-document messaging is unavailable.
  } finally {
    try { channel?.close(); } catch { /* Closing a failed channel is also best-effort. */ }
  }
}

export function subscribeSessionNotificationPreferenceChange(onChange: () => void): () => void {
  let channel: BroadcastChannel | undefined;
  let live = true;
  try {
    channel = new BroadcastChannel(SESSION_NOTIFICATION_PREFERENCE_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!live || !isSessionNotificationPreferenceMessage(event.data)) return;
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

export function sameSessionNotificationPreference(left: UiPreferences, right: UiPreferences): boolean {
  return left.sessionNotificationsEnabled === right.sessionNotificationsEnabled;
}

export function withSessionNotificationPreference(current: UiPreferences, source: UiPreferences): UiPreferences {
  if (sameSessionNotificationPreference(current, source)) return current;
  return {
    ...current,
    sessionNotificationsEnabled: source.sessionNotificationsEnabled
  };
}

function isSessionNotificationPreferenceMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>)["kind"] === SESSION_NOTIFICATION_PREFERENCE_CHANGED;
}
