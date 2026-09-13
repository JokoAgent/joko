import type { AsrEvent, AsrProvider, AsrStartRequest, AudioChunk } from "./types.js";

export type AsrProviderRouteFactory = () => Promise<AsrProvider> | AsrProvider;

/**
 * Selects the first route that completes its start handshake. Route failures
 * are isolated until a route is active, so a failed primary cannot terminate
 * the owning VoiceInputController before a backup has been attempted.
 */
export class FallbackAsrProvider implements AsrProvider {
  readonly #factories: readonly AsrProviderRouteFactory[];
  readonly #listeners = new Set<(event: AsrEvent) => void>();
  #active: AsrProvider | undefined;
  #unsubscribe: (() => void) | undefined;
  #state: "idle" | "starting" | "started" | "stopped" = "idle";

  constructor(factories: readonly AsrProviderRouteFactory[]) {
    if (factories.length < 1 || factories.length > 3) {
      throw new RangeError("An ASR route chain must contain one to three routes.");
    }
    this.#factories = [...factories];
  }

  async start(request: AsrStartRequest): Promise<void> {
    if (this.#state !== "idle") throw new Error("The ASR route chain has already started.");
    this.#state = "starting";
    let lastFailure: unknown;
    for (const factory of this.#factories) {
      if ((this.#state as string) === "stopped") throw new Error("The ASR route chain was stopped.");
      let provider: AsrProvider | undefined;
      const pendingEvents: AsrEvent[] = [];
      let unsubscribe: (() => void) | undefined;
      try {
        provider = await factory();
        unsubscribe = provider.onEvent((event) => {
          if (this.#active === provider && this.#state === "started") this.#emit(event);
          else pendingEvents.push(event);
        });
        await provider.start(request);
        if ((this.#state as string) === "stopped") {
          unsubscribe();
          await provider.stop().catch(() => undefined);
          throw new Error("The ASR route chain was stopped.");
        }
        this.#active = provider;
        this.#unsubscribe = unsubscribe;
        this.#state = "started";
        for (const event of pendingEvents) this.#emit(event);
        return;
      } catch (error) {
        lastFailure = error;
        unsubscribe?.();
        await provider?.stop().catch(() => undefined);
      }
    }
    this.#state = "stopped";
    throw lastFailure instanceof Error ? lastFailure : new Error("No ASR route could start.");
  }

  appendAudio(chunk: AudioChunk): void {
    if (this.#state !== "started" || this.#active === undefined) return;
    this.#active.appendAudio(chunk);
  }

  flushAudio(): Promise<void> {
    return this.#active?.flushAudio() ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const active = this.#active;
    this.#active = undefined;
    await active?.stop();
    this.#listeners.clear();
  }

  recover(): Promise<void> {
    if (this.#state !== "started" || this.#active?.recover === undefined) {
      return Promise.reject(new Error("The active ASR route cannot recover."));
    }
    return this.#active.recover();
  }

  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: AsrEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}
