import type { AudioGate, AudioGateEmit } from "@joko/voice-speaker";

export const SPEAKER_PREPARATION_TIMEOUT_MS = 1_500;

/** Holds initial PCM locally while the current profile and models are resolved. */
export class PendingMobileAudioGate implements AudioGate {
  #preparation?: AbortController;
  #gate?: AudioGate;
  #emit?: AudioGateEmit;
  #pending: Parameters<AudioGate["push"]>[] = [];
  #ready: Promise<void> = Promise.resolve();

  constructor(
    private readonly prepare: (signal: AbortSignal) => Promise<AudioGate | undefined>,
    private readonly onUnavailable: () => void
  ) {}

  begin(emit: AudioGateEmit): void {
    this.abort();
    this.#emit = emit;
    const controller = new AbortController();
    this.#preparation = controller;
    this.#ready = new Promise(resolve => {
      const timeout = setTimeout(() => complete(undefined, true), SPEAKER_PREPARATION_TIMEOUT_MS);
      const cancelled = () => { clearTimeout(timeout); resolve(); };
      const complete = (gate: AudioGate | undefined, unavailable = false) => {
        if (this.#preparation !== controller) { gate?.abort(); return; }
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", cancelled);
        this.#preparation = undefined;
        if (unavailable) {
          controller.abort();
          this.onUnavailable();
        }
        this.#gate = gate;
        gate?.begin(emit);
        const held = this.#pending;
        this.#pending = [];
        for (const chunk of held) this.push(...chunk);
        resolve();
      };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      void Promise.resolve().then(() => this.prepare(controller.signal))
        .then(gate => complete(gate), () => complete(undefined, true));
    });
  }

  push(...chunk: Parameters<AudioGate["push"]>): void {
    if (this.#preparation) this.#pending.push(chunk);
    else if (this.#gate) this.#gate.push(...chunk);
    else this.#emit?.(...chunk);
  }

  async finish(): Promise<void> {
    await this.#ready;
    await this.#gate?.finish();
  }

  abort(): void {
    this.#preparation?.abort();
    this.#preparation = undefined;
    this.#gate?.abort();
    this.#gate = undefined;
    this.#emit = undefined;
    for (const [pcm] of this.#pending) new Uint8Array(pcm).fill(0);
    this.#pending = [];
  }
}
