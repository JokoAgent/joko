import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  AppendVoiceAudioResponseSchema,
  AdviseVoiceInputDictionaryEditResponseSchema,
  BeginCredentialUploadResponseSchema,
  CapabilitySupport,
  CancelVoiceInputResponseSchema,
  GetSnapshotResponseSchema,
  GetVoiceInputCapabilitiesResponseSchema,
  GetVoiceInputSessionResponseSchema,
  TestVoiceInputConnectionResponseSchema,
  OperationState,
  SnapshotSchema,
  StartVoiceInputResponseSchema,
  StopVoiceInputResponseSchema,
  SubmitOperationResponseSchema,
  VoiceInputState,
  VoiceInputConnectionTestFailure,
  VoiceInputDictionaryLearningActionType,
  VoiceInputDictionaryLearningConfidence,
  VoiceInputDictionaryTermType,
  VoiceInputTerminalOutcome,
  VoiceInputTextSource
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("voice input gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps capabilities and transports ephemeral audio with strict sequencing", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const transport = voiceTransport((method, input) => {
      requests.push({ method, input });
      if (method === "getVoiceInputCapabilities") {
        return create(GetVoiceInputCapabilitiesResponseSchema, {
          profile: {
            capability: { support: CapabilitySupport.SUPPORTED },
            limits: {
              supportedMimeTypes: ["audio/webm"],
              maximumAudioChunkBytes: 8_192n,
              maximumAudioBytes: 1_048_576n,
              maximumAudioChunkDuration: { seconds: 0n, nanos: 500_000_000 },
              maximumAudioDuration: { seconds: 60n, nanos: 0 },
              maximumLocaleCharacters: 35,
              stableWait: { seconds: 1n, nanos: 250_000_000 },
              maximumConcurrentSessions: 1
            },
            supportsLocale: true,
            supportsLiveDrafts: true,
            supportsRefinement: true
          }
        });
      }
      if (method === "testVoiceInputConnection") return create(TestVoiceInputConnectionResponseSchema, { ok: true });
      if (method === "adviseVoiceInputDictionaryEdit") return create(AdviseVoiceInputDictionaryEditResponseSchema, {
        actions: [{
          action: VoiceInputDictionaryLearningActionType.ADD_ENTRY,
          term: "VoiceKit",
          aliases: ["voice kit"],
          termType: VoiceInputDictionaryTermType.PRODUCT_NAME,
          confidence: VoiceInputDictionaryLearningConfidence.HIGH
        }]
      });
      if (method === "startVoiceInput") return create(StartVoiceInputResponseSchema, { session: sessionMessage() });
      if (method === "appendVoiceAudio") return create(AppendVoiceAudioResponseSchema, {
        session: sessionMessage({ nextChunkSequence: 2n, acceptedAudioBytes: 3n, acceptedAudioDuration: { seconds: 0n, nanos: 250_000_000 } })
      });
      if (method === "stopVoiceInput") return create(StopVoiceInputResponseSchema, {
        session: sessionMessage({
          state: VoiceInputState.DONE,
          outcome: VoiceInputTerminalOutcome.SUCCESS,
          nextChunkSequence: 2n,
          acceptedAudioBytes: 3n,
          acceptedAudioDuration: { seconds: 0n, nanos: 250_000_000 },
          result: { text: "final words", source: VoiceInputTextSource.STABLE, salvaged: false, rawTranscriptText: "final word" }
        })
      });
      if (method === "cancelVoiceInput") return create(CancelVoiceInputResponseSchema, {
        session: sessionMessage({ state: VoiceInputState.DONE, outcome: VoiceInputTerminalOutcome.CANCELLED })
      });
      if (method === "getVoiceInputSession") return create(GetVoiceInputSessionResponseSchema, { session: sessionMessage() });
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway({ id: "voice-connection", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.getVoiceInputCapabilities()).resolves.toMatchObject({
      support: "supported",
      limits: { supportedMimeTypes: ["audio/webm"], maximumAudioChunkBytes: 8_192, stableWaitMs: 1_250 },
      supportsLocale: true,
      supportsLiveDrafts: true,
      supportsRefinement: true
    });
    await expect(gateway.testVoiceInputConnection()).resolves.toEqual({ ok: true });
    await expect(gateway.adviseVoiceInputDictionaryEdit({
      beforeText: "Use voice kit.",
      afterText: "Use VoiceKit.",
      existingEntries: [],
      existingCandidates: []
    })).resolves.toEqual({ actions: [{
      action: "addEntry",
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "productName",
      confidence: "high"
    }] });
    await gateway.startVoiceInput("request-one", "audio/webm", "en-US", {
      instructions: "Keep commands verbatim.",
      dictionaryTerms: ["Joko", "Orchestrator"]
    });
    await gateway.appendVoiceAudio("voice-one", 1n, new Uint8Array([1, 2, 3]), 250, true);
    const result = await gateway.stopVoiceInput("voice-one", 2n);
    await gateway.cancelVoiceInput("voice-one");
    await gateway.getVoiceInputSession("voice-one");

    expect(requests.find((request) => request.method === "startVoiceInput")?.input).toMatchObject({
      requestId: "request-one",
      mimeType: "audio/webm",
      locale: "en-US",
      refinementInstructions: "Keep commands verbatim.",
      dictionaryTerms: ["Joko", "Orchestrator"]
    });
    expect(requests.find((request) => request.method === "appendVoiceAudio")?.input).toMatchObject({ voiceInputId: "voice-one", chunkSequence: 1n, audio: new Uint8Array([1, 2, 3]), durationMs: 250, voiced: true });
    expect(requests.find((request) => request.method === "stopVoiceInput")?.input).toMatchObject({ voiceInputId: "voice-one", expectedNextChunkSequence: 2n });
    expect(result).toMatchObject({ state: "done", outcome: "success", result: { text: "final words", source: "stable", salvaged: false, rawTranscriptText: "final word" } });
    gateway.disconnect();
  });

  it("maps a content-free connection test failure", async () => {
    const transport = voiceTransport((method) => {
      if (method === "testVoiceInputConnection") return create(TestVoiceInputConnectionResponseSchema, {
        ok: false,
        failure: VoiceInputConnectionTestFailure.AUTHENTICATION_FAILED
      });
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway({ id: "voice-probe", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();
    await expect(gateway.testVoiceInputConnection()).resolves.toEqual({ ok: false, reason: "authenticationFailed" });
    gateway.disconnect();
  });

  it("fails closed when the service omits a required session", async () => {
    const transport = voiceTransport((method) => {
      if (method === "startVoiceInput") return create(StartVoiceInputResponseSchema);
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway({ id: "voice-missing", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();
    await expect(gateway.startVoiceInput("request-one", "audio/webm")).rejects.toThrow("no voice input session");
    gateway.disconnect();
  });

  it("uploads a replacement key through the credential channel before submitting non-secret settings", async () => {
    const calls: string[] = [];
    const submitted: any[] = [];
    let uploaded = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push("upload");
      uploaded = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response(undefined, { status: 204 });
    }));
    const transport = voiceTransport((method, input) => {
      if (method === "beginCredentialUpload") {
        calls.push("begin");
        expect(input).toMatchObject({ providerId: "" });
        return create(BeginCredentialUploadResponseSchema, {
          ticket: {
            ticketId: "voice-ticket",
            relativeEndpoint: "/v1/credential-uploads/voice-ticket",
            maximumBytes: 1_024n
          }
        });
      }
      if (method === "submitOperation") {
        calls.push("submit");
        submitted.push(input.mutation.payload);
        return create(SubmitOperationResponseSchema, {
          operation: { operationId: input.operationId, state: OperationState.SUCCEEDED }
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway({ id: "voice-settings", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await gateway.updateVoiceInputServiceSettings({
      enabled: true,
      protocol: "openAiCompatibleBatch",
      endpoint: "https://speech.example/v1/audio/transcriptions",
      model: "voice-model",
      keyless: false,
      secret: "replacement-key",
      refinementEnabled: false,
      refinerProviderId: "",
      refinerModelId: "",
      refinerFallbackProviderId: "",
      refinerFallbackModelId: "",
      fallbackEnabled: false,
      fallbackProtocol: "openAiCompatibleBatch",
      fallbackEndpoint: "https://api.openai.com/v1/audio/transcriptions",
      fallbackModel: "whisper-1",
      fallbackKeyless: false,
      expectedRevision: 4n
    });

    expect(calls).toEqual(["begin", "upload", "submit"]);
    expect(uploaded).toBe("replacement-key");
    expect(submitted[0]).toMatchObject({
      case: "updateVoiceInputServiceSettings",
      value: {
        patch: {
          enabled: true,
          endpoint: "https://speech.example/v1/audio/transcriptions",
          model: "voice-model",
          keyless: false,
          credentialUploadTicketId: "voice-ticket",
          expectedRevision: { value: 4n }
        }
      }
    });
    expect(JSON.stringify(submitted, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("replacement-key");
    gateway.disconnect();
  });
});

function voiceTransport(handler: (method: string, input: any) => unknown): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
        }));
      }
      return response(method, handler(method.localName, input));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function sessionMessage(patch: Record<string, unknown> = {}): any {
  return {
    voiceInputId: "voice-one",
    state: VoiceInputState.LISTENING,
    nextChunkSequence: 1n,
    acceptedAudioBytes: 0n,
    acceptedAudioDuration: { seconds: 0n, nanos: 0 },
    createdAt: { seconds: 1_000n, nanos: 0 },
    updatedAt: { seconds: 1_000n, nanos: 0 },
    recoveryAttempts: 0,
    stallWarning: false,
    ...patch
  };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
