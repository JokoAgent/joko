import { requireNativeModule } from "expo-modules-core";
import { AppState, Platform } from "react-native";
import type {
  MobileVoiceCaptureRuntime,
  MobileVoicePcmChunk,
  MobileVoicePermission
} from "./mobile-voice-input";
import {
  createPcm16Converter,
  decodeBase64Pcm,
  mobilePcmIsVoiced
} from "./mobile-pcm";

interface EventSubscription { remove(): void }

type NativeChunkEvent = {
  readonly base64Pcm16: string;
  readonly capturedAt: number;
  readonly chunkIndex: number;
  readonly sampleRate: number;
  readonly durationMs: number;
};

type NativeErrorEvent = { readonly message: string };

type NativeRealtimeAudioModule = {
  start(options?: { sampleRate?: number; bufferSize?: number }): Promise<void>;
  stop(): Promise<void>;
  prewarm(): Promise<void>;
  addListener(eventName: "onAudioChunk", listener: (event: NativeChunkEvent) => void): EventSubscription;
  addListener(eventName: "onAudioError", listener: (event: NativeErrorEvent) => void): EventSubscription;
};

type ExpoAudioStreamBufferEvent = {
  readonly data: ArrayBuffer;
  readonly sampleRate: number;
  readonly channels: number;
  readonly timestamp: number;
};

type ExpoAudioStreamStatusEvent = { readonly isStreaming: boolean };

type ExpoAudioStream = {
  readonly id: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly isStreaming: boolean;
  addListener(eventName: "audioStreamBuffer", listener: (event: ExpoAudioStreamBufferEvent) => void): EventSubscription;
  addListener(eventName: "audioStreamStatus", listener: (event: ExpoAudioStreamStatusEvent) => void): EventSubscription;
  start(): Promise<void>;
  stop(): void;
  release(): void;
};

type ExpoAudioNativeModule = {
  AudioStream: new (options: { sampleRate: number; channels: number; encoding: "int16" }) => ExpoAudioStream;
};

const TARGET_SAMPLE_RATE = 16_000;
const NATIVE_BUFFER_SIZE = 2_048;
const STREAM_STALL_TIMEOUT_MS = 5_000;
const STREAM_WATCHDOG_INTERVAL_MS = 1_000;
const PERMISSION_FOREGROUND_TIMEOUT_MS = 30_000;

let nativeBinding: NativeRealtimeAudioModule | null | undefined;
let expoAudioBinding: ExpoAudioNativeModule | null | undefined;
let expoAudioModeActive = false;
let activeCaptureStop: (() => Promise<void>) | undefined;
let captureTransition: Promise<void> = Promise.resolve();

export const mobileVoiceCaptureRuntime: MobileVoiceCaptureRuntime = {
  isAvailable: isMobileRealtimeAudioAvailable,
  ensurePermission: ensureMobileMicrophonePermission,
  start: startMobileRealtimeAudio,
  release: releaseMobileRealtimeAudio
};

export function isMobileRealtimeAudioAvailable(): boolean {
  return getNativeBinding() !== null || getExpoAudioBinding() !== null;
}

export function prewarmMobileRealtimeAudio(): void {
  const binding = getNativeBinding();
  if (!binding) return;
  void binding.prewarm().catch(() => undefined);
}

export async function ensureMobileMicrophonePermission(signal: AbortSignal): Promise<MobileVoicePermission> {
  throwIfAborted(signal);
  if (AppState.currentState !== "active") throw abortError();
  const audio = await import("expo-audio");
  throwIfAborted(signal);
  let permission = await audio.getRecordingPermissionsAsync();
  throwIfAborted(signal);
  let openedPrompt = false;
  if (!permission.granted && permission.canAskAgain) {
    openedPrompt = true;
    permission = await audio.requestRecordingPermissionsAsync();
    throwIfAborted(signal);
  }
  if (openedPrompt && permission.granted && AppState.currentState !== "active") {
    await waitForAppActive(signal);
  }
  throwIfAborted(signal);
  if (AppState.currentState !== "active") throw abortError();
  return { granted: permission.granted, canAskAgain: permission.canAskAgain };
}

export async function startMobileRealtimeAudio(
  onChunk: (chunk: MobileVoicePcmChunk) => void,
  onError: (error: Error) => void,
  signal: AbortSignal
): Promise<() => Promise<void>> {
  const previousTransition = captureTransition;
  let releaseTransition!: () => void;
  captureTransition = new Promise<void>((resolve) => { releaseTransition = resolve; });
  await previousTransition;
  try {
    throwIfAborted(signal);
    await activeCaptureStop?.();
    throwIfAborted(signal);
    const native = getNativeBinding();
    const expo = native === null ? getExpoAudioBinding() : null;
    const rawStop = native !== null
      ? await startNativeAudio(native, onChunk, onError, signal)
      : expo !== null
        ? await startExpoAudio(expo, onChunk, onError, signal)
        : undefined;
    if (rawStop === undefined) throw new Error("Realtime PCM microphone capture is unavailable.");
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        try { await rawStop(); }
        finally {
          await releaseMobileRealtimeAudio();
          if (activeCaptureStop === stop) activeCaptureStop = undefined;
        }
      })();
      return stopPromise;
    };
    activeCaptureStop = stop;
    return stop;
  } finally {
    releaseTransition();
  }
}

export async function releaseMobileRealtimeAudio(): Promise<void> {
  if (!expoAudioModeActive) return;
  expoAudioModeActive = false;
  try {
    const audio = await import("expo-audio");
    await audio.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  } catch {
    // Capture teardown already released the native stream; audio-mode reset is best effort.
  }
}

async function startNativeAudio(
  module: NativeRealtimeAudioModule,
  onChunk: (chunk: MobileVoicePcmChunk) => void,
  onError: (error: Error) => void,
  signal: AbortSignal
): Promise<() => Promise<void>> {
  let stopped = false;
  let nextChunkIndex = 0;
  const subscriptions: EventSubscription[] = [];
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    subscriptions.splice(0).forEach((subscription) => subscription.remove());
    await module.stop().catch(() => undefined);
  };
  const onAbort = (): void => { void stop(); };
  try {
    subscriptions.push(module.addListener("onAudioChunk", (event) => {
      if (stopped || signal.aborted) return;
      try {
        if (event.sampleRate !== TARGET_SAMPLE_RATE || event.chunkIndex !== nextChunkIndex
          || !Number.isFinite(event.capturedAt) || event.capturedAt <= 0) {
          throw new Error("Native voice capture returned an invalid PCM sequence.");
        }
        nextChunkIndex += 1;
        const audio = decodeBase64Pcm(event.base64Pcm16);
        const durationMs = normalizeDuration(event.durationMs, audio.byteLength);
        onChunk({ audio, durationMs, voiced: mobilePcmIsVoiced(audio) });
      } catch (error) {
        onError(error instanceof Error ? error : new Error("Native PCM conversion failed."));
      }
    }));
    subscriptions.push(module.addListener("onAudioError", (event) => {
      if (!stopped && !signal.aborted) onError(new Error(event.message || "Native voice capture failed."));
    }));
    signal.addEventListener("abort", onAbort, { once: true });
    await module.start({ sampleRate: TARGET_SAMPLE_RATE, bufferSize: NATIVE_BUFFER_SIZE });
    throwIfAborted(signal);
  } catch (error) {
    await stop();
    signal.removeEventListener("abort", onAbort);
    throw error;
  }
  return async () => {
    signal.removeEventListener("abort", onAbort);
    await stop();
  };
}

async function startExpoAudio(
  module: ExpoAudioNativeModule,
  onChunk: (chunk: MobileVoicePcmChunk) => void,
  onError: (error: Error) => void,
  signal: AbortSignal
): Promise<() => Promise<void>> {
  const audio = await import("expo-audio");
  await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  expoAudioModeActive = true;
  let stream: ExpoAudioStream | undefined;
  let stopped = false;
  let started = false;
  let failureReported = false;
  let lastChunkAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const subscriptions: EventSubscription[] = [];
  const stop = async (): Promise<void> => {
    if (watchdog !== undefined) clearInterval(watchdog);
    watchdog = undefined;
    if (stopped) return;
    stopped = true;
    subscriptions.splice(0).forEach((subscription) => subscription.remove());
    try { stream?.stop(); } catch { /* interruption may already have stopped it */ }
    try { stream?.release(); } catch { /* shared object may already be released */ }
    stream = undefined;
  };
  const reportFailure = (error = new Error("Realtime voice capture was interrupted.")): void => {
    if (stopped || failureReported) return;
    failureReported = true;
    void stop();
    onError(error);
  };
  const onAbort = (): void => { void stop(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    const convert = createPcm16Converter(TARGET_SAMPLE_RATE);
    stream = new module.AudioStream({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, encoding: "int16" });
    subscriptions.push(
      stream.addListener("audioStreamBuffer", (event) => {
        if (stopped || signal.aborted) return;
        lastChunkAt = Date.now();
        try {
          const converted = convert(event.data, event.sampleRate, event.channels);
          if (converted.byteLength === 0) return;
          onChunk({
            audio: converted,
            durationMs: normalizeDuration(converted.byteLength / 2 / TARGET_SAMPLE_RATE * 1_000, converted.byteLength),
            voiced: mobilePcmIsVoiced(converted)
          });
        } catch (error) {
          reportFailure(error instanceof Error ? error : new Error("Realtime PCM conversion failed."));
        }
      }),
      stream.addListener("audioStreamStatus", (event) => {
        if (!event.isStreaming && started && !stopped) reportFailure();
      })
    );
    await stream.start();
    throwIfAborted(signal);
    if (stopped) throw abortError();
    started = true;
    lastChunkAt = Date.now();
    watchdog = setInterval(() => {
      if (Date.now() - lastChunkAt > STREAM_STALL_TIMEOUT_MS) reportFailure();
    }, STREAM_WATCHDOG_INTERVAL_MS);
  } catch (error) {
    await stop();
    signal.removeEventListener("abort", onAbort);
    await releaseMobileRealtimeAudio();
    throw error;
  }
  return async () => {
    signal.removeEventListener("abort", onAbort);
    await stop();
  };
}

export const __testing = {
  resetBindings(): void {
    nativeBinding = undefined;
    expoAudioBinding = undefined;
    expoAudioModeActive = false;
    activeCaptureStop = undefined;
    captureTransition = Promise.resolve();
  }
};

function getNativeBinding(): NativeRealtimeAudioModule | null {
  if (nativeBinding !== undefined) return nativeBinding;
  if (Platform.OS !== "ios") { nativeBinding = null; return null; }
  try { nativeBinding = requireNativeModule<NativeRealtimeAudioModule>("JokoMobileRealtimeAudio"); }
  catch { nativeBinding = null; }
  return nativeBinding;
}

function getExpoAudioBinding(): ExpoAudioNativeModule | null {
  if (expoAudioBinding !== undefined) return expoAudioBinding;
  try {
    const module = requireNativeModule<ExpoAudioNativeModule>("ExpoAudio");
    expoAudioBinding = typeof module.AudioStream === "function" ? module : null;
  } catch { expoAudioBinding = null; }
  return expoAudioBinding;
}

function normalizeDuration(value: number, byteLength: number): number {
  const duration = Math.max(1, Math.round(value));
  if (!Number.isSafeInteger(duration) || duration > 10_000 || byteLength !== duration * 32
    && Math.abs(byteLength / 32 - duration) > 2) {
    throw new Error("Native voice capture returned an invalid PCM duration.");
  }
  return duration;
}

function waitForAppActive(signal: AbortSignal): Promise<void> {
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscription: EventSubscription | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => finish(() => reject(abortError()));
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      subscription?.remove();
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") finish(resolve);
    });
    timer = setTimeout(() => finish(() => reject(abortError())), PERMISSION_FOREGROUND_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (AppState.currentState === "active") finish(resolve);
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Voice input was cancelled.");
  error.name = "AbortError";
  return error;
}
