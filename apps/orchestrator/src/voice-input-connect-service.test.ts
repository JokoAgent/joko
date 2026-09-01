import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AsrEvent, AsrProvider, AsrStartRequest, AudioChunk } from "@joko/voice-input";
import { createVoiceInputConnectService } from "./voice-input-connect-service.js";
import { VoiceInputCoordinator } from "./voice-input-coordinator.js";

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
    const service = createVoiceInputConnectService(coordinator, connectionTest, () => ({ connectionId: owner }));
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
    const service = createVoiceInputConnectService(undefined, undefined, () => ({ connectionId: "connection-1" }));
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
});

class FakeAsrProvider implements AsrProvider {
  flushImpl: () => Promise<void> = async () => undefined;
  private listener: ((event: AsrEvent) => void) | undefined;

  async start(_request: AsrStartRequest): Promise<void> {}
  appendAudio(_chunk: AudioChunk): void {}
  flushAudio(): Promise<void> { return this.flushImpl(); }
  async stop(): Promise<void> {}
  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  emit(event: AsrEvent): void { this.listener?.(event); }
}
