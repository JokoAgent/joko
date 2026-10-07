import type { InteractionResolutionDraft, InteractionView } from "../model.js";
import { validQuestionAnswer } from "../components/coding-ui-behavior.js";

export const VISUAL_INTERACTION_SETTLE_EVENT = "joko-visual-interaction-settle";
let nextFixtureOwner = 0;

export interface VisualInteractionAttempt {
  readonly interactionId: string;
  readonly kind: InteractionView["kind"];
  readonly attempt: number;
  readonly action: "resolve" | "dismiss";
  readonly decisionId?: string;
  readonly answeredFieldIds?: readonly string[];
  readonly feedbackLength?: number;
}

export interface VisualInteractionState {
  readonly ownerId: string;
  readonly activeId?: string;
  readonly phase: "ready" | "pending" | "failed" | "completed";
  readonly attempt: number;
  readonly totalAttempts: number;
  readonly failedAttempts: number;
  readonly pending?: VisualInteractionAttempt;
  readonly confirmed: readonly VisualInteractionAttempt[];
}

interface PendingInteraction {
  readonly value: VisualInteractionAttempt;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Only the development harness owns these bounded, memory-only requests. */
export class VisualInteractionFixture {
  readonly #ownerId = `visual-interaction-owner-${++nextFixtureOwner}`;
  readonly #requests: readonly InteractionView[];
  readonly #listeners = new Set<(state: VisualInteractionState) => void>();
  readonly #attempts = new Map<string, number>();
  readonly #confirmed: VisualInteractionAttempt[] = [];
  #index = 0;
  #totalAttempts = 0;
  #failedAttempts = 0;
  #phase: VisualInteractionState["phase"] = "ready";
  #pending?: PendingInteraction;

  constructor(requests: readonly InteractionView[]) { this.#requests = requests; }

  get current(): InteractionView | undefined { return this.#requests[this.#index]; }

  get state(): VisualInteractionState {
    const activeId = this.#requests[this.#index]?.id;
    return {
      ownerId: this.#ownerId,
      ...(activeId === undefined ? {} : { activeId }),
      phase: this.#phase,
      attempt: activeId === undefined ? 0 : this.#attempts.get(activeId) ?? 0,
      totalAttempts: this.#totalAttempts,
      failedAttempts: this.#failedAttempts,
      ...(this.#pending === undefined ? {} : { pending: this.#pending.value }),
      confirmed: [...this.#confirmed]
    };
  }

  subscribe(listener: (state: VisualInteractionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  begin(interaction: InteractionView, resolution?: InteractionResolutionDraft): Promise<void> {
    const current = this.#requests[this.#index];
    if (current === undefined || current.id !== interaction.id || current.sessionId !== interaction.sessionId
      || current.generation !== interaction.generation || current.kind !== interaction.kind) {
      return Promise.reject(new Error("The deterministic interaction source changed."));
    }
    if (this.#pending !== undefined) return Promise.reject(new Error("The deterministic interaction is already pending."));
    if (resolution !== undefined && (resolution.kind !== current.kind
      || (resolution.kind === "permission" || resolution.kind === "plan")
        && !current.options.some((option) => option.id === resolution.decisionId)
      || resolution.kind === "question" && (Object.keys(resolution.answers).some((id) => !current.fields.some((field) => field.id === id))
        || !current.fields.every((field) => validQuestionAnswer(field, resolution.answers[field.id]))))) {
      return Promise.reject(new Error("The deterministic interaction decision is invalid."));
    }
    const attempt = (this.#attempts.get(current.id) ?? 0) + 1;
    this.#attempts.set(current.id, attempt);
    this.#totalAttempts += 1;
    const value: VisualInteractionAttempt = {
      interactionId: current.id, kind: current.kind, attempt,
      action: resolution === undefined ? "dismiss" : "resolve",
      ...(resolution?.kind === "permission" || resolution?.kind === "plan" ? { decisionId: resolution.decisionId } : {}),
      ...(resolution?.kind === "question" ? { answeredFieldIds: Object.keys(resolution.answers) } : {}),
      ...(resolution?.kind === "plan" ? { feedbackLength: resolution.feedback.length } : {})
    };
    this.#phase = "pending";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.value === value) this.#failPending(new Error("The deterministic interaction request timed out. Retry the decision."));
      }, 60_000);
      this.#pending = { value, resolve, reject, timer };
      this.#publish();
    });
  }

  settle(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const detail = value as Record<string, unknown>;
    const pending = this.#pending;
    if (pending === undefined || detail.ownerId !== this.#ownerId
      || detail.interactionId !== pending.value.interactionId || detail.attempt !== pending.value.attempt
      || (detail.outcome !== "failure" && detail.outcome !== "success")) return false;
    if (detail.outcome === "failure") {
      this.#failPending(new Error("The deterministic interaction request failed. Retry the same decision."));
    } else {
      clearTimeout(pending.timer);
      this.#pending = undefined;
      this.#confirmed.push(pending.value);
      this.#index += 1;
      this.#phase = this.#index === this.#requests.length ? "completed" : "ready";
      this.#publish();
      pending.resolve();
    }
    return true;
  }

  /** Cleanup may run during a development StrictMode probe; no old pending survives it. */
  cancelPending(): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    this.#phase = "ready";
    this.#publish();
    pending.reject(new Error("The deterministic interaction owner retired."));
  }

  #failPending(error: Error): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    this.#failedAttempts += 1;
    this.#phase = "failed";
    this.#publish();
    pending.reject(error);
  }

  #publish(): void { for (const listener of this.#listeners) listener(this.state); }
}
