import { afterEach, describe, expect, it } from "vitest";
import type { AsrEvent, AsrProvider, AsrStartRequest, AudioChunk } from "@joko/voice-input";
import {
  VoiceInputControlError,
  VoiceInputCoordinator,
  type VoiceInputProviderFactory
} from "./voice-input-coordinator.js";

const coordinators: VoiceInputCoordinator[] = [];

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
});

describe("VoiceInputCoordinator", () => {
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
});

class FakeAsrProvider implements AsrProvider {
  startRequests: AsrStartRequest[] = [];
  appendCalls: AudioChunk[] = [];
  stopCalls = 0;
  flushImpl: () => Promise<void> = async () => undefined;
  private listener: ((event: AsrEvent) => void) | undefined;

  async start(request: AsrStartRequest): Promise<void> {
    this.startRequests.push(request);
  }

  appendAudio(chunk: AudioChunk): void {
    this.appendCalls.push(chunk);
  }

  flushAudio(): Promise<void> {
    return this.flushImpl();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
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
  overrides: { readonly maximumConcurrentSessions?: number } = {}
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
