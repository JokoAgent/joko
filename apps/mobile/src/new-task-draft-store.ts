import type { MobilePlainStorageDriver } from "./connection-storage";
import { normalizeMobileObjectiveInput, type MobileObjectiveInput } from "./mobile-objective";
import { normalizeMobileWorkerForm, type MobileWorkerForm } from "./mobile-collaboration";
import {
  cloneMobileComposerDraft,
  mobileComposerDraftsEqual,
  normalizeMobileComposerDraft,
  emptyMobileComposerDraft,
  prependMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";

export interface MobileNewTaskDraftIdentity {
  readonly profileId: string;
}

export interface MobileNewTaskEditableDraft {
  readonly collaboration?: MobileWorkerForm;
  readonly targetId: string;
  readonly name: string;
  readonly input: MobileComposerDraft;
}

export interface MobileNewTaskModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly effortId?: string;
  readonly fastMode: boolean | "ultrafast";
}

interface MobileNewTaskSubmissionBase {
  readonly collaboration?: MobileWorkerForm;
  readonly objective?: MobileObjectiveInput;
  readonly connectionId: string;
  readonly serverId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly targetRevisionEtag?: string;
  readonly createOperationId: string;
  readonly displayName: string;
  readonly model: MobileNewTaskModelSelection | null;
  readonly input: MobileComposerDraft;
}

export interface MobileNewTaskCreateSubmission extends MobileNewTaskSubmissionBase {
  readonly phase: "creating";
}

export interface MobileNewTaskSendSubmission extends MobileNewTaskSubmissionBase {
  readonly firstInputAccepted?: true;
  readonly collaborationHandled?: boolean;
  readonly phase: "sending";
  readonly sessionId: string;
  readonly runtimeGeneration: string;
  readonly sendOperationId?: string;
  readonly objectiveRequestId?: string;
}

export type MobileNewTaskSubmission = MobileNewTaskCreateSubmission | MobileNewTaskSendSubmission;

export interface MobileNewTaskDraft extends MobileNewTaskEditableDraft {
  readonly submission?: MobileNewTaskSubmission;
  readonly conversation?: MobileNewTaskConversation;
}

export interface MobileNewTaskFollowUp {
  readonly operationId: string;
  readonly input: MobileComposerDraft;
  readonly state: "queued" | "dispatching" | "accepted";
}

export interface MobileNewTaskConversation {
  readonly input: MobileComposerDraft;
  readonly followUps: readonly MobileNewTaskFollowUp[];
  readonly sealed?: true;
}

export type MobileNewTaskDraftErrorListener = (
  identity: MobileNewTaskDraftIdentity,
  error: Error
) => void;

export interface MobileNewTaskDraftSnapshot {
  readonly revision: number;
  readonly draft?: MobileNewTaskDraft;
}

const storagePrefix = "joko.mobile.new-task-draft.v9";
const persistDebounceMilliseconds = 400;
const maximumStoredCharacters = 12_110_000;

export class MobileNewTaskDraftStore {
  readonly #memory = new Map<string, MobileNewTaskDraft>();
  readonly #cleared = new Set<string>();
  readonly #dirty = new Set<string>();
  readonly #identities = new Map<string, MobileNewTaskDraftIdentity>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #listeners = new Set<MobileNewTaskDraftErrorListener>();
  readonly #revisions = new Map<string, number>();
  readonly #changes = new Set<() => void>();

  constructor(readonly driver: MobilePlainStorageDriver) {}

  subscribe(listener: () => void): () => void {
    this.#changes.add(listener);
    return () => this.#changes.delete(listener);
  }

  revision(identity: MobileNewTaskDraftIdentity): number {
    return this.#revisions.get(identityKey(identity)) ?? 0;
  }

  subscribeErrors(listener: MobileNewTaskDraftErrorListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  readSync(identity: MobileNewTaskDraftIdentity): MobileNewTaskDraft | null {
    const key = identityKey(identity);
    if (this.#cleared.has(key)) return null;
    const draft = this.#memory.get(key);
    return draft === undefined ? null : cloneDraft(draft);
  }

  async read(identity: MobileNewTaskDraftIdentity): Promise<MobileNewTaskDraft | null> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    const current = this.#memory.get(key);
    if (current !== undefined) return cloneDraft(current);
    if (this.#cleared.has(key)) return null;
    let stored: string | null;
    try {
      stored = await this.driver.getItem(storageKey(exact));
    } catch (cause) {
      const error = storageError("read", cause);
      this.#notify(exact, error);
      throw error;
    }
    const newer = this.#memory.get(key);
    if (newer !== undefined) return cloneDraft(newer);
    if (this.#cleared.has(key) || stored === null) return null;
    try {
      const draft = readRecord(stored, exact);
      this.#memory.set(key, draft);
      this.#identities.set(key, exact);
      return cloneDraft(draft);
    } catch (cause) {
      const error = storageError("read", cause);
      this.#notify(exact, error);
      throw error;
    }
  }

  async readDurable(identity: MobileNewTaskDraftIdentity): Promise<MobileNewTaskDraft | null> {
    const exact = normalizeIdentity(identity);
    try {
      const stored = await this.driver.getItem(storageKey(exact));
      return stored === null ? null : cloneDraft(readRecord(stored, exact));
    } catch (cause) {
      const error = storageError("read", cause);
      this.#notify(exact, error);
      throw error;
    }
  }

  save(identity: MobileNewTaskDraftIdentity, draft: MobileNewTaskEditableDraft): void {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    if (this.#memory.get(key)?.submission !== undefined) return;
    const value = normalizeEditableDraft(draft);
    this.#save(exact, value);
  }

  #save(exact: MobileNewTaskDraftIdentity, value: MobileNewTaskDraft): void {
    const key = identityKey(exact);
    const serialized = serializeRecord(exact, value);
    this.#cancelTimer(key);
    this.#bumpRevision(key);
    this.#memory.set(key, value);
    this.#cleared.delete(key);
    this.#dirty.add(key);
    this.#identities.set(key, exact);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      void this.#persistIfCurrent(exact, value, serialized).catch(() => undefined);
    }, persistDebounceMilliseconds);
    this.#timers.set(key, timer);
    this.#publish();
  }

  async openConversation(identity: MobileNewTaskDraftIdentity, createOperationId: string): Promise<void> {
    const current = this.#conversationOwner(identity, createOperationId);
    if (current.conversation) return;
    await this.#replace(identity, { ...current, conversation: { input: emptyMobileComposerDraft(), followUps: [] } });
  }

  saveConversationInput(identity: MobileNewTaskDraftIdentity, createOperationId: string, input: MobileComposerDraft): void {
    const current = this.#conversationOwner(identity, createOperationId);
    if (!current.conversation || current.conversation.sealed) throw new Error("The local task conversation is being transferred to its created task.");
    const next = { ...current, conversation: { ...current.conversation, input: normalizeNewTaskInput(input) } };
    mergeMobileNewTaskUnsentInput(next, true);
    this.#save(identity, next);
  }

  async queueFollowUp(identity: MobileNewTaskDraftIdentity, createOperationId: string, operationId: string,
    expected: MobileComposerDraft): Promise<void> {
    const current = this.#conversationOwner(identity, createOperationId), conversation = current.conversation;
    if (!conversation || conversation.sealed || !mobileComposerDraftsEqual(conversation.input, expected)) {
      throw new Error("The local follow-up changed before it could be saved.");
    }
    assertIdentity(operationId, "follow-up operation");
    if (!hasComposerInput(expected) || conversation.followUps.length >= 100
      || conversation.followUps.some(item => item.operationId === operationId) || operationId === createOperationId) {
      throw new Error("The local follow-up cannot be queued.");
    }
    await this.#replace(identity, { ...current, conversation: { ...conversation, input: emptyMobileComposerDraft(),
      followUps: [...conversation.followUps, { operationId, input: normalizeNewTaskInput(expected), state: "queued" }] } });
  }

  async updateFollowUp(identity: MobileNewTaskDraftIdentity, createOperationId: string, operationId: string,
    change: { readonly input?: MobileComposerDraft; readonly state?: MobileNewTaskFollowUp["state"] }): Promise<void> {
    const current = this.#conversationOwner(identity, createOperationId), conversation = current.conversation;
    const previous = conversation?.followUps.find(item => item.operationId === operationId);
    if (!conversation || !previous || previous.state === "accepted" || change.input && previous.state !== "queued"
      || change.state === "queued" || change.state === "accepted" && previous.state !== "dispatching") {
      throw new Error("The retained follow-up owner changed.");
    }
    await this.#replace(identity, { ...current, conversation: { ...conversation,
      followUps: conversation.followUps.map(item => item === previous ? { ...item, ...change } : item) } });
  }

  async markFirstInputAccepted(identity: MobileNewTaskDraftIdentity, createOperationId: string): Promise<MobileNewTaskSendSubmission> {
    const current = this.#conversationOwner(identity, createOperationId), submission = current.submission;
    if (submission?.phase !== "sending" || !submission.sendOperationId) throw new Error("The first-message receipt is unavailable.");
    const next = { ...submission, firstInputAccepted: true as const };
    await this.#replace(identity, { ...current, submission: next });
    return next;
  }

  async sealConversation(identity: MobileNewTaskDraftIdentity, createOperationId: string): Promise<MobileNewTaskDraft> {
    const current = this.#conversationOwner(identity, createOperationId);
    const next = current.conversation ? { ...current, conversation: { ...current.conversation, sealed: true as const } } : current;
    await this.#replace(identity, next);
    return cloneDraft(next);
  }

  #conversationOwner(identity: MobileNewTaskDraftIdentity, createOperationId: string): MobileNewTaskDraft {
    const current = this.#required(identity);
    if (current.submission?.createOperationId !== createOperationId || current.submission.objective) {
      throw new Error("The retained new-task conversation belongs to a different creation.");
    }
    return current;
  }

  async readSnapshot(identity: MobileNewTaskDraftIdentity): Promise<MobileNewTaskDraftSnapshot> {
    const exact = normalizeIdentity(identity);
    await this.read(exact);
    const draft = this.readSync(exact);
    return {
      revision: this.#revisions.get(identityKey(exact)) ?? 0,
      ...(draft === null ? {} : { draft })
    };
  }

  saveIfRevision(
    identity: MobileNewTaskDraftIdentity,
    draft: MobileNewTaskEditableDraft,
    expectedRevision: number
  ): boolean {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || (this.#revisions.get(key) ?? 0) !== expectedRevision
      || this.#memory.get(key)?.submission !== undefined) return false;
    this.save(exact, draft);
    return (this.#revisions.get(key) ?? 0) === expectedRevision + 1;
  }

  async beginSubmission(
    identity: MobileNewTaskDraftIdentity,
    draft: MobileNewTaskEditableDraft,
    authority: Omit<MobileNewTaskSubmissionBase, "targetId" | "displayName" | "input">
  ): Promise<MobileNewTaskCreateSubmission> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    const existing = this.#memory.get(key) ?? await this.read(exact) ?? undefined;
    if (existing?.submission !== undefined) {
      throw new Error("A retained new-task submission is already in progress.");
    }
    const editable = normalizeEditableDraft(draft);
    const displayName = editable.name.trim() || "New task";
    if (!editable.targetId || !hasComposerInput(editable.input) && authority.objective === undefined) {
      throw new Error("Choose a project and enter a first message or attachment.");
    }
    const submission = normalizeSubmission({
      phase: "creating",
      ...authority,
      targetId: editable.targetId,
      displayName,
      input: editable.input
    });
    await this.#replace(exact, { ...editable, submission });
    return cloneSubmission(submission) as MobileNewTaskCreateSubmission;
  }

  async advanceToSending(
    identity: MobileNewTaskDraftIdentity,
    createOperationId: string,
    sessionId: string,
    runtimeGeneration: bigint
  ): Promise<MobileNewTaskSendSubmission> {
    const exact = normalizeIdentity(identity);
    const current = this.#required(exact);
    const submission = current.submission;
    if (submission?.phase !== "creating" || submission.createOperationId !== createOperationId) {
      throw new Error("The retained new-task creation changed before its first message was prepared.");
    }
    assertIdentity(sessionId, "task");
    if (runtimeGeneration < 1n) throw new Error("The created task runtime generation is invalid.");
    const next = normalizeSubmission({
      ...submission,
      phase: "sending",
      sessionId,
      runtimeGeneration: runtimeGeneration.toString(10)
    }) as MobileNewTaskSendSubmission;
    await this.#replace(exact, { ...current, submission: next });
    return cloneSubmission(next) as MobileNewTaskSendSubmission;
  }

  async setSendOperation(
    identity: MobileNewTaskDraftIdentity,
    createOperationId: string,
    sendOperationId: string
  ): Promise<MobileNewTaskSendSubmission> {
    const exact = normalizeIdentity(identity);
    const current = this.#required(exact);
    const submission = current.submission;
    if (submission?.phase !== "sending" || submission.createOperationId !== createOperationId) {
      throw new Error("The retained new-task first-message owner changed.");
    }
    assertIdentity(sendOperationId, "first-message operation");
    if (submission.sendOperationId !== undefined && submission.sendOperationId !== sendOperationId) {
      throw new Error("The retained new-task first message already has a different operation.");
    }
    const next = normalizeSubmission({ ...submission, sendOperationId }) as MobileNewTaskSendSubmission;
    await this.#replace(exact, { ...current, submission: next });
    return cloneSubmission(next) as MobileNewTaskSendSubmission;
  }

  async setObjectiveRequest(identity: MobileNewTaskDraftIdentity, createOperationId: string, requestId: string): Promise<MobileNewTaskSendSubmission> {
    const exact = normalizeIdentity(identity), current = this.#required(exact), submission = current.submission;
    if (submission?.phase !== "sending" || submission.createOperationId !== createOperationId || !submission.objective
      || submission.objectiveRequestId !== undefined && submission.objectiveRequestId !== requestId || submission.sendOperationId !== undefined) {
      throw new Error("The retained new-task objective owner changed.");
    }
    assertIdentity(requestId, "objective request");
    const next = normalizeSubmission({ ...submission, objectiveRequestId: requestId }) as MobileNewTaskSendSubmission;
    await this.#replace(exact, { ...current, submission: next });
    return cloneSubmission(next) as MobileNewTaskSendSubmission;
  }

  async markCollaborationHandled(identity: MobileNewTaskDraftIdentity, createOperationId: string): Promise<MobileNewTaskSendSubmission> {
    const exact = normalizeIdentity(identity), current = this.#required(exact), submission = current.submission;
    if (submission?.phase !== "sending" || submission.createOperationId !== createOperationId || !submission.collaboration) throw new Error("The retained collaboration draft owner changed.");
    const next = normalizeSubmission({ ...submission, collaborationHandled: true }) as MobileNewTaskSendSubmission;
    await this.#replace(exact, { ...current, submission: next }); return cloneSubmission(next) as MobileNewTaskSendSubmission;
  }

  async replaceSubmissionInput(
    identity: MobileNewTaskDraftIdentity,
    createOperationId: string,
    expected: MobileComposerDraft,
    replacement: MobileComposerDraft
  ): Promise<MobileNewTaskSubmission> {
    const exact = normalizeIdentity(identity);
    const current = this.#required(exact);
    const submission = current.submission;
    if (submission === undefined || submission.createOperationId !== createOperationId
      || !mobileComposerDraftsEqual(current.input, expected)
      || !mobileComposerDraftsEqual(submission.input, expected)) {
      throw new Error("The retained new-task attachment input changed while it was being committed.");
    }
    const input = normalizeNewTaskInput(replacement);
    if (!hasComposerInput(input)) throw new Error("The retained Joko first input is invalid.");
    const next = normalizeSubmission({ ...submission, input });
    await this.#replace(exact, { ...current, input, submission: next });
    return cloneSubmission(next);
  }

  async clearSubmission(
    identity: MobileNewTaskDraftIdentity,
    operationId: string
  ): Promise<MobileNewTaskEditableDraft> {
    const exact = normalizeIdentity(identity);
    const current = this.#required(exact);
    const submission = current.submission;
    const activeOperationId = submission?.phase === "sending" && submission.sendOperationId
      ? submission.sendOperationId
      : submission?.createOperationId;
    if (submission === undefined || activeOperationId !== operationId) {
      throw new Error("The retained new-task operation changed before it could be released.");
    }
    const editable = normalizeEditableDraft({ ...current, input: mergeMobileNewTaskUnsentInput(current, true) });
    await this.#replace(exact, editable);
    return cloneEditableDraft(editable);
  }

  async clear(identity: MobileNewTaskDraftIdentity): Promise<void> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    this.#cancelTimer(key);
    this.#bumpRevision(key);
    this.#memory.delete(key);
    this.#cleared.add(key);
    this.#dirty.add(key);
    this.#identities.set(key, exact);
    this.#publish();
    await this.#removeIfCurrent(exact);
  }

  async flush(identity?: MobileNewTaskDraftIdentity): Promise<void> {
    const selectedKey = identity === undefined ? undefined : identityKey(identity);
    const pending = [...this.#timers.entries()].filter(([key]) => selectedKey === undefined || key === selectedKey);
    for (const [key, timer] of pending) {
      clearTimeout(timer);
      this.#timers.delete(key);
    }
    const keys = new Set([
      ...pending.map(([key]) => key),
      ...[...this.#dirty].filter((key) => selectedKey === undefined || key === selectedKey)
    ]);
    await Promise.all([...keys].map(async (key) => {
      const exact = this.#identities.get(key);
      const draft = this.#memory.get(key);
      if (!exact) return;
      if (draft !== undefined) await this.#persistIfCurrent(exact, draft, serializeRecord(exact, draft));
      else if (this.#cleared.has(key)) await this.#removeIfCurrent(exact);
    }));
    await Promise.all([...this.#operations.entries()]
      .filter(([key]) => selectedKey === undefined || key === selectedKey)
      .map(([, operation]) => operation));
  }

  async #replace(identity: MobileNewTaskDraftIdentity, draft: MobileNewTaskDraft): Promise<void> {
    const value = normalizeDraft(draft);
    const serialized = serializeRecord(identity, value);
    const key = identityKey(identity);
    this.#cancelTimer(key);
    this.#bumpRevision(key);
    this.#memory.set(key, value);
    this.#cleared.delete(key);
    this.#dirty.add(key);
    this.#identities.set(key, identity);
    this.#publish();
    await this.#persistIfCurrent(identity, value, serialized);
  }

  #publish(): void { for (const listener of this.#changes) listener(); }

  #required(identity: MobileNewTaskDraftIdentity): MobileNewTaskDraft {
    const draft = this.#memory.get(identityKey(identity));
    if (draft === undefined || this.#cleared.has(identityKey(identity))) {
      throw new Error("The retained new-task draft is unavailable.");
    }
    return cloneDraft(draft);
  }

  async #persistIfCurrent(
    identity: MobileNewTaskDraftIdentity,
    draft: MobileNewTaskDraft,
    serialized: string
  ): Promise<void> {
    const key = identityKey(identity);
    const current = this.#memory.get(key);
    if (this.#cleared.has(key) || current === undefined || !sameDraft(current, draft)) return;
    await this.#enqueue(identity, () => this.driver.setItem(storageKey(identity), serialized));
    const latest = this.#memory.get(key);
    if (!this.#cleared.has(key) && latest !== undefined && sameDraft(latest, draft)) this.#dirty.delete(key);
  }

  async #removeIfCurrent(identity: MobileNewTaskDraftIdentity): Promise<void> {
    const key = identityKey(identity);
    if (!this.#cleared.has(key) || this.#memory.has(key)) return;
    await this.#enqueue(identity, () => this.driver.removeItem(storageKey(identity)));
    if (this.#cleared.has(key) && !this.#memory.has(key)) this.#dirty.delete(key);
  }

  #enqueue(identity: MobileNewTaskDraftIdentity, effect: () => Promise<void>): Promise<void> {
    const key = identityKey(identity);
    const previous = this.#operations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(effect).catch((cause) => {
      const error = storageError("write", cause);
      this.#notify(identity, error);
      throw error;
    });
    this.#operations.set(key, operation);
    void operation.finally(() => {
      if (this.#operations.get(key) === operation) this.#operations.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  #cancelTimer(key: string): void {
    const timer = this.#timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(key);
  }

  #notify(identity: MobileNewTaskDraftIdentity, error: Error): void {
    for (const listener of this.#listeners) listener(identity, error);
  }

  #bumpRevision(key: string): void {
    const current = this.#revisions.get(key) ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) throw new Error("The local Joko new-task draft revision is exhausted.");
    this.#revisions.set(key, current + 1);
  }
}

export function mobileNewTaskDraftIdentityKey(identity: MobileNewTaskDraftIdentity): string {
  return identityKey(identity);
}

function normalizeIdentity(identity: MobileNewTaskDraftIdentity): MobileNewTaskDraftIdentity {
  assertIdentity(identity.profileId, "connection profile");
  return { profileId: identity.profileId };
}

function identityKey(identity: MobileNewTaskDraftIdentity): string {
  return normalizeIdentity(identity).profileId;
}

function storageKey(identity: MobileNewTaskDraftIdentity): string {
  return `${storagePrefix}.${encodeURIComponent(normalizeIdentity(identity).profileId)}`;
}

function normalizeDraft(value: MobileNewTaskDraft): MobileNewTaskDraft {
  const editable = normalizeEditableDraft(value);
  return value.submission === undefined
    ? editable
    : { ...editable, submission: normalizeSubmission(value.submission),
      ...(value.conversation === undefined ? {} : { conversation: normalizeConversation(value.conversation) }) };
}

function normalizeConversation(value: MobileNewTaskConversation): MobileNewTaskConversation {
  if (!value || !Array.isArray(value.followUps) || value.followUps.length > 100 || value.sealed !== undefined && value.sealed !== true) {
    throw new Error("The retained local task conversation is invalid.");
  }
  const ids = new Set<string>();
  const followUps = value.followUps.map(item => {
    assertIdentity(item.operationId, "follow-up operation");
    if (ids.has(item.operationId) || !["queued", "dispatching", "accepted"].includes(item.state)) throw new Error("The retained follow-up is invalid.");
    ids.add(item.operationId);
    const input = normalizeNewTaskInput(item.input);
    if (!hasComposerInput(input)) throw new Error("The retained follow-up is empty.");
    return { operationId: item.operationId, state: item.state, input };
  });
  return { input: normalizeNewTaskInput(value.input), followUps, ...(value.sealed ? { sealed: true } : {}) };
}

/** Keep structured ranges and attachment ownership while returning unsent input to an editor. */
export function mergeMobileNewTaskUnsentInput(draft: MobileNewTaskDraft, includeFirst: boolean): MobileComposerDraft {
  const inputs = [...(includeFirst ? [draft.input] : []),
    ...(draft.conversation?.followUps.filter(item => item.state !== "accepted").map(item => item.input) ?? []),
    ...(draft.conversation ? [draft.conversation.input] : [])].filter(hasComposerInput);
  return inputs.reduceRight((tail, input) => prependMobileComposerDraft(input, tail), emptyMobileComposerDraft());
}

function normalizeEditableDraft(value: MobileNewTaskEditableDraft): MobileNewTaskEditableDraft {
  if (!value || typeof value !== "object") throw new Error("The local Joko new-task draft is invalid.");
  if (typeof value.targetId !== "string" || typeof value.name !== "string") {
    throw new Error("The local Joko new-task draft is invalid.");
  }
  if (value.targetId !== "") assertIdentity(value.targetId, "project");
  if (value.name.length > 256) throw new Error("The local Joko task name is too long.");
  const input = normalizeNewTaskInput(value.input);
  return { targetId: value.targetId, name: value.name, input,
    ...(value.collaboration === undefined ? {} : { collaboration: normalizeMobileWorkerForm(value.collaboration) }) };
}

function normalizeSubmission(value: MobileNewTaskSubmission): MobileNewTaskSubmission {
  if (!value || typeof value !== "object" || (value.phase !== "creating" && value.phase !== "sending")) {
    throw new Error("The retained new-task submission is invalid.");
  }
  assertIdentity(value.connectionId, "connection");
  assertIdentity(value.serverId, "server");
  assertIdentity(value.backendId, "Backend");
  assertIdentity(value.targetId, "project");
  positiveDecimal(value.targetRevision, "project revision");
  if (value.targetRevisionEtag !== undefined
    && (typeof value.targetRevisionEtag !== "string" || value.targetRevisionEtag.length > 512
      || /[\u0000-\u001f\u007f]/u.test(value.targetRevisionEtag))) {
    throw new Error("The retained Joko project revision tag is invalid.");
  }
  assertIdentity(value.createOperationId, "creation operation");
  if (!value.displayName.trim() || value.displayName.length > 256) throw new Error("The retained Joko task name is invalid.");
  const input = normalizeNewTaskInput(value.input);
  if (!hasComposerInput(input) && value.objective === undefined) {
    throw new Error("The retained Joko first message is invalid.");
  }
  const base: MobileNewTaskSubmissionBase = {
    ...(value.collaboration === undefined ? {} : { collaboration: normalizeMobileWorkerForm(value.collaboration) }),
    ...(value.objective === undefined ? {} : { objective: normalizeMobileObjectiveInput(value.objective) }),
    connectionId: value.connectionId,
    serverId: value.serverId,
    backendId: value.backendId,
    targetId: value.targetId,
    targetRevision: value.targetRevision,
    ...(value.targetRevisionEtag === undefined ? {} : { targetRevisionEtag: value.targetRevisionEtag }),
    createOperationId: value.createOperationId,
    displayName: value.displayName,
    model: normalizeNewTaskModelSelection(value.model),
    input
  };
  if (value.phase === "creating") return { phase: "creating", ...base };
  assertIdentity(value.sessionId, "task");
  positiveDecimal(value.runtimeGeneration, "task runtime generation");
  if (value.sendOperationId !== undefined) assertIdentity(value.sendOperationId, "first-message operation");
  if (value.objectiveRequestId !== undefined) assertIdentity(value.objectiveRequestId, "objective request");
  if (value.firstInputAccepted !== undefined && (value.firstInputAccepted !== true || !value.sendOperationId || value.objective)) throw new Error("The first-message confirmation is invalid.");
  if (value.collaborationHandled !== undefined && (value.collaborationHandled !== true || value.collaboration === undefined)) throw new Error("The retained collaboration preparation is invalid.");
  if (value.objective !== undefined ? value.sendOperationId !== undefined : value.objectiveRequestId !== undefined) {
    throw new Error("The retained task submission has conflicting input owners.");
  }
  return {
    phase: "sending",
    ...base,
    sessionId: value.sessionId,
    runtimeGeneration: value.runtimeGeneration,
    ...(value.firstInputAccepted ? { firstInputAccepted: true } : {}),
    ...(value.collaborationHandled === undefined ? {} : { collaborationHandled: true }),
    ...(value.sendOperationId === undefined ? {} : { sendOperationId: value.sendOperationId }),
    ...(value.objectiveRequestId === undefined ? {} : { objectiveRequestId: value.objectiveRequestId })
  };
}

function serializeRecord(identity: MobileNewTaskDraftIdentity, draft: MobileNewTaskDraft): string {
  const exact = normalizeDraft(draft);
  const serialized = JSON.stringify({
    version: 9,
    identity: normalizeIdentity(identity),
    draft: exact.submission === undefined
      ? exact
      : { ...cloneEditableDraft(exact), submission: persistedSubmission(exact.submission),
        ...(exact.conversation === undefined ? {} : { conversation: exact.conversation }) }
  });
  if (serialized.length > maximumStoredCharacters) throw new Error("The local Joko new-task draft is too large.");
  return serialized;
}

function readRecord(serialized: string, identity: MobileNewTaskDraftIdentity): MobileNewTaskDraft {
  if (serialized.length > maximumStoredCharacters) throw new Error("saved new-task draft is too large");
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || value["version"] !== 9 || !isRecord(value["identity"])
    || value["identity"]["profileId"] !== identity.profileId) {
    throw new Error("new-task draft identity mismatch");
  }
  const draft = value["draft"];
  if (!isRecord(draft) || typeof draft["targetId"] !== "string" || typeof draft["name"] !== "string"
    || !isRecord(draft["input"]) || !Array.isArray(draft["input"]["mentions"])
    || !Array.isArray(draft["input"]["atoms"]) || !Array.isArray(draft["input"]["slashCommands"])
    || !Array.isArray(draft["input"]["attachments"])) {
    throw new Error("invalid new-task draft envelope");
  }
  const editable = normalizeEditableDraft({
    targetId: draft["targetId"],
    name: draft["name"],
    input: draft["input"] as unknown as MobileComposerDraft,
    ...(draft["collaboration"] === undefined ? {} : { collaboration: draft["collaboration"] as unknown as MobileWorkerForm })
  });
  if (draft["submission"] === undefined) return editable;
  if (!isRecord(draft["submission"]) || "input" in draft["submission"]) {
    throw new Error("invalid new-task submission envelope");
  }
  const submission = { ...draft["submission"], input: editable.input } as unknown as MobileNewTaskSubmission;
  return normalizeDraft({ ...editable, submission,
    ...(draft["conversation"] === undefined ? {} : { conversation: draft["conversation"] as unknown as MobileNewTaskConversation }) });
}

function cloneDraft(draft: MobileNewTaskDraft): MobileNewTaskDraft {
  return {
    ...cloneEditableDraft(draft),
    ...(draft.submission === undefined ? {} : { submission: cloneSubmission(draft.submission) }),
    ...(draft.conversation === undefined ? {} : { conversation: normalizeConversation(draft.conversation) })
  };
}

function cloneSubmission(submission: MobileNewTaskSubmission): MobileNewTaskSubmission {
  return {
    ...submission,
    ...(submission.objective === undefined ? {} : { objective: normalizeMobileObjectiveInput(submission.objective) }),
    ...(submission.collaboration === undefined ? {} : { collaboration: normalizeMobileWorkerForm(submission.collaboration) }),
    model: submission.model === null ? null : { ...submission.model },
    input: cloneMobileComposerDraft(submission.input)
  };
}

function persistedSubmission(submission: MobileNewTaskSubmission): Omit<MobileNewTaskSubmission, "input"> {
  const { input: _input, ...persisted } = submission;
  return persisted;
}

function sameDraft(left: MobileNewTaskDraft, right: MobileNewTaskDraft): boolean {
  return left.targetId === right.targetId && left.name === right.name
    && JSON.stringify(left.collaboration) === JSON.stringify(right.collaboration)
    && JSON.stringify(left.conversation) === JSON.stringify(right.conversation)
    && mobileComposerDraftsEqual(left.input, right.input)
    && (left.submission === undefined && right.submission === undefined
      || left.submission !== undefined && right.submission !== undefined
        && sameSubmission(left.submission, right.submission));
}

function cloneEditableDraft(draft: MobileNewTaskEditableDraft): MobileNewTaskEditableDraft {
  return { targetId: draft.targetId, name: draft.name, input: cloneMobileComposerDraft(draft.input),
    ...(draft.collaboration === undefined ? {} : { collaboration: normalizeMobileWorkerForm(draft.collaboration) }) };
}

function normalizeNewTaskInput(value: MobileComposerDraft): MobileComposerDraft {
  const input = normalizeMobileComposerDraft(value);
  if (input.slashCommands.length > 0) {
    throw new Error("A selected slash command requires an existing task runtime.");
  }
  if (input.mentions.some((mention) => mention.kind === "resource" || mention.kind === "artifact")) {
    throw new Error("A new task can reference existing tasks and its selected Workspace, but not runtime Resources or Artifacts.");
  }
  return input;
}

function sameSubmission(left: MobileNewTaskSubmission, right: MobileNewTaskSubmission): boolean {
  if (left.phase !== right.phase || left.connectionId !== right.connectionId || left.serverId !== right.serverId
    || left.backendId !== right.backendId || left.targetId !== right.targetId
    || left.targetRevision !== right.targetRevision || left.targetRevisionEtag !== right.targetRevisionEtag
    || left.createOperationId !== right.createOperationId || left.displayName !== right.displayName
    || !sameNewTaskModelSelection(left.model, right.model)
    || !mobileComposerDraftsEqual(left.input, right.input)) return false;
  if (JSON.stringify(left.objective) !== JSON.stringify(right.objective) || JSON.stringify(left.collaboration) !== JSON.stringify(right.collaboration)) return false;
  return left.phase === "creating" && right.phase === "creating"
    || left.phase === "sending" && right.phase === "sending"
      && left.sessionId === right.sessionId && left.runtimeGeneration === right.runtimeGeneration
      && left.sendOperationId === right.sendOperationId && left.firstInputAccepted === right.firstInputAccepted
      && left.objectiveRequestId === right.objectiveRequestId && left.collaborationHandled === right.collaborationHandled;
}

function normalizeNewTaskModelSelection(
  value: MobileNewTaskModelSelection | null
): MobileNewTaskModelSelection | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") {
    throw new Error("The retained Joko new-task model selection is invalid.");
  }
  assertIdentity(value.providerId, "model Provider");
  assertIdentity(value.modelId, "model");
  if (value.effortId !== undefined) assertIdentity(value.effortId, "model effort");
  if (typeof value.fastMode !== "boolean" && value.fastMode !== "ultrafast") {
    throw new Error("The retained Joko new-task model selection is invalid.");
  }
  return {
    providerId: value.providerId,
    modelId: value.modelId,
    ...(value.effortId === undefined ? {} : { effortId: value.effortId }),
    fastMode: value.fastMode
  };
}

function sameNewTaskModelSelection(
  left: MobileNewTaskModelSelection | null,
  right: MobileNewTaskModelSelection | null
): boolean {
  return left === null && right === null
    || left !== null && right !== null
      && left.providerId === right.providerId && left.modelId === right.modelId
      && left.effortId === right.effortId && left.fastMode === right.fastMode;
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`The local Joko ${label} identity is invalid.`);
  }
}

function positiveDecimal(value: string, label: string): void {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`The retained Joko ${label} is invalid.`);
}

function hasComposerInput(input: MobileComposerDraft): boolean {
  return input.text.trim().length > 0 || input.attachments.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storageError(action: "read" | "write", cause: unknown): Error {
  const error = new Error(`The saved new-task draft could not be ${action === "read" ? "read" : "written"}. Your current text was kept in memory.`);
  error.name = "MobileNewTaskDraftStorageError";
  if (cause instanceof Error) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export const mobileNewTaskDraftTesting = {
  persistDebounceMilliseconds,
  storageKey
};
