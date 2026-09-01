import type { BackgroundTaskActivityView, ConnectionProfile, SessionView } from "./model.js";

export const PROMPT_RECOMMENDATION_SETTLE_MS = 500;

export function promptRecommendationOwnerKey(profile: ConnectionProfile | undefined): string | undefined {
  return profile === undefined
    ? undefined
    : `${profile.serverId}\0${profile.id}`;
}

export interface PromptRecommendationFence {
  readonly sessionId: string;
  readonly generation: bigint;
  readonly updatedAt: number;
}

export interface PromptRecommendationStoreState extends PromptRecommendationFence {
  readonly phase: "settling" | "candidate" | "requesting" | "ready";
  readonly text?: string;
}

interface Entry extends PromptRecommendationStoreState {
  readonly requestId: number;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

interface ObservedSession extends PromptRecommendationFence {
  readonly state: SessionView["state"];
  readonly backgroundActive: boolean;
}

type PredictionRequest = (fence: PromptRecommendationFence) => Promise<string>;

/**
 * Renderer-only prompt recommendation store. It observes
 * every Session rather than the mounted Composer, settles terminal snapshots,
 * and keeps predictions keyed by their Session fence. Nothing is persisted.
 */
export class PromptRecommendationStore {
  readonly #settleMs: number;
  readonly #observed = new Map<string, ObservedSession>();
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  #active = false;
  #revision = 0;
  #nextRequestId = 0;

  constructor(settleMs = PROMPT_RECOMMENDATION_SETTLE_MS) {
    this.#settleMs = settleMs;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getRevision = (): number => this.#revision;

  observe(
    sessions: readonly SessionView[],
    setting: { readonly enabled: boolean; readonly available: boolean },
    backgroundTasks: readonly BackgroundTaskActivityView[] = []
  ): void {
    const active = setting.enabled && setting.available;
    if (!active && this.#active) this.#clearEntries();
    this.#active = active;
    const seen = new Set<string>();
    const backgroundActiveBySession = new Set(backgroundTasks
      .filter((task) => backgroundTaskIsActive(task.state))
      .map((task) => task.sessionId));

    for (const session of sessions) {
      seen.add(session.id);
      const next: ObservedSession = {
        sessionId: session.id,
        generation: session.generation,
        updatedAt: session.updatedAt,
        state: session.state,
        backgroundActive: backgroundActiveBySession.has(session.id)
      };
      const previous = this.#observed.get(session.id);
      const previousRunning = previous !== undefined && observationIsRunning(previous);
      const nextRunning = observationIsRunning(next);
      const entry = this.#entries.get(session.id);

      if (nextRunning) {
        if (!sameObservation(previous, next) || entry !== undefined) this.#deleteEntry(session.id);
      } else if (previousRunning && next.state === "idle" && active) {
        this.#schedule(next);
      } else if (entry !== undefined && !sameFence(entry, next)) {
        if (entry.phase === "settling" && next.state === "idle" && active) this.#schedule(next);
        else this.#deleteEntry(session.id);
      }
      this.#observed.set(session.id, next);
    }

    for (const sessionId of [...this.#observed.keys()]) {
      if (seen.has(sessionId)) continue;
      this.#observed.delete(sessionId);
      this.#deleteEntry(sessionId);
    }
  }

  request(
    sessionId: string,
    generation: bigint,
    updatedAt: number,
    request: PredictionRequest
  ): void {
    const entry = this.#entries.get(sessionId);
    if (!this.#active || entry?.phase !== "candidate" || !sameFence(entry, { sessionId, generation, updatedAt })) return;
    const requesting: Entry = { ...entry, phase: "requesting" };
    this.#entries.set(sessionId, requesting);
    this.#emit();
    void Promise.resolve().then(() => request({ sessionId, generation, updatedAt })).then((value) => {
      const current = this.#entries.get(sessionId);
      if (current !== requesting || !this.#active || !this.#fenceIsCurrent(requesting)) return;
      const text = value.trim();
      if (text.length === 0) this.#entries.delete(sessionId);
      else this.#entries.set(sessionId, { ...requesting, phase: "ready", text });
      this.#emit();
    }).catch(() => {
      if (this.#entries.get(sessionId) !== requesting) return;
      this.#entries.delete(sessionId);
      this.#emit();
    });
  }

  recommendation(sessionId: string, generation: bigint, updatedAt: number): string | undefined {
    const entry = this.#entries.get(sessionId);
    return entry?.phase === "ready" && sameFence(entry, { sessionId, generation, updatedAt })
      ? entry.text
      : undefined;
  }

  inspect(sessionId: string): PromptRecommendationStoreState | undefined {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return undefined;
    const { timer: _timer, requestId: _requestId, ...state } = entry;
    return state;
  }

  dismiss(sessionId: string): void {
    this.#deleteEntry(sessionId);
  }

  reset(): void {
    this.#active = false;
    this.#observed.clear();
    this.#clearEntries();
  }

  #schedule(session: ObservedSession): void {
    this.#deleteEntry(session.sessionId, false);
    const requestId = ++this.#nextRequestId;
    const timer = setTimeout(() => {
      const entry = this.#entries.get(session.sessionId);
      if (
        entry?.requestId !== requestId ||
        entry.phase !== "settling" ||
        !this.#active ||
        !this.#fenceIsCurrent(entry)
      ) return;
      this.#entries.set(session.sessionId, { ...entry, phase: "candidate", timer: undefined });
      this.#emit();
    }, this.#settleMs);
    this.#entries.set(session.sessionId, {
      sessionId: session.sessionId,
      generation: session.generation,
      updatedAt: session.updatedAt,
      phase: "settling",
      requestId,
      timer
    });
  }

  #fenceIsCurrent(entry: PromptRecommendationFence): boolean {
    const observed = this.#observed.get(entry.sessionId);
    return observed !== undefined && observed.state === "idle" && !observed.backgroundActive && sameFence(entry, observed);
  }

  #deleteEntry(sessionId: string, emit = true): void {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.#entries.delete(sessionId);
    if (emit) this.#emit();
  }

  #clearEntries(): void {
    if (this.#entries.size === 0) return;
    for (const entry of this.#entries.values()) if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.#entries.clear();
    this.#emit();
  }

  #emit(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}

function isRunning(state: SessionView["state"]): boolean {
  return state === "running" || state === "waiting" || state === "retrying";
}

function observationIsRunning(observation: ObservedSession): boolean {
  return observation.backgroundActive || isRunning(observation.state);
}

function backgroundTaskIsActive(state: BackgroundTaskActivityView["state"]): boolean {
  return state === "queued" || state === "running" || state === "waiting" || state === "unknown";
}

function sameFence(left: PromptRecommendationFence, right: PromptRecommendationFence): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation && left.updatedAt === right.updatedAt;
}

function sameObservation(left: ObservedSession | undefined, right: ObservedSession): boolean {
  return left !== undefined && left.state === right.state && left.backgroundActive === right.backgroundActive && sameFence(left, right);
}

export const promptRecommendationStore = new PromptRecommendationStore();
