// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { OperationApi, VoiceInputCapabilityView, VoiceInputSessionView } from "./model.js";
import { VoiceInputMediaSession, VoiceMediaError, normalizeVoiceMediaError, selectVoiceMediaType } from "./voice-input-media.js";
import type { VoicePcmCapture, VoicePcmChunk } from "./voice-input-pcm.js";

const capability: VoiceInputCapabilityView = {
  support: "supported",
  limits: {
    supportedMimeTypes: ["audio/webm"],
    maximumAudioChunkBytes: 1_024,
    maximumAudioBytes: 4_096,
    maximumAudioChunkDurationMs: 500,
    maximumAudioDurationMs: 10_000,
    maximumLocaleCharacters: 35,
    stableWaitMs: 250,
    maximumConcurrentSessions: 1
  },
  supportsLocale: true,
  supportsLiveDrafts: true,
  supportsRefinement: true
};

describe("VoiceInputMediaSession", () => {
  it("captures real recorder bytes in strict sequence, fences stop, and releases the device", async () => {
    const updates: string[] = [];
    const track = new FakeTrack();
    const stream = fakeStream(track);
    const getUserMedia = vi.fn(async () => stream);
    const api = voiceApi();
    api.getVoiceInputCapabilities = vi.fn(async () => capability);
    api.startVoiceInput = vi.fn(async () => voiceSession());
    api.appendVoiceAudio = vi.fn(async (_id, _sequence, audio, durationMs) => voiceSession({
      nextChunkSequence: 2n,
      acceptedAudioBytes: audio.byteLength,
      acceptedAudioDurationMs: durationMs,
      draft: { text: "live words", source: "partial" }
    }));
    api.stopVoiceInput = vi.fn(async () => voiceSession({
      state: "done",
      outcome: "success",
      nextChunkSequence: 2n,
      acceptedAudioBytes: 3,
      acceptedAudioDurationMs: 250,
      result: { text: "final words", source: "stable", salvaged: false }
    }));

    const media = new VoiceInputMediaSession({
      api,
      preferences: {
        refinementInstructions: "Keep commands verbatim.",
        dictionaryTerms: ["Joko", "Orchestrator"],
        playInteractionSound: false
      },
      mediaDevices: { getUserMedia },
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      now: sequenceClock(0, 250),
      onUpdate: (update) => updates.push(update.state)
    });
    await media.start();
    FakeMediaRecorder.latest?.emitData([1, 2, 3]);
    await vi.waitFor(() => expect(api.appendVoiceAudio).toHaveBeenCalledOnce());
    const result = await media.stop();

    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ channelCount: 1 }), video: false }));
    expect(api.startVoiceInput).toHaveBeenCalledWith(
      expect.any(String),
      "audio/webm",
      undefined,
      { instructions: "Keep commands verbatim.", dictionaryTerms: ["Joko", "Orchestrator"] },
      expect.any(AbortSignal)
    );
    expect(api.appendVoiceAudio).toHaveBeenCalledWith("voice-one", 1n, new Uint8Array([1, 2, 3]), 250, false);
    expect(api.stopVoiceInput).toHaveBeenCalledWith("voice-one", 2n);
    expect(result?.result?.text).toBe("final words");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(updates).toContain("listening");
    expect(updates.at(-1)).toBe("done");
  });

  it("maps permission denial to a recoverable, content-free error", async () => {
    const denied = new Error("host detail that must not reach the UI");
    denied.name = "NotAllowedError";
    const api = voiceApi();
    api.getVoiceInputCapabilities = vi.fn(async () => capability);
    const errors: Array<VoiceMediaError | undefined> = [];
    const media = new VoiceInputMediaSession({
      api,
      mediaDevices: { getUserMedia: vi.fn(async () => { throw denied; }) },
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      onUpdate: (update) => errors.push(update.error)
    });

    await expect(media.start()).rejects.toMatchObject({ code: "permissionDenied" });
    expect(errors.at(-1)).toMatchObject({ code: "permissionDenied" });
    expect(api.startVoiceInput).not.toHaveBeenCalled();
  });

  it("uses and releases a checked-out prewarmed stream without reopening the microphone", async () => {
    const track = new FakeTrack();
    const stream = fakeStream(track);
    const getUserMedia = vi.fn();
    const api = voiceApi();
    api.getVoiceInputCapabilities = vi.fn(async () => capability);
    api.startVoiceInput = vi.fn(async () => voiceSession());
    const media = new VoiceInputMediaSession({
      api,
      prewarmedStream: stream,
      mediaDevices: { getUserMedia },
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder
    });

    await media.start();
    await media.cancel();

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("keeps a no-speech terminal outcome visible as a retryable error", async () => {
    const api = voiceApi();
    api.getVoiceInputCapabilities = vi.fn(async () => capability);
    api.startVoiceInput = vi.fn(async () => voiceSession());
    api.stopVoiceInput = vi.fn(async () => voiceSession({ state: "done", outcome: "noSpeech" }));
    const states: string[] = [];
    const media = new VoiceInputMediaSession({
      api,
      mediaDevices: { getUserMedia: vi.fn(async () => fakeStream(new FakeTrack())) },
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      onUpdate: (update) => states.push(update.state)
    });

    await media.start();
    await media.stop();
    expect(states.at(-1)).toBe("error");
    expect(media.currentSession?.outcome).toBe("noSpeech");
  });

  it("honors shortcut release while microphone startup is still in flight", async () => {
    let releaseCapability!: (value: VoiceInputCapabilityView) => void;
    const capabilityPending = new Promise<VoiceInputCapabilityView>((resolve) => { releaseCapability = resolve; });
    const api = voiceApi();
    api.getVoiceInputCapabilities = vi.fn(async () => capabilityPending);
    api.startVoiceInput = vi.fn(async () => voiceSession());
    api.stopVoiceInput = vi.fn(async () => voiceSession({ state: "done", outcome: "noSpeech" }));
    const states: string[] = [];
    const media = new VoiceInputMediaSession({
      api,
      mediaDevices: { getUserMedia: vi.fn(async () => fakeStream(new FakeTrack())) },
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      onUpdate: (update) => states.push(update.state)
    });

    const starting = media.start();
    await media.stop();
    releaseCapability(capability);
    await starting;

    expect(api.stopVoiceInput).toHaveBeenCalledWith("voice-one", 1n);
    expect(states).toContain("submitting");
    expect(states.at(-1)).toBe("error");
  });

  it("negotiates only a mutually supported recorder format", () => {
    expect(selectVoiceMediaType(capability, { isTypeSupported: (value) => value === "audio/webm" })).toBe("audio/webm");
    expect(() => selectVoiceMediaType(capability, { isTypeSupported: () => false })).toThrowError(VoiceMediaError);
    expect(normalizeVoiceMediaError(Object.assign(new Error(), { name: "NotFoundError" }))).toMatchObject({ code: "deviceUnavailable" });
  });

  it("prefers live PCM capture, forwards voice activity, and closes its audio graph", async () => {
    const liveCapability: VoiceInputCapabilityView = {
      ...capability,
      limits: { ...capability.limits, supportedMimeTypes: ["audio/pcm", "audio/webm"] },
      supportsLiveDrafts: true
    };
    const api = voiceApi();
    api.getVoiceInputCapabilities = vi.fn(async () => liveCapability);
    api.startVoiceInput = vi.fn(async () => voiceSession());
    api.appendVoiceAudio = vi.fn(async (_id, _sequence, audio, durationMs) => voiceSession({
      nextChunkSequence: 2n,
      acceptedAudioBytes: audio.byteLength,
      acceptedAudioDurationMs: durationMs
    }));
    api.stopVoiceInput = vi.fn(async () => voiceSession({ state: "done", outcome: "success", nextChunkSequence: 2n }));
    const capture = new FakePcmCapture();
    const track = new FakeTrack();
    const media = new VoiceInputMediaSession({
      api,
      mediaDevices: { getUserMedia: vi.fn(async () => fakeStream(track)) },
      pcmCaptureFactory: () => capture
    });

    await media.start();
    capture.emit({ audio: new Uint8Array([1, 0, 2, 0]), durationMs: 20, voiced: true });
    await vi.waitFor(() => expect(api.appendVoiceAudio).toHaveBeenCalledOnce());
    await media.stop();

    expect(api.startVoiceInput).toHaveBeenCalledWith(expect.any(String), "audio/pcm", undefined, expect.any(Object), expect.any(AbortSignal));
    expect(api.appendVoiceAudio).toHaveBeenCalledWith("voice-one", 1n, new Uint8Array([1, 0, 2, 0]), 20, true);
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});

class FakeTrack extends EventTarget {
  readonly stop = vi.fn();
}

class FakeMediaRecorder extends EventTarget {
  static latest: FakeMediaRecorder | undefined;
  static isTypeSupported(value: string): boolean { return value === "audio/webm"; }
  state: RecordingState = "inactive";

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    super();
    FakeMediaRecorder.latest = this;
  }

  start(): void { this.state = "recording"; }
  requestData(): void { /* the test emits recorder data explicitly */ }
  stop(): void {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }

  emitData(bytes: readonly number[]): void {
    const data = {
      size: bytes.length,
      arrayBuffer: async (): Promise<ArrayBuffer> => Uint8Array.from(bytes).buffer
    } as Blob;
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

class FakePcmCapture implements VoicePcmCapture {
  readonly stop = vi.fn(async () => undefined);
  private onChunk: ((chunk: VoicePcmChunk) => void) | undefined;

  async start(_stream: MediaStream, onChunk: (chunk: VoicePcmChunk) => void): Promise<void> {
    this.onChunk = onChunk;
  }

  emit(chunk: VoicePcmChunk): void {
    this.onChunk?.(chunk);
  }
}

function fakeStream(track: FakeTrack): MediaStream {
  return {
    getAudioTracks: () => [track as unknown as MediaStreamTrack],
    getTracks: () => [track as unknown as MediaStreamTrack]
  } as unknown as MediaStream;
}

function voiceSession(patch: Partial<VoiceInputSessionView> = {}): VoiceInputSessionView {
  return {
    id: "voice-one",
    state: "listening",
    nextChunkSequence: 1n,
    acceptedAudioBytes: 0,
    acceptedAudioDurationMs: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    recoveryAttempts: 0,
    stallWarning: false,
    ...patch
  };
}

function voiceApi(): OperationApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getVoiceInputCapabilities: vi.fn(),
    startVoiceInput: vi.fn(),
    appendVoiceAudio: vi.fn(),
    stopVoiceInput: vi.fn(),
    cancelVoiceInput: vi.fn(async () => voiceSession({ state: "done", outcome: "cancelled" })),
    getVoiceInputSession: vi.fn(async () => voiceSession())
  } as unknown as OperationApi & Record<string, ReturnType<typeof vi.fn>>;
}

function sequenceClock(...values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
