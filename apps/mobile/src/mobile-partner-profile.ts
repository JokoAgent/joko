import type { PartnerDirectory, UpdatePartnerResponse } from "@joko/contracts";
import { mobilePartnerPhotoValid, type MobilePartnerAvatarDraft } from "./mobile-partner-avatar";
import { projectMobilePartnerCapabilities, projectMobilePartnerProfile,
  type MobilePartnerCapabilities, type MobilePartnerDirectoryProfile, type MobilePartnerModelRoute } from "./mobile-partner-directory";
import type { MobileModelRoute } from "./mobile-runtime-controls";

export interface MobilePartnerProfileOptions {
  readonly revision: bigint;
  readonly avatarPresets: readonly string[];
  readonly defaultCapabilities?: MobilePartnerCapabilities;
}
export interface MobilePartnerProfileDraft {
  readonly displayName: string;
  readonly description: string;
  readonly avatar: MobilePartnerAvatarDraft;
  readonly identitySource: string;
  readonly usesDirectoryDefaults: boolean;
  readonly capabilities: MobilePartnerCapabilities;
  readonly taskModelOverride?: MobilePartnerModelRoute;
}
export interface MobilePartnerProfileSnapshot {
  readonly tasks?: readonly import("@joko/contracts").PartnerSessionTaskView[];
  readonly ownerKey: string;
  readonly partner: MobilePartnerDirectoryProfile;
  readonly options: MobilePartnerProfileOptions;
  readonly names: readonly { readonly partnerId: string; readonly displayName: string }[];
  readonly models: readonly MobileModelRoute[];
  readonly taskModels?: readonly MobilePartnerTaskModel[];
  readonly canSwitchModel: boolean;
  readonly canSetEffort: boolean;
  readonly canSetFastMode: boolean;
  readonly permissionModes: readonly MobilePartnerCapabilities["permissionMode"][];
  readonly canSetPlanMode: boolean;
}
export interface MobilePartnerTaskModel extends MobileModelRoute {
  readonly canSwitchModel?: boolean;
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
  controlTask?(snapshot: MobilePartnerProfileSnapshot, task: import("@joko/contracts").PartnerSessionTaskView, action: "pause" | "resume" | "cancel", signal: AbortSignal): Promise<void>;
  openTask?(snapshot: MobilePartnerProfileSnapshot, task: import("@joko/contracts").PartnerSessionTaskView, signal: AbortSignal): Promise<void>;
  listOutputs?(snapshot: MobilePartnerProfileSnapshot, signal: AbortSignal): Promise<import("./mobile-partner-task-outputs").MobilePartnerTaskOutputs>;
  openOutputTask?(snapshot: MobilePartnerProfileSnapshot, row: import("./mobile-partner-task-outputs").MobilePartnerTaskOutput, signal: AbortSignal): Promise<void>;
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
  return { displayName: partner.displayName, description: partner.description, avatar: partner.avatar, identitySource: partner.identitySource,
    capabilities: partner.capabilities, usesDirectoryDefaults: partner.usesDirectoryDefaults,
    ...(partner.taskModelOverride === undefined ? {} : { taskModelOverride: partner.taskModelOverride }) };
}

export function validateMobilePartnerProfileDraft(snapshot: MobilePartnerProfileSnapshot,
  draft: MobilePartnerProfileDraft): MobilePartnerProfileDraft {
  return validateMobilePartnerDraftFields(snapshot, draft, snapshot.partner.capabilities.modelChain[0]?.backendId,
    snapshot.partner);
}

export type MobilePartnerDraftFields = Omit<MobilePartnerProfileSnapshot, "partner">;

export function mobilePartnerDraftCatalogIdentity(snapshot: MobilePartnerDraftFields): string {
  return JSON.stringify({ options: snapshot.options, names: snapshot.names, models: snapshot.models, taskModels: snapshot.taskModels,
    canSwitchModel: snapshot.canSwitchModel, canSetEffort: snapshot.canSetEffort, canSetFastMode: snapshot.canSetFastMode,
    canSetPlanMode: snapshot.canSetPlanMode, permissionModes: snapshot.permissionModes },
  (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

export function validateMobilePartnerDraftFields(snapshot: MobilePartnerDraftFields, draft: MobilePartnerProfileDraft,
  backendId: string | undefined, original?: MobilePartnerDirectoryProfile): MobilePartnerProfileDraft {
  const displayName = draft.displayName.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const description = draft.description.replace(/\r\n?/gu, "\n").trim();
  const identitySource = draft.identitySource.trim();
  if (displayName.length < 1 || displayName.length > 200 || !LABEL.test(displayName)) {
    throw new MobilePartnerProfileValidationError("name", "Enter a Partner name of 1–200 characters without control characters.");
  }
  if (snapshot.names.some((candidate) => candidate.partnerId !== original?.partnerId
    && normalizedName(candidate.displayName) === normalizedName(displayName))) {
    throw new MobilePartnerProfileValidationError("nameTaken", "Another Partner on this node already has that name.");
  }
  if (description.length > 12_000 || description !== "" && !TEXT.test(description)) {
    throw new MobilePartnerProfileValidationError("identity", "The introduction exceeds its limit or contains invalid text.");
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
  if (chain.length < 1 || chain.length > 5 || new Set(chain.map((route) => `${route.backendId}\u001f${route.providerId}\u001f${route.modelId}`)).size !== chain.length
    || !["ask", "auto", "bypassPermissions"].includes(capabilities.permissionMode)) throw new MobilePartnerProfileValidationError("modelChain", "Select 1–5 unique Partner model routes.");
  for (const route of chain) {
    const model = snapshot.models.find((candidate) => candidate.backendId === route.backendId
      && candidate.providerId === route.providerId && candidate.modelId === route.modelId);
    const axes = snapshot.taskModels?.find(candidate => candidate.backendId === route.backendId
      && candidate.providerId === route.providerId && candidate.modelId === route.modelId) ?? (route.backendId === backendId ? snapshot : undefined);
    if (!model || !axes || !axes.permissionModes.includes(capabilities.permissionMode) || capabilities.planMode && !axes.canSetPlanMode
      || chain.filter(candidate => candidate.backendId === route.backendId).length > 1 && !axes.canSwitchModel
      || route.effort !== undefined && !model.efforts.some((effort) => effort.id === route.effort)
      || (model.efforts.length > 0) !== (route.effort !== undefined) || route.effort !== undefined && !axes.canSetEffort
      || route.fastMode && (!model.supportsFastMode || !axes.canSetFastMode)) {
      throw new MobilePartnerProfileValidationError("modelUnavailable", "A selected Partner capability, model or option is no longer available.");
    }
  }
  const task = draft.taskModelOverride;
  if (task !== undefined && (JSON.stringify(task) !== JSON.stringify(original?.taskModelOverride)
    || capabilities.permissionMode !== original?.capabilities.permissionMode || capabilities.planMode !== original?.capabilities.planMode)) {
    const model = snapshot.taskModels?.find(candidate => candidate.backendId === task.backendId
      && candidate.providerId === task.providerId && candidate.modelId === task.modelId);
    if (!original || !model || !model.permissionModes.includes(capabilities.permissionMode) || capabilities.planMode && !model.canSetPlanMode
      || (model.efforts.length > 0) !== (task.effort !== undefined)
      || task.effort !== undefined && (!model.canSetEffort || !model.efforts.some(effort => effort.id === task.effort))
      || task.fastMode && (!model.canSetFastMode || !model.supportsFastMode)) {
      throw new MobilePartnerProfileValidationError("modelUnavailable", "The selected task model or option is no longer available.");
    }
  }
  return { ...draft, displayName, description, identitySource, capabilities };
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
