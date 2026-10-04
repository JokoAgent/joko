import { setModelPickerLayout } from "./model-picker-preferences.js";
import { writeSessionSplitLayout } from "./session-split-layout.js";
import {
  WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY,
  WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY
} from "./workspace-chat-rail.js";

export const CLIENT_LAYOUT_RESET_EVENT = "joko:client-layout-reset";
export const INSPECTOR_RATIO_STORAGE_KEY = "joko.session.inspectorRatio";
export const INSPECTOR_SIDE_STORAGE_KEY = "joko.session.inspectorSide";
export const SCHEDULE_LIST_WIDTH_STORAGE_KEY = "joko.scheduler.listWidth";
export const SCHEDULE_COLLAPSED_GROUPS_STORAGE_KEY = "joko.scheduler.collapsedProjects";
export const MODEL_PICKER_LAYOUT_STORAGE_KEY = "joko:model-picker-layout:v1";

const CLIENT_LAYOUT_RESET_CHANNEL = "joko:client-layout-reset:v1";
const CLIENT_LAYOUT_RESET_MESSAGE = "client-layout-reset";

/** Publish a content-free occurrence; each receiver resets its own current layout. */
export function publishClientLayoutResetOccurrence(): void {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CLIENT_LAYOUT_RESET_CHANNEL);
    channel.postMessage({ kind: CLIENT_LAYOUT_RESET_MESSAGE });
  } catch {
    // The initiating document's local reset remains successful without cross-document messaging.
  } finally {
    try { channel?.close(); } catch { /* Closing a failed channel is also best-effort. */ }
  }
}

export function subscribeClientLayoutResetOccurrence(onReset: () => void): () => void {
  let channel: BroadcastChannel | undefined;
  let live = true;
  try {
    channel = new BroadcastChannel(CLIENT_LAYOUT_RESET_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!live || !isClientLayoutResetMessage(event.data)) return;
      onReset();
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

export function layoutResetPersistsSessionSplit(search: string): boolean {
  return new URLSearchParams(search).get("sessionWindow") !== "1";
}

/** Reset view geometry only. Content, drafts, profiles, credentials and theme are untouched. */
export function resetClientLayout(ownerId?: string, persistSplit = true): void {
  if (ownerId !== undefined && ownerId.trim() !== "") writeSessionSplitLayout(ownerId, {}, persistSplit);
  try {
    for (const key of [
      INSPECTOR_RATIO_STORAGE_KEY,
      INSPECTOR_SIDE_STORAGE_KEY,
      WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY,
      WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY,
      SCHEDULE_LIST_WIDTH_STORAGE_KEY,
      SCHEDULE_COLLAPSED_GROUPS_STORAGE_KEY,
      MODEL_PICKER_LAYOUT_STORAGE_KEY
    ]) window.localStorage.removeItem(key);
  } catch {
    // Component-local fallbacks are reset by the event below.
  }
  setModelPickerLayout("original");
  window.dispatchEvent(new CustomEvent(CLIENT_LAYOUT_RESET_EVENT));
}

function isClientLayoutResetMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>)["kind"] === CLIENT_LAYOUT_RESET_MESSAGE;
}
