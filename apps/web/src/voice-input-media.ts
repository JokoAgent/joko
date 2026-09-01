import type {
  OperationApi,
  VoiceInputCapabilityView,
  VoiceInputSessionView
} from "./model.js";
import { randomUuid } from "./web-crypto.js";
import { playVoiceInputCue } from "./voice-input-cue.js";
import {
  WebAudioVoicePcmCapture,
  hasVoicePcmCapture,
  type VoicePcmCapture,
  type VoicePcmCaptureFactory,
  type VoicePcmChunk
} from "./voice-input-pcm.js";

const DEFAULT_CHUNK_DURATION_MS = 250;
const TERMINAL_POLL_INTERVAL_MS = 180;

export type VoiceMediaState = "idle" | "starting" | "listening" | "submitting" | "done" | "error" | "cancelled";

export interface VoiceMediaSessionUpdate {
  readonly state: VoiceMediaState;
  readonly session?: VoiceInputSessionView;
  readonly error?: VoiceMediaError;
}

export type VoiceMediaErrorCode =
  | "unsupported"
  | "permissionDenied"
  | "deviceUnavailable"
  | "deviceBusy"
  | "captureFailed"
  | "audioLimit"
  | "serviceUnavailable"
  | "cancelled";

export class VoiceMediaError extends Error {
  readonly code: VoiceMediaErrorCode;

  constructor(code: VoiceMediaErrorCode, options: { readonly cause?: unknown } = {}) {
    super(VOICE_MEDIA_ERROR_MESSAGES[code], options);
    this.name = "VoiceMediaError";
    this.code = code;
  }
}

export interface VoiceMediaPreferences {
  readonly locale?: string;
  readonly deviceId?: string;
  readonly refinementInstructions?: string;
  readonly dictionaryTerms?: readonly string[];
  readonly playInteractionSound?: boolean;
}

export interface VoiceMediaSessionOptions {
  readonly api: OperationApi;
  readonly preferences?: VoiceMediaPreferences;
  readonly onUpdate?: (update: VoiceMediaSessionUpdate) => void;
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  readonly mediaRecorder?: typeof MediaRecorder;
  readonly pcmCaptureFactory?: VoicePcmCaptureFactory;
  readonly prewarmedStream?: MediaStream;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (handle: number) => void;
}

const VOICE_MEDIA_ERROR_MESSAGES: Readonly<Record<VoiceMediaErrorCode, string>> = {
  unsupported: "Voice input is not supported by this service or browser.",
  permissionDenied: "Microphone permission is required for voice input.",
  deviceUnavailable: "The selected microphone is unavailable.",
  deviceBusy: "The microphone is busy or could not be opened.",
  captureFailed: "Microphone capture stopped unexpectedly.",
  audioLimit: "This voice input reached its audio limit.",
  serviceUnavailable: "Voice input is temporarily unavailable.",
  cancelled: "Voice input was cancelled."
};

/**
 * Owns one ephemeral microphone-to-service session. Audio bytes and transcript
 * values exist only in this instance and are never written to browser storage.
 */
export class VoiceInputMediaSession {
  private readonly api: OperationApi;
  private readonly preferences: VoiceMediaPreferences;
  private readonly onUpdate: (update: VoiceMediaSessionUpdate) => void;
  private readonly mediaDevices: Pick<MediaDevices, "getUserMedia">;
  private readonly MediaRecorderClass: typeof MediaRecorder | undefined;
  private readonly pcmCaptureFactory: VoicePcmCaptureFactory | undefined;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private state: VoiceMediaState = "idle";
  private capability?: VoiceInputCapabilityView;
  private session?: VoiceInputSessionView;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private pcmCapture?: VoicePcmCapture;
  private startAbort?: AbortController;
  private pollAbort?: AbortController;
  private pollTimer?: number;
  private chunkSequence = 1n;
  private acceptedBytes = 0;
  private acceptedDurationMs = 0;
  private lastChunkAt = 0;
  private appendChain: Promise<void> = Promise.resolve();
  private releaseSubscription?: () => void;
  private trackCleanup: Array<() => void> = [];
  private generation = 0;
  private disposed = false;
  private stopRequested = false;

  constructor(options: VoiceMediaSessionOptions) {
    this.api = options.api;
    this.preferences = options.preferences ?? {};
    this.onUpdate = options.onUpdate ?? (() => undefined);
    const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    const MediaRecorderClass = options.mediaRecorder ?? globalThis.MediaRecorder;
    const pcmCaptureFactory = options.pcmCaptureFactory
      ?? (hasVoicePcmCapture() ? () => new WebAudioVoicePcmCapture() : undefined);
    if (mediaDevices === undefined || MediaRecorderClass === undefined && pcmCaptureFactory === undefined) {
      throw new VoiceMediaError("unsupported");
    }
    this.mediaDevices = mediaDevices;
    this.MediaRecorderClass = MediaRecorderClass;
    this.pcmCaptureFactory = pcmCaptureFactory;
    this.stream = options.prewarmedStream;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
  }

  get currentState(): VoiceMediaState {
    return this.state;
  }

  get currentSession(): VoiceInputSessionView | undefined {
    return this.session;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.stopRequested = false;
    const generation = ++this.generation;
    this.setState("starting");
    const startAbort = new AbortController();
    this.startAbort = startAbort;
    try {
      const capability = await this.api.getVoiceInputCapabilities(startAbort.signal);
      if (!this.isCurrent(generation) || startAbort.signal.aborted) throw new VoiceMediaError("cancelled");
      if (capability.support !== "supported") throw new VoiceMediaError("unsupported");
      const mimeType = selectVoiceMediaType(capability, this.MediaRecorderClass, this.pcmCaptureFactory !== undefined);
      const chunkDuration = boundedChunkDuration(capability);
      this.capability = capability;
      const stream = this.stream ?? await this.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(this.preferences.deviceId === undefined
              ? {}
              : { deviceId: { exact: this.preferences.deviceId } })
          },
          video: false
        });
      if (!this.isCurrent(generation) || startAbort.signal.aborted) {
        stopMediaStream(stream);
        throw new VoiceMediaError("cancelled");
      }
      this.stream = stream;
      this.watchTracks(stream);
      const recorder = mimeType === "audio/pcm"
        ? undefined
        : new this.MediaRecorderClass!(stream, { mimeType });
      this.recorder = recorder;
      const session = await this.api.startVoiceInput(
        randomUuid(),
        mimeType,
        capability.supportsLocale ? this.preferences.locale : undefined,
        {
          ...(this.preferences.refinementInstructions === undefined
            ? {}
            : { instructions: this.preferences.refinementInstructions }),
          dictionaryTerms: this.preferences.dictionaryTerms ?? []
        },
        startAbort.signal
      );
      if (!this.isCurrent(generation) || startAbort.signal.aborted) {
        if (recorder !== undefined) stopMediaRecorder(recorder);
        stopMediaStream(stream);
        await this.api.cancelVoiceInput(session.id).catch(() => undefined);
        throw new VoiceMediaError("cancelled");
      }
      this.acceptSession(session);
      this.chunkSequence = session.nextChunkSequence;
      this.acceptedBytes = session.acceptedAudioBytes;
      this.acceptedDurationMs = session.acceptedAudioDurationMs;
      this.lastChunkAt = this.now();
      if (mimeType === "audio/pcm") {
        const capture = this.pcmCaptureFactory!();
        this.pcmCapture = capture;
        await capture.start(stream, this.handlePcmChunk);
      } else {
        recorder!.addEventListener("dataavailable", this.handleDataAvailable);
        recorder!.addEventListener("error", this.handleRecorderError);
        recorder!.start(chunkDuration);
      }
      this.releaseSubscription = window.jokoDesktop?.microphone?.onRelease(() => {
        void this.fail(new VoiceMediaError("captureFailed"));
      });
      this.setState("listening", session);
      if (this.preferences.playInteractionSound !== false) playVoiceInputCue("start");
      if (this.stopRequested) {
        this.stopRequested = false;
        await this.stop();
        return;
      }
      this.schedulePoll(generation);
    } catch (error) {
      if (this.currentState === "cancelled" || error instanceof VoiceMediaError && error.code === "cancelled") return;
      await this.fail(normalizeVoiceMediaError(error));
      throw normalizeVoiceMediaError(error);
    } finally {
      if (this.startAbort === startAbort) this.startAbort = undefined;
    }
  }

  async stop(): Promise<VoiceInputSessionView | undefined> {
    if (this.state === "starting") {
      this.stopRequested = true;
      return this.session;
    }
    if (this.state !== "listening" || this.session === undefined) return this.session;
    const generation = this.generation;
    if (this.preferences.playInteractionSound !== false) playVoiceInputCue("stop");
    this.setState("submitting", this.session);
    this.pollAbort?.abort();
    this.clearPoll();
    try {
      await this.finishCapture();
      await this.appendChain;
      if (!this.isCurrent(generation) || this.session === undefined) return this.session;
      const result = await this.api.stopVoiceInput(this.session.id, this.chunkSequence);
      this.acceptSession(result);
      this.stopCaptureResources();
      if (isVoiceSessionTerminal(result)) {
        this.setState(terminalVoiceMediaState(result), result);
        return result;
      }
      this.schedulePoll(generation, true);
      return result;
    } catch (error) {
      const normalized = normalizeVoiceMediaError(error);
      if (this.isCurrent(generation)) await this.fail(normalized);
      throw normalized;
    }
  }

  async cancel(): Promise<void> {
    if (this.state === "cancelled" || this.state === "done") return;
    ++this.generation;
    this.stopRequested = false;
    const id = this.session?.id;
    this.startAbort?.abort();
    this.pollAbort?.abort();
    this.clearPoll();
    this.stopCaptureResources();
    this.session = undefined;
    this.setState("cancelled");
    if (id !== undefined) await this.api.cancelVoiceInput(id).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
  }

  private readonly handleDataAvailable = (event: BlobEvent): void => {
    if (event.data.size === 0 || this.state !== "listening" && this.state !== "submitting") return;
    const endedAt = this.now();
    const durationMs = Math.max(1, Math.round(endedAt - this.lastChunkAt));
    this.lastChunkAt = endedAt;
    this.enqueueAudio(async () => new Uint8Array(await event.data.arrayBuffer()), durationMs, false);
  };

  private readonly handlePcmChunk = (chunk: VoicePcmChunk): void => {
    if (this.state !== "listening" && this.state !== "submitting") return;
    this.enqueueAudio(chunk.audio, chunk.durationMs, chunk.voiced);
  };

  private enqueueAudio(
    source: Uint8Array | (() => Promise<Uint8Array>),
    durationMs: number,
    voiced: boolean
  ): void {
    const generation = this.generation;
    this.appendChain = this.appendChain.then(async () => {
      if (!this.isCurrent(generation) || this.session === undefined) return;
      const capability = this.capability;
      if (capability === undefined) throw new VoiceMediaError("unsupported");
      const audio = typeof source === "function" ? await source() : Uint8Array.from(source);
      if (audio.byteLength === 0) return;
      const nextBytes = this.acceptedBytes + audio.byteLength;
      const nextDuration = this.acceptedDurationMs + durationMs;
      if (
        audio.byteLength > capability.limits.maximumAudioChunkBytes
        || durationMs > capability.limits.maximumAudioChunkDurationMs
        || nextBytes > capability.limits.maximumAudioBytes
        || nextDuration > capability.limits.maximumAudioDurationMs
      ) throw new VoiceMediaError("audioLimit");
      const result = await this.api.appendVoiceAudio(
        this.session.id,
        this.chunkSequence,
        audio,
        durationMs,
        voiced
      );
      if (!this.isCurrent(generation)) return;
      this.chunkSequence = result.nextChunkSequence;
      this.acceptedBytes = result.acceptedAudioBytes;
      this.acceptedDurationMs = result.acceptedAudioDurationMs;
      this.acceptSession(result);
    }).catch((error: unknown) => {
      if (this.isCurrent(generation)) void this.fail(normalizeVoiceMediaError(error));
    });
  }

  private readonly handleRecorderError = (): void => {
    void this.fail(new VoiceMediaError("captureFailed"));
  };

  private watchTracks(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      const onEnded = (): void => { void this.fail(new VoiceMediaError("captureFailed")); };
      track.addEventListener("ended", onEnded);
      this.trackCleanup.push(() => track.removeEventListener("ended", onEnded));
    }
  }

  private schedulePoll(generation: number, immediate = false): void {
    this.clearPoll();
    if (!this.isCurrent(generation) || this.session === undefined || isVoiceSessionTerminal(this.session)) return;
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = undefined;
      void this.poll(generation);
    }, immediate ? 0 : TERMINAL_POLL_INTERVAL_MS);
  }

  private async poll(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.session === undefined) return;
    const pollAbort = new AbortController();
    this.pollAbort = pollAbort;
    try {
      const result = await this.api.getVoiceInputSession(this.session.id, pollAbort.signal);
      if (!this.isCurrent(generation) || pollAbort.signal.aborted) return;
      this.acceptSession(result);
      if (isVoiceSessionTerminal(result)) {
        this.stopCaptureResources();
        this.setState(terminalVoiceMediaState(result), result);
      } else {
        this.schedulePoll(generation);
      }
    } catch (error) {
      if (!pollAbort.signal.aborted && this.isCurrent(generation)) await this.fail(normalizeVoiceMediaError(error));
    } finally {
      if (this.pollAbort === pollAbort) this.pollAbort = undefined;
    }
  }

  private async finishCapture(): Promise<void> {
    const pcmCapture = this.pcmCapture;
    if (pcmCapture !== undefined) {
      this.pcmCapture = undefined;
      await pcmCapture.stop();
      this.stopCaptureResources();
      return;
    }
    const recorder = this.recorder;
    if (recorder === undefined || recorder.state === "inactive") {
      this.stopCaptureResources();
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: number | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        recorder.removeEventListener("stop", onStop);
        if (timeout !== undefined) this.clearTimer(timeout);
        resolve();
      };
      const onStop = (): void => {
        finish();
      };
      recorder.addEventListener("stop", onStop);
      timeout = this.setTimer(finish, 1_000);
      try {
        recorder.requestData();
        recorder.stop();
      } catch {
        finish();
      }
    });
    this.stopCaptureResources();
  }

  private stopCaptureResources(): void {
    const recorder = this.recorder;
    if (recorder !== undefined) {
      recorder.removeEventListener("dataavailable", this.handleDataAvailable);
      recorder.removeEventListener("error", this.handleRecorderError);
      stopMediaRecorder(recorder);
    }
    this.recorder = undefined;
    const pcmCapture = this.pcmCapture;
    this.pcmCapture = undefined;
    void pcmCapture?.stop();
    this.trackCleanup.splice(0).forEach((cleanup) => cleanup());
    stopMediaStream(this.stream);
    this.stream = undefined;
    this.releaseSubscription?.();
    this.releaseSubscription = undefined;
  }

  private clearPoll(): void {
    if (this.pollTimer === undefined) return;
    this.clearTimer(this.pollTimer);
    this.pollTimer = undefined;
  }

  private acceptSession(session: VoiceInputSessionView): void {
    if (this.session !== undefined && this.session.id !== session.id) return;
    this.session = session;
    if (!this.disposed) this.onUpdate({ state: this.state, session });
  }

  private setState(state: VoiceMediaState, session = this.session, error?: VoiceMediaError): void {
    this.state = state;
    if (!this.disposed) this.onUpdate({ state, ...(session === undefined ? {} : { session }), ...(error === undefined ? {} : { error }) });
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.state !== "cancelled";
  }

  private async fail(error: VoiceMediaError): Promise<void> {
    if (this.state === "cancelled" || this.state === "done" || this.state === "error") return;
    ++this.generation;
    this.stopRequested = false;
    const id = this.session?.id;
    this.startAbort?.abort();
    this.pollAbort?.abort();
    this.clearPoll();
    this.stopCaptureResources();
    this.setState("error", this.session, error);
    if (id !== undefined) await this.api.cancelVoiceInput(id).catch(() => undefined);
  }
}

export function selectVoiceMediaType(
  capability: VoiceInputCapabilityView,
  MediaRecorderClass: Pick<typeof MediaRecorder, "isTypeSupported"> | undefined,
  pcmCaptureAvailable = hasVoicePcmCapture()
): string {
  if (pcmCaptureAvailable && capability.limits.supportedMimeTypes.includes("audio/pcm")) return "audio/pcm";
  if (MediaRecorderClass === undefined) throw new VoiceMediaError("unsupported");
  const preferred = ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav"];
  for (const mimeType of preferred) {
    if (capability.limits.supportedMimeTypes.includes(mimeType) && MediaRecorderClass.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  throw new VoiceMediaError("unsupported");
}

export function supportsVoiceMediaCapture(
  capability: VoiceInputCapabilityView,
  MediaRecorderClass: Pick<typeof MediaRecorder, "isTypeSupported"> | undefined,
  pcmCaptureAvailable = hasVoicePcmCapture()
): boolean {
  if (capability.support !== "supported") return false;
  try {
    selectVoiceMediaType(capability, MediaRecorderClass, pcmCaptureAvailable);
    return capability.limits.maximumAudioChunkDurationMs >= 1;
  } catch {
    return false;
  }
}

export function normalizeVoiceMediaError(error: unknown): VoiceMediaError {
  if (error instanceof VoiceMediaError) return error;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name?: unknown }).name)
    : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new VoiceMediaError("permissionDenied", { cause: error });
  if (name === "NotFoundError" || name === "OverconstrainedError") return new VoiceMediaError("deviceUnavailable", { cause: error });
  if (name === "NotReadableError" || name === "AbortError") return new VoiceMediaError("deviceBusy", { cause: error });
  return new VoiceMediaError("serviceUnavailable", { cause: error });
}

function boundedChunkDuration(capability: VoiceInputCapabilityView): number {
  const duration = Math.min(DEFAULT_CHUNK_DURATION_MS, capability.limits.maximumAudioChunkDurationMs);
  if (!Number.isSafeInteger(duration) || duration < 1) throw new VoiceMediaError("unsupported");
  return duration;
}

function isVoiceSessionTerminal(session: VoiceInputSessionView): boolean {
  return session.state === "done" || session.state === "error" || session.outcome !== undefined;
}

function terminalVoiceMediaState(session: VoiceInputSessionView): "done" | "error" {
  return session.state === "done" && session.outcome === "success" ? "done" : "error";
}

function stopMediaRecorder(recorder: MediaRecorder): void {
  if (recorder.state === "inactive") return;
  try { recorder.stop(); } catch { /* already stopping */ }
}

function stopMediaStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
