import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  PARTNER_GROUP_ATTACHMENTS_MAX, PARTNER_GROUP_MAX_MEMBERS, PARTNER_GROUP_MIN_MEMBERS,
  PARTNER_GROUP_NAME_MAX_CHARS, PARTNER_GROUP_PAGE_SIZE, PARTNER_GROUP_PLAN_MAX_STEPS,
  PARTNER_GROUP_PLAN_TASK_MAX_CHARS, PARTNER_GROUP_REPLY_MAX_CHARS, PARTNER_GROUP_MESSAGE_MAX_CHARS,
  PARTNER_GROUP_STEP_FILES_MAX, isPartnerGroupPlanOpen,
  type PartnerGroupAttachment, type PartnerGroupChange, type PartnerGroupChangeNotice, type PartnerGroupLane, type PartnerGroupMembership, type PartnerGroupMessage,
  type PartnerGroupPlan, type PartnerGroupPlanStep, type PartnerGroupRecord
} from "@joko/core";
import { operationBodyHash, serializeJson } from "./serialization.js";
import { SensitiveDataError } from "./errors.js";

type Row = Record<string, unknown>;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const DEFINITIONS = [
  { name: "group_schema", sql: "CREATE TABLE group_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL CHECK(version = 1), baseline_id TEXT NOT NULL) STRICT" },
  { name: "group_directory", sql: "CREATE TABLE group_directory (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)) STRICT" },
  { name: "partner_groups", sql: "CREATE TABLE partner_groups (id TEXT PRIMARY KEY, creation_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, reply_mode TEXT NOT NULL CHECK(reply_mode IN ('all','mentioned')), speaking_mode TEXT NOT NULL CHECK(speaking_mode IN ('auto','sequential')), organizer_partner_id TEXT, project_dir TEXT, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleting')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT" },
  { name: "group_members", sql: "CREATE TABLE group_members (group_id TEXT NOT NULL REFERENCES partner_groups(id) ON DELETE CASCADE, partner_id TEXT NOT NULL, position INTEGER NOT NULL, last_seen_sequence INTEGER NOT NULL CHECK(last_seen_sequence >= 0), joined_at INTEGER NOT NULL, PRIMARY KEY(group_id,partner_id), UNIQUE(group_id,position)) STRICT" },
  { name: "group_messages", sql: "CREATE TABLE group_messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES partner_groups(id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK(sequence > 0), client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(group_id,sequence), UNIQUE(group_id,client_id)) STRICT" },
  { name: "group_plans", sql: "CREATE TABLE group_plans (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES partner_groups(id) ON DELETE CASCADE, revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('proposed','running','waiting','done','stopped','dismissed','superseded')), payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT" },
  { name: "group_lanes", sql: "CREATE TABLE group_lanes (group_id TEXT NOT NULL REFERENCES partner_groups(id) ON DELETE CASCADE, partner_id TEXT NOT NULL, plan_key TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, PRIMARY KEY(group_id,partner_id,plan_key)) STRICT" },
  { name: "group_reads", sql: "CREATE TABLE group_reads (group_id TEXT NOT NULL REFERENCES partner_groups(id) ON DELETE CASCADE, device_id TEXT NOT NULL, through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0), PRIMARY KEY(group_id,device_id)) STRICT" },
  { name: "group_changes", sql: "CREATE TABLE group_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 9007199254740991), group_id TEXT NOT NULL, group_revision INTEGER NOT NULL, directory_revision INTEGER NOT NULL, change TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT" },
  { name: "retired_group_creations", sql: "CREATE TABLE retired_group_creations (creation_id TEXT PRIMARY KEY, retired_at INTEGER NOT NULL) STRICT" },
  { name: "group_messages_sequence", sql: "CREATE INDEX group_messages_sequence ON group_messages(group_id,sequence)" },
  { name: "group_plans_created", sql: "CREATE INDEX group_plans_created ON group_plans(group_id,created_at)" }
] as const;
const BASELINE = createHash("sha256").update(DEFINITIONS.map(entry => entry.sql).join(";\n")).digest("hex");

export class PartnerGroupStoreError extends Error {
  constructor(readonly code: "invalid" | "changed" | "not_found" | "unavailable", message: string) {
    super(message); this.name = "PartnerGroupStoreError";
  }
}

export interface AppendPartnerGroupMessage extends Omit<PartnerGroupMessage, "id" | "sequence" | "createdAt"> {
  readonly clientId: string;
  readonly expectedRevision?: number;
  readonly requestFingerprint?: string;
}

/** Node-owned current-v1 group, timeline, plan and receipt authority. */
export class PartnerGroupStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #subscribers = new Set<(notice: PartnerGroupChangeNotice) => void>();
  readonly #pendingNotices: PartnerGroupChangeNotice[] = [];
  #writing = false;
  constructor(path: string, options: { readonly now?: () => number; readonly id?: () => string } = {}) {
    this.#now = options.now ?? Date.now; this.#id = options.id ?? randomUUID;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Row[];
      if (tables.length === 0) {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
          for (const definition of DEFINITIONS) this.#db.exec(definition.sql);
          this.#db.prepare("INSERT INTO group_schema VALUES (1,1,?)").run(BASELINE);
          this.#db.exec("INSERT INTO group_directory VALUES (1,1); PRAGMA user_version = 1; COMMIT;");
        } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      }
      const marker = this.#db.prepare("SELECT version, baseline_id FROM group_schema WHERE singleton = 1").get() as Row | undefined;
      const version = this.#db.prepare("PRAGMA user_version").get() as Row;
      if (marker?.version !== 1 || marker.baseline_id !== BASELINE || version["user_version"] !== 1) invalid();
      const actual = this.#db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
      if (actual.length !== DEFINITIONS.length || DEFINITIONS.some(expected => actual.find(row => row["name"] === expected.name)?.["sql"] !== expected.sql)) invalid();
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { this.#subscribers.clear(); this.#db.close(); }
  subscribe(listener: (notice: PartnerGroupChangeNotice) => void): () => void { this.#subscribers.add(listener); return () => this.#subscribers.delete(listener); }
  latestChangeSequence(): number { return integer((this.#db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM group_changes").get() as Row)["sequence"], 0); }
  changes(afterSequence: number, limit = 100): readonly PartnerGroupChangeNotice[] {
    return (this.#db.prepare("SELECT * FROM group_changes WHERE sequence > ? ORDER BY sequence LIMIT ?").all(integer(afterSequence, 0), Math.min(integer(limit, 1), 100)) as Row[]).map(row => this.#change(row));
  }
  appendChange(groupId: string, change: PartnerGroupChange): PartnerGroupChangeNotice {
    return this.#write(() => {
      const group = this.find(identity(groupId)), revision = group?.revision ?? 0, directoryRevision = this.directoryRevision() + 1, createdAt = this.#time();
      const kind = choice(change, ["created", "updated", "deleted", "messages", "round", "plan", "read"]);
      const inserted = this.#db.prepare("INSERT INTO group_changes(group_id,group_revision,directory_revision,change,created_at) VALUES (?,?,?,?,?)")
        .run(groupId, revision, directoryRevision, kind, createdAt);
      const notice = { sequence: integer(Number(inserted.lastInsertRowid), 1), groupId, groupRevision: revision, directoryRevision, change: kind, createdAt };
      this.#pendingNotices.push(notice); return notice;
    });
  }
  transaction<T>(action: (store: this) => T): T { return this.#write(() => action(this)); }
  directoryRevision(): number { return integer((this.#db.prepare("SELECT revision FROM group_directory WHERE singleton = 1").get() as Row)["revision"], 1); }
  list(): readonly PartnerGroupRecord[] {
    return (this.#db.prepare("SELECT * FROM partner_groups ORDER BY updated_at DESC,id").all() as Row[]).map(row => this.#group(row));
  }
  find(groupId: string): PartnerGroupRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM partner_groups WHERE id = ?").get(identity(groupId)) as Row | undefined;
    return row ? this.#group(row) : undefined;
  }
  get(groupId: string): PartnerGroupRecord { const value = this.find(groupId); if (!value) missing(); return value; }
  memberships(groupId: string): readonly PartnerGroupMembership[] {
    return (this.#db.prepare("SELECT * FROM group_members WHERE group_id = ? ORDER BY position").all(identity(groupId)) as Row[]).map(row => ({
      partnerId: identity(row["partner_id"]), position: integer(row["position"], 0),
      lastSeenSequence: integer(row["last_seen_sequence"], 0), joinedAt: integer(row["joined_at"], 0)
    }));
  }
  creation(requestId: string): { readonly group?: PartnerGroupRecord; readonly retired: boolean } {
    const row = this.#db.prepare("SELECT * FROM partner_groups WHERE creation_id = ?").get(identity(requestId)) as Row | undefined;
    return { ...(row ? { group: this.#group(row) } : {}), retired: !!this.#db.prepare("SELECT 1 FROM retired_group_creations WHERE creation_id = ?").get(requestId) };
  }
  retireCreation(requestId: string) {
    return this.#write(() => {
      const result = this.creation(requestId);
      if (!result.group) this.#db.prepare("INSERT OR IGNORE INTO retired_group_creations VALUES (?,?)").run(requestId, this.#time());
      return this.creation(requestId);
    });
  }
  create(input: { readonly requestId: string; readonly expectedDirectoryRevision: number; readonly name: string; readonly memberIds: readonly string[] }): PartnerGroupRecord {
    const name = groupName(input.name), members = memberIds(input.memberIds), requestId = identity(input.requestId);
    const fingerprint = operationBodyHash({ name, members });
    return this.#write(() => {
      const previous = this.#db.prepare("SELECT * FROM partner_groups WHERE creation_id = ?").get(requestId) as Row | undefined;
      if (previous) { if (previous["fingerprint"] !== fingerprint) changed(); return this.#group(previous); }
      if (this.creation(requestId).retired) throw new PartnerGroupStoreError("unavailable", "The group creation intent was retired.");
      if (this.directoryRevision() !== integer(input.expectedDirectoryRevision, 1)) changed();
      const id = identity(this.#id()), now = this.#time();
      this.#db.prepare("INSERT INTO partner_groups VALUES (?,?,?,1,?,'all','auto',NULL,NULL,'active',?,?)").run(id, requestId, fingerprint, name, now, now);
      members.forEach((memberId, position) => this.#db.prepare("INSERT INTO group_members VALUES (?,?,?,0,?)").run(id, memberId, position, now));
      return this.get(id);
    });
  }
  /** Private execution metadata for a server-owned room; this is not a local group creation entry. */
  createExecutionGroup(input: { readonly requestId: string; readonly partnerId: string }): PartnerGroupRecord {
    const requestId = identity(input.requestId), partnerId = identity(input.partnerId), fingerprint = operationBodyHash({ partnerId });
    return this.#write(() => {
      const previous = this.#db.prepare("SELECT * FROM partner_groups WHERE creation_id = ?").get(requestId) as Row | undefined;
      if (previous) { if (previous["fingerprint"] !== fingerprint) changed(); return this.#group(previous); }
      const id = identity(this.#id()), now = this.#time();
      this.#db.prepare("INSERT INTO partner_groups VALUES (?,?,?,1,?,'all','auto',NULL,NULL,'active',?,?)").run(id, requestId, fingerprint, "Shared conversation", now, now);
      this.#db.prepare("INSERT INTO group_members VALUES (?,?,0,0,?)").run(id, partnerId, now);
      return this.get(id);
    });
  }
  /** Server-room execution metadata is private and may add an authorized local step member. */
  ensureExecutionMember(groupId: string, partnerId: string): PartnerGroupRecord {
    return this.#write(() => {
      const group = this.#active(groupId), id = identity(partnerId);
      if (!group.memberIds.includes(id)) {
        this.#db.prepare("INSERT INTO group_members VALUES (?,?,?,0,?)").run(group.id, id, group.memberIds.length, this.#time()); this.#touch(group.id);
      }
      return this.get(group.id);
    });
  }
  update(groupId: string, expectedRevision: number, patch: Partial<Pick<PartnerGroupRecord, "name" | "replyMode" | "speakingMode" | "organizerPartnerId" | "projectDir">>): PartnerGroupRecord {
    return this.#write(() => {
      const current = this.#active(groupId, expectedRevision), next = { ...current, ...patch };
      groupName(next.name); choice(next.replyMode, ["all", "mentioned"]); choice(next.speakingMode, ["auto", "sequential"]);
      if (next.organizerPartnerId !== null && !current.memberIds.includes(identity(next.organizerPartnerId))) invalid();
      if (next.projectDir !== null) text(next.projectDir, 4096);
      this.#db.prepare("UPDATE partner_groups SET name = ?,reply_mode = ?,speaking_mode = ?,organizer_partner_id = ?,project_dir = ? WHERE id = ?")
        .run(next.name, next.replyMode, next.speakingMode, next.organizerPartnerId, next.projectDir, groupId);
      this.#touch(groupId); return this.get(groupId);
    });
  }
  setMembers(groupId: string, expectedRevision: number, input: readonly string[]): PartnerGroupRecord {
    const members = memberIds(input);
    return this.#write(() => {
      this.#active(groupId, expectedRevision); const previous = new Map(this.memberships(groupId).map(item => [item.partnerId, item]));
      this.#db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
      members.forEach((id, position) => {
        const old = previous.get(id);
        this.#db.prepare("INSERT INTO group_members VALUES (?,?,?,?,?)").run(groupId, id, position, old?.lastSeenSequence ?? 0, old?.joinedAt ?? this.#time());
      });
      this.#touch(groupId); return this.get(groupId);
    });
  }
  removePartner(partnerId: string): readonly string[] {
    identity(partnerId);
    return this.#write(() => {
      const groups = (this.#db.prepare("SELECT group_id FROM group_members WHERE partner_id = ?").all(partnerId) as Row[]).map(row => identity(row["group_id"]));
      this.#db.prepare("DELETE FROM group_members WHERE partner_id = ?").run(partnerId);
      for (const groupId of groups) this.#touch(groupId);
      return groups;
    });
  }
  appendMessage(groupId: string, input: AppendPartnerGroupMessage): { readonly message: PartnerGroupMessage; readonly created: boolean } {
    const clientId = identity(input.clientId), fingerprint = input.requestFingerprint === undefined ? operationBodyHash({ ...input, expectedRevision: undefined }) : requestFingerprint(input.requestFingerprint);
    return this.#write(() => {
      const existing = this.#db.prepare("SELECT * FROM group_messages WHERE group_id = ? AND client_id = ?").get(identity(groupId), clientId) as Row | undefined;
      if (existing) { if (existing["fingerprint"] !== fingerprint) changed(); return { message: this.#message(existing), created: false }; }
      const group = this.#active(groupId, input.expectedRevision);
      const message = parseMessage({ id: identity(this.#id()), sequence: this.latestSequence(groupId) + 1,
        kind: input.kind, authorKind: input.authorKind, authorPartnerId: input.authorPartnerId, authorName: input.authorName,
        content: input.content, mentions: input.mentions, noticeCode: input.noticeCode, planId: input.planId,
        files: input.files, attachments: input.attachments, createdAt: this.#time() });
      if (message.authorKind === "partner" && !group.memberIds.includes(message.authorPartnerId!)) {
        const plan = message.planId === null ? undefined : this.getPlan(message.planId);
        const step = plan?.currentStep === null ? undefined : plan?.steps[plan.currentStep!];
        if (plan?.groupId !== groupId || plan.status !== "running" || step?.status !== "running" || step.partnerId !== message.authorPartnerId) invalid();
      }
      if (message.mentions.partnerIds.some(id => !group.memberIds.includes(id))) invalid();
      if (message.planId !== null && this.getPlan(message.planId).groupId !== groupId) invalid();
      this.#db.prepare("INSERT INTO group_messages VALUES (?,?,?,?,?,?,?)").run(message.id, groupId, message.sequence, clientId, fingerprint, safeJson(message), message.createdAt);
      this.#touch(groupId); return { message, created: true };
    });
  }
  findMessage(groupId: string, messageId: string): PartnerGroupMessage | undefined {
    const row = this.#db.prepare("SELECT * FROM group_messages WHERE group_id = ? AND id = ?").get(identity(groupId), identity(messageId)) as Row | undefined;
    return row ? this.#message(row) : undefined;
  }
  messageForClient(groupId: string, clientId: string, fingerprint?: string): PartnerGroupMessage | undefined {
    const row = this.#db.prepare("SELECT * FROM group_messages WHERE group_id = ? AND client_id = ?").get(identity(groupId), identity(clientId)) as Row | undefined;
    if (row && fingerprint !== undefined && row["fingerprint"] !== requestFingerprint(fingerprint)) changed();
    return row ? this.#message(row) : undefined;
  }
  latestSequence(groupId: string): number {
    return integer((this.#db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM group_messages WHERE group_id = ?").get(identity(groupId)) as Row)["sequence"], 0);
  }
  messages(groupId: string, options: { readonly beforeSequence?: number; readonly afterSequence?: number; readonly throughSequence?: number; readonly limit?: number } = {}) {
    this.get(groupId); const before = integer(options.beforeSequence ?? MAX_INTEGER, 1), after = integer(options.afterSequence ?? 0, 0);
    const through = integer(options.throughSequence ?? MAX_INTEGER, 0), limit = integer(options.limit ?? PARTNER_GROUP_PAGE_SIZE, 1);
    if (limit > PARTNER_GROUP_PAGE_SIZE) invalid();
    const rows = this.#db.prepare("SELECT * FROM group_messages WHERE group_id = ? AND sequence < ? AND sequence > ? AND sequence <= ? ORDER BY sequence DESC LIMIT ?")
      .all(groupId, before, after, through, limit + 1) as Row[];
    return { messages: rows.slice(0, limit).reverse().map(row => this.#message(row)), hasMoreBefore: rows.length > limit };
  }
  advanceDelivered(groupId: string, partnerId: string, throughSequence: number): void {
    this.#write(() => {
      this.#active(groupId); const through = integer(throughSequence, 0);
      if (through > this.latestSequence(groupId)) invalid();
      const updated = this.#db.prepare("UPDATE group_members SET last_seen_sequence = MAX(last_seen_sequence,?) WHERE group_id = ? AND partner_id = ?")
        .run(through, groupId, identity(partnerId));
      if (updated.changes !== 1) changed();
    });
  }
  readThrough(groupId: string, deviceId: string): number {
    this.get(groupId); const row = this.#db.prepare("SELECT through_sequence FROM group_reads WHERE group_id = ? AND device_id = ?").get(groupId, identity(deviceId)) as Row | undefined;
    return row ? integer(row["through_sequence"], 0) : 0;
  }
  markRead(groupId: string, deviceId: string, throughSequence: number): void {
    this.#write(() => {
      this.get(groupId); const through = integer(throughSequence, 0); if (through > this.latestSequence(groupId)) invalid();
      this.#db.prepare("INSERT INTO group_reads VALUES (?,?,?) ON CONFLICT(group_id,device_id) DO UPDATE SET through_sequence = MAX(through_sequence,excluded.through_sequence)")
        .run(groupId, identity(deviceId), through);
    });
  }
  plans(groupId: string): readonly PartnerGroupPlan[] {
    this.get(groupId); return (this.#db.prepare("SELECT * FROM group_plans WHERE group_id = ? ORDER BY created_at,id").all(groupId) as Row[]).map(row => this.#plan(row));
  }
  getPlan(planId: string): PartnerGroupPlan {
    const row = this.#db.prepare("SELECT * FROM group_plans WHERE id = ?").get(identity(planId)) as Row | undefined;
    if (!row) missing(); return this.#plan(row);
  }
  openPlan(groupId: string): PartnerGroupPlan | undefined {
    const row = this.#db.prepare("SELECT * FROM group_plans WHERE group_id = ? AND status IN ('proposed','running','waiting') ORDER BY created_at DESC LIMIT 1").get(identity(groupId)) as Row | undefined;
    return row ? this.#plan(row) : undefined;
  }
  createPlan(groupId: string, expectedGroupRevision: number, input: Pick<PartnerGroupPlan, "requestText" | "attachments" | "organizerPartnerId" | "organizerName"> & {
    readonly steps: readonly Pick<PartnerGroupPlanStep, "partnerId" | "partnerName" | "task">[] }): PartnerGroupPlan {
    return this.#write(() => {
      const group = this.#active(groupId, expectedGroupRevision), previous = this.openPlan(groupId);
      if (!group.memberIds.includes(input.organizerPartnerId) || input.steps.some(step => !group.memberIds.includes(step.partnerId))) invalid();
      if (previous && previous.status !== "proposed") throw new PartnerGroupStoreError("unavailable", "A group plan is already open.");
      if (previous) this.#putPlan({ ...previous, status: "superseded", revision: previous.revision + 1, updatedAt: this.#time() });
      const now = this.#time(), plan = parsePlan({ id: identity(this.#id()), groupId, revision: 1, status: "proposed", ...input,
        currentStep: null, workDir: null, branch: null, createdAt: now, updatedAt: now,
        steps: input.steps.map((step, position) => ({ ...step, position, status: "pending", resultMessageId: null, startedAt: null, finishedAt: null })) });
      this.#db.prepare("INSERT INTO group_plans VALUES (?,?,?,?,?,?,?)").run(plan.id, groupId, plan.revision, plan.status, safeJson(plan), now, now);
      this.appendMessage(groupId, { clientId: `plan:${plan.id}`, kind: "plan", authorKind: "partner", authorPartnerId: plan.organizerPartnerId,
        authorName: plan.organizerName, content: "", mentions: { all: false, partnerIds: [] }, noticeCode: null, planId: plan.id, files: [], attachments: [] });
      return plan;
    });
  }
  updatePlan(planId: string, expectedRevision: number, change: (plan: PartnerGroupPlan) => PartnerGroupPlan): PartnerGroupPlan {
    return this.#write(() => {
      const current = this.getPlan(planId); this.#active(current.groupId);
      if (current.revision !== integer(expectedRevision, 1)) changed();
      const next = parsePlan({ ...change(structuredClone(current)), id: current.id, groupId: current.groupId, createdAt: current.createdAt,
        revision: current.revision + 1, updatedAt: this.#time() });
      this.#putPlan(next); this.#touch(current.groupId); return next;
    });
  }
  recoverInterruptedPlans(): readonly PartnerGroupPlan[] {
    return this.#write(() => {
      const running = this.#db.prepare("SELECT * FROM group_plans WHERE status = 'running'").all() as Row[], recovered: PartnerGroupPlan[] = [];
      for (const row of running) {
        const current = this.#plan(row), now = this.#time();
        const next = parsePlan({ ...current, revision: current.revision + 1, status: "waiting", updatedAt: now,
          steps: current.steps.map(step => step.status === "running" ? { ...step, status: "failed", finishedAt: now } : step) });
        this.#putPlan(next); this.#touch(current.groupId); recovered.push(next);
      }
      return recovered;
    });
  }
  lanes(groupId?: string): readonly PartnerGroupLane[] {
    const rows = groupId === undefined ? this.#db.prepare("SELECT * FROM group_lanes").all()
      : this.#db.prepare("SELECT * FROM group_lanes WHERE group_id = ?").all(identity(groupId));
    return (rows as Row[]).map(row => parseLane(decode(row["payload_json"])));
  }
  claimLane(input: Pick<PartnerGroupLane, "groupId" | "partnerId" | "planId" | "profileVersion" | "operationId">): PartnerGroupLane {
    return this.#write(() => {
      const group = this.#active(input.groupId); if (!group.memberIds.includes(identity(input.partnerId))) invalid();
      if (input.planId !== null && this.getPlan(input.planId).groupId !== group.id) invalid();
      const existing = this.lanes(group.id).find(lane => lane.partnerId === input.partnerId && lane.planId === input.planId);
      if (existing) return existing;
      const now = this.#time(), lane = parseLane({ ...input, phase: "preparing", sessionId: null, createdAt: now, updatedAt: now });
      this.#db.prepare("INSERT INTO group_lanes VALUES (?,?,?,?,?)").run(group.id, input.partnerId, input.planId ?? "", input.operationId, safeJson(lane));
      return lane;
    });
  }
  updateLane(lane: PartnerGroupLane, patch: Pick<PartnerGroupLane, "phase" | "sessionId" | "profileVersion">): PartnerGroupLane {
    return this.#write(() => {
      const row = this.#db.prepare("SELECT * FROM group_lanes WHERE operation_id = ?").get(identity(lane.operationId)) as Row | undefined;
      if (!row) missing(); const current = parseLane(decode(row["payload_json"]));
      if (current.phase !== lane.phase || current.sessionId !== lane.sessionId || current.profileVersion !== lane.profileVersion) changed();
      const next = parseLane({ ...current, ...patch, updatedAt: this.#time() });
      this.#db.prepare("UPDATE group_lanes SET payload_json = ? WHERE operation_id = ?").run(safeJson(next), lane.operationId); return next;
    });
  }
  retryClosedLane(lane: PartnerGroupLane, operationId: string): PartnerGroupLane {
    return this.#write(() => {
      this.#active(lane.groupId);
      const row = this.#db.prepare("SELECT * FROM group_lanes WHERE operation_id = ?").get(identity(lane.operationId)) as Row | undefined;
      if (!row) missing(); const current = parseLane(decode(row["payload_json"]));
      if (current.phase !== "unknown" || lane.phase !== current.phase || lane.sessionId !== current.sessionId || lane.profileVersion !== current.profileVersion) changed();
      const next = parseLane({ ...current, operationId: identity(operationId), sessionId: null, phase: "preparing", updatedAt: this.#time() });
      this.#db.prepare("UPDATE group_lanes SET operation_id = ?, payload_json = ? WHERE operation_id = ?").run(next.operationId, safeJson(next), current.operationId); return next;
    });
  }
  beginDelete(groupId: string, expectedRevision: number): PartnerGroupRecord {
    return this.#write(() => {
      const current = this.get(groupId); if (current.lifecycle === "deleting") return current;
      this.#active(groupId, expectedRevision); this.#db.prepare("UPDATE partner_groups SET lifecycle = 'deleting' WHERE id = ?").run(groupId);
      this.#touch(groupId); return this.get(groupId);
    });
  }
  finishDelete(groupId: string): void {
    this.#write(() => {
      const current = this.get(groupId); if (current.lifecycle !== "deleting" || this.lanes(groupId).some(lane => lane.phase !== "archived")) changed();
      const row = this.#db.prepare("SELECT creation_id FROM partner_groups WHERE id = ?").get(groupId) as Row;
      this.#db.prepare("INSERT OR IGNORE INTO retired_group_creations VALUES (?,?)").run(identity(row["creation_id"]), this.#time());
      this.#db.prepare("DELETE FROM partner_groups WHERE id = ?").run(groupId);
    });
  }
  #time(): number { return integer(this.#now(), 0); }
  #active(groupId: string, expectedRevision?: number): PartnerGroupRecord {
    const group = this.get(groupId); if (group.lifecycle !== "active") throw new PartnerGroupStoreError("unavailable", "The group is being deleted.");
    if (expectedRevision !== undefined && group.revision !== integer(expectedRevision, 1)) changed(); return group;
  }
  #touch(groupId: string): void {
    const current = this.get(groupId); if (current.revision === MAX_INTEGER) invalid();
    this.#db.prepare("UPDATE partner_groups SET revision = revision + 1,updated_at = ? WHERE id = ?").run(this.#time(), groupId);
  }
  #write<T>(action: () => T): T {
    if (this.#writing) return action();
    this.#db.exec("BEGIN IMMEDIATE"); this.#writing = true;
    let result: T;
    try {
      result = action(); if (this.directoryRevision() === MAX_INTEGER) invalid();
      this.#db.exec("UPDATE group_directory SET revision = revision + 1 WHERE singleton = 1; COMMIT");
    } catch (error) { this.#pendingNotices.splice(0); this.#db.exec("ROLLBACK"); throw error; } finally { this.#writing = false; }
    const notices = this.#pendingNotices.splice(0);
    for (const notice of notices) for (const listener of this.#subscribers) { try { listener(notice); } catch { /* A committed notice remains replayable. */ } }
    return result;
  }
  #change(row: Row): PartnerGroupChangeNotice {
    return { sequence: integer(row["sequence"], 1), groupId: identity(row["group_id"]), groupRevision: integer(row["group_revision"], 0),
      directoryRevision: integer(row["directory_revision"], 1), change: choice(row["change"], ["created", "updated", "deleted", "messages", "round", "plan", "read"]), createdAt: integer(row["created_at"], 0) };
  }
  #group(row: Row): PartnerGroupRecord {
    return { id: identity(row["id"]), revision: integer(row["revision"], 1), name: groupName(row["name"]),
      replyMode: choice(row["reply_mode"], ["all", "mentioned"]), speakingMode: choice(row["speaking_mode"], ["auto", "sequential"]),
      organizerPartnerId: nullableIdentity(row["organizer_partner_id"]), projectDir: row["project_dir"] === null ? null : text(row["project_dir"], 4096),
      lifecycle: choice(row["lifecycle"], ["active", "deleting"]), memberIds: this.memberships(identity(row["id"])).map(member => member.partnerId),
      createdAt: integer(row["created_at"], 0), updatedAt: integer(row["updated_at"], 0) };
  }
  #message(row: Row): PartnerGroupMessage {
    const message = parseMessage(decode(row["payload_json"]));
    if (message.id !== row["id"] || message.sequence !== row["sequence"] || message.createdAt !== row["created_at"]) invalid(); return message;
  }
  #plan(row: Row): PartnerGroupPlan {
    const plan = parsePlan(decode(row["payload_json"]));
    if (plan.id !== row["id"] || plan.groupId !== row["group_id"] || plan.status !== row["status"] || plan.revision !== row["revision"]) invalid(); return plan;
  }
  #putPlan(plan: PartnerGroupPlan): void {
    if (isPartnerGroupPlanOpen(plan.status) && this.openPlan(plan.groupId)?.id !== plan.id) changed();
    this.#db.prepare("UPDATE group_plans SET revision = ?,status = ?,payload_json = ?,updated_at = ? WHERE id = ?")
      .run(plan.revision, plan.status, safeJson(plan), plan.updatedAt, plan.id);
  }
}

function requestFingerprint(value: string): string { if (!/^[a-f0-9]{64}$/u.test(value)) invalid(); return value; }
function parseMessage(raw: unknown): PartnerGroupMessage {
  const value = record(raw, ["id", "sequence", "kind", "authorKind", "authorPartnerId", "authorName", "content", "mentions", "noticeCode", "planId", "files", "attachments", "createdAt"]);
  const authorKind = choice(value["authorKind"], ["user", "partner", "system"]), authorPartnerId = nullableIdentity(value["authorPartnerId"]);
  if (authorKind === "partner" && authorPartnerId === null || authorKind === "user" && authorPartnerId !== null) invalid();
  const mentions = record(value["mentions"], ["all", "partnerIds"]); if (typeof mentions["all"] !== "boolean") invalid();
  const mentioned = identities(mentions["partnerIds"], PARTNER_GROUP_MAX_MEMBERS);
  const files = strings(value["files"], PARTNER_GROUP_STEP_FILES_MAX, 4096);
  if (files.some(file => file.startsWith("/") || file.includes("\\") || file.split("/").some(part => part === ".." || !part) || /^[A-Za-z]:/u.test(file))) invalid();
  const noticeCode = value["noticeCode"] === null ? null : choice(value["noticeCode"], ["member-failed", "member-timeout", "member-unavailable", "plan-failed", "plan-stopped", "workdir-unavailable"]);
  return { id: identity(value["id"]), sequence: integer(value["sequence"], 1), kind: choice(value["kind"], ["message", "round-end", "notice", "plan", "plan-end"]),
    authorKind, authorPartnerId, authorName: text(value["authorName"], 200, true), content: text(value["content"], authorKind === "user" ? PARTNER_GROUP_MESSAGE_MAX_CHARS : PARTNER_GROUP_REPLY_MAX_CHARS, true),
    mentions: { all: mentions["all"], partnerIds: mentioned }, noticeCode, planId: nullableIdentity(value["planId"]), files,
    attachments: attachments(value["attachments"]), createdAt: integer(value["createdAt"], 0) };
}
function parsePlan(raw: unknown): PartnerGroupPlan {
  const value = record(raw, ["id", "groupId", "revision", "status", "requestText", "attachments", "organizerPartnerId", "organizerName", "steps", "currentStep", "workDir", "branch", "createdAt", "updatedAt"]);
  if (!Array.isArray(value["steps"]) || value["steps"].length < 1 || value["steps"].length > PARTNER_GROUP_PLAN_MAX_STEPS) invalid();
  const steps = value["steps"].map((raw, position): PartnerGroupPlanStep => {
    const step = record(raw, ["position", "partnerId", "partnerName", "task", "status", "resultMessageId", "startedAt", "finishedAt"]);
    if (step["position"] !== position) invalid();
    return { position, partnerId: identity(step["partnerId"]), partnerName: text(step["partnerName"], 200), task: text(step["task"], PARTNER_GROUP_PLAN_TASK_MAX_CHARS),
      status: choice(step["status"], ["pending", "running", "done", "failed"]), resultMessageId: nullableIdentity(step["resultMessageId"]),
      startedAt: nullableTime(step["startedAt"]), finishedAt: nullableTime(step["finishedAt"]) };
  });
  const currentStep = value["currentStep"] === null ? null : integer(value["currentStep"], 0); if (currentStep !== null && currentStep >= steps.length) invalid();
  return { id: identity(value["id"]), groupId: identity(value["groupId"]), revision: integer(value["revision"], 1),
    status: choice(value["status"], ["proposed", "running", "waiting", "done", "stopped", "dismissed", "superseded"]),
    requestText: text(value["requestText"], PARTNER_GROUP_MESSAGE_MAX_CHARS, true), attachments: attachments(value["attachments"]),
    organizerPartnerId: identity(value["organizerPartnerId"]), organizerName: text(value["organizerName"], 200), steps, currentStep,
    workDir: value["workDir"] === null ? null : text(value["workDir"], 4096), branch: value["branch"] === null ? null : text(value["branch"], 256),
    createdAt: integer(value["createdAt"], 0), updatedAt: integer(value["updatedAt"], 0) };
}
function parseLane(raw: unknown): PartnerGroupLane {
  const value = record(raw, ["groupId", "partnerId", "planId", "operationId", "phase", "sessionId", "profileVersion", "createdAt", "updatedAt"]);
  const phase = choice(value["phase"], ["preparing", "ready", "unknown", "archived"]), sessionId = nullableIdentity(value["sessionId"]);
  if (phase === "ready" && sessionId === null) invalid();
  return { groupId: identity(value["groupId"]), partnerId: identity(value["partnerId"]), planId: nullableIdentity(value["planId"]), operationId: identity(value["operationId"]),
    phase, sessionId, profileVersion: integer(value["profileVersion"], 1), createdAt: integer(value["createdAt"], 0), updatedAt: integer(value["updatedAt"], 0) };
}
function attachments(raw: unknown): readonly PartnerGroupAttachment[] {
  if (!Array.isArray(raw) || raw.length > PARTNER_GROUP_ATTACHMENTS_MAX) invalid();
  const result = raw.map((raw): PartnerGroupAttachment => {
    const value = record(raw, ["id", "name", "category", "blob", "annotated"]), blob = record(value["blob"], ["id", "sha256", "byteLength", "mimeType"], ["fileName"]);
    if (typeof blob["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(blob["sha256"]) || typeof value["annotated"] !== "boolean") invalid();
    return { id: identity(value["id"]), name: text(value["name"], 1024), category: choice(value["category"], ["image", "pdf", "text", "office", "file"]), annotated: value["annotated"],
      blob: { id: identity(blob["id"]), sha256: blob["sha256"], byteLength: integer(blob["byteLength"], 0), mimeType: text(blob["mimeType"], 256),
        ...(blob["fileName"] === undefined ? {} : { fileName: text(blob["fileName"], 1024) }) } };
  });
  if (new Set(result.map(item => item.id)).size !== result.length) invalid(); return result;
}
function safeJson(value: unknown): string {
  const safe = serializeJson(value); if (Buffer.byteLength(safe) > MAX_RECORD_BYTES) invalid();
  if (!isDeepStrictEqual(value, JSON.parse(safe))) throw new SensitiveDataError("Group data must not contain credentials."); return safe;
}
function decode(value: unknown): unknown {
  const body = text(value, MAX_RECORD_BYTES); if (Buffer.byteLength(body) > MAX_RECORD_BYTES) invalid();
  try { return JSON.parse(body); } catch { return invalid(); }
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); const row = value as Row;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid(); return row;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || !empty && !value.trim() || Array.from(value).length > maximum || CONTROL.test(value)) invalid(); return value;
}
function identity(value: unknown): string { const id = text(value, 256); if (!ID.test(id)) invalid(); return id; }
function nullableIdentity(value: unknown): string | null { return value === null ? null : identity(value); }
function integer(value: unknown, minimum: number): number { if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(); return Number(value); }
function nullableTime(value: unknown): number | null { return value === null ? null : integer(value, 0); }
function groupName(value: unknown): string { return text(value, PARTNER_GROUP_NAME_MAX_CHARS).replace(/\s+/gu, " ").trim(); }
function identities(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(); const ids = value.map(identity);
  if (new Set(ids).size !== ids.length) invalid(); return ids;
}
function memberIds(value: unknown): string[] { const ids = identities(value, PARTNER_GROUP_MAX_MEMBERS); if (ids.length < PARTNER_GROUP_MIN_MEMBERS) invalid(); return ids; }
function strings(value: unknown, maximum: number, length: number): string[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value.map(item => text(item, length)); }
function choice<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== "string" || !allowed.includes(value as T)) invalid(); return value as T; }
function invalid(): never { throw new PartnerGroupStoreError("invalid", "Group data must use the current valid state format. Incompatible development data must be rebuilt explicitly."); }
function changed(): never { throw new PartnerGroupStoreError("changed", "The group changed. Read its current state before continuing."); }
function missing(): never { throw new PartnerGroupStoreError("not_found", "The group record is unavailable."); }
