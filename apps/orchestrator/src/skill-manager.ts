import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OperationalStore } from "@joko/store";
import { parseDocument } from "yaml";

import type {
  PiResourceDescriptor,
  PiResourceManager,
  PiSkillContentLease,
  PiSkillContentMutationResult,
  PreparedPiResourceMutation
} from "./resource-manager.js";

export type SkillCatalogScope = "global" | "project";

export interface SkillCatalogEntry {
  readonly id: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: SkillCatalogScope;
  readonly name: string;
  readonly sourceLabel: string;
  readonly state: PiResourceDescriptor["state"];
  readonly enabled: boolean;
  readonly canToggle: boolean;
  readonly contentAvailable: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly resourceVersion: bigint;
  readonly approvedRevision: string;
  readonly updatedAt: number;
}

export interface SkillCatalogSnapshot {
  readonly revision: bigint;
  readonly skills: readonly SkillCatalogEntry[];
}

export interface SkillFileEntry {
  readonly key: string;
  readonly name: string;
  readonly kind: "directory" | "file";
  readonly size: number;
  readonly editable: boolean;
}

export interface SkillFileContent {
  readonly key: string;
  readonly content: string;
  readonly revision: string;
  readonly size: number;
  readonly editable: boolean;
}

export interface SkillMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly frontmatterJson: string;
  readonly parseError?: string;
}

export interface SkillDiffChange {
  readonly key: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly binary: boolean;
  readonly unifiedDiff?: string;
}

export interface SkillDiff {
  readonly available: boolean;
  readonly reason?: string;
  readonly changes: readonly SkillDiffChange[];
  readonly truncated: boolean;
}

export interface SkillSessionDetails {
  readonly sessionId: string;
  readonly skill: SkillCatalogEntry;
  readonly observedRevision: string;
  readonly dirty: boolean;
  readonly baselineAvailable: boolean;
  readonly metadata: SkillMetadata;
  readonly fileCount: number;
  readonly bytes: number;
  readonly diff: SkillDiff;
  readonly expiresAt: number;
}

export interface SkillDraftPreview {
  readonly draftId: string;
  readonly sessionId: string;
  readonly skillId: string;
  readonly kind: "edit" | "rename";
  readonly name: string;
  readonly resourceVersion: bigint;
  readonly observedRevision: string;
  readonly changes: readonly SkillDiffChange[];
  readonly expiresAt: number;
}

export interface SkillRecoveryRecord {
  readonly id: string;
  readonly skillId: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: SkillCatalogScope;
  readonly name: string;
  readonly revision: string;
  readonly files: number;
  readonly bytes: number;
  readonly createdAt: number;
  readonly status: "ready" | "missing";
}

export interface SkillManagerOptions {
  readonly resources: PiResourceManager;
  readonly store: OperationalStore;
  readonly rootDirectory: string;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maximumSessions?: number;
  readonly maximumDrafts?: number;
  readonly maximumPreviewBytes?: number;
  readonly maximumEditBytes?: number;
}

const preparedSkillMutationBrand = Symbol("PreparedSkillMutation");

export interface PreparedSkillMutation<T> {
  readonly value: T;
  readonly revokesRuntimeAuthority: boolean;
  readonly recoveryId?: string;
  readonly [preparedSkillMutationBrand]: true;
}

interface ActiveSkillSession {
  readonly id: string;
  readonly connectionId: string;
  readonly resourceId: string;
  readonly resourceVersion: bigint;
  readonly approvedRevision: string;
  readonly observedRevision: string;
  readonly root: string;
  readonly baselineRoot?: string;
  readonly lease: PiSkillContentLease;
  readonly snapshotFiles: number;
  readonly snapshotBytes: number;
  readonly metadata: SkillMetadata;
  readonly expiresAt: number;
}

interface ActiveSkillDraft {
  readonly id: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly resourceId: string;
  readonly resourceVersion: bigint;
  readonly observedRevision: string;
  readonly root: string;
  readonly kind: "edit" | "rename";
  readonly name: string;
  changes: readonly SkillDiffChange[];
  readonly expiresAt: number;
  preparing: boolean;
  consumed: boolean;
}

interface StoredSkillRecoveryRecord extends Omit<SkillRecoveryRecord, "status"> {
  readonly directoryName: string;
}

interface StoredSkillState {
  readonly format: 1;
  readonly recoveries: readonly StoredSkillRecoveryRecord[];
}

interface PreparedSkillMutationInternal<T> {
  readonly resourceMutation: PreparedPiResourceMutation<T>;
  readonly draft?: ActiveSkillDraft;
  readonly recovery?: StoredSkillRecoveryRecord;
  completed: boolean;
}

interface PrivateTreeInspection {
  readonly revision: string;
  readonly files: number;
  readonly bytes: number;
}

interface VisibleFile {
  readonly key: string;
  readonly size: number;
  readonly hash: string;
  readonly text?: string;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAXIMUM_SESSIONS = 32;
const DEFAULT_MAXIMUM_DRAFTS = 64;
const DEFAULT_MAXIMUM_PREVIEW_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_EDIT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_FRONTMATTER_BYTES = 256 * 1024;
const MAXIMUM_DIFF_CHANGES = 500;
const MAXIMUM_UNIFIED_DIFF_BYTES = 256 * 1024;
const SKILL_SESSION_ID = /^skill_session_[a-f0-9]{32}$/u;
const SKILL_DRAFT_ID = /^skill_draft_[a-f0-9]{32}$/u;
const SKILL_RECOVERY_ID = /^skill_recovery_[a-f0-9]{32}$/u;
const SAFE_CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

/**
 * Path-private content owner for standalone Skills. Resource authority remains
 * in PiResourceManager; this owner only holds exact snapshots, drafts, diffs,
 * and recovery records tied to a connection and Resource revision.
 */
export class SkillManager {
  readonly #resources: PiResourceManager;
  readonly #store: OperationalStore;
  readonly #rootDirectory: string;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maximumSessions: number;
  readonly #maximumDrafts: number;
  readonly #maximumPreviewBytes: number;
  readonly #maximumEditBytes: number;
  readonly #sessions = new Map<string, ActiveSkillSession>();
  readonly #drafts = new Map<string, ActiveSkillDraft>();
  readonly #recoveries = new Map<string, StoredSkillRecoveryRecord>();
  readonly #prepared = new WeakMap<object, PreparedSkillMutationInternal<unknown>>();
  #catalogRevision = 0n;
  #catalogIdentity = "";
  #tail: Promise<void> = Promise.resolve();
  #expirationTimer?: NodeJS.Timeout;
  #initialized = false;
  #closed = false;

  constructor(options: SkillManagerOptions) {
    if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory) {
      throw new Error("Skill manager root must be a normalized absolute path.");
    }
    this.#resources = options.resources;
    this.#store = options.store;
    this.#rootDirectory = options.rootDirectory;
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
    this.#ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "Skill session TTL");
    this.#maximumSessions = positiveInteger(options.maximumSessions ?? DEFAULT_MAXIMUM_SESSIONS, "Skill session limit");
    this.#maximumDrafts = positiveInteger(options.maximumDrafts ?? DEFAULT_MAXIMUM_DRAFTS, "Skill draft limit");
    this.#maximumPreviewBytes = positiveInteger(options.maximumPreviewBytes ?? DEFAULT_MAXIMUM_PREVIEW_BYTES, "Skill preview byte limit");
    this.#maximumEditBytes = positiveInteger(options.maximumEditBytes ?? DEFAULT_MAXIMUM_EDIT_BYTES, "Skill edit byte limit");
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#rootDirectory, "Skill manager root");
    for (const name of ["sessions", "drafts"]) {
      const path = join(this.#rootDirectory, name);
      await rm(path, { recursive: true, force: true });
      await mkdir(path, { recursive: false, mode: 0o700 });
    }
    for (const name of ["baselines", "recoveries"]) {
      await mkdir(join(this.#rootDirectory, name), { recursive: true, mode: 0o700 });
    }
    const stored = this.#store.findSetting<StoredSkillState>("service", this.#scopeId, "skill_content_state");
    if (stored !== undefined) {
      const state = validateStoredSkillState(stored.value);
      for (const recovery of state.recoveries) this.#recoveries.set(recovery.id, recovery);
    }
    await this.#reconcileRecoveryDirectory();
    this.#initialized = true;
    await this.reconcile();
    this.#expirationTimer = setInterval(() => { void this.#mutate(() => this.#pruneExpired()); }, Math.min(this.#ttlMs, 60_000));
    this.#expirationTimer.unref();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#expirationTimer !== undefined) clearInterval(this.#expirationTimer);
    await this.#mutate(async () => {
      for (const session of [...this.#sessions.values()]) await this.#closeSession(session);
      for (const draft of [...this.#drafts.values()]) await this.#removeDraft(draft);
    });
  }

  async reconcile(): Promise<SkillCatalogSnapshot> {
    return this.#mutate(() => this.#reconcileCatalog());
  }

  async #reconcileCatalog(): Promise<SkillCatalogSnapshot> {
    this.#assertUsable();
    const skills = this.#catalogEntries();
    const identity = JSON.stringify(skills, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value);
    if (identity !== this.#catalogIdentity) {
      this.#catalogIdentity = identity;
      this.#catalogRevision += 1n;
    }
    for (const session of [...this.#sessions.values()]) {
      const current = skills.find((entry) => entry.id === session.resourceId);
      if (current === undefined || current.resourceVersion !== session.resourceVersion) await this.#closeSession(session);
    }
    return { revision: this.#catalogRevision, skills };
  }

  list(input: {
    readonly query?: string;
    readonly backendId?: string;
    readonly targetId?: string;
    readonly scope?: SkillCatalogScope;
  } = {}): SkillCatalogSnapshot {
    this.#assertUsable();
    const query = input.query?.trim().toLocaleLowerCase("en-US") ?? "";
    const skills = this.#catalogEntries()
      .filter((entry) => input.backendId === undefined || entry.backendId === input.backendId)
      .filter((entry) => input.targetId === undefined || entry.targetId === input.targetId)
      .filter((entry) => input.scope === undefined || entry.scope === input.scope)
      .filter((entry) => query === "" || `${entry.name}\n${entry.sourceLabel}\n${entry.backendId}`.toLocaleLowerCase("en-US").includes(query));
    return { revision: this.#catalogRevision, skills };
  }

  async openSkill(
    connectionId: string,
    resourceId: string,
    expectedResourceVersion: bigint
  ): Promise<SkillSessionDetails> {
    return this.#mutate(async () => {
      this.#assertUsable();
      await this.#pruneExpired();
      const owner = validConnectionId(connectionId);
      if (this.#sessions.size >= this.#maximumSessions) throw new Error("Too many Skill detail sessions are open.");
      const lease = await this.#resources.acquireSkillContent({ resourceId, expectedResourceVersion });
      const id = `skill_session_${randomUUID().replaceAll("-", "")}`;
      const root = join(this.#rootDirectory, "sessions", id);
      try {
        await mkdir(root, { recursive: false, mode: 0o700 });
        const snapshot = await lease.snapshotTo(root);
        const baselineRoot = await this.#resolveBaselineRoot(
          lease.resource.id,
          lease.approvedRevision,
          lease.dirty ? undefined : root
        );
        const metadata = await parseSkillMetadata(root);
        const session: ActiveSkillSession = {
          id,
          connectionId: owner,
          resourceId: lease.resource.id,
          resourceVersion: lease.resource.versionNumber,
          approvedRevision: lease.approvedRevision,
          observedRevision: lease.observedRevision,
          root,
          ...(baselineRoot === undefined ? {} : { baselineRoot }),
          lease,
          snapshotFiles: snapshot.files,
          snapshotBytes: snapshot.bytes,
          metadata,
          expiresAt: this.#now() + this.#ttlMs
        };
        this.#sessions.set(id, session);
        return this.#sessionDetails(session);
      } catch (error) {
        await lease.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async listFiles(connectionId: string, sessionId: string, parentKey = ""): Promise<readonly SkillFileEntry[]> {
    return this.#mutate(async () => {
      const session = await this.#requireSession(connectionId, sessionId);
      const parent = resolvePortableKey(session.root, parentKey, true);
      return listVisibleChildren(session.root, parent, parentKey, this.#maximumEditBytes);
    });
  }

  async readFile(connectionId: string, sessionId: string, key: string): Promise<SkillFileContent> {
    return this.#mutate(async () => {
      const session = await this.#requireSession(connectionId, sessionId);
      return readVisibleTextFile(session.root, key, this.#maximumPreviewBytes, this.#maximumEditBytes);
    });
  }

  async getDiff(connectionId: string, sessionId: string): Promise<SkillDiff> {
    return this.#mutate(async () => {
      const session = await this.#requireSession(connectionId, sessionId);
      if (session.baselineRoot === undefined) {
        return {
          available: false,
          reason: "The approved baseline is unavailable; current content is treated as dirty.",
          changes: [],
          truncated: false
        };
      }
      return compareSkillTrees(session.baselineRoot, session.root, this.#maximumPreviewBytes);
    });
  }

  async prepareFileEdit(input: {
    readonly connectionId: string;
    readonly sessionId: string;
    readonly key: string;
    readonly expectedFileRevision: string;
    readonly content: string;
  }): Promise<SkillDraftPreview> {
    return this.#mutate(async () => {
      const session = await this.#requireSession(input.connectionId, input.sessionId);
      await session.lease.assertCurrent();
      if (this.#drafts.size >= this.#maximumDrafts) throw new Error("Too many Skill drafts are open.");
      const current = await readVisibleTextFile(session.root, input.key, this.#maximumEditBytes, this.#maximumEditBytes);
      if (!current.editable) throw new Error("This Skill file is too large to edit in the app.");
      if (current.revision !== normalizedRevision(input.expectedFileRevision)) throw new Error("Skill file revision is stale.");
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > this.#maximumEditBytes) throw new Error("Skill edit exceeds the configured byte limit.");
      const draft = await this.#createDraft(session, "edit", session.lease.resource.name);
      try {
        const destination = resolvePortableKey(draft.root, input.key, false);
        const info = await lstat(destination);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Only an existing regular Skill file may be edited.");
        await atomicWriteUtf8(destination, input.content);
        const changedInspection = await inspectPrivateTree(draft.root, this.#resources.maximumFiles, this.#resources.maximumBytes);
        void changedInspection;
        const diff = await compareSkillTrees(session.root, draft.root, this.#maximumPreviewBytes);
        draft.changes = diff.changes;
        return publicDraft(draft);
      } catch (error) {
        await this.#removeDraft(draft);
        throw error;
      }
    });
  }

  async prepareRename(input: {
    readonly connectionId: string;
    readonly sessionId: string;
    readonly name: string;
  }): Promise<SkillDraftPreview> {
    return this.#mutate(async () => {
      const session = await this.#requireSession(input.connectionId, input.sessionId);
      await session.lease.assertCurrent();
      if (this.#drafts.size >= this.#maximumDrafts) throw new Error("Too many Skill drafts are open.");
      const name = portableSkillName(input.name);
      if (name === session.lease.resource.name && name === session.metadata.name) throw new Error("Skill already has that name.");
      const draft = await this.#createDraft(session, "rename", name);
      try {
        const manifest = await readVisibleTextFile(draft.root, "SKILL.md", MAXIMUM_FRONTMATTER_BYTES, MAXIMUM_FRONTMATTER_BYTES);
        await atomicWriteUtf8(join(draft.root, "SKILL.md"), updateSkillManifestName(manifest.content, name));
        const metadata = await parseSkillMetadata(draft.root);
        if (metadata.parseError !== undefined || metadata.name !== name) throw new Error("Renamed Skill frontmatter is invalid.");
        const diff = await compareSkillTrees(session.root, draft.root, this.#maximumPreviewBytes);
        draft.changes = diff.changes;
        return publicDraft(draft);
      } catch (error) {
        await this.#removeDraft(draft);
        throw error;
      }
    });
  }

  async prepareApplyDraft(
    connectionId: string,
    draftId: string
  ): Promise<PreparedSkillMutation<PiSkillContentMutationResult>> {
    return this.#mutate(async () => {
      const draft = this.#requireDraft(connectionId, draftId);
      if (draft.preparing) throw new Error("Skill draft is already being applied.");
      const session = await this.#requireSession(connectionId, draft.sessionId);
      if (session.resourceId !== draft.resourceId || session.resourceVersion !== draft.resourceVersion) {
        throw new Error("Skill draft authority no longer matches its detail session.");
      }
      await session.lease.assertCurrent();
      draft.preparing = true;
      try {
        const resourceMutation = await this.#resources.prepareReplaceSkillContent({
          resourceId: draft.resourceId,
          expectedResourceVersion: draft.resourceVersion,
          expectedObservedRevision: draft.observedRevision,
          candidateRoot: draft.root,
          changedByConnectionId: draft.connectionId,
          ...(draft.kind === "rename" ? { name: draft.name } : {})
        });
        return this.#wrapPrepared(resourceMutation, { draft });
      } catch (error) {
        draft.preparing = false;
        throw error;
      }
    });
  }

  async prepareSetEnabled(input: {
    readonly resourceId: string;
    readonly expectedResourceVersion: bigint;
    readonly enabled: boolean;
  }): Promise<PreparedSkillMutation<PiResourceDescriptor>> {
    return this.#mutate(async () => {
      this.#assertUsable();
      const current = this.#resources.get(input.resourceId);
      if (current.kind !== "skill") throw new Error("Resource is not a Skill.");
      if (current.versionNumber !== input.expectedResourceVersion) throw new Error("Skill Resource revision is stale.");
      return this.#wrapPrepared(await this.#resources.prepareSetEnabled(current.id, input.enabled), {});
    });
  }

  async prepareDelete(input: {
    readonly connectionId: string;
    readonly sessionId: string;
    readonly confirmation: string;
  }): Promise<PreparedSkillMutation<PiResourceDescriptor>> {
    return this.#mutate(async () => {
      const session = await this.#requireSession(input.connectionId, input.sessionId);
      await session.lease.assertCurrent();
      if (input.confirmation !== session.lease.resource.name) throw new Error("Skill deletion confirmation does not match its exact name.");
      const id = `skill_recovery_${randomUUID().replaceAll("-", "")}`;
      const directoryName = id;
      const destination = join(this.#rootDirectory, "recoveries", directoryName);
      await mkdir(destination, { recursive: false, mode: 0o700 });
      try {
        const resourceMutation = await this.#resources.prepareRemoveSkillContent({
          resourceId: session.resourceId,
          expectedResourceVersion: session.resourceVersion,
          expectedObservedRevision: session.observedRevision,
          recoveryDestination: destination
        });
        const inspection = await inspectPrivateTree(destination, this.#resources.maximumFiles, this.#resources.maximumBytes);
        const recovery: StoredSkillRecoveryRecord = {
          id,
          skillId: session.resourceId,
          backendId: session.lease.resource.backendId,
          ...(session.lease.resource.targetId === undefined ? {} : { targetId: session.lease.resource.targetId }),
          scope: session.lease.resource.scope === "project" ? "project" : "global",
          name: session.lease.resource.name,
          revision: inspection.revision,
          files: inspection.files,
          bytes: inspection.bytes,
          createdAt: this.#now(),
          directoryName
        };
        return this.#wrapPrepared(resourceMutation, { recovery });
      } catch (error) {
        await rm(destination, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async completePreparedMutation<T, TResult>(
    prepared: PreparedSkillMutation<T>,
    completion: (finalize: (store: OperationalStore) => void) => TResult
  ): Promise<TResult> {
    return this.#mutate(async () => {
      this.#assertUsable();
      const internal = this.#prepared.get(prepared as object) as PreparedSkillMutationInternal<T> | undefined;
      if (internal === undefined) throw new Error("Prepared Skill mutation does not belong to this manager.");
      if (internal.completed) throw new Error("Prepared Skill mutation has already completed.");
      try {
        const result = await this.#resources.completePreparedMutation(internal.resourceMutation, (finalizeResource) => completion((store) => {
          finalizeResource(store);
          if (internal.recovery !== undefined) {
            this.#persistRecoveries(store, [...this.#recoveries.values(), internal.recovery]);
          }
        }));
        internal.completed = true;
        if (internal.recovery !== undefined) this.#recoveries.set(internal.recovery.id, internal.recovery);
        if (internal.draft !== undefined) {
          internal.draft.preparing = false;
          internal.draft.consumed = true;
          await this.#removeDraft(internal.draft);
        }
        await this.#reconcileCatalog();
        return result;
      } catch (error) {
        internal.completed = true;
        if (internal.draft !== undefined) internal.draft.preparing = false;
        throw error;
      }
    });
  }

  async applyDraft(connectionId: string, draftId: string): Promise<PiSkillContentMutationResult> {
    const prepared = await this.prepareApplyDraft(connectionId, draftId);
    return this.completePreparedMutation(prepared, (finalize) => this.#store.transaction((store) => {
      finalize(store);
      return prepared.value;
    }));
  }

  async setEnabled(input: {
    readonly resourceId: string;
    readonly expectedResourceVersion: bigint;
    readonly enabled: boolean;
  }): Promise<PiResourceDescriptor> {
    const prepared = await this.prepareSetEnabled(input);
    return this.completePreparedMutation(prepared, (finalize) => this.#store.transaction((store) => {
      finalize(store);
      return prepared.value;
    }));
  }

  async delete(input: {
    readonly connectionId: string;
    readonly sessionId: string;
    readonly confirmation: string;
  }): Promise<PiResourceDescriptor> {
    const prepared = await this.prepareDelete(input);
    return this.completePreparedMutation(prepared, (finalize) => this.#store.transaction((store) => {
      finalize(store);
      return prepared.value;
    }));
  }

  async listRecoveries(): Promise<readonly SkillRecoveryRecord[]> {
    return this.#mutate(async () => {
      this.#assertUsable();
      const result: SkillRecoveryRecord[] = [];
      for (const record of this.#recoveries.values()) {
        const path = join(this.#rootDirectory, "recoveries", record.directoryName);
        const status = await isCanonicalDirectory(path) ? "ready" : "missing";
        const { directoryName: _directoryName, ...publicRecord } = record;
        result.push({ ...publicRecord, status });
      }
      return result.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id, "en"));
    });
  }

  async closeSession(connectionId: string, sessionId: string): Promise<boolean> {
    return this.#mutate(async () => {
      const owner = validConnectionId(connectionId);
      const id = validSessionId(sessionId);
      const session = this.#sessions.get(id);
      if (session === undefined) return false;
      if (session.connectionId !== owner) throw new Error("Skill detail session belongs to another connection.");
      await this.#closeSession(session);
      return true;
    });
  }

  async revokeConnection(connectionId: string): Promise<void> {
    await this.#mutate(async () => {
      const owner = validConnectionId(connectionId);
      for (const draft of [...this.#drafts.values()]) {
        if (draft.connectionId === owner) await this.#removeDraft(draft);
      }
      for (const session of [...this.#sessions.values()]) {
        if (session.connectionId === owner) await this.#closeSession(session);
      }
    });
  }

  #catalogEntries(): readonly SkillCatalogEntry[] {
    return this.#resources.list({ kind: "skill" })
      .filter((resource) => resource.state !== "removed")
      .map(skillCatalogEntryFromResource)
      .sort((left, right) => left.scope.localeCompare(right.scope, "en") || left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
  }

  async #sessionDetails(session: ActiveSkillSession): Promise<SkillSessionDetails> {
    const skill = this.#catalogEntries().find((entry) => entry.id === session.resourceId);
    if (skill === undefined || skill.resourceVersion !== session.resourceVersion) throw new Error("Skill Resource authority changed while opening details.");
    const diff = session.baselineRoot === undefined
      ? { available: false, reason: "The approved baseline is unavailable; current content is treated as dirty.", changes: [], truncated: false } as const
      : await compareSkillTrees(session.baselineRoot, session.root, this.#maximumPreviewBytes);
    return {
      sessionId: session.id,
      skill,
      observedRevision: session.observedRevision,
      dirty: session.observedRevision !== session.approvedRevision,
      baselineAvailable: session.baselineRoot !== undefined,
      metadata: session.metadata,
      fileCount: session.snapshotFiles,
      bytes: session.snapshotBytes,
      diff,
      expiresAt: session.expiresAt
    };
  }

  async #createDraft(session: ActiveSkillSession, kind: "edit" | "rename", name: string): Promise<ActiveSkillDraft> {
    const id = `skill_draft_${randomUUID().replaceAll("-", "")}`;
    const root = join(this.#rootDirectory, "drafts", id);
    await mkdir(root, { recursive: false, mode: 0o700 });
    try {
      await copyPrivateTree(session.root, root, this.#resources.maximumFiles, this.#resources.maximumBytes);
      const draft: ActiveSkillDraft = {
        id,
        sessionId: session.id,
        connectionId: session.connectionId,
        resourceId: session.resourceId,
        resourceVersion: session.resourceVersion,
        observedRevision: session.observedRevision,
        root,
        kind,
        name,
        changes: [],
        expiresAt: this.#now() + this.#ttlMs,
        preparing: false,
        consumed: false
      };
      this.#drafts.set(id, draft);
      return draft;
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  #wrapPrepared<T>(
    resourceMutation: PreparedPiResourceMutation<T>,
    extra: { readonly draft?: ActiveSkillDraft; readonly recovery?: StoredSkillRecoveryRecord }
  ): PreparedSkillMutation<T> {
    const prepared = Object.freeze({
      value: resourceMutation.value,
      revokesRuntimeAuthority: resourceMutation.revokesRuntimeAuthority,
      ...(extra.recovery === undefined ? {} : { recoveryId: extra.recovery.id }),
      [preparedSkillMutationBrand]: true as const
    });
    this.#prepared.set(prepared, { resourceMutation, ...extra, completed: false });
    return prepared;
  }

  async #requireSession(connectionId: string, sessionId: string): Promise<ActiveSkillSession> {
    this.#assertUsable();
    await this.#pruneExpired();
    const owner = validConnectionId(connectionId);
    const session = this.#sessions.get(validSessionId(sessionId));
    if (session === undefined) throw new Error("Skill detail session does not exist or has expired.");
    if (session.connectionId !== owner) throw new Error("Skill detail session belongs to another connection.");
    await session.lease.assertCurrent();
    return session;
  }

  #requireDraft(connectionId: string, draftId: string): ActiveSkillDraft {
    this.#assertUsable();
    const owner = validConnectionId(connectionId);
    const draft = this.#drafts.get(validDraftId(draftId));
    if (draft === undefined || draft.consumed || draft.expiresAt <= this.#now()) throw new Error("Skill draft does not exist or has expired.");
    if (draft.connectionId !== owner) throw new Error("Skill draft belongs to another connection.");
    return draft;
  }

  async #resolveBaselineRoot(resourceId: string, approvedRevision: string, cleanSource?: string): Promise<string | undefined> {
    const name = createHash("sha256").update(`${resourceId}\0${approvedRevision}`).digest("hex");
    const baseline = join(this.#rootDirectory, "baselines", name);
    if (await isCanonicalDirectory(baseline)) {
      const inspection = await inspectPrivateTree(baseline, this.#resources.maximumFiles, this.#resources.maximumBytes).catch(() => undefined);
      if (inspection?.revision === approvedRevision) return baseline;
      await rm(baseline, { recursive: true, force: true });
    }
    if (cleanSource === undefined) return undefined;
    const temporary = join(this.#rootDirectory, "baselines", `${name}.${randomUUID()}.tmp`);
    await mkdir(temporary, { recursive: false, mode: 0o700 });
    try {
      await copyPrivateTree(cleanSource, temporary, this.#resources.maximumFiles, this.#resources.maximumBytes);
      const inspection = await inspectPrivateTree(temporary, this.#resources.maximumFiles, this.#resources.maximumBytes);
      if (inspection.revision !== approvedRevision) throw new Error("Skill baseline differs from its approved Resource revision.");
      try {
        await rename(temporary, baseline);
      } catch (error) {
        if (!await isCanonicalDirectory(baseline)) throw error;
        await rm(temporary, { recursive: true, force: true });
      }
      return baseline;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #pruneExpired(): Promise<void> {
    const now = this.#now();
    for (const draft of [...this.#drafts.values()]) {
      if (!draft.preparing && draft.expiresAt <= now) await this.#removeDraft(draft);
    }
    for (const session of [...this.#sessions.values()]) {
      if (session.expiresAt <= now) await this.#closeSession(session);
    }
  }

  async #removeDraft(draft: ActiveSkillDraft): Promise<void> {
    if (this.#drafts.get(draft.id) === draft) this.#drafts.delete(draft.id);
    await removePrivateChild(this.#rootDirectory, draft.root);
  }

  async #closeSession(session: ActiveSkillSession): Promise<void> {
    if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
    for (const draft of [...this.#drafts.values()]) {
      if (draft.sessionId === session.id && !draft.preparing) await this.#removeDraft(draft);
    }
    await session.lease.release().catch(() => undefined);
    await removePrivateChild(this.#rootDirectory, session.root);
  }

  #persistRecoveries(store: OperationalStore, records: readonly StoredSkillRecoveryRecord[]): void {
    store.setSetting("service", this.#scopeId, "skill_content_state", {
      format: 1,
      recoveries: [...records].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredSkillState);
  }

  async #reconcileRecoveryDirectory(): Promise<void> {
    const root = join(this.#rootDirectory, "recoveries");
    const expected = new Set([...this.#recoveries.values()].map((record) => record.directoryName));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      validateEntryName(entry.name);
      const path = join(root, entry.name);
      if (!expected.has(entry.name)) {
        await removePrivateChild(root, path);
        continue;
      }
      const info = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Stored Skill recovery must be a regular directory.");
      }
      await assertPrivateContained(root, path, "Stored Skill recovery");
    }
  }

  #assertUsable(): void {
    if (!this.#initialized) throw new Error("Skill manager is not initialized.");
    if (this.#closed) throw new Error("Skill manager is closed.");
  }

  #mutate<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(callback, callback);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function skillCatalogEntryFromResource(resource: PiResourceDescriptor): SkillCatalogEntry {
  const contentAvailable = resource.scope === "project"
    ? resource.state === "approved" || resource.state === "disabled" || resource.state === "loaded"
    : resource.state === "installed" || resource.state === "disabled" || resource.state === "loaded";
  const standalone = resource.sourceKind === "local";
  return {
    id: resource.id,
    backendId: resource.backendId,
    ...(resource.targetId === undefined ? {} : { targetId: resource.targetId }),
    scope: resource.scope === "project" ? "project" : "global",
    name: resource.name,
    sourceLabel: resource.sourceDisplay,
    state: resource.state,
    enabled: resource.enabled,
    canToggle: resource.canToggle,
    contentAvailable,
    canEdit: contentAvailable && standalone,
    canDelete: contentAvailable && standalone,
    resourceVersion: resource.versionNumber,
    approvedRevision: resource.discoveredRevision,
    updatedAt: resource.updatedAt
  };
}

function publicDraft(draft: ActiveSkillDraft): SkillDraftPreview {
  return {
    draftId: draft.id,
    sessionId: draft.sessionId,
    skillId: draft.resourceId,
    kind: draft.kind,
    name: draft.name,
    resourceVersion: draft.resourceVersion,
    observedRevision: draft.observedRevision,
    changes: draft.changes,
    expiresAt: draft.expiresAt
  };
}

async function parseSkillMetadata(root: string): Promise<SkillMetadata> {
  try {
    const raw = await readPrivateUtf8(join(root, "SKILL.md"), MAXIMUM_FRONTMATTER_BYTES);
    const frontmatter = extractFrontmatter(raw);
    if (frontmatter === undefined) return { frontmatterJson: "{}" };
    const document = parseDocument(frontmatter, { schema: "core", prettyErrors: false });
    if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill frontmatter must be a mapping.");
    const safe = jsonSafeMetadata(value) as Record<string, unknown>;
    const name = typeof safe["name"] === "string" ? safe["name"].trim().slice(0, 100) : undefined;
    const description = typeof safe["description"] === "string" ? safe["description"].trim().slice(0, 500) : undefined;
    const version = typeof safe["version"] === "string" || typeof safe["version"] === "number"
      ? String(safe["version"]).trim().slice(0, 128)
      : undefined;
    return {
      ...(name === undefined || name === "" ? {} : { name }),
      ...(description === undefined || description === "" ? {} : { description }),
      ...(version === undefined || version === "" ? {} : { version }),
      frontmatterJson: JSON.stringify(safe, undefined, 2)
    };
  } catch (error) {
    return {
      frontmatterJson: "{}",
      parseError: safeErrorMessage(error, "Skill frontmatter could not be parsed.")
    };
  }
}

function extractFrontmatter(raw: string): string | undefined {
  const normalized = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const match = /^(?:---)[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(normalized);
  return match?.[1];
}

function jsonSafeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactMetadataValue(value).slice(0, 4096);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => jsonSafeMetadata(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      result[key.slice(0, 128)] = sensitiveMetadataKey(key) ? "[redacted]" : jsonSafeMetadata(child, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 256);
}

function sensitiveMetadataKey(key: string): boolean {
  return /(?:^|[_-])(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key|credential)(?:$|[_-])/iu.test(key);
}

function redactMetadataValue(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/gu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu, "Bearer [redacted]");
}

function updateSkillManifestName(raw: string, name: string): string {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = extractFrontmatter(raw);
  if (frontmatter === undefined) return `---${newline}name: ${name}${newline}---${newline}${raw}`;
  const updated = /^name[ \t]*:.*$/mu.test(frontmatter)
    ? frontmatter.replace(/^name[ \t]*:.*$/mu, `name: ${name}`)
    : `name: ${name}${newline}${frontmatter}`;
  const start = raw.indexOf(frontmatter);
  return `${raw.slice(0, start)}${updated}${raw.slice(start + frontmatter.length)}`;
}

async function listVisibleChildren(
  root: string,
  directory: string,
  parentKey: string,
  maximumEditBytes: number
): Promise<readonly SkillFileEntry[]> {
  await assertPrivateContained(root, directory, "Skill directory");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Skill file-tree target is not a regular directory.");
  const result: SkillFileEntry[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = parentKey === "" ? entry.name : `${parentKey}/${entry.name}`;
    if (isExcludedSkillKey(key)) continue;
    const path = join(directory, entry.name);
    const child = await lstat(path);
    if (entry.isSymbolicLink() || child.isSymbolicLink()) throw new Error("Skill snapshot contains a symlink or junction.");
    if (entry.isDirectory() && child.isDirectory()) {
      result.push({ key, name: entry.name, kind: "directory", size: 0, editable: false });
    } else if (entry.isFile() && child.isFile()) {
      result.push({ key, name: entry.name, kind: "file", size: child.size, editable: child.size <= maximumEditBytes });
    } else {
      throw new Error("Skill snapshot contains a special file.");
    }
  }
  return result.sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.name.localeCompare(right.name, "en"));
}

async function readVisibleTextFile(
  root: string,
  key: string,
  maximumBytes: number,
  maximumEditBytes: number
): Promise<SkillFileContent> {
  const normalized = portableKey(key, false);
  if (isExcludedSkillKey(normalized)) throw new Error("Skill path is excluded from content browsing.");
  const path = resolvePortableKey(root, normalized, false);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Skill content target is not a regular file.");
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) {
    throw new Error("Skill content exceeds the preview byte limit.");
  }
  const canonical = await realpath(path);
  if (resolve(canonical) !== resolve(path)) throw new Error("Skill content contains a path alias or junction.");
  assertWithin(root, canonical, "Skill content");
  const bytes = await readFile(canonical);
  const after = await stat(canonical);
  if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Skill content changed while it was read.");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Skill content is not valid UTF-8 text.");
  }
  return {
    key: normalized,
    content,
    revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
    editable: bytes.byteLength <= maximumEditBytes
  };
}

async function compareSkillTrees(beforeRoot: string, afterRoot: string, maximumTextBytes: number): Promise<SkillDiff> {
  const [before, after] = await Promise.all([
    collectVisibleFiles(beforeRoot, maximumTextBytes),
    collectVisibleFiles(afterRoot, maximumTextBytes)
  ]);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right, "en"));
  const changes: SkillDiffChange[] = [];
  let diffBytes = 0;
  let truncated = false;
  for (const key of keys) {
    const left = before.get(key);
    const right = after.get(key);
    if (left?.hash === right?.hash) continue;
    if (changes.length >= MAXIMUM_DIFF_CHANGES) {
      truncated = true;
      break;
    }
    const kind = left === undefined ? "added" : right === undefined ? "deleted" : "modified";
    const binary = (left !== undefined && left.text === undefined) || (right !== undefined && right.text === undefined);
    let unifiedDiff: string | undefined;
    if (!binary) {
      const candidate = wholeFileUnifiedDiff(key, left?.text ?? "", right?.text ?? "");
      const candidateBytes = Buffer.byteLength(candidate, "utf8");
      if (diffBytes + candidateBytes <= MAXIMUM_UNIFIED_DIFF_BYTES) {
        unifiedDiff = candidate;
        diffBytes += candidateBytes;
      } else {
        truncated = true;
      }
    }
    changes.push({ key, kind, binary, ...(unifiedDiff === undefined ? {} : { unifiedDiff }) });
  }
  return { available: true, changes, truncated };
}

async function collectVisibleFiles(root: string, maximumTextBytes: number): Promise<Map<string, VisibleFile>> {
  const files = new Map<string, VisibleFile>();
  const visit = async (directory: string, parentKey: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = parentKey === "" ? entry.name : `${parentKey}/${entry.name}`;
      if (isExcludedSkillKey(key)) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error("Skill snapshot contains a symlink or junction.");
      if (entry.isDirectory() && info.isDirectory()) {
        await visit(path, key);
      } else if (entry.isFile() && info.isFile()) {
        const bytes = await readFile(path);
        let text: string | undefined;
        if (bytes.byteLength <= maximumTextBytes) {
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binary */ }
        }
        files.set(key, {
          key,
          size: bytes.byteLength,
          hash: createHash("sha256").update(bytes).digest("hex"),
          ...(text === undefined ? {} : { text })
        });
      } else {
        throw new Error("Skill snapshot contains a special file.");
      }
    }
  };
  await visit(root, "");
  return files;
}

function wholeFileUnifiedDiff(key: string, before: string, after: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const header = `--- a/${key}\n+++ b/${key}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;
  return `${header}${beforeLines.map((line) => `-${line}`).join("\n")}${beforeLines.length > 0 ? "\n" : ""}${afterLines.map((line) => `+${line}`).join("\n")}${afterLines.length > 0 ? "\n" : ""}`;
}

function splitLines(value: string): readonly string[] {
  if (value === "") return [];
  const normalized = value.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function copyPrivateTree(sourceRoot: string, destinationRoot: string, maximumFiles: number, maximumBytes: number): Promise<void> {
  const budget = { files: 0, bytes: 0 };
  const visit = async (source: string, destination: string): Promise<void> => {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      validateEntryName(entry.name);
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const before = await lstat(sourcePath);
      if (entry.isSymbolicLink() || before.isSymbolicLink()) throw new Error("Skill private tree contains a symlink or junction.");
      if (entry.isDirectory() && before.isDirectory()) {
        await mkdir(destinationPath, { recursive: false, mode: 0o700 });
        await visit(sourcePath, destinationPath);
      } else if (entry.isFile() && before.isFile()) {
        budget.files += 1;
        budget.bytes += before.size;
        if (budget.files > maximumFiles || budget.bytes > maximumBytes) throw new Error("Skill private tree exceeds its configured limits.");
        await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      } else {
        throw new Error("Skill private tree contains a special file.");
      }
      const after = await lstat(sourcePath);
      if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error("Skill private tree changed while it was copied.");
      }
    }
  };
  await visit(sourceRoot, destinationRoot);
}

async function inspectPrivateTree(root: string, maximumFiles: number, maximumBytes: number): Promise<PrivateTreeInspection> {
  await assertCanonicalDirectory(root, "Skill private tree");
  const hash = createHash("sha256");
  const budget = { files: 0, bytes: 0 };
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    hash.update(`D\0${relativeDirectory}\0`);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      validateEntryName(entry.name);
      const path = join(directory, entry.name);
      const key = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const info = await lstat(path);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error("Skill private tree contains a symlink or junction.");
      if (entry.isDirectory() && info.isDirectory()) {
        await visit(path, key);
      } else if (entry.isFile() && info.isFile()) {
        budget.files += 1;
        budget.bytes += info.size;
        if (budget.files > maximumFiles || budget.bytes > maximumBytes) throw new Error("Skill private tree exceeds its configured limits.");
        hash.update(`F\0${key}\0${info.size}\0`);
        hash.update(await readFile(path));
      } else {
        throw new Error("Skill private tree contains a special file.");
      }
    }
  };
  await visit(root, "");
  return { revision: `sha256:${hash.digest("hex")}`, files: budget.files, bytes: budget.bytes };
}

async function atomicWriteUtf8(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readPrivateUtf8(path: string, maximumBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) throw new Error("Skill metadata file is unavailable or too large.");
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Skill metadata must be valid UTF-8.");
  }
}

function resolvePortableKey(root: string, key: string, allowRoot: boolean): string {
  const normalized = portableKey(key, allowRoot);
  const path = normalized === "" ? root : join(root, ...normalized.split("/"));
  assertWithin(root, path, "Skill portable path");
  return path;
}

function portableKey(value: string, allowRoot: boolean): string {
  if (
    typeof value !== "string" || value.length > 512 || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || isAbsolute(value)
  ) {
    throw new Error("Skill path key is invalid.");
  }
  if (value === "") {
    if (allowRoot) return "";
    throw new Error("Skill file key must not be empty.");
  }
  const parts = value.split("/");
  if (parts.length > 32 || parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Skill path key is invalid.");
  for (const part of parts) {
    validateEntryName(part);
    if (/[<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part) || isWindowsReservedName(part)) {
      throw new Error("Skill path key is invalid.");
    }
  }
  return parts.join("/");
}

function isWindowsReservedName(value: string): boolean {
  const stem = value.split(".", 1)[0]!.toUpperCase();
  return stem === "CON" || stem === "PRN" || stem === "AUX" || stem === "NUL"
    || /^COM[1-9]$/u.test(stem) || /^LPT[1-9]$/u.test(stem);
}

function isExcludedSkillKey(value: string): boolean {
  const key = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "").toLowerCase();
  if (key === "") return false;
  const parts = key.split("/");
  const excludedDirectories = new Set([
    ".git", ".hg", ".svn", ".venv", "node_modules", "__macosx",
    ".aws", ".ssh", ".gnupg", ".kube", ".docker", ".azure"
  ]);
  if (parts.some((part) => excludedDirectories.has(part))) return true;
  if (key === ".config/gcloud" || key.startsWith(".config/gcloud/")) return true;
  const name = parts.at(-1)!;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if ([".npmrc", ".pypirc", ".netrc", "_netrc", ".terraformrc", "terraform.rc", "credentials.tfrc.json", ".ds_store"].includes(name)) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/u.test(name)) return true;
  if (/^(?:credentials|secrets?)(?:\.[a-z0-9_-]+)?\.(?:json|ya?ml|toml|ini|conf)$/u.test(name)) return true;
  if (/(?:^|\/)\.m2\/settings(?:-security)?\.xml$/u.test(key)) return true;
  if (name.endsWith(".xdt-tmp") || /^skill\.md\.xdt-rename-[a-f0-9-]+$/u.test(name) || name.startsWith("._")) return true;
  return false;
}

async function assertPrivateContained(root: string, path: string, label: string): Promise<void> {
  assertWithin(root, path, label);
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  assertWithin(canonicalRoot, canonical, label);
  if (resolve(path) !== resolve(canonical)) throw new Error(`${label} contains a path alias or junction.`);
}

function assertWithin(root: string, candidate: string, label: string): void {
  const suffix = relative(resolve(root), resolve(candidate));
  if (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) return;
  throw new Error(`${label} escapes its approved root.`);
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  const canonical = await realpath(path);
  if (resolve(path) !== resolve(canonical)) throw new Error(`${label} contains a path alias or junction.`);
}

async function isCanonicalDirectory(path: string): Promise<boolean> {
  try {
    await assertCanonicalDirectory(path, "Skill private directory");
    return true;
  } catch {
    return false;
  }
}

async function removePrivateChild(root: string, path: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new Error("Skill private cleanup paths must be absolute.");
  assertWithin(root, path, "Skill private cleanup");
  if (resolve(root) === resolve(path)) throw new Error("Skill private root cannot be removed as a child.");
  await rm(path, { recursive: true, force: true });
}

function validateStoredSkillState(value: unknown): StoredSkillState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Stored Skill state is malformed.");
  const record = value as Record<string, unknown>;
  if (record["format"] !== 1 || !Array.isArray(record["recoveries"])) throw new Error("Stored Skill state has an unsupported format.");
  const recoveries = record["recoveries"].map((item) => validateStoredRecovery(item));
  if (new Set(recoveries.map((item) => item.id)).size !== recoveries.length) throw new Error("Stored Skill state contains duplicate recovery IDs.");
  return { format: 1, recoveries };
}

function validateStoredRecovery(value: unknown): StoredSkillRecoveryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Stored Skill recovery is malformed.");
  const record = value as Record<string, unknown>;
  const id = validRecoveryId(requiredString(record, "id"));
  const directoryName = requiredString(record, "directoryName");
  if (directoryName !== id) throw new Error("Stored Skill recovery directory is malformed.");
  const scope = record["scope"];
  if (scope !== "global" && scope !== "project") throw new Error("Stored Skill recovery scope is malformed.");
  const files = requiredSafeInteger(record, "files");
  const bytes = requiredSafeInteger(record, "bytes");
  const createdAt = requiredSafeInteger(record, "createdAt");
  return {
    id,
    skillId: requiredString(record, "skillId"),
    backendId: requiredString(record, "backendId"),
    ...(record["targetId"] === undefined ? {} : { targetId: requiredString(record, "targetId") }),
    scope,
    name: requiredString(record, "name"),
    revision: normalizedRevision(requiredString(record, "revision")),
    files,
    bytes,
    createdAt,
    directoryName
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new Error(`Stored Skill ${key} is malformed.`);
  return value;
}

function requiredSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Stored Skill ${key} is malformed.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function validConnectionId(value: string): string {
  if (!SAFE_CONNECTION_ID.test(value)) throw new Error("Connection ID is invalid.");
  return value;
}

function validSessionId(value: string): string {
  if (!SKILL_SESSION_ID.test(value)) throw new Error("Skill session ID is invalid.");
  return value;
}

function validDraftId(value: string): string {
  if (!SKILL_DRAFT_ID.test(value)) throw new Error("Skill draft ID is invalid.");
  return value;
}

function validRecoveryId(value: string): string {
  if (!SKILL_RECOVERY_ID.test(value)) throw new Error("Skill recovery ID is invalid.");
  return value;
}

function portableSkillName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers, and single hyphens.");
  }
  return name;
}

function normalizedRevision(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("Skill revision is invalid.");
  return value;
}

function validateEntryName(value: string): void {
  if (value === "" || value === "." || value === ".." || value.includes("\0") || value.includes("/") || value.includes("\\")) {
    throw new Error("Skill tree contains an invalid path component.");
  }
}

function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function safeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return redactMetadataValue(message)
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/gu, "[private path]")
    .replace(/\\\\[^\s"'<>|]+/gu, "[private path]")
    .replace(/\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]*/gu, "[private path]")
    .replace(/~\/[^\s"'<>|]*/gu, "[private path]")
    .slice(0, 512);
}
