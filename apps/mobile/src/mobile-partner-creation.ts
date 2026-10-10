import { CapabilitySupport, PartnerLifecycle, PermissionMode, type PartnerDirectory, type PartnerProfile, type Snapshot } from "@joko/contracts";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { projectMobilePartnerProfile } from "./mobile-partner-directory";
import { resolveMobileNewTaskExecutionAuthority } from "./mobile-runtime-controls";
import { projectMobilePartnerProfileOptions, validateMobilePartnerDraftFields, MobilePartnerProfileValidationError,
  type MobilePartnerProfileOptions, type MobilePartnerProfileDraft, type MobilePartnerDraftFields } from "./mobile-partner-profile";

export interface MobilePartnerCreationOptions extends MobilePartnerProfileOptions {
  readonly templates: readonly { readonly templateId: string; readonly displayName: string; readonly description: string; readonly identitySource: string }[];
}
export interface MobilePartnerCreationBackend extends Omit<MobilePartnerDraftFields, "ownerKey" | "options" | "names"> {
  readonly backendId: string;
  readonly displayName: string;
}
export interface MobilePartnerCreationSnapshot {
  readonly ownerKey: string;
  readonly options: MobilePartnerCreationOptions;
  readonly names: MobilePartnerDraftFields["names"];
  readonly backends: readonly MobilePartnerCreationBackend[];
}
export interface MobilePartnerCreationDraft extends Omit<MobilePartnerProfileDraft, "avatar"> {
  readonly templateId: string;
  readonly avatar: string | { readonly base64: string };
}
export type MobilePartnerCreationResult = { readonly kind: "found"; readonly partner: MobilePartnerDirectoryProfile }
  | { readonly kind: "inactive" } | { readonly kind: "absent" } | { readonly kind: "retired" };
export class MobilePartnerCreationRejected extends Error {}
export interface MobilePartnerCreationTransport {
  readonly ownerKey: string;
  pending(signal: AbortSignal): Promise<string | undefined>;
  load(signal: AbortSignal): Promise<MobilePartnerCreationSnapshot>;
  create(snapshot: MobilePartnerCreationSnapshot, draft: MobilePartnerCreationDraft, signal: AbortSignal): Promise<MobilePartnerCreationResult>;
  lookup(requestId: string, signal: AbortSignal): Promise<MobilePartnerCreationResult>;
  retire(requestId: string, signal: AbortSignal): Promise<MobilePartnerCreationResult>;
}

export function projectMobilePartnerCreationOptions(value: PartnerDirectory | undefined): MobilePartnerCreationOptions {
  const options = projectMobilePartnerProfileOptions(value);
  if (!value || value.templates.length < 1 || value.templates.length > 100 || new Set(value.templates.map((item) => item.templateId)).size !== value.templates.length
    || value.templates.some((item) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.templateId) || !item.displayName.trim()
      || item.displayName.length > 200 || item.description.length > 2000 || !item.identitySource.trim() || item.identitySource.length > 8000)) {
    throw new Error("The Joko node returned invalid Partner creation options.");
  }
  return { ...options, templates: value.templates.map(({ templateId, displayName, description, identitySource }) =>
    ({ templateId, displayName, description, identitySource })) };
}

export function mobilePartnerCreationBackends(owner: Snapshot | undefined): readonly MobilePartnerCreationBackend[] {
  return (owner?.backends ?? []).flatMap((backend) => {
    const execution = resolveMobileNewTaskExecutionAuthority(owner, backend.backendId);
    const permission = backend.capabilities?.capabilities.filter((item) => item.name === "permission.modes") ?? [];
    if (!execution || permission.length !== 1 || permission[0]!.support !== CapabilitySupport.SUPPORTED
      || permission[0]!.options?.kind.case !== "permission" || execution.models.length === 0) return [];
    const advertised = permission[0]!.options.kind.value.modes;
    if (new Set(advertised).size !== advertised.length || advertised.some((mode) => ![PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS].includes(mode))) return [];
    const modes = advertised.filter((mode) => mode === PermissionMode.ASK || mode === PermissionMode.AUTO)
      .map((mode) => mode === PermissionMode.ASK ? "ask" as const : "auto" as const);
    if (modes.length === 0) return [];
    return [{ backendId: backend.backendId, displayName: backend.displayName, models: execution.models,
      canSwitchModel: execution.canSelectModel, canSetEffort: execution.canSetEffort, canSetFastMode: execution.canSetFastMode,
      canSetPlanMode: execution.canSetPlanMode, permissionModes: modes }];
  });
}

export function mobilePartnerCreationDraft(snapshot: MobilePartnerCreationSnapshot, selectedBackendId?: string): MobilePartnerCreationDraft | undefined {
  const backend = snapshot.backends.find((item) => item.backendId === selectedBackendId) ?? snapshot.backends[0];
  const template = snapshot.options.templates[0]; const model = backend?.models[0]; const avatar = snapshot.options.avatarPresets[0];
  if (!backend || !template || !model || !avatar) return undefined;
  const defaults = snapshot.options.defaultCapabilities;
  const inherited = defaults?.modelChain[0]?.backendId === backend.backendId;
  const effort = model.efforts.find((item) => item.default)?.id ?? model.efforts[0]?.id;
  return { displayName: "", avatar, identitySource: template.identitySource, templateId: template.templateId,
    usesDirectoryDefaults: inherited,
    capabilities: inherited ? defaults! : { modelChain: [{ backendId: model.backendId, providerId: model.providerId, modelId: model.modelId,
      fastMode: false, ...(effort === undefined ? {} : { effort }) }], permissionMode: backend.permissionModes[0]!, planMode: false } };
}

export function mobilePartnerCreationFields(snapshot: MobilePartnerCreationSnapshot, draft: MobilePartnerCreationDraft): MobilePartnerDraftFields | undefined {
  const backend = snapshot.backends.find((item) => item.backendId === draft.capabilities.modelChain[0]?.backendId);
  return backend ? { ...backend, ownerKey: snapshot.ownerKey, options: snapshot.options, names: snapshot.names } : undefined;
}

export function validateMobilePartnerCreationDraft(snapshot: MobilePartnerCreationSnapshot, draft: MobilePartnerCreationDraft): MobilePartnerCreationDraft {
  const fields = mobilePartnerCreationFields(snapshot, draft);
  if (!fields) throw new MobilePartnerProfileValidationError("modelUnavailable", "Select an available Partner Backend.");
  if (!snapshot.options.templates.some((item) => item.templateId === draft.templateId)) throw new Error("Select a current Partner template.");
  return { ...draft, ...validateMobilePartnerDraftFields(fields, draft, draft.capabilities.modelChain[0]?.backendId), avatar: draft.avatar };
}

export function projectMobilePartnerCreationResult(value: PartnerProfile | undefined): MobilePartnerCreationResult {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.partnerId) || !value.revision || value.revision.value < 1n) {
    throw new Error("The Joko node returned no valid Partner creation result.");
  }
  if (value.lifecycle === PartnerLifecycle.ARCHIVED || value.lifecycle === PartnerLifecycle.DELETED) return { kind: "inactive" };
  return { kind: "found", partner: projectMobilePartnerProfile(value) };
}
