import type { SessionDraftSurface } from "./local-state.js";
import { isSessionApplicationWindow } from "./session-window-navigation.js";

/** A native task instance supplies only its stable local draft slot. */
export async function sessionDraftSurface(profileId: string, sessionId: string, isCurrent: () => boolean, sideChatSourceAnchor?: string): Promise<SessionDraftSurface> {
  const search = window.location.search;
  const query = new URLSearchParams(search);
  if (!query.has("sessionWindow")) return "application";
  const ownerSessionId = sideChatSourceAnchor ?? sessionId;
  if (sideChatSourceAnchor === sessionId || !ownerSessionId || !isSessionApplicationWindow(window.location)
    || query.get("bootSession") !== ownerSessionId) throw new Error("The task draft window owner is invalid.");
  const bridge = window.jokoDesktop?.sessionWindows;
  if (bridge?.getOwner === undefined || !isCurrent()) throw new Error("The task draft window owner is no longer current.");
  let retired = false;
  const retire = () => { retired = true; };
  window.addEventListener("pagehide", retire, { once: true });
  try {
    const owner = await bridge.getOwner();
    if (retired || !isCurrent() || window.location.search !== search || window.jokoDesktop?.sessionWindows !== bridge) {
      throw new Error("The task draft window owner is no longer current.");
    }
    if (owner === null || typeof owner !== "object" || Object.keys(owner).sort().join(",") !== "draftSlot,profileId,sessionId"
      || owner.profileId !== profileId || owner.sessionId !== ownerSessionId || !Number.isSafeInteger(owner.draftSlot) || owner.draftSlot < 0) {
      throw new Error("The task draft window owner is invalid.");
    }
    return `task-window:${owner.draftSlot}`;
  } finally { window.removeEventListener("pagehide", retire); }
}
