import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";

/** Full projections coalesce to one pending read; no content or event backlog is retained. */
class ProjectionPulse {
  #pending = false;
  #closed = false;
  #waiting?: (changed: boolean) => void;
  readonly #aborted = (): void => this.close();
  constructor(private readonly signal: AbortSignal) {
    if (signal.aborted) this.close();
    else signal.addEventListener("abort", this.#aborted, { once: true });
  }
  notify(): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const resolve = this.#waiting; this.#waiting = undefined; resolve(true);
    } else this.#pending = true;
  }
  next(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    if (this.#pending) { this.#pending = false; return Promise.resolve(true); }
    return new Promise((resolve) => { this.#waiting = resolve; });
  }
  close(): void {
    this.#closed = true; this.#pending = false;
    this.signal.removeEventListener("abort", this.#aborted);
    this.#waiting?.(false); this.#waiting = undefined;
  }
}

export async function* watchVoiceDictionaryProjection<T>(options: {
  readonly context: HandlerContext;
  readonly authenticate: (context: HandlerContext) => { readonly connectionId: string };
  readonly onRevoked?: (connectionId: string, listener: () => void) => () => void;
  readonly shutdownSignal?: AbortSignal;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: () => T;
}): AsyncGenerator<{ readonly sequence: bigint; readonly value: T }> {
  const owner = options.authenticate(options.context);
  const signal = options.shutdownSignal === undefined ? options.context.signal : AbortSignal.any([options.context.signal, options.shutdownSignal]);
  const pulse = new ProjectionPulse(signal);
  let unsubscribe = (): void => undefined;
  let stopRevocation = (): void => undefined;
  try {
    unsubscribe = options.subscribe(() => pulse.notify());
    stopRevocation = options.onRevoked?.(owner.connectionId, () => pulse.close()) ?? (() => undefined);
    let sequence = 1n;
    if (signal.aborted) return;
    options.authenticate(options.context);
    yield { sequence, value: options.read() };
    while (await pulse.next()) {
      if (signal.aborted) return;
      options.authenticate(options.context);
      sequence += 1n;
      yield { sequence, value: options.read() };
    }
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("The voice dictionary projection is unavailable.", Code.Unavailable);
  } finally {
    unsubscribe(); stopRevocation(); pulse.close();
  }
}
