import type { ConnectionProfile } from "./model.js";

export const CONTACTS_TOOL_POLICY_ID = "joko-contacts-tools";

export interface ContactsDraftOwner {
  readonly profileId: string;
  readonly serverId: string;
}

export function contactsDraftOwnerMatches(owner: ContactsDraftOwner, profile: ConnectionProfile | undefined): boolean {
  return profile?.id === owner.profileId && profile.serverId === owner.serverId;
}
