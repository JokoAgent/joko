import { nativeFileActionSequence } from "@joko/contracts";

const RECEIPT_WINDOW = 1_024;

export interface NativeFileActionScope {
  readonly id: string;
  readonly isCurrent: () => boolean;
}

interface Request<T> {
  readonly id: string;
  readonly digest: string;
  readonly abort: AbortController;
  readonly result: Promise<T>;
  settled: boolean;
}

interface Scope<T> {
  readonly owner: NativeFileActionScope;
  readonly requests: Map<number, Request<T>>;
  maximum: number;
}

/** Bounded receipts; a retired ordinal can never become a new external action. */
export class NativeFileActionRequests<T> {
  readonly #scopes = new Map<string, Scope<T>>();
  readonly #retired = new WeakSet<NativeFileActionScope>();
  readonly #pending = new Set<Request<T>>();

  get pendingCount(): number { return this.#pending.size; }

  /** false means retired, including old IDs whose receipt has left the window. */
  replay(scope: NativeFileActionScope, id: string, digest: string): Promise<T> | false | undefined {
    const ordinal = sequence(id);
    if (this.#retired.has(scope)) return false;
    const state = this.#scopes.get(scope.id);
    if (state === undefined) return undefined;
    if (state.owner !== scope) return false;
    const existing = state.requests.get(ordinal);
    if (existing !== undefined) {
      if (existing.id !== id || existing.digest !== digest) {
        throw new TypeError("The native file action identity was reused with different content.");
      }
      return existing.result;
    }
    return ordinal <= state.maximum - RECEIPT_WINDOW ? false : undefined;
  }

  add(scope: NativeFileActionScope, id: string, digest: string, abort: AbortController, result: Promise<T>): void {
    const ordinal = sequence(id);
    let state = this.#scopes.get(scope.id);
    if (state === undefined) {
      state = { owner: scope, requests: new Map(), maximum: ordinal };
      this.#scopes.set(scope.id, state);
    }
    state.maximum = Math.max(state.maximum, ordinal);
    const request = { id, digest, abort, result, settled: false };
    state.requests.set(ordinal, request);
    this.#pending.add(request);
    this.#prune(state);
    const receiptScope = state;
    const settle = (): void => {
      request.settled = true;
      this.#pending.delete(request);
      this.#prune(receiptScope);
    };
    void result.then(settle, settle);
  }

  cancel(scopeId: string, id: string): void {
    const request = this.#scopes.get(scopeId)?.requests.get(sequence(id));
    if (request?.id === id) request.abort.abort();
  }

  retireScope(scopeId: string): void {
    const state = this.#scopes.get(scopeId);
    if (state === undefined) return;
    this.#retired.add(state.owner);
    for (const request of state.requests.values()) request.abort.abort();
    this.#scopes.delete(scopeId);
  }

  cancelPending(): void {
    for (const request of this.#pending) request.abort.abort();
  }

  #prune(state: Scope<T>): void {
    for (const [ordinal, request] of state.requests) {
      if (request.settled && ordinal <= state.maximum - RECEIPT_WINDOW) state.requests.delete(ordinal);
    }
  }
}

function sequence(id: string): number {
  const value = nativeFileActionSequence(id);
  if (value === undefined) throw new TypeError("Invalid native file action identity.");
  return value;
}
