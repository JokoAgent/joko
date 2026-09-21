import type { MobilePlainStorageDriver } from "./connection-storage";
import type { Interaction } from "@joko/contracts";
import type { MobileInteractionDraft, MobileQuestionAnswerDraft } from "./mobile-interactions";

export interface MobileInteractionDraftIdentity {
  readonly profileId: string;
  readonly sessionId: string;
  readonly interactionId: string;
  readonly kind: "question" | "plan";
  readonly generation: bigint;
  readonly revision: bigint;
}

export type MobileInteractionDraftErrorListener = (
  identity: MobileInteractionDraftIdentity,
  error: Error
) => void;

const storagePrefix = "joko.mobile.interaction-draft.v1";
const persistDebounceMilliseconds = 400;
const maximumStoredCharacters = 1_000_000;

export class MobileInteractionDraftStore {
  readonly #memory = new Map<string, MobileInteractionDraft>();
  readonly #cleared = new Set<string>();
  readonly #dirty = new Set<string>();
  readonly #identities = new Map<string, MobileInteractionDraftIdentity>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #listeners = new Set<MobileInteractionDraftErrorListener>();

  constructor(readonly driver: MobilePlainStorageDriver) {}

  subscribeErrors(listener: MobileInteractionDraftErrorListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  readSync(identity: MobileInteractionDraftIdentity): MobileInteractionDraft | null {
    const key = identityKey(identity);
    if (this.#cleared.has(key)) return null;
    const draft = this.#memory.get(key);
    return draft === undefined ? null : cloneDraft(draft);
  }

  async read(identity: MobileInteractionDraftIdentity): Promise<MobileInteractionDraft | null> {
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

  save(identity: MobileInteractionDraftIdentity, draft: MobileInteractionDraft): void {
    const exact = normalizeIdentity(identity);
    const value = normalizeDraft(draft, exact.kind);
    const serialized = serializeRecord(exact, value);
    const key = identityKey(exact);
    this.#cancelTimer(key);
    this.#memory.set(key, value);
    this.#cleared.delete(key);
    this.#dirty.add(key);
    this.#identities.set(key, exact);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      void this.#persistIfCurrent(exact, value, serialized).catch(() => undefined);
    }, persistDebounceMilliseconds);
    this.#timers.set(key, timer);
  }

  async clear(identity: MobileInteractionDraftIdentity): Promise<void> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    this.#cancelTimer(key);
    this.#memory.delete(key);
    this.#cleared.add(key);
    this.#dirty.add(key);
    this.#identities.set(key, exact);
    await this.#removeIfCurrent(exact);
  }

  async flush(identity?: MobileInteractionDraftIdentity): Promise<void> {
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

  async #persistIfCurrent(
    identity: MobileInteractionDraftIdentity,
    draft: MobileInteractionDraft,
    serialized: string
  ): Promise<void> {
    const key = identityKey(identity);
    const current = this.#memory.get(key);
    if (this.#cleared.has(key) || current === undefined || !sameDraft(current, draft)) return;
    await this.#enqueue(identity, () => this.driver.setItem(storageKey(identity), serialized));
    const latest = this.#memory.get(key);
    if (!this.#cleared.has(key) && latest !== undefined && sameDraft(latest, draft)) this.#dirty.delete(key);
  }

  async #removeIfCurrent(identity: MobileInteractionDraftIdentity): Promise<void> {
    const key = identityKey(identity);
    if (!this.#cleared.has(key) || this.#memory.has(key)) return;
    await this.#enqueue(identity, () => this.driver.removeItem(storageKey(identity)));
    if (this.#cleared.has(key) && !this.#memory.has(key)) this.#dirty.delete(key);
  }

  #enqueue(identity: MobileInteractionDraftIdentity, effect: () => Promise<void>): Promise<void> {
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

  #notify(identity: MobileInteractionDraftIdentity, error: Error): void {
    for (const listener of this.#listeners) listener(identity, error);
  }
}

export function mobileInteractionDraftIdentityKey(identity: MobileInteractionDraftIdentity): string {
  return identityKey(identity);
}

export function mobileInteractionDraftIdentity(
  profileId: string | undefined,
  interaction: Interaction | undefined
): MobileInteractionDraftIdentity | undefined {
  if (!profileId || !interaction?.version?.revision) return undefined;
  const kind = interaction.request.case === "question" ? "question" : interaction.request.case === "planReview" ? "plan" : undefined;
  if (!kind) return undefined;
  return {
    profileId,
    sessionId: interaction.sessionId,
    interactionId: interaction.interactionId,
    kind,
    generation: interaction.generation,
    revision: interaction.version.revision.value
  };
}

function normalizeIdentity(identity: MobileInteractionDraftIdentity): MobileInteractionDraftIdentity {
  assertIdentity(identity.profileId, "connection profile");
  assertIdentity(identity.sessionId, "task");
  assertIdentity(identity.interactionId, "request");
  if (identity.kind !== "question" && identity.kind !== "plan") throw new Error("The local Joko request draft kind is invalid.");
  if (identity.generation < 1n || identity.revision < 1n) throw new Error("The local Joko request draft version is invalid.");
  return { ...identity };
}

function identityKey(identity: MobileInteractionDraftIdentity): string {
  const exact = normalizeIdentity(identity);
  return [exact.profileId, exact.sessionId, exact.interactionId, exact.kind,
    exact.generation.toString(10), exact.revision.toString(10)].join("\u001f");
}

function storageKey(identity: MobileInteractionDraftIdentity): string {
  return `${storagePrefix}.${[
    identity.profileId,
    identity.sessionId,
    identity.interactionId,
    identity.kind,
    identity.generation.toString(10),
    identity.revision.toString(10)
  ].map(encodeURIComponent).join(".")}`;
}

function serializeRecord(identity: MobileInteractionDraftIdentity, draft: MobileInteractionDraft): string {
  const serialized = JSON.stringify({
    version: 1,
    identity: {
      profileId: identity.profileId,
      sessionId: identity.sessionId,
      interactionId: identity.interactionId,
      kind: identity.kind,
      generation: identity.generation.toString(10),
      revision: identity.revision.toString(10)
    },
    draft
  });
  if (serialized.length > maximumStoredCharacters) throw new Error("The local Joko request draft is too large.");
  return serialized;
}

function readRecord(serialized: string, identity: MobileInteractionDraftIdentity): MobileInteractionDraft {
  if (serialized.length > maximumStoredCharacters) throw new Error("saved request draft is too large");
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["identity"])) throw new Error("invalid request draft envelope");
  const saved = value["identity"];
  if (saved["profileId"] !== identity.profileId || saved["sessionId"] !== identity.sessionId
    || saved["interactionId"] !== identity.interactionId || saved["kind"] !== identity.kind
    || saved["generation"] !== identity.generation.toString(10) || saved["revision"] !== identity.revision.toString(10)) {
    throw new Error("request draft identity mismatch");
  }
  return normalizeDraft(value["draft"], identity.kind);
}

function normalizeDraft(value: unknown, kind: MobileInteractionDraftIdentity["kind"]): MobileInteractionDraft {
  if (!isRecord(value) || value["kind"] !== kind) throw new Error("The local Joko request draft does not match its request.");
  if (kind === "plan") {
    if (Reflect.ownKeys(value).some((key) => key !== "kind" && key !== "feedback") || typeof value["feedback"] !== "string") {
      throw new Error("The local Joko plan draft is invalid.");
    }
    boundedText(value["feedback"]);
    return { kind: "plan", feedback: value["feedback"] };
  }
  if (Reflect.ownKeys(value).some((key) => key !== "kind" && key !== "fieldIndex" && key !== "answers")
    || !Number.isSafeInteger(value["fieldIndex"]) || (value["fieldIndex"] as number) < 0
    || !isRecord(value["answers"])) {
    throw new Error("The local Joko question draft is invalid.");
  }
  const entries = Object.entries(value["answers"]);
  if (entries.length > 256) throw new Error("The local Joko question draft has too many fields.");
  const answers: Record<string, MobileQuestionAnswerDraft> = {};
  for (const [fieldId, answer] of entries) {
    assertIdentity(fieldId, "question field");
    answers[fieldId] = normalizeAnswer(answer);
  }
  return { kind: "question", fieldIndex: value["fieldIndex"] as number, answers };
}

function normalizeAnswer(value: unknown): MobileQuestionAnswerDraft {
  if (!isRecord(value) || typeof value["kind"] !== "string") throw new Error("The local Joko question answer is invalid.");
  if (value["kind"] === "text" || value["kind"] === "boolean") {
    if (Reflect.ownKeys(value).some((key) => key !== "kind" && key !== "value")) throw new Error("The local Joko question answer is invalid.");
    if (value["kind"] === "text" && typeof value["value"] === "string") {
      boundedText(value["value"]);
      return { kind: "text", value: value["value"] };
    }
    if (value["kind"] === "boolean" && typeof value["value"] === "boolean") return { kind: "boolean", value: value["value"] };
    throw new Error("The local Joko question answer is invalid.");
  }
  if (value["kind"] === "single") {
    if (Reflect.ownKeys(value).some((key) => key !== "kind" && key !== "selection") || !isRecord(value["selection"])) {
      throw new Error("The local Joko single-choice answer is invalid.");
    }
    const selection = value["selection"];
    if (selection["kind"] === "choice" && typeof selection["choiceId"] === "string"
      && Reflect.ownKeys(selection).every((key) => key === "kind" || key === "choiceId")) {
      assertIdentity(selection["choiceId"], "question choice");
      return { kind: "single", selection: { kind: "choice", choiceId: selection["choiceId"] } };
    }
    if (selection["kind"] === "other" && typeof selection["text"] === "string"
      && Reflect.ownKeys(selection).every((key) => key === "kind" || key === "text")) {
      boundedText(selection["text"]);
      return { kind: "single", selection: { kind: "other", text: selection["text"] } };
    }
    throw new Error("The local Joko single-choice answer is invalid.");
  }
  if (value["kind"] !== "multiple" || !Array.isArray(value["choiceIds"])
    || value["choiceIds"].length > 512 || value["choiceIds"].some((choiceId) => typeof choiceId !== "string")
    || (value["otherText"] !== undefined && typeof value["otherText"] !== "string")
    || Reflect.ownKeys(value).some((key) => key !== "kind" && key !== "choiceIds" && key !== "otherText")) {
    throw new Error("The local Joko multiple-choice answer is invalid.");
  }
  const choiceIds = value["choiceIds"] as string[];
  for (const choiceId of choiceIds) assertIdentity(choiceId, "question choice");
  if (value["otherText"] !== undefined) boundedText(value["otherText"]);
  return { kind: "multiple", choiceIds: [...choiceIds], ...(value["otherText"] === undefined ? {} : { otherText: value["otherText"] }) };
}

function cloneDraft(draft: MobileInteractionDraft): MobileInteractionDraft {
  if (draft.kind === "plan") return { ...draft };
  return {
    ...draft,
    answers: Object.fromEntries(Object.entries(draft.answers).map(([fieldId, answer]) => [fieldId, cloneAnswer(answer)]))
  };
}

function cloneAnswer(answer: MobileQuestionAnswerDraft): MobileQuestionAnswerDraft {
  if (answer.kind === "single") return { ...answer, selection: { ...answer.selection } };
  if (answer.kind === "multiple") return { ...answer, choiceIds: [...answer.choiceIds] };
  return { ...answer };
}

function sameDraft(left: MobileInteractionDraft, right: MobileInteractionDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`The local Joko ${label} identity is invalid.`);
  }
}

function boundedText(value: string): void {
  if (value.length > maximumStoredCharacters) throw new Error("The local Joko request draft is too large.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storageError(action: "read" | "write", cause: unknown): Error {
  const error = new Error(`The saved request draft could not be ${action === "read" ? "read" : "written"}. Your current response was kept in memory.`);
  error.name = "MobileInteractionDraftStorageError";
  if (cause instanceof Error) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export const mobileInteractionDraftTesting = {
  persistDebounceMilliseconds,
  storageKey
};
