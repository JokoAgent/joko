import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent, AsrProvider, AsrStartRequest, AudioChunk } from "@joko/voice-input";
import { createVoiceInputConnectService } from "./voice-input-connect-service.js";
import { VoiceInputCoordinator } from "./voice-input-coordinator.js";
import { VoiceDictionarySyncRepositoryError, type VoiceDictionarySyncSnapshot } from "./voice-dictionary-sync-repository.js";

let coordinator: VoiceInputCoordinator | undefined;

afterEach(async () => {
  await coordinator?.close();
  coordinator = undefined;
});

describe("VoiceInputService", () => {
  it("authenticates and maps the strict start/chunk/stop/status contract", async () => {
    const provider = new FakeAsrProvider();
    provider.flushImpl = async () => provider.emit({ type: "stable", text: "ephemeral result" });
    coordinator = new VoiceInputCoordinator({
      provider: {
        describe: () => ({ support: "supported", mimeTypes: ["audio/webm"], supportsLocale: true }),
        create: () => provider
      },
      createId: () => "voice-rpc-1"
    });
    let owner = "connection-1";
    const connectionTest = {
      testConnection: async () => ({ ok: true } as const),
      adviseDictionaryEdit: async () => ({ actions: [{
        action: "add_entry" as const,
        term: "VoiceKit",
        aliases: ["voice kit"],
        type: "product_name" as const,
        confidence: "high" as const
      }] })
    };
    let dictionarySnapshot = voiceDictionarySnapshot();
    const dictionary = {
      snapshot: vi.fn(() => dictionarySnapshot),
      setEnabled: vi.fn((_revision: number, enabled: boolean) => (dictionarySnapshot = { ...dictionarySnapshot, revision: dictionarySnapshot.revision + 1, enabled })),
      addManualTerms: vi.fn(() => (dictionarySnapshot = { ...dictionarySnapshot, revision: dictionarySnapshot.revision + 1 })),
      editEntry: vi.fn(() => (dictionarySnapshot = { ...dictionarySnapshot, revision: dictionarySnapshot.revision + 1 })),
      deleteEntry: vi.fn(() => (dictionarySnapshot = { ...dictionarySnapshot, revision: dictionarySnapshot.revision + 1 })),
      applyLearning: vi.fn(() => (dictionarySnapshot = { ...dictionarySnapshot, revision: dictionarySnapshot.revision + 1 }))
    };
    const service = createVoiceInputConnectService(coordinator, connectionTest, dictionary, () => ({ connectionId: owner }));
    const start = vi.spyOn(coordinator, "start");
    const context = { signal: new AbortController().signal } as HandlerContext;

    const capabilities = await service.getVoiceInputCapabilities(
      create(contract.GetVoiceInputCapabilitiesRequestSchema),
      context
    );
    expect(capabilities.profile?.capability).toMatchObject({
      name: contract.capabilityNames.voiceInput,
      support: contract.CapabilitySupport.SUPPORTED
    });
    expect(capabilities.profile?.supportsRefinement).toBe(false);
    await expect(service.testVoiceInputConnection(
      create(contract.TestVoiceInputConnectionRequestSchema),
      context
    )).resolves.toMatchObject({ ok: true, failure: contract.VoiceInputConnectionTestFailure.UNSPECIFIED });
    await expect(service.adviseVoiceInputDictionaryEdit(create(contract.AdviseVoiceInputDictionaryEditRequestSchema, {
      beforeText: "Use voice kit.",
      afterText: "Use VoiceKit."
    }), context)).resolves.toMatchObject({
      actions: [{
        action: contract.VoiceInputDictionaryLearningActionType.ADD_ENTRY,
        term: "VoiceKit",
        aliases: ["voice kit"],
        termType: contract.VoiceInputDictionaryTermType.PRODUCT_NAME,
        confidence: contract.VoiceInputDictionaryLearningConfidence.HIGH
      }]
    });
    await expect(service.getVoiceInputDictionary(
      create(contract.GetVoiceInputDictionaryRequestSchema),
      context
    )).resolves.toMatchObject({
      dictionary: {
        revision: 4n,
        syncEnabled: true,
        entries: [{ entryId: "dict-sync-entry", text: "Joko", frequency: 2n }],
        refinementTerms: ["Joko"]
      }
    });
    await service.setVoiceInputDictionarySyncEnabled(create(contract.SetVoiceInputDictionarySyncEnabledRequestSchema, {
      expectedRevision: 4n,
      enabled: false
    }), context);
    await service.addVoiceInputDictionaryTerms(create(contract.AddVoiceInputDictionaryTermsRequestSchema, {
      expectedRevision: 5n,
      terms: ["Orchestrator"]
    }), context);
    await service.applyVoiceInputDictionaryLearning(create(contract.ApplyVoiceInputDictionaryLearningRequestSchema, {
      expectedRevision: 6n,
      actions: [{
        action: contract.VoiceInputDictionaryLearningActionType.ADD_CANDIDATE,
        term: "VoiceKit",
        aliases: ["voice kit"]
      }]
    }), context);
    expect(dictionary.setEnabled).toHaveBeenCalledWith(4, false);
    expect(dictionary.addManualTerms).toHaveBeenCalledWith(5, ["Orchestrator"]);
    expect(dictionary.applyLearning).toHaveBeenCalledWith(6, [{
      text: "VoiceKit",
      aliases: ["voice kit"],
      stage: "candidate"
    }]);

    const started = await service.startVoiceInput(create(contract.StartVoiceInputRequestSchema, {
      requestId: "request-rpc-1",
      mimeType: "audio/webm",
      locale: "en-US"
    }), context);
    expect(started.session).toMatchObject({
      voiceInputId: "voice-rpc-1",
      state: contract.VoiceInputState.LISTENING,
      nextChunkSequence: 1n
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ dictionaryTerms: ["Joko"] }));

    const appended = await service.appendVoiceAudio(create(contract.AppendVoiceAudioRequestSchema, {
      voiceInputId: "voice-rpc-1",
      chunkSequence: 1n,
      audio: Uint8Array.of(1, 2, 3),
      durationMs: 20,
      voiced: true
    }), context);
    expect(appended.session).toMatchObject({
      nextChunkSequence: 2n,
      acceptedAudioBytes: 3n
    });
    expect("audio" in (appended.session ?? {})).toBe(false);

    const stopped = await service.stopVoiceInput(create(contract.StopVoiceInputRequestSchema, {
      voiceInputId: "voice-rpc-1",
      expectedNextChunkSequence: 2n
    }), context);
    expect(stopped.session).toMatchObject({
      state: contract.VoiceInputState.DONE,
      outcome: contract.VoiceInputTerminalOutcome.SUCCESS,
      result: {
        text: "ephemeral result",
        source: contract.VoiceInputTextSource.STABLE,
        salvaged: false
      }
    });

    owner = "connection-2";
    await expect(service.getVoiceInputSession(create(contract.GetVoiceInputSessionRequestSchema, {
      voiceInputId: "voice-rpc-1"
    }), context)).rejects.toSatisfy((error: unknown) => error instanceof ConnectError && error.code === Code.NotFound);
  });

  it("advertises unsupported capability and rejects mutation without a configured coordinator", async () => {
    const service = createVoiceInputConnectService(undefined, undefined, undefined, () => ({ connectionId: "connection-1" }));
    const context = {} as HandlerContext;
    const capabilities = await service.getVoiceInputCapabilities(
      create(contract.GetVoiceInputCapabilitiesRequestSchema),
      context
    );
    expect(capabilities.profile?.capability?.support).toBe(contract.CapabilitySupport.NOT_IMPLEMENTED);
    await expect(service.startVoiceInput(create(contract.StartVoiceInputRequestSchema, {
      requestId: "request-1",
      mimeType: "audio/webm"
    }), context)).rejects.toSatisfy((error: unknown) => error instanceof ConnectError && error.code === Code.Unimplemented);
  });

  it("maps dictionary persistence failures without exposing an apparent mutation success", async () => {
    const unavailable = new VoiceDictionarySyncRepositoryError("UNAVAILABLE", "Dictionary storage unavailable.");
    const method = vi.fn(() => { throw unavailable; });
    const dictionary = {
      snapshot: method,
      setEnabled: method,
      addManualTerms: method,
      editEntry: method,
      deleteEntry: method,
      applyLearning: method
    };
    const service = createVoiceInputConnectService(undefined, undefined, dictionary, () => ({ connectionId: "connection-1" }));
    await expect(service.getVoiceInputDictionary(
      create(contract.GetVoiceInputDictionaryRequestSchema),
      {} as HandlerContext
    )).rejects.toSatisfy((error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable);
  });

  it("fences unauthenticated, cancelled, malformed and stale dictionary mutations", async () => {
    const method = vi.fn(() => voiceDictionarySnapshot());
    const dictionary = { snapshot: method, setEnabled: method, addManualTerms: method, editEntry: method, deleteEntry: method, applyLearning: method };
    const context = { signal: new AbortController().signal } as HandlerContext;
    const rejected = createVoiceInputConnectService(undefined, undefined, dictionary, () => { throw new ConnectError("Pair first.", Code.Unauthenticated); });
    await expect(rejected.applyVoiceInputDictionaryLearning(create(contract.ApplyVoiceInputDictionaryLearningRequestSchema, {
      expectedRevision: 4n, actions: [{ action: contract.VoiceInputDictionaryLearningActionType.ADD_ENTRY, term: "Joko" }]
    }), context)).rejects.toMatchObject({ code: Code.Unauthenticated });
    const service = createVoiceInputConnectService(undefined, undefined, dictionary, () => ({ connectionId: "connection-1" }));
    for (const revision of [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      await expect(service.addVoiceInputDictionaryTerms(create(contract.AddVoiceInputDictionaryTermsRequestSchema, {
        expectedRevision: revision, terms: ["Joko"]
      }), context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
    await expect(service.applyVoiceInputDictionaryLearning(create(contract.ApplyVoiceInputDictionaryLearningRequestSchema, {
      expectedRevision: 4n, actions: [{ action: 99 as contract.VoiceInputDictionaryLearningActionType, term: "Joko" }]
    }), context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    const abort = new AbortController(); abort.abort();
    await expect(service.deleteVoiceInputDictionaryEntry(create(contract.DeleteVoiceInputDictionaryEntryRequestSchema, {
      expectedRevision: 4n, entryId: "dict-sync-entry"
    }), { signal: abort.signal } as HandlerContext)).rejects.toMatchObject({ code: Code.Canceled });
    expect(method).not.toHaveBeenCalled();
    method.mockImplementationOnce(() => { throw new VoiceDictionarySyncRepositoryError("CONFLICT", "Dictionary changed."); });
    await expect(service.setVoiceInputDictionarySyncEnabled(create(contract.SetVoiceInputDictionarySyncEnabledRequestSchema, {
      expectedRevision: 3n, enabled: true
    }), context)).rejects.toMatchObject({ code: Code.Aborted });
  });
});

function voiceDictionarySnapshot(): VoiceDictionarySyncSnapshot {
  return {
    revision: 4,
    replicaId: "voice-replica-rpc",
    enabled: true,
    dictionary: {
      entries: [{
        id: "dict-sync-entry",
        text: "Joko",
        source: "manual",
        frequency: 2,
        aliases: [{ text: "jo ko", count: 1, lastSeenAt: 1_000 }],
        createdAt: 900,
        updatedAt: 1_000
      }],
      candidates: [],
      suppressedAutomaticTexts: []
    },
    refinementTerms: ["Joko"]
  };
}

class FakeAsrProvider implements AsrProvider {
  flushImpl: () => Promise<void> = async () => undefined;
  readonly startRequests: AsrStartRequest[] = [];
  private listener: ((event: AsrEvent) => void) | undefined;

  async start(request: AsrStartRequest): Promise<void> { this.startRequests.push(request); }
  appendAudio(_chunk: AudioChunk): void {}
  flushAudio(): Promise<void> { return this.flushImpl(); }
  async stop(): Promise<void> {}
  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  emit(event: AsrEvent): void { this.listener?.(event); }
}
