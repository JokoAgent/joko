/** A cancellable fixture stream; it does not invent a second dictionary model. */
export function dictionaryWatchFixture<T>() {
  const subscribers = new Set<{ pending?: T; closed: boolean; wake?: () => void }>();
  async function* watch(signal: AbortSignal): AsyncGenerator<T> {
    const subscriber: { pending?: T; closed: boolean; wake?: () => void } = { closed: signal.aborted };
    const close = (): void => { subscriber.closed = true; subscribers.delete(subscriber); subscriber.wake?.(); };
    signal.addEventListener("abort", close, { once: true });
    if (!subscriber.closed) subscribers.add(subscriber);
    try {
      while (!subscriber.closed) {
        if (subscriber.pending !== undefined) {
          const value = subscriber.pending; subscriber.pending = undefined;
          yield value;
        } else await new Promise<void>((resolve) => { subscriber.wake = resolve; });
        subscriber.wake = undefined;
      }
    } finally { signal.removeEventListener("abort", close); subscribers.delete(subscriber); }
  }
  return { watch,
    push(value: T): void { for (const subscriber of subscribers) { subscriber.pending = value; subscriber.wake?.(); } },
    end(): void { for (const subscriber of subscribers) { subscriber.closed = true; subscribers.delete(subscriber); subscriber.wake?.(); } },
    get count(): number { return subscribers.size; } };
}

export const idleDictionaryWatch = (signal: AbortSignal): AsyncIterable<never> => dictionaryWatchFixture<never>().watch(signal);
