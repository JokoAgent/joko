export type VoiceLeaseStopReason = "complete" | "cancel";
export type VoiceLeaseReleaseKind = "auto" | "tap" | "hold" | "cancel";

export interface VoiceLeaseBackend<Source> {
  readonly start: (request: {
    readonly generation: number;
    readonly source: Source;
  }) => boolean | Promise<boolean>;
  readonly stop: (request: {
    readonly generation: number;
    readonly source: Source;
    readonly reason: VoiceLeaseStopReason;
  }) => void | Promise<void>;
}

export interface VoicePressLease<Source> {
  readonly source: Source;
  readonly activation: number;
  readonly recordingGeneration: number;
}

export type VoiceLeasePressResult<Source> =
  | {
    readonly accepted: true;
    readonly effect: "start" | "toggle-complete";
    readonly lease: VoicePressLease<Source>;
  }
  | {
    readonly accepted: false;
    readonly reason: "source-held" | "recording-transition" | "recording-uncertain";
  };

export type VoiceLeaseSnapshot<Source> =
  | { readonly state: "idle" }
  | {
    readonly state: "starting" | "recording" | "stopping" | "uncertain";
    readonly generation: number;
    readonly source: Source;
  };

export interface SourceAwareVoiceLeaseOptions<Source> {
  readonly backend: VoiceLeaseBackend<Source>;
  readonly holdDelayMs?: number;
  readonly now?: () => number;
  readonly onFailure?: (error: unknown, phase: "start" | "stop", generation: number) => void;
}

interface VoiceActivation<Source> {
  readonly lease: VoicePressLease<Source>;
  readonly pressedAt: number;
  readonly effect: "start" | "toggle-complete";
}

interface VoiceRecording<Source> {
  readonly generation: number;
  readonly source: Source;
  state: "starting" | "recording" | "stopping" | "uncertain";
  pendingStop: VoiceLeaseStopReason | undefined;
}

const DEFAULT_HOLD_DELAY_MS = 450;

/**
 * Coordinates the native shortcut and hardware microphone key through one
 * generation-fenced recording owner. Nothing is queued while start/stop state
 * is uncertain, and a release must present the exact press lease it received.
 */
export class SourceAwareVoiceLease<Source> {
  readonly #backend: VoiceLeaseBackend<Source>;
  readonly #holdDelayMs: number;
  readonly #now: () => number;
  readonly #onFailure: ((error: unknown, phase: "start" | "stop", generation: number) => void) | undefined;
  readonly #activations = new Map<Source, VoiceActivation<Source>>();
  readonly #operations = new Set<Promise<unknown>>();
  #recording: VoiceRecording<Source> | undefined;
  #nextGeneration = 0;
  #nextActivation = 0;

  constructor(options: SourceAwareVoiceLeaseOptions<Source>) {
    if (options.holdDelayMs !== undefined
      && (!Number.isFinite(options.holdDelayMs) || options.holdDelayMs < 0)) {
      throw new TypeError("Voice hold delay is invalid.");
    }
    this.#backend = options.backend;
    this.#holdDelayMs = options.holdDelayMs ?? DEFAULT_HOLD_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#onFailure = options.onFailure;
  }

  press(source: Source): VoiceLeasePressResult<Source> {
    if (this.#activations.has(source)) {
      return Object.freeze({ accepted: false, reason: "source-held" });
    }

    const recording = this.#recording;
    if (recording !== undefined) {
      if (recording.state === "stopping"
        || (recording.state === "starting" && recording.pendingStop !== undefined)) {
        return Object.freeze({ accepted: false, reason: "recording-transition" });
      }
      if (recording.state === "uncertain") {
        return Object.freeze({ accepted: false, reason: "recording-uncertain" });
      }
      if (!Object.is(recording.source, source)) {
        return Object.freeze({ accepted: false, reason: "recording-transition" });
      }
      const lease = this.#newActivation(source, recording.generation, "toggle-complete");
      this.#requestStop(recording, "complete");
      return Object.freeze({ accepted: true, effect: "toggle-complete", lease });
    }

    const generation = ++this.#nextGeneration;
    const next: VoiceRecording<Source> = {
      generation,
      source,
      state: "starting",
      pendingStop: undefined
    };
    this.#recording = next;
    const lease = this.#newActivation(source, generation, "start");
    const start = Promise.resolve()
      .then(() => this.#backend.start({ generation, source }))
      .then((started) => {
        if (this.#recording !== next) return;
        if (!started) {
          this.#clearRecording(next);
          return;
        }
        next.state = "recording";
        const pendingStop = next.pendingStop;
        if (pendingStop !== undefined) this.#requestStop(next, pendingStop);
      })
      .catch((error: unknown) => {
        if (this.#recording === next) this.#clearRecording(next);
        this.#reportFailure(error, "start", generation);
      });
    this.#track(start);
    return Object.freeze({ accepted: true, effect: "start", lease });
  }

  release(lease: VoicePressLease<Source>, kind: VoiceLeaseReleaseKind = "auto"): boolean {
    const activation = this.#activations.get(lease.source);
    if (activation === undefined
      || activation.lease.activation !== lease.activation
      || activation.lease.recordingGeneration !== lease.recordingGeneration) return false;
    this.#activations.delete(lease.source);
    if (activation.effect === "toggle-complete") return true;

    const recording = this.#recording;
    if (recording === undefined || recording.generation !== lease.recordingGeneration) return true;
    if (kind === "cancel") {
      this.#requestStop(recording, "cancel");
      return true;
    }
    const held = kind === "hold"
      || (kind === "auto" && elapsedSince(activation.pressedAt, this.#safeNow()) >= this.#holdDelayMs);
    if (held) this.#requestStop(recording, "complete");
    return true;
  }

  cancelSource(source: Source): boolean {
    this.#activations.delete(source);
    const recording = this.#recording;
    if (recording === undefined || !Object.is(recording.source, source)) return false;
    this.#requestStop(recording, "cancel");
    return true;
  }

  cancelAll(): boolean {
    this.#activations.clear();
    const recording = this.#recording;
    if (recording === undefined) return false;
    this.#requestStop(recording, "cancel");
    return true;
  }

  /** Clears only the exact generation acknowledged by the recording owner. */
  acknowledgeStopped(generation: number): boolean {
    const recording = this.#recording;
    if (recording === undefined || recording.generation !== generation) return false;
    this.#clearRecording(recording);
    return true;
  }

  snapshot(): VoiceLeaseSnapshot<Source> {
    const recording = this.#recording;
    return recording === undefined
      ? Object.freeze({ state: "idle" })
      : Object.freeze({
        state: recording.state,
        generation: recording.generation,
        source: recording.source
      });
  }

  /** Test/integration barrier for the currently known start/stop operations. */
  async settle(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }

  #newActivation(
    source: Source,
    recordingGeneration: number,
    effect: VoiceActivation<Source>["effect"]
  ): VoicePressLease<Source> {
    const lease = Object.freeze({
      source,
      activation: ++this.#nextActivation,
      recordingGeneration
    });
    this.#activations.set(source, {
      lease,
      pressedAt: this.#safeNow(),
      effect
    });
    return lease;
  }

  #requestStop(recording: VoiceRecording<Source>, reason: VoiceLeaseStopReason): void {
    if (recording.state === "starting") {
      recording.pendingStop = recording.pendingStop === "cancel" || reason === "cancel" ? "cancel" : "complete";
      return;
    }
    if (recording.state === "stopping" || recording.state === "uncertain") return;
    recording.state = "stopping";
    recording.pendingStop = reason;
    const stop = Promise.resolve()
      .then(() => this.#backend.stop({
        generation: recording.generation,
        source: recording.source,
        reason
      }))
      .then(() => {
        if (this.#recording === recording) this.#clearRecording(recording);
      })
      .catch((error: unknown) => {
        if (this.#recording === recording) recording.state = "uncertain";
        this.#reportFailure(error, "stop", recording.generation);
      });
    this.#track(stop);
  }

  #clearRecording(recording: VoiceRecording<Source>): void {
    if (this.#recording !== recording) return;
    this.#recording = undefined;
    for (const [source, activation] of this.#activations) {
      if (activation.lease.recordingGeneration === recording.generation) this.#activations.delete(source);
    }
  }

  #track(operation: Promise<unknown>): void {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation));
  }

  #safeNow(): number {
    const value = this.#now();
    return Number.isFinite(value) ? value : 0;
  }

  #reportFailure(error: unknown, phase: "start" | "stop", generation: number): void {
    try {
      this.#onFailure?.(error, phase, generation);
    } catch {
      // An observer cannot change the recording lease state.
    }
  }
}

function elapsedSince(startedAt: number, now: number): number {
  return Math.max(0, now - startedAt);
}
