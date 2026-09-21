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
  PartnerModelRouteRecord,
  PartnerPatch,
  PartnerProfileRecord,
  PartnerProfileVersionRecord
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

const PARTNER_SCHEMA_VERSION = 1;
const MAX_SAFE_REVISION = 9_007_199_254_740_991;
const MAX_PARTNERS = 1_000;
const MAX_DISPLAY_NAME = 100;
const MAX_IDENTITY_SOURCE = 8_000;
const MAX_MODEL_ROUTES = 3;
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
      if (error instanceof Error && /partners\.canonical_session_id/u.test(error.message)) {
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

function positiveInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive.`);
  return result;
}

function timestamp(value: unknown, label: string): number {
  return safeInteger(value, label);
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
