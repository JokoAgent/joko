export interface DeferredBackendRestartState {
  readonly pending: boolean;
  readonly applying: boolean;
  readonly lastError: string;
}

interface PendingRestart {
  token: number;
  applying: boolean;
  lastError: string;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Coalesces spawn-time Backend changes without interrupting accepted work.
 * Durable desired state remains in the owning settings row; this class owns
 * only process-local application timing and never persists credentials.
 */
export class DeferredBackendRestartCoordinator {
  readonly #pending = new Map<string, PendingRestart>();
  readonly #retiredBlocks = new Set<string>();
  readonly #restart: (backendId: string) => Promise<void>;
  readonly #canRestart: (backendId: string) => boolean;
  readonly #wakeQueues: (backendId: string) => void;
  readonly #retryDelayMs: number;
  #disposed = false;

  constructor(options: {
    readonly restart: (backendId: string) => Promise<void>;
    readonly canRestart: (backendId: string) => boolean;
    readonly wakeQueues: (backendId: string) => void;
    readonly retryDelayMs?: number;
  }) {
    this.#restart = options.restart;
    this.#canRestart = options.canRestart;
    this.#wakeQueues = options.wakeQueues;
    this.#retryDelayMs = options.retryDelayMs ?? 10_000;
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 1) {
      throw new TypeError("Deferred Backend restart delay must be a positive integer.");
    }
  }

  state(backendId: string): DeferredBackendRestartState {
    const state = this.#pending.get(backendId);
    return {
      pending: state !== undefined,
      applying: state?.applying === true,
      lastError: state?.lastError ?? ""
    };
  }

  blocksDispatch(backendId: string): boolean {
    return this.#pending.has(backendId) || this.#retiredBlocks.has(backendId);
  }

  /** Install the queue hold synchronously after durable desired-state commit. */
  request(backendId: string): void {
    if (this.#disposed) throw new Error("Deferred Backend restart coordinator is closed.");
    if (backendId.trim() === "" || backendId.length > 128) throw new TypeError("Backend ID is invalid.");
    const current = this.#pending.get(backendId);
    if (current === undefined) {
      const state = { token: 1, applying: false, lastError: "" } satisfies PendingRestart;
      this.#pending.set(backendId, state);
      this.#scheduleRetry(backendId, state, 0);
    } else {
      current.token += 1;
      current.lastError = "";
      if (current.timer !== undefined) {
        clearTimeout(current.timer);
        current.timer = undefined;
      }
      this.#scheduleRetry(backendId, current, 0);
    }
  }

  async apply(backendId: string): Promise<void> {
    await this.#tryApply(backendId);
  }

  /** Cancel only a waiting hold; an in-flight generation must finish its token fence. */
  cancelIfWaiting(backendId: string): boolean {
    const state = this.#pending.get(backendId);
    if (state === undefined || state.applying) return false;
    if (state.timer !== undefined) clearTimeout(state.timer);
    this.#pending.delete(backendId);
    this.#wakeQueues(backendId);
    return true;
  }

  async schedule(backendId: string): Promise<void> {
    this.request(backendId);
    await this.#tryApply(backendId);
  }

  onBackendMayBeIdle(backendId: string): void {
    if (this.#disposed || !this.#pending.has(backendId)) return;
    void this.#tryApply(backendId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [backendId, state] of this.#pending) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      // The owning SessionHost retires later in application shutdown. Keep
      // accepted work fenced from the stale process generation until then;
      // the next service process reconstructs desired state from Store.
      this.#retiredBlocks.add(backendId);
    }
    this.#pending.clear();
  }

  async #tryApply(backendId: string): Promise<void> {
    const state = this.#pending.get(backendId);
    if (this.#disposed || state === undefined || state.applying) return;
    if (!this.#canRestart(backendId)) {
      this.#scheduleRetry(backendId, state);
      return;
    }
    const token = state.token;
    state.applying = true;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    try {
      await this.#restart(backendId);
      if (this.#disposed || this.#pending.get(backendId) !== state) return;
      if (state.token !== token) {
        state.applying = false;
        this.#scheduleRetry(backendId, state, 0);
        return;
      }
      this.#pending.delete(backendId);
      this.#wakeQueues(backendId);
    } catch (error) {
      if (this.#disposed || this.#pending.get(backendId) !== state) return;
      state.lastError = error instanceof Error ? error.message : "Backend replacement failed.";
      this.#scheduleRetry(backendId, state);
    } finally {
      if (this.#pending.get(backendId) === state) state.applying = false;
    }
  }

  #scheduleRetry(backendId: string, state: PendingRestart, delay = this.#retryDelayMs): void {
    if (this.#disposed || this.#pending.get(backendId) !== state || state.timer !== undefined) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.#disposed || this.#pending.get(backendId) !== state) return;
      void this.#tryApply(backendId);
    }, delay);
  }
}
