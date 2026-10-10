import type { PartnerDirectory, UpdatePartnerResponse } from "@joko/contracts";
import { mobilePartnerPhotoValid, type MobilePartnerAvatarDraft } from "./mobile-partner-avatar";
import { projectMobilePartnerCapabilities, projectMobilePartnerProfile,
  type MobilePartnerCapabilities, type MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileModelRoute } from "./mobile-runtime-controls";

export interface MobilePartnerProfileOptions {
  readonly revision: bigint;
  readonly avatarPresets: readonly string[];
  readonly defaultCapabilities?: MobilePartnerCapabilities;
}
export interface MobilePartnerProfileDraft {
  readonly displayName: string;
  readonly avatar: MobilePartnerAvatarDraft;
  readonly identitySource: string;
  readonly usesDirectoryDefaults: boolean;
  readonly capabilities: MobilePartnerCapabilities;
}
export interface MobilePartnerProfileSnapshot {
  readonly ownerKey: string;
  readonly partner: MobilePartnerDirectoryProfile;
  readonly options: MobilePartnerProfileOptions;
  readonly names: readonly { readonly partnerId: string; readonly displayName: string }[];
  readonly models: readonly MobileModelRoute[];
  readonly canSwitchModel: boolean;
  readonly canSetEffort: boolean;
  readonly canSetFastMode: boolean;
  readonly permissionModes: readonly MobilePartnerCapabilities["permissionMode"][];
  readonly canSetPlanMode: boolean;
}
export interface MobilePartnerProfileTransport {
  readonly ownerKey: string;
  load(partner: MobilePartnerDirectoryProfile, signal: AbortSignal): Promise<MobilePartnerProfileSnapshot>;
  save(snapshot: MobilePartnerProfileSnapshot, draft: MobilePartnerProfileDraft,
    signal: AbortSignal): Promise<MobilePartnerDirectoryProfile>;
}

const LABEL = /^[^\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u;
const TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u;
const normalizedName = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("en-US");
export type MobilePartnerProfileValidationCode = "name" | "nameTaken" | "identity" | "avatar" | "defaults" | "modelChain" | "modelUnavailable";
export class MobilePartnerProfileValidationError extends Error {
  constructor(readonly code: MobilePartnerProfileValidationCode, message: string) { super(message); }
}

export function projectMobilePartnerProfileOptions(value: PartnerDirectory | undefined): MobilePartnerProfileOptions {
  if (!value || !value.revision || value.revision.value < 1n || value.avatarPresets.length > 100
    || value.avatarPresets.some((preset) => !/^[a-z][a-z0-9-]{0,31}$/u.test(preset))
    || new Set(value.avatarPresets).size !== value.avatarPresets.length) {
    throw new Error("The Joko node returned invalid Partner profile options.");
  }
  return { revision: value.revision.value, avatarPresets: [...value.avatarPresets],
    ...(value.defaultCapabilities === undefined ? {} : {
      defaultCapabilities: projectMobilePartnerCapabilities(value.defaultCapabilities)
    }) };
}

export function mobilePartnerProfileDraft(partner: MobilePartnerDirectoryProfile): MobilePartnerProfileDraft {
  return { displayName: partner.displayName, avatar: partner.avatar, identitySource: partner.identitySource,
    capabilities: partner.capabilities, usesDirectoryDefaults: partner.usesDirectoryDefaults };
}

export function validateMobilePartnerProfileDraft(snapshot: MobilePartnerProfileSnapshot,
  draft: MobilePartnerProfileDraft): MobilePartnerProfileDraft {
  return validateMobilePartnerDraftFields(snapshot, draft, snapshot.partner.capabilities.modelChain[0]?.backendId,
    snapshot.partner);
}

export type MobilePartnerDraftFields = Omit<MobilePartnerProfileSnapshot, "partner">;

export function validateMobilePartnerDraftFields(snapshot: MobilePartnerDraftFields, draft: MobilePartnerProfileDraft,
  backendId: string | undefined, original?: MobilePartnerDirectoryProfile): MobilePartnerProfileDraft {
  const displayName = draft.displayName.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const identitySource = draft.identitySource.trim();
  if (displayName.length < 1 || displayName.length > 200 || !LABEL.test(displayName)) {
    throw new MobilePartnerProfileValidationError("name", "Enter a Partner name of 1–200 characters without control characters.");
  }
  if (snapshot.names.some((candidate) => candidate.partnerId !== original?.partnerId
    && normalizedName(candidate.displayName) === normalizedName(displayName))) {
    throw new MobilePartnerProfileValidationError("nameTaken", "Another Partner on this node already has that name.");
  }
  if (identitySource.length < 1 || identitySource.length > 8_000 || !TEXT.test(identitySource)) {
    throw new MobilePartnerProfileValidationError("identity", "Enter a Partner identity of 1–8,000 characters without control characters.");
  }
  if (typeof draft.avatar === "string" ? !snapshot.options.avatarPresets.includes(draft.avatar)
    : "base64" in draft.avatar ? !mobilePartnerPhotoValid(draft.avatar.base64)
      : !original || JSON.stringify(draft.avatar) !== JSON.stringify(original.avatar)) {
    throw new MobilePartnerProfileValidationError("avatar", "Select a current Partner avatar.");
  }
  const capabilities = draft.usesDirectoryDefaults ? snapshot.options.defaultCapabilities : draft.capabilities;
  if (!capabilities) throw new MobilePartnerProfileValidationError("defaults", "Partner directory defaults are not configured.");
  const chain = capabilities.modelChain;
  if (chain.length < 1 || chain.length > 3 || new Set(chain.map((route) => `${route.providerId}\u001f${route.modelId}`)).size !== chain.length
    || !["ask", "auto"].includes(capabilities.permissionMode)) throw new MobilePartnerProfileValidationError("modelChain", "Select 1–3 unique Partner model routes.");
  if (chain.length > 1 && !snapshot.canSwitchModel || !snapshot.permissionModes.includes(capabilities.permissionMode)
    || capabilities.planMode && !snapshot.canSetPlanMode) {
    throw new MobilePartnerProfileValidationError("modelUnavailable", "The selected Partner capability is no longer available.");
  }
  for (const route of chain) {
    const model = snapshot.models.find((candidate) => candidate.backendId === route.backendId
      && candidate.providerId === route.providerId && candidate.modelId === route.modelId);
    if (route.backendId !== backendId || !model
      || route.effort !== undefined && !model.efforts.some((effort) => effort.id === route.effort)
      || (model.efforts.length > 0) !== (route.effort !== undefined) || route.effort !== undefined && !snapshot.canSetEffort
      || route.fastMode && (!model.supportsFastMode || !snapshot.canSetFastMode)) {
      throw new MobilePartnerProfileValidationError("modelUnavailable", "A selected Partner model or option is no longer available.");
    }
  }
  return { ...draft, displayName, identitySource, capabilities };
}

export function projectMobilePartnerProfileUpdate(partnerId: string, expectedRevision: bigint,
  response: UpdatePartnerResponse): MobilePartnerDirectoryProfile {
  if (!response.partner) throw new Error("The Joko node returned no updated Partner profile.");
  const partner = projectMobilePartnerProfile(response.partner);
  projectMobilePartnerProfileOptions(response.directory);
  if (partner.partnerId !== partnerId || partner.revision < expectedRevision) {
    throw new Error("The Joko node returned a mismatched Partner profile update.");
  }
  return partner;
}
