import { createHash, randomUUID } from "node:crypto";
import type { Routine, RoutineInput, RoutineRun, RunDescriptor, SessionDescriptor } from "@joko/core";
import { TaskShareStore, type ConnectionRecord, type OperationalStore, type PartnerStore } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import type { PartnerRoutineManager } from "./partner-routine-manager.js";
import type { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import type { BridgeToolCallContext } from "./mcp-router.js";
import { ownerAuthoredPromptText } from "./native-owner-intent.js";
// Runtime facts, consent, event admission and native execution retain their original owners.
export const PARTNER_HOST_SOURCE = "host:sessions";
const TYPES = ["stuck", "waiting", "errored", "usage-limit", "finished", "sweep"] as const;
type EventType = typeof TYPES[number];
const DAY = 24 * 60 * 60_000, FALLBACK = 2 * 60 * 60_000;
const SETTINGS_SCOPE = "partner.autonomy.v1", SETTINGS_KEY = "settings";
const RESPONSIBILITY_PREFIX = "responsibility.";
const MAX_RESPONSIBILITIES = 10_000;
const FOLLOW_UP_VERSION = 1;
const TODO_CHECK_VERSION = 1;
export interface PartnerAutonomySettings {
  readonly revision: number; readonly customized: boolean; readonly schedulerPartnerId?: string;
  readonly schedulerFallbackPartnerIds: readonly string[];
}
export type PartnerAutonomyChoice = { readonly schedulerPartnerId: string } | { readonly disabled: true }
  | { readonly reset: true } | { readonly fallback: { readonly partnerId: string; readonly allow: boolean } };
export type PartnerObservedPhase = "running" | "waiting-permission" | "waiting-answer" | "errored" | "usage-limit" | "finished";
export interface PartnerObservedTask {
  readonly sessionId: string; readonly generation: number; readonly targetId: string; readonly title: string;
  readonly phase: PartnerObservedPhase; readonly phaseSince: number; readonly startedAt?: number;
  readonly question?: string; readonly interactionId?: string; readonly creatorPartnerId?: string; readonly followerPartnerId?: string;
  readonly responsiblePartnerId?: string;
  readonly canonicalPartnerId?: string; readonly runId: string; readonly lastActivityAt: number; readonly toolInFlight: boolean;
  readonly source: RunDescriptor["source"]; readonly shared: boolean; readonly readOnly: boolean;
  readonly deviceId?: string; readonly deviceName?: string; readonly online: boolean;
}
interface GlanceSnapshot {
  readonly partnerId: string; readonly partnerRevision: bigint; readonly allTasks: boolean;
  readonly rows: readonly PartnerObservedTask[]; readonly waitingCount: number; readonly workingCount: number;
  readonly doneToday: number; readonly observedAt: number; readonly settingsRevision: number;
}
interface TaskResponsibility {
  readonly version: 1;
  readonly adoptedBy?: string;
  readonly released: readonly string[];
}
export interface PartnerFollowUpRuntime {
  prepare(routine: Routine, run: RoutineRun): { readonly events: RoutineRun["events"]; readonly context: string; readonly assertCurrent: () => void } | undefined;
}

/** Only a host event can wake the built-in observer. It cannot answer an interaction. */
export class PartnerAutonomyManager implements PartnerFollowUpRuntime {
  #timer: ReturnType<typeof setInterval> | undefined; #scheduled: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined; #sweeping = false; #closed = true; #startedAt = 0;
  readonly #snapshots = new Map<string, GlanceSnapshot>(); readonly #lastWoken = new Map<string, number>();
  readonly #completed = new Map<string, { readonly at: number; readonly sessionId: string; readonly creatorPartnerId?: string; readonly canonicalPartnerId?: string }>();
  constructor(readonly options: { readonly store: OperationalStore; readonly profiles: PartnerStore; readonly partners: PartnerManager;
    readonly routines: PartnerRoutineManager; readonly tasks: PartnerSessionTaskManager; readonly now?: () => number }) {}
  #now(): number { return (this.options.now ?? Date.now)(); }
  settings(): PartnerAutonomySettings {
    const saved = this.options.store.findSetting<PartnerAutonomySettings>("service", SETTINGS_SCOPE, SETTINGS_KEY)?.value;
    const value = saved ?? { revision: 1, customized: false, schedulerFallbackPartnerIds: [] };
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.customized !== "boolean"
      || value.schedulerPartnerId !== undefined && !id(value.schedulerPartnerId) || !Array.isArray(value.schedulerFallbackPartnerIds)
      || value.schedulerFallbackPartnerIds.length > 1_000 || value.schedulerFallbackPartnerIds.some(item => !id(item))) throw new Error("The autonomy settings are invalid.");
    return structuredClone(value);
  }
  update(input: { readonly operationId: string; readonly connection: ConnectionRecord; readonly expectedRevision: number;
    readonly choice: PartnerAutonomyChoice; readonly assertCurrent: () => void }): PartnerAutonomySettings {
    input.assertCurrent();
    const result = this.options.store.runAuthorizedOperation(input.connection.id, input.connection.authKeyDigest,
      { id: input.operationId, kind: "partner_autonomy_settings", body: { expectedRevision: input.expectedRevision, choice: input.choice } }, store => {
        input.assertCurrent(); const before = this.settings();
        if (before.revision !== input.expectedRevision) throw new Error("The follow-up settings changed. Refresh before saving.");
        let next: PartnerAutonomySettings = { ...before, revision: before.revision + 1 };
        if ("schedulerPartnerId" in input.choice) {
          this.#partner(input.choice.schedulerPartnerId, true);
          next = { ...next, customized: true, schedulerPartnerId: input.choice.schedulerPartnerId };
        } else if ("disabled" in input.choice || "reset" in input.choice) {
          const { schedulerPartnerId: _scheduler, ...rest } = next;
          next = { ...rest, customized: "disabled" in input.choice };
        } else {
          this.#partner(input.choice.fallback.partnerId, false);
          const ids = new Set(next.schedulerFallbackPartnerIds);
          if (input.choice.fallback.allow) ids.add(input.choice.fallback.partnerId); else ids.delete(input.choice.fallback.partnerId);
          next = { ...next, schedulerFallbackPartnerIds: [...ids].sort() };
        }
        store.setSetting("service", SETTINGS_SCOPE, SETTINGS_KEY, next); return next;
      });
    this.#snapshots.clear(); this.refresh(); return result.value;
  }
  async start(): Promise<void> {
    if (!this.#closed) return;
    this.#closed = false; this.#startedAt = this.#now();
    this.options.routines.engine.registerSource({ id: PARTNER_HOST_SOURCE, name: "Joko tasks", status: "listening",
      events: TYPES.map(type => ({ type, name: type, fields: ["sessionId", "generation", "runId", "phase", "minutes", "creatorPartnerId", "followerPartnerId"] })) });
    this.#unsubscribe = this.options.store.subscribe(event => {
      if (event.payload.type === "run_state" && event.payload.state === "completed" && event.sessionId && event.runId) {
        const run = this.options.store.findRun(event.runId)?.descriptor, session = this.options.store.getSession(event.sessionId).descriptor;
        if (run?.source !== "schedule" && event.generation === session.binding.generation) {
          const link = this.options.profiles.getSessionLink(event.sessionId), creatorPartnerId = this.#creators().get(event.sessionId);
          if (link?.role !== "canonical") this.#completed.set(event.runId, { at: event.emittedAt, sessionId: event.sessionId, ...(creatorPartnerId ? { creatorPartnerId } : {}) });
        }
      }
      this.refresh();
    });
    this.#timer = setInterval(() => { void this.sweep().catch(() => this.#diagnose()); }, 30_000); this.#timer.unref?.();
    await this.sweep();
  }
  stop(): void {
    this.#closed = true; this.#unsubscribe?.(); this.#unsubscribe = undefined;
    clearInterval(this.#timer); clearTimeout(this.#scheduled); this.#timer = this.#scheduled = undefined;
    this.#snapshots.clear(); this.#lastWoken.clear();
    this.#completed.clear();
  }
  refresh(): void {
    if (this.#closed || this.#scheduled) return;
    this.#scheduled = setTimeout(() => { this.#scheduled = undefined; void this.sweep().catch(() => this.#diagnose()); }, 250);
    this.#scheduled.unref?.();
  }
  #diagnose(): void {
    try { this.options.store.appendDiagnostic({ severity: "warning", component: "partner-autonomy", code: "PARTNER_AUTONOMY_REFRESH_FAILED",
      message: "Partner task observation could not refresh. Open the original task or retry.", details: {} }); } catch { /* Store owns its failure. */ }
  }
  #partner(partnerId: string, active: boolean) {
    const profile = this.options.partners.getPartner(partnerId);
    if (profile.lifecycle === "deleted" || profile.lifecycle === "archived" || active && profile.lifecycle !== "active"
      || profile.initializationState !== "ready" || !profile.canonicalSessionId || this.options.partners.isHomeChanging(partnerId)) throw new Error("The follow-up Partner is unavailable.");
    const session = this.options.store.getSession(profile.canonicalSessionId).descriptor;
    if (session.archived || session.deletedAt !== undefined || session.targetId !== profile.homeTargetId || session.remoteWorkspace !== undefined) throw new Error("The follow-up Partner must run on its home computer.");
    return profile;
  }
  #scheduler(settings: PartnerAutonomySettings): string | undefined {
    if (!settings.customized || !settings.schedulerPartnerId) return undefined;
    try { this.#partner(settings.schedulerPartnerId, false); return settings.schedulerPartnerId; } catch { return undefined; }
  }
  #follower(creator: string | undefined, settings: PartnerAutonomySettings): string | undefined {
    const available = (partnerId: string | undefined): string | undefined => {
      if (!partnerId) return undefined; try { this.#partner(partnerId, true); return partnerId; } catch { return undefined; }
    };
    if (creator) return available(creator) ?? (settings.schedulerFallbackPartnerIds.includes(creator) ? available(this.#scheduler(settings)) : undefined);
    return available(this.#scheduler(settings));
  }
  #creators(): Map<string, string> {
    const creators = new Map<string, string>();
    for (const profile of this.options.partners.listPartners()) {
      for (const delegation of this.options.profiles.listDelegations(profile.id)) {
        if (delegation.childSessionId && !creators.has(delegation.childSessionId)) creators.set(delegation.childSessionId, delegation.requesterPartnerId);
      }
      for (const task of this.options.tasks.list(profile.id)) if (task.sessionId) creators.set(task.sessionId, profile.id);
    }
    // Explicit workbench adoption already owns these tasks; its record never grants another project.
    for (const row of this.options.store.listSettings("service", "partner.workbench.background")) {
      const task = row.value as { version?: unknown; sessionId?: unknown; partnerId?: unknown; status?: unknown } | null;
      if (task?.version === 1 && id(task.sessionId) && id(task.partnerId) && task.status !== "failed" && !creators.has(task.sessionId)) creators.set(task.sessionId, task.partnerId);
    }
    return creators;
  }
  setResponsibility(partnerId: string, taskId: string, responsible: boolean, operationId: string, context: BridgeToolCallContext, signal?: AbortSignal) {
    if (!id(taskId)) throw new Error("The original task ID is invalid.");
    const { store, partners, profiles } = this.options;
    const assertCurrent = () => {
      signal?.throwIfAborted(); context.assertCurrent?.();
      const profile = this.#partner(partnerId, true);
      const caller = store.getSession(context.sessionId).descriptor;
      if (!context.localProductScope || caller.targetId !== context.targetId || caller.targetId !== profile.homeTargetId
        || caller.binding.generation !== context.generation || partners.runtimeCaller(caller.id).id !== partnerId) {
        throw new Error("The original Partner authority changed.");
      }
      const runOwner = context.inputQueueItem;
      const queue = runOwner && store.findQueueItemByRunId(caller.id, runOwner.runId);
      const run = runOwner && store.findRun(runOwner.runId)?.descriptor;
      const attempt = runOwner && store.getAttempt(runOwner.attemptId).descriptor;
      if (!runOwner || !run || queue?.id !== runOwner.id || queue.attemptId !== runOwner.attemptId
        || !["dispatching", "backend_accepted"].includes(queue.state) || !["running", "queued", "waiting", "retrying"].includes(run.state)
        || run.activeAttemptId !== runOwner.attemptId || attempt?.runId !== run.id || attempt.endedAt !== undefined
        || attempt.generation !== context.generation || attempt.backendInstanceGeneration !== store.getBackend(caller.backendId).descriptor.instanceGeneration) {
        throw new Error("The original Partner turn changed.");
      }
      if (responsible || caller.id === profile.canonicalSessionId) {
        const operation = queue && store.findOperation(queue.operationId);
        if (caller.id !== profile.canonicalSessionId || run.source !== "user" || run.parentRunId !== undefined
          || queue.body.messagingOrigin || queue.body.automaticContinuation || queue.body.objectiveContinuation || queue.body.inputHandoffContinuation
          || !operation?.connectionId || store.getConnection(operation.connectionId).state !== "active" || operation.status !== "completed"
          || (operation.kind !== "sendInput" && operation.kind !== "send_input") || new TaskShareStore(store).getAuthorForOperation(queue.operationId)
          || !(ownerAuthoredPromptText(queue.body).match(/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}/gu)?.some(word => word === taskId || word.replace(/[.:]+$/u, "") === taskId)
            || queue.body.mentions.some(mention => mention.kind === "session" && mention.reference === taskId))) {
          throw new Error("The owner must select this task in the current Partner message.");
        }
      } else if (run.source !== "schedule") {
        throw new Error("The routine can release responsibility during its own scheduled run.");
      }
    };
    assertCurrent();
    const result = store.runOperation({ id: operationId, kind: "partner_task_responsibility", body: { partnerId, taskId, responsible } }, () => {
      assertCurrent();
      const task = store.getSession(taskId).descriptor, target = store.getTarget(task.targetId);
      const link = profiles.getSessionLink(taskId);
      if (task.archived || task.deletedAt !== undefined || task.hidden || task.remoteWorkspace || !target.descriptor.trusted || target.descriptor.remoteWorkspace
        || task.automationOrigin || task.derivationOrigin?.sideChat || store.findSessionRuntimePolicy(taskId) || store.findCollaborationWorkerBySession(taskId)
        || new TaskShareStore(store).list().some(share => share.sessionId === taskId && share.status === "active")) {
        throw new Error("The task cannot be followed from this Partner.");
      }
      const key = `${RESPONSIBILITY_PREFIX}${taskId}`;
      const stored = store.findSetting("service", SETTINGS_SCOPE, key);
      const record: TaskResponsibility | null = stored === undefined ? { version: 1, released: [] } : taskResponsibility(stored.value);
      if (!record) throw new Error("The task's responsibility record is unavailable.");
      const creator = this.#creators().get(taskId);
      const assigned = responsiblePartner(record, creator);
      if (responsible) {
        if (assigned && assigned !== partnerId || link && (link.role !== "delegation" || creator !== partnerId)
          || !store.listRuns({ sessionId: taskId, activeOnly: true, limit: 1 }).length) throw new Error("This task is not available to take over.");
      } else if (assigned !== partnerId && creator !== partnerId && !record.released.includes(partnerId)) {
        throw new Error("This Partner does not follow the selected task.");
      }
      const released = new Set(record.released);
      if (responsible) released.delete(partnerId); else released.add(partnerId);
      const adoptedBy = responsible ? partnerId : record.adoptedBy === partnerId ? undefined : record.adoptedBy;
      if (stored === undefined && store.listSettingsByKeyPrefix("service", SETTINGS_SCOPE, RESPONSIBILITY_PREFIX).length >= MAX_RESPONSIBILITIES) {
        throw new Error("The task responsibility store is full.");
      }
      store.setSetting("service", SETTINGS_SCOPE, key, { version: 1, released: [...released], ...(adoptedBy === undefined ? {} : { adoptedBy }) } satisfies TaskResponsibility);
      return { taskId, responsible };
    });
    this.#snapshots.clear(); this.refresh();
    return result.value;
  }
  observe(): readonly PartnerObservedTask[] {
    const settings = this.settings(), scheduler = this.#scheduler(settings), creators = this.#creators();
    const responsibilities = new Map(this.options.store.listSettingsByKeyPrefix("service", SETTINGS_SCOPE, RESPONSIBILITY_PREFIX)
      .map(item => [item.key.slice(RESPONSIBILITY_PREFIX.length), taskResponsibility(item.value)]));
    const canonical = new Map(this.options.partners.listPartners().flatMap(profile => profile.canonicalSessionId ? [[profile.canonicalSessionId, profile.id] as const] : []));
    const sessions = scheduler ? this.options.store.listSessions({ excludeHidden: true }).map(row => row.descriptor)
      : [...new Set([...creators.keys(), ...responsibilities.keys()])].flatMap(sessionId => {
        if (!responsiblePartner(responsibilities.get(sessionId), creators.get(sessionId))) return [];
        try { return [this.options.store.getSession(sessionId).descriptor]; } catch { return []; }
      });
    const shared = new Set(new TaskShareStore(this.options.store).list().filter(item => item.status === "active").map(item => item.sessionId));
    return sessions.flatMap(session => {
      const link = this.options.profiles.getSessionLink(session.id);
      if (session.archived || session.deletedAt !== undefined || session.hidden || link && link.role !== "canonical" && link.role !== "delegation") return [];
      const run = this.options.store.listRuns({ sessionId: session.id, limit: 1 })[0]?.descriptor;
      if (!run || run.state === "queued" || run.state === "aborted") return [];
      const interaction = this.options.store.listInteractions({ sessionId: session.id, status: "open", limit: 100 })
        .find(item => item.generation === session.binding.generation && item.runId === run.id);
      let phase: PartnerObservedPhase = interaction ? interaction.kind === "permission" ? "waiting-permission" : "waiting-answer"
        : run.state === "failed" || run.state === "dispatch_unknown" ? "errored" : run.state === "completed" ? "finished"
          : run.state === "retrying" && /usage|quota|rate.limit/iu.test(run.error?.code ?? "") ? "usage-limit" : "running";
      if (run.state === "retrying" && phase === "running" && /usage|quota|rate.limit/iu.test(run.error?.message ?? "")) phase = "usage-limit";
      const events = this.options.store.listEvents({ sessionId: session.id, order: "desc", limit: 1000 })
        .filter(event => event.runId === run.id && event.generation === session.binding.generation);
      const toolCalls = new Set<string>();
      for (const event of [...events].reverse()) {
        if (event.payload.type === "tool_start") toolCalls.add(event.payload.callId);
        else if (event.payload.type === "tool_result") toolCalls.delete(event.payload.callId);
      }
      const creatorPartnerId = creators.get(session.id), canonicalPartnerId = canonical.get(session.id), remote = session.remoteWorkspace;
      const responsibility = responsibilities.get(session.id), responsiblePartnerId = responsiblePartner(responsibility, creatorPartnerId);
      const phaseSince = interaction?.createdAt ?? run.endedAt ?? run.startedAt ?? run.createdAt;
      if (phase === "finished" && this.#now() - phaseSince > 15 * 60_000) return [];
      const isShared = shared.has(session.id), follower = remote || isShared || responsibility === null ? undefined : this.#follower(responsiblePartnerId, settings);
      const followerPartnerId = follower === canonicalPartnerId || follower && responsibility?.released.includes(follower) ? undefined : follower;
      const question = interaction?.payload.kind === "question" ? compact(interaction.payload.prompt, 140)
        : interaction?.payload.kind === "permission" ? compact(interaction.payload.title, 140)
          : phase === "errored" ? compact(run.error?.message ?? "Task execution outcome is unavailable.", 140) : undefined;
      return [{ sessionId: session.id, generation: session.binding.generation, targetId: session.targetId, title: session.title,
        phase, phaseSince,
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }), ...(question ? { question } : {}),
        ...(interaction ? { interactionId: interaction.id } : {}), ...(creatorPartnerId ? { creatorPartnerId } : {}), ...(responsiblePartnerId ? { responsiblePartnerId } : {}),
        ...(canonicalPartnerId ? { canonicalPartnerId } : {}), ...(followerPartnerId ? { followerPartnerId } : {}),
        runId: run.id, source: run.source, shared: isShared, readOnly: remote !== undefined,
        lastActivityAt: Math.max(run.startedAt ?? run.createdAt, ...events.map(event => event.emittedAt)),
        toolInFlight: toolCalls.size > 0 || events.length === 1000, online: true,
        ...(remote?.kind === "device_peer" ? { deviceId: remote.targetDeviceId, deviceName: this.options.store.getTarget(session.targetId).descriptor.displayName } : {}) } satisfies PartnerObservedTask];
    });
  }
  glance(partnerId: string, token = "", offset = 0) {
    const partner = this.#partner(partnerId, false), now = this.#now(), settings = this.settings();
    for (const [key, value] of this.#snapshots) if (now - value.observedAt > 120_000) this.#snapshots.delete(key);
    let snapshot = token ? this.#snapshots.get(token) : undefined;
    if (token && (!snapshot || snapshot.partnerId !== partnerId || snapshot.partnerRevision !== partner.revision || snapshot.settingsRevision !== settings.revision)) throw new Error("The task observation page expired. Refresh the list.");
    if (!Number.isSafeInteger(offset) || offset < 0 || !token && offset !== 0) throw new Error("The task observation offset is invalid.");
    if (!snapshot) {
      const allTasks = this.#scheduler(settings) === partnerId;
      const observed = this.observe().filter(row => row.canonicalPartnerId !== partnerId && (allTasks || row.responsiblePartnerId === partnerId));
      const rows = observed.filter(row => row.phase !== "finished").sort((a, b) => Number(working(a)) - Number(working(b))
        || (working(a) ? b.phaseSince - a.phaseSince : a.phaseSince - b.phaseSince) || a.sessionId.localeCompare(b.sessionId));
      snapshot = { partnerId, partnerRevision: partner.revision, allTasks, rows, waitingCount: rows.filter(row => !working(row)).length,
        workingCount: rows.filter(working).length, doneToday: this.#completedToday(partnerId, allTasks), observedAt: now, settingsRevision: settings.revision };
      token = randomUUID(); this.#snapshots.set(token, snapshot);
      while (this.#snapshots.size > 64) this.#snapshots.delete(this.#snapshots.keys().next().value!);
    }
    const rows = snapshot.rows.slice(offset, offset + 50);
    return { ...snapshot, rows, snapshotToken: token, ...(offset + 50 < snapshot.rows.length ? { nextOffset: offset + 50 } : {}) };
  }
  #completedToday(partnerId: string, all: boolean): number {
    return new Set(this.options.store.listSettingsByKeyPrefix("service", SETTINGS_SCOPE, "done.").flatMap(item => {
      const value = item.value as { at: number; sessionId: string; creatorPartnerId?: string; canonicalPartnerId?: string };
      return sameDay(value.at, this.#now()) && value.canonicalPartnerId !== partnerId && (all || value.creatorPartnerId === partnerId) ? [value.sessionId] : [];
    })).size;
  }
  async sweep(): Promise<void> {
    if (this.#closed || this.#sweeping) return;
    this.#sweeping = true;
    try {
      const now = this.#now();
      for (const [runId, completed] of this.#completed) {
        const key = `done.${hash(runId)}`;
        if (!this.options.store.findSetting("service", SETTINGS_SCOPE, key)) this.options.store.setSetting("service", SETTINGS_SCOPE, key, completed);
        this.#completed.delete(runId);
      }
      for (const partner of this.options.partners.listPartners("active")) {
        try {
          this.#partner(partner.id, true);
          await this.options.routines.engine.ensureBuiltin(partner.id, followUpInput(partner.id), followUpId(partner.id), FOLLOW_UP_VERSION);
          if (!this.options.routines.engine.list(partner.id).some(routine => routine.builtin === "todo-check" && routine.builtinVersion === TODO_CHECK_VERSION)) {
            await this.options.routines.engine.ensureBuiltin(partner.id, todoCheckInput(),
              `builtin-todo-check-${hash(partner.id).slice(0, 40)}`, TODO_CHECK_VERSION, "todo-check");
          }
        }
        catch { /* Other Partners keep observing; this owner will be retried. */ }
      }
      if (this.#closed) return;
      for (const row of this.observe()) {
        const type = dueEvent(row, now);
        if (!type || !row.followerPartnerId) continue;
        const eventId = `${type}:${hash(JSON.stringify([row.sessionId, row.generation, row.runId, row.phaseSince, row.interactionId ?? ""]))}`, key = `event.${hash(eventId)}`;
        if (this.options.store.findSetting("service", SETTINGS_SCOPE, key)) continue;
        const occurrences = this.options.store.listSettingsByKeyPrefix("service", SETTINGS_SCOPE, "event.").filter(item => {
          const value = item.value as { at: number; sessionId: string; type: string };
          return value.sessionId === row.sessionId && value.type === type && now - value.at < DAY;
        });
        if (occurrences.length >= 6) continue;
        const accepted = await this.options.routines.engine.publish(PARTNER_HOST_SOURCE, { id: eventId, type, occurredAt: now, subject: row.sessionId,
          data: { sessionId: row.sessionId, generation: row.generation, runId: row.runId, phase: row.phase,
            minutes: Math.max(0, Math.floor((now - row.phaseSince) / 60_000)), creatorPartnerId: row.creatorPartnerId ?? "", followerPartnerId: row.followerPartnerId } },
          () => !this.#closed && this.observe().some(current => current.sessionId === row.sessionId && current.generation === row.generation
            && current.runId === row.runId && current.followerPartnerId === row.followerPartnerId && current.phaseSince === row.phaseSince));
        if (this.#closed) return;
        this.options.store.setSetting("service", SETTINGS_SCOPE, key, { at: now, sessionId: row.sessionId, type });
        if (accepted.accepted > 0) this.#lastWoken.set(row.followerPartnerId, now);
      }
      for (const partner of this.options.partners.listPartners("active")) {
        if (now - (this.#lastWoken.get(partner.id) ?? this.#startedAt) < FALLBACK) continue;
        if (!this.observe().some(row => row.followerPartnerId === partner.id && pending(row, now))) continue;
        const eventId = `sweep:${partner.id}:${Math.floor(now / FALLBACK)}`;
        const accepted = await this.options.routines.engine.publish(PARTNER_HOST_SOURCE, { id: eventId, type: "sweep", subject: partner.id, occurredAt: now,
          data: { followerPartnerId: partner.id } }, () => !this.#closed && this.observe().some(row => row.followerPartnerId === partner.id && pending(row, this.#now())));
        if (accepted.accepted > 0) this.#lastWoken.set(partner.id, now);
      }
      for (const item of this.options.store.listSettings("service", SETTINGS_SCOPE)) {
        if (!item.key.startsWith("event.") && !item.key.startsWith("done.")) continue;
        if (now - (item.value as { at: number }).at >= DAY) this.options.store.deleteSetting("service", SETTINGS_SCOPE, item.key);
      }
    } finally { this.#sweeping = false; }
  }
  prepare(routine: Routine, run: RoutineRun) {
    if (this.#closed || routine.builtin !== "follow-up" || routine.id !== followUpId(routine.partnerId)) return undefined;
    const profile = this.#partner(routine.partnerId, true), settings = this.settings();
    const rows = this.observe().filter(row => row.followerPartnerId === profile.id && row.canonicalPartnerId !== profile.id && !row.shared && !row.readOnly);
    const events = run.events.filter(item => item.sourceId === PARTNER_HOST_SOURCE && (item.event.type === "sweep"
      ? rows.some(row => pending(row, this.#now()))
      : rows.some(row => item.event.subject === row.sessionId && item.event.data["runId"] === row.runId && item.event.data["generation"] === row.generation)));
    if (events.length === 0) return undefined;
    const chosen = rows.filter(row => events.some(item => item.event.type === "sweep" ? pending(row, this.#now()) : item.event.subject === row.sessionId)).sort((a, b) => a.sessionId.localeCompare(b.sessionId)).slice(0, 100);
    const identities = JSON.stringify(chosen.map(row => [row.sessionId, row.generation, row.runId, row.followerPartnerId, row.interactionId]));
    return { events, context: JSON.stringify(chosen.map(row => ({ sessionId: row.sessionId, generation: row.generation, runId: row.runId,
      title: compact(row.title, 200), phase: row.phase, minutes: Math.max(0, Math.floor((this.#now() - row.phaseSince) / 60_000)), question: row.question ?? "" }))),
      assertCurrent: () => {
        if (this.#closed || this.#partner(profile.id, true).revision !== profile.revision || this.settings().revision !== settings.revision) throw new Error("Follow-up consent changed.");
        const current = this.observe().filter(row => chosen.some(before => before.sessionId === row.sessionId)).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
        if (JSON.stringify(current.map(row => [row.sessionId, row.generation, row.runId, row.followerPartnerId, row.interactionId])) !== identities) throw new Error("Follow-up task ownership changed.");
      } };
  }
}

export function followUpId(partnerId: string): string { return `builtin-follow-up-${hash(partnerId).slice(0, 40)}`; }

/** A service-owned follow-up Session can message only a child it delegated. */
export function canSendFollowUpTaskMessage(
  profiles: Pick<PartnerStore, "getSessionLink" | "getPartner" | "getDelegation">,
  caller: SessionDescriptor,
  targetSessionId: string | undefined
): boolean {
  const link = profiles.getSessionLink(caller.id);
  if (link?.role !== "routine") return true;
  const key = `routine:${followUpId(link.partnerId)}`;
  if (link.routineKey !== key && !link.routineKey?.startsWith(`${key}:`)) return true;
  const owner = profiles.getPartner(link.partnerId);
  if (!targetSessionId || owner.lifecycle !== "active" || owner.initializationState !== "ready" || owner.pauseCleanupPending
    || owner.profileVersion !== link.profileVersion || owner.homeTargetId !== caller.targetId) return false;

  const child = profiles.getSessionLink(targetSessionId);
  if (child?.role !== "delegation" || !child.delegationId) return false;
  const delegation = profiles.getDelegation(child.delegationId);
  return delegation.requesterPartnerId === owner.id && delegation.childSessionId === targetSessionId
    && delegation.targetPartnerId === child.partnerId && delegation.targetProfileVersion === child.profileVersion
    && delegation.status !== "cancelled";
}

function todoCheckInput(): RoutineInput {
  return {
    name: "Daily todo check", enabled: false, silentWhenIdle: true,
    prompt: "Check for items I need to handle that appeared since the previous check. Read the todo ledger and use only sources already authorized and available to this Partner. Add each verified new discovery with a stable key and its source evidence. Leave existing owner decisions alone. Call schedule_notify_current_run only when you recorded a new item that needs my attention.",
    triggers: [{ id: "weekday-morning", kind: "cron", expression: "0 9 * * 1-5",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }]
  };
}

function taskResponsibility(value: unknown): TaskResponsibility | null {
  const record = value as Partial<TaskResponsibility> | undefined;
  if (record?.version !== 1 || !Array.isArray(record.released) || !record.released.every(id)
    || record.adoptedBy !== undefined && !id(record.adoptedBy)) return null;
  return { version: 1, released: record.released, ...(record.adoptedBy === undefined ? {} : { adoptedBy: record.adoptedBy }) };
}

function responsiblePartner(record: TaskResponsibility | null | undefined, creator: string | undefined): string | undefined {
  if (record === null) return undefined;
  return record?.adoptedBy ?? (creator && !record?.released.includes(creator) ? creator : undefined);
}

function followUpInput(partnerId: string): RoutineInput {
  return { name: "Follow up on tasks", prompt: "Review these tasks and tell me your judgment and suggestions about anything that needs my reply or decision. Stay quiet when there is no new information. Do not message a task, answer an interaction, approve a request, or change task state without my explicit permission.",
    enabled: true, silentWhenIdle: true, triggers: TYPES.map(type => ({ id: `event-${type}`, kind: "event", sourceId: PARTNER_HOST_SOURCE, eventType: type,
      filters: [{ field: "followerPartnerId", operator: "equals", value: partnerId }] })) };
}
export function dueEvent(row: PartnerObservedTask, now: number): EventType | undefined {
  if (!row.online || row.readOnly || row.shared) return undefined;
  if (row.phase === "running") return now - Math.max(row.lastActivityAt, row.phaseSince) >= (row.toolInFlight ? 45 : 10) * 60_000 ? "stuck" : undefined;
  if (row.phase === "waiting-answer" || row.phase === "waiting-permission") return now - row.phaseSince >= 5 * 60_000 ? "waiting" : undefined;
  if (row.phase === "finished") return row.source === "schedule" || row.canonicalPartnerId ? undefined : "finished";
  return row.phase;
}
function pending(row: PartnerObservedTask, now: number): boolean { return row.phase !== "finished" && (row.phase !== "running" || dueEvent(row, now) === "stuck"); }
function working(row: PartnerObservedTask): boolean { return row.phase === "running" || row.phase === "usage-limit"; }
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function compact(value: string, maximum: number): string { return Array.from(value.replace(/\s+/gu, " ").trim()).slice(0, maximum).join(""); }
function sameDay(left: number, right: number): boolean { return new Date(left).toDateString() === new Date(right).toDateString(); }
