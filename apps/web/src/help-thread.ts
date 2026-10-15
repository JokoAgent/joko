import type { HelpAnswerView, HelpFeedbackDraftView, HelpMessageView } from "./model.js";
import { randomUuid } from "./web-crypto.js";

export interface HelpThreadMessage extends HelpMessageView {
  readonly id: string;
  readonly settingsSection?: string;
  readonly feedbackDraftId?: string;
  readonly feedbackAttempt?: HelpFeedbackDraftView;
}
export interface HelpThreadState { readonly messages: readonly HelpThreadMessage[]; readonly pending: boolean }
export interface HelpThreadPort {
  askHelp(messages: readonly HelpMessageView[], locale: string, signal?: AbortSignal): Promise<HelpAnswerView>;
}

/** One private thread per connected node/profile. Only stable turns survive a restart. */
export class HelpThread {
  readonly #key: string;
  readonly #storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  readonly #listeners = new Set<() => void>();
  #state: HelpThreadState = { messages: [], pending: false };
  #flight: AbortController | undefined;
  #epoch = 0;
  constructor(owner: string, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
    this.#key = `joko.help-thread.v1:${owner}`;
    this.#storage = storage;
    try {
      const raw = storage?.getItem(this.#key);
      if (raw === undefined || raw === null || raw.length > 500_000) return;
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || !("messages" in value) || !Array.isArray(value.messages)
        || !value.messages.every(isMessage)) return;
      this.#state = { messages: truncate(value.messages), pending: false };
    } catch { /* Disabled or unavailable browser storage retains the in-memory thread. */ }
  }
  readonly subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  readonly snapshot = (): HelpThreadState => this.#state;
  reset(): void {
    this.retire();
    this.#set({ messages: [], pending: false });
    try { this.#storage?.removeItem(this.#key); } catch { /* Memory remains authoritative for this window. */ }
  }
  retire(): void {
    this.#epoch += 1;
    this.#flight?.abort();
    this.#flight = undefined;
    if (this.#state.pending) this.#set({ ...this.#state, pending: false });
  }
  markFeedback(id: string, patch: Pick<HelpThreadMessage, "feedbackAttempt" | "feedbackDraftId">): void {
    this.#set({ ...this.#state, messages: this.#state.messages.map((message) => message.id === id && message.role === "assistant"
      ? { ...message, ...patch } : message) });
  }
  async ask(port: HelpThreadPort, content: string, locale: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 16_000 || this.#state.pending) return;
    const flight = new AbortController(), epoch = this.#epoch;
    this.#flight = flight;
    const messages = truncate([...this.#state.messages, { id: randomUuid(), role: "user", content: trimmed }]);
    this.#set({ messages, pending: true });
    let answer: HelpAnswerView;
    try { answer = await port.askHelp(messages.map(({ role, content: text }) => ({ role, content: text })), locale, flight.signal); }
    catch { answer = { kind: "noAnswer" }; }
    if (epoch !== this.#epoch || flight.signal.aborted || this.#flight !== flight) return;
    this.#flight = undefined;
    this.#set({ pending: false, messages: truncate([...messages, { id: randomUuid(), role: "assistant",
      content: answer.kind === "answer" ? answer.text : "",
      ...(answer.kind === "answer" && answer.settingsSection !== undefined ? { settingsSection: answer.settingsSection } : {})
    }]) });
  }
  #set(state: HelpThreadState): void {
    this.#state = state;
    try { this.#storage?.setItem(this.#key, JSON.stringify({ messages: state.messages })); } catch { /* Preserve interactive use without persistence. */ }
    for (const listener of this.#listeners) listener();
  }
}

function truncate(messages: readonly HelpThreadMessage[]): readonly HelpThreadMessage[] {
  const next = messages.slice(-12);
  while (next.length > 0 && next[0]?.role !== "user") next.shift();
  return next;
}

function isMessage(value: unknown): value is HelpThreadMessage {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<HelpThreadMessage>;
  return typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256
    && (row.role === "user" || row.role === "assistant") && typeof row.content === "string" && row.content.length <= 24_000
    && (row.settingsSection === undefined || typeof row.settingsSection === "string")
    && (row.feedbackDraftId === undefined || typeof row.feedbackDraftId === "string")
    && (row.feedbackAttempt === undefined || (typeof row.feedbackAttempt === "object" && row.feedbackAttempt !== null
      && [row.feedbackAttempt.requestId, row.feedbackAttempt.question, row.feedbackAttempt.answer, row.feedbackAttempt.title,
        row.feedbackAttempt.body, row.feedbackAttempt.locale].every((field) => typeof field === "string" && field.length <= 32_000)));
}
