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
export type PartnerSessionRole = "canonical" | "history" | "delegation";
export type PartnerPrivateThreadStatus = "active" | "closed";
export type PartnerPrivateThreadCloseReason = "message_limit" | "idle_timeout";
export type PartnerPrivateMessageDeliveryStatus = "pending" | "delivered" | "failed";
export type PartnerDelegationStatus =
  | "preparing"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

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

export interface PartnerSessionLinkRecord {
  readonly sessionId: string;
  readonly partnerId: string;
  readonly role: PartnerSessionRole;
  readonly profileVersion: number;
  readonly parentSessionId?: string;
  readonly delegationId?: string;
  readonly createdAt: number;
}

export interface PartnerReadStateRecord {
  readonly partnerId: string;
  readonly throughCursor: bigint;
  readonly updatedAt: number;
}

export interface PartnerPrivateThreadRecord {
  readonly id: string;
  readonly firstPartnerId: string;
  readonly secondPartnerId: string;
  readonly status: PartnerPrivateThreadStatus;
  readonly closeReason?: PartnerPrivateThreadCloseReason;
  readonly messageCount: number;
  readonly maxMessages: number;
  readonly expiresAt: number;
  readonly blockedUntil?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
}

export interface PartnerPrivateMessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly senderPartnerId: string;
  readonly recipientPartnerId: string;
  readonly senderSessionId: string;
  readonly recipientSessionId: string;
  readonly content: string;
  readonly deliveryStatus: PartnerPrivateMessageDeliveryStatus;
  readonly operationId: string;
  readonly runId?: string;
  readonly errorText?: string;
  readonly createdAt: number;
  readonly deliveredAt?: number;
}

export interface PartnerPrivateThreadReadStateRecord {
  readonly threadId: string;
  readonly partnerId: string;
  readonly throughSequence: number;
  readonly updatedAt: number;
}

export interface PartnerPrivateThreadViewRecord {
  readonly thread: PartnerPrivateThreadRecord;
  readonly messages: readonly PartnerPrivateMessageRecord[];
  readonly readState?: PartnerPrivateThreadReadStateRecord;
}

export interface PartnerDelegationRecord {
  readonly id: string;
  readonly revision: bigint;
  readonly requesterPartnerId: string;
  readonly targetPartnerId: string;
  readonly parentSessionId: string;
  readonly targetProfileVersion: number;
  readonly title: string;
  readonly objective: string;
  readonly status: PartnerDelegationStatus;
  readonly childSessionId?: string;
  readonly runId?: string;
  readonly createOperationId: string;
  readonly enqueueOperationId: string;
  readonly resultSummary?: string;
  readonly errorText?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
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
  | "PARTNER_PRIVATE_LIMIT"
  | "PARTNER_PRIVATE_WAIT"
  | "PARTNER_DELEGATION_CHANGED"
  | "PARTNER_STORE_UNAVAILABLE";

export class PartnerStoreError extends Error {
  constructor(readonly code: PartnerStoreErrorCode, message: string) {
    super(message);
    this.name = "PartnerStoreError";
  }
}
