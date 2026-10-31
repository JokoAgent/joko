import type { PartnerLearningReceipt, PartnerLearningTurnSource } from "@joko/core";
import type { MakerMemoryEntry, OperationalStore, PartnerLearningTurnRecord, PartnerStore, PersistedEvent, QueueItemRecord } from "@joko/store";
import type { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import type { MakerMemoryController } from "./maker-memory.js";
import type { PartnerLearningSaveCapture } from "./mcp-router.js";
import type { PartnerManager } from "./partner-manager.js";
import type { PartnerSkillsManager } from "./partner-skills.js";
import { hasPartnerLearningEvidence, parsePartnerLearningReviewPlan, partnerLearningReviewInstructions,
  partnerLearningSnapshotBudget, type PartnerLearningReviewMessage } from "./partner-learning-plan.js";

export interface PartnerLearningManagerOptions {
  readonly store: OperationalStore;
  readonly profiles: PartnerStore;
  readonly partners: PartnerManager;
  readonly memory: MakerMemoryController;
  readonly skills: PartnerSkillsManager;
  readonly auxiliary: Pick<AuxiliaryTextRouting, "capture" | "run">;
  readonly assertMessagingSource?: (item: QueueItemRecord) => void;
}

type OrderedMessage = PartnerLearningReviewMessage & { readonly cursor: bigint };
interface LearningProgress {
  readonly version: 1; readonly generation: number; readonly bindingFingerprint: string;
  readonly cursor: string; readonly offset: number;
}

/** Learning observes the existing write Owners and never grants a new tool or caller permission. */
export class PartnerLearningManager {
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #controllers = new Set<AbortController>();
  #disposed = false;

  constructor(readonly options: PartnerLearningManagerOptions) {}

  #owner(source: PartnerLearningTurnSource, partnerId?: string, canonical = false, association = false) {
    if (this.#disposed) throw new Error("Learning owner is unavailable.");
    const { store, profiles, partners } = this.options;
    const session = store.getSession(source.sessionId).descriptor;
    const target = store.getTarget(source.targetId);
    const link = profiles.getSessionLink(source.sessionId);
    if (!link || link.role !== "canonical" && link.role !== "history" && link.role !== "topic" && link.role !== 'channel' && link.role !== 'routine'
      || canonical && link.role !== "canonical" && link.role !== "topic" && link.role !== 'channel' && link.role !== 'routine'
      || partnerId !== undefined && link.partnerId !== partnerId) throw new Error("Learning source is unavailable.");
    const profile = partners.getPartner(link.partnerId);
    const queue = store.getQueueItem(source.sourceQueueItemId);
    if (queue.body.messagingOrigin && (!queue.body.messagingOrigin.isOwner || queue.body.messagingOrigin.partnerId !== profile.id)) throw new Error('Only the original owner message can be learned.');
    if (queue.body.messagingOrigin) {
      if (!this.options.assertMessagingSource) throw new Error('The owner message authority is unavailable.');
      this.options.assertMessagingSource(queue);
    }
    if (link.role === 'channel' && !queue.body.messagingOrigin) throw new Error('Channel learning requires its original owner message.');
    const operation = store.getOperation(queue.operationId);
    const operationBody = operation.body !== null && typeof operation.body === "object"
      ? operation.body as Readonly<Record<string, unknown>> : undefined;
    if (operationBody?.["partnerPrivateOrigin"] !== undefined || profile.lifecycle === "deleted" || !association && (profile.lifecycle !== "active"
      || profile.initializationState !== "ready" || profile.pauseCleanupPending
      || partners.listPendingRestarts().some(item => item.partnerId === profile.id))
      || profile.homeTargetId !== source.targetId || canonical && link.role === "canonical" && profile.canonicalSessionId !== source.sessionId
      || !association && session.archived || session.deletedAt !== undefined || !target.descriptor.trusted
      || session.remoteWorkspace !== undefined || target.descriptor.remoteWorkspace !== undefined
      || session.targetId !== source.targetId || session.backendId !== source.backendId
      || session.binding.generation !== source.bindingGeneration
      || store.getBackend(source.backendId).descriptor.instanceGeneration !== source.backendInstanceGeneration) {
      throw new Error("Learning source changed.");
    }
    return { profile, session, target };
  }

  captureSource(source: PartnerLearningTurnSource): boolean {
    try {
      const owner = this.#owner(source);
      this.options.store.registerPartnerLearningTurn(source, owner.profile.id);
      return true;
    } catch { return false; }
  }

  captureSave(source: PartnerLearningTurnSource): PartnerLearningSaveCapture | undefined {
    try {
      const turn = this.options.store.getPartnerLearningTurn(source.occurrenceId);
      if (!turn || !sameSource(turn.source, source)) return undefined;
      this.#owner(turn.source, turn.partnerId);
      return this.#saveCapture(turn);
    } catch { return undefined; }
  }

  #saveCapture(turn: PartnerLearningTurnRecord): PartnerLearningSaveCapture {
    return Object.freeze({ recordSaved: (store: OperationalStore, receipt: PartnerLearningReceipt): void => {
      if (store !== this.options.store) throw new Error("Learning write uses another Store.");
      this.#owner(turn.source, turn.partnerId);
      store.addPartnerLearningReceipt(turn.source.occurrenceId, { ...receipt,
        title: receipt.title.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim() });
    } });
  }

  accepted(occurrenceId: string): void {
    try {
      const turn = this.options.store.getPartnerLearningTurn(occurrenceId);
      if (!turn) return;
      this.#owner(turn.source, turn.partnerId, false, true);
      this.options.store.acceptPartnerLearningTurn(occurrenceId);
    } catch { /* The original input acceptance remains owned by the Host. */ }
  }

  sealed(occurrenceId: string, completionEventId: string): void {
    try {
      const turn = this.options.store.getPartnerLearningTurn(occurrenceId);
      if (!turn) return;
      this.#owner(turn.source, turn.partnerId, false, true);
      this.options.store.sealPartnerLearningTurn(occurrenceId, completionEventId);
    } catch { /* A retired source never moves its receipts to another reply. */ }
  }

  settled(occurrenceId: string, completionEventId: string, outcome: "completed" | "aborted" | "failed"): void {
    if (this.#disposed || outcome !== "completed") return;
    try {
      const original = this.options.store.getPartnerLearningTurn(occurrenceId);
      if (!original || original.completionEventId !== completionEventId) return;
      this.#owner(original.source, original.partnerId, true);
      const turn = this.options.store.claimPartnerLearningReview(completionEventId);
      if (!turn) return;
      const controller = new AbortController(); this.#controllers.add(controller);
      const previous = this.#jobs.get(turn.partnerId) ?? Promise.resolve();
      const job = previous.catch(() => {}).then(() => this.#review(turn, controller.signal)).catch(() => {}).finally(() => {
        this.#controllers.delete(controller);
        if (this.#jobs.get(turn.partnerId) === job) this.#jobs.delete(turn.partnerId);
      });
      this.#jobs.set(turn.partnerId, job);
    } catch { /* A successful product turn is independent of optional learning. */ }
  }

  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  /** A service shutdown and owning checks can wait for the already scheduled work without replaying it. */
  async drain(): Promise<void> { await Promise.allSettled([...this.#jobs.values()]); }

  async #review(turn: PartnerLearningTurnRecord, signal: AbortSignal): Promise<void> {
    const { store, memory, skills, auxiliary } = this.options;
    if (!turn.completionEventId) return;
    const owner = this.#owner(turn.source, turn.partnerId, true);
    const completionEventId = turn.completionEventId;
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      const latest = this.#owner(turn.source, turn.partnerId, true);
      if (latest.profile.revision !== owner.profile.revision || latest.target.revision !== owner.target.revision
        || latest.session.binding.opaqueRef !== owner.session.binding.opaqueRef
        || store.findVisibleSessionMessageOrigin({ sessionId: turn.source.sessionId, eventId: completionEventId }) === undefined) {
        throw new Error("Learning review owner changed.");
      }
    };
    const current = (): boolean => { try { assertCurrent(); return true; } catch { return false; } };
    assertCurrent();
    const currentMessages = await this.#messages(turn, assertCurrent);
    const backfill = await this.#backfill(turn, assertCurrent);
    const seenMessages = new Set<string>();
    const messages = [...currentMessages, ...backfill.messages].filter(message => {
      const identity = JSON.stringify(message); if (seenMessages.has(identity)) return false; seenMessages.add(identity); return true;
    }).sort((left, right) => {
      const a = store.findEvent(left.id)?.globalCursor ?? 0n, b = store.findEvent(right.id)?.globalCursor ?? 0n;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    if (!messages.some(message => message.role === "user")) return;
    const memories = memory.enabledForTarget(owner.profile.homeTargetId)
      ? memory.list(owner.profile.homeTargetId).filter((entry): entry is MakerMemoryEntry & { kind: Exclude<MakerMemoryEntry["kind"], "digest"> } => entry.kind !== "digest") : [];
    const memoryRecords = memories.map(entry => ({ id: entry.id, name: entry.slug, type: entry.kind,
      title: entry.title, description: entry.description, body: entry.body }));
    const memorySnapshot = partnerLearningSnapshotBudget(memoryRecords.filter(entry => entry.body.length <= 12_000), 24_000);
    const skillSnapshot = await skills.readLearningSnapshot(turn.partnerId, signal, assertCurrent);
    if (!skillSnapshot) return;
    assertCurrent();
    const memoryIndex = memories.map(entry => ({ name: entry.slug, type: entry.kind, title: entry.title }));
    const skillIndex = skillSnapshot.catalog.map(entry => ({ slug: entry.slug, name: entry.title,
      description: entry.description, enabled: entry.enabled }));
    if (JSON.stringify({ memoryIndex, skillIndex }).length > 24_000) return;
    const planOwner = auxiliary.capture();
    const result = await auxiliary.run(planOwner, { system: partnerLearningReviewInstructions,
      user: JSON.stringify({ messages, memoryEnabled: memory.enabledForTarget(owner.profile.homeTargetId), memoryIndex,
        memories: memorySnapshot.map(({ id: _id, ...entry }) => entry), skillIndex,
        skills: skillSnapshot.bodies.map(entry => ({ slug: entry.slug, title: entry.title, description: entry.description, body: entry.body })) }),
      maxTokens: 6_000, timeoutMs: 45_000, signal, stillCurrent: current,
      validate: raw => parsePartnerLearningReviewPlan(raw) === undefined ? undefined : raw });
    if (result.status !== "ok" || !current()) return;
    const plan = parsePartnerLearningReviewPlan(result.text);
    if (!plan) return;
    const learningSave = this.#saveCapture(turn);
    let memorySaved = false, skillSaved = false;
    try {
      for (const proposal of plan.memories) {
        if (!current()) return;
        if (!memory.enabledForTarget(owner.profile.homeTargetId)) break;
        if (!hasPartnerLearningEvidence(proposal, messages, true) || Buffer.byteLength(proposal.body.trim()) > 8_192) continue;
        const prior = memories.find(entry => entry.kind === proposal.type && entry.slug === proposal.name);
        if (prior && !memorySnapshot.some(entry => entry.id === prior.id) || prior?.body === proposal.body) continue;
        try {
          store.transaction(() => {
            assertCurrent();
            if (!memory.enabledForTarget(owner.profile.homeTargetId)) throw new Error("Memory is disabled.");
            const latest = store.findMakerMemoryEntry(owner.profile.homeTargetId, proposal.type, proposal.name);
            if (prior ? latest?.id !== prior.id || latest.revision !== prior.revision : latest !== undefined) {
              throw new Error("Memory changed.");
            }
            memory.write(owner.profile.homeTargetId, { kind: proposal.type, name: proposal.name, title: proposal.title,
              description: proposal.description, body: proposal.body, mode: prior ? "update" : "create" },
              (transactionStore, saved, created) => learningSave.recordSaved(transactionStore,
                { kind: "memory", entryId: saved.id, title: saved.title, action: created ? "created" : "updated" }));
          });
          memorySaved = true;
        } catch { /* Concurrent edits and original validation win over a proposal. */ }
      }
      for (const proposal of plan.skills) {
        if (!current()) return;
        if (!hasPartnerLearningEvidence(proposal, messages, false)) continue;
        const prior = skillSnapshot.catalog.find(entry => entry.slug === proposal.slug);
        const snapshot = skillSnapshot.bodies.find(entry => entry.slug === proposal.slug);
        if (prior && (!snapshot || !prior.enabled) || snapshot?.body === proposal.body) continue;
        try {
          await skills.saveLearningProposal(turn.partnerId, { slug: proposal.slug, title: proposal.title,
            description: proposal.description, body: proposal.body, expectedPartnerRevision: owner.profile.revision,
            ...(prior === undefined ? {} : { prior }) }, signal, assertCurrent, learningSave);
          skillSaved = true;
        } catch { /* Failed saves never create feedback. */ }
      }
    } finally {
      if (memorySaved) memory.requestEntriesRefresh();
      if (skillSaved && current()) skills.requestRefresh?.(turn.source.sessionId);
      // Each conversation owns its own coverage. A topic can never move the canonical cursor.
      if (current()) store.setSetting("session", turn.source.sessionId, "partner.learning.progress.v1", backfill.progress);
    }
  }

  async #backfill(turn: PartnerLearningTurnRecord, assertCurrent: () => void): Promise<{ readonly messages: readonly PartnerLearningReviewMessage[]; readonly progress: LearningProgress }> {
    const store = this.options.store, completion = store.findEvent(turn.completionEventId!)!;
    let progress = store.findSetting<LearningProgress>("session", turn.source.sessionId, "partner.learning.progress.v1")?.value;
    if (progress && (progress.version !== 1 || progress.generation !== turn.source.bindingGeneration
      || progress.bindingFingerprint !== turn.source.bindingFingerprint || !/^\d{1,20}$/u.test(progress.cursor)
      || !Number.isSafeInteger(progress.offset) || progress.offset < 0 || BigInt(progress.cursor) > completion.globalCursor)) progress = undefined;
    if (!progress) {
      // Enabling topic learning starts at the prior completed reply, rather than scanning old history.
      let before = completion.globalCursor, boundary = 0n;
      for (;;) {
        assertCurrent(); const page = store.listEvents({ sessionId: turn.source.sessionId, beforeCursor: before, order: "desc", limit: 1000, activeNativeTimeline: true });
        const previous = page.find(event => event.generation === turn.source.bindingGeneration && event.payload.type === "message_complete"
          && event.payload.role === "assistant" && event.runId !== turn.source.sourceRunId
          && event.runId !== undefined && store.findRun(event.runId)?.descriptor.state === "completed");
        if (previous) { boundary = previous.globalCursor; break; }
        if (page.length === 0) break;
        const next = page.at(-1)!.globalCursor; if (next >= before) break; before = next; await new Promise<void>(resolve => setImmediate(resolve));
      }
      progress = { version: 1, generation: turn.source.bindingGeneration, bindingFingerprint: turn.source.bindingFingerprint, cursor: boundary.toString(), offset: 0 };
      assertCurrent(); store.setSetting("session", turn.source.sessionId, "partner.learning.progress.v1", progress);
    }
    const messages: PartnerLearningReviewMessage[] = []; let remaining = 16_000;
    let cursor = BigInt(progress.cursor), offset = progress.offset, stop = false;
    while (!stop && (cursor < completion.globalCursor || offset > 0)) {
      assertCurrent(); const page = store.listEvents({ sessionId: turn.source.sessionId,
        afterCursor: offset > 0 && cursor > 0n ? cursor - 1n : cursor, order: "asc", limit: 1000, activeNativeTimeline: true });
      if (page.length === 0) break;
      for (const event of page) {
        if (event.globalCursor > completion.globalCursor) { stop = true; break; }
        const record = event.generation === turn.source.bindingGeneration && event.targetId === turn.source.targetId
          && event.backendId === turn.source.backendId ? this.#reviewMessage(event, false) : undefined;
        if (record && record.message.text) {
          let start = event.globalCursor === cursor ? offset : 0;
          while (start < record.message.text.length) {
            const message = { ...record.message, text: record.message.text.slice(start, start + 6000) }, cost = JSON.stringify(message).length;
            if (cost > remaining || messages.length >= 40) { cursor = start > 0 ? event.globalCursor : event.globalCursor - 1n; offset = start; stop = true; break; }
            messages.push(message); remaining -= cost;
            if (start + 6000 >= record.message.text.length) { start = record.message.text.length; break; }
            start += 5800;
          }
          if (stop) break;
        }
        cursor = event.globalCursor; offset = 0;
        if (cursor === completion.globalCursor) { stop = true; break; }
      }
      if (!stop) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return { messages, progress: { ...progress, cursor: cursor.toString(), offset } };
  }

  async #messages(turn: PartnerLearningTurnRecord, assertCurrent: () => void): Promise<PartnerLearningReviewMessage[]> {
    const store = this.options.store, completed = store.findEvent(turn.completionEventId!);
    if (!completed || completed.payload.type !== "message_complete" || completed.payload.role !== "assistant") return [];
    const users: OrderedMessage[] = [], others: OrderedMessage[] = [], seen = new Set<string>();
    let before = completed.globalCursor + 1n, foundBoundary = false;
    while (!foundBoundary) {
      assertCurrent();
      const page = store.listEvents({ sessionId: turn.source.sessionId, beforeCursor: before, order: "desc", limit: 1_000,
        activeNativeTimeline: true });
      if (page.length === 0) break;
      for (const event of page) {
        if (event.generation !== turn.source.bindingGeneration || event.backendId !== turn.source.backendId
          || event.targetId !== turn.source.targetId) continue;
        const record = this.#reviewMessage(event);
        if (record && !seen.has(record.identity)) {
          seen.add(record.identity);
          const group = record.message.role === "user" ? users : others;
          if (group.length < 80) group.push({ ...record.message, cursor: event.globalCursor });
        }
        if (event.payload.type === "message_complete" && event.payload.role === "user"
          && event.runId === turn.source.sourceRunId && event.payload.acceptedInput !== undefined) {
          if (event.payload.partnerPrivateOrigin !== undefined || event.payload.automaticContinuation !== undefined
            || event.payload.objectiveContinuation !== undefined || event.payload.inputHandoffContinuation !== undefined) return [];
          foundBoundary = true; break;
        }
      }
      const next = page.at(-1)!.globalCursor;
      if (next >= before) break;
      before = next;
      if (!foundBoundary) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!foundBoundary) return [];
    const selected = partnerLearningSnapshotBudget([...users, ...others].slice(0, 80).map(({ cursor, ...message }) =>
      ({ cursor: cursor.toString(), ...message })), 40_000);
    return selected.sort((a, b) => BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1).map(({ cursor: _cursor, ...message }) => message);
  }

  #reviewMessage(event: PersistedEvent, clip = true) {
    const queue = event.sessionId && event.runId ? this.options.store.findQueueItemByRunId(event.sessionId, event.runId) : undefined;
    const origin = queue?.body.messagingOrigin;
    if (origin) {
      if (!origin.isOwner) return undefined;
      const record = reviewMessage(event, clip);
      // The actual owner utterance is evidence. Group history, quotes and
      // other speakers appended to the model prompt are not owner evidence.
      if (record && record.message.role === 'user') return { ...record, message: { ...record.message,
        text: origin.userText.slice(0, clip ? 6000 : undefined) } };
      return record;
    }
    if (event.sessionId && this.options.profiles.getSessionLink(event.sessionId)?.role === 'channel') return undefined;
    return reviewMessage(event, clip);
  }
}

function sameSource(left: PartnerLearningTurnSource, right: PartnerLearningTurnSource): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => right[key as keyof PartnerLearningTurnSource] === value);
}

function reviewMessage(event: PersistedEvent, clip = true): { readonly identity: string; readonly message: PartnerLearningReviewMessage } | undefined {
  const payload = event.payload;
  if (payload.type === "message_complete") {
    if (payload.partnerPrivateOrigin !== undefined || payload.automaticContinuation !== undefined || payload.objectiveContinuation !== undefined || payload.inputHandoffContinuation !== undefined
      || payload.role === "user" && payload.acceptedInput === undefined) return undefined;
    return { identity: `${payload.role}:${payload.nativeHistory?.identity?.entryId ?? event.id}`,
      message: { id: event.id, role: payload.role, text: payload.blocks.flatMap(block => block.kind === "text" ? [block.text] : []).join("\n").slice(0, clip ? 6000 : undefined) } };
  }
  if (payload.type !== "tool_start" && payload.type !== "tool_result") return undefined;
  if (payload.type === "tool_result" && payload.isError) return undefined;
  return { identity: `${payload.type}:${payload.nativeHistory?.identity?.entryId ?? payload.callId}`,
    message: { id: event.id, role: payload.type === "tool_start" ? "tool_use" : "tool_result",
      text: (payload.type === "tool_start" ? payload.input : payload.output).slice(0, clip ? 6000 : undefined) } };
}
