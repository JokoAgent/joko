export interface SessionScopedRequest {
  readonly sessionId: string;
  readonly epoch: number;
  release(): void;
}

/**
 * Compact confirmation is scoped to the committed session and is
 * single-flight per committed session epoch. A route-away/route-back creates
 * a new epoch so a late confirmation from the previous view can never compact
 * the new view.
 */
export class SessionScopedRequestGuard {
  readonly #inFlight = new Set<string>();
  #currentSessionId: string | null = null;
  #epoch = 0;

  setCurrentSession(sessionId: string | null): void {
    if (this.#currentSessionId === sessionId) return;
    this.#currentSessionId = sessionId;
    this.#epoch += 1;
  }

  tryBegin(sessionId: string): SessionScopedRequest | undefined {
    const requestKey = this.#requestKey(sessionId, this.#epoch);
    if (this.#currentSessionId !== sessionId || this.#inFlight.has(requestKey)) return undefined;
    this.#inFlight.add(requestKey);
    const epoch = this.#epoch;
    let released = false;
    return {
      sessionId,
      epoch,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight.delete(requestKey);
      }
    };
  }

  isCurrent(sessionId: string, epoch?: number): boolean {
    return this.#currentSessionId === sessionId && (epoch === undefined || epoch === this.#epoch);
  }

  isInFlight(sessionId: string): boolean {
    return this.#currentSessionId === sessionId && this.#inFlight.has(this.#requestKey(sessionId, this.#epoch));
  }

  #requestKey(sessionId: string, epoch: number): string {
    return `${sessionId}\u0000${epoch}`;
  }
}
