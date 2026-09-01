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
  window.dispatchEvent(new CustomEvent(CLIENT_LAYOUT_RESET_EVENT));
}
