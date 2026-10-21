import type { SessionDescriptor } from "@joko/core";
import type { OperationalStore, PartnerStore } from "@joko/store";
import type { PartnerMemoryPreferences } from "./partner-memory-preferences.js";
import type { MakerMemoryController } from "./maker-memory.js";

interface PrivateProjection { readonly identity: string; readonly user: string; readonly instructions: string }
export class PartnerRuntimePromptResolver {
  constructor(readonly profiles: PartnerStore, readonly store: OperationalStore, readonly preferences: PartnerMemoryPreferences,
    readonly readEnvironment: (partnerId: string, assertCurrent: () => void) => Promise<{ readonly profileProjection: PrivateProjection } | undefined>, readonly memory?: MakerMemoryController,
    readonly validGroupTarget: (session: SessionDescriptor, partnerId: string) => boolean = () => false) {}
  async resolve(session: SessionDescriptor, assertCurrent: () => void): Promise<string | undefined> {
    const link = this.profiles.getSessionLink(session.id); if (!link) return undefined;
    const profile = this.profiles.getPartner(link.partnerId);
    const groupTarget = link.role === "group" && link.profileVersion === profile.profileVersion && this.validGroupTarget(session, profile.id);
    if (profile.lifecycle !== "active" || profile.initializationState !== "ready" || session.targetId !== profile.homeTargetId && !groupTarget
      || !this.store.getTarget(session.targetId).descriptor.trusted) return undefined;
    const identitySource = link.role === "canonical" || groupTarget ? profile.identitySource
      : this.profiles.listProfileVersions(profile.id).find(version => version.version === link.profileVersion)?.identitySource;
    if (identitySource === undefined) return undefined;
    const assertOwner = () => {
      assertCurrent(); const current = this.profiles.getPartner(profile.id); const currentLink = this.profiles.getSessionLink(session.id);
      if (current.revision !== profile.revision || current.lifecycle !== "active" || current.initializationState !== "ready"
        || currentLink?.partnerId !== link.partnerId || currentLink.profileVersion !== link.profileVersion || currentLink.role !== link.role
        || groupTarget && !this.validGroupTarget(this.store.getSession(session.id).descriptor, profile.id)) throw new Error("The private runtime identity owner changed.");
    };
    const carried = this.store.findSetting<PrivateProjection>("target", profile.homeTargetId, "partner-home.profile")?.value;
    const environment = carried ? undefined : await this.readEnvironment(profile.id, assertOwner); assertOwner();
    const preferences = this.preferences.read(profile.homeTargetId);
    const memoryPrompt = this.memory && this.store.getBackend(session.backendId).descriptor.capabilities.get("memory.curated")?.supported !== true
      ? this.memory.runtimePrompt(profile.homeTargetId) : undefined;
    let carriedEnd = Math.min(carried?.identity.length ?? 0, 8000);
    if (carried && carriedEnd < carried.identity.length && /[\uD800-\uDBFF]/u.test(carried.identity[carriedEnd - 1] ?? "")) carriedEnd--;
    const carriedIdentity = carried && identitySource === carried.identity.slice(0, carriedEnd).trim() ? carried.identity : identitySource;
    if (!environment) return [carriedIdentity,
      (preferences.userContext ?? carried?.user)?.trim() && `## User context\n${(preferences.userContext ?? carried?.user)!.trim()}`,
      carried?.instructions && `## Instructions\n${carried.instructions}`, memoryPrompt].filter(Boolean).join("\n\n");
    const projection = environment.profileProjection;
    let prefixEnd = Math.min(projection.identity.length, 8000);
    if (prefixEnd < projection.identity.length && /[\uD800-\uDBFF]/u.test(projection.identity[prefixEnd - 1] ?? "")) prefixEnd--;
    const identity = projection.identity && identitySource === projection.identity.slice(0, prefixEnd).trim() ? projection.identity : identitySource;
    const user = (preferences.userContext ?? projection.user).trim();
    return [identity, user && `## User context\n${user}`, projection.instructions && `## Instructions\n${projection.instructions}`, memoryPrompt,
      "## Imported resources\nUse joko_imported_connections.setup_status to read saved, verified and active setup state. Continue verification or schedule takeover only when requested. Use continue_setup for the original request, and use_current_settings for explicit model/tool mapping. Read complete imported documents with list_documents/read_document and run imported commands with run_command so private environment values and original skill resources remain isolated."].filter(Boolean).join("\n\n");
  }
}
