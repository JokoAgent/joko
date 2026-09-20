import { create } from "@bufbuild/protobuf";
import {
  CapabilitySchema,
  CapabilitySupport,
  VoiceInputCapabilityProfileSchema,
  VoiceInputDraftSchema,
  VoiceInputFailureCode,
  VoiceInputFailureSchema,
  VoiceInputLimitsSchema,
  VoiceInputSessionSchema,
  VoiceInputState,
  VoiceInputTerminalOutcome,
  VoiceInputTextSource
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MobileVoiceInputRun,
  MobileVoiceRunError,
  projectMobileVoiceCapability,
  projectMobileVoiceSession,
  reconcileMobileVoiceInsertion,
  supportsMobileVoiceCapture,
  type MobileVoiceCapability,
  type MobileVoiceCaptureRuntime,
  type MobileVoicePcmChunk,
  type MobileVoiceSession,
  type MobileVoiceTransport
} from "./mobile-voice-input";

const capability: MobileVoiceCapability = {
  support: "supported",
  limits: {
    supportedMimeTypes: ["audio/pcm"],
    maximumAudioChunkBytes: 1_024,
    maximumAudioBytes: 4_096,
    maximumAudioChunkDurationMs: 1_000,
    maximumAudioDurationMs: 10_000,
    maximumLocaleCharacters: 35,
    stableWaitMs: 250,
    maximumConcurrentSessions: 1
  },
  supportsLocale: true,
  supportsLiveDrafts: true,
  supportsRefinement: true
};

describe("mobile voice protocol projection", () => {
  it("requires an exact supported PCM profile and maps bounded protocol values", () => {
    const projected = projectMobileVoiceCapability(create(VoiceInputCapabilityProfileSchema, {
      capability: create(CapabilitySchema, { support: CapabilitySupport.SUPPORTED }),
      limits: create(VoiceInputLimitsSchema, {
        supportedMimeTypes: [" Audio/PCM ", "audio/pcm"],
        maximumAudioChunkBytes: 1_024n,
        maximumAudioBytes: 4_096n,
        maximumAudioChunkDuration: { seconds: 1n },
        maximumAudioDuration: { seconds: 10n },
        maximumLocaleCharacters: 35,
        stableWait: { nanos: 250_000_000 },
        maximumConcurrentSessions: 1
      }),
      supportsLocale: true,
      supportsLiveDrafts: true
    }));
    expect(projected.limits.supportedMimeTypes).toEqual(["audio/pcm"]);
    expect(projected.limits.stableWaitMs).toBe(250);
    expect(supportsMobileVoiceCapture(projected, true)).toBe(true);
    expect(supportsMobileVoiceCapture(projected, false)).toBe(false);
    expect(supportsMobileVoiceCapture({
      ...projected,
      limits: { ...projected.limits, supportedMimeTypes: ["audio/webm"] }
    }, true)).toBe(false);
  });

  it("rejects malformed sessions and preserves only closed failure metadata", () => {
    const projected = projectMobileVoiceSession(create(VoiceInputSessionSchema, {
      voiceInputId: "voice-one",
      state: VoiceInputState.ERROR,
      outcome: VoiceInputTerminalOutcome.FAILED,
      draft: create(VoiceInputDraftSchema, { text: "kept\r\ntext", source: VoiceInputTextSource.STABLE }),
      failure: create(VoiceInputFailureSchema, {
        code: VoiceInputFailureCode.PROVIDER_ERROR,
        transcriptKept: true
      }),
      nextChunkSequence: 2n,
      acceptedAudioBytes: 32n,
      acceptedAudioDuration: { nanos: 1_000_000 },
      createdAt: { seconds: 1n },
      updatedAt: { seconds: 2n }
    }));
    expect(projected).toMatchObject({
      id: "voice-one",
      state: "error",
      outcome: "failed",
      draft: { text: "kept\ntext", source: "stable" },
      failure: { code: "providerError", transcriptKept: true }
    });
    expect(() => projectMobileVoiceSession(create(VoiceInputSessionSchema, {
      voiceInputId: "bad id",
      state: VoiceInputState.LISTENING,
      nextChunkSequence: 1n,
      createdAt: { seconds: 1n },
      updatedAt: { seconds: 1n }
    }))).toThrow(/invalid voice input session/i);
  });
});

describe("MobileVoiceInputRun", () => {
  it("keeps startup-stop race safe and fences stop behind the exact next sequence", async () => {
    let resolveStart!: (session: MobileVoiceSession) => void;
    const pendingStart = new Promise<MobileVoiceSession>((resolve) => { resolveStart = resolve; });
    const transport = fakeTransport();
    transport.start = vi.fn(async () => pendingStart);
    transport.stop = vi.fn(async (_id, sequence) => voiceSession({
      state: "done",
      outcome: "success",
      nextChunkSequence: sequence,
      result: { text: "short", source: "stable", salvaged: false }
    }));
    const capture = fakeCapture();
    const captureStopped = vi.fn();
    const states: string[] = [];
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-one",
      onCaptureStopped: captureStopped,
      onUpdate: (update) => states.push(update.state)
    });
    const starting = run.start();
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce());
    await run.stop();
    resolveStart(voiceSession());
    await starting;
    expect(transport.stop).toHaveBeenCalledWith("voice-one", 1n, expect.any(AbortSignal));
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(capture.release).toHaveBeenCalled();
    expect(captureStopped).toHaveBeenCalledOnce();
    expect(capture.stop.mock.invocationCallOrder[0]).toBeLessThan(captureStopped.mock.invocationCallOrder[0]!);
    expect(captureStopped.mock.invocationCallOrder[0]).toBeLessThan(transport.stop.mock.invocationCallOrder[0]!);
    expect(states).toContain("submitting");
    expect(states.at(-1)).toBe("done");
  });

  it("closes a late capture handle before a startup handshake can settle after release", async () => {
    let resolveStart!: (session: MobileVoiceSession) => void;
    let resolveCapture!: (stop: () => Promise<void>) => void;
    const transport = fakeTransport();
    transport.start = vi.fn(() => new Promise<MobileVoiceSession>((resolve) => { resolveStart = resolve; }));
    const capture = fakeCapture();
    capture.start = vi.fn(() => new Promise<() => Promise<void>>((resolve) => { resolveCapture = resolve; }));
    const lateStop = vi.fn(async () => undefined);
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-early-release"
    });

    const starting = run.start();
    await vi.waitFor(() => expect(capture.start).toHaveBeenCalledOnce());
    await run.stop();
    resolveCapture(lateStop);
    await vi.waitFor(() => expect(lateStop).toHaveBeenCalledOnce());
    expect(transport.stop).not.toHaveBeenCalled();
    resolveStart(voiceSession());
    await starting;

    expect(lateStop.mock.invocationCallOrder[0]).toBeLessThan(transport.stop.mock.invocationCallOrder[0]!);
    expect(run.currentState).toBe("error");
  });

  it("streams PCM chunks in order, verifies acknowledgements, and projects the final text", async () => {
    const transport = fakeTransport();
    transport.append = vi.fn(async (_id, sequence, audio, durationMs) => voiceSession({
      nextChunkSequence: sequence + 1n,
      acceptedAudioBytes: audio.byteLength * Number(sequence),
      acceptedAudioDurationMs: durationMs * Number(sequence),
      draft: { text: `partial-${sequence}`, source: "partial" },
      updatedAt: 1_000 + Number(sequence)
    }));
    transport.stop = vi.fn(async (_id, sequence) => voiceSession({
      state: "done",
      outcome: "success",
      nextChunkSequence: sequence,
      acceptedAudioBytes: 8,
      acceptedAudioDurationMs: 40,
      result: { text: "final words", source: "stable", salvaged: false },
      updatedAt: 2_000
    }));
    const capture = fakeCapture();
    const updates: MobileVoiceSession[] = [];
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-two",
      onUpdate: (update) => { if (update.session) updates.push(update.session); }
    });
    await run.start();
    capture.emit({ audio: new Uint8Array([1, 0, 2, 0]), durationMs: 20, voiced: true });
    capture.emit({ audio: new Uint8Array([0, 0, 0, 0]), durationMs: 20, voiced: false });
    await vi.waitFor(() => expect(transport.append).toHaveBeenCalledTimes(2));
    await run.stop();
    expect(transport.append).toHaveBeenNthCalledWith(
      1, "voice-one", 1n, new Uint8Array([1, 0, 2, 0]), 20, true, expect.any(AbortSignal)
    );
    expect(transport.append).toHaveBeenNthCalledWith(
      2, "voice-one", 2n, new Uint8Array([0, 0, 0, 0]), 20, false, expect.any(AbortSignal)
    );
    expect(transport.stop).toHaveBeenCalledWith("voice-one", 3n, expect.any(AbortSignal));
    expect(updates.at(-1)?.result?.text).toBe("final words");
    expect(updates.filter((session) => session.result?.text === "final words")).toHaveLength(1);
  });

  it("never starts the service after blocked permission and cancels the exact session on owner drift", async () => {
    const blockedTransport = fakeTransport();
    const blockedCapture = fakeCapture({ granted: false, canAskAgain: false });
    const blocked = new MobileVoiceInputRun({
      transport: blockedTransport,
      capture: blockedCapture,
      requestId: () => "request-blocked"
    });
    await expect(blocked.start()).rejects.toMatchObject({ code: "permissionBlocked" });
    expect(blockedTransport.start).not.toHaveBeenCalled();

    let current = true;
    const transport = fakeTransport(() => current);
    const capture = fakeCapture();
    const errors: MobileVoiceRunError[] = [];
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-owner",
      onUpdate: (update) => { if (update.error) errors.push(update.error); }
    });
    await run.start();
    current = false;
    capture.emit({ audio: new Uint8Array([1, 0]), durationMs: 1, voiced: true });
    await vi.waitFor(() => expect(transport.cancel).toHaveBeenCalledWith("voice-one"));
    expect(errors.at(-1)?.code).toBe("ownerChanged");
    expect(capture.stop).toHaveBeenCalledOnce();
  });

  it("cancels a service session that arrives after startup was abandoned", async () => {
    let resolveStart!: (session: MobileVoiceSession) => void;
    const transport = fakeTransport();
    transport.start = vi.fn(() => new Promise<MobileVoiceSession>((resolve) => { resolveStart = resolve; }));
    const capture = fakeCapture();
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-cancel-start"
    });

    const starting = run.start();
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce());
    await run.cancel();
    resolveStart(voiceSession());
    await starting;

    expect(transport.cancel).toHaveBeenCalledWith("voice-one");
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(capture.release).toHaveBeenCalled();
    expect(run.currentState).toBe("cancelled");
  });

  it("fails closed on acknowledgement drift and a cumulative capture limit", async () => {
    const driftedTransport = fakeTransport();
    driftedTransport.append = vi.fn(async () => voiceSession({
      nextChunkSequence: 4n,
      acceptedAudioBytes: 2,
      acceptedAudioDurationMs: 1,
      updatedAt: 1_001
    }));
    const driftedCapture = fakeCapture();
    const driftedErrors: MobileVoiceRunError[] = [];
    const drifted = new MobileVoiceInputRun({
      transport: driftedTransport,
      capture: driftedCapture,
      requestId: () => "request-drift",
      onUpdate: (update) => { if (update.error) driftedErrors.push(update.error); }
    });
    await drifted.start();
    driftedCapture.emit({ audio: new Uint8Array([1, 0]), durationMs: 1, voiced: true });
    await vi.waitFor(() => expect(drifted.currentState).toBe("error"));
    expect(driftedErrors.at(-1)?.code).toBe("serviceUnavailable");
    expect(driftedTransport.cancel).toHaveBeenCalledWith("voice-one");

    const limitedTransport = fakeTransport();
    limitedTransport.getCapabilities = vi.fn(async () => ({
      ...capability,
      limits: { ...capability.limits, maximumAudioBytes: 2 }
    }));
    const limitedCapture = fakeCapture();
    const limitedErrors: MobileVoiceRunError[] = [];
    const limited = new MobileVoiceInputRun({
      transport: limitedTransport,
      capture: limitedCapture,
      requestId: () => "request-limit",
      onUpdate: (update) => { if (update.error) limitedErrors.push(update.error); }
    });
    await limited.start();
    limitedCapture.emit({ audio: new Uint8Array([1, 0]), durationMs: 1, voiced: true });
    limitedCapture.emit({ audio: new Uint8Array([2, 0]), durationMs: 1, voiced: true });
    await vi.waitFor(() => expect(limited.currentState).toBe("error"));
    expect(limitedErrors.at(-1)?.code).toBe("audioLimit");
    expect(limitedTransport.append).not.toHaveBeenCalled();
  });

  it("awaits append failure cleanup instead of stopping or finalizing a failed session", async () => {
    const transport = fakeTransport();
    transport.append = vi.fn(async () => { throw new Error("sensitive upstream detail"); });
    const capture = fakeCapture();
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-append-failure"
    });
    await run.start();
    capture.emit({ audio: new Uint8Array([1, 0]), durationMs: 1, voiced: true });

    await run.stop();

    expect(run.currentState).toBe("error");
    expect(transport.cancel).toHaveBeenCalledWith("voice-one");
    expect(transport.stop).not.toHaveBeenCalled();
  });

  it("does not send a second stop after an append returns a terminal session", async () => {
    const transport = fakeTransport();
    transport.append = vi.fn(async () => voiceSession({
      state: "done",
      outcome: "success",
      nextChunkSequence: 2n,
      acceptedAudioBytes: 2,
      acceptedAudioDurationMs: 1,
      result: { text: "terminal", source: "stable", salvaged: false },
      updatedAt: 1_001
    }));
    const capture = fakeCapture();
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-terminal-append"
    });
    await run.start();
    capture.emit({ audio: new Uint8Array([1, 0]), durationMs: 1, voiced: true });

    const terminal = await run.stop();

    expect(terminal?.result?.text).toBe("terminal");
    expect(run.currentState).toBe("done");
    expect(transport.stop).not.toHaveBeenCalled();
  });

  it("ignores regressed poll snapshots and reports empty speech distinctly", async () => {
    const timers: Array<() => void> = [];
    const transport = fakeTransport();
    transport.get = vi.fn(async () => voiceSession({
      state: "done",
      outcome: "noSpeech",
      updatedAt: 999
    }));
    const capture = fakeCapture();
    const run = new MobileVoiceInputRun({
      transport,
      capture,
      requestId: () => "request-stale-poll",
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined
    });
    await run.start();
    timers.shift()?.();
    await vi.waitFor(() => expect(transport.get).toHaveBeenCalledOnce());
    expect(run.currentState).toBe("listening");
    expect(timers).toHaveLength(1);
    await run.cancel();

    const noSpeechTransport = fakeTransport();
    const errors: MobileVoiceRunError[] = [];
    const noSpeech = new MobileVoiceInputRun({
      transport: noSpeechTransport,
      capture: fakeCapture(),
      requestId: () => "request-no-speech",
      onUpdate: (update) => { if (update.error) errors.push(update.error); }
    });
    await noSpeech.start();
    await noSpeech.stop();
    expect(noSpeech.currentState).toBe("error");
    expect(errors.at(-1)?.code).toBe("noSpeech");
  });
});

describe("voice insertion ownership", () => {
  it("moves an intact insertion for edits before it and retires on overlap", () => {
    const insertion = { start: 6, end: 11, text: "voice" };
    expect(reconcileMobileVoiceInsertion("hello voice", "say hello voice", insertion)).toEqual({
      insertion: { start: 10, end: 15, text: "voice" },
      overlapped: false
    });
    expect(reconcileMobileVoiceInsertion("hello voice", "hello edited", insertion)).toEqual({ overlapped: true });
  });
});

function voiceSession(patch: Partial<MobileVoiceSession> = {}): MobileVoiceSession {
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

type FakeVoiceTransport = MobileVoiceTransport & {
  getCapabilities: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
};

function fakeTransport(isCurrent: () => boolean = () => true): FakeVoiceTransport {
  return {
    profileId: "profile-one",
    surfaceOwnerKey: "owner-one",
    isCurrent,
    getCapabilities: vi.fn(async () => capability),
    start: vi.fn(async () => voiceSession()),
    append: vi.fn(),
    stop: vi.fn(async () => voiceSession({ state: "done", outcome: "noSpeech" })),
    cancel: vi.fn(async () => voiceSession({ state: "done", outcome: "cancelled" })),
    get: vi.fn(async () => voiceSession())
  } as unknown as FakeVoiceTransport;
}

function fakeCapture(permission: { granted: boolean; canAskAgain: boolean } = { granted: true, canAskAgain: true }) {
  let onChunk: ((chunk: MobileVoicePcmChunk) => void) | undefined;
  const stop = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const runtime: MobileVoiceCaptureRuntime & {
    readonly stop: typeof stop;
    readonly release: typeof release;
    emit(chunk: MobileVoicePcmChunk): void;
  } = {
    isAvailable: () => true,
    ensurePermission: vi.fn(async () => permission),
    start: vi.fn(async (next) => { onChunk = next; return stop; }),
    release,
    stop,
    emit: (chunk) => onChunk?.(chunk)
  };
  return runtime;
}
