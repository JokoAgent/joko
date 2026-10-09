import { create } from "@bufbuild/protobuf";
import { PartnerProfileSchema, PartnerLifecycle, PartnerInitializationState, PartnerInvitationStage, PermissionMode } from "@joko/contracts";
import type { MobilePartnerDirectoryProfile } from "../mobile-partner-directory";
import type { MobilePartnerProfileSnapshot } from "../mobile-partner-profile";

export const profilePartner: MobilePartnerDirectoryProfile = {
  partnerId: "partner-a", revision: 2n, profileVersion: 3n, displayName: "Ada", avatar: "orbit",
  identitySource: "Product work", templateId: "general", lifecycle: "active", initializationState: "ready",
  invitationStage: "ready", homeTargetId: "target", canonicalSessionId: "session", usesDirectoryDefaults: false,
  capabilities: { modelChain: [{ backendId: "backend", providerId: "alpha", modelId: "a", effort: "low", fastMode: false }],
    permissionMode: "ask", planMode: false }, createdAt: 1_000, updatedAt: 2_000,
  activity: { partnerId: "partner-a", unreadReplyCount: 0, artifactCount: 0, activeDelegationCount: 0,
    readThroughCursor: 0n, readUpdatedAt: 1_000 }
};
export const profileSnapshot: MobilePartnerProfileSnapshot = {
  ownerKey: "owner", partner: profilePartner,
  options: { revision: 4n, avatarPresets: ["orbit", "spark", "leaf", "wave"], defaultCapabilities: profilePartner.capabilities },
  names: [{ partnerId: "partner-a", displayName: "Ada" }, { partnerId: "partner-b", displayName: "Bea" }],
  models: ["a", "b"].map((modelId, index) => ({ key: `route-${modelId}`, backendId: "backend",
    providerId: index === 0 ? "alpha" : "beta", modelId, providerName: index === 0 ? "Alpha Provider" : "Beta Provider",
    displayName: index === 0 ? "Alpha" : "Beta", family: "family", contextWindowTokens: 100n, maximumOutputTokens: 50n,
    efforts: [{ id: "low", label: "Low", order: 0, default: true }], supportsFastMode: true })),
  canSwitchModel: true, canSetEffort: true, canSetFastMode: true, permissionModes: ["ask", "auto"], canSetPlanMode: true
};

export function profilePartnerWire(partner = profilePartner) {
  return create(PartnerProfileSchema, {
    partnerId: partner.partnerId, revision: { value: partner.revision }, profileVersion: partner.profileVersion,
    displayName: partner.displayName, avatar: partner.avatar, identitySource: partner.identitySource, templateId: partner.templateId,
    lifecycle: PartnerLifecycle.ACTIVE, initializationState: PartnerInitializationState.READY, invitationStage: PartnerInvitationStage.READY,
    homeTargetId: partner.homeTargetId, canonicalSessionId: partner.canonicalSessionId, usesDirectoryDefaults: partner.usesDirectoryDefaults,
    capabilities: { modelChain: [...partner.capabilities.modelChain], permissionMode: PermissionMode.ASK, planMode: false },
    createdAt: { seconds: 1n }, updatedAt: { seconds: 2n }, activity: {
      partnerId: partner.partnerId, readThroughCursor: { value: 0n }, readUpdatedAt: { seconds: 1n }
    }
  });
}
