import {
  isDesktopSessionWindowOwner,
  type DesktopSessionWindowOwner
} from "./channels.js";

export const MAXIMUM_SESSION_WINDOWS = 32;

/** Stable private map/file key for the complete task-window authority. */
export function sessionWindowOwnerKey(owner: DesktopSessionWindowOwner): string {
  if (!isDesktopSessionWindowOwner(owner)) throw new TypeError("Task window owner is invalid.");
  return JSON.stringify([owner.profileId, owner.sessionId]);
}

/** A child Task window may only create another window on its bound profile. */
export function sessionWindowOwnerMayRequest(
  sender: DesktopSessionWindowOwner | undefined,
  requested: DesktopSessionWindowOwner
): boolean {
  return isDesktopSessionWindowOwner(requested)
    && (sender === undefined || (isDesktopSessionWindowOwner(sender) && sender.profileId === requested.profileId));
}
