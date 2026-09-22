import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  PartnerCapabilitiesRecord,
  PartnerDirectoryState,
  PartnerDraft,
  PartnerInitializationErrorCode,
  PartnerInitializationState,
  PartnerInvitationStage,
  PartnerLifecycle,
  PartnerDelegationRecord,
  PartnerDelegationStatus,
  PartnerModelRouteRecord,
  PartnerPatch,
  PartnerPrivateMessageDeliveryStatus,
  PartnerPrivateMessageRecord,
  PartnerPrivateThreadCloseReason,
  PartnerPrivateThreadReadStateRecord,
  PartnerPrivateThreadRecord,
  PartnerPrivateThreadViewRecord,
  PartnerProfileRecord,
  PartnerProfileVersionRecord,
  PartnerReadStateRecord,
  PartnerSessionLinkRecord,
  PartnerSessionRole
} from "./partner-types.js";
import { PartnerStoreError } from "./partner-types.js";

type Row = Record<string, unknown>;

export interface PartnerStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface PartnerListOptions {
  readonly lifecycle?: PartnerLifecycle;
  readonly includeDeleted?: boolean;
}

export interface CreatePartnerInput extends PartnerDraft {
  readonly expectedDirectoryRevision: bigint;
  readonly id?: string;
  readonly homeTargetId?: string;
}

export interface PartnerPrivateMessageReservation {
  readonly thread: PartnerPrivateThreadRecord;
  readonly message: PartnerPrivateMessageRecord;
  readonly remainingMessages: number;
  readonly conversationEnded: boolean;
}

export interface CreatePartnerDelegationInput {
  readonly requesterPartnerId: string;
  readonly targetPartnerId: string;
  readonly parentSessionId: string;
  readonly title: string;
  readonly objective: string;
  readonly id?: string;
}

export interface TransitionPartnerDelegationInput {
  readonly delegationId: string;
  readonly expectedRevision: bigint;
  readonly status: PartnerDelegationStatus;
  readonly runId?: string;
  readonly resultSummary?: string;
  readonly errorText?: string;
}

const PARTNER_SCHEMA_VERSION = 1;
const MAX_SAFE_REVISION = 9_007_199_254_740_991;
const MAX_PARTNERS = 1_000;
const MAX_DISPLAY_NAME = 100;
const MAX_IDENTITY_SOURCE = 8_000;
const MAX_MODEL_ROUTES = 3;
export const PARTNER_PRIVATE_MAX_MESSAGES = 12;
export const PARTNER_PRIVATE_IDLE_TIMEOUT_MS = 15 * 60_000;
export const PARTNER_PRIVATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const MAX_PRIVATE_MESSAGE = 16_000;
const MAX_DELEGATION_TITLE = 200;
const MAX_DELEGATION_OBJECTIVE = 12_000;
const MAX_DELEGATION_RESULT = 12_000;
const MAX_ERROR_TEXT = 2_000;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const AVATAR_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const TEMPLATE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const FORBIDDEN_INLINE_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_MULTILINE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const PARTNER_SCHEMA = `
CREATE TABLE partner_schema_version (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  baseline_id TEXT NOT NULL CHECK (length(baseline_id) = 64),
  initialized_at INTEGER NOT NULL CHECK (initialized_at >= 0)
) STRICT;

CREATE TABLE partner_directory (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  default_model_chain_json TEXT,
  default_permission_mode TEXT CHECK (default_permission_mode IS NULL OR default_permission_mode IN ('ask', 'auto')),
  default_plan_mode INTEGER CHECK (default_plan_mode IS NULL OR default_plan_mode IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((default_model_chain_json IS NULL) = (default_permission_mode IS NULL)),
  CHECK ((default_model_chain_json IS NULL) = (default_plan_mode IS NULL))
) STRICT;

CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 9007199254740991),
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  identity_source TEXT NOT NULL,
  template_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived', 'deleted')),
  initialization_state TEXT NOT NULL CHECK (initialization_state IN ('pending', 'ready', 'error')),
  invitation_stage TEXT NOT NULL CHECK (invitation_stage IN ('home', 'avatar', 'session', 'ready', 'failed')),
  initialization_error_code TEXT CHECK (initialization_error_code IS NULL OR initialization_error_code IN ('home_unavailable', 'avatar_unavailable', 'model_unavailable', 'session_unavailable', 'state_changed')),
  home_target_id TEXT NOT NULL UNIQUE,
  canonical_session_id TEXT UNIQUE,
  model_chain_json TEXT NOT NULL,
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('ask', 'auto')),
  plan_mode INTEGER NOT NULL CHECK (plan_mode IN (0, 1)),
  uses_directory_defaults INTEGER NOT NULL CHECK (uses_directory_defaults IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX partners_live_name_unique
  ON partners(normalized_name)
  WHERE lifecycle <> 'deleted';
CREATE INDEX partners_lifecycle_updated_idx ON partners(lifecycle, updated_at DESC, id);

CREATE TABLE partner_profile_versions (
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  identity_source TEXT NOT NULL,
  model_chain_json TEXT NOT NULL,
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('ask', 'auto')),
  plan_mode INTEGER NOT NULL CHECK (plan_mode IN (0, 1)),
  uses_directory_defaults INTEGER NOT NULL CHECK (uses_directory_defaults IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY(partner_id, version)
) STRICT;

CREATE TABLE partner_read_states (
  partner_id TEXT PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  through_cursor INTEGER NOT NULL CHECK (through_cursor BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE TABLE partner_private_threads (
  id TEXT PRIMARY KEY,
  first_partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  second_partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('message_limit', 'idle_timeout')),
  message_count INTEGER NOT NULL CHECK (message_count BETWEEN 0 AND 12),
  max_messages INTEGER NOT NULL CHECK (max_messages = 12),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  blocked_until INTEGER CHECK (blocked_until IS NULL OR blocked_until >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= created_at),
  CHECK (first_partner_id < second_partner_id),
  CHECK ((status = 'active') = (close_reason IS NULL)),
  CHECK ((status = 'active') = (closed_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX partner_private_threads_active_pair_unique
  ON partner_private_threads(first_partner_id, second_partner_id)
  WHERE status = 'active';
CREATE INDEX partner_private_threads_participants_updated_idx
  ON partner_private_threads(first_partner_id, second_partner_id, updated_at DESC, id);

CREATE TABLE partner_private_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES partner_private_threads(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  sender_partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  recipient_partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  sender_session_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 16000),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
  operation_id TEXT NOT NULL UNIQUE,
  run_id TEXT,
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at >= created_at),
  UNIQUE(thread_id, sequence),
  CHECK (sender_partner_id <> recipient_partner_id),
  CHECK ((delivery_status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((delivery_status = 'failed') = (error_text IS NOT NULL)),
  CHECK (delivery_status <> 'pending' OR run_id IS NULL)
) STRICT;
CREATE INDEX partner_private_messages_pending_idx
  ON partner_private_messages(delivery_status, created_at, id);

CREATE TABLE partner_private_thread_reads (
  thread_id TEXT NOT NULL REFERENCES partner_private_threads(id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  through_sequence INTEGER NOT NULL CHECK (through_sequence BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY(thread_id, partner_id)
) STRICT;

CREATE TABLE partner_delegations (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  requester_partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  target_partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL,
  target_profile_version INTEGER NOT NULL CHECK (target_profile_version BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 12000),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown')),
  child_session_id TEXT UNIQUE,
  run_id TEXT,
  create_operation_id TEXT NOT NULL UNIQUE,
  enqueue_operation_id TEXT NOT NULL UNIQUE,
  result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) BETWEEN 1 AND 12000),
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= created_at),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (requester_partner_id <> target_partner_id),
  CHECK (status NOT IN ('queued', 'running', 'waiting', 'completed') OR child_session_id IS NOT NULL),
  CHECK (status NOT IN ('queued', 'running', 'waiting', 'completed') OR run_id IS NOT NULL),
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
  CHECK (status NOT IN ('running', 'waiting', 'completed') OR started_at IS NOT NULL),
  CHECK ((status = 'completed') = (result_summary IS NOT NULL)),
  CHECK (status <> 'failed' OR error_text IS NOT NULL),
  CHECK (status IN ('failed', 'unknown') OR error_text IS NULL)
) STRICT;
CREATE INDEX partner_delegations_owner_updated_idx
  ON partner_delegations(requester_partner_id, updated_at DESC, id);
CREATE INDEX partner_delegations_target_updated_idx
  ON partner_delegations(target_partner_id, updated_at DESC, id);
CREATE INDEX partner_delegations_recovery_idx
  ON partner_delegations(status, updated_at, id);

CREATE TABLE partner_session_links (
  session_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('canonical', 'history', 'delegation')),
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 9007199254740991),
  parent_session_id TEXT,
  delegation_id TEXT REFERENCES partner_delegations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((role = 'delegation') = (delegation_id IS NOT NULL)),
  CHECK ((role = 'delegation') = (parent_session_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX partner_session_links_canonical_partner_unique
  ON partner_session_links(partner_id)
  WHERE role = 'canonical';
CREATE INDEX partner_session_links_partner_created_idx
  ON partner_session_links(partner_id, created_at DESC, session_id);
CREATE UNIQUE INDEX partner_session_links_delegation_unique
  ON partner_session_links(delegation_id)
  WHERE role = 'delegation';
`;

export const PARTNER_SCHEMA_BASELINE_ID = createHash("sha256")
  .update(`partner-v1\n${PARTNER_SCHEMA}`, "utf8").digest("hex");

/** Current-v1, standalone durable authority for long-lived partner profiles. */
export class PartnerStore {
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  #writeDepth = 0;
  #closed = false;

  constructor(readonly filePath: string, options: PartnerStoreOptions = {}) {
    if (filePath !== ":memory:" && !filePath.startsWith("file:")) {
      mkdirSync(dirname(resolve(filePath)), { recursive: true });
    }
    this.#database = new DatabaseSync(filePath);
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    try {
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
      if (filePath !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.#initialize();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  directoryState(): PartnerDirectoryState {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT revision, default_model_chain_json, default_permission_mode, default_plan_mode, updated_at,
        (SELECT COUNT(*) FROM partners WHERE lifecycle = 'active') AS active_count,
        (SELECT COUNT(*) FROM partners WHERE lifecycle = 'archived') AS archived_count,
        (SELECT COUNT(*) FROM partners WHERE lifecycle <> 'deleted' AND initialization_state = 'error') AS error_count
      FROM partner_directory WHERE singleton = 1
    `).get() as Row | undefined;
    if (row === undefined) throw unavailable("The partner directory row is missing.");
    const defaultCapabilities = nullableCapabilitiesFromRow(row, "default_");
    return {
      revision: BigInt(safeInteger(row["revision"], "Partner directory revision")),
      activeCount: safeInteger(row["active_count"], "Partner active count"),
      archivedCount: safeInteger(row["archived_count"], "Partner archived count"),
      errorCount: safeInteger(row["error_count"], "Partner error count"),
      ...(defaultCapabilities === undefined ? {} : { defaultCapabilities }),
      updatedAt: timestamp(row["updated_at"], "Partner directory updated time")
    };
  }

  setDirectoryDefaults(
    expectedDirectoryRevision: bigint,
    capabilities: PartnerCapabilitiesRecord
  ): readonly PartnerProfileRecord[] {
    return this.#write(() => {
      const directory = this.directoryState();
      if (directory.revision !== expectedDirectoryRevision) {
        throw new PartnerStoreError("PARTNER_DIRECTORY_CHANGED", "The partner directory changed; read it again and retry.");
      }
      const next = capabilitiesValue(capabilities);
      if (directory.defaultCapabilities !== undefined
        && sameCapabilities(directory.defaultCapabilities, next)) {
        return this.listPartners().filter((profile) => profile.usesDirectoryDefaults);
      }
      const at = this.#now();
      const profiles = this.listPartners().filter((profile) => profile.usesDirectoryDefaults);
      for (const current of profiles) {
        const nextRevision = nextNumber(current.revision, "Partner revision");
        const nextVersion = nextSafeInteger(current.profileVersion, "Partner profile version");
        const result = this.#database.prepare(`
          UPDATE partners SET revision = ?, profile_version = ?, model_chain_json = ?, permission_mode = ?,
            plan_mode = ?, initialization_state = 'pending', invitation_stage = 'home',
            initialization_error_code = NULL, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(nextRevision, nextVersion, modelChainJson(next.modelChain), next.permissionMode,
          next.planMode ? 1 : 0, at, current.id, Number(current.revision));
        if (Number(result.changes) !== 1) throw changed(current.id);
        this.#insertVersion(current.id, nextVersion, current.identitySource, next, true, at);
      }
      this.#database.prepare(`
        UPDATE partner_directory SET default_model_chain_json = ?, default_permission_mode = ?,
          default_plan_mode = ?, revision = ?, updated_at = ? WHERE singleton = 1
      `).run(modelChainJson(next.modelChain), next.permissionMode, next.planMode ? 1 : 0,
        nextNumber(directory.revision, "Partner directory revision"), at);
      return profiles.map((profile) => this.getPartner(profile.id));
    });
  }

  listPartners(options: PartnerListOptions = {}): readonly PartnerProfileRecord[] {
    this.#assertOpen();
    const rows = options.lifecycle === undefined
      ? this.#database.prepare(`
          SELECT * FROM partners
          WHERE (? = 1 OR lifecycle <> 'deleted')
          ORDER BY CASE lifecycle WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END, updated_at DESC, id
        `).all(options.includeDeleted === true ? 1 : 0) as Row[]
      : this.#database.prepare(`
          SELECT * FROM partners WHERE lifecycle = ? ORDER BY updated_at DESC, id
        `).all(options.lifecycle) as Row[];
    return rows.map((row) => this.#profile(row));
  }

  getPartner(partnerId: string): PartnerProfileRecord {
    this.#assertOpen();
    const id = entityId(partnerId, "Partner ID");
    const row = this.#database.prepare("SELECT * FROM partners WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner profile was not found.");
    return this.#profile(row);
  }

  findPartnerByCanonicalSession(sessionId: string): PartnerProfileRecord | undefined {
    this.#assertOpen();
    const id = entityId(sessionId, "Canonical Session ID");
    const row = this.#database.prepare("SELECT * FROM partners WHERE canonical_session_id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : this.#profile(row);
  }

  findPartnerByHomeTarget(targetId: string): PartnerProfileRecord | undefined {
    this.#assertOpen();
    const id = entityId(targetId, "Partner home Target ID");
    const row = this.#database.prepare("SELECT * FROM partners WHERE home_target_id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : this.#profile(row);
  }

  findPartnerBySession(sessionId: string): PartnerProfileRecord | undefined {
    const link = this.getSessionLink(sessionId);
    return link === undefined ? undefined : this.getPartner(link.partnerId);
  }

  getSessionLink(sessionId: string): PartnerSessionLinkRecord | undefined {
    this.#assertOpen();
    const id = entityId(sessionId, "Partner Session ID");
    const row = this.#database.prepare("SELECT * FROM partner_session_links WHERE session_id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : partnerSessionLink(row);
  }

  listSessionLinks(partnerId: string, role?: PartnerSessionRole): readonly PartnerSessionLinkRecord[] {
    this.getPartner(partnerId);
    if (role !== undefined) partnerSessionRole(role);
    const rows = role === undefined
      ? this.#database.prepare(`
          SELECT * FROM partner_session_links WHERE partner_id = ?
          ORDER BY CASE role WHEN 'canonical' THEN 0 WHEN 'history' THEN 1 ELSE 2 END,
            created_at DESC, session_id
        `).all(partnerId) as Row[]
      : this.#database.prepare(`
          SELECT * FROM partner_session_links WHERE partner_id = ? AND role = ?
          ORDER BY created_at DESC, session_id
        `).all(partnerId, role) as Row[];
    return rows.map(partnerSessionLink);
  }

  readState(partnerId: string): PartnerReadStateRecord {
    const partner = this.getPartner(partnerId);
    const row = this.#database.prepare("SELECT * FROM partner_read_states WHERE partner_id = ?")
      .get(partner.id) as Row | undefined;
    return row === undefined
      ? { partnerId: partner.id, throughCursor: 0n, updatedAt: partner.createdAt }
      : partnerReadState(row);
  }

  markRead(partnerId: string, throughCursor: bigint): PartnerReadStateRecord {
    return this.#write(() => {
      const partner = this.getPartner(partnerId);
      const cursor = revisionNumber(throughCursor, "Partner read cursor", true);
      const current = this.readState(partner.id);
      if (throughCursor <= current.throughCursor) return current;
      const at = this.#now();
      this.#database.prepare(`
        INSERT INTO partner_read_states(partner_id, through_cursor, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(partner_id) DO UPDATE SET through_cursor = excluded.through_cursor, updated_at = excluded.updated_at
        WHERE excluded.through_cursor > partner_read_states.through_cursor
      `).run(partner.id, cursor, at);
      return this.readState(partner.id);
    });
  }

  createPartner(input: CreatePartnerInput): PartnerProfileRecord {
    return this.#write(() => {
      const directory = this.directoryState();
      if (directory.revision !== input.expectedDirectoryRevision) {
        throw new PartnerStoreError("PARTNER_DIRECTORY_CHANGED", "The partner directory changed; read it again and retry.");
      }
      const count = safeInteger((this.#database.prepare("SELECT COUNT(*) AS count FROM partners WHERE lifecycle <> 'deleted'").get() as Row)["count"], "Partner count");
      if (count >= MAX_PARTNERS) throw new PartnerStoreError("PARTNER_INVALID", "The partner directory reached its current-v1 limit.");
      const id = entityId(input.id ?? this.#idFactory(), "Partner ID");
      const homeTargetId = entityId(input.homeTargetId ?? `partner:${id}`, "Partner home Target ID");
      const requestedDraft = partnerDraft(input);
      const capabilities = requestedDraft.usesDirectoryDefaults
        ? this.directoryState().defaultCapabilities
        : requestedDraft.capabilities;
      if (capabilities === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "Partner directory defaults must be configured first.");
      }
      const draft = { ...requestedDraft, capabilities };
      const at = this.#now();
      this.#database.prepare(`
        INSERT INTO partners(
          id, revision, profile_version, display_name, normalized_name, avatar, identity_source, template_id,
          lifecycle, initialization_state, invitation_stage, initialization_error_code,
          home_target_id, canonical_session_id, model_chain_json, permission_mode, plan_mode,
          uses_directory_defaults, created_at, updated_at
        ) VALUES (?, 1, 1, ?, ?, ?, ?, ?, 'active', 'pending', 'home', NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(id, draft.displayName, normalizedPartnerName(draft.displayName), draft.avatar,
        draft.identitySource, draft.templateId, homeTargetId, modelChainJson(draft.capabilities.modelChain),
        draft.capabilities.permissionMode, draft.capabilities.planMode ? 1 : 0,
        draft.usesDirectoryDefaults ? 1 : 0, at, at);
      this.#insertVersion(id, 1, draft.identitySource, draft.capabilities, draft.usesDirectoryDefaults, at);
      this.#bumpDirectory(at);
      return this.getPartner(id);
    });
  }

  updatePartner(partnerId: string, expectedRevision: bigint, patch: PartnerPatch): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(partnerId);
      assertMutable(current);
      assertRevision(current, expectedRevision);
      const usesDirectoryDefaults = patch.usesDirectoryDefaults ?? current.usesDirectoryDefaults;
      if (usesDirectoryDefaults && patch.capabilities !== undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "A partner using directory defaults cannot also provide capability overrides.");
      }
      const capabilities = usesDirectoryDefaults
        ? this.directoryState().defaultCapabilities
        : patch.capabilities ?? current.capabilities;
      if (capabilities === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "Partner directory defaults must be configured first.");
      }
      const next = partnerDraft({
        displayName: patch.displayName ?? current.displayName,
        avatar: patch.avatar ?? current.avatar,
        identitySource: patch.identitySource ?? current.identitySource,
        templateId: current.templateId,
        capabilities,
        usesDirectoryDefaults
      });
      if (sameProfileContent(current, next)) return current;
      const at = this.#now();
      const nextRevision = nextNumber(current.revision, "Partner revision");
      const nextVersion = nextSafeInteger(current.profileVersion, "Partner profile version");
      const result = this.#database.prepare(`
        UPDATE partners SET
          revision = ?, profile_version = ?, display_name = ?, normalized_name = ?, avatar = ?, identity_source = ?,
          model_chain_json = ?, permission_mode = ?, plan_mode = ?, uses_directory_defaults = ?,
          initialization_state = 'pending', invitation_stage = 'home',
          initialization_error_code = NULL, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(nextRevision, nextVersion, next.displayName, normalizedPartnerName(next.displayName), next.avatar,
        next.identitySource, modelChainJson(next.capabilities.modelChain), next.capabilities.permissionMode,
        next.capabilities.planMode ? 1 : 0, next.usesDirectoryDefaults ? 1 : 0,
        at, current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw changed(current.id);
      this.#insertVersion(current.id, nextVersion, next.identitySource, next.capabilities,
        next.usesDirectoryDefaults, at);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  setLifecycle(partnerId: string, expectedRevision: bigint, lifecycle: PartnerLifecycle): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(partnerId);
      assertRevision(current, expectedRevision);
      lifecycleValue(lifecycle);
      if (current.lifecycle === lifecycle) return current;
      if (current.lifecycle === "deleted") {
        throw new PartnerStoreError("PARTNER_INVALID", "A deleted partner profile cannot be restored.");
      }
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partners SET revision = ?, lifecycle = ?, updated_at = ? WHERE id = ? AND revision = ?
      `).run(nextNumber(current.revision, "Partner revision"), lifecycle, at, current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw changed(current.id);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  prepareInitialization(partnerId: string, expectedRevision: bigint): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(partnerId);
      assertMutable(current);
      assertRevision(current, expectedRevision);
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partners SET revision = ?, initialization_state = 'pending',
          invitation_stage = 'home',
          initialization_error_code = NULL, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(nextNumber(current.revision, "Partner revision"), at, current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw changed(current.id);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  markInvitationStage(
    partnerId: string,
    expectedRevision: bigint,
    stage: Exclude<PartnerInvitationStage, "ready" | "failed">
  ): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(partnerId);
      assertMutable(current);
      assertRevision(current, expectedRevision);
      invitationStageValue(stage);
      if (current.initializationState !== "pending") {
        throw new PartnerStoreError("PARTNER_INVALID", "Only pending partner initialization can advance.");
      }
      if (current.invitationStage === stage) return current;
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partners SET revision = ?, invitation_stage = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(nextNumber(current.revision, "Partner revision"), stage, at,
        current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw changed(current.id);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  failInitialization(
    partnerId: string,
    expectedRevision: bigint,
    errorCode: PartnerInitializationErrorCode
  ): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(partnerId);
      assertMutable(current);
      assertRevision(current, expectedRevision);
      initializationErrorCode(errorCode);
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partners SET revision = ?, initialization_state = 'error', invitation_stage = 'failed',
          initialization_error_code = ?, updated_at = ? WHERE id = ? AND revision = ?
      `).run(nextNumber(current.revision, "Partner revision"), errorCode, at, current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw changed(current.id);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  bindCanonicalSession(input: {
    readonly partnerId: string;
    readonly expectedRevision: bigint;
    readonly expectedProfileVersion: number;
    readonly sessionId: string;
  }): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(input.partnerId);
      assertMutable(current);
      assertRevision(current, input.expectedRevision);
      if (current.profileVersion !== input.expectedProfileVersion) throw changed(current.id);
      const sessionId = entityId(input.sessionId, "Canonical Session ID");
      if (current.canonicalSessionId !== undefined && current.canonicalSessionId !== sessionId) {
        throw new PartnerStoreError("PARTNER_SESSION_CONFLICT", "The partner already has a different canonical Session.");
      }
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partners SET revision = ?, canonical_session_id = ?, initialization_state = 'pending',
          invitation_stage = 'session', initialization_error_code = NULL, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(nextNumber(current.revision, "Partner revision"), sessionId, at, current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw changed(current.id);
      this.#database.prepare(`
        INSERT INTO partner_session_links(
          session_id, partner_id, role, profile_version, parent_session_id, delegation_id, created_at
        ) VALUES (?, ?, 'canonical', ?, NULL, NULL, ?)
      `).run(sessionId, current.id, current.profileVersion, at);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  replaceCanonicalSession(input: {
    readonly partnerId: string;
    readonly expectedRevision: bigint;
    readonly expectedProfileVersion: number;
    readonly expectedCanonicalSessionId: string;
    readonly sessionId: string;
  }): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(input.partnerId);
      assertMutable(current);
      assertRevision(current, input.expectedRevision);
      if (current.profileVersion !== input.expectedProfileVersion) throw changed(current.id);
      const expected = entityId(input.expectedCanonicalSessionId, "Previous canonical Session ID");
      if (current.canonicalSessionId !== expected) throw changed(current.id);
      const sessionId = entityId(input.sessionId, "Canonical Session ID");
      if (sessionId === expected) {
        throw new PartnerStoreError("PARTNER_INVALID", "A replacement canonical Session must be different.");
      }
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partners SET revision = ?, canonical_session_id = ?, initialization_state = 'pending',
          invitation_stage = 'session', initialization_error_code = NULL, updated_at = ?
        WHERE id = ? AND revision = ? AND canonical_session_id = ?
      `).run(nextNumber(current.revision, "Partner revision"), sessionId, at,
        current.id, Number(current.revision), expected);
      if (Number(result.changes) !== 1) throw changed(current.id);
      const retired = this.#database.prepare(`
        UPDATE partner_session_links SET role = 'history' WHERE session_id = ? AND partner_id = ? AND role = 'canonical'
      `).run(expected, current.id);
      if (Number(retired.changes) !== 1) throw unavailable("The previous canonical Session link is missing.");
      this.#database.prepare(`
        INSERT INTO partner_session_links(
          session_id, partner_id, role, profile_version, parent_session_id, delegation_id, created_at
        ) VALUES (?, ?, 'canonical', ?, NULL, NULL, ?)
      `).run(sessionId, current.id, current.profileVersion, at);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  markReady(partnerId: string, expectedRevision: bigint): PartnerProfileRecord {
    return this.#write(() => {
      const current = this.getPartner(partnerId);
      assertMutable(current);
      assertRevision(current, expectedRevision);
      if (current.canonicalSessionId === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "A canonical Session is required before the partner can become ready.");
      }
      if (current.initializationState === "ready" && current.initializationErrorCode === undefined) return current;
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partners SET revision = ?, initialization_state = 'ready', invitation_stage = 'ready',
          initialization_error_code = NULL, updated_at = ? WHERE id = ? AND revision = ?
      `).run(nextNumber(current.revision, "Partner revision"), at, current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw changed(current.id);
      this.#bumpDirectory(at);
      return this.getPartner(current.id);
    });
  }

  listProfileVersions(partnerId: string): readonly PartnerProfileVersionRecord[] {
    this.getPartner(partnerId);
    const rows = this.#database.prepare(`
      SELECT * FROM partner_profile_versions WHERE partner_id = ? ORDER BY version DESC
    `).all(partnerId) as Row[];
    return rows.map((row) => ({
      partnerId: stringValue(row["partner_id"], "Partner version owner"),
      version: safeInteger(row["version"], "Partner profile version"),
      identitySource: identityValue(row["identity_source"]),
      capabilities: capabilitiesFromRow(row),
      usesDirectoryDefaults: booleanInteger(row["uses_directory_defaults"], "Partner version default inheritance"),
      createdAt: timestamp(row["created_at"], "Partner profile version created time")
    }));
  }

  reservePrivateMessage(input: {
    readonly id?: string;
    readonly senderPartnerId: string;
    readonly recipientPartnerId: string;
    readonly senderSessionId: string;
    readonly recipientSessionId: string;
    readonly content: string;
  }): PartnerPrivateMessageReservation {
    return this.#write(() => {
      const senderPartnerId = entityId(input.senderPartnerId, "Private-message sender Partner ID");
      const recipientPartnerId = entityId(input.recipientPartnerId, "Private-message recipient Partner ID");
      const senderSessionId = entityId(input.senderSessionId, "Private-message sender Session ID");
      const recipientSessionId = entityId(input.recipientSessionId, "Private-message recipient Session ID");
      const content = multilineText(input.content, "Partner private message", MAX_PRIVATE_MESSAGE);
      const requestedMessageId = input.id === undefined
        ? undefined
        : entityId(input.id, "Partner private message ID");
      if (requestedMessageId !== undefined) {
        const existingRow = this.#database.prepare("SELECT * FROM partner_private_messages WHERE id = ?")
          .get(requestedMessageId) as Row | undefined;
        if (existingRow !== undefined) {
          const message = this.#validatedPrivateMessage(existingRow);
          if (message.senderPartnerId !== senderPartnerId
            || message.recipientPartnerId !== recipientPartnerId
            || message.senderSessionId !== senderSessionId
            || message.content !== content) {
            throw new PartnerStoreError(
              "PARTNER_INVALID",
              "The private-message operation was already used with different input."
            );
          }
          const thread = this.getPrivateThread(message.threadId).thread;
          const countRow = this.#database.prepare(`
            SELECT COUNT(*) AS count FROM partner_private_messages
            WHERE thread_id = ? AND sequence <= ? AND delivery_status <> 'failed'
          `).get(thread.id, message.sequence) as Row;
          const countAtReservation = safeInteger(countRow["count"], "Partner private reservation count");
          return {
            thread,
            message,
            remainingMessages: Math.max(0, thread.maxMessages - countAtReservation),
            conversationEnded: message.deliveryStatus !== "failed" && countAtReservation >= thread.maxMessages
          };
        }
      }
      const sender = this.getPartner(senderPartnerId);
      const recipient = this.getPartner(recipientPartnerId);
      if (sender.id === recipient.id) {
        throw new PartnerStoreError("PARTNER_INVALID", "A partner cannot send a private message to itself.");
      }
      if (sender.lifecycle !== "active" || sender.initializationState !== "ready"
        || recipient.lifecycle !== "active" || recipient.initializationState !== "ready") {
        throw new PartnerStoreError("PARTNER_INVALID", "Both private-message participants must be active and ready.");
      }
      if (sender.canonicalSessionId !== senderSessionId || recipient.canonicalSessionId !== recipientSessionId) {
        throw new PartnerStoreError("PARTNER_SESSION_CONFLICT", "Private messages require both current canonical Sessions.");
      }
      const [firstPartnerId, secondPartnerId] = partnerPair(sender.id, recipient.id);
      const at = this.#now();
      this.#database.prepare(`
        UPDATE partner_private_threads
        SET status = 'closed', close_reason = 'idle_timeout', closed_at = ?, updated_at = ?
        WHERE first_partner_id = ? AND second_partner_id = ? AND status = 'active' AND expires_at <= ?
      `).run(at, at, firstPartnerId, secondPartnerId, at);

      let threadRow = this.#database.prepare(`
        SELECT * FROM partner_private_threads
        WHERE first_partner_id = ? AND second_partner_id = ? AND status = 'active'
      `).get(firstPartnerId, secondPartnerId) as Row | undefined;
      if (threadRow === undefined) {
        const latest = this.#database.prepare(`
          SELECT * FROM partner_private_threads
          WHERE first_partner_id = ? AND second_partner_id = ?
          ORDER BY updated_at DESC, id DESC LIMIT 1
        `).get(firstPartnerId, secondPartnerId) as Row | undefined;
        if (latest !== undefined) {
          const latestThread = partnerPrivateThread(latest);
          if (latestThread.closeReason === "message_limit"
            && latestThread.blockedUntil !== undefined && latestThread.blockedUntil > at) {
            throw new PartnerStoreError("PARTNER_PRIVATE_LIMIT", "This private conversation reached its message limit; retry after the cooldown.");
          }
        }
        const threadId = entityId(this.#idFactory(), "Partner private thread ID");
        this.#database.prepare(`
          INSERT INTO partner_private_threads(
            id, first_partner_id, second_partner_id, status, close_reason, message_count, max_messages,
            expires_at, blocked_until, created_at, updated_at, closed_at
          ) VALUES (?, ?, ?, 'active', NULL, 0, ?, ?, NULL, ?, ?, NULL)
        `).run(threadId, firstPartnerId, secondPartnerId, PARTNER_PRIVATE_MAX_MESSAGES,
          at + PARTNER_PRIVATE_IDLE_TIMEOUT_MS, at, at);
        threadRow = this.#database.prepare("SELECT * FROM partner_private_threads WHERE id = ?")
          .get(threadId) as Row | undefined;
      }
      if (threadRow === undefined) throw unavailable("The partner private thread could not be created.");
      let thread = partnerPrivateThread(threadRow);
      const messages = this.#database.prepare(`
        SELECT * FROM partner_private_messages WHERE thread_id = ? ORDER BY sequence
      `).all(thread.id) as Row[];
      const liveMessages = messages.map((row) => this.#validatedPrivateMessage(row))
        .filter((message) => message.deliveryStatus !== "failed");
      if (thread.messageCount !== liveMessages.length) {
        this.#database.prepare("UPDATE partner_private_threads SET message_count = ? WHERE id = ?")
          .run(liveMessages.length, thread.id);
        thread = { ...thread, messageCount: liveMessages.length };
      }
      if (thread.messageCount >= thread.maxMessages) {
        throw new PartnerStoreError("PARTNER_PRIVATE_LIMIT", "This partner private conversation reached its message limit.");
      }
      if (liveMessages.slice(-2).every((message) => message.senderPartnerId === sender.id)
        && liveMessages.length >= 2) {
        throw new PartnerStoreError("PARTNER_PRIVATE_WAIT", "Wait for the other partner to reply before sending again.");
      }
      const nextSequence = messages.reduce((maximum, row) => {
        return Math.max(maximum, safeInteger(row["sequence"], "Partner private message sequence"));
      }, 0) + 1;
      const messageId = requestedMessageId ?? entityId(this.#idFactory(), "Partner private message ID");
      const operationId = stablePartnerOperationId("partner-private", thread.id, messageId);
      const nextCount = thread.messageCount + 1;
      const ended = nextCount >= thread.maxMessages;
      this.#database.prepare(`
        INSERT INTO partner_private_messages(
          id, thread_id, sequence, sender_partner_id, recipient_partner_id,
          sender_session_id, recipient_session_id, content, delivery_status,
          operation_id, run_id, error_text, created_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL)
      `).run(messageId, thread.id, nextSequence, sender.id, recipient.id,
        senderSessionId, recipientSessionId, content, operationId, at);
      this.#database.prepare(`
        UPDATE partner_private_threads SET message_count = ?, expires_at = ?, updated_at = ?,
          status = ?, close_reason = ?, blocked_until = ?, closed_at = ? WHERE id = ?
      `).run(nextCount, at + PARTNER_PRIVATE_IDLE_TIMEOUT_MS, at,
        ended ? "closed" : "active", ended ? "message_limit" : null,
        ended ? at + PARTNER_PRIVATE_LIMIT_COOLDOWN_MS : null, ended ? at : null, thread.id);
      thread = this.getPrivateThread(thread.id).thread;
      const message = this.getPrivateMessage(messageId);
      return {
        thread,
        message,
        remainingMessages: Math.max(0, thread.maxMessages - thread.messageCount),
        conversationEnded: ended
      };
    });
  }

  listPrivateThreads(partnerId: string): readonly PartnerPrivateThreadRecord[] {
    return this.#write(() => {
      const partner = this.getPartner(partnerId);
      const at = this.#now();
      this.#database.prepare(`
        UPDATE partner_private_threads
        SET status = 'closed', close_reason = 'idle_timeout', closed_at = ?, updated_at = ?
        WHERE (first_partner_id = ? OR second_partner_id = ?)
          AND status = 'active' AND expires_at <= ?
      `).run(at, at, partner.id, partner.id, at);
      const rows = this.#database.prepare(`
        SELECT * FROM partner_private_threads
        WHERE first_partner_id = ? OR second_partner_id = ?
        ORDER BY updated_at DESC, id DESC
      `).all(partner.id, partner.id) as Row[];
      return rows.map(partnerPrivateThread);
    });
  }

  getPrivateThread(threadId: string, viewerPartnerId?: string): PartnerPrivateThreadViewRecord {
    return this.#write(() => {
      const id = entityId(threadId, "Partner private thread ID");
      const at = this.#now();
      this.#database.prepare(`
        UPDATE partner_private_threads
        SET status = 'closed', close_reason = 'idle_timeout', closed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND expires_at <= ?
      `).run(at, at, id, at);
      const row = this.#database.prepare("SELECT * FROM partner_private_threads WHERE id = ?").get(id) as Row | undefined;
      if (row === undefined) throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner private thread was not found.");
      const thread = partnerPrivateThread(row);
      let readState: PartnerPrivateThreadReadStateRecord | undefined;
      if (viewerPartnerId !== undefined) {
        const viewer = entityId(viewerPartnerId, "Partner private thread viewer ID");
        assertThreadParticipant(thread, viewer);
        const readRow = this.#database.prepare(`
          SELECT * FROM partner_private_thread_reads WHERE thread_id = ? AND partner_id = ?
        `).get(thread.id, viewer) as Row | undefined;
        readState = readRow === undefined ? undefined : partnerPrivateThreadReadState(readRow);
      }
      const messageRows = this.#database.prepare(`
        SELECT * FROM partner_private_messages WHERE thread_id = ? AND delivery_status <> 'failed'
        ORDER BY sequence
      `).all(thread.id) as Row[];
      const messages = messageRows.map((messageRow) => this.#validatedPrivateMessage(messageRow));
      if (thread.messageCount !== messages.length) {
        throw unavailable("The partner private thread message count is inconsistent.");
      }
      return {
        thread,
        messages,
        ...(readState === undefined ? {} : { readState })
      };
    });
  }

  getPrivateMessage(messageId: string): PartnerPrivateMessageRecord {
    this.#assertOpen();
    const id = entityId(messageId, "Partner private message ID");
    const row = this.#database.prepare("SELECT * FROM partner_private_messages WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner private message was not found.");
    return this.#validatedPrivateMessage(row);
  }

  listPendingPrivateMessages(): readonly PartnerPrivateMessageRecord[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM partner_private_messages WHERE delivery_status = 'pending' ORDER BY created_at, id
    `).all() as Row[];
    return rows.map((row) => this.#validatedPrivateMessage(row));
  }

  markPrivateMessageDelivered(messageId: string, runId?: string): PartnerPrivateMessageRecord {
    return this.#write(() => {
      const current = this.getPrivateMessage(messageId);
      if (current.deliveryStatus === "delivered") return current;
      if (current.deliveryStatus === "failed") {
        throw new PartnerStoreError("PARTNER_INVALID", "A failed private message cannot become delivered.");
      }
      const normalizedRunId = runId === undefined ? undefined : entityId(runId, "Partner private message Run ID");
      this.#database.prepare(`
        UPDATE partner_private_messages SET delivery_status = 'delivered', run_id = ?, delivered_at = ? WHERE id = ?
      `).run(normalizedRunId ?? null, this.#now(), current.id);
      return this.getPrivateMessage(current.id);
    });
  }

  markPrivateMessageFailed(messageId: string, errorText: string): PartnerPrivateMessageRecord {
    return this.#write(() => {
      const current = this.getPrivateMessage(messageId);
      if (current.deliveryStatus === "delivered") {
        throw new PartnerStoreError("PARTNER_INVALID", "A delivered private message cannot become failed.");
      }
      const error = textValue(errorText, "Partner private message failure", MAX_ERROR_TEXT, true);
      if (current.deliveryStatus !== "failed") {
        this.#database.prepare(`
          UPDATE partner_private_messages SET delivery_status = 'failed', error_text = ?, delivered_at = NULL WHERE id = ?
        `).run(error, current.id);
      }
      const row = this.#database.prepare("SELECT * FROM partner_private_threads WHERE id = ?")
        .get(current.threadId) as Row | undefined;
      if (row === undefined) throw unavailable("The partner private message thread is missing.");
      const thread = partnerPrivateThread(row);
      const countRow = this.#database.prepare(`
        SELECT COUNT(*) AS count FROM partner_private_messages WHERE thread_id = ? AND delivery_status <> 'failed'
      `).get(thread.id) as Row;
      const liveCount = safeInteger(countRow["count"], "Partner private message count");
      const reopen = thread.closeReason === "message_limit" && liveCount < thread.maxMessages;
      this.#database.prepare(`
        UPDATE partner_private_threads SET message_count = ?, status = ?, close_reason = ?,
          blocked_until = ?, closed_at = ?, updated_at = ? WHERE id = ?
      `).run(liveCount, reopen ? "active" : thread.status, reopen ? null : thread.closeReason ?? null,
        reopen ? null : thread.blockedUntil ?? null, reopen ? null : thread.closedAt ?? null,
        this.#now(), thread.id);
      return this.getPrivateMessage(current.id);
    });
  }

  markPrivateThreadRead(
    threadId: string,
    partnerId: string,
    throughSequence: number
  ): PartnerPrivateThreadReadStateRecord {
    return this.#write(() => {
      const view = this.getPrivateThread(threadId, partnerId);
      const sequence = safeNonNegativeInteger(throughSequence, "Partner private read sequence");
      const maximum = view.messages.at(-1)?.sequence ?? 0;
      if (sequence > maximum) {
        throw new PartnerStoreError("PARTNER_INVALID", "The private-message read position exceeds the thread.");
      }
      const current = view.readState;
      if (current !== undefined && current.throughSequence >= sequence) return current;
      const at = this.#now();
      this.#database.prepare(`
        INSERT INTO partner_private_thread_reads(thread_id, partner_id, through_sequence, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, partner_id) DO UPDATE SET
          through_sequence = excluded.through_sequence, updated_at = excluded.updated_at
        WHERE excluded.through_sequence > partner_private_thread_reads.through_sequence
      `).run(view.thread.id, partnerId, sequence, at);
      const row = this.#database.prepare(`
        SELECT * FROM partner_private_thread_reads WHERE thread_id = ? AND partner_id = ?
      `).get(view.thread.id, partnerId) as Row | undefined;
      if (row === undefined) throw unavailable("The partner private read state was not saved.");
      return partnerPrivateThreadReadState(row);
    });
  }

  createDelegation(input: CreatePartnerDelegationInput): PartnerDelegationRecord {
    return this.#write(() => {
      const requesterPartnerId = entityId(input.requesterPartnerId, "Partner delegation requester ID");
      const targetPartnerId = entityId(input.targetPartnerId, "Partner delegation target ID");
      const parentSessionId = entityId(input.parentSessionId, "Partner delegation parent Session ID");
      const id = entityId(input.id ?? this.#idFactory(), "Partner delegation ID");
      const title = textValue(input.title, "Partner delegation title", MAX_DELEGATION_TITLE, true);
      const objective = multilineText(input.objective, "Partner delegation objective", MAX_DELEGATION_OBJECTIVE);
      const existingRow = this.#database.prepare("SELECT * FROM partner_delegations WHERE id = ?").get(id) as Row | undefined;
      if (existingRow !== undefined) {
        const existing = this.#validatedDelegation(existingRow);
        if (existing.requesterPartnerId !== requesterPartnerId
          || existing.targetPartnerId !== targetPartnerId
          || existing.parentSessionId !== parentSessionId
          || existing.title !== title
          || existing.objective !== objective) {
          throw new PartnerStoreError(
            "PARTNER_DELEGATION_CHANGED",
            `Partner delegation ${id} was already used with different input.`
          );
        }
        return existing;
      }
      const requester = this.getPartner(requesterPartnerId);
      const target = this.getPartner(targetPartnerId);
      if (requester.id === target.id) {
        throw new PartnerStoreError("PARTNER_INVALID", "A partner cannot delegate to itself.");
      }
      if (requester.lifecycle !== "active" || requester.initializationState !== "ready"
        || target.lifecycle !== "active" || target.initializationState !== "ready") {
        throw new PartnerStoreError("PARTNER_INVALID", "Both delegation participants must be active and ready.");
      }
      if (requester.canonicalSessionId !== parentSessionId) {
        throw new PartnerStoreError("PARTNER_SESSION_CONFLICT", "A delegation must start from the requester's canonical Session.");
      }
      const at = this.#now();
      this.#database.prepare(`
        INSERT INTO partner_delegations(
          id, revision, requester_partner_id, target_partner_id, parent_session_id,
          target_profile_version, title, objective, status, child_session_id, run_id,
          create_operation_id, enqueue_operation_id, result_summary, error_text,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'preparing', NULL, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
      `).run(id, requester.id, target.id, parentSessionId, target.profileVersion, title, objective,
        stablePartnerOperationId("partner-delegation-create", id),
        stablePartnerOperationId("partner-delegation-enqueue", id), at, at);
      return this.getDelegation(id);
    });
  }

  getDelegation(delegationId: string): PartnerDelegationRecord {
    this.#assertOpen();
    const id = entityId(delegationId, "Partner delegation ID");
    const row = this.#database.prepare("SELECT * FROM partner_delegations WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner delegation was not found.");
    return this.#validatedDelegation(row);
  }

  listDelegations(partnerId: string, options: {
    readonly asTarget?: boolean;
    readonly statuses?: readonly PartnerDelegationStatus[];
  } = {}): readonly PartnerDelegationRecord[] {
    const partner = this.getPartner(partnerId);
    const column = options.asTarget === true ? "target_partner_id" : "requester_partner_id";
    const rows = this.#database.prepare(`
      SELECT * FROM partner_delegations WHERE ${column} = ? ORDER BY updated_at DESC, id DESC
    `).all(partner.id) as Row[];
    const statuses = options.statuses?.map(partnerDelegationStatus);
    return rows.map((row) => this.#validatedDelegation(row))
      .filter((delegation) => statuses === undefined || statuses.includes(delegation.status));
  }

  listRecoverableDelegations(): readonly PartnerDelegationRecord[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM partner_delegations
      WHERE status IN ('preparing', 'queued', 'running', 'waiting', 'unknown')
      ORDER BY created_at, id
    `).all() as Row[];
    return rows.map((row) => this.#validatedDelegation(row));
  }

  bindDelegationSession(
    delegationId: string,
    expectedRevision: bigint,
    childSessionId: string
  ): PartnerDelegationRecord {
    return this.#write(() => {
      const current = this.getDelegation(delegationId);
      assertDelegationRevision(current, expectedRevision);
      const sessionId = entityId(childSessionId, "Partner delegation child Session ID");
      if (current.childSessionId !== undefined) {
        if (current.childSessionId === sessionId) return current;
        throw delegationChanged(current.id);
      }
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partner_delegations SET revision = ?, child_session_id = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND child_session_id IS NULL
      `).run(nextNumber(current.revision, "Partner delegation revision"), sessionId, at,
        current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw delegationChanged(current.id);
      this.#database.prepare(`
        INSERT INTO partner_session_links(
          session_id, partner_id, role, profile_version, parent_session_id, delegation_id, created_at
        ) VALUES (?, ?, 'delegation', ?, ?, ?, ?)
      `).run(sessionId, current.targetPartnerId, current.targetProfileVersion,
        current.parentSessionId, current.id, at);
      return this.getDelegation(current.id);
    });
  }

  transitionDelegation(input: TransitionPartnerDelegationInput): PartnerDelegationRecord {
    return this.#write(() => {
      const current = this.getDelegation(input.delegationId);
      assertDelegationRevision(current, input.expectedRevision);
      const status = partnerDelegationStatus(input.status);
      const runId = input.runId === undefined ? current.runId : entityId(input.runId, "Partner delegation Run ID");
      const resultSummary = input.resultSummary === undefined
        ? current.resultSummary
        : multilineText(input.resultSummary, "Partner delegation result", MAX_DELEGATION_RESULT);
      const errorText = input.errorText === undefined
        ? (status !== current.status && status !== "failed" && status !== "unknown" ? undefined : current.errorText)
        : textValue(input.errorText, "Partner delegation failure", MAX_ERROR_TEXT, true);
      if (status === current.status && runId === current.runId
        && resultSummary === current.resultSummary && errorText === current.errorText) return current;
      assertDelegationTransition(current, status);
      if ((status === "queued" || status === "running" || status === "waiting" || status === "completed")
        && current.childSessionId === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "The delegation has no child Session.");
      }
      if ((status === "queued" || status === "running" || status === "waiting" || status === "completed")
        && runId === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "The delegation has no Run.");
      }
      if (status === "completed" && resultSummary === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "A completed delegation requires a result summary.");
      }
      if (status !== "completed" && resultSummary !== undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "Only a completed delegation may keep a result summary.");
      }
      if (status === "failed" && errorText === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "A failed delegation requires an error.");
      }
      if (status !== "failed" && status !== "unknown" && errorText !== undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "Only a failed or unknown delegation may keep an error.");
      }
      const terminal = status === "completed" || status === "failed" || status === "cancelled";
      const at = this.#now();
      const result = this.#database.prepare(`
        UPDATE partner_delegations SET revision = ?, status = ?, run_id = ?, result_summary = ?, error_text = ?,
          updated_at = ?, started_at = ?, completed_at = ? WHERE id = ? AND revision = ?
      `).run(nextNumber(current.revision, "Partner delegation revision"), status, runId ?? null,
        resultSummary ?? null, errorText ?? null, at,
        current.startedAt ?? (status === "running" || status === "waiting" || status === "completed" ? at : null),
        terminal ? current.completedAt ?? at : null, current.id, Number(current.revision));
      if (Number(result.changes) !== 1) throw delegationChanged(current.id);
      return this.getDelegation(current.id);
    });
  }

  #validatedPrivateMessage(row: Row): PartnerPrivateMessageRecord {
    const message = partnerPrivateMessage(row);
    const threadRow = this.#database.prepare("SELECT * FROM partner_private_threads WHERE id = ?")
      .get(message.threadId) as Row | undefined;
    if (threadRow === undefined) throw unavailable("The partner private message thread is missing.");
    const thread = partnerPrivateThread(threadRow);
    assertPrivateMessageThread(message, thread);
    const senderLink = this.getSessionLink(message.senderSessionId);
    const recipientLink = this.getSessionLink(message.recipientSessionId);
    if (senderLink === undefined || recipientLink === undefined
      || senderLink.partnerId !== message.senderPartnerId
      || recipientLink.partnerId !== message.recipientPartnerId
      || senderLink.role === "delegation" || recipientLink.role === "delegation") {
      throw unavailable("The partner private message Session ownership is inconsistent.");
    }
    return message;
  }

  #validatedDelegation(row: Row): PartnerDelegationRecord {
    const delegation = partnerDelegation(row);
    const linkRows = this.#database.prepare(`
      SELECT * FROM partner_session_links WHERE delegation_id = ? ORDER BY session_id
    `).all(delegation.id) as Row[];
    if (delegation.childSessionId === undefined) {
      if (linkRows.length !== 0) throw unavailable("The partner delegation Session ownership is inconsistent.");
      return delegation;
    }
    if (linkRows.length !== 1) throw unavailable("The partner delegation Session ownership is inconsistent.");
    const link = partnerSessionLink(linkRows[0]!);
    if (link.sessionId !== delegation.childSessionId
      || link.partnerId !== delegation.targetPartnerId
      || link.role !== "delegation"
      || link.delegationId !== delegation.id
      || link.parentSessionId !== delegation.parentSessionId
      || link.profileVersion !== delegation.targetProfileVersion) {
      throw unavailable("The partner delegation Session ownership is inconsistent.");
    }
    return delegation;
  }

  #profile(row: Row): PartnerProfileRecord {
    try {
      const lifecycle = lifecycleValue(row["lifecycle"]);
      const initializationState = initializationStateValue(row["initialization_state"]);
      const invitationStage = invitationStageValue(row["invitation_stage"]);
      const rawError = row["initialization_error_code"];
      const initializationError = rawError === null || rawError === undefined
        ? undefined
        : initializationErrorCode(rawError);
      if ((initializationState === "error") !== (initializationError !== undefined)) {
        throw new Error("Partner initialization state and error code disagree.");
      }
      if ((initializationState === "ready") !== (invitationStage === "ready")) {
        throw new Error("Partner initialization state and invitation stage disagree.");
      }
      if ((initializationState === "error") !== (invitationStage === "failed")) {
        throw new Error("Partner initialization failure and invitation stage disagree.");
      }
      const canonicalSessionId = nullableEntityId(row["canonical_session_id"], "Canonical Session ID");
      if (initializationState === "ready" && canonicalSessionId === undefined) {
        throw new Error("A ready partner has no canonical Session.");
      }
      return {
        id: entityId(row["id"], "Partner ID"),
        revision: BigInt(safeInteger(row["revision"], "Partner revision")),
        profileVersion: positiveInteger(row["profile_version"], "Partner profile version"),
        displayName: displayName(row["display_name"]),
        avatar: avatarId(row["avatar"]),
        identitySource: identityValue(row["identity_source"]),
        templateId: templateId(row["template_id"]),
        lifecycle,
        initializationState,
        invitationStage,
        ...(initializationError === undefined ? {} : { initializationErrorCode: initializationError }),
        homeTargetId: entityId(row["home_target_id"], "Partner home Target ID"),
        ...(canonicalSessionId === undefined ? {} : { canonicalSessionId }),
        capabilities: capabilitiesFromRow(row),
        usesDirectoryDefaults: booleanInteger(row["uses_directory_defaults"], "Partner default inheritance"),
        createdAt: timestamp(row["created_at"], "Partner created time"),
        updatedAt: timestamp(row["updated_at"], "Partner updated time")
      };
    } catch (error) {
      if (error instanceof PartnerStoreError) throw error;
      throw unavailable(error instanceof Error ? error.message : "The partner profile is corrupt.");
    }
  }

  #insertVersion(
    partnerId: string,
    version: number,
    identitySource: string,
    capabilities: PartnerCapabilitiesRecord,
    usesDirectoryDefaults: boolean,
    at: number
  ): void {
    this.#database.prepare(`
      INSERT INTO partner_profile_versions(
        partner_id, version, identity_source, model_chain_json, permission_mode, plan_mode,
        uses_directory_defaults, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(partnerId, version, identitySource, modelChainJson(capabilities.modelChain),
      capabilities.permissionMode, capabilities.planMode ? 1 : 0, usesDirectoryDefaults ? 1 : 0, at);
  }

  #bumpDirectory(at: number): void {
    const row = this.#database.prepare("SELECT revision FROM partner_directory WHERE singleton = 1").get() as Row | undefined;
    if (row === undefined) throw unavailable("The partner directory row is missing.");
    const revision = safeInteger(row["revision"], "Partner directory revision");
    if (revision >= MAX_SAFE_REVISION) throw unavailable("The partner directory revision is exhausted.");
    this.#database.prepare("UPDATE partner_directory SET revision = ?, updated_at = ? WHERE singleton = 1")
      .run(revision + 1, at);
  }

  #initialize(): void {
    const marker = this.#database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partner_schema_version'
    `).get();
    if (marker === undefined) {
      const existing = this.#database.prepare(`
        SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' LIMIT 1
      `).get();
      if (existing !== undefined) throw unavailable("The partner database has an unknown schema. Rebuild the development database explicitly.");
      const at = this.#now();
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(PARTNER_SCHEMA);
        this.#database.prepare(`
          INSERT INTO partner_schema_version(singleton, version, baseline_id, initialized_at) VALUES (1, ?, ?, ?)
        `).run(PARTNER_SCHEMA_VERSION, PARTNER_SCHEMA_BASELINE_ID, at);
        this.#database.prepare(`
          INSERT INTO partner_directory(singleton, revision, created_at, updated_at) VALUES (1, 1, ?, ?)
        `).run(at, at);
        this.#database.exec("COMMIT");
      } catch (error) {
        try { this.#database.exec("ROLLBACK"); } catch {}
        throw error;
      }
      return;
    }
    const row = this.#database.prepare("SELECT version, baseline_id FROM partner_schema_version WHERE singleton = 1").get() as Row | undefined;
    if (row === undefined || safeInteger(row["version"], "Partner schema version") !== PARTNER_SCHEMA_VERSION
      || stringValue(row["baseline_id"], "Partner schema baseline") !== PARTNER_SCHEMA_BASELINE_ID) {
      throw unavailable("The partner database is not the current v1 baseline. Rebuild incompatible development data explicitly.");
    }
    const integrity = this.#database.prepare("PRAGMA quick_check").all() as Row[];
    if (integrity.length !== 1 || stringValue(integrity[0]?.["quick_check"], "Partner integrity result") !== "ok") {
      throw unavailable("The partner database failed its integrity check.");
    }
  }

  #write<T>(callback: () => T): T {
    this.#assertOpen();
    if (this.#writeDepth > 0) return callback();
    this.#database.exec("BEGIN IMMEDIATE");
    this.#writeDepth = 1;
    try {
      const result = callback();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      if (error instanceof PartnerStoreError) throw error;
      if (error instanceof Error && /partners\.normalized_name/u.test(error.message)) {
        throw new PartnerStoreError("PARTNER_NAME_CONFLICT", "Another active or archived partner uses this name.");
      }
      if (error instanceof Error && /(partners\.canonical_session_id|partner_session_links\.session_id|partner_session_links\.partner_id)/u.test(error.message)) {
        throw new PartnerStoreError("PARTNER_SESSION_CONFLICT", "The canonical Session belongs to another partner.");
      }
      throw error;
    } finally {
      this.#writeDepth = 0;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw unavailable("The partner store is closed.");
  }
}

function partnerSessionLink(row: Row): PartnerSessionLinkRecord {
  const role = partnerSessionRole(row["role"]);
  const parentSessionId = nullableEntityId(row["parent_session_id"], "Partner parent Session ID");
  const delegationId = nullableEntityId(row["delegation_id"], "Partner delegation ID");
  if ((role === "delegation") !== (delegationId !== undefined)
    || (role === "delegation") !== (parentSessionId !== undefined)) {
    throw unavailable("The partner Session link role is inconsistent.");
  }
  return {
    sessionId: entityId(row["session_id"], "Partner Session ID"),
    partnerId: entityId(row["partner_id"], "Partner Session owner ID"),
    role,
    profileVersion: positiveInteger(row["profile_version"], "Partner Session profile version"),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(delegationId === undefined ? {} : { delegationId }),
    createdAt: timestamp(row["created_at"], "Partner Session link created time")
  };
}

function partnerSessionRole(value: unknown): PartnerSessionRole {
  if (value === "canonical" || value === "history" || value === "delegation") return value;
  throw unavailable("The partner Session role is invalid.");
}

function partnerReadState(row: Row): PartnerReadStateRecord {
  return {
    partnerId: entityId(row["partner_id"], "Partner read-state owner ID"),
    throughCursor: BigInt(safeInteger(row["through_cursor"], "Partner read cursor")),
    updatedAt: timestamp(row["updated_at"], "Partner read-state updated time")
  };
}

function partnerPrivateThread(row: Row): PartnerPrivateThreadRecord {
  const status = partnerPrivateThreadStatus(row["status"]);
  const closeReason = nullablePrivateThreadCloseReason(row["close_reason"]);
  const blockedUntil = nullableTimestamp(row["blocked_until"], "Partner private thread blocked time");
  const closedAt = nullableTimestamp(row["closed_at"], "Partner private thread closed time");
  if ((status === "active") !== (closeReason === undefined) || (status === "active") !== (closedAt === undefined)) {
    throw unavailable("The partner private thread state is inconsistent.");
  }
  return {
    id: entityId(row["id"], "Partner private thread ID"),
    firstPartnerId: entityId(row["first_partner_id"], "Partner private thread first participant ID"),
    secondPartnerId: entityId(row["second_partner_id"], "Partner private thread second participant ID"),
    status,
    ...(closeReason === undefined ? {} : { closeReason }),
    messageCount: safeInteger(row["message_count"], "Partner private thread message count"),
    maxMessages: positiveInteger(row["max_messages"], "Partner private thread message limit"),
    expiresAt: timestamp(row["expires_at"], "Partner private thread expiry time"),
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
    createdAt: timestamp(row["created_at"], "Partner private thread created time"),
    updatedAt: timestamp(row["updated_at"], "Partner private thread updated time"),
    ...(closedAt === undefined ? {} : { closedAt })
  };
}

function partnerPrivateThreadStatus(value: unknown): PartnerPrivateThreadRecord["status"] {
  if (value === "active" || value === "closed") return value;
  throw unavailable("The partner private thread status is invalid.");
}

function nullablePrivateThreadCloseReason(value: unknown): PartnerPrivateThreadCloseReason | undefined {
  if (value === null || value === undefined) return undefined;
  if (value === "message_limit" || value === "idle_timeout") return value;
  throw unavailable("The partner private thread close reason is invalid.");
}

function partnerPrivateMessage(row: Row): PartnerPrivateMessageRecord {
  const deliveryStatus = partnerPrivateMessageDeliveryStatus(row["delivery_status"]);
  const runId = nullableEntityId(row["run_id"], "Partner private message Run ID");
  const errorText = nullableStoredText(row["error_text"], "Partner private message failure", MAX_ERROR_TEXT);
  const deliveredAt = nullableTimestamp(row["delivered_at"], "Partner private message delivered time");
  if ((deliveryStatus === "delivered") !== (deliveredAt !== undefined)
    || ((deliveryStatus === "failed") !== (errorText !== undefined))
    || (deliveryStatus === "pending" && runId !== undefined)) {
    throw unavailable("The partner private message delivery state is inconsistent.");
  }
  return {
    id: entityId(row["id"], "Partner private message ID"),
    threadId: entityId(row["thread_id"], "Partner private message thread ID"),
    sequence: positiveInteger(row["sequence"], "Partner private message sequence"),
    senderPartnerId: entityId(row["sender_partner_id"], "Partner private message sender ID"),
    recipientPartnerId: entityId(row["recipient_partner_id"], "Partner private message recipient ID"),
    senderSessionId: entityId(row["sender_session_id"], "Partner private message sender Session ID"),
    recipientSessionId: entityId(row["recipient_session_id"], "Partner private message recipient Session ID"),
    content: multilineText(row["content"], "Partner private message", MAX_PRIVATE_MESSAGE),
    deliveryStatus,
    operationId: entityId(row["operation_id"], "Partner private message Operation ID"),
    ...(runId === undefined ? {} : { runId }),
    ...(errorText === undefined ? {} : { errorText }),
    createdAt: timestamp(row["created_at"], "Partner private message created time"),
    ...(deliveredAt === undefined ? {} : { deliveredAt })
  };
}

function partnerPrivateMessageDeliveryStatus(value: unknown): PartnerPrivateMessageDeliveryStatus {
  if (value === "pending" || value === "delivered" || value === "failed") return value;
  throw unavailable("The partner private message delivery status is invalid.");
}

function partnerPrivateThreadReadState(row: Row): PartnerPrivateThreadReadStateRecord {
  return {
    threadId: entityId(row["thread_id"], "Partner private read thread ID"),
    partnerId: entityId(row["partner_id"], "Partner private read owner ID"),
    throughSequence: safeInteger(row["through_sequence"], "Partner private read sequence"),
    updatedAt: timestamp(row["updated_at"], "Partner private read updated time")
  };
}

function partnerDelegation(row: Row): PartnerDelegationRecord {
  const childSessionId = nullableEntityId(row["child_session_id"], "Partner delegation child Session ID");
  const runId = nullableEntityId(row["run_id"], "Partner delegation Run ID");
  const resultSummary = nullableStoredMultilineText(
    row["result_summary"], "Partner delegation result", MAX_DELEGATION_RESULT
  );
  const errorText = nullableStoredText(row["error_text"], "Partner delegation failure", MAX_ERROR_TEXT);
  const startedAt = nullableTimestamp(row["started_at"], "Partner delegation started time");
  const completedAt = nullableTimestamp(row["completed_at"], "Partner delegation completed time");
  const status = partnerDelegationStatus(row["status"]);
  const dispatched = status === "queued" || status === "running" || status === "waiting" || status === "completed";
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  if ((dispatched && (childSessionId === undefined || runId === undefined))
    || (terminal !== (completedAt !== undefined))
    || ((status === "running" || status === "waiting" || status === "completed") && startedAt === undefined)
    || ((status === "completed") !== (resultSummary !== undefined))
    || (status === "failed" && errorText === undefined)
    || (status !== "failed" && status !== "unknown" && errorText !== undefined)) {
    throw unavailable("The partner delegation state is inconsistent.");
  }
  return {
    id: entityId(row["id"], "Partner delegation ID"),
    revision: BigInt(positiveInteger(row["revision"], "Partner delegation revision")),
    requesterPartnerId: entityId(row["requester_partner_id"], "Partner delegation requester ID"),
    targetPartnerId: entityId(row["target_partner_id"], "Partner delegation target ID"),
    parentSessionId: entityId(row["parent_session_id"], "Partner delegation parent Session ID"),
    targetProfileVersion: positiveInteger(row["target_profile_version"], "Partner delegation profile version"),
    title: textValue(row["title"], "Partner delegation title", MAX_DELEGATION_TITLE, true),
    objective: multilineText(row["objective"], "Partner delegation objective", MAX_DELEGATION_OBJECTIVE),
    status,
    ...(childSessionId === undefined ? {} : { childSessionId }),
    ...(runId === undefined ? {} : { runId }),
    createOperationId: entityId(row["create_operation_id"], "Partner delegation create Operation ID"),
    enqueueOperationId: entityId(row["enqueue_operation_id"], "Partner delegation enqueue Operation ID"),
    ...(resultSummary === undefined ? {} : { resultSummary }),
    ...(errorText === undefined ? {} : { errorText }),
    createdAt: timestamp(row["created_at"], "Partner delegation created time"),
    updatedAt: timestamp(row["updated_at"], "Partner delegation updated time"),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt })
  };
}

function partnerDelegationStatus(value: unknown): PartnerDelegationStatus {
  if (value === "preparing" || value === "queued" || value === "running" || value === "waiting"
    || value === "completed" || value === "failed" || value === "cancelled" || value === "unknown") return value;
  throw unavailable("The partner delegation status is invalid.");
}

function assertDelegationRevision(delegation: PartnerDelegationRecord, expected: bigint): void {
  if (expected < 1n || expected > BigInt(MAX_SAFE_REVISION) || delegation.revision !== expected) {
    throw delegationChanged(delegation.id);
  }
}

function assertDelegationTransition(
  current: PartnerDelegationRecord,
  status: PartnerDelegationStatus
): void {
  if (status === current.status) return;
  const allowed: Record<PartnerDelegationStatus, readonly PartnerDelegationStatus[]> = {
    preparing: ["queued", "failed", "cancelled", "unknown"],
    queued: ["running", "waiting", "completed", "failed", "cancelled", "unknown"],
    running: ["waiting", "completed", "failed", "cancelled", "unknown"],
    waiting: ["running", "completed", "failed", "cancelled", "unknown"],
    unknown: ["queued", "running", "waiting", "completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: []
  };
  if (!allowed[current.status].includes(status)) {
    throw new PartnerStoreError("PARTNER_INVALID", "The partner delegation status transition is invalid.");
  }
}

function delegationChanged(delegationId: string): PartnerStoreError {
  return new PartnerStoreError(
    "PARTNER_DELEGATION_CHANGED",
    `Partner delegation ${delegationId} changed; read it again and retry.`
  );
}

function assertThreadParticipant(thread: PartnerPrivateThreadRecord, partnerId: string): void {
  if (thread.firstPartnerId !== partnerId && thread.secondPartnerId !== partnerId) {
    throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner private thread was not found.");
  }
}

function assertPrivateMessageThread(
  message: PartnerPrivateMessageRecord,
  thread: PartnerPrivateThreadRecord
): void {
  const forward = message.senderPartnerId === thread.firstPartnerId
    && message.recipientPartnerId === thread.secondPartnerId;
  const reverse = message.senderPartnerId === thread.secondPartnerId
    && message.recipientPartnerId === thread.firstPartnerId;
  if (message.threadId !== thread.id || (!forward && !reverse)) {
    throw unavailable("The partner private message participants are inconsistent with its thread.");
  }
}

function partnerPair(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left];
}

function stablePartnerOperationId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex")}`;
}

function partnerDraft(input: PartnerDraft): PartnerDraft {
  if (typeof input.usesDirectoryDefaults !== "boolean") {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner default inheritance must be boolean.");
  }
  return {
    displayName: displayName(input.displayName),
    avatar: avatarId(input.avatar),
    identitySource: identityValue(input.identitySource),
    templateId: templateId(input.templateId),
    capabilities: capabilitiesValue(input.capabilities),
    usesDirectoryDefaults: input.usesDirectoryDefaults
  };
}

function capabilitiesValue(value: PartnerCapabilitiesRecord): PartnerCapabilitiesRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner capabilities are required.");
  }
  const permissionMode = value.permissionMode;
  if (permissionMode !== "ask" && permissionMode !== "auto") {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner permission mode is invalid.");
  }
  if (typeof value.planMode !== "boolean") {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner Plan mode must be boolean.");
  }
  if (!Array.isArray(value.modelChain) || value.modelChain.length < 1 || value.modelChain.length > MAX_MODEL_ROUTES) {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner model chain must contain one to three routes.");
  }
  const routes = value.modelChain.map(modelRoute);
  const backendId = routes[0]!.backendId;
  if (routes.some((route) => route.backendId !== backendId)) {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner model routes must belong to one Backend.");
  }
  const identities = new Set<string>();
  for (const route of routes) {
    const identity = `${route.backendId}\0${route.providerId}\0${route.modelId}`;
    if (identities.has(identity)) throw new PartnerStoreError("PARTNER_INVALID", "Partner model routes must be unique.");
    identities.add(identity);
  }
  return { modelChain: routes, permissionMode, planMode: value.planMode };
}

function modelRoute(value: PartnerModelRouteRecord): PartnerModelRouteRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner model route is invalid.");
  }
  const backendId = entityId(value.backendId, "Partner route Backend ID");
  const providerId = entityId(value.providerId, "Partner route Provider ID");
  const modelId = routeText(value.modelId, "Partner route model ID");
  const rawEffort = value.effort?.trim();
  const effort = rawEffort === undefined || rawEffort === ""
    ? undefined
    : routeText(rawEffort, "Partner route effort", 64);
  if (typeof value.fastMode !== "boolean") {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner route Fast mode must be boolean.");
  }
  return { backendId, providerId, modelId, ...(effort === undefined ? {} : { effort }), fastMode: value.fastMode };
}

function capabilitiesFromRow(row: Row): PartnerCapabilitiesRecord {
  return capabilitiesFromColumns(row, "");
}

function nullableCapabilitiesFromRow(row: Row, prefix: string): PartnerCapabilitiesRecord | undefined {
  const rawModelChain = row[`${prefix}model_chain_json`];
  const rawPermission = row[`${prefix}permission_mode`];
  const rawPlan = row[`${prefix}plan_mode`];
  if (rawModelChain === null && rawPermission === null && rawPlan === null) return undefined;
  if (rawModelChain === null || rawPermission === null || rawPlan === null) {
    throw unavailable("Partner directory defaults are incomplete.");
  }
  return capabilitiesFromColumns(row, prefix);
}

function capabilitiesFromColumns(row: Row, prefix: string): PartnerCapabilitiesRecord {
  const raw = stringValue(row[`${prefix}model_chain_json`], "Partner model chain");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Partner model chain JSON is invalid."); }
  if (!Array.isArray(parsed)) throw new Error("Partner model chain must be an array.");
  const routes = parsed.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Partner model route is invalid.");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "backendId,fastMode,modelId,providerId" && keys !== "backendId,effort,fastMode,modelId,providerId") {
      throw new Error("Partner model route has unknown fields.");
    }
    return modelRoute({
      backendId: stringValue(record["backendId"], "Partner route Backend ID"),
      providerId: stringValue(record["providerId"], "Partner route Provider ID"),
      modelId: stringValue(record["modelId"], "Partner route model ID"),
      ...(record["effort"] === undefined ? {} : { effort: stringValue(record["effort"], "Partner route effort") }),
      fastMode: booleanInteger(record["fastMode"], "Partner route Fast mode")
    });
  });
  const permissionMode = stringValue(row[`${prefix}permission_mode`], "Partner permission mode");
  return capabilitiesValue({
    modelChain: routes,
    permissionMode: permissionMode === "ask" || permissionMode === "auto" ? permissionMode : permissionMode as never,
    planMode: booleanInteger(row[`${prefix}plan_mode`], "Partner Plan mode")
  });
}

function modelChainJson(routes: readonly PartnerModelRouteRecord[]): string {
  return JSON.stringify(routes.map((route) => ({
    backendId: route.backendId,
    providerId: route.providerId,
    modelId: route.modelId,
    ...(route.effort === undefined ? {} : { effort: route.effort }),
    fastMode: route.fastMode
  })));
}

function sameProfileContent(current: PartnerProfileRecord, next: PartnerDraft): boolean {
  return current.displayName === next.displayName
    && current.avatar === next.avatar
    && current.identitySource === next.identitySource
    && current.templateId === next.templateId
    && current.usesDirectoryDefaults === next.usesDirectoryDefaults
    && current.capabilities.permissionMode === next.capabilities.permissionMode
    && current.capabilities.planMode === next.capabilities.planMode
    && modelChainJson(current.capabilities.modelChain) === modelChainJson(next.capabilities.modelChain);
}

function sameCapabilities(current: PartnerCapabilitiesRecord, next: PartnerCapabilitiesRecord): boolean {
  return current.permissionMode === next.permissionMode
    && current.planMode === next.planMode
    && modelChainJson(current.modelChain) === modelChainJson(next.modelChain);
}

function assertMutable(profile: PartnerProfileRecord): void {
  if (profile.lifecycle === "deleted") throw new PartnerStoreError("PARTNER_INVALID", "The partner profile is deleted.");
}

function assertRevision(profile: PartnerProfileRecord, expected: bigint): void {
  if (expected < 1n || expected > BigInt(MAX_SAFE_REVISION) || profile.revision !== expected) throw changed(profile.id);
}

function changed(partnerId: string): PartnerStoreError {
  return new PartnerStoreError("PARTNER_CHANGED", `Partner ${partnerId} changed; read it again and retry.`);
}

function nextNumber(revision: bigint, label: string): number {
  if (revision < 1n || revision >= BigInt(MAX_SAFE_REVISION)) throw unavailable(`${label} is exhausted.`);
  return Number(revision + 1n);
}

function nextSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= MAX_SAFE_REVISION) throw unavailable(`${label} is exhausted.`);
  return value + 1;
}

function displayName(value: unknown): string {
  const result = textValue(value, "Partner display name", MAX_DISPLAY_NAME, true);
  if (result.normalize("NFKC").trim() === "") throw new PartnerStoreError("PARTNER_INVALID", "Partner display name is required.");
  return result;
}

export function normalizedPartnerName(value: string): string {
  return displayName(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function avatarId(value: unknown): string {
  const result = stringValue(value, "Partner avatar");
  if (!AVATAR_ID.test(result)) throw new PartnerStoreError("PARTNER_INVALID", "Partner avatar preset is invalid.");
  return result;
}

function templateId(value: unknown): string {
  const result = stringValue(value, "Partner template");
  if (!TEMPLATE_ID.test(result)) throw new PartnerStoreError("PARTNER_INVALID", "Partner template is invalid.");
  return result;
}

function lifecycleValue(value: unknown): PartnerLifecycle {
  if (value === "active" || value === "archived" || value === "deleted") return value;
  throw new PartnerStoreError("PARTNER_INVALID", "Partner lifecycle is invalid.");
}

function initializationStateValue(value: unknown): PartnerInitializationState {
  if (value === "pending" || value === "ready" || value === "error") return value;
  throw new Error("Partner initialization state is invalid.");
}

function invitationStageValue(value: unknown): PartnerInvitationStage {
  if (value === "home" || value === "avatar" || value === "session"
    || value === "ready" || value === "failed") return value;
  throw new Error("Partner invitation stage is invalid.");
}

function initializationErrorCode(value: unknown): PartnerInitializationErrorCode {
  if (value === "home_unavailable" || value === "avatar_unavailable" || value === "model_unavailable"
    || value === "session_unavailable" || value === "state_changed") return value;
  throw new PartnerStoreError("PARTNER_INVALID", "Partner initialization error code is invalid.");
}

function entityId(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!ENTITY_ID.test(result)) throw new PartnerStoreError("PARTNER_INVALID", `${label} is invalid.`);
  return result;
}

function nullableEntityId(value: unknown, label: string): string | undefined {
  return value === null || value === undefined ? undefined : entityId(value, label);
}

function routeText(value: unknown, label: string, maximum = 128, allowEmpty = false): string {
  return textValue(value, label, maximum, !allowEmpty);
}

function identityValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner identity source must be text.");
  }
  const result = value.replace(/\r\n?/gu, "\n").trim();
  if (result === "" || result.length > MAX_IDENTITY_SOURCE || FORBIDDEN_MULTILINE_TEXT.test(result)) {
    throw new PartnerStoreError("PARTNER_INVALID", "Partner identity source is invalid or exceeds its limit.");
  }
  return result;
}

function multilineText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new PartnerStoreError("PARTNER_INVALID", `${label} must be text.`);
  const result = value.replace(/\r\n?/gu, "\n").trim();
  if (result === "" || result.length > maximum || FORBIDDEN_MULTILINE_TEXT.test(result)) {
    throw new PartnerStoreError("PARTNER_INVALID", `${label} is invalid or exceeds its limit.`);
  }
  return result;
}

function textValue(value: unknown, label: string, maximum: number, required: boolean): string {
  if (typeof value !== "string") throw new PartnerStoreError("PARTNER_INVALID", `${label} must be text.`);
  const result = value.trim();
  if (required && result === "") throw new PartnerStoreError("PARTNER_INVALID", `${label} is required.`);
  if (result.length > maximum || FORBIDDEN_INLINE_TEXT.test(result)) {
    throw new PartnerStoreError("PARTNER_INVALID", `${label} is invalid or exceeds its limit.`);
  }
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe integer.`);
  return value;
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  try {
    return safeInteger(value, label);
  } catch {
    throw new PartnerStoreError("PARTNER_INVALID", `${label} must be a non-negative safe integer.`);
  }
}

function revisionNumber(value: bigint, label: string, allowZero = false): number {
  const minimum = allowZero ? 0n : 1n;
  if (typeof value !== "bigint" || value < minimum || value > BigInt(MAX_SAFE_REVISION)) {
    throw new PartnerStoreError("PARTNER_INVALID", `${label} is invalid.`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive.`);
  return result;
}

function timestamp(value: unknown, label: string): number {
  return safeInteger(value, label);
}

function nullableTimestamp(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : timestamp(value, label);
}

function nullableStoredText(value: unknown, label: string, maximum: number): string | undefined {
  return value === null || value === undefined ? undefined : textValue(value, label, maximum, true);
}

function nullableStoredMultilineText(value: unknown, label: string, maximum: number): string | undefined {
  return value === null || value === undefined ? undefined : multilineText(value, label, maximum);
}

function booleanInteger(value: unknown, label: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  if (value === false || value === true) return value;
  throw new Error(`${label} must be boolean.`);
}

function unavailable(message: string): PartnerStoreError {
  return new PartnerStoreError("PARTNER_STORE_UNAVAILABLE", message);
}
