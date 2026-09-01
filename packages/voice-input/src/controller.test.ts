import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceInputController } from "./controller.js";
import {
  MAXIMUM_AUDIO_BYTES,
  MAXIMUM_AUDIO_CHUNK_BYTES,
  MAXIMUM_AUDIO_DURATION_MS,
  VoiceInputBoundsError
} from "./limits.js";
import type {
  AsrEvent,
  AsrProvider,
  AsrStartRequest,
  AudioChunk,
  EditorRangeAcceptance,
  RefinementEvent,
  RefinementRequest,
  RefinementResult,
  VoiceInputCallbacks,
  VoiceInputDiagnosticEvent,
  VoiceInputFailure,
  VoiceSubmission
} from "./types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceInputController", () => {
  it("closes the provider exactly once when stop and cancel race", async () => {
    const flush = deferred<void>();
    const provider = new FakeAsrProvider();
    provider.flushImpl = () => flush.promise;
    const order: string[] = [];
    provider.stopImpl = async () => {
      order.push("provider-stop");
    };
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({
        onStateChanged: (state, outcome) => order.push(`state:${state}:${outcome ?? ""}`)
      }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/webm", locale: "en-US" });
    provider.emit({ type: "partial", text: "do not submit" });
    const originalStop = controller.stop();
    const firstCancel = controller.cancel();
    const secondCancel = controller.cancel();

    expect(firstCancel).toBe(secondCancel);
    await firstCancel;
    flush.resolve();
    await originalStop;
    await controller.stop();
    await controller.cancel();

    expect(provider.stopCalls).toBe(1);
    expect(provider.flushCalls).toBe(1);
    expect(order.indexOf("state:done:cancelled")).toBeLessThan(order.indexOf("provider-stop"));
    expect(controller.currentState).toBe("done");
    expect(controller.terminalOutcome).toBe("cancelled");
  });

  it("waits the default 500 ms for a final stable transcript", async () => {
    vi.useFakeTimers();
    const provider = new FakeAsrProvider();
    const submissions: VoiceSubmission[] = [];
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({ onSubmitted: (submission) => (submissions.push(submission), range()) }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/ogg" });
    provider.emit({ type: "partial", text: "partial words" });
    const stopping = controller.stop();
    await vi.advanceTimersByTimeAsync(499);
    expect(submissions).toEqual([]);

    provider.emit({ type: "stable", text: "stable words" });
    await stopping;

    expect(submissions.map(({ text, source }) => ({ text, source }))).toEqual([
      { text: "stable words", source: "stable" }
    ]);
    expect(controller.terminalOutcome).toBe("success");
  });

  it("falls back to the latest partial after the 500 ms stable window", async () => {
    vi.useFakeTimers();
    const provider = new FakeAsrProvider();
    const submissions: VoiceSubmission[] = [];
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({ onSubmitted: (submission) => (submissions.push(submission), range()) }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/pcm" });
    provider.emit({ type: "partial", text: "latest partial" });
    const stopping = controller.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;

    expect(submissions[0]).toMatchObject({ text: "latest partial", source: "partial", salvaged: false });
  });

  it("recovers only explicit transport failures and caps recovery at three attempts", async () => {
    const provider = new FakeAsrProvider();
    const submissions: VoiceSubmission[] = [];
    const failures: VoiceInputFailure[] = [];
    const refiner = { refine: vi.fn<(_: RefinementRequest) => Promise<RefinementResult>>() };
    const controller = new VoiceInputController({
      provider,
      refiner,
      callbacks: callbacks({
        onSubmitted: (submission) => (submissions.push(submission), range()),
        onError: (failure) => failures.push(failure)
      }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/wav" });
    provider.emit({ type: "partial", text: "keep these words" });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      provider.emit({ type: "disconnected", recoverable: true });
      await settlePromises();
      expect(provider.recoverCalls).toBe(attempt);
    }

    provider.emit({ type: "error", category: "transport", recoverable: true });
    await settlePromises();

    expect(provider.recoverCalls).toBe(3);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ text: "keep these words", salvaged: true });
    expect(refiner.refine).not.toHaveBeenCalled();
    expect(failures).toEqual([{ code: "connection_interrupted", transcriptKept: true }]);
    expect(controller.terminalOutcome).toBe("failed");
  });

  it("never retries non-transport provider errors", async () => {
    const provider = new FakeAsrProvider();
    const failures: VoiceInputFailure[] = [];
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({ onError: (failure) => failures.push(failure) }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/mp4" });
    provider.emit({ type: "error", category: "authentication", recoverable: true });
    await settlePromises();

    expect(provider.recoverCalls).toBe(0);
    expect(failures[0]?.code).toBe("provider_authentication");
  });

  it.each(["disconnected", "error"] as const)(
    "salvages the newest raw transcript without refinement on %s",
    async (failureType) => {
      const provider = new FakeAsrProvider();
      const order: string[] = [];
      const submissions: VoiceSubmission[] = [];
      const refiner = { refine: vi.fn<(_: RefinementRequest) => Promise<RefinementResult>>() };
      const controller = new VoiceInputController({
        provider,
        refiner,
        callbacks: callbacks({
          onStateChanged: (state) => {
            if (state === "error") order.push("error");
          },
          onSubmitted: (submission) => {
            order.push("submitted");
            submissions.push(submission);
            return range();
          }
        }),
        createId: sequenceIds()
      });

      await controller.start({ mimeType: "audio/mpeg" });
      provider.emit({ type: "stable", text: "older stable" });
      provider.emit({ type: "partial", text: "  newest raw\nline  " });
      provider.emit(failureType === "disconnected"
        ? { type: "disconnected", recoverable: false }
        : { type: "error", category: "transport", recoverable: false });
      await settlePromises();

      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toMatchObject({ text: "newest raw\nline", source: "partial", salvaged: true });
      expect(refiner.refine).not.toHaveBeenCalled();
      expect(order).toEqual(["submitted", "error"]);
      expect(controller.terminalOutcome).toBe("failed");
    }
  );

  it("emits preview and applies refinement only against the accepted revision", async () => {
    const provider = new FakeAsrProvider();
    const events: RefinementEvent[] = [];
    const apply = vi.fn(() => ({ applied: true, revision: 8 } as const));
    const controller = new VoiceInputController({
      provider,
      stableWaitMs: 0,
      refiner: {
        refine: async (request) => {
          request.onPreview("Preview text");
          return { accepted: true, basedOnText: request.text, refinedText: "Refined text" };
        }
      },
      callbacks: callbacks({
        onSubmitted: () => range(7),
        inspectEditorRange: () => ({ exists: true, revision: 7, userEdited: false }),
        applyRefinement: apply,
        onRefinement: (event) => events.push(event)
      }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/webm", locale: "zh-Hans-CN" });
    provider.emit({ type: "stable", text: "raw text" });
    await controller.stop();

    expect(events).toEqual([
      expect.objectContaining({ type: "preview", text: "Preview text", expectedRevision: 7 }),
      expect.objectContaining({ type: "applied", text: "Refined text", expectedRevision: 7 })
    ]);
    expect(apply).toHaveBeenCalledWith({ rangeId: "range-1", expectedRevision: 7, refinedText: "Refined text" });
    expect(controller.terminalOutcome).toBe("success");
  });

  it("discards refinement when the editor revision is stale", async () => {
    const provider = new FakeAsrProvider();
    const result = deferred<RefinementResult>();
    const events: RefinementEvent[] = [];
    const apply = vi.fn();
    const controller = new VoiceInputController({
      provider,
      stableWaitMs: 0,
      refiner: { refine: () => result.promise },
      callbacks: callbacks({
        onSubmitted: () => range(3),
        inspectEditorRange: () => ({ exists: true, revision: 4, userEdited: false }),
        applyRefinement: apply,
        onRefinement: (event) => events.push(event)
      }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/ogg" });
    provider.emit({ type: "stable", text: "raw text" });
    const stopping = controller.stop();
    await settlePromises();
    result.resolve({ accepted: true, basedOnText: "raw text", refinedText: "Refined text" });
    await stopping;

    expect(events).toContainEqual(expect.objectContaining({ type: "discarded", reason: "stale_revision" }));
    expect(apply).not.toHaveBeenCalled();
    expect(controller.terminalOutcome).toBe("success");
  });

  it("discards refinement when the user touched the accepted range", async () => {
    const provider = new FakeAsrProvider();
    const events: RefinementEvent[] = [];
    const apply = vi.fn();
    const controller = new VoiceInputController({
      provider,
      stableWaitMs: 0,
      refiner: {
        refine: async (request) => ({ accepted: true, basedOnText: request.text, refinedText: "Refined" })
      },
      callbacks: callbacks({
        onSubmitted: () => range(1),
        inspectEditorRange: () => ({ exists: true, revision: 1, userEdited: true }),
        applyRefinement: apply,
        onRefinement: (event) => events.push(event)
      }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/pcm" });
    provider.emit({ type: "stable", text: "raw" });
    await controller.stop();

    expect(events).toContainEqual(expect.objectContaining({ type: "discarded", reason: "user_edited" }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("uses the 4 s wall and 2 s voiced gates as a diagnostic-only watchdog", async () => {
    vi.useFakeTimers({ now: 0 });
    const provider = new FakeAsrProvider();
    const diagnostics: VoiceInputDiagnosticEvent[] = [];
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({ onDiagnostic: (event) => diagnostics.push(event) }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/wav" });
    for (let index = 0; index < 4; index += 1) {
      controller.appendAudio(audioChunk(500, true));
    }
    await vi.advanceTimersByTimeAsync(3_999);
    expect(diagnostics.some(({ type }) => type === "stall_warning")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostics).toContainEqual({
      type: "stall_warning",
      wallMsSinceLastSignal: 4_000,
      audioMsSinceLastSignal: 2_000,
      voicedAudioMsSinceLastSignal: 2_000,
      everSawSignal: false
    });
    expect(provider.recoverCalls).toBe(0);
    expect(controller.currentState).toBe("listening");
    await controller.cancel();
  });

  it("marks cancellation terminal before ignoring teardown disconnects", async () => {
    const provider = new FakeAsrProvider();
    const failures: VoiceInputFailure[] = [];
    provider.stopImpl = async () => {
      provider.emit({ type: "disconnected", recoverable: true });
      provider.emit({ type: "error", category: "transport", recoverable: true });
    };
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({ onError: (failure) => failures.push(failure) }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/mp4" });
    await controller.cancel();

    expect(controller.terminalOutcome).toBe("cancelled");
    expect(failures).toEqual([]);
    expect(provider.recoverCalls).toBe(0);
    expect(provider.stopCalls).toBe(1);
  });

  it("does not turn normal stop-time teardown events into a failed run", async () => {
    const provider = new FakeAsrProvider();
    const failures: VoiceInputFailure[] = [];
    provider.stopImpl = async () => {
      provider.emit({ type: "disconnected", recoverable: true });
      provider.emit({ type: "error", category: "transport", recoverable: true });
    };
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({ onError: (failure) => failures.push(failure) }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/webm" });
    provider.emit({ type: "stable", text: "usable transcript" });
    await controller.stop();

    expect(controller.terminalOutcome).toBe("success");
    expect(failures).toEqual([]);
    expect(provider.stopCalls).toBe(1);
  });

  it("enforces MIME, locale, per-chunk, and cumulative audio bounds before provider calls", async () => {
    const provider = new FakeAsrProvider();
    const controller = new VoiceInputController({ provider, callbacks: callbacks(), createId: sequenceIds() });

    await expect(controller.start({ mimeType: "text/plain" })).rejects.toMatchObject({ code: "mime_type" });
    await expect(controller.start({ mimeType: "audio/webm", locale: "not_a_locale" })).rejects.toMatchObject({ code: "locale" });
    expect(provider.startRequests).toEqual([]);

    await controller.start({ mimeType: " AUDIO/WEBM ", locale: "en-us" });
    expect(provider.startRequests[0]).toMatchObject({ mimeType: "audio/webm", locale: "en-US" });
    expect(() => controller.appendAudio({ data: new ArrayBuffer(0), durationMs: 10, voiced: false }))
      .toThrowError(VoiceInputBoundsError);
    expect(() => controller.appendAudio({
      data: new ArrayBuffer(MAXIMUM_AUDIO_CHUNK_BYTES + 1),
      durationMs: 10,
      voiced: false
    })).toThrowError(expect.objectContaining({ code: "audio_chunk_bytes" }));
    expect(() => controller.appendAudio({ data: new ArrayBuffer(2), durationMs: 10_001, voiced: true }))
      .toThrowError(expect.objectContaining({ code: "audio_chunk_duration" }));

    const maximumChunk = new ArrayBuffer(MAXIMUM_AUDIO_CHUNK_BYTES);
    for (let bytes = 0; bytes < MAXIMUM_AUDIO_BYTES; bytes += MAXIMUM_AUDIO_CHUNK_BYTES) {
      controller.appendAudio({ data: maximumChunk, durationMs: 1, voiced: false });
    }
    expect(() => controller.appendAudio({ data: new ArrayBuffer(1), durationMs: 1, voiced: false }))
      .toThrowError(expect.objectContaining({ code: "audio_total_bytes" }));
    await controller.cancel();

    const durationProvider = new FakeAsrProvider();
    const durationController = new VoiceInputController({
      provider: durationProvider,
      callbacks: callbacks(),
      createId: sequenceIds()
    });
    await durationController.start({ mimeType: "audio/pcm" });
    for (let duration = 0; duration < MAXIMUM_AUDIO_DURATION_MS; duration += 10_000) {
      durationController.appendAudio(audioChunk(10_000, false));
    }
    expect(() => durationController.appendAudio(audioChunk(1, false)))
      .toThrowError(expect.objectContaining({ code: "audio_total_duration" }));
    await durationController.cancel();
  });

  it("keeps transcript content out of diagnostic events", async () => {
    const secretTranscript = "private phrase 8f2a7d";
    const provider = new FakeAsrProvider();
    const diagnostics: VoiceInputDiagnosticEvent[] = [];
    const controller = new VoiceInputController({
      provider,
      callbacks: callbacks({ onDiagnostic: (event) => diagnostics.push(event) }),
      createId: sequenceIds()
    });

    await controller.start({ mimeType: "audio/ogg" });
    provider.emit({ type: "partial", text: secretTranscript });
    provider.emit({ type: "disconnected", recoverable: false });
    await settlePromises();

    expect(JSON.stringify(diagnostics)).not.toContain(secretTranscript);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      type: "transcript_salvaged",
      characterCount: secretTranscript.length
    }));
  });
});

class FakeAsrProvider implements AsrProvider {
  startRequests: AsrStartRequest[] = [];
  appendCalls = 0;
  flushCalls = 0;
  stopCalls = 0;
  recoverCalls = 0;
  startImpl: (request: AsrStartRequest) => Promise<void> = async () => undefined;
  flushImpl: () => Promise<void> = async () => undefined;
  stopImpl: () => Promise<void> = async () => undefined;
  recoverImpl: () => Promise<void> = async () => undefined;
  private listener: ((event: AsrEvent) => void) | undefined;

  async start(request: AsrStartRequest): Promise<void> {
    this.startRequests.push(request);
    await this.startImpl(request);
  }

  appendAudio(_chunk: AudioChunk): void {
    this.appendCalls += 1;
  }

  async flushAudio(): Promise<void> {
    this.flushCalls += 1;
    await this.flushImpl();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopImpl();
  }

  async recover(): Promise<void> {
    this.recoverCalls += 1;
    await this.recoverImpl();
  }

  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  emit(event: AsrEvent): void {
    this.listener?.(event);
  }
}

function callbacks(overrides: Partial<VoiceInputCallbacks> = {}): VoiceInputCallbacks {
  return {
    onSubmitted: () => range(),
    ...overrides
  };
}

function range(revision: string | number = 1): EditorRangeAcceptance {
  return { id: "range-1", startOffset: 0, endOffset: 4, revision };
}

function audioChunk(durationMs: number, voiced: boolean): AudioChunk {
  return { data: new ArrayBuffer(2), durationMs, voiced };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sequenceIds(): () => string {
  let next = 0;
  return () => `voice-${++next}`;
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
