import { randomUUID } from "node:crypto";
import type { RoutineRun } from "@joko/core";
import type { MakerMemoryEntry, OperationalStore, PartnerLearningTurnRecord } from "@joko/store";
import type { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import type { MakerMemoryController } from "./maker-memory.js";
import type { PartnerLearningManager } from "./partner-learning.js";
import { hasPartnerLearningEvidence, partnerLearningSnapshotBudget, type PartnerLearningReviewMessage } from "./partner-learning-plan.js";
import { parsePartnerNightlyPlan, partnerNightlyInstructions, type PartnerNightlyPlan } from "./partner-nightly-learning-plan.js";
import type { PartnerLearningSkillBody, PartnerSkillsManager } from "./partner-skills.js";

export interface NightlyLearningOwner {
  readonly partnerId: string;
  readonly targetId: string;
  readonly partnerRevision: bigint;
  readonly assertCurrent: () => void;
}

type Memory = Pick<MakerMemoryEntry, "id" | "slug" | "title" | "description" | "body"> & {
  readonly kind: Exclude<MakerMemoryEntry["kind"], "digest">;
  readonly revision: string;
};
type Skill = Omit<PartnerLearningSkillBody, "revision"> & { readonly revision: string };
type RoutineStatus = "running" | "success" | "skipped" | "failed" | "interrupted";
type ChangeDetails = {
  readonly id: string;
  readonly action: "created" | "updated" | "removed" | "disabled";
  readonly reason: string;
  readonly title: string;
  readonly currentRevision?: string;
  readonly undone: boolean;
};
type EntryChange = ChangeDetails & (
  { readonly kind: "memory"; readonly before?: Memory; readonly after?: Memory }
  | { readonly kind: "skill"; readonly before?: Skill; readonly after?: Skill }
);
interface ReviewRun {
  readonly id: string;
  readonly startedAt: number;
  readonly manual: boolean;
  readonly status: RoutineStatus;
  readonly conversations: number;
  readonly changes: readonly EntryChange[];
}
interface Observation {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly firstSeenAt: number;
}
interface NightlyJournal {
  readonly version: 1;
  readonly targetId: string;
  readonly cursor: string;
  readonly history: readonly ReviewRun[];
  readonly candidates: readonly Observation[];
}

const journalKey = "partner.nightly-learning.v1";
const maxHistory = 24;
const maxCandidates = 24;
const conversationBudget = 40_000;

/** Private settings hold only the records needed to undo the exact changes, in
 * the same SQLite transaction that commits each memory or Skill mutation. */
export class PartnerNightlyLearning {
  readonly #active = new Map<string, string>();

  constructor(private readonly options: {
    readonly store: OperationalStore;
    readonly memory: MakerMemoryController;
    readonly skills: PartnerSkillsManager;
    readonly learning: Pick<PartnerLearningManager, "messagesForNightly" | "nightlyTurnCurrent">;
    readonly auxiliary: Pick<AuxiliaryTextRouting, "capture" | "run">;
    readonly now?: () => number;
  }) {}

  read(partnerId: string, targetId: string) {
    const { journal, revision } = this.#read(partnerId, targetId);
    const activeRun = this.#active.get(partnerId);
    return {
      revision, running: activeRun !== undefined, memoryEnabled: this.options.memory.enabledForTarget(targetId),
      pending: this.options.store.countPartnerNightlyTurns(partnerId, targetId, BigInt(journal.cursor)),
      history: journal.history.map(({ changes, ...run }) => ({ ...run,
        status: run.status === "running" && run.id !== activeRun ? "interrupted" as const : run.status,
        changes: changes.map(({ id, kind, action, title, reason, undone }) => ({ id, kind, action, title, reason, undone })) })),
      candidates: journal.candidates.map(({ id, title, description, firstSeenAt }) => ({ id, title, summary: description, firstSeenAt }))
    };
  }

  retire(partnerId: string): void { this.options.store.deleteSetting("service", partnerId, journalKey); }

  async run(owner: NightlyLearningOwner, occurrence: RoutineRun, signal: AbortSignal) {
    const { store, memory, skills, auxiliary } = this.options;
    const manual = occurrence.triggerIds.includes("manual");
    if (this.#active.has(owner.partnerId)) return { deferred: true };
    this.#active.set(owner.partnerId, occurrence.id);
    let conversations = 0;
    let recorded = false;
    try {
      const original = this.#read(owner.partnerId, owner.targetId).journal;
      let cursor = BigInt(original.cursor);
      const messages: PartnerLearningReviewMessage[] = [];
      const selected: { turn: PartnerLearningTurnRecord; userEvents: string[] }[] = [];
      let used = 0;
      for (const row of store.listPartnerNightlyTurns(owner.partnerId, owner.targetId, cursor, 32)) {
        owner.assertCurrent();
        const evidence = await this.options.learning.messagesForNightly(row.turn, owner.targetId, owner.assertCurrent);
        const size = JSON.stringify(evidence).length;
        if (messages.length && used + size > conversationBudget) break;
        cursor = row.cursor;
        const userEvents = evidence.filter(message => message.role === "user").map(message => message.id);
        if (userEvents.length === 0) continue;
        selected.push({ turn: row.turn, userEvents });
        messages.push(...evidence);
        conversations++;
        used += size;
      }
      const run: ReviewRun = { id: occurrence.id, manual, startedAt: this.#now(), conversations, status: "running", changes: [] };
      this.#write(owner, journal => ({ ...journal, history: [run, ...journal.history].slice(0, maxHistory) }));
      recorded = true;
      if (!manual && messages.length === 0) {
        this.#updateRun(owner, run.id, "skipped", cursor);
        return { skipped: true, resultText: "No new conversations to review." };
      }
      const originalOwner = owner;
      owner = { ...owner, assertCurrent: () => {
        originalOwner.assertCurrent();
        for (const { turn, userEvents } of selected) {
          if (!this.options.learning.nightlyTurnCurrent(turn, owner.targetId) || userEvents.some(eventId =>
            !store.findVisibleSessionMessageOrigin({ sessionId: turn.source.sessionId, eventId, role: "user" }))) {
            throw new Error("An original conversation is no longer available for learning.");
          }
        }
      } };

      const memories = memory.enabledForTarget(owner.targetId)
        ? partnerLearningSnapshotBudget(memory.list(owner.targetId).flatMap(entry => entry.kind === "digest" ? [] : [memorySnapshot(entry)]), 24_000) : [];
      const skillSnapshot = await skills.readLearningSnapshot(owner.partnerId, signal, owner.assertCurrent);
      if (!skillSnapshot) throw new Error("The Partner Skill catalog is unavailable.");
      const skillBodies = skillSnapshot.bodies.map(skillSnapshotRecord);
      const proposed = await auxiliary.run(auxiliary.capture(), { system: partnerNightlyInstructions,
        user: JSON.stringify({ messages, memoryEnabled: memory.enabledForTarget(owner.targetId),
          memories: memories.map(({ revision: ignored, ...entry }) => entry),
          skills: skillBodies.map(({ slug, title, description, body }) => ({ slug, title, description, body })),
          observations: partnerLearningSnapshotBudget(original.candidates, 12_000) }),
        maxTokens: 6_000, timeoutMs: 45_000, signal,
        stillCurrent: () => { try { owner.assertCurrent(); return true; } catch { return false; } },
        validate: raw => parsePartnerNightlyPlan(raw) ? raw : undefined });
      owner.assertCurrent();
      const plan = proposed.status === "ok" ? parsePartnerNightlyPlan(proposed.text) : undefined;
      if (!plan) throw new Error("The configured learning model could not prepare a review.");
      // Claim the accepted conversation batch before adopting its effects. An
      // interrupted occurrence keeps any committed changes and is never replayed.
      this.#updateRun(owner, run.id, "running", cursor);
      for (const change of plan.memories) {
        owner.assertCurrent();
        try { this.#applyMemoryPlan(owner, run.id, memories, change, messages); } catch { /* An invalid or stale item cannot write. */ }
      }
      for (const change of plan.skills) {
        owner.assertCurrent();
        const before = skillBodies.find(item => item.slug === change.slug && item.enabled);
        if (!before) continue;
        const after = change.action === "disable" ? { ...before, enabled: false } : {
          title: change.title, description: change.description, body: change.body, enabled: true
        };
        try {
          await this.#changeSkill(owner, run.id, change.slug, before, after, change.action === "disable" ? "disabled" : "updated", change.reason, signal);
        } catch { /* Scope, file versions and invalid replacements stay closed. */ }
      }
      for (const proposal of plan.promotions) {
        owner.assertCurrent();
        const existing = original.candidates.find(item => item.id === proposal.id);
        if (!existing || !hasPartnerLearningEvidence(proposal, messages, true)) continue;
        try { await this.#promote(owner, run.id, existing, proposal, proposal.reason, signal); } catch { /* A live Skill or changed observation owns the slot. */ }
      }
      this.#write(owner, journal => {
        const seen = new Set([...skillSnapshot.catalog.map(item => item.slug), ...original.candidates.map(item => item.slug)]);
        const observed: Observation[] = [];
        for (const { slug, title, description, body, evidence } of plan.observations) {
          if (seen.has(slug) || !hasPartnerLearningEvidence({ evidence }, messages, false)) continue;
          seen.add(slug); observed.push({ id: randomUUID(), slug, title, description, body, firstSeenAt: this.#now() });
        }
        return { ...journal, candidates: [...journal.candidates, ...observed].slice(0, maxCandidates) };
      });
      this.#updateRun(owner, run.id, "success", cursor);
      return { resultText: "Nightly learning completed." };
    } catch (error) {
      if (recorded && !signal.aborted) {
        try { this.#updateRun(owner, occurrence.id, "failed"); } catch { /* The original owner may have retired. */ }
      }
      throw error;
    } finally {
      this.#active.delete(owner.partnerId);
      if (recorded && this.#read(owner.partnerId, owner.targetId).journal.history.find(run => run.id === occurrence.id)
        ?.changes.some(change => change.kind === "memory")) memory.requestEntriesRefresh();
    }
  }

  async decideCandidate(owner: NightlyLearningOwner, candidateId: string, promote: boolean, signal: AbortSignal): Promise<void> {
    const candidate = this.#read(owner.partnerId, owner.targetId).journal.candidates.find(item => item.id === candidateId);
    if (!candidate) throw new Error("The learning candidate changed.");
    if (!promote) { this.#write(owner, journal => withoutCandidate(journal, candidateId)); return; }
    await this.#promote(owner, candidateId, candidate, candidate, "Approved by the owner.", signal);
  }

  async decideChange(owner: NightlyLearningOwner, runId: string, id: string, redo: boolean, signal: AbortSignal): Promise<void> {
    const { memory, skills } = this.options;
    const change = this.#read(owner.partnerId, owner.targetId).journal.history.find(run => run.id === runId)?.changes.find(item => item.id === id);
    if (!change || change.undone !== redo) throw new Error("The learning change has already been applied or removed.");
    const save = (_store: OperationalStore, revision: string | undefined): void => {
      this.#write(owner, journal => mapRun(journal, runId, run => ({ ...run, changes: run.changes.map(item => {
        if (item.id !== id) return item;
        const { currentRevision: _previousRevision, ...original } = item;
        return { ...original, undone: !redo, ...(revision === undefined ? {} : { currentRevision: revision }) };
      }) })));
    };
    if (change.kind === "memory") {
      this.options.store.transaction(store => {
        owner.assertCurrent();
        const identity = change.before ?? change.after!;
        const current = store.findMakerMemoryEntry(owner.targetId, identity.kind, identity.slug);
        if (current?.revision.toString() !== change.currentRevision || current && current.id !== identity.id) throw new Error("The memory was edited later.");
        const result = this.#putMemory(owner, current, redo ? change.after : change.before);
        save(store, result?.revision.toString());
      });
      memory.requestEntriesRefresh();
    } else {
      const identity = change.before ?? change.after!;
      const current = await skills.readNightlySkill(owner.partnerId, identity.slug, signal, owner.assertCurrent);
      if (current?.revision.toString() !== change.currentRevision) throw new Error("The Skill was edited later.");
      await skills.applyNightlySkill(owner.partnerId, owner.partnerRevision, identity.slug, current, redo ? change.after : change.before,
        signal, owner.assertCurrent, (store, value) => save(store, value?.revision.toString()));
    }
  }

  #applyMemoryPlan(owner: NightlyLearningOwner, runId: string, memories: readonly Memory[], change: PartnerNightlyPlan["memories"][number],
    messages: readonly PartnerLearningReviewMessage[]): void {
    const { store, memory } = this.options;
    if (!memory.enabledForTarget(owner.targetId)) return;
    store.transaction(() => {
      owner.assertCurrent();
      if (change.action === "create") {
        if (!hasPartnerLearningEvidence(change, messages, true) || store.findMakerMemoryEntry(owner.targetId, change.kind, change.slug)) return;
        this.#changeMemory(owner, runId, undefined, { ...change, id: randomUUID() }, change.reason);
        return;
      }
      const before = memories.find(value => value.id === change.id);
      if (!before) return;
      if (change.action === "remove") { this.#changeMemory(owner, runId, before, undefined, change.reason); return; }
      const sources = change.action === "merge" ? [...new Set(change.sources)].map(id => memories.find(value => value.id === id && id !== before.id)) : [];
      if (sources.some(source => source === undefined)) return;
      this.#changeMemory(owner, runId, before, { ...before, title: change.title, description: change.description, body: change.body }, change.reason);
      for (const source of sources) this.#changeMemory(owner, runId, source!, undefined, change.reason);
    });
  }

  #changeMemory(owner: NightlyLearningOwner, runId: string, before: Memory | undefined, desired: Omit<Memory, "revision"> | undefined,
    reason: string): void {
    const identity = before ?? desired!;
    const current = this.options.store.findMakerMemoryEntry(owner.targetId, identity.kind, identity.slug);
    if (before ? current?.id !== before.id || current.revision.toString() !== before.revision : current !== undefined) throw new Error("The memory changed.");
    if (current && desired && current.title === desired.title && current.description === desired.description && current.body === desired.body) return;
    const saved = this.#putMemory(owner, current, desired);
    const after = saved ? memorySnapshot(saved) : undefined;
    this.#append(owner, runId, { kind: "memory", action: !before ? "created" : !after ? "removed" : "updated", id: randomUUID(),
      title: (after ?? before!).title, reason, undone: false, ...(before ? { before } : {}), ...(after ? { after, currentRevision: after.revision } : {}) });
  }

  #putMemory(owner: NightlyLearningOwner, current: MakerMemoryEntry | undefined, desired: Omit<Memory, "revision"> | undefined) {
    const { memory, store } = this.options;
    if (!memory.enabledForTarget(owner.targetId)) throw new Error("Memory is disabled.");
    if (desired) return store.putMakerMemoryEntry({ ...desired, targetId: owner.targetId, mode: current ? "update" : "create" });
    if (current) memory.delete(owner.targetId, current.id);
    return undefined;
  }

  async #changeSkill(owner: NightlyLearningOwner, runId: string, slug: string, before: Skill | undefined,
    desired: Pick<Skill, "title" | "description" | "body" | "enabled">, action: ChangeDetails["action"], reason: string,
    signal: AbortSignal, candidateId?: string): Promise<void> {
    const prior = before ? { ...before, revision: BigInt(before.revision) } : undefined;
    let recorded = false;
    const assertCurrent = () => {
      owner.assertCurrent();
      if (candidateId && !recorded && !this.#read(owner.partnerId, owner.targetId).journal.candidates.some(entry => entry.id === candidateId)) {
        throw new Error("The candidate changed.");
      }
    };
    await this.options.skills.applyNightlySkill(owner.partnerId, owner.partnerRevision, slug, prior, desired, signal, assertCurrent, (_store, value) => {
      if (!value) throw new Error("The requested Skill save has no receipt.");
      const after = skillSnapshotRecord(value);
      this.#append(owner, runId, { kind: "skill", id: randomUUID(), action, reason, title: value.title,
        undone: false, ...(before ? { before } : {}), after, currentRevision: after.revision }, candidateId);
      recorded = true;
    });
  }

  async #promote(owner: NightlyLearningOwner, runId: string, candidate: Observation,
    desired: Pick<Observation, "title" | "description" | "body">, reason: string, signal: AbortSignal): Promise<void> {
    await this.#changeSkill(owner, runId, candidate.slug, undefined, { ...desired, enabled: true }, "created", reason, signal, candidate.id);
  }

  #append(owner: NightlyLearningOwner, runId: string, change: EntryChange, candidateId?: string): void {
    this.#write(owner, journal => {
      const existing = journal.history.find(run => run.id === runId);
      const next = existing ? mapRun(journal, runId, run => ({ ...run, changes: [...run.changes, change] })) : {
        ...journal, history: [{ id: runId, startedAt: this.#now(), manual: true, status: "success" as const, conversations: 0, changes: [change] },
          ...journal.history].slice(0, maxHistory)
      };
      return candidateId ? withoutCandidate(next, candidateId) : next;
    });
  }

  #updateRun(owner: NightlyLearningOwner, runId: string, status: RoutineStatus, cursor?: bigint): void {
    this.#write(owner, journal => mapRun(cursor === undefined ? journal : { ...journal, cursor: cursor.toString() }, runId, run => ({ ...run, status })));
  }

  #read(partnerId: string, targetId: string): { journal: NightlyJournal; revision: bigint } {
    const record = this.options.store.findSetting<NightlyJournal>("service", partnerId, journalKey);
    if (record?.value.version === 1 && record.value.targetId === targetId) return { journal: record.value, revision: record.revision };
    return { journal: { version: 1, targetId, cursor: "0", history: [], candidates: [] }, revision: 0n };
  }

  #write(owner: NightlyLearningOwner, update: (journal: NightlyJournal) => NightlyJournal): void {
    this.options.store.transaction(store => {
      owner.assertCurrent();
      store.setSetting("service", owner.partnerId, journalKey, update(this.#read(owner.partnerId, owner.targetId).journal));
    });
  }

  #now(): number { return (this.options.now ?? Date.now)(); }
}

function mapRun(journal: NightlyJournal, id: string, update: (run: ReviewRun) => ReviewRun): NightlyJournal {
  return { ...journal, history: journal.history.map(run => run.id === id ? update(run) : run) };
}

function withoutCandidate(journal: NightlyJournal, id: string): NightlyJournal {
  return { ...journal, candidates: journal.candidates.filter(candidate => candidate.id !== id) };
}

function memorySnapshot({ kind, id, slug, title, description, body, revision }: MakerMemoryEntry): Memory {
  if (kind === "digest") throw new Error("A Backend digest cannot be edited by Partner learning.");
  return { kind, id, slug, title, description, body, revision: revision.toString() };
}

function skillSnapshotRecord(skill: PartnerLearningSkillBody): Skill { return { ...skill, revision: skill.revision.toString() }; }
