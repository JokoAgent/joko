import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  PARTNER_GROUP_ATTACHMENTS_MAX, PARTNER_GROUP_MESSAGE_MAX_CHARS, PARTNER_GROUP_REPLY_MAX_CHARS,
  PARTNER_GROUP_TURN_ATTACHMENTS_MAX, isPartnerGroupNoReplyText,
  type PartnerGroupAttachment, type PartnerGroupChange, type PartnerGroupDetail, type PartnerGroupLane,
  type PartnerGroupMember, type PartnerGroupMention, type PartnerGroupMessage, type PartnerGroupNoticeCode,
  type PartnerGroupPlan, type PartnerGroupRecord, type PartnerGroupSpeaker, type PartnerGroupSummary
} from "@joko/core";
import { PartnerGroupStore, type PartnerProfileRecord } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import { buildMemberTurnPrompt, clampGroupText, resolveGroupMentions, rotateResponders } from "./partner-group-discussion.js";
import { buildPlanStepBrief, type PlanDecision, type PlanDecisionInput } from "./partner-group-division.js";

export class PartnerGroupError extends Error {
  constructor(readonly code: "invalid" | "changed" | "unavailable" | "plan_open" | "plan_closed", message: string) {
    super(message); this.name = "PartnerGroupError";
  }
}

export interface PartnerGroupSession {
  readonly sessionId: string;
  /** Exact Profile, Session/native binding, Target and runtime instance fence. */
  readonly assertCurrent: () => void;
}
export interface PartnerGroupTurnResult {
  readonly status: "completed" | "failed" | "cancelled" | "unknown";
  readonly text: string;
  readonly failure?: "workdir-unavailable";
  /** Local-only terminal signals. The room receives a fixed public category. */
  readonly error?: unknown;
}
export interface PartnerGroupRuntime {
  /** Retire interrupted inputs before they can resume through the ordinary Queue startup. */
  recover(lanes: readonly PartnerGroupLane[]): Promise<void>;
  ensureLane(input: { readonly group: PartnerGroupRecord; readonly partner: PartnerProfileRecord; readonly plan?: PartnerGroupPlan;
    readonly signal: AbortSignal; readonly assertCurrent: () => void }): Promise<PartnerGroupSession>;
  execute(input: { readonly lane: PartnerGroupSession; readonly clientId: string; readonly prompt: string;
    readonly attachments: readonly PartnerGroupAttachment[]; readonly signal: AbortSignal; readonly onAccepted: () => void }): Promise<PartnerGroupTurnResult>;
  /** Stops only inputs owned by this group lane and returns confirmed quiescence. */
  stop(sessionId: string): Promise<boolean>;
  archive(lane: PartnerGroupLane): Promise<void>;
  hasPendingInteraction(sessionId: string): boolean;
}
export interface PartnerGroupWorkDirectories {
  validateProject(path: string): Promise<string>;
  /** Reuses the exact saved plan directory/worktree; never falls back to Home or a checkout. */
  prepare(group: PartnerGroupRecord, plan: PartnerGroupPlan, assertCurrent: () => void): Promise<{ readonly path: string; readonly branch: string | null }>;
  snapshot(path: string): Promise<ReadonlyMap<string, string>>;
  changedFiles(path: string, before: ReadonlyMap<string, string>): Promise<readonly string[]>;
  trashGroup(groupId: string): Promise<void>;
}
export interface PartnerGroupAttachmentOwner {
  prepare(input: { readonly groupId: string; readonly clientId: string; readonly attachments: readonly PartnerGroupAttachment[];
    readonly deviceId: string; readonly assertCurrent: () => void }): Promise<{
      readonly attachments: readonly PartnerGroupAttachment[]; readonly commit: () => Promise<void>; readonly discard: () => Promise<void>;
    }>;
}
interface Member extends PartnerGroupMember { readonly profile?: PartnerProfileRecord; }
interface Round {
  readonly id: string; readonly abort: AbortController; readonly responders: readonly string[];
  readonly speakers: Map<string, string | null>; readonly dropped: Set<string>;
}
interface Planning { readonly id: string; readonly partnerId: string; readonly abort: AbortController; }
interface Note { readonly text: string; readonly attachments: readonly PartnerGroupAttachment[]; }
interface Step {
  readonly planId: string; readonly position: number; readonly partnerId: string; readonly abort: AbortController;
  readonly notes: Note[]; sessionId: string | null;
}
interface GroupRuntimeState {
  tail: Promise<unknown>; round: Round | null; planning: Planning | null; step: Step | null;
  carried: { readonly planId: string; readonly position: number; readonly notes: readonly Note[] } | null;
}
type Outcome = { readonly kind: "reply"; readonly text: string } | { readonly kind: "silent" | "cancelled" }
  | { readonly kind: "failed"; readonly notice: PartnerGroupNoticeCode };

/** Group messages and plans remain independent of their hidden execution Sessions. */
export class PartnerGroupManager {
  readonly #states = new Map<string, GroupRuntimeState>();
  readonly #flights = new Set<Promise<unknown>>();
  readonly #interrupted = new Set<string>();
  readonly #blocked = new Set<string>();
  #started = false;
  #closed = false;
  constructor(readonly options: {
    readonly storage: PartnerGroupStore;
    readonly partners: Pick<PartnerManager, "getPartner" | "listPartners">;
    readonly runtime: PartnerGroupRuntime;
    readonly work: PartnerGroupWorkDirectories;
    readonly attachments: PartnerGroupAttachmentOwner;
    readonly decidePlan: (input: PlanDecisionInput, signal: AbortSignal, isCurrent: () => boolean) => Promise<PlanDecision | null>;
    /** The composition persists the body-free change Event before publishing it. */
    readonly changed: (groupId: string, change: PartnerGroupChange) => void;
    readonly notifyStep: (group: PartnerGroupRecord, plan: PartnerGroupPlan) => Promise<void>;
    readonly now?: () => number;
    readonly id?: () => string;
    readonly turnTimeoutMs?: number;
    readonly stepTimeoutMs?: number;
  }) {}
  async start(): Promise<void> {
    await this.options.runtime.recover(this.options.storage.lanes());
    this.options.storage.recoverInterruptedPlans(); this.#started = true;
    for (const group of this.options.storage.list()) if (group.lifecycle === "deleting") await this.#finishDelete(group.id);
  }
  #id(): string { return (this.options.id ?? randomUUID)(); }
  #now(): number { return (this.options.now ?? Date.now)(); }
  #assertStarted(): void { if (!this.#started || this.#closed) unavailable(); }
  #state(groupId: string): GroupRuntimeState {
    let state = this.#states.get(groupId);
    if (!state) { state = { tail: Promise.resolve(), round: null, planning: null, step: null, carried: null }; this.#states.set(groupId, state); }
    return state;
  }
  #serial<T>(groupId: string, action: () => Promise<T>): Promise<T> {
    this.#assertStarted(); const state = this.#state(groupId), next = state.tail.then(action, action);
    state.tail = next.catch(() => undefined); return next;
  }
  #launch(action: Promise<unknown>): void {
    this.#flights.add(action); void action.catch(() => undefined).finally(() => this.#flights.delete(action));
  }
  #emit(groupId: string, change: PartnerGroupChange): void { if (!this.#closed) this.options.changed(groupId, change); }
  #members(group: PartnerGroupRecord): Member[] {
    return group.memberIds.map(partnerId => {
      try {
        const profile = this.options.partners.getPartner(partnerId);
        const status = profile.lifecycle === "deleted" ? "deleting" : profile.initializationState === "error" ? "error" : profile.lifecycle;
        return { partnerId, name: profile.displayName, status, profile };
      } catch { return { partnerId, name: partnerId, status: "missing" as const }; }
    });
  }
  #available(member: Member): member is Member & { readonly profile: PartnerProfileRecord } {
    return member.status === "active" && member.profile?.initializationState === "ready";
  }
  #visible(group: PartnerGroupRecord, controller: boolean): boolean {
    return !controller || this.#members(group).every(member => member.status !== "archived" && member.status !== "deleting" && member.status !== "missing");
  }
  #owner(groupId: string, expectedRevision?: number, assertRequest: () => void = () => undefined) {
    this.#assertStarted(); assertRequest(); const group = this.options.storage.get(groupId);
    if (group.lifecycle !== "active") unavailable();
    if (expectedRevision !== undefined && group.revision !== expectedRevision) changed();
    const identity = configIdentity(group);
    const assertCurrent = () => {
      this.#assertStarted(); assertRequest(); const current = this.options.storage.get(groupId);
      if (current.lifecycle !== "active" || configIdentity(current) !== identity) changed();
    };
    return { group, assertCurrent };
  }
  #speakers(groupId: string): PartnerGroupSpeaker[] {
    const state = this.#states.get(groupId), speakers: PartnerGroupSpeaker[] = [];
    for (const [partnerId, sessionId] of state?.round?.speakers ?? []) speakers.push({ partnerId, sessionId, activity: "reply" });
    if (state?.planning) speakers.push({ partnerId: state.planning.partnerId, sessionId: null, activity: "planning" });
    if (state?.step) speakers.push({ partnerId: state.step.partnerId, sessionId: state.step.sessionId, activity: "step" });
    return speakers;
  }
  #planView(plan: PartnerGroupPlan, controller: boolean): PartnerGroupPlan { return controller ? { ...plan, workDir: null } : plan; }
  #summary(group: PartnerGroupRecord, deviceId: string, controller: boolean): PartnerGroupSummary {
    const messages = this.options.storage.messages(group.id).messages, last = messages.at(-1);
    let lastReplyAt: number | null = null, lastReplySequence = 0, before: number | undefined;
    for (;;) {
      const page = before === undefined ? messages : this.options.storage.messages(group.id, { beforeSequence: before }).messages;
      const reply = [...page].reverse().find(message => message.authorKind === "partner" && message.kind === "message");
      if (reply) { lastReplyAt = reply.createdAt; lastReplySequence = reply.sequence; break; }
      if (page.length < 100) break; before = page[0]!.sequence;
    }
    const openPlan = this.options.storage.openPlan(group.id), members = this.#members(group).map(({ profile: _profile, ...member }) => member);
    return { id: group.id, revision: group.revision, lifecycle: group.lifecycle, name: group.name, replyMode: group.replyMode,
      speakingMode: group.speakingMode, organizerPartnerId: this.#organizer(group)?.partnerId ?? null,
      projectDir: controller ? null : group.projectDir, projectDirName: group.projectDir === null ? null : basename(group.projectDir), members,
      lastMessage: last ? { authorKind: last.authorKind, authorName: last.authorName, content: clampGroupText(last.content, 80), createdAt: last.createdAt } : null,
      lastReplyAt, unread: lastReplySequence > this.options.storage.readThrough(group.id, deviceId),
      planningPartnerId: this.#states.get(group.id)?.planning?.partnerId ?? null, speakers: this.#speakers(group.id),
      openPlan: openPlan ? this.#planView(openPlan, controller) : null, createdAt: group.createdAt, updatedAt: group.updatedAt };
  }
  list(deviceId: string, controller = false): { readonly revision: number; readonly groups: readonly PartnerGroupSummary[] } {
    this.#assertStarted(); return { revision: this.options.storage.directoryRevision(), groups: this.options.storage.list()
      .filter(group => this.#visible(group, controller)).map(group => this.#summary(group, deviceId, controller)) };
  }
  detail(groupId: string, deviceId: string, controller = false, beforeSequence?: number): PartnerGroupDetail {
    this.#assertStarted(); const group = this.options.storage.get(groupId); if (!this.#visible(group, controller)) unavailable();
    const page = this.options.storage.messages(groupId, beforeSequence === undefined ? {} : { beforeSequence });
    const state = this.#states.get(groupId), latest = this.options.storage.messages(groupId, { limit: 1 }).messages[0];
    const planIds = new Set(page.messages.flatMap(message => message.planId ? [message.planId] : []));
    const open = this.options.storage.openPlan(groupId); if (open) planIds.add(open.id);
    return { ...this.#summary(group, deviceId, controller), ...page, plans: [...planIds].map(id => this.#planView(this.options.storage.getPlan(id), controller)),
      round: { status: state?.round || state?.planning || state?.step ? "running" : "idle", speakers: this.#speakers(groupId),
        canContinue: !state?.round && !state?.planning && !state?.step && latest?.kind === "round-end" } };
  }
  markRead(groupId: string, deviceId: string, throughSequence: number): void {
    this.#assertStarted(); this.options.storage.markRead(groupId, deviceId, throughSequence); this.#emit(groupId, "read");
  }
  create(input: { readonly requestId: string; readonly expectedDirectoryRevision: number; readonly name: string; readonly memberIds: readonly string[] }) {
    this.#assertStarted(); this.#validateMembers(input.memberIds); const group = this.options.storage.create(input); this.#emit(group.id, "created"); return group;
  }
  creation(requestId: string) { this.#assertStarted(); return this.options.storage.creation(requestId); }
  async retireCreation(requestId: string, assertRequest: () => void) {
    this.#assertStarted(); assertRequest(); const receipt = this.options.storage.creation(requestId);
    if (receipt.group) {
      if (this.options.storage.latestSequence(receipt.group.id) > 0 || this.options.storage.plans(receipt.group.id).length > 0) return receipt;
      await this.delete(receipt.group.id, receipt.group.revision, assertRequest);
    }
    assertRequest(); return this.options.storage.retireCreation(requestId);
  }
  #validateMembers(ids: readonly string[]): void {
    for (const id of ids) { const profile = this.options.partners.getPartner(id); if (profile.lifecycle === "deleted" || profile.lifecycle === "archived") unavailable(); }
  }
  update(groupId: string, expectedRevision: number, patch: Parameters<PartnerGroupStore["update"]>[2], assertRequest: () => void, controller = false) {
    return this.#serial(groupId, async () => {
      const owner = this.#owner(groupId, expectedRevision, assertRequest);
      if (controller && patch.projectDir !== undefined) invalid();
      const normalized = patch.projectDir === undefined || patch.projectDir === null ? patch : { ...patch, projectDir: await this.options.work.validateProject(patch.projectDir) };
      owner.assertCurrent(); const group = this.options.storage.update(groupId, expectedRevision, normalized); this.#emit(groupId, "updated"); return group;
    });
  }
  setMembers(groupId: string, expectedRevision: number, ids: readonly string[], assertRequest: () => void) {
    return this.#serial(groupId, async () => {
      this.#owner(groupId, expectedRevision, assertRequest); this.#validateMembers(ids); await this.#cancelRound(groupId); assertRequest();
      const group = this.options.storage.setMembers(groupId, expectedRevision, ids); this.#cancelPlanning(groupId); this.#emit(groupId, "updated"); return group;
    });
  }
  #organizer(group: PartnerGroupRecord) {
    const members = this.#members(group).filter(member => this.#available(member));
    return members.find(member => member.partnerId === group.organizerPartnerId) ?? members[0];
  }
  async send(input: { readonly groupId: string; readonly expectedRevision: number; readonly clientId: string; readonly text: string;
    readonly mentions: PartnerGroupMention | null; readonly division: boolean; readonly attachments: readonly PartnerGroupAttachment[];
    readonly deviceId: string; readonly assertRequest: () => void }): Promise<PartnerGroupMessage> {
    this.#assertStarted(); input.assertRequest(); const initial = this.options.storage.get(input.groupId);
    if (initial.lifecycle !== "active") unavailable();
    const requestFingerprint = createHash("sha256").update(JSON.stringify([input.text.trim(), input.mentions, input.division, input.attachments])).digest("hex");
    const existing = this.options.storage.messageForClient(input.groupId, input.clientId, requestFingerprint); if (existing) return existing;
    const owner = this.#owner(input.groupId, input.expectedRevision, input.assertRequest);
    if (input.attachments.length > PARTNER_GROUP_ATTACHMENTS_MAX || !input.text.trim() && input.attachments.length === 0
      || Array.from(input.text).length > PARTNER_GROUP_MESSAGE_MAX_CHARS) invalid();
    const prepared = await this.options.attachments.prepare({ groupId: input.groupId, clientId: input.clientId,
      attachments: input.attachments, deviceId: input.deviceId, assertCurrent: owner.assertCurrent });
    let posted = false;
    try {
      return await this.#serial(input.groupId, async () => {
        owner.assertCurrent(); const group = this.options.storage.get(input.groupId), members = this.#members(group);
        const mentions = resolveGroupMentions(input.text, input.mentions, members), open = this.options.storage.openPlan(group.id);
        if (input.division && open && open.status !== "proposed") throw new PartnerGroupError("plan_open", "Finish or stop the open plan before requesting another.");
        const appended = this.options.storage.appendMessage(group.id, { clientId: input.clientId, requestFingerprint, kind: "message", authorKind: "user", authorPartnerId: null,
          authorName: "", content: input.text.trim(), mentions, noticeCode: null, planId: null, files: [], attachments: prepared.attachments });
        if (!appended.created) return appended.message;
        posted = true; await prepared.commit(); await this.#cancelRound(group.id); this.#cancelPlanning(group.id); this.#emit(group.id, "messages");
        const available = members.filter(member => this.#available(member));
        for (const id of mentions.partnerIds) {
          const member = members.find(member => member.partnerId === id); if (member && !this.#available(member)) this.#notice(group.id, member, "member-unavailable");
        }
        const responders = mentions.all ? available.map(member => member.partnerId) : mentions.partnerIds.length
          ? mentions.partnerIds.filter(id => available.some(member => member.partnerId === id)) : group.replyMode === "all" ? available.map(member => member.partnerId) : [];
        const chat = () => this.#startRound(group.id, responders, mentions, group.speakingMode === "auto" && responders.length > 1 && (mentions.all || mentions.partnerIds.length === 0));
        if (mentions.partnerIds.length && !input.division) chat();
        else if (input.division || open?.status === "proposed") this.#startPlanning(group.id, appended.message, input.division ? "forced" : "revise", open, null);
        else if (open?.status === "running") this.#state(group.id).step?.notes.push({ text: input.text, attachments: prepared.attachments });
        else if (open?.status === "waiting" && open.currentStep !== null) await this.#beginStep(open, open.currentStep,
          { kind: open.steps[open.currentStep]?.status === "failed" ? "retry" : "redo", notes: [{ text: input.text, attachments: prepared.attachments }] });
        else if (available.length >= 2) this.#startPlanning(group.id, appended.message, "auto", undefined, chat);
        else chat();
        return appended.message;
      });
    } finally { if (!posted) await prepared.discard(); }
  }
  #notice(groupId: string, member: Pick<Member, "partnerId" | "name">, notice: PartnerGroupNoticeCode): void {
    this.options.storage.appendMessage(groupId, { ...emptyMessage(), clientId: this.#id(), kind: "notice", authorKind: "system",
      authorPartnerId: member.partnerId, authorName: member.name, noticeCode: notice }); this.#emit(groupId, "messages");
  }
  async #cancelRound(groupId: string): Promise<void> {
    const state = this.#state(groupId), round = state.round; if (!round) return;
    round.abort.abort(); const sessions = [...round.speakers.values()].filter((id): id is string => id !== null);
    const results = await Promise.all(sessions.map(async sessionId => {
      const confirmed = await this.options.runtime.stop(sessionId).catch(() => false);
      if (!confirmed) this.#blocked.add(sessionId); else this.#blocked.delete(sessionId); return confirmed;
    }));
    if (results.some(value => !value)) unavailable("A group lane stop was not confirmed. Read the current state before retrying.");
    if (state.round === round) state.round = null; this.#emit(groupId, "round");
  }
  #cancelPlanning(groupId: string): void { const state = this.#state(groupId); state.planning?.abort.abort(); state.planning = null; }
  #startRound(groupId: string, responders: readonly string[], mentions: PartnerGroupMention, parallel: boolean): void {
    if (!responders.length) return;
    const state = this.#state(groupId), round: Round = { id: this.#id(), abort: new AbortController(), responders,
      speakers: new Map(), dropped: new Set() }; state.round = round; this.#emit(groupId, "round");
    this.#launch(this.#runRound(groupId, round, mentions, parallel));
  }
  async #runRound(groupId: string, round: Round, mentions: PartnerGroupMention, parallel: boolean): Promise<void> {
    const state = this.#state(groupId), live = () => !this.#closed && !round.abort.signal.aborted && state.round === round;
    let posted = 0;
    const takeTurn = async (partnerId: string, throughSequence?: number): Promise<boolean> => {
      if (!live() || posted >= 10 || round.dropped.has(partnerId)) return false;
      const group = this.options.storage.get(groupId), member = this.#members(group).find(member => member.partnerId === partnerId);
      if (!member || !this.#available(member)) return false;
      const outcome = await this.#memberTurn(group, member, round, mentions, live, throughSequence);
      round.speakers.delete(partnerId); if (!live()) return false;
      if (outcome.kind === "reply" && posted < 10) {
        posted++;
        this.options.storage.appendMessage(groupId, { ...emptyMessage(), clientId: `${round.id}:${this.#id()}`, authorKind: "partner", authorPartnerId: member.partnerId,
          authorName: member.name, content: clampGroupText(outcome.text, PARTNER_GROUP_REPLY_MAX_CHARS) }); this.#emit(groupId, "messages"); this.#emit(groupId, "round"); return true;
      }
      if (outcome.kind === "failed") { round.dropped.add(partnerId); this.#notice(groupId, member, outcome.notice); }
      this.#emit(groupId, "round"); return false;
    };
    try {
      for (let circle = 0; circle < (round.responders.length > 1 ? 3 : 1) && posted < 10 && live(); circle++) {
        const order = rotateResponders(round.responders, circle); let spoke = false;
        if (circle === 0 && parallel) {
          const through = this.options.storage.latestSequence(groupId);
          spoke = (await Promise.all(order.map(id => takeTurn(id, through)))).some(Boolean);
        } else for (const id of order) { if (!live() || posted >= 10) break; if (await takeTurn(id)) spoke = true; }
        if (!spoke) break;
      }
      if (live() && posted > 0) {
        const members = this.options.storage.get(groupId).memberIds;
        this.options.storage.appendMessage(groupId, { ...emptyMessage(), clientId: `${round.id}:end`, kind: "round-end", authorKind: "system",
          mentions: { all: false, partnerIds: round.responders.filter(id => members.includes(id)) } }); this.#emit(groupId, "messages");
      }
    } finally { if (state.round === round && round.speakers.size === 0) { state.round = null; this.#emit(groupId, "round"); } }
  }
  #delta(groupId: string, partnerId: string, through: number) {
    const seen = this.options.storage.memberships(groupId).find(member => member.partnerId === partnerId)?.lastSeenSequence;
    if (seen === undefined) unavailable();
    let before = through + 1, count = 0; const recent: PartnerGroupMessage[] = [], delivered = new Map<string, PartnerGroupAttachment>();
    for (;;) {
      const page = this.options.storage.messages(groupId, { beforeSequence: before, afterSequence: seen, throughSequence: through });
      for (const message of [...page.messages].reverse()) if (message.kind === "message" && message.authorPartnerId !== partnerId) {
        count++; if (recent.length < 30) recent.push(message);
        for (const attachment of [...message.attachments].reverse()) if (!delivered.has(attachment.id)) delivered.set(attachment.id, attachment);
      }
      if (!page.hasMoreBefore) break; before = page.messages[0]!.sequence;
    }
    return { recent: recent.reverse(), omitted: count - recent.length, deliveredThrough: through,
      attachments: [...delivered.values()].slice(0, PARTNER_GROUP_TURN_ATTACHMENTS_MAX).reverse(), leftOut: Math.max(0, delivered.size - PARTNER_GROUP_TURN_ATTACHMENTS_MAX) };
  }
  async #memberTurn(group: PartnerGroupRecord, member: Member & { readonly profile: PartnerProfileRecord }, round: Round,
    mentions: PartnerGroupMention, live: () => boolean, throughSequence?: number): Promise<Outcome> {
    try {
      const lane = await this.options.runtime.ensureLane({ group, partner: member.profile, signal: round.abort.signal, assertCurrent: () => { if (!live()) changed(); } });
      if (!live()) return { kind: "cancelled" }; lane.assertCurrent();
      round.speakers.set(member.partnerId, lane.sessionId); this.#emit(group.id, "round");
      const delta = this.#delta(group.id, member.partnerId, throughSequence ?? this.options.storage.latestSequence(group.id));
      const shownIds = new Set(delta.recent.flatMap(message => message.attachments.map(attachment => attachment.id)));
      const prompt = buildMemberTurnPrompt({ groupName: group.name, partnerName: member.name,
        peerNames: this.#members(group).filter(peer => peer.partnerId !== member.partnerId).map(peer => peer.name),
        mentioned: mentions.all ? "everyone" : mentions.partnerIds.includes(member.partnerId) ? "you" : null,
        messages: delta.recent.map(message => {
          const plan = message.planId ? this.options.storage.getPlan(message.planId) : undefined;
          return { from: message.authorKind === "user" ? "user" : message.authorName, text: clampGroupText(message.content, 4000),
            ...(plan?.workDir && message.files.length ? { files: message.files.map(file => join(plan.workDir!, ...file.split("/"))) } : {}),
            ...(message.attachments.length ? { attachments: message.attachments.map(attachment => attachment.name) } : {}) };
        }), omitted: delta.omitted, earlierAttachments: delta.attachments.filter(attachment => !shownIds.has(attachment.id)).map(attachment => attachment.name),
        attachmentsLeftOut: delta.leftOut, previousTurnInterrupted: this.#interrupted.delete(lane.sessionId) });
      return await this.#execute(lane, `${round.id}:${member.partnerId}:${this.#id()}`, prompt, delta.attachments, round.abort.signal,
        this.options.turnTimeoutMs ?? 5 * 60_000, () => this.options.storage.advanceDelivered(group.id, member.partnerId, delta.deliveredThrough));
    } catch { return round.abort.signal.aborted ? { kind: "cancelled" } : { kind: "failed", notice: "member-unavailable" }; }
  }
  async #execute(lane: PartnerGroupSession, clientId: string, prompt: string, attachments: readonly PartnerGroupAttachment[], parentSignal: AbortSignal,
    timeoutMs: number, onAccepted: () => void): Promise<Outcome> {
    lane.assertCurrent();
    if (this.#blocked.has(lane.sessionId)) {
      if (!await this.options.runtime.stop(lane.sessionId).catch(() => false)) return { kind: "failed", notice: "member-failed" };
      this.#blocked.delete(lane.sessionId);
    }
    const timeout = new AbortController(), signal = AbortSignal.any([parentSignal, timeout.signal]); let expired = false;
    const operation = this.options.runtime.execute({ lane, clientId, prompt, attachments, signal, onAccepted });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<Outcome>(resolve => {
      const arm = () => { timer = setTimeout(() => {
        if (this.options.runtime.hasPendingInteraction(lane.sessionId)) { arm(); return; }
        expired = true; timeout.abort(); this.#interrupted.add(lane.sessionId);
        void this.options.runtime.stop(lane.sessionId).then(confirmed => { if (!confirmed) this.#blocked.add(lane.sessionId); }).catch(() => this.#blocked.add(lane.sessionId));
        resolve({ kind: "failed", notice: "member-timeout" });
      }, timeoutMs); timer.unref(); }; arm();
    });
    const settled = operation.then((result): Outcome => {
      if (parentSignal.aborted || expired) return { kind: "cancelled" };
      if (result.status !== "completed") return { kind: "failed", notice: result.failure ?? "member-failed" };
      lane.assertCurrent(); return isPartnerGroupNoReplyText(result.text) ? { kind: "silent" } : { kind: "reply", text: result.text };
    }, (): Outcome => parentSignal.aborted || expired ? { kind: "cancelled" } : { kind: "failed", notice: "member-failed" });
    try { return await Promise.race([settled, timeoutResult]); } finally { clearTimeout(timer); }
  }
  #startPlanning(groupId: string, message: PartnerGroupMessage, mode: PlanDecisionInput["mode"], revise: PartnerGroupPlan | undefined, fallback: (() => void) | null): void {
    const group = this.options.storage.get(groupId), organizer = this.#organizer(group);
    if (!organizer) { if (fallback) fallback(); else this.#notice(groupId, { partnerId: group.organizerPartnerId ?? group.memberIds[0] ?? "unavailable", name: "" }, "plan-failed"); return; }
    const state = this.#state(groupId), planning: Planning = { id: this.#id(), partnerId: organizer.partnerId, abort: new AbortController() };
    state.planning = planning; this.#emit(groupId, "round");
    const live = () => !this.#closed && !planning.abort.signal.aborted && state.planning === planning;
    this.#launch((async () => {
      try {
        const decision = await this.options.decidePlan({ mode, groupName: group.name, organizerName: organizer.name,
          members: this.#members(group).filter(member => this.#available(member)).map(member => ({ partnerId: member.partnerId, name: member.name, description: member.profile?.description ?? "" })),
          recent: this.options.storage.messages(groupId, { beforeSequence: message.sequence, limit: 12 }).messages.filter(row => row.kind === "message").map(row => ({ from: row.authorKind === "user" ? "user" : row.authorName, text: row.content })),
          request: message.content, requestAttachments: message.attachments.map(attachment => attachment.name),
          ...(revise ? { currentSteps: revise.steps.map(step => ({ partnerId: step.partnerId, task: step.task })) } : {}) }, planning.abort.signal, live);
        if (!live()) return;
        if (decision?.needsPlan) {
          const current = this.options.storage.get(groupId), available = this.#members(current).filter(member => this.#available(member));
          if (decision.steps.some(step => !available.some(member => member.partnerId === step.partnerId))) unavailable();
          this.options.storage.createPlan(groupId, current.revision, { requestText: mode === "revise" && revise ? `${revise.requestText}\n${message.content}` : message.content,
            attachments: uniqueAttachments([...(revise?.attachments ?? []), ...message.attachments]).slice(-PARTNER_GROUP_ATTACHMENTS_MAX),
            organizerPartnerId: organizer.partnerId, organizerName: organizer.name,
            steps: decision.steps.map(step => ({ ...step, partnerName: available.find(member => member.partnerId === step.partnerId)!.name })) });
          this.#emit(groupId, "plan"); this.#emit(groupId, "messages");
        } else if (mode === "auto") fallback?.();
        else this.#notice(groupId, organizer, "plan-failed");
      } catch { if (live()) { if (mode === "auto") fallback?.(); else this.#notice(groupId, organizer, "plan-failed"); } }
      finally { if (state.planning === planning) { state.planning = null; this.#emit(groupId, "round"); } }
    })());
  }
  planAction(groupId: string, planId: string, expectedRevision: number, action: "start" | "dismiss" | "continue" | "retry", assertRequest: () => void): Promise<void> {
    return this.#serial(groupId, async () => {
      this.#owner(groupId, undefined, assertRequest); const plan = this.options.storage.getPlan(planId);
      if (plan.groupId !== groupId || plan.revision !== expectedRevision || this.options.storage.openPlan(groupId)?.id !== planId) planClosed();
      if (action === "start") { if (plan.status !== "proposed") planClosed(); await this.#beginStep(plan, 0, null); return; }
      if (action === "dismiss") {
        if (plan.status === "proposed") this.options.storage.updatePlan(planId, expectedRevision, value => ({ ...value, status: "dismissed" }));
        else if (plan.status === "waiting") await this.#stopPlan(groupId); else planClosed();
        this.#emit(groupId, "plan"); return;
      }
      if (plan.status !== "waiting" || plan.currentStep === null) planClosed();
      const step = plan.steps[plan.currentStep]!;
      if (action === "continue") { if (step.status !== "done" || plan.currentStep + 1 >= plan.steps.length) planClosed(); await this.#beginStep(plan, plan.currentStep + 1, null); }
      else { if (step.status !== "failed") planClosed(); await this.#beginStep(plan, plan.currentStep, null); }
    });
  }
  editPlan(groupId: string, planId: string, expectedRevision: number, position: number, action: "reassign" | "remove", partnerId: string | undefined, assertRequest: () => void): Promise<void> {
    return this.#serial(groupId, async () => {
      const owner = this.#owner(groupId, undefined, assertRequest), plan = this.options.storage.getPlan(planId);
      if (plan.groupId !== groupId || plan.revision !== expectedRevision || !["proposed", "waiting"].includes(plan.status) || !plan.steps[position]) planClosed();
      let steps = [...plan.steps];
      if (action === "remove") { if (plan.status !== "proposed" || steps.length < 2) planClosed(); steps.splice(position, 1); steps = steps.map((step, index) => ({ ...step, position: index })); }
      else {
        const member = this.#members(owner.group).find(member => member.partnerId === partnerId); if (!member || !this.#available(member)) unavailable();
        if (plan.status !== "proposed" && steps[position]!.status === "done") planClosed();
        steps[position] = { ...steps[position]!, partnerId: member.partnerId, partnerName: member.name };
      }
      this.options.storage.updatePlan(planId, expectedRevision, value => ({ ...value, steps })); this.#emit(groupId, "plan");
    });
  }
  async #beginStep(plan: PartnerGroupPlan, position: number, notes: { readonly kind: "redo" | "more" | "retry"; readonly notes: readonly Note[] } | null): Promise<void> {
    const state = this.#state(plan.groupId); if (state.step) planClosed(); await this.#cancelRound(plan.groupId); this.#cancelPlanning(plan.groupId);
    const pending = plan.steps[position]; if (!pending) planClosed();
    const current = this.options.storage.getPlan(plan.id);
    const running = this.options.storage.updatePlan(plan.id, current.revision, value => ({ ...value, status: "running", currentStep: position,
      steps: value.steps.map(step => step.position === position ? { ...step, status: "running", startedAt: this.#now(), finishedAt: null } : step) }));
    const carried = state.carried?.planId === plan.id && state.carried.position === position ? state.carried.notes : [];
    state.carried = null;
    const step: Step = { planId: plan.id, position, partnerId: pending.partnerId, abort: new AbortController(), notes: [], sessionId: null };
    state.step = step; this.#emit(plan.groupId, "plan"); this.#emit(plan.groupId, "round");
    this.#launch(this.#runStep(running, step, notes ? { ...notes, notes: [...carried, ...notes.notes] } : carried.length ? { kind: "retry", notes: carried } : null));
  }
  async #runStep(initialPlan: PartnerGroupPlan, active: Step, initialNotes: { readonly kind: "redo" | "more" | "retry"; readonly notes: readonly Note[] } | null): Promise<void> {
    const groupId = initialPlan.groupId, state = this.#state(groupId), live = () => !this.#closed && !active.abort.signal.aborted && state.step === active;
    let inFlight: readonly Note[] = initialNotes?.notes ?? [], leftover: Note[] = [];
    const fail = (notice: PartnerGroupNoticeCode) => {
      if (!live()) return;
      const current = this.options.storage.getPlan(initialPlan.id);
      this.options.storage.transaction(storage => {
        storage.updatePlan(current.id, current.revision, value => ({ ...value, status: "waiting",
          steps: value.steps.map(step => step.position === active.position ? { ...step, status: "failed", finishedAt: this.#now() } : step) }));
        storage.appendMessage(groupId, { ...emptyMessage(), clientId: this.#id(), kind: "notice", authorKind: "system",
          authorPartnerId: active.partnerId, authorName: current.steps[active.position]!.partnerName, noticeCode: notice });
      });
      state.carried = { planId: current.id, position: active.position, notes: [...inFlight, ...active.notes.splice(0)] };
      this.#emit(groupId, "messages"); this.#emit(groupId, "plan"); this.#launch(this.options.notifyStep(this.options.storage.get(groupId), this.options.storage.getPlan(current.id)));
    };
    try {
      const group = this.options.storage.get(groupId), member = this.#members(group).find(member => member.partnerId === active.partnerId);
      if (!member || !this.#available(member)) { fail("member-unavailable"); return; }
      let plan = this.options.storage.getPlan(initialPlan.id);
      const location = await this.options.work.prepare(group, plan, () => { if (!live()) changed(); }); if (!live()) return;
      plan = this.options.storage.updatePlan(plan.id, plan.revision, value => ({ ...value, workDir: location.path, branch: location.branch }));
      const lane = await this.options.runtime.ensureLane({ group, partner: member.profile, plan, signal: active.abort.signal, assertCurrent: () => { if (!live()) changed(); } });
      if (!live()) return; active.sessionId = lane.sessionId; this.#emit(groupId, "round");
      const before = await this.options.work.snapshot(location.path); let notes = initialNotes, text = "", files: readonly string[] = [];
      let includeOriginal = initialNotes?.kind !== "redo";
      for (;;) {
        if (!live()) return; inFlight = notes?.notes ?? [];
        const current = this.options.storage.getPlan(plan.id);
        const handoffs = current.steps.filter(step => step.position < active.position).map(step => {
          const message = step.resultMessageId ? this.options.storage.findMessage(groupId, step.resultMessageId) : undefined;
          return { position: step.position, partnerName: message?.authorName ?? step.partnerName, note: message?.content ?? "", files: [...(message?.files ?? [])] };
        });
        const prompt = buildPlanStepBrief({ groupName: group.name, partnerName: member.name, request: current.requestText,
          attachments: current.attachments.map(attachment => attachment.name), attachmentsIncluded: includeOriginal,
          steps: current.steps.map(step => ({ position: step.position, partnerName: step.partnerName, task: step.task, status: step.status })),
          position: active.position, handoffs, recent: this.options.storage.messages(groupId, { limit: 12 }).messages.filter(message => message.kind === "message")
            .map(message => ({ from: message.authorKind === "user" ? "user" : message.authorName, text: message.content })),
          workDir: location.path, branch: location.branch,
          ...(notes ? { userNotes: { kind: notes.kind, texts: notes.notes.map(note => note.text), attachments: notes.notes.flatMap(note => note.attachments.map(attachment => attachment.name)) } } : {}) });
        const attachments = uniqueAttachments([...(includeOriginal ? current.attachments : []), ...inFlight.flatMap(note => note.attachments)]); includeOriginal = false;
        const outcome = await this.#execute(lane, `${active.planId}:${active.position}:${this.#id()}`, prompt, attachments, active.abort.signal,
          this.options.stepTimeoutMs ?? 2 * 60 * 60_000, () => undefined);
        if (!live() || outcome.kind === "cancelled") return;
        if (outcome.kind === "failed") { fail(outcome.notice); return; }
        text = outcome.kind === "reply" ? outcome.text : ""; inFlight = [];
        if (!active.notes.length) { files = await this.options.work.changedFiles(location.path, before); if (!active.notes.length) break; }
        notes = { kind: "more", notes: active.notes.splice(0) };
      }
      if (!live()) return;
      const current = this.options.storage.getPlan(plan.id), done = active.position === current.steps.length - 1;
      this.options.storage.transaction(storage => {
        const handoff = storage.appendMessage(groupId, { ...emptyMessage(), clientId: `${active.planId}:${active.position}:result:${this.#id()}`,
          authorKind: "partner", authorPartnerId: active.partnerId, authorName: member.name, content: clampGroupText(text, PARTNER_GROUP_REPLY_MAX_CHARS),
          planId: current.id, files: files.slice(0, 20) }).message;
        storage.updatePlan(current.id, current.revision, value => ({ ...value, status: done ? "done" : "waiting",
          steps: value.steps.map(step => step.position === active.position ? { ...step, status: "done", resultMessageId: handoff.id, finishedAt: this.#now() } : step) }));
        if (done) storage.appendMessage(groupId, { ...emptyMessage(), clientId: `${current.id}:end`, kind: "plan-end", authorKind: "system", planId: current.id });
      });
      const completed = this.options.storage.getPlan(plan.id); leftover = active.notes.splice(0);
      if (state.step === active) { state.step = null; this.#emit(groupId, "round"); }
      this.#emit(groupId, "messages"); this.#emit(groupId, "plan"); await this.options.notifyStep(this.options.storage.get(groupId), completed);
    } catch { fail("member-failed"); }
    finally {
      if (state.step === active) { state.step = null; this.#emit(groupId, "round"); }
      if (leftover.length && !active.abort.signal.aborted && !this.#closed) this.#launch(this.#serial(groupId, async () => {
        const plan = this.options.storage.openPlan(groupId); if (plan?.id === active.planId && plan.status === "waiting" && plan.currentStep === active.position)
          await this.#beginStep(plan, active.position, { kind: "redo", notes: leftover });
      }));
    }
  }
  async #stopPlan(groupId: string): Promise<void> {
    const state = this.#state(groupId), active = state.step; active?.abort.abort();
    if (active?.sessionId && !await this.options.runtime.stop(active.sessionId).catch(() => false)) { this.#blocked.add(active.sessionId); unavailable("The plan step stop was not confirmed."); }
    if (state.step === active) state.step = null; state.carried = null;
    const plan = this.options.storage.openPlan(groupId);
    if (plan && plan.status !== "proposed") {
      this.options.storage.updatePlan(plan.id, plan.revision, value => ({ ...value, status: "stopped",
        steps: value.steps.map(step => step.status === "running" ? { ...step, status: "failed", finishedAt: this.#now() } : step) }));
      this.#notice(groupId, { partnerId: plan.organizerPartnerId, name: plan.organizerName }, "plan-stopped"); this.#emit(groupId, "plan");
      await this.options.notifyStep(this.options.storage.get(groupId), this.options.storage.getPlan(plan.id));
    }
  }
  continueRound(groupId: string, assertRequest: () => void = () => undefined): Promise<void> {
    return this.#serial(groupId, async () => {
      this.#owner(groupId, undefined, assertRequest); const state = this.#state(groupId); if (state.round) return;
      const latest = this.options.storage.messages(groupId, { limit: 1 }).messages[0]; if (latest?.kind !== "round-end" || state.step || state.planning) invalid();
      const available = this.#members(this.options.storage.get(groupId)).filter(member => this.#available(member));
      const responders = latest.mentions.partnerIds.filter(id => available.some(member => member.partnerId === id)); if (!responders.length) unavailable();
      this.#startRound(groupId, responders, { all: false, partnerIds: [] }, false);
    });
  }
  stop(groupId: string, assertRequest: () => void = () => undefined): Promise<void> {
    return this.#serial(groupId, async () => { this.#owner(groupId, undefined, assertRequest); await this.#cancelRound(groupId); this.#cancelPlanning(groupId); await this.#stopPlan(groupId); this.#emit(groupId, "round"); });
  }
  delete(groupId: string, expectedRevision: number, assertRequest: () => void = () => undefined): Promise<void> {
    return this.#serial(groupId, async () => {
      assertRequest();
      const group = this.options.storage.get(groupId); if (group.lifecycle === "active") this.options.storage.beginDelete(groupId, expectedRevision);
      await this.#cancelRound(groupId); this.#cancelPlanning(groupId); await this.#stopPlanForDelete(groupId); await this.#finishDelete(groupId);
    });
  }
  async #stopPlanForDelete(groupId: string): Promise<void> {
    const state = this.#state(groupId), active = state.step; active?.abort.abort();
    if (active?.sessionId && !await this.options.runtime.stop(active.sessionId).catch(() => false)) unavailable("The group execution could not be retired.");
    state.step = null; state.carried = null;
  }
  async #finishDelete(groupId: string): Promise<void> {
    for (const lane of this.options.storage.lanes(groupId)) {
      if (lane.phase === "archived") continue; await this.options.runtime.archive(lane);
      const current = this.options.storage.lanes(groupId).find(value => value.operationId === lane.operationId)!;
      if (current.phase !== "archived") this.options.storage.updateLane(current, { phase: "archived", sessionId: current.sessionId, profileVersion: current.profileVersion });
    }
    await this.options.work.trashGroup(groupId); this.options.storage.finishDelete(groupId); this.#states.delete(groupId); this.#emit(groupId, "deleted");
  }
  async partnerLifecycle(partnerId: string, lifecycle: "active" | "paused" | "archived" | "deleted"): Promise<void> {
    if (!this.#started) return;
    for (const group of this.options.storage.list().filter(group => group.memberIds.includes(partnerId))) await this.#serial(group.id, async () => {
      if (lifecycle !== "active") {
        await this.#cancelRound(group.id); this.#cancelPlanning(group.id);
        const state = this.#state(group.id), active = state.step;
        if (active?.partnerId === partnerId) {
          active.abort.abort(); if (active.sessionId && !await this.options.runtime.stop(active.sessionId).catch(() => false)) unavailable();
          state.step = null; const plan = this.options.storage.getPlan(active.planId);
          this.options.storage.updatePlan(plan.id, plan.revision, value => ({ ...value, status: "waiting",
            steps: value.steps.map(step => step.position === active.position ? { ...step, status: "failed", finishedAt: this.#now() } : step) }));
          this.#emit(group.id, "plan");
        }
        if (lifecycle === "deleted") this.options.storage.removePartner(partnerId);
      }
      this.#emit(group.id, "updated");
    });
  }
  async close(): Promise<void> {
    for (const [id, state] of this.#states) {
      state.round?.abort.abort(); state.planning?.abort.abort(); state.step?.abort.abort();
      const sessions = [...state.round?.speakers.values() ?? [], state.step?.sessionId].filter((id): id is string => !!id);
      await Promise.all(sessions.map(id => this.options.runtime.stop(id).catch(() => false)));
      state.round = null; state.planning = null; state.step = null; this.#states.delete(id);
    }
    this.#closed = true; this.options.storage.recoverInterruptedPlans();
  }
}

function emptyMessage() {
  return { kind: "message" as const, authorKind: "system" as const, authorPartnerId: null, authorName: "", content: "",
    mentions: { all: false, partnerIds: [] }, noticeCode: null, planId: null, files: [], attachments: [] };
}
function uniqueAttachments(input: readonly PartnerGroupAttachment[]): PartnerGroupAttachment[] {
  const seen = new Set<string>(); return input.filter(attachment => !seen.has(attachment.id) && !!seen.add(attachment.id));
}
function configIdentity(group: PartnerGroupRecord): string {
  return JSON.stringify([group.id, group.lifecycle, group.name, group.replyMode, group.speakingMode, group.organizerPartnerId, group.projectDir, group.memberIds]);
}
function changed(): never { throw new PartnerGroupError("changed", "The group owner changed. Read the current state before continuing."); }
function unavailable(message = "The group or member is unavailable."): never { throw new PartnerGroupError("unavailable", message); }
function invalid(): never { throw new PartnerGroupError("invalid", "The group action is invalid for the current state."); }
function planClosed(): never { throw new PartnerGroupError("plan_closed", "The plan changed or does not allow this action."); }
