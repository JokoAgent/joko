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
  GetVoiceInputDictionaryResponseSchema,
  GetVoiceInputDictionaryPeerStatusResponseSchema,
  WatchVoiceInputDictionaryResponseSchema,
  WatchVoiceInputDictionaryPeerStatusResponseSchema,
  GrantVoiceInputDictionaryPeerResponseSchema,
  RevokeVoiceInputDictionaryPeerResponseSchema,
  SyncVoiceInputDictionaryNowResponseSchema,
  ConfigureVoiceInputDictionaryListenerResponseSchema,
  GetVoiceInputDictionaryPeerInvitationResponseSchema,
  GrantVoiceInputDictionaryDirectPeerResponseSchema,
  ClearVoiceInputDictionaryPeerRouteResponseSchema,
  VoiceInputDictionaryPeerPhase,
  GetVoiceInputSessionResponseSchema,
  TestVoiceInputConnectionResponseSchema,
  OperationState,
  SnapshotSchema,
  StartVoiceInputResponseSchema,
  StopVoiceInputResponseSchema,
  SubmitOperationResponseSchema,
  VoiceInputState,
  VoiceInputConnectionTestFailure,
  VoiceInputDictionaryEntrySource,
  VoiceInputDictionaryLearningActionType,
  VoiceInputDictionaryLearningConfidence,
  VoiceInputDictionaryTermType,
  VoiceInputTerminalOutcome,
  VoiceInputTextSource,
  SetVoiceInputDictionarySyncEnabledResponseSchema,
  AddVoiceInputDictionaryTermsResponseSchema,
  EditVoiceInputDictionaryEntryResponseSchema,
  DeleteVoiceInputDictionaryEntryResponseSchema,
  ApplyVoiceInputDictionaryLearningResponseSchema,
  VoiceInputTranscriptionProtocol,
  defaultVoiceInputSaucSettings, protoVoiceInputSaucSettings
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import { dictionaryWatchFixture } from "./voice-dictionary.test-support.js";

describe("voice input gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["content", "sharing"] as const)("validates every %s watch sequence and passes caller and gateway cancellation to the original stream", async (kind) => {
    const updates = dictionaryWatchFixture<unknown>();
    let streamSignal!: AbortSignal;
    const transport = { ...voiceTransport(() => undefined), stream: vi.fn(async (method: any, signal: AbortSignal) => {
      if (method.localName === (kind === "content" ? "watchVoiceInputDictionary" : "watchVoiceInputDictionaryPeerStatus")) {
        streamSignal = signal; return response(method, updates.watch(signal), true);
      }
      return response(method, idleStream(), true);
    }) } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "voice-connection", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();
    const value = (sequence: bigint) => kind === "content"
      ? create(WatchVoiceInputDictionaryResponseSchema, { sequence, dictionary: dictionaryMessage() })
      : create(WatchVoiceInputDictionaryPeerStatusResponseSchema, { sequence, status: { available: true, configurationRevision: 5n,
        nodeId: "node-self", fingerprint: "a".repeat(64), enabled: true, phase: VoiceInputDictionaryPeerPhase.WAITING } });
    const watch = (signal: AbortSignal) => kind === "content" ? gateway.watchVoiceInputDictionary(signal) : gateway.watchVoiceInputDictionaryPeerStatus(signal);
    const request = new AbortController();
    try {
      const stream = watch(request.signal)[Symbol.asyncIterator]();
      const first = stream.next();
      await vi.waitFor(() => expect(updates.count).toBe(1));
      updates.push(value(1n));
      await expect(first).resolves.toMatchObject({ done: false, value: kind === "content" ? { revision: 4n } : { configurationRevision: 5n } });
      const duplicate = stream.next(); const rejected = expect(duplicate).rejects.toThrow(/invalid/u);
      updates.push(value(1n)); await rejected;
      expect(streamSignal.aborted).toBe(true);
      const resumed = watch(request.signal)[Symbol.asyncIterator]();
      const resumedFirst = resumed.next();
      await vi.waitFor(() => expect(updates.count).toBe(1));
      updates.push(value(1n)); await resumedFirst;
      request.abort();
      expect(streamSignal.aborted).toBe(true);
      await resumed.return?.();
      const last = watch(new AbortController().signal)[Symbol.asyncIterator]();
      const lastFirst = last.next();
      await vi.waitFor(() => expect(updates.count).toBe(1));
      updates.push(value(1n)); await lastFirst;
      gateway.disconnect(); expect(streamSignal.aborted).toBe(true);
      await last.return?.();
    } finally { request.abort(); gateway.disconnect(); updates.end(); }
  });

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
            supportedLocales: ["en-US"], supportsRecognitionContext: true,
            recognitionContextMaximumItems: 20, recognitionContextMaximumItemBytes: 2_048, recognitionContextMaximumBytes: 8_192,
            supportsLiveDrafts: true,
            supportsRefinement: true
          }
        });
      }
      if (method === "testVoiceInputConnection") return create(TestVoiceInputConnectionResponseSchema, { ok: true });
      if (method === "getVoiceInputDictionary") return create(GetVoiceInputDictionaryResponseSchema, {
        dictionary: dictionaryMessage()
      });
      switch (method) {
        case "setVoiceInputDictionarySyncEnabled": return create(SetVoiceInputDictionarySyncEnabledResponseSchema, { dictionary: dictionaryMessage(5n) });
        case "addVoiceInputDictionaryTerms": return create(AddVoiceInputDictionaryTermsResponseSchema, { dictionary: dictionaryMessage(5n) });
        case "editVoiceInputDictionaryEntry": return create(EditVoiceInputDictionaryEntryResponseSchema, { dictionary: dictionaryMessage(5n) });
        case "deleteVoiceInputDictionaryEntry": return create(DeleteVoiceInputDictionaryEntryResponseSchema, { dictionary: dictionaryMessage(5n) });
        case "applyVoiceInputDictionaryLearning": return create(ApplyVoiceInputDictionaryLearningResponseSchema, { dictionary: dictionaryMessage(5n) });
      }
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
      supportedLocales: ["en-US"], supportsRecognitionContext: true,
      recognitionContextMaximumItems: 20, recognitionContextMaximumItemBytes: 2_048, recognitionContextMaximumBytes: 8_192,
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
    await expect(gateway.getVoiceInputDictionary()).resolves.toMatchObject({
      revision: 4n,
      syncEnabled: true,
      entries: [{ id: "dict-sync-entry", text: "Joko", source: "manual", frequency: 2 }],
      candidates: [{ text: "VoiceKit", evidenceCount: 1 }],
      refinementTerms: ["Joko"]
    });
    await gateway.setVoiceInputDictionarySyncEnabled(4n, false);
    await gateway.addVoiceInputDictionaryTerms(4n, ["Orchestrator"]);
    await gateway.editVoiceInputDictionaryEntry(4n, "dict-sync-entry", "Joko Core", ["Joko"]);
    await gateway.deleteVoiceInputDictionaryEntry(4n, "dict-sync-entry");
    await gateway.applyVoiceInputDictionaryLearning(4n, [{
      action: "addCandidate",
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "productName",
      confidence: "high"
    }]);
    await gateway.startVoiceInput("request-one", "audio/webm", "en-US", {
      instructions: "Keep commands verbatim."
    }, undefined, { contextData: [{ text: "Client authorized context" }, { text: "Next item" }] });
    await gateway.appendVoiceAudio("voice-one", 1n, new Uint8Array([1, 2, 3]), 250, true);
    const result = await gateway.stopVoiceInput("voice-one", 2n);
    await gateway.cancelVoiceInput("voice-one");
    await gateway.getVoiceInputSession("voice-one");

    expect(requests.find((request) => request.method === "startVoiceInput")?.input).toMatchObject({
      requestId: "request-one",
      mimeType: "audio/webm",
      locale: "en-US",
      refinementInstructions: "Keep commands verbatim.",
      recognitionContext: { contextData: [{ text: "Client authorized context" }, { text: "Next item" }] }
    });
    expect("dictionaryTerms" in requests.find((request) => request.method === "startVoiceInput")!.input).toBe(false);
    expect(requests.find((request) => request.method === "setVoiceInputDictionarySyncEnabled")?.input)
      .toMatchObject({ expectedRevision: 4n, enabled: false });
    expect(requests.find((request) => request.method === "addVoiceInputDictionaryTerms")?.input)
      .toMatchObject({ expectedRevision: 4n, terms: ["Orchestrator"] });
    expect(requests.find((request) => request.method === "applyVoiceInputDictionaryLearning")?.input)
      .toMatchObject({ expectedRevision: 4n, actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_CANDIDATE }] });
    expect(requests.find((request) => request.method === "appendVoiceAudio")?.input).toMatchObject({ voiceInputId: "voice-one", chunkSequence: 1n, audio: new Uint8Array([1, 2, 3]), durationMs: 250, voiced: true });
    expect(requests.find((request) => request.method === "stopVoiceInput")?.input).toMatchObject({ voiceInputId: "voice-one", expectedNextChunkSequence: 2n });
    expect(result).toMatchObject({ state: "done", outcome: "success", result: { text: "final words", source: "stable", salvaged: false, rawTranscriptText: "final word" } });
    gateway.disconnect();
  });

  it("uses independent configuration and grant revisions for the generated sharing and direct route operations", async () => {
    const calls: Array<{ method: string; input: any }> = [];
    const status = { available: true, configurationRevision: 4n, nodeId: "node-a", fingerprint: "a".repeat(64),
      enabled: true, phase: VoiceInputDictionaryPeerPhase.WAITING,
      peers: [{ peerId: "node-b", revision: 2n, displayName: "Office", fingerprint: "b".repeat(64),
        grantedAt: { seconds: 1n, nanos: 0 } }] };
    const transport = voiceTransport((method, input) => {
      calls.push({ method, input });
      switch (method) {
        case "getVoiceInputDictionaryPeerStatus": return create(GetVoiceInputDictionaryPeerStatusResponseSchema, { status });
        case "grantVoiceInputDictionaryPeer": return create(GrantVoiceInputDictionaryPeerResponseSchema, { status });
        case "revokeVoiceInputDictionaryPeer": return create(RevokeVoiceInputDictionaryPeerResponseSchema, { status });
        case "syncVoiceInputDictionaryNow": return create(SyncVoiceInputDictionaryNowResponseSchema, { status });
        case "configureVoiceInputDictionaryListener": return create(ConfigureVoiceInputDictionaryListenerResponseSchema, { status });
        case "getVoiceInputDictionaryPeerInvitation": return create(GetVoiceInputDictionaryPeerInvitationResponseSchema, { invitation });
        case "grantVoiceInputDictionaryDirectPeer": return create(GrantVoiceInputDictionaryDirectPeerResponseSchema, { status });
        case "clearVoiceInputDictionaryPeerRoute": return create(ClearVoiceInputDictionaryPeerRouteResponseSchema, { status });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const invitation = JSON.stringify({ version: 1, nodeId: "node-b", displayName: "Peer", publicKey: "MCowBQYDK2VuAyEA" + "A".repeat(43) + "=",
      fingerprint: "b".repeat(64), host: "peer.example", port: 43_121 });
    const gateway = createOrchestratorGateway({ id: "sharing", deviceId: "device-test", name: "Browser",
      origin: "https://orchestrator.example", serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();
    calls.length = 0;
    try {
      await expect(gateway.getVoiceInputDictionaryPeerStatus()).resolves.toMatchObject({ configurationRevision: 4n,
        phase: "waiting", peers: [{ revision: 2n, grantedAt: 1_000 }] });
      await gateway.grantVoiceInputDictionaryPeer(4n, "node-c", "c".repeat(64));
      await gateway.revokeVoiceInputDictionaryPeer("node-b", 2n);
      await gateway.syncVoiceInputDictionaryNow(4n, "node-b");
      await gateway.configureVoiceInputDictionaryListener(4n, { listenPort: 43_121, host: "self.example", port: 44_121 });
      await expect(gateway.getVoiceInputDictionaryPeerInvitation()).resolves.toBe(invitation);
      await gateway.grantVoiceInputDictionaryDirectPeer(4n, invitation, "b".repeat(64));
      await gateway.clearVoiceInputDictionaryPeerRoute(4n, "node-b");
      await gateway.configureVoiceInputDictionaryListener(4n, undefined);
      expect(calls).toMatchObject([
        { method: "getVoiceInputDictionaryPeerStatus", input: {} },
        { method: "grantVoiceInputDictionaryPeer", input: { expectedConfigurationRevision: 4n, peerId: "node-c", expectedFingerprint: "c".repeat(64) } },
        { method: "revokeVoiceInputDictionaryPeer", input: { peerId: "node-b", expectedGrantRevision: 2n } },
        { method: "syncVoiceInputDictionaryNow", input: { expectedConfigurationRevision: 4n, peerId: "node-b" } },
        { method: "configureVoiceInputDictionaryListener", input: { expectedConfigurationRevision: 4n, listener: { listenPort: 43_121, host: "self.example", port: 44_121 } } },
        { method: "getVoiceInputDictionaryPeerInvitation", input: {} },
        { method: "grantVoiceInputDictionaryDirectPeer", input: { expectedConfigurationRevision: 4n, invitation, expectedFingerprint: "b".repeat(64) } },
        { method: "clearVoiceInputDictionaryPeerRoute", input: { expectedConfigurationRevision: 4n, peerId: "node-b" } },
        { method: "configureVoiceInputDictionaryListener", input: { expectedConfigurationRevision: 4n, listener: undefined } }
      ]);
    } finally { gateway.disconnect(); }
  });

  it.each(["missing", "unsafe revision", "unsafe count", "unspecified source"] as const)("rejects a dictionary projection with %s", async (invalid) => {
    const dictionary = dictionaryMessage();
    if (invalid === "unsafe revision") dictionary.revision = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    if (invalid === "unsafe count") dictionary.entries[0].frequency = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    if (invalid === "unspecified source") dictionary.entries[0].source = VoiceInputDictionaryEntrySource.UNSPECIFIED;
    const transport = voiceTransport(() => create(GetVoiceInputDictionaryResponseSchema, {
      ...(invalid === "missing" ? {} : { dictionary })
    }));
    const gateway = createOrchestratorGateway({ id: "dictionary-invalid", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();
    try { await expect(gateway.getVoiceInputDictionary()).rejects.toThrow(/dictionary/u); }
    finally { gateway.disconnect(); }
  });

  it("retains manual intent when a concurrent automatic suppression is present", async () => {
    const transport = voiceTransport(() => create(GetVoiceInputDictionaryResponseSchema, {
      dictionary: { ...dictionaryMessage(), suppressedAutomaticTerms: ["Joko"] }
    }));
    const gateway = createOrchestratorGateway({ id: "dictionary-manual", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();
    try { await expect(gateway.getVoiceInputDictionary()).resolves.toMatchObject({ entries: [{ text: "Joko", source: "manual" }], suppressedAutomaticTerms: ["Joko"] }); }
    finally { gateway.disconnect(); }
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
      protocol: "volcengineSauc",
      endpoint: "wss://speech.example/api/v3/sauc/bigmodel_async",
      model: "",
      resourceId: "volc.seedasr.sauc.duration",
      sauc: { ...defaultVoiceInputSaucSettings(), mode: "bidirectional", authentication: "accessToken", appId: "public-app", useDictionaryHotwords: true,
        boostingTableId: "boost", correctTableName: "correct" },
      keyless: false,
      secret: "replacement-key",
      refinementEnabled: false,
      refinerModel: { backendId: "text-one", providerId: "same-provider", modelId: "same-model" },
      refinerFallbackModel: { backendId: "text-two", providerId: "same-provider", modelId: "same-model" },
      fallbackEnabled: false,
      fallbackProtocol: "openAiCompatibleBatch",
      fallbackEndpoint: "https://api.openai.com/v1/audio/transcriptions",
      fallbackModel: "whisper-1",
      fallbackResourceId: "",
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
          protocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC,
          endpoint: "wss://speech.example/api/v3/sauc/bigmodel_async",
          model: "",
          resourceId: "volc.seedasr.sauc.duration",
          sauc: protoVoiceInputSaucSettings({ ...defaultVoiceInputSaucSettings(), mode: "bidirectional", authentication: "accessToken", appId: "public-app", useDictionaryHotwords: true,
            boostingTableId: "boost", correctTableName: "correct" }),
          refinerModel: { backendId: "text-one", providerId: "same-provider", modelId: "same-model" },
          refinerFallbackModel: { backendId: "text-two", providerId: "same-provider", modelId: "same-model" },
          fallbackResourceId: "",
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

function dictionaryMessage(revision = 4n): any {
  return {
    revision,
    syncEnabled: true,
    entries: [{
      entryId: "dict-sync-entry",
      text: "Joko",
      source: VoiceInputDictionaryEntrySource.MANUAL,
      frequency: 2n,
      aliases: [{ text: "jo ko", count: 1n, lastSeenAt: { seconds: 1n, nanos: 0 } }],
      createdAt: { seconds: 1n, nanos: 0 },
      updatedAt: { seconds: 2n, nanos: 0 }
    }],
    candidates: [{
      text: "VoiceKit",
      evidenceCount: 1n,
      aliases: [{ text: "voice kit", count: 1n, lastSeenAt: { seconds: 2n, nanos: 0 } }],
      createdAt: { seconds: 2n, nanos: 0 },
      updatedAt: { seconds: 2n, nanos: 0 }
    }],
    suppressedAutomaticTerms: [],
    refinementTerms: ["Joko"]
  };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
