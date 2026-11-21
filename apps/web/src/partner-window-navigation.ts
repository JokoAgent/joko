import type { DragEvent } from "react";
import type { ConnectionProfile } from "./model.js";
import { cancelSessionWindowDragPreview, sessionWindowDragPreviewAvailable, startSessionWindowDragPreview } from "./session-window-drag-preview.js";
import { validSessionWindowId } from "./session-window-navigation.js";

export function partnerApplicationWindowIdentity(location: Pick<Location, "search">): JokoDesktopPartnerWindowOwner | undefined {
  const query = new URLSearchParams(location.search);
  if ([...query.keys()].sort().join(",") !== "bootPartner,partnerWindow,profile,server") return undefined;
  const kind = query.get("partnerWindow");
  const conversationId = query.get("bootPartner"), profileId = query.get("profile"), serverId = query.get("server");
  return (kind === "private" || kind === "group") && validSessionWindowId(conversationId)
    && validSessionWindowId(profileId) && validSessionWindowId(serverId)
    ? { kind, conversationId, profileId, serverId } : undefined;
}

export function partnerWindowMatchesProfile(owner: JokoDesktopPartnerWindowOwner, profile: ConnectionProfile | undefined): boolean {
  return profile?.id === owner.profileId && profile.serverId === owner.serverId;
}

export function partnerConversationDragProps<E extends HTMLElement>(
  profile: Pick<ConnectionProfile, "id" | "serverId"> | undefined,
  kind: JokoDesktopPartnerWindowOwner["kind"],
  conversationId: string,
  label: string,
  hint: string
): { draggable?: true; onDragStart?: (event: DragEvent<E>) => void } {
  if (profile === undefined || typeof window === "undefined" || window.jokoDesktop?.sessionWindows?.getPartnerOwner === undefined
    || !sessionWindowDragPreviewAvailable(window)) return {};
  const partnerWindow = { kind, profileId: profile.id, serverId: profile.serverId, conversationId };
  return {
    draggable: true,
    onDragStart: (event) => {
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow === null || !startSessionWindowDragPreview({
        dataTransfer: event.dataTransfer, row: event.currentTarget, partnerWindow, label, hint, ownerWindow
      })) {
        event.preventDefault();
        return;
      }
      try {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-joko-partner-conversation", "1");
      } catch {
        cancelSessionWindowDragPreview(ownerWindow);
        event.preventDefault();
        return;
      }
      event.stopPropagation();
    }
  };
}
