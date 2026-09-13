export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly settled: () => boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  let isSettled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (isSettled) return;
      isSettled = true;
      resolvePromise(value);
    },
    reject: (reason) => {
      if (isSettled) return;
      isSettled = true;
      rejectPromise(reason);
    },
    settled: () => isSettled
  };
}

interface PendingInput<T> {
  readonly value: T;
  readonly consumed: Deferred<void>;
  readonly onConsumed: () => void;
  readonly beforeConsumed: () => void;
  readonly release: () => void;
}

/**
 * A deliberately one-slot AsyncIterable. The Adapter does not make the next
 * product turn visible to the SDK until the previous turn has a Result;
 * same-turn input uses the same slot and can be withdrawn before consumption.
 */
export class AsyncInputGate<T> implements AsyncIterable<T>, AsyncIterator<T> {
  #pending: PendingInput<T> | undefined;
  #reader: Deferred<IteratorResult<T>> | undefined;
  #closed = false;
  #closeReason: unknown = new Error("The native input stream is closed.");

  offer(value: T, onConsumed: () => void = () => undefined, signal?: AbortSignal, beforeConsumed: () => void = () => undefined): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closeReason);
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    if (this.#pending !== undefined) {
      return Promise.reject(new Error("The native input gate already contains an unread turn."));
    }
    const consumed = deferred<void>();
    const reader = this.#reader;
    if (reader !== undefined) {
      try { beforeConsumed(); }
      catch (error) {
        consumed.reject(error);
        // The SDK still owns its outstanding read. A rejected offer must not
        // end that iterator or leave a second reader behind.
        return consumed.promise;
      }
      this.#reader = undefined;
      onConsumed();
      consumed.resolve(undefined);
      reader.resolve({ value, done: false });
    } else {
      const cancel = () => {
        if (this.#pending?.consumed !== consumed) return;
        this.#pending.release();
        this.#pending = undefined;
        consumed.reject(signal?.reason);
      };
      this.#pending = { value, consumed, onConsumed, beforeConsumed, release: () => signal?.removeEventListener("abort", cancel) };
      signal?.addEventListener("abort", cancel, { once: true });
    }
    return consumed.promise;
  }

  next(): Promise<IteratorResult<T>> {
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#pending = undefined;
      pending.release();
      try { pending.beforeConsumed(); }
      catch (error) {
        pending.consumed.reject(error);
        // Keep this same SDK read waiting for the next authorized offer;
        // close() also settles it if its Adapter retires the runtime.
        return this.next();
      }
      pending.onConsumed();
      pending.consumed.resolve(undefined);
      return Promise.resolve({ value: pending.value, done: false });
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    if (this.#reader !== undefined) {
      return Promise.reject(new Error("The SDK requested concurrent reads from a single-turn input gate."));
    }
    const reader = deferred<IteratorResult<T>>();
    this.#reader = reader;
    return reader.promise;
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  close(reason: unknown = new Error("The native input stream is closed.")): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#pending?.consumed.reject(reason);
    this.#pending?.release();
    this.#pending = undefined;
    this.#reader?.resolve({ value: undefined, done: true });
    this.#reader = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
