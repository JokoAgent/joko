import {
  DEFAULT_STABLE_WAIT_MS,
  MAXIMUM_RECOVERY_ATTEMPTS,
  STALL_VOICED_AUDIO_MS,
  STALL_WALL_TIMEOUT_MS,
  normalizeLocale,
  normalizeMimeType,
  validateAudioChunk,
  validateStableWait
} from "./limits.js";
import type {
  AsrErrorCategory,
  AsrEvent,
  AudioChunk,
  EditorRangeAcceptance,
  EditorRangeStatus,
  RefinementDiscardReason,
  RefinementEvent,
  SpeechSegment,
  VoiceInputClock,
  VoiceInputControllerOptions,
  VoiceInputDiagnosticEvent,
  VoiceInputDraftSource,
  VoiceInputFailureCode,
  VoiceInputStartOptions,
  VoiceInputState,
  VoiceInputTerminalOutcome
} from "./types.js";

const STALL_CHECK_INTERVAL_MS = 250;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 200_000;

const SYSTEM_CLOCK: VoiceInputClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

interface StableWaiter {
  readonly resolve: (text: string | undefined) => void;
  readonly timer: unknown;
}

interface ActiveRefinement {
  readonly runId: string;
  readonly generation: number;
  readonly range: EditorRangeAcceptance;
  readonly abortController: AbortController;
  discarded: boolean;
}

interface SubmissionDelivery {
  readonly range?: EditorRangeAcceptance;
  readonly threw: boolean;
}

export class VoiceInputOperationError extends Error {
  readonly code: VoiceInputFailureCode;

  constructor(code: VoiceInputFailureCode) {
    super(`Voice input operation failed (${code}).`);
    this.name = "VoiceInputOperationError";
    this.code = code;
  }
}

/**
 * Ephemeral click-to-dictate state machine. It has no storage or credential
 * surface; hosts receive text only through the explicit callbacks.
 */
export class VoiceInputController {
  private readonly provider: VoiceInputControllerOptions["provider"];
  private readonly callbacks: VoiceInputControllerOptions["callbacks"];
  private readonly refiner: VoiceInputControllerOptions["refiner"];
  private readonly stableWaitMs: number;
  private readonly clock: VoiceInputClock;
  private readonly createId: () => string;
  private readonly unsubscribeProvider: () => void;

  private state: VoiceInputState = "idle";
  private outcome: VoiceInputTerminalOutcome | undefined;
  private runId = "";
  private generation = 0;
  private locale: string | undefined;
  private latestPartial = "";
  private latestStable = "";
  private latestTranscript = "";
  private latestTranscriptSource: VoiceInputDraftSource = "partial";
  private speechActivitySeen = false;
  private submissionAttempted = false;
  private transcriptKept = false;
  private submittedRange: EditorRangeAcceptance | undefined;
  private cancelled = false;
  private totalAudioBytes = 0;
  private totalAudioDurationMs = 0;

  private lastSignalAt = 0;
  private audioMsSinceLastSignal = 0;
  private voicedAudioMsSinceLastSignal = 0;
  private everSawSignal = false;
  private stallWarned = false;
  private stallTimer: unknown;

  private stableWaiters = new Set<StableWaiter>();
  private stopPromise: Promise<void> | undefined;
  private cancelPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private recoveryInFlight: Promise<void> | undefined;
  private recoveryAttempts = 0;
  private activeRefinement: ActiveRefinement | undefined;

  constructor(options: VoiceInputControllerOptions) {
    this.provider = options.provider;
    this.callbacks = options.callbacks;
    this.refiner = options.refiner;
    this.stableWaitMs = validateStableWait(options.stableWaitMs ?? DEFAULT_STABLE_WAIT_MS);
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.createId = options.createId ?? createVoiceInputId;
    this.unsubscribeProvider = this.provider.onEvent((event) => this.handleProviderEvent(event));
  }

  get id(): string {
    return this.runId;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  get terminalOutcome(): VoiceInputTerminalOutcome | undefined {
    return this.outcome;
  }

  async start(options: VoiceInputStartOptions): Promise<string> {
    if (this.isActive()) return this.runId;

    const mimeType = normalizeMimeType(options.mimeType);
    const locale = normalizeLocale(options.locale);
    await this.closePromise?.catch(() => undefined);

    this.generation += 1;
    this.runId = this.createId();
    this.locale = locale;
    this.latestPartial = "";
    this.latestStable = "";
    this.latestTranscript = "";
    this.latestTranscriptSource = "partial";
    this.speechActivitySeen = false;
    this.submissionAttempted = false;
    this.transcriptKept = false;
    this.submittedRange = undefined;
    this.cancelled = false;
    this.totalAudioBytes = 0;
    this.totalAudioDurationMs = 0;
    this.recoveryAttempts = 0;
    this.recoveryInFlight = undefined;
    this.stopPromise = undefined;
    this.cancelPromise = undefined;
    this.closePromise = undefined;
    this.activeRefinement = undefined;
    this.outcome = undefined;
    this.resetStallWindow(false);
    this.setActiveState("listening");
    this.startStallWatchdog();

    try {
      await this.provider.start({ runId: this.runId, mimeType, ...(locale === undefined ? {} : { locale }) });
    } catch {
      this.fail("provider_start_failed");
      await this.closeProviderOnce().catch(() => undefined);
      throw new VoiceInputOperationError("provider_start_failed");
    }
    return this.runId;
  }

  appendAudio(chunk: AudioChunk): void {
    if (this.state !== "listening" || this.outcome !== undefined) return;
    const totals = validateAudioChunk(chunk, {
      bytes: this.totalAudioBytes,
      durationMs: this.totalAudioDurationMs
    });
    this.totalAudioBytes = totals.bytes;
    this.totalAudioDurationMs = totals.durationMs;
    this.audioMsSinceLastSignal += chunk.durationMs;
    if (chunk.voiced) {
      this.speechActivitySeen = true;
      this.voicedAudioMsSinceLastSignal += chunk.durationMs;
    }
    try {
      this.provider.appendAudio(chunk);
    } catch {
      this.fail("provider_error");
      throw new VoiceInputOperationError("provider_error");
    }
  }

  stop(): Promise<void> {
    if (this.cancelPromise !== undefined) return this.cancelPromise;
    if (this.stopPromise !== undefined) return this.stopPromise;
    if (this.state !== "listening" || this.outcome !== undefined) {
      return this.closePromise?.catch(() => undefined) ?? Promise.resolve();
    }
    const generation = this.generation;
    const runId = this.runId;
    this.stopPromise = this.finishStop(generation, runId);
    return this.stopPromise;
  }

  cancel(): Promise<void> {
    if (this.cancelPromise !== undefined) return this.cancelPromise;
    if (this.runId === "" || this.outcome !== undefined) {
      return this.closePromise?.catch(() => undefined) ?? Promise.resolve();
    }

    this.cancelled = true;
    this.stopStallWatchdog();
    this.resolveStableWaiters(undefined);
    if (this.activeRefinement !== undefined) {
      this.activeRefinement.abortController.abort();
      this.discardRefinement(this.activeRefinement, "cancelled");
    }

    // Intentional disconnect events must observe the terminal outcome.
    this.finishTerminal("done", "cancelled");
    this.cancelPromise = this.closeProviderOnce().catch(() => undefined);
    return this.cancelPromise;
  }

  /** Detaches callbacks after the host has ended the controller's lifetime. */
  detach(): void {
    this.stopStallWatchdog();
    this.unsubscribeProvider();
  }

  private async finishStop(generation: number, runId: string): Promise<void> {
    this.stopStallWatchdog();
    this.setActiveState("submitting");

    try {
      await this.provider.flushAudio();
    } catch {
      if (this.isCurrentRun(generation, runId) && this.outcome === undefined) {
        this.fail("provider_flush_failed");
      }
      await this.closeProviderOnce().catch(() => undefined);
      return;
    }

    if (!this.isCurrentSubmittingRun(generation, runId)) {
      await this.closeProviderOnce().catch(() => undefined);
      return;
    }

    const stable = await this.waitForStable(this.stableWaitMs);
    const text = normalizeTranscript(stable || this.latestStable || this.latestPartial);
    const source: VoiceInputDraftSource = stable || this.latestStable ? "stable" : "partial";

    try {
      await this.closeProviderOnce();
    } catch {
      if (this.isCurrentSubmittingRun(generation, runId)) this.fail("provider_close_failed");
      return;
    }

    if (!this.isCurrentSubmittingRun(generation, runId) || this.submissionAttempted) return;

    if (text === "") {
      if (this.speechActivitySeen) this.fail("empty_transcript");
      else this.finishTerminal("done", "no_speech");
      return;
    }

    const delivery = this.deliverSubmission(text, source, false);
    if (delivery.threw) {
      this.fail("host_submission_failed");
      return;
    }

    if (this.refiner === undefined || delivery.range === undefined) {
      this.finishTerminal("done", "success");
      return;
    }

    await this.refineSubmission(generation, runId, text, delivery.range);
  }

  private async refineSubmission(
    generation: number,
    runId: string,
    text: string,
    range: EditorRangeAcceptance
  ): Promise<void> {
    if (this.refiner === undefined) return;
    const active: ActiveRefinement = {
      runId,
      generation,
      range,
      abortController: new AbortController(),
      discarded: false
    };
    this.activeRefinement = active;
    this.setActiveState("refining");

    let result: Awaited<ReturnType<NonNullable<typeof this.refiner>["refine"]>>;
    try {
      result = await this.refiner.refine({
        runId,
        text,
        ...(this.locale === undefined ? {} : { locale: this.locale }),
        signal: active.abortController.signal,
        onPreview: (preview) => this.publishRefinementPreview(active, preview)
      });
    } catch {
      if (!active.discarded) {
        const reason: RefinementDiscardReason = this.cancelled
          ? "cancelled"
          : this.outcome === "failed"
            ? "run_failed"
            : generation !== this.generation || runId !== this.runId
              ? "stale_run"
              : "refiner_failed";
        this.discardRefinement(active, reason);
      }
      if (this.isCurrentRun(generation, runId) && this.outcome === undefined) {
        this.finishTerminal("done", "success");
      }
      return;
    }

    if (active.discarded) return;
    if (!this.isCurrentRun(generation, runId)) {
      this.discardRefinement(active, "stale_run");
      return;
    }
    if (this.cancelled) {
      this.discardRefinement(active, "cancelled");
      return;
    }
    if (this.outcome === "failed") {
      this.discardRefinement(active, "run_failed");
      return;
    }
    if (!result.accepted) {
      this.discardRefinement(active, result.reason === "unchanged" ? "unchanged" : "refiner_rejected");
      this.finishTerminal("done", "success");
      return;
    }
    if (result.basedOnText !== text) {
      this.discardRefinement(active, "base_text_changed");
      this.finishTerminal("done", "success");
      return;
    }

    const refinedText = normalizeTranscript(result.refinedText);
    if (refinedText === "" || refinedText === text) {
      this.discardRefinement(active, "unchanged");
      this.finishTerminal("done", "success");
      return;
    }

    const conflict = this.rangeConflict(range);
    if (conflict !== undefined) {
      this.discardRefinement(active, conflict);
      this.finishTerminal("done", "success");
      return;
    }

    let applyResult: ReturnType<NonNullable<typeof this.callbacks.applyRefinement>> | undefined;
    try {
      applyResult = this.callbacks.applyRefinement?.({
        rangeId: range.id,
        expectedRevision: range.revision,
        refinedText
      });
    } catch {
      applyResult = { applied: false, reason: "apply_failed" };
    }
    if (applyResult?.applied !== true) {
      this.discardRefinement(active, applyResult?.reason ?? "apply_failed");
      this.finishTerminal("done", "success");
      return;
    }

    this.emitRefinement({
      type: "applied",
      runId,
      rangeId: range.id,
      expectedRevision: range.revision,
      text: refinedText
    });
    this.finishTerminal("done", "success");
  }

  private publishRefinementPreview(active: ActiveRefinement, value: string): void {
    if (
      active.discarded ||
      this.cancelled ||
      this.outcome !== undefined ||
      !this.isCurrentRun(active.generation, active.runId)
    ) return;
    const text = normalizeTranscript(value);
    if (text === "" || this.rangeConflict(active.range) !== undefined) return;
    this.emitRefinement({
      type: "preview",
      runId: active.runId,
      rangeId: active.range.id,
      expectedRevision: active.range.revision,
      text
    });
  }

  private rangeConflict(range: EditorRangeAcceptance): RefinementDiscardReason | undefined {
    if (range.userEdited === true) return "user_edited";
    if (this.callbacks.inspectEditorRange === undefined) return undefined;
    let status: EditorRangeStatus | undefined;
    try {
      status = this.callbacks.inspectEditorRange(range);
    } catch {
      return "apply_failed";
    }
    if (status === undefined || !status.exists) return "range_missing";
    if (status.userEdited) return "user_edited";
    if (status.revision !== range.revision) return "stale_revision";
    return undefined;
  }

  private handleProviderEvent(event: AsrEvent): void {
    if (this.runId === "" || this.outcome !== undefined) return;
    switch (event.type) {
      case "connected":
        return;
      case "partial":
      case "stable": {
        if (this.state !== "listening" && this.state !== "submitting") return;
        const text = boundedTranscript(event.text);
        if (event.type === "partial") this.latestPartial = text;
        else this.latestStable = text;
        this.latestTranscript = text;
        this.latestTranscriptSource = event.type;
        if (normalizeTranscript(text) !== "") this.speechActivitySeen = true;
        this.resetStallWindow(true);
        if (event.type === "stable") this.resolveStableWaiters(text);
        if (this.state === "listening") this.publishDraft(text, event.type);
        return;
      }
      case "disconnected":
        // Provider stop commonly emits a final disconnect. Only a disconnect
        // while actively listening is an unexpected transport failure.
        if (this.state !== "listening") return;
        if (this.tryRecover("disconnected", event.recoverable)) return;
        this.fail("connection_interrupted");
        return;
      case "error":
        // A provider can report a close/flush error after already returning
        // usable text. Preserve the commit path instead of turning intentional
        // teardown into a failed run or submitting the same text twice.
        if (
          (this.state === "submitting" || this.state === "refining") &&
          (normalizeTranscript(this.latestTranscript) !== "" || this.submissionAttempted)
        ) return;
        if (
          this.state === "listening" &&
          event.category === "transport" &&
          this.tryRecover("error", event.recoverable)
        ) return;
        this.fail(mapProviderFailure(event.category));
    }
  }

  private tryRecover(trigger: "disconnected" | "error", recoverable: boolean): boolean {
    if (!recoverable || typeof this.provider.recover !== "function") return false;
    if (this.recoveryInFlight !== undefined) return true;
    if (this.recoveryAttempts >= MAXIMUM_RECOVERY_ATTEMPTS) return false;

    this.recoveryAttempts += 1;
    const attempt = this.recoveryAttempts;
    const generation = this.generation;
    const runId = this.runId;
    this.emitDiagnostic({ type: "recovery_attempted", attempt, trigger });
    const recovery = Promise.resolve()
      .then(() => this.provider.recover?.())
      .then(
        () => {
          if (!this.isCurrentRun(generation, runId) || this.outcome !== undefined || this.state !== "listening") return;
          this.resetStallWindow(this.everSawSignal);
          this.emitDiagnostic({ type: "recovery_succeeded", attempt });
        },
        () => {
          if (!this.isCurrentRun(generation, runId) || this.outcome !== undefined) return;
          this.emitDiagnostic({ type: "recovery_failed", attempt });
          this.fail("connection_interrupted");
        }
      )
      .finally(() => {
        if (this.recoveryInFlight === recovery) this.recoveryInFlight = undefined;
      });
    this.recoveryInFlight = recovery;
    return true;
  }

  private fail(code: VoiceInputFailureCode): void {
    if (this.outcome !== undefined) return;
    this.stopStallWatchdog();
    this.resolveStableWaiters(undefined);
    if (this.activeRefinement !== undefined) {
      this.activeRefinement.abortController.abort();
      this.discardRefinement(this.activeRefinement, "run_failed");
    }
    this.salvageLatestTranscript();
    this.finishTerminal("error", "failed");
    try {
      this.callbacks.onError?.({ code, transcriptKept: this.transcriptKept });
    } catch {
      // A host callback must not prevent provider teardown.
    }
    void this.closeProviderOnce().catch(() => undefined);
  }

  private salvageLatestTranscript(): void {
    if (this.submissionAttempted) return;
    const text = normalizeTranscript(this.latestTranscript);
    if (text === "") return;
    const delivery = this.deliverSubmission(text, this.latestTranscriptSource, true);
    this.emitDiagnostic({
      type: "transcript_salvaged",
      source: this.latestTranscriptSource,
      accepted: delivery.range !== undefined,
      characterCount: text.length
    });
  }

  private deliverSubmission(
    text: string,
    source: VoiceInputDraftSource,
    salvaged: boolean
  ): SubmissionDelivery {
    if (this.submissionAttempted) return { range: this.submittedRange, threw: false };
    this.submissionAttempted = true;
    const segment: SpeechSegment = {
      id: this.createId(),
      source: "mic",
      status: "submitted",
      text,
      updatedAt: this.clock.now()
    };
    try {
      const range = this.callbacks.onSubmitted({
        runId: this.runId,
        text,
        source,
        salvaged,
        segment
      });
      this.submittedRange = range;
      this.transcriptKept = range !== undefined;
      return { ...(range === undefined ? {} : { range }), threw: false };
    } catch {
      return { threw: true };
    }
  }

  private publishDraft(value: string, source: VoiceInputDraftSource): void {
    const text = normalizeTranscript(value);
    if (text === "") return;
    const segment: SpeechSegment = {
      id: `draft-${this.runId}`,
      source: "mic",
      status: "draft",
      text,
      updatedAt: this.clock.now()
    };
    try {
      this.callbacks.onDraftChanged?.(text, segment, source);
    } catch {
      // Draft rendering does not own the provider lifetime.
    }
  }

  private waitForStable(timeoutMs: number): Promise<string | undefined> {
    if (normalizeTranscript(this.latestStable) !== "") return Promise.resolve(this.latestStable);
    return new Promise((resolve) => {
      let waiter: StableWaiter;
      const finish = (text: string | undefined): void => {
        this.clock.clearTimeout(waiter.timer);
        this.stableWaiters.delete(waiter);
        resolve(text);
      };
      waiter = {
        resolve: finish,
        timer: this.clock.setTimeout(() => finish(undefined), timeoutMs)
      };
      this.stableWaiters.add(waiter);
    });
  }

  private resolveStableWaiters(text: string | undefined): void {
    for (const waiter of [...this.stableWaiters]) waiter.resolve(text);
  }

  private closeProviderOnce(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = Promise.resolve().then(() => this.provider.stop());
    }
    return this.closePromise;
  }

  private setActiveState(state: Exclude<VoiceInputState, "done" | "error">): void {
    if (this.outcome !== undefined) return;
    this.state = state;
    try {
      this.callbacks.onStateChanged?.(state);
    } catch {
      // State observers are isolated from the state machine.
    }
  }

  private finishTerminal(state: "done" | "error", outcome: VoiceInputTerminalOutcome): void {
    if (this.outcome !== undefined) return;
    this.state = state;
    this.outcome = outcome;
    try {
      this.callbacks.onStateChanged?.(state, outcome);
    } catch {
      // State observers are isolated from cleanup.
    }
  }

  private emitRefinement(event: RefinementEvent): void {
    try {
      this.callbacks.onRefinement?.(event);
    } catch {
      // Preview/result observers do not own editor acceptance.
    }
  }

  private discardRefinement(active: ActiveRefinement, reason: RefinementDiscardReason): void {
    if (active.discarded) return;
    active.discarded = true;
    this.emitRefinement({
      type: "discarded",
      runId: active.runId,
      rangeId: active.range.id,
      reason
    });
    this.emitDiagnostic({ type: "refinement_discarded", reason });
  }

  private emitDiagnostic(event: VoiceInputDiagnosticEvent): void {
    try {
      this.callbacks.onDiagnostic?.(event);
    } catch {
      // Diagnostics are best effort and contain no content payloads.
    }
  }

  private resetStallWindow(sawSignal: boolean): void {
    this.lastSignalAt = this.clock.now();
    this.audioMsSinceLastSignal = 0;
    this.voicedAudioMsSinceLastSignal = 0;
    this.stallWarned = false;
    if (sawSignal) this.everSawSignal = true;
  }

  private startStallWatchdog(): void {
    this.stopStallWatchdog();
    this.stallTimer = this.clock.setInterval(() => this.checkStall(), STALL_CHECK_INTERVAL_MS);
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer === undefined) return;
    this.clock.clearInterval(this.stallTimer);
    this.stallTimer = undefined;
  }

  private checkStall(): void {
    if (this.state !== "listening" || this.outcome !== undefined) {
      this.stopStallWatchdog();
      return;
    }
    const wallMs = this.clock.now() - this.lastSignalAt;
    if (
      this.stallWarned ||
      wallMs < STALL_WALL_TIMEOUT_MS ||
      this.voicedAudioMsSinceLastSignal < STALL_VOICED_AUDIO_MS
    ) return;
    this.stallWarned = true;
    this.emitDiagnostic({
      type: "stall_warning",
      wallMsSinceLastSignal: Math.round(wallMs),
      audioMsSinceLastSignal: Math.round(this.audioMsSinceLastSignal),
      voicedAudioMsSinceLastSignal: Math.round(this.voicedAudioMsSinceLastSignal),
      everSawSignal: this.everSawSignal
    });
  }

  private isActive(): boolean {
    return this.outcome === undefined && (
      this.state === "listening" || this.state === "submitting" || this.state === "refining"
    );
  }

  private isCurrentRun(generation: number, runId: string): boolean {
    return generation === this.generation && runId === this.runId;
  }

  private isCurrentSubmittingRun(generation: number, runId: string): boolean {
    return this.isCurrentRun(generation, runId) && this.outcome === undefined && this.state === "submitting";
  }
}

function normalizeTranscript(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function boundedTranscript(value: string): string {
  return value.slice(0, MAXIMUM_TRANSCRIPT_CHARACTERS);
}

function mapProviderFailure(category: AsrErrorCategory): VoiceInputFailureCode {
  switch (category) {
    case "transport":
      return "connection_interrupted";
    case "authentication":
      return "provider_authentication";
    case "quota":
      return "provider_quota";
    case "protocol":
      return "provider_protocol";
    case "unknown":
      return "provider_error";
  }
}

function createVoiceInputId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
