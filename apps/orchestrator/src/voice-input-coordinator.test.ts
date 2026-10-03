import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent, AsrProvider, AsrRecognitionContext, AsrStartRequest, AudioChunk } from "@joko/voice-input";
import {
  VoiceInputControlError,
  VoiceInputCoordinator,
  type VoiceInputProviderFactory,
  type VoiceInputCoordinatorOptions
} from "./voice-input-coordinator.js";

const coordinators: VoiceInputCoordinator[] = [];

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
});

describe("VoiceInputCoordinator", () => {
  it("freezes authorized recognition context and validates its capability before creating a provider", async () => {
    const provider = new FakeAsrProvider();
    let context: AsrRecognitionContext | undefined;
    let creates = 0;
    const coordinator = createCoordinator({
      describe: () => ({ support: "supported", mimeTypes: ["audio/pcm"], supportsLocale: true,
        supportedLocales: ["en-US"], supportsRecognitionContext: true }),
      create: (input) => { creates += 1; context = input.recognitionContext; return provider; }
    });
    const input = { ownerConnectionId: "connection-context", requestId: "context-request", mimeType: "audio/pcm",
      locale: "en-us", recognitionContext: { hotwords: [], contextData: [{ text: "  Authorized\r\ncontext\ttext  " }] } };
    const started = await coordinator.start(input);
    input.recognitionContext.contextData[0]!.text = "Changed input";
    expect(context).toEqual({ hotwords: [], contextData: [{ text: "Authorized\ncontext\ttext" }] });
    expect(Object.isFrozen(context!.contextData[0])).toBe(true);
    expect(JSON.stringify(started, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("Authorized");
    await expect(coordinator.start(input)).rejects.toMatchObject({ code: "conflict" });
    await coordinator.cancel({ ownerConnectionId: input.ownerConnectionId, voiceInputId: started.id });
    await expect(coordinator.start({ ...input, requestId: "wrong-locale", locale: "ja" })).rejects.toMatchObject({ code: "not_supported" });
    await expect(coordinator.start({ ...input, requestId: "invalid-context", recognitionContext: {
      hotwords: [], contextData: [{ text: "a".repeat(2_049) }] } })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(creates).toBe(1);
    const unsupported = createCoordinator(factory(new FakeAsrProvider()));
    await expect(unsupported.start({ ...input, requestId: "unsupported-context", mimeType: "audio/webm", locale: undefined }))
      .rejects.toMatchObject({ code: "not_supported" });
  });

  it.each(["Connection", "request", "configuration"] as const)("retires a pending voice provider after %s cancellation", async (kind) => {
    const provider = new FakeAsrProvider();
    const pending = deferred<AsrProvider>();
    const abort = new AbortController();
    let retireOwner: () => void = () => undefined;
    let disposed = 0;
    const coordinator = createCoordinator({
      describe: () => ({ support: "supported", mimeTypes: ["audio/pcm"], supportsLocale: false, supportsRecognitionContext: true }),
      create: () => pending.promise
    }, { onOwnerRetired: (_owner, callback) => { retireOwner = callback; return () => { disposed += 1; }; } });
    const starting = coordinator.start({ ownerConnectionId: "connection-retire", requestId: "pending-retire", mimeType: "audio/pcm",
      recognitionContext: { hotwords: [], contextData: [{ text: "Private context" }] }, signal: abort.signal });
    if (kind === "Connection") retireOwner();
    else if (kind === "request") abort.abort();
    else await coordinator.retireProviderConfiguration();
    pending.resolve(provider);
    await expect(starting).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(provider.startRequests).toHaveLength(0);
    expect(provider.stopCalls).toBe(1);
    expect(disposed).toBe(1);
  });

  it("cleans a live voice capture when its Connection or provider configuration retires", async () => {
    const callbacks = new Map<string, () => void>();
    const providers = [new FakeAsrProvider(), new FakeAsrProvider()];
    const coordinator = createCoordinator({
      describe: () => ({ support: "supported", mimeTypes: ["audio/pcm"], supportsLocale: false }),
      create: () => providers.shift()!
    }, { onOwnerRetired: (owner, callback) => { callbacks.set(owner, callback); return () => { callbacks.delete(owner); }; } });
    const first = await coordinator.start({ ownerConnectionId: "connection-a", requestId: "voice-a", mimeType: "audio/pcm" });
    callbacks.get("connection-a")!();
    await settlePromises();
    expect(coordinator.get({ ownerConnectionId: "connection-a", voiceInputId: first.id }).outcome).toBe("cancelled");
    expect(callbacks.has("connection-a")).toBe(false);
    const second = await coordinator.start({ ownerConnectionId: "connection-b", requestId: "voice-b", mimeType: "audio/pcm" });
    await coordinator.retireProviderConfiguration();
    expect(coordinator.get({ ownerConnectionId: "connection-b", voiceInputId: second.id }).outcome).toBe("cancelled");
    expect(callbacks.size).toBe(0);
  });

  it("owns an ephemeral, sequence-fenced transcription session", async () => {
    const provider = new FakeAsrProvider();
    provider.flushImpl = async () => provider.emit({ type: "stable", text: "private final words" });
    const coordinator = createCoordinator(factory(provider));

    const started = await coordinator.start({
      ownerConnectionId: "connection-1",
      requestId: "request-1",
      mimeType: "audio/webm",
      locale: "en-us"
    });
    expect(started).toMatchObject({ state: "listening", nextChunkSequence: 1n });
    expect(provider.startRequests[0]).toMatchObject({ mimeType: "audio/webm", locale: "en-US" });

    const appended = coordinator.append({
      ownerConnectionId: "connection-1",
      voiceInputId: started.id,
      chunkSequence: 1n,
      audio: Uint8Array.of(1, 2, 3, 4),
      durationMs: 25,
      voiced: true
    });
    expect(appended).toMatchObject({
      nextChunkSequence: 2n,
      acceptedAudioBytes: 4,
      acceptedAudioDurationMs: 25
    });
    expect(() => coordinator.append({
      ownerConnectionId: "connection-1",
      voiceInputId: started.id,
      chunkSequence: 1n,
      audio: Uint8Array.of(9),
      durationMs: 1,
      voiced: false
    })).toThrowError(expect.objectContaining({ code: "conflict" }));

    const stopped = await coordinator.stop({
      ownerConnectionId: "connection-1",
      voiceInputId: started.id,
      expectedNextChunkSequence: 2n
    });
    expect(stopped).toMatchObject({
      state: "done",
      outcome: "success",
      result: { text: "private final words", source: "stable", salvaged: false }
    });
    expect(stopped.draft).toBeUndefined();
    expect(provider.stopCalls).toBe(1);
    expect(() => coordinator.get({ ownerConnectionId: "connection-2", voiceInputId: started.id }))
      .toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("applies optional delayed refinement before returning the terminal result", async () => {
    const provider = new FakeAsrProvider();
    let refinementContext: unknown;
    provider.flushImpl = async () => provider.emit({ type: "stable", text: "please inspect src/app.ts" });
    const refine = async (input: { readonly text: string }) => ({
      accepted: true as const,
      basedOnText: input.text,
      refinedText: "Please inspect src/app.ts."
    });
    const coordinator = createCoordinator({
      describe: () => ({
        support: "supported",
        mimeTypes: ["audio/webm"],
        supportsLocale: true,
        supportsLiveDrafts: false,
        supportsRefinement: true
      }),
      create: () => provider,
      createRefiner: (input) => {
        refinementContext = input;
        return { refine };
      }
    });
    const started = await coordinator.start({
      ownerConnectionId: "connection-1",
      requestId: "request-refinement",
      mimeType: "audio/webm",
      locale: "en-US",
      refinementInstructions: "Keep commands verbatim.",
      dictionaryTerms: ["Joko", "Orchestrator", "joko"]
    });
    expect(refinementContext).toEqual({
      locale: "en-US",
      refinementInstructions: "Keep commands verbatim.",
      dictionaryTerms: ["Joko", "Orchestrator"]
    });
    coordinator.append({
      ownerConnectionId: "connection-1",
      voiceInputId: started.id,
      chunkSequence: 1n,
      audio: Uint8Array.of(1, 2, 3),
      durationMs: 25,
      voiced: false
    });

    const stopped = await coordinator.stop({
      ownerConnectionId: "connection-1",
      voiceInputId: started.id,
      expectedNextChunkSequence: 2n
    });

    expect(stopped).toMatchObject({
      state: "done",
      outcome: "success",
      result: {
        text: "Please inspect src/app.ts.",
        source: "stable",
        salvaged: false,
        rawTranscriptText: "please inspect src/app.ts"
      }
    });
  });

  it("makes start idempotent per authenticated Connection and cancel exactly once", async () => {
    const provider = new FakeAsrProvider();
    const providerFactory = factory(provider);
    const coordinator = createCoordinator(providerFactory);
    const input = {
      ownerConnectionId: "connection-1",
      requestId: "request-same",
      mimeType: "audio/webm"
    } as const;

    const first = await coordinator.start(input);
    const replay = await coordinator.start(input);
    expect(replay.id).toBe(first.id);
    expect(providerFactory.createCalls).toBe(1);
    await expect(coordinator.start({ ...input, mimeType: "audio/ogg" }))
      .rejects.toMatchObject({ code: "conflict" });

    const cancelled = await coordinator.cancel({ ownerConnectionId: "connection-1", voiceInputId: first.id });
    const repeated = await coordinator.cancel({ ownerConnectionId: "connection-1", voiceInputId: first.id });
    expect(cancelled.outcome).toBe("cancelled");
    expect(repeated.outcome).toBe("cancelled");
    expect(provider.stopCalls).toBe(1);
  });

  it("salvages the latest raw text in memory without exposing provider error text", async () => {
    const provider = new FakeAsrProvider();
    const coordinator = createCoordinator(factory(provider));
    const started = await coordinator.start({
      ownerConnectionId: "connection-1",
      requestId: "request-salvage",
      mimeType: "audio/ogg"
    });

    provider.emit({ type: "stable", text: "older stable" });
    provider.emit({ type: "partial", text: "newest private raw" });
    provider.emit({ type: "error", category: "transport", recoverable: false });
    await settlePromises();

    const failed = coordinator.get({ ownerConnectionId: "connection-1", voiceInputId: started.id });
    expect(failed).toMatchObject({
      state: "error",
      outcome: "failed",
      result: { text: "newest private raw", source: "partial", salvaged: true },
      failure: { code: "connection_interrupted", transcriptKept: true }
    });
    expect(Object.keys(failed.failure ?? {})).toEqual(["code", "transcriptKept"]);
  });

  it("fails closed when no capability is configured", async () => {
    const coordinator = createCoordinator();
    expect(coordinator.capabilities()).toMatchObject({ support: "not_implemented", mimeTypes: [] });
    await expect(coordinator.start({
      ownerConnectionId: "connection-1",
      requestId: "request-1",
      mimeType: "audio/webm"
    })).rejects.toMatchObject({ code: "not_supported" });
  });

  it("counts pending factories against the concurrent session bound", async () => {
    const provider = new FakeAsrProvider();
    const pending = deferred<AsrProvider>();
    const providerFactory: VoiceInputProviderFactory = {
      describe: () => ({ support: "supported", mimeTypes: ["audio/webm"], supportsLocale: true }),
      create: () => pending.promise
    };
    const coordinator = createCoordinator(providerFactory, { maximumConcurrentSessions: 1 });
    const first = coordinator.start({
      ownerConnectionId: "connection-1",
      requestId: "request-1",
      mimeType: "audio/webm"
    });
    await expect(coordinator.start({
      ownerConnectionId: "connection-2",
      requestId: "request-2",
      mimeType: "audio/webm"
    })).rejects.toMatchObject({ code: "resource_exhausted" });
    pending.resolve(provider);
    await first;
  });

  it("does not revive a provider factory that settles after shutdown", async () => {
    const provider = new FakeAsrProvider();
    const pending = deferred<AsrProvider>();
    const coordinator = createCoordinator({
      describe: () => ({ support: "supported", mimeTypes: ["audio/webm"], supportsLocale: true }),
      create: () => pending.promise
    });
    const starting = coordinator.start({
      ownerConnectionId: "connection-1",
      requestId: "request-shutdown",
      mimeType: "audio/webm"
    });

    await coordinator.close();
    pending.resolve(provider);
    await expect(starting).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(provider.stopCalls).toBe(1);
  });

  it.each([
    { name: "actual audio bytes", bytes: 320_000, durationMs: 100, chunks: 9, budgetMs: 180_000 },
    { name: "declared audio duration", bytes: 32, durationMs: 10_000, chunks: 9, budgetMs: 180_000 },
    { name: "rounded audio bytes", bytes: 321, durationMs: 1, chunks: 1, budgetMs: 90_011 }
  ])("keeps a fixed Stop drain deadline from $name past the capture lifetime", async ({ bytes, durationMs, chunks, budgetMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const provider = new FakeAsrProvider();
    const flush = deferred<void>();
    provider.flushImpl = () => flush.promise;
    provider.stopImpl = async () => { flush.reject(new Error("Retired capture")); };
    let retireOwner: (() => void) | undefined;
    const disposeOwner = vi.fn(() => { retireOwner = undefined; });
    const coordinator = createCoordinator(factory(provider), {
      onOwnerRetired: (_owner, listener) => { retireOwner = listener; return disposeOwner; }
    });
    try {
      const started = await coordinator.start({ ownerConnectionId: "drain-owner", requestId: "drain-request", mimeType: "audio/webm" });
      const owner = { ownerConnectionId: "drain-owner", voiceInputId: started.id };
      for (let index = 0; index < chunks; index += 1) {
        coordinator.append({ ...owner, chunkSequence: BigInt(index + 1), audio: new Uint8Array(bytes), durationMs, voiced: true });
      }
      vi.setSystemTime(719_000);
      await expect(coordinator.stop({ ...owner, expectedNextChunkSequence: 0n })).rejects.toMatchObject({ code: "conflict" });
      expect(provider.flushCalls).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      const stopInput = { ...owner, expectedNextChunkSequence: BigInt(chunks + 1) };
      const stopping = coordinator.stop(stopInput);
      let returned = false;
      void stopping.then(() => { returned = true; });
      expect(provider.flushCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(coordinator.get(owner)).toMatchObject({ state: "submitting", acceptedAudioBytes: bytes * chunks, acceptedAudioDurationMs: durationMs * chunks });
      const repeated = coordinator.stop(stopInput);
      provider.emit({ type: "partial", text: "Private late draft" });
      await vi.advanceTimersByTimeAsync(budgetMs - 1_002);
      expect(returned).toBe(false);
      expect(coordinator.get(owner).outcome).toBeUndefined();
      expect(retireOwner).toBeDefined();
      expect(provider.flushCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const stopped = await stopping;
      const repeatedResult = await repeated;
      expect(stopped).toMatchObject({ state: "done", outcome: "cancelled" });
      expect(repeatedResult.outcome).toBe("cancelled");
      expect(stopped.result).toBeUndefined();
      expect(repeatedResult.result).toBeUndefined();
      expect(provider.stopCalls).toBe(1);
      expect(disposeOwner).toHaveBeenCalledTimes(1);
      expect(retireOwner).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      provider.emit({ type: "stable", text: "Late terminal text" });
      expect(() => coordinator.get(owner)).toThrowError(expect.objectContaining({ code: "not_found" }));
    } finally {
      await coordinator.close();
      vi.useRealTimers();
    }
  });

  it.each(["success", "cancel", "Connection", "configuration", "close"] as const)(
    "clears a pending Stop drain timer after %s retirement", async (retirement) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const provider = new FakeAsrProvider();
      const flush = deferred<void>();
      provider.flushImpl = () => flush.promise;
      provider.stopImpl = async () => { flush.reject(new Error("Retired capture")); };
      let retireOwner: (() => void) | undefined;
      const disposeOwner = vi.fn(() => { retireOwner = undefined; });
      const coordinator = createCoordinator(factory(provider), {
        onOwnerRetired: (_owner, listener) => { retireOwner = listener; return disposeOwner; }
      });
      try {
        const started = await coordinator.start({ ownerConnectionId: "cleanup-owner", requestId: "cleanup-request", mimeType: "audio/webm" });
        const owner = { ownerConnectionId: "cleanup-owner", voiceInputId: started.id };
        coordinator.append({ ...owner, chunkSequence: 1n, audio: new Uint8Array(320), durationMs: 10, voiced: true });
        const stopping = coordinator.stop({ ...owner, expectedNextChunkSequence: 2n });
        expect(vi.getTimerCount()).toBe(1);
        if (retirement === "success") {
          provider.emit({ type: "stable", text: "Confirmed text" });
          flush.resolve();
        } else if (retirement === "cancel") await coordinator.cancel(owner);
        else if (retirement === "Connection") retireOwner!();
        else if (retirement === "configuration") await coordinator.retireProviderConfiguration();
        else await coordinator.close();
        expect(await stopping).toMatchObject({ state: "done", outcome: retirement === "success" ? "success" : "cancelled" });
        expect(disposeOwner).toHaveBeenCalledTimes(1);
        expect(retireOwner).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(90_010);
        provider.emit({ type: "stable", text: "Late replacement text" });
        expect(provider.stopCalls).toBe(1);
        if (retirement !== "close") {
          expect(coordinator.get(owner).result?.text).toBe(retirement === "success" ? "Confirmed text" : undefined);
        }
      } finally {
        await coordinator.close();
        vi.useRealTimers();
      }
    }
  );

  it("keeps the capture lifetime fixed when drafts and reads change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const provider = new FakeAsrProvider();
    const coordinator = createCoordinator(factory(provider));
    try {
      const started = await coordinator.start({ ownerConnectionId: "capture-owner", requestId: "capture-request", mimeType: "audio/webm" });
      const owner = { ownerConnectionId: "capture-owner", voiceInputId: started.id };
      vi.setSystemTime(719_999);
      provider.emit({ type: "partial", text: "Current capture" });
      expect(coordinator.get(owner).state).toBe("listening");
      vi.setSystemTime(720_000);
      expect(() => coordinator.get(owner)).toThrowError(expect.objectContaining({ code: "not_found" }));
      await settlePromises();
      expect(provider.stopCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await coordinator.close();
      vi.useRealTimers();
    }
  });
});

class FakeAsrProvider implements AsrProvider {
  startRequests: AsrStartRequest[] = [];
  appendCalls: AudioChunk[] = [];
  stopCalls = 0;
  flushCalls = 0;
  flushImpl: () => Promise<void> = async () => undefined;
  stopImpl: () => Promise<void> = async () => undefined;
  private listener: ((event: AsrEvent) => void) | undefined;

  async start(request: AsrStartRequest): Promise<void> {
    this.startRequests.push(request);
  }

  appendAudio(chunk: AudioChunk): void {
    this.appendCalls.push(chunk);
  }

  flushAudio(): Promise<void> {
    this.flushCalls += 1;
    return this.flushImpl();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopImpl();
  }

  async recover(): Promise<void> {}

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

function factory(provider: AsrProvider): VoiceInputProviderFactory & { createCalls: number } {
  return {
    createCalls: 0,
    describe: () => ({
      support: "supported",
      mimeTypes: ["audio/webm", "audio/ogg"],
      supportsLocale: true
    }),
    create() {
      this.createCalls += 1;
      return provider;
    }
  };
}

function createCoordinator(
  provider?: VoiceInputProviderFactory,
  overrides: Pick<VoiceInputCoordinatorOptions, "maximumConcurrentSessions" | "onOwnerRetired"> = {}
): VoiceInputCoordinator {
  let nextId = 0;
  const coordinator = new VoiceInputCoordinator({
    ...(provider === undefined ? {} : { provider }),
    createId: () => `voice-${++nextId}`,
    ...overrides
  });
  coordinators.push(coordinator);
  return coordinator;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
