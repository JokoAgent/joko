import { RunState, SessionWorkingStatusProjection, hasPublicWorkingSubject, workingStatusTurnKey,
  type Session, type Run, type Interaction, type SessionWorkingStatus, type WorkingPhase } from "@joko/contracts";
import type { OperationalStore, PersistedEvent } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import type { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import { toProtoEvent, toProtoInteraction, toProtoRun, toProtoSession } from "./proto-mapper.js";
import { WorkingStatusCopy, WORKING_STATUS_COPY_INSTRUCTIONS, workingStatusPrompt, validateWorkingStatusCopy } from "./working-status-copy.js";

interface WorkingFacts {
  readonly session: Session;
  readonly runs: readonly Run[];
  readonly interactions: readonly Interaction[];
  readonly startedAt?: number;
}
interface TurnEntry {
  readonly partnerId: string;
  readonly scope: string;
  readonly projection: SessionWorkingStatusProjection;
  cursor: bigint;
  readonly copies: Map<string, { readonly scope: string; readonly copy: WorkingStatusCopy }>;
}
interface PartnerWorkingStatusOptions {
  readonly store: OperationalStore;
  readonly partners: Pick<PartnerManager, "canonicalCaller" | "getPartner" | "listSessions">;
  readonly auxiliary: Pick<AuxiliaryTextRouting, "capture" | "isCurrent" | "run">;
}

/** Read-only, service-owned facts and optional captions. No agent turn, Event or durable caption copy. */
export class PartnerWorkingStatusManager {
  readonly #options: PartnerWorkingStatusOptions;
  readonly #turns = new Map<string, TurnEntry>();
  #unsubscribe?: () => void;
  #disposed = false;

  constructor(options: PartnerWorkingStatusOptions) { this.#options = options; }

  start(): void {
    if (this.#disposed || this.#unsubscribe) return;
    this.#unsubscribe = this.#options.store.subscribe((event) => this.#observe(event));
  }

  dispose(): void {
    this.#disposed = true; this.#unsubscribe?.(); this.#unsubscribe = undefined;
    for (const entry of this.#turns.values()) this.#retire(entry);
    this.#turns.clear();
  }

  status(partnerId: string): SessionWorkingStatus | undefined {
    if (this.#disposed) return undefined;
    let sessionId: string | undefined;
    try { sessionId = this.#options.partners.getPartner(partnerId).canonicalSessionId; } catch { return undefined; }
    if (!sessionId) return undefined;
    const facts = this.#facts(partnerId, sessionId);
    let entry = this.#turns.get(sessionId);
    if (!facts) { if (entry) { this.#retire(entry); this.#turns.delete(sessionId); } return undefined; }
    const run = facts.runs.find((run) => [RunState.DISPATCHING, RunState.DISPATCH_UNKNOWN, RunState.RUNNING, RunState.WAITING, RunState.RETRYING]
      .includes(run.state) && run.version?.generation === facts.session.version?.generation);
    const identity = { sessionId, targetId: facts.session.targetId, backendId: facts.session.backendId,
      generation: facts.session.version?.generation ?? 0n, runId: run?.runId ?? "", attemptId: run?.activeAttemptId ?? "" };
    const scope = JSON.stringify([partnerId, workingStatusTurnKey(identity)]);
    if (!entry || entry.scope !== scope) {
      if (entry) this.#retire(entry);
      entry = { partnerId, scope, projection: new SessionWorkingStatusProjection(facts.session, run), cursor: 0n, copies: new Map() };
      this.#turns.set(sessionId, entry);
    }
    // Replay every page of this turn after restart; never substitute a user's historical window.
    for (;;) {
      const page = this.#options.store.listEvents({ sessionId, afterCursor: entry.cursor, limit: 1000,
        ...(facts.startedAt === undefined ? {} : { emittedFrom: facts.startedAt }) });
      for (const event of page) { this.#observeFact(entry, event); entry.cursor = event.globalCursor; }
      if (page.length < 1000) break;
    }
    const status = entry.projection.read(facts.session, facts.runs, facts.interactions);
    for (const [locale, localized] of entry.copies) {
      const planScope = this.#options.auxiliary.capture();
      if (localized.scope !== planScope.runtimeRevision) { localized.copy.dispose(); entry.copies.delete(locale); }
      else localized.copy.observe(status && hasPublicWorkingSubject(status.phase) ? status.phase : null);
    }
    if (!status && !run) { this.#retire(entry); this.#turns.delete(sessionId); }
    return status;
  }

  async readCaption(partnerId: string, expected: SessionWorkingStatus, locale: string): Promise<(SessionWorkingStatus & { readonly caption: string }) | undefined> {
    const current = this.status(partnerId);
    if (!current || !sameStatus(current, expected)) return undefined;
    if (!hasPublicWorkingSubject(current.phase)) return { ...current, caption: "" };
    if (!["en", "zh-CN", "zh-TW", "ja", "ko"].includes(locale)) throw new RangeError("Working caption language is invalid.");
    const entry = this.#turns.get(current.sessionId)!;
    const plan = this.#options.auxiliary.capture();
    let localized = entry.copies.get(locale);
    if (localized?.scope !== plan.runtimeRevision) { localized?.copy.dispose(); localized = undefined; }
    if (!localized) {
      const eligible = (phase: WorkingPhase): boolean => {
        const active = this.status(partnerId);
        return !this.#disposed && this.#options.auxiliary.isCurrent(plan) && this.#turns.get(current.sessionId) === entry
          && active !== undefined && active.phase === phase && workingStatusTurnKey(active) === workingStatusTurnKey(current);
      };
      localized = { scope: plan.runtimeRevision, copy: new WorkingStatusCopy(async (phase, previous, signal) => {
        if (signal.aborted || !eligible(phase)) return null;
        const result = await this.#options.auxiliary.run(plan, {
          system: WORKING_STATUS_COPY_INSTRUCTIONS, user: workingStatusPrompt(phase, locale, previous), maxTokens: 96, timeoutMs: 20_000,
          signal, stillCurrent: () => eligible(phase), validate: (raw) => validateWorkingStatusCopy(raw, phase) ?? undefined
        });
        return !signal.aborted && eligible(phase) && result.status === "ok" ? validateWorkingStatusCopy(result.text, phase) : null;
      }) };
      entry.copies.set(locale, localized);
    }
    const caption = await localized.copy.request(current.phase);
    const after = this.status(partnerId);
    return after && sameStatus(after, expected) && this.#turns.get(current.sessionId) === entry
      && this.#options.auxiliary.isCurrent(plan) ? { ...after, caption: caption ?? "" } : undefined;
  }

  #facts(partnerId: string, sessionId: string): WorkingFacts | undefined {
    try {
      const owner = this.#options.partners.canonicalCaller(sessionId);
      if (owner.id !== partnerId) return undefined;
      const links = this.#options.partners.listSessions(partnerId).filter((view) => view.link.role === "canonical" && view.link.sessionId === sessionId);
      if (links.length !== 1 || !links[0]!.available || links[0]!.readOnly) return undefined;
      const record = this.#options.store.getSession(sessionId);
      const runs = this.#options.store.listRuns({ sessionId, activeOnly: true }).map((run) => toProtoRun(run, {
        targetId: record.descriptor.targetId, backendId: record.descriptor.backendId,
        attempts: this.#options.store.listAttempts(run.descriptor.id)
      }));
      const current = this.#options.store.findLatestRunForSessionGeneration(sessionId, record.descriptor.binding.generation);
      const session = toProtoSession(record, { ...(current === undefined ? {} : { activeRun: current }) });
      const interactions = this.#options.store.listInteractions({ sessionId, status: "open" }).map((value) => toProtoInteraction(value,
        { targetId: record.descriptor.targetId, backendId: record.descriptor.backendId }));
      return { session, runs, interactions, ...(current === undefined ? {} : { startedAt: current.descriptor.createdAt }) };
    } catch { return undefined; }
  }

  #observe(event: PersistedEvent): void {
    for (const [sessionId, entry] of this.#turns) {
      if (event.sessionId === sessionId) { this.#observeFact(entry, event); entry.cursor = event.globalCursor; }
      // Profile/session/route changes also revoke eligibility; status() cancels before publication is consumed.
      this.status(entry.partnerId);
    }
  }
  #retire(entry: TurnEntry): void { for (const localized of entry.copies.values()) localized.copy.dispose(); entry.copies.clear(); }
  #observeFact(entry: TurnEntry, event: PersistedEvent): void {
    if (event.payload.type === "done") {
      entry.projection.end({ sessionId: event.sessionId, targetId: event.targetId, backendId: event.backendId,
        generation: BigInt(event.generation), runId: event.runId ?? "", attemptId: event.attemptId ?? "" });
      return;
    }
    // Other projections require their own owning context and do not carry working facts.
    if (["text_delta", "message_complete", "tool_start", "tool_update", "tool_result", "compaction", "retry", "error"]
      .includes(event.payload.type)) entry.projection.observe(toProtoEvent(event));
  }
}

function sameStatus(a: SessionWorkingStatus, b: SessionWorkingStatus): boolean {
  return a.phase === b.phase && workingStatusTurnKey(a) === workingStatusTurnKey(b);
}
