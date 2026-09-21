export type PartnerLifecycle = "active" | "archived" | "deleted";
export type PartnerInitializationState = "pending" | "ready" | "error";
export type PartnerInvitationStage = "home" | "avatar" | "session" | "ready" | "failed";
export type PartnerInitializationErrorCode =
  | "home_unavailable"
  | "avatar_unavailable"
  | "model_unavailable"
  | "session_unavailable"
  | "state_changed";
export type PartnerPermissionMode = "ask" | "auto";

export interface PartnerModelRouteRecord {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
}

export interface PartnerCapabilitiesRecord {
  readonly modelChain: readonly PartnerModelRouteRecord[];
  readonly permissionMode: PartnerPermissionMode;
  readonly planMode: boolean;
}

export interface PartnerDirectoryState {
  readonly revision: bigint;
  readonly activeCount: number;
  readonly archivedCount: number;
  readonly errorCount: number;
  readonly defaultCapabilities?: PartnerCapabilitiesRecord;
  readonly updatedAt: number;
}

export interface PartnerProfileRecord {
  readonly id: string;
  readonly revision: bigint;
  readonly profileVersion: number;
  readonly displayName: string;
  readonly avatar: string;
  readonly identitySource: string;
  readonly templateId: string;
  readonly lifecycle: PartnerLifecycle;
  readonly initializationState: PartnerInitializationState;
  readonly invitationStage: PartnerInvitationStage;
  readonly initializationErrorCode?: PartnerInitializationErrorCode;
  readonly homeTargetId: string;
  readonly canonicalSessionId?: string;
  readonly capabilities: PartnerCapabilitiesRecord;
  readonly usesDirectoryDefaults: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PartnerProfileVersionRecord {
  readonly partnerId: string;
  readonly version: number;
  readonly identitySource: string;
  readonly capabilities: PartnerCapabilitiesRecord;
  readonly usesDirectoryDefaults: boolean;
  readonly createdAt: number;
}

export interface PartnerDraft {
  readonly displayName: string;
  readonly avatar: string;
  readonly identitySource: string;
  readonly templateId: string;
  readonly capabilities: PartnerCapabilitiesRecord;
  readonly usesDirectoryDefaults: boolean;
}

export interface PartnerPatch {
  readonly displayName?: string;
  readonly avatar?: string;
  readonly identitySource?: string;
  readonly capabilities?: PartnerCapabilitiesRecord;
  readonly usesDirectoryDefaults?: boolean;
}

export type PartnerStoreErrorCode =
  | "PARTNER_INVALID"
  | "PARTNER_NOT_FOUND"
  | "PARTNER_DIRECTORY_CHANGED"
  | "PARTNER_CHANGED"
  | "PARTNER_NAME_CONFLICT"
  | "PARTNER_SESSION_CONFLICT"
  | "PARTNER_STORE_UNAVAILABLE";

export class PartnerStoreError extends Error {
  constructor(readonly code: PartnerStoreErrorCode, message: string) {
    super(message);
    this.name = "PartnerStoreError";
  }
}
