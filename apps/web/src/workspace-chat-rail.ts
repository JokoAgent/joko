export const WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH = 400;
export const WORKSPACE_CHAT_RAIL_MIN_WIDTH = 400;
export const WORKSPACE_CHAT_RAIL_MAX_WIDTH = 1120;
export const WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY = "joko.workspaceFiles.chatRailWidth.v1";
export const WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY = "joko.workspaceFiles.chatRailCollapsed.v1";

export function clampWorkspaceChatRailWidth(value: number): number {
  if (!Number.isFinite(value)) return WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH;
  return Math.min(WORKSPACE_CHAT_RAIL_MAX_WIDTH, Math.max(WORKSPACE_CHAT_RAIL_MIN_WIDTH, Math.round(value)));
}

/** The handle is on the left edge of a right rail, so movement is inverted. */
export function workspaceChatRailDragWidth(startWidth: number, startX: number, clientX: number): number {
  return clampWorkspaceChatRailWidth(startWidth - (clientX - startX));
}

export function readWorkspaceChatRailWidth(storage: Pick<Storage, "getItem"> | undefined): number {
  try {
    const raw = storage?.getItem(WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY);
    if (raw === undefined || raw === null || raw.trim() === "") return WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH;
    return clampWorkspaceChatRailWidth(Number(raw));
  } catch {
    return WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH;
  }
}

export function readWorkspaceChatRailCollapsed(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}
