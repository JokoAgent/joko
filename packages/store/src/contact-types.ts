export type ContactKind = "person" | "organization";
export type ContactStatus = "confirmed" | "pending";
export type ContactSource = "manual" | "agent" | "import";

export interface ContactIdentityRecord {
  readonly id: string;
  readonly contactId: string;
  readonly revision: bigint;
  readonly platform: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly label: string;
  readonly note: string;
  readonly createdAt: number;
}

export interface ContactEventRecord {
  readonly id: string;
  readonly contactId: string;
  readonly revision: bigint;
  readonly date: string;
  readonly text: string;
  readonly source: string;
  readonly createdAt: number;
}

export interface ContactGroupRecord {
  readonly id: string;
  readonly revision: bigint;
  readonly name: string;
  readonly description: string;
  readonly memberCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactRelationRecord {
  readonly id: string;
  readonly revision: bigint;
  readonly fromContactId: string;
  readonly toContactId: string;
  readonly relation: string;
  readonly note: string;
  readonly createdAt: number;
}

export interface RelatedContactRecord extends ContactRelationRecord {
  readonly direction: "outgoing" | "incoming";
  readonly relatedContactId: string;
  readonly relatedDisplayName: string;
  readonly relatedKind: ContactKind;
}

export interface ContactSummaryRecord {
  readonly id: string;
  readonly revision: bigint;
  readonly kind: ContactKind;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly status: ContactStatus;
  readonly source: ContactSource;
  readonly identityCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactProfileRecord extends ContactSummaryRecord {
  readonly narrative: string;
  readonly agentNotes: string;
  readonly identities: readonly ContactIdentityRecord[];
  readonly events: readonly ContactEventRecord[];
  readonly groups: readonly ContactGroupRecord[];
  readonly relations: readonly RelatedContactRecord[];
}

export interface ContactDirectoryState {
  readonly format: 1;
  readonly revision: bigint;
  readonly enabled: boolean;
  readonly people: number;
  readonly organizations: number;
  readonly pending: number;
  readonly groups: number;
}

export interface ContactDraft {
  readonly kind: ContactKind;
  readonly displayName: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly narrative?: string;
  readonly agentNotes?: string;
  readonly status?: ContactStatus;
  readonly source?: ContactSource;
  readonly identities?: readonly ContactIdentityDraft[];
}

export interface ContactPatch {
  readonly kind?: ContactKind;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly narrative?: string;
  readonly agentNotes?: string;
  readonly status?: ContactStatus;
}

export interface ContactIdentityDraft {
  readonly platform: string;
  readonly value: string;
  readonly label?: string;
  readonly note?: string;
}

export interface ContactEventDraft {
  readonly date: string;
  readonly text: string;
  readonly source?: string;
}

export interface ContactDuplicateCandidate {
  readonly matchType: "identity" | "name";
  readonly contactId: string;
  readonly displayName: string;
  readonly kind: ContactKind;
  readonly status: ContactStatus;
  readonly summary: string;
  readonly matchedPlatform?: string;
  readonly matchedValue?: string;
}

export interface ContactDuplicatePair {
  readonly first: ContactSummaryRecord;
  readonly second: ContactSummaryRecord;
}

export interface ContactListResult {
  readonly contacts: readonly ContactSummaryRecord[];
  readonly total: number;
  readonly nextOffset?: number;
}

export interface ContactMergeResult {
  readonly target: ContactProfileRecord;
  readonly mergedContactId: string;
  readonly movedIdentities: number;
  readonly movedEvents: number;
  readonly movedRelations: number;
}

export interface ContactSyncConfigurationRecord {
  readonly revision: bigint;
  readonly nodeId: string;
  readonly enabled: boolean;
  readonly publicKey: string;
  readonly sealedPrivateKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactSyncPeerRecord {
  readonly peerId: string;
  readonly revision: bigint;
  readonly displayName: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly grantedAt: number;
  readonly updatedAt: number;
  readonly lastSyncAt?: number;
  readonly lastRoute?: "lan";
}

export type ContactStoreErrorCode =
  | "CONTACT_INVALID"
  | "CONTACT_NOT_FOUND"
  | "CONTACT_CHANGED"
  | "CONTACT_IDENTITY_CONFLICT"
  | "CONTACT_ALREADY_EXISTS"
  | "CONTACT_DIRECTORY_CHANGED"
  | "CONTACT_SYNC_CHANGED"
  | "CONTACT_SYNC_PEER_NOT_FOUND"
  | "CONTACT_STORE_UNAVAILABLE";

export class ContactStoreError extends Error {
  constructor(
    readonly code: ContactStoreErrorCode,
    message: string,
    readonly conflictContactId?: string
  ) {
    super(message);
    this.name = "ContactStoreError";
  }
}
