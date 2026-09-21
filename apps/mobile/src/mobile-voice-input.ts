import {
  CapabilitySupport,
  VoiceInputFailureCode as ProtoVoiceInputFailureCode,
  VoiceInputState as ProtoVoiceInputState,
  VoiceInputTerminalOutcome as ProtoVoiceInputTerminalOutcome,
  VoiceInputTextSource as ProtoVoiceInputTextSource,
  type VoiceInputCapabilityProfile as ProtoVoiceInputCapabilityProfile,
  type VoiceInputSession as ProtoVoiceInputSession
} from "@joko/contracts";
import type {
  MobileVoiceDictionaryAdviceDraft,
  MobileVoiceDictionaryLearningAction
} from "./mobile-voice-dictionary";

const TERMINAL_POLL_INTERVAL_MS = 180;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 200_000;

export type MobileVoiceCapabilitySupport = "supported" | "upstreamMissing" | "notImplemented"
  | "platformLimited" | "disabledByPolicy" | "temporarilyUnavailable" | "unspecified";
export type MobileVoiceState = "idle" | "listening" | "submitting" | "refining" | "done" | "error";
export type MobileVoiceOutcome = "success" | "noSpeech" | "failed" | "cancelled";
export type MobileVoiceTextSource = "partial" | "stable";
export type MobileVoiceFailureCode = "connectionInterrupted" | "emptyTranscript" | "hostSubmissionFailed"
  | "providerAuthentication" | "providerCloseFailed" | "providerError" | "providerFlushFailed"
  | "providerProtocol" | "providerQuota" | "providerStartFailed";

export interface MobileVoiceCapability {
  readonly support: MobileVoiceCapabilitySupport;
  readonly reason?: string;
  readonly limits: {
    readonly supportedMimeTypes: readonly string[];
    readonly maximumAudioChunkBytes: number;
    readonly maximumAudioBytes: number;
    readonly maximumAudioChunkDurationMs: number;
    readonly maximumAudioDurationMs: number;
    readonly maximumLocaleCharacters: number;
    readonly stableWaitMs: number;
    readonly maximumConcurrentSessions: number;
  };
  readonly supportsLocale: boolean;
  readonly supportsLiveDrafts: boolean;
  readonly supportsRefinement: boolean;
}

export interface MobileVoiceSession {
  readonly id: string;
  readonly state: MobileVoiceState;
  readonly outcome?: MobileVoiceOutcome;
  readonly draft?: { readonly text: string; readonly source: MobileVoiceTextSource };
  readonly result?: {
    readonly text: string;
    readonly source: MobileVoiceTextSource;
    readonly salvaged: boolean;
    readonly rawTranscriptText?: string;
  };
  readonly failure?: { readonly code: MobileVoiceFailureCode; readonly transcriptKept: boolean };
  readonly nextChunkSequence: bigint;
  readonly acceptedAudioBytes: number;
  readonly acceptedAudioDurationMs: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recoveryAttempts: number;
  readonly stallWarning: boolean;
}

export interface MobileVoiceRefinementContext {
  readonly instructions?: string;
  readonly dictionaryTerms: readonly string[];
}

export interface MobileVoiceTransport {
  readonly profileId: string;
  readonly surfaceOwnerKey: string;
  isCurrent(): boolean;
  getCapabilities(signal?: AbortSignal): Promise<MobileVoiceCapability>;
  adviseVoiceInputDictionaryEdit(
    draft: MobileVoiceDictionaryAdviceDraft,
    signal?: AbortSignal
  ): Promise<{ readonly actions: readonly MobileVoiceDictionaryLearningAction[] }>;
  start(
    requestId: string,
    mimeType: string,
    locale?: string,
    refinement?: MobileVoiceRefinementContext,
    signal?: AbortSignal
  ): Promise<MobileVoiceSession>;
  append(
    voiceInputId: string,
    chunkSequence: bigint,
    audio: Uint8Array,
    durationMs: number,
    voiced: boolean,
    signal?: AbortSignal
  ): Promise<MobileVoiceSession>;
  stop(voiceInputId: string, expectedNextChunkSequence: bigint, signal?: AbortSignal): Promise<MobileVoiceSession>;
  cancel(voiceInputId: string, signal?: AbortSignal): Promise<MobileVoiceSession>;
  get(voiceInputId: string, signal?: AbortSignal): Promise<MobileVoiceSession>;
}

export interface MobileVoicePermission {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}

export interface MobileVoicePcmChunk {
  readonly audio: Uint8Array;
  readonly durationMs: number;
  readonly voiced: boolean;
}

export interface MobileVoiceCaptureRuntime {
  isAvailable(): boolean;
  ensurePermission(signal: AbortSignal): Promise<MobileVoicePermission>;
  start(
    onChunk: (chunk: MobileVoicePcmChunk) => void,
    onError: (error: Error) => void,
    signal: AbortSignal
  ): Promise<() => Promise<void>>;
  release(): Promise<void>;
}

export type MobileVoiceRunState = "idle" | "starting" | "listening" | "submitting" | "done" | "error" | "cancelled";

export interface MobileVoiceRunUpdate {
  readonly state: MobileVoiceRunState;
  readonly session?: MobileVoiceSession;
  readonly error?: MobileVoiceRunError;
}

export type MobileVoiceRunErrorCode = "unsupported" | "permissionDenied" | "permissionBlocked"
  | "captureFailed" | "audioLimit" | "noSpeech" | "transcriptionFailed"
  | "ownerChanged" | "serviceUnavailable" | "cancelled";

const ERROR_MESSAGES: Readonly<Record<MobileVoiceRunErrorCode, string>> = {
  unsupported: "Voice input is not available for this Joko connection on this device.",
  permissionDenied: "Microphone permission is required for voice input.",
  permissionBlocked: "Microphone access is blocked. Open system settings to allow it for Joko.",
  captureFailed: "Microphone capture stopped unexpectedly. Try recording again.",
  audioLimit: "This recording reached the voice input limit. Stop and start a new recording.",
  noSpeech: "No speech was detected. Try recording again.",
  transcriptionFailed: "Voice transcription failed. Try recording again.",
  ownerChanged: "The task or connection changed while voice input was active.",
  serviceUnavailable: "Voice input is temporarily unavailable. Try again.",
  cancelled: "Voice input was cancelled."
};

export class MobileVoiceRunError extends Error {
  readonly code: MobileVoiceRunErrorCode;

  constructor(code: MobileVoiceRunErrorCode, options: { readonly cause?: unknown } = {}) {
    super(ERROR_MESSAGES[code], options);
    this.name = "MobileVoiceRunError";
    this.code = code;
  }
}

export interface MobileVoiceRunOptions {
  readonly transport: MobileVoiceTransport;
  readonly capture: MobileVoiceCaptureRuntime;
  readonly requestId: () => string;
  readonly locale?: string;
  readonly refinement?: MobileVoiceRefinementContext;
  readonly onCapability?: (capability: MobileVoiceCapability) => void;
  readonly onUpdate?: (update: MobileVoiceRunUpdate) => void;
  readonly onCaptureStopped?: () => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Owns one ephemeral native microphone → VoiceInputService session. */
export class MobileVoiceInputRun {
  readonly #transport: MobileVoiceTransport;
  readonly #capture: MobileVoiceCaptureRuntime;
  readonly #requestId: () => string;
  readonly #locale: string | undefined;
  readonly #refinement: MobileVoiceRefinementContext | undefined;
  readonly #onCapability: (capability: MobileVoiceCapability) => void;
  readonly #onUpdate: (update: MobileVoiceRunUpdate) => void;
  readonly #onCaptureStopped: () => void;
  readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #state: MobileVoiceRunState = "idle";
  #capability: MobileVoiceCapability | undefined;
  #session: MobileVoiceSession | undefined;
  #abort: AbortController | undefined;
  #pollAbort: AbortController | undefined;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #stopCapture: (() => Promise<void>) | undefined;
  #appendChain: Promise<void> = Promise.resolve();
  #startBarrier: Promise<void> = Promise.resolve();
  #releaseStartBarrier: (() => void) | undefined;
  #chunkSequence = 1n;
  #acceptedBytes = 0;
  #acceptedDurationMs = 0;
  #capturedBytes = 0;
  #capturedDurationMs = 0;
  #generation = 0;
  #stopRequested = false;
  #disposed = false;

  constructor(options: MobileVoiceRunOptions) {
    this.#transport = options.transport;
    this.#capture = options.capture;
    this.#requestId = options.requestId;
    this.#locale = options.locale;
    this.#refinement = options.refinement;
    this.#onCapability = options.onCapability ?? (() => undefined);
    this.#onUpdate = options.onUpdate ?? (() => undefined);
    this.#onCaptureStopped = options.onCaptureStopped ?? (() => undefined);
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get currentState(): MobileVoiceRunState { return this.#state; }
  get currentSession(): MobileVoiceSession | undefined { return this.#session; }

  async start(): Promise<void> {
    if (this.#disposed || !["idle", "done", "error", "cancelled"].includes(this.#state)) return;
    const generation = ++this.#generation;
    this.#stopRequested = false;
    this.#session = undefined;
    this.#capability = undefined;
    this.#chunkSequence = 1n;
    this.#acceptedBytes = 0;
    this.#acceptedDurationMs = 0;
    this.#capturedBytes = 0;
    this.#capturedDurationMs = 0;
    this.#appendChain = Promise.resolve();
    this.#startBarrier = new Promise<void>((resolve) => { this.#releaseStartBarrier = resolve; });
    const abort = new AbortController();
    this.#abort = abort;
    this.#setState("starting");
    try {
      this.#assertOwner();
      const capability = await this.#transport.getCapabilities(abort.signal);
      if (!this.#isCurrent(generation, abort)) throw new MobileVoiceRunError("cancelled");
      try { this.#onCapability(capability); }
      catch { /* Local capability observation cannot fail microphone capture. */ }
      if (!supportsMobileVoiceCapture(capability, this.#capture.isAvailable())) {
        throw new MobileVoiceRunError("unsupported");
      }
      this.#capability = capability;
      const permission = await this.#capture.ensurePermission(abort.signal);
      if (!this.#isCurrent(generation, abort)) throw new MobileVoiceRunError("cancelled");
      if (!permission.granted) {
        throw new MobileVoiceRunError(permission.canAskAgain ? "permissionDenied" : "permissionBlocked");
      }
      this.#assertOwner();

      const requestId = this.#requestId();
      if (!IDENTIFIER_PATTERN.test(requestId)) throw new MobileVoiceRunError("serviceUnavailable");
      const locale = capability.supportsLocale ? normalizeMobileVoiceLocale(this.#locale, capability) : undefined;
      const refinement = capability.supportsRefinement ? this.#refinement : undefined;
      const sessionPromise = this.#transport.start(requestId, "audio/pcm", locale, refinement, abort.signal).then(async (session) => {
        if (!this.#isCurrent(generation, abort)) {
          await this.#transport.cancel(session.id).catch(() => undefined);
          throw new MobileVoiceRunError("cancelled");
        }
        this.#acceptInitialSession(session);
        this.#releaseBarrier();
        return session;
      });
      const capturePromise = this.#capture.start(
        (chunk) => this.#enqueuePcm(chunk, generation),
        (error) => { void this.#fail(new MobileVoiceRunError("captureFailed", { cause: error }), generation); },
        abort.signal
      ).then(async (stop) => {
        if (!this.#isCurrent(generation, abort)) {
          await stop().catch(() => undefined);
          throw new MobileVoiceRunError("cancelled");
        }
        this.#stopCapture = stop;
        if (this.#stopRequested) await this.#finishCapture();
        return stop;
      });
      await Promise.all([sessionPromise, capturePromise]);
      this.#assertOwner();
      if (!this.#isCurrent(generation, abort)) throw new MobileVoiceRunError("cancelled");
      this.#setState("listening", this.#session);
      this.#schedulePoll(generation);
      if (this.#stopRequested) {
        this.#stopRequested = false;
        await this.stop();
      }
    } catch (error) {
      this.#releaseBarrier();
      const normalized = normalizeMobileVoiceRunError(error);
      if (normalized.code === "cancelled" || !this.#isGeneration(generation)) return;
      await this.#fail(normalized, generation);
      throw normalized;
    } finally {
      if (this.#abort === abort && this.#state !== "listening" && this.#state !== "submitting") {
        this.#abort = undefined;
      }
    }
  }

  async stop(): Promise<MobileVoiceSession | undefined> {
    if (this.#state === "starting") {
      this.#stopRequested = true;
      // Capture and the service handshake start concurrently. Release an
      // already-open microphone immediately; a later capture handle observes
      // #stopRequested above and closes itself before the handshake settles.
      await this.#finishCapture();
      return this.#session;
    }
    if (this.#state !== "listening" || this.#session === undefined) return this.#session;
    const generation = this.#generation;
    this.#setState("submitting", this.#session);
    this.#pollAbort?.abort();
    this.#clearPoll();
    try {
      await this.#finishCapture();
      try { this.#onCaptureStopped(); }
      catch { /* Optional local feedback must not fail transcription. */ }
      await this.#appendChain;
      if (!this.#isGeneration(generation) || this.#session === undefined) return undefined;
      if (isMobileVoiceTerminal(this.#session)) return this.#session;
      this.#assertOwner();
      const result = await this.#transport.stop(this.#session.id, this.#chunkSequence, this.#abort?.signal);
      if (!this.#isGeneration(generation)) return undefined;
      const current = this.#acceptSession(result);
      if (isMobileVoiceTerminal(current)) {
        await this.#finishTerminal(current);
      } else {
        this.#schedulePoll(generation, true);
      }
      return current;
    } catch (error) {
      const normalized = normalizeMobileVoiceRunError(error);
      if (this.#isGeneration(generation)) await this.#fail(normalized, generation);
      throw normalized;
    }
  }

  async cancel(): Promise<void> {
    if (this.#state === "cancelled" || this.#state === "done") return;
    ++this.#generation;
    this.#stopRequested = false;
    const id = this.#session?.id;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#pollAbort?.abort();
    this.#pollAbort = undefined;
    this.#clearPoll();
    this.#releaseBarrier();
    await this.#finishCapture();
    this.#session = undefined;
    this.#setState("cancelled");
    if (id !== undefined) await this.#transport.cancel(id).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.cancel();
  }

  #enqueuePcm(chunk: MobileVoicePcmChunk, generation: number): void {
    if (!this.#isGeneration(generation) || this.#state !== "starting" && this.#state !== "listening") return;
    let exact: MobileVoicePcmChunk;
    try { exact = assertMobileVoicePcmChunk(chunk); }
    catch (error) { void this.#fail(new MobileVoiceRunError("captureFailed", { cause: error }), generation); return; }
    const capability = this.#capability;
    if (capability === undefined) return;
    const nextBytes = this.#capturedBytes + exact.audio.byteLength;
    const nextDuration = this.#capturedDurationMs + exact.durationMs;
    if (exact.audio.byteLength > capability.limits.maximumAudioChunkBytes
      || exact.durationMs > capability.limits.maximumAudioChunkDurationMs
      || nextBytes > capability.limits.maximumAudioBytes
      || nextDuration > capability.limits.maximumAudioDurationMs) {
      void this.#fail(new MobileVoiceRunError("audioLimit"), generation);
      return;
    }
    this.#capturedBytes = nextBytes;
    this.#capturedDurationMs = nextDuration;
    const audio = Uint8Array.from(exact.audio);
    this.#appendChain = this.#appendChain.then(async () => {
      await this.#startBarrier;
      if (!this.#isGeneration(generation) || this.#session === undefined
        || this.#state !== "listening" && this.#state !== "submitting") return;
      this.#assertOwner();
      const sequence = this.#chunkSequence;
      const priorBytes = this.#acceptedBytes;
      const priorDuration = this.#acceptedDurationMs;
      const result = await this.#transport.append(
        this.#session.id,
        sequence,
        audio,
        exact.durationMs,
        exact.voiced,
        this.#abort?.signal
      );
      if (!this.#isGeneration(generation)) return;
      if (isMobileVoiceTerminal(result)) {
        const current = this.#acceptSession(result);
        if (isMobileVoiceTerminal(current)) await this.#finishTerminal(current);
        return;
      }
      if (result.nextChunkSequence !== sequence + 1n
        || result.acceptedAudioBytes !== priorBytes + audio.byteLength
        || result.acceptedAudioDurationMs !== priorDuration + exact.durationMs) {
        throw new MobileVoiceRunError("serviceUnavailable");
      }
      this.#acceptSession(result);
    }).catch(async (error: unknown) => {
      if (this.#isGeneration(generation)) await this.#fail(normalizeMobileVoiceRunError(error), generation);
    });
  }

  #schedulePoll(generation: number, immediate = false): void {
    this.#clearPoll();
    if (!this.#isGeneration(generation) || this.#session === undefined || isMobileVoiceTerminal(this.#session)) return;
    this.#pollTimer = this.#setTimer(() => {
      this.#pollTimer = undefined;
      void this.#poll(generation);
    }, immediate ? 0 : TERMINAL_POLL_INTERVAL_MS);
  }

  async #poll(generation: number): Promise<void> {
    if (!this.#isGeneration(generation) || this.#session === undefined) return;
    const abort = new AbortController();
    this.#pollAbort = abort;
    try {
      this.#assertOwner();
      const result = await this.#transport.get(this.#session.id, abort.signal);
      if (!this.#isGeneration(generation) || abort.signal.aborted) return;
      const current = this.#acceptSession(result);
      if (isMobileVoiceTerminal(current)) await this.#finishTerminal(current);
      else {
        if (current.state === "submitting" || current.state === "refining") this.#setState("submitting", current);
        this.#schedulePoll(generation);
      }
    } catch (error) {
      if (!abort.signal.aborted && this.#isGeneration(generation)) {
        await this.#fail(normalizeMobileVoiceRunError(error), generation);
      }
    } finally {
      if (this.#pollAbort === abort) this.#pollAbort = undefined;
    }
  }

  #acceptInitialSession(session: MobileVoiceSession): void {
    if (session.state !== "listening" || session.outcome !== undefined || session.nextChunkSequence !== 1n
      || session.acceptedAudioBytes !== 0 || session.acceptedAudioDurationMs !== 0) {
      throw new MobileVoiceRunError("serviceUnavailable");
    }
    this.#session = session;
    this.#chunkSequence = session.nextChunkSequence;
    this.#acceptedBytes = session.acceptedAudioBytes;
    this.#acceptedDurationMs = session.acceptedAudioDurationMs;
    this.#onUpdate({ state: this.#state, session });
  }

  #acceptSession(session: MobileVoiceSession): MobileVoiceSession {
    const current = this.#session;
    if (current !== undefined && (session.id !== current.id || session.createdAt !== current.createdAt)) {
      throw new MobileVoiceRunError("serviceUnavailable");
    }
    if (current !== undefined && (session.updatedAt < current.updatedAt
      || session.nextChunkSequence < current.nextChunkSequence
      || session.acceptedAudioBytes < current.acceptedAudioBytes
      || session.acceptedAudioDurationMs < current.acceptedAudioDurationMs)) return current;
    this.#session = session;
    this.#chunkSequence = session.nextChunkSequence;
    this.#acceptedBytes = session.acceptedAudioBytes;
    this.#acceptedDurationMs = session.acceptedAudioDurationMs;
    // Terminal snapshots are published once by #finishTerminal with their
    // final UI state. Publishing here as well would apply the same transcript
    // twice to clients that retire their temporary insertion at completion.
    if (!this.#disposed && !isMobileVoiceTerminal(session)) this.#onUpdate({ state: this.#state, session });
    return session;
  }

  async #finishTerminal(session: MobileVoiceSession): Promise<void> {
    this.#pollAbort?.abort();
    this.#pollAbort = undefined;
    this.#clearPoll();
    await this.#finishCapture();
    this.#abort = undefined;
    if (session.state === "done" && session.outcome === "success") {
      this.#setState("done", session);
    } else if (session.outcome === "cancelled") {
      this.#setState("cancelled", session);
    } else {
      this.#setState("error", session, new MobileVoiceRunError(
        session.outcome === "noSpeech" || session.failure?.code === "emptyTranscript"
          ? "noSpeech"
          : "transcriptionFailed"
      ));
    }
  }

  async #fail(error: MobileVoiceRunError, generation: number): Promise<void> {
    if (!this.#isGeneration(generation) || ["cancelled", "done", "error"].includes(this.#state)) return;
    ++this.#generation;
    const id = this.#session?.id;
    this.#stopRequested = false;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#pollAbort?.abort();
    this.#pollAbort = undefined;
    this.#clearPoll();
    this.#releaseBarrier();
    await this.#finishCapture();
    this.#setState("error", this.#session, error);
    if (id !== undefined) await this.#transport.cancel(id).catch(() => undefined);
  }

  async #finishCapture(): Promise<void> {
    const stop = this.#stopCapture;
    this.#stopCapture = undefined;
    try { await stop?.(); }
    finally { await this.#capture.release().catch(() => undefined); }
  }

  #setState(state: MobileVoiceRunState, session = this.#session, error?: MobileVoiceRunError): void {
    this.#state = state;
    if (!this.#disposed) this.#onUpdate({ state, ...(session === undefined ? {} : { session }), ...(error === undefined ? {} : { error }) });
  }

  #releaseBarrier(): void {
    const release = this.#releaseStartBarrier;
    this.#releaseStartBarrier = undefined;
    release?.();
  }

  #clearPoll(): void {
    if (this.#pollTimer === undefined) return;
    this.#clearTimer(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  #assertOwner(): void {
    if (!this.#transport.isCurrent()) throw new MobileVoiceRunError("ownerChanged");
  }

  #isGeneration(generation: number): boolean {
    return generation === this.#generation && this.#state !== "cancelled";
  }

  #isCurrent(generation: number, abort: AbortController): boolean {
    return this.#isGeneration(generation) && !abort.signal.aborted;
  }
}

export interface MobileVoiceDraftInsertion {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function isMobileVoiceInsertionIntact(text: string, insertion: MobileVoiceDraftInsertion): boolean {
  return insertion.start >= 0 && insertion.end >= insertion.start && insertion.end <= text.length
    && text.slice(insertion.start, insertion.end) === insertion.text;
}

export function reconcileMobileVoiceInsertion(
  previousText: string,
  nextText: string,
  insertion: MobileVoiceDraftInsertion
): { readonly insertion?: MobileVoiceDraftInsertion; readonly overlapped: boolean } {
  if (!isMobileVoiceInsertionIntact(previousText, insertion)) return { overlapped: true };
  if (previousText === nextText) return { insertion, overlapped: false };
  let prefix = 0;
  while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousText.length - prefix && suffix < nextText.length - prefix
    && previousText[previousText.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1;
  const oldEnd = previousText.length - suffix;
  const newEnd = nextText.length - suffix;
  const delta = newEnd - oldEnd;
  if (oldEnd <= insertion.start) {
    return { insertion: { ...insertion, start: insertion.start + delta, end: insertion.end + delta }, overlapped: false };
  }
  if (prefix >= insertion.end) return { insertion, overlapped: false };
  return { overlapped: true };
}

export function supportsMobileVoiceCapture(capability: MobileVoiceCapability, captureAvailable: boolean): boolean {
  return captureAvailable && capability.support === "supported"
    && capability.limits.supportedMimeTypes.includes("audio/pcm")
    && capability.limits.maximumAudioChunkBytes >= 2
    && capability.limits.maximumAudioBytes >= 2
    && capability.limits.maximumAudioChunkDurationMs >= 1
    && capability.limits.maximumAudioDurationMs >= 1
    && capability.limits.maximumConcurrentSessions >= 1;
}

export function assertMobileVoicePcmChunk(value: MobileVoicePcmChunk): MobileVoicePcmChunk {
  if (!(value.audio instanceof Uint8Array) || value.audio.byteLength < 2 || value.audio.byteLength % 2 !== 0
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || typeof value.voiced !== "boolean") {
    throw new Error("Native voice capture returned an invalid PCM chunk.");
  }
  return { audio: Uint8Array.from(value.audio), durationMs: value.durationMs, voiced: value.voiced };
}

export function projectMobileVoiceCapability(profile: ProtoVoiceInputCapabilityProfile | undefined): MobileVoiceCapability {
  if (profile === undefined || profile.limits === undefined) throw new Error("The Joko node returned no voice input capability limits.");
  const supportedMimeTypes = [...new Set(profile.limits.supportedMimeTypes.map((value) => {
    const normalized = value.trim().toLocaleLowerCase("en-US");
    if (!normalized || normalized.length > 64) throw new Error("The Joko node returned an invalid voice input media type.");
    return normalized;
  }))];
  const support = mobileVoiceCapabilitySupport(profile.capability?.support);
  if (support === "supported" && supportedMimeTypes.length === 0) {
    throw new Error("The Joko node reported voice input support without a media type.");
  }
  return {
    support,
    ...(profile.capability?.reason.trim() ? { reason: profile.capability.reason.trim().slice(0, 512) } : {}),
    limits: {
      supportedMimeTypes,
      maximumAudioChunkBytes: safeCounter(profile.limits.maximumAudioChunkBytes, "audio chunk byte limit"),
      maximumAudioBytes: safeCounter(profile.limits.maximumAudioBytes, "audio byte limit"),
      maximumAudioChunkDurationMs: durationMs(profile.limits.maximumAudioChunkDuration, "audio chunk duration limit"),
      maximumAudioDurationMs: durationMs(profile.limits.maximumAudioDuration, "audio duration limit"),
      maximumLocaleCharacters: safeNumber(profile.limits.maximumLocaleCharacters, "locale character limit"),
      stableWaitMs: durationMs(profile.limits.stableWait, "stable wait"),
      maximumConcurrentSessions: safeNumber(profile.limits.maximumConcurrentSessions, "concurrent session limit")
    },
    supportsLocale: profile.supportsLocale,
    supportsLiveDrafts: profile.supportsLiveDrafts,
    supportsRefinement: profile.supportsRefinement
  };
}

export function projectMobileVoiceSession(value: ProtoVoiceInputSession | undefined): MobileVoiceSession {
  if (value === undefined || !IDENTIFIER_PATTERN.test(value.voiceInputId.trim())) {
    throw new Error("The Joko node returned an invalid voice input session.");
  }
  const createdAt = timestampMs(value.createdAt, "created");
  const updatedAt = timestampMs(value.updatedAt, "updated");
  if (updatedAt < createdAt || value.nextChunkSequence < 1n) {
    throw new Error("The Joko node returned an invalid voice input session sequence.");
  }
  const outcome = mobileVoiceOutcome(value.outcome);
  return {
    id: value.voiceInputId.trim(),
    state: mobileVoiceState(value.state),
    ...(outcome === undefined ? {} : { outcome }),
    ...(value.draft === undefined ? {} : { draft: {
      text: mobileVoiceText(value.draft.text),
      source: mobileVoiceTextSource(value.draft.source)
    } }),
    ...(value.result === undefined ? {} : { result: {
      text: mobileVoiceText(value.result.text),
      source: mobileVoiceTextSource(value.result.source),
      salvaged: value.result.salvaged,
      ...(value.result.rawTranscriptText === undefined ? {} : {
        rawTranscriptText: mobileVoiceText(value.result.rawTranscriptText)
      })
    } }),
    ...(value.failure === undefined ? {} : { failure: {
      code: mobileVoiceFailureCode(value.failure.code),
      transcriptKept: value.failure.transcriptKept
    } }),
    nextChunkSequence: value.nextChunkSequence,
    acceptedAudioBytes: safeCounter(value.acceptedAudioBytes, "accepted audio bytes"),
    acceptedAudioDurationMs: durationMs(value.acceptedAudioDuration, "accepted audio duration"),
    createdAt,
    updatedAt,
    recoveryAttempts: safeNumber(value.recoveryAttempts, "recovery count"),
    stallWarning: value.stallWarning
  };
}

export function normalizeMobileVoiceRunError(error: unknown): MobileVoiceRunError {
  if (error instanceof MobileVoiceRunError) return error;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name?: unknown }).name)
    : "";
  if (name === "AbortError") return new MobileVoiceRunError("cancelled", { cause: error });
  return new MobileVoiceRunError("serviceUnavailable", { cause: error });
}

function normalizeMobileVoiceLocale(value: string | undefined, capability: MobileVoiceCapability): string | undefined {
  const locale = value?.trim();
  if (!locale) return undefined;
  if (locale.length > capability.limits.maximumLocaleCharacters || !/^[A-Za-z0-9-]+$/u.test(locale)) return undefined;
  return locale;
}

function isMobileVoiceTerminal(session: MobileVoiceSession): boolean {
  return session.state === "done" || session.state === "error" || session.outcome !== undefined;
}

function mobileVoiceCapabilitySupport(value: CapabilitySupport | undefined): MobileVoiceCapabilitySupport {
  switch (value) {
    case CapabilitySupport.SUPPORTED: return "supported";
    case CapabilitySupport.UPSTREAM_MISSING: return "upstreamMissing";
    case CapabilitySupport.NOT_IMPLEMENTED: return "notImplemented";
    case CapabilitySupport.PLATFORM_LIMITED: return "platformLimited";
    case CapabilitySupport.DISABLED_BY_POLICY: return "disabledByPolicy";
    case CapabilitySupport.TEMPORARILY_UNAVAILABLE: return "temporarilyUnavailable";
    case CapabilitySupport.UNSPECIFIED:
    case undefined: return "unspecified";
  }
}

function mobileVoiceState(value: ProtoVoiceInputState): MobileVoiceState {
  switch (value) {
    case ProtoVoiceInputState.IDLE: return "idle";
    case ProtoVoiceInputState.LISTENING: return "listening";
    case ProtoVoiceInputState.SUBMITTING: return "submitting";
    case ProtoVoiceInputState.REFINING: return "refining";
    case ProtoVoiceInputState.DONE: return "done";
    case ProtoVoiceInputState.ERROR: return "error";
    case ProtoVoiceInputState.UNSPECIFIED: throw new Error("The Joko node returned an unspecified voice input state.");
  }
}

function mobileVoiceOutcome(value: ProtoVoiceInputTerminalOutcome): MobileVoiceOutcome | undefined {
  switch (value) {
    case ProtoVoiceInputTerminalOutcome.UNSPECIFIED: return undefined;
    case ProtoVoiceInputTerminalOutcome.SUCCESS: return "success";
    case ProtoVoiceInputTerminalOutcome.NO_SPEECH: return "noSpeech";
    case ProtoVoiceInputTerminalOutcome.FAILED: return "failed";
    case ProtoVoiceInputTerminalOutcome.CANCELLED: return "cancelled";
  }
}

function mobileVoiceTextSource(value: ProtoVoiceInputTextSource): MobileVoiceTextSource {
  switch (value) {
    case ProtoVoiceInputTextSource.PARTIAL: return "partial";
    case ProtoVoiceInputTextSource.STABLE: return "stable";
    case ProtoVoiceInputTextSource.UNSPECIFIED: throw new Error("The Joko node returned an unspecified voice text source.");
  }
}

function mobileVoiceFailureCode(value: ProtoVoiceInputFailureCode): MobileVoiceFailureCode {
  switch (value) {
    case ProtoVoiceInputFailureCode.CONNECTION_INTERRUPTED: return "connectionInterrupted";
    case ProtoVoiceInputFailureCode.EMPTY_TRANSCRIPT: return "emptyTranscript";
    case ProtoVoiceInputFailureCode.HOST_SUBMISSION_FAILED: return "hostSubmissionFailed";
    case ProtoVoiceInputFailureCode.PROVIDER_AUTHENTICATION: return "providerAuthentication";
    case ProtoVoiceInputFailureCode.PROVIDER_CLOSE_FAILED: return "providerCloseFailed";
    case ProtoVoiceInputFailureCode.PROVIDER_ERROR: return "providerError";
    case ProtoVoiceInputFailureCode.PROVIDER_FLUSH_FAILED: return "providerFlushFailed";
    case ProtoVoiceInputFailureCode.PROVIDER_PROTOCOL: return "providerProtocol";
    case ProtoVoiceInputFailureCode.PROVIDER_QUOTA: return "providerQuota";
    case ProtoVoiceInputFailureCode.PROVIDER_START_FAILED: return "providerStartFailed";
    case ProtoVoiceInputFailureCode.UNSPECIFIED: throw new Error("The Joko node returned an unspecified voice input failure.");
  }
}

function mobileVoiceText(value: string): string {
  if (value.length > MAXIMUM_TRANSCRIPT_CHARACTERS) throw new Error("The Joko node returned an oversized voice transcript.");
  return value.replace(/\r\n?/gu, "\n");
}

function safeCounter(value: bigint, label: string): number {
  const mapped = Number(value);
  if (!Number.isSafeInteger(mapped) || mapped < 0) throw new Error(`The Joko node returned an invalid voice input ${label}.`);
  return mapped;
}

function safeNumber(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`The Joko node returned an invalid voice input ${label}.`);
  return value;
}

function durationMs(value: { readonly seconds: bigint; readonly nanos: number } | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) {
    throw new Error(`The Joko node returned an invalid voice input ${label}.`);
  }
  const mapped = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(mapped) || mapped < 0) throw new Error(`The Joko node returned an invalid voice input ${label}.`);
  return mapped;
}

function timestampMs(value: { readonly seconds: bigint; readonly nanos: number } | undefined, label: string): number {
  const mapped = durationMs(value, `${label} time`);
  if (mapped < 0) throw new Error(`The Joko node returned an invalid voice input ${label} time.`);
  return mapped;
}
