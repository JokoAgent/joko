import type { PersonalizationPrompts, UiPreferences } from "./local-state.js";

const CONVERSATION_PREFERENCES_CHANNEL = "joko:conversation-preferences:v1";
const CONVERSATION_PREFERENCES_CHANGED = "conversation-preferences-changed";

/** A content-free hint: receivers always reload and validate their own durable record. */
export function publishConversationPreferencesChange(): void {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CONVERSATION_PREFERENCES_CHANNEL);
    channel.postMessage({ kind: CONVERSATION_PREFERENCES_CHANGED });
  } catch {
    // The durable preference remains committed when cross-document messaging is unavailable.
  } finally {
    try { channel?.close(); } catch { /* Closing a failed channel is also best-effort. */ }
  }
}

export function subscribeConversationPreferencesChange(onChange: () => void): () => void {
  let channel: BroadcastChannel | undefined;
  let live = true;
  try {
    channel = new BroadcastChannel(CONVERSATION_PREFERENCES_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!live || !isConversationPreferencesMessage(event.data)) return;
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

export function sameConversationPreferences(left: UiPreferences, right: UiPreferences): boolean {
  return left.composerSendShortcut === right.composerSendShortcut
    && left.messageNavRailEnabled === right.messageNavRailEnabled
    && left.streamFadeEnabled === right.streamFadeEnabled
    && left.webLinkOpenPreference === right.webLinkOpenPreference
    && left.localLinkOpenPreference === right.localLinkOpenPreference
    && left.newSessionWorktreeEnabled === right.newSessionWorktreeEnabled
    && samePersonalizationPrompts(left.personalizationPrompts, right.personalizationPrompts);
}

export function withConversationPreferences(current: UiPreferences, source: UiPreferences): UiPreferences {
  if (sameConversationPreferences(current, source)) return current;
  return {
    ...current,
    composerSendShortcut: source.composerSendShortcut,
    messageNavRailEnabled: source.messageNavRailEnabled,
    streamFadeEnabled: source.streamFadeEnabled,
    webLinkOpenPreference: source.webLinkOpenPreference,
    localLinkOpenPreference: source.localLinkOpenPreference,
    newSessionWorktreeEnabled: source.newSessionWorktreeEnabled,
    personalizationPrompts: source.personalizationPrompts
  };
}

function samePersonalizationPrompts(left: PersonalizationPrompts, right: PersonalizationPrompts): boolean {
  if (left === right) return true;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  // Saving an owner moves it to the newest end; order decides eviction at the cap.
  return leftEntries.length === rightEntries.length && leftEntries.every(([owner, prompt], index) => (
    rightEntries[index]?.[0] === owner && rightEntries[index]?.[1] === prompt
  ));
}

function isConversationPreferencesMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>)["kind"] === CONVERSATION_PREFERENCES_CHANGED;
}
