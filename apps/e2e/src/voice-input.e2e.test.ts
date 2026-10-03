import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  CredentialKind, CredentialService, DeviceKind, OperationMutationSchema, OperationState,
  VoiceInputDictionaryLearningActionType, VoiceInputSaucAuthentication, VoiceInputSaucMode,
  VoiceInputState, VoiceInputTerminalOutcome, VoiceInputTranscriptionProtocol,
  type VoiceInputServiceSettingsPatch
} from "@joko/contracts";
import { createOrchestratorApplication, createPublicServer, type OrchestratorConfig } from "@joko/orchestrator";
import { expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { createE2eClients, type PairedClient } from "./connect-clients.js";
import { submit } from "./operations.js";

type SaucPacket = { type: number; sequence?: number; data: Buffer };
interface GatewaySession {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly packets: SaucPacket[];
}

it("uses saved SAUC routes, explicit context and dictionary snapshots through production HTTP, cancellation and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-sauc-product-"));
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sessions: GatewaySession[] = [];
  let rejectNextPrimary = false;
  let holdNextReady = false;
  await once(gateway, "listening");
  gateway.on("connection", (socket, request) => {
    const session: GatewaySession = { socket, request, packets: [] };
    sessions.push(session);
    socket.on("message", (raw) => {
      const bytes = Buffer.from(raw as Buffer);
      const offset = (bytes[1]! & 1) === 1 ? 8 : 4;
      const packet: SaucPacket = { type: bytes[1]! >> 4, data: gunzipSync(bytes.subarray(offset + 4)),
        ...(offset === 8 ? { sequence: bytes.readInt32BE(4) } : {}) };
      session.packets.push(packet);
      if (packet.type === 1) {
        if (rejectNextPrimary && request.url?.endsWith("bigmodel_nostream")) {
          rejectNextPrimary = false;
          socket.send(saucFailure());
        } else if (holdNextReady) {
          holdNextReady = false;
        } else socket.send(saucResponse({}));
      } else if ((packet.sequence ?? 0) < 0) {
        socket.send(saucResponse({ result: { text: "A verified final transcript.",
          utterances: [{ text: "A verified final transcript.", start_time: 0, end_time: 100, definite: true }] } }, Math.abs(packet.sequence!), true));
      }
    });
  });
  const gatewayAddress = gateway.address();
  if (typeof gatewayAddress === "string" || gatewayAddress === null) throw new Error("SAUC test listener has no address.");
  const origin = `ws://127.0.0.1:${gatewayAddress.port}/api/v3/sauc`;
  const primarySecret = "primary-access-token-fixture";
  const fallbackSecret = "fallback-api-key-fixture";
  const contextText = "Explicitly authorized recognition context.\n\tA second paragraph.";
  let host: Awaited<ReturnType<typeof startVoiceHost>> | undefined;
  const durableOperations: unknown[] = [];
  try {
    host = await startVoiceHost(directory);
    let paired = await host.pair();
    let clients = paired.clients;
    const initial = (await clients.settings.getSettings({})).settings!.voiceInput!;
    const upload = async (secret: string): Promise<string> => {
      const credentialApi = createClient(CredentialService, createConnectTransport({ baseUrl: host!.baseUrl, httpVersion: "1.1",
        interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] }));
      const ticket = (await credentialApi.beginCredentialUpload({ kind: CredentialKind.API_KEY, providerId: "" })).ticket!;
      expect((await fetch(new URL(ticket.relativeEndpoint, host!.baseUrl), { method: "PUT", headers: {
        authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream"
      }, body: Buffer.from(secret) })).ok).toBe(true);
      return ticket.ticketId;
    };
    const save = async (patch: Omit<VoiceInputServiceSettingsPatch, "$typeName">) => {
      const operation = await submit(clients.operation, paired.connectionId, create(OperationMutationSchema, {
        payload: { case: "updateVoiceInputServiceSettings", value: { patch } }
      }));
      durableOperations.push(operation);
      return operation;
    };
    const primaryTicket = await upload(primarySecret);
    const fallbackTicket = await upload(fallbackSecret);
    expect(primaryTicket).not.toBe(fallbackTicket);
    expect((await save({ enabled: true, protocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC,
      endpoint: `${origin}/bigmodel_nostream`, model: "", resourceId: "volc.seedasr.sauc.duration", keyless: false,
      credentialUploadTicketId: primaryTicket, expectedRevision: initial.version!.revision, refinementEnabled: false,
      sauc: { $typeName: "joko.v1.VoiceInputSaucSettings", mode: VoiceInputSaucMode.STREAM_INPUT,
        authentication: VoiceInputSaucAuthentication.ACCESS_TOKEN, appId: "public-application-id", useDictionaryHotwords: true,
        boostingTableName: "Primary table", boostingTableId: "primary-table-id", correctTableName: "Primary corrections", correctTableId: "primary-correction-id" },
      fallbackEnabled: true, fallbackProtocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC,
      fallbackEndpoint: `${origin}/bigmodel_async`, fallbackModel: "", fallbackResourceId: "volc.seedasr.sauc.duration", fallbackKeyless: false,
      fallbackCredentialUploadTicketId: fallbackTicket,
      fallbackSauc: { $typeName: "joko.v1.VoiceInputSaucSettings", mode: VoiceInputSaucMode.ASYNC_TWO_PASS,
        authentication: VoiceInputSaucAuthentication.API_KEY, appId: "", useDictionaryHotwords: true,
        boostingTableName: "", boostingTableId: "backup-table-id", correctTableName: "", correctTableId: "" }
    })).state).toBe(OperationState.SUCCEEDED);
    let settings = (await clients.settings.getSettings({})).settings!.voiceInput!;
    expect(settings).toMatchObject({ credentialConfigured: true, fallbackCredentialConfigured: true,
      sauc: { mode: VoiceInputSaucMode.STREAM_INPUT, authentication: VoiceInputSaucAuthentication.ACCESS_TOKEN, appId: "public-application-id" },
      fallbackSauc: { mode: VoiceInputSaucMode.ASYNC_TWO_PASS, authentication: VoiceInputSaucAuthentication.API_KEY, appId: "" } });
    expect((await save({ enabled: false, expectedRevision: initial.version!.revision })).state).toBe(OperationState.FAILED);
    expect((await clients.settings.getSettings({})).settings!.voiceInput!.version!.revision).toEqual(settings.version!.revision);
    const capability = (await clients.voiceInput.getVoiceInputCapabilities({})).profile!;
    expect(capability).toMatchObject({ supportsLocale: false, supportsLiveDrafts: false, supportsRecognitionContext: true,
      supportedLocales: [], recognitionContextMaximumItems: 20, recognitionContextMaximumItemBytes: 2_048, recognitionContextMaximumBytes: 8_192 });
    expect(await clients.voiceInput.testVoiceInputConnection({})).toMatchObject({ ok: true });
    expect(sessions).toHaveLength(1);
    const probe = sessions[0]!;
    expect(probe.request.url).toBe("/api/v3/sauc/bigmodel_nostream");
    expect(probe.request.headers["x-api-app-key"]).toBe("public-application-id");
    expect(probe.request.headers["x-api-access-key"]).toBe(primarySecret);
    expect(probe.request.headers["x-api-key"]).toBeUndefined();
    expect(probe.packets.map(packet => packet.type)).toEqual([1]);
    expect(configuration(probe).request.corpus).toEqual({ boosting_table_name: "Primary table", boosting_table_id: "primary-table-id",
      correct_table_name: "Primary corrections", correct_table_id: "primary-correction-id" });
    await vi.waitFor(() => expect(probe.socket.readyState).toBe(3));

    const terms = Array.from({ length: 201 }, (_, index) => `Main term ${index.toString().padStart(3, "0")}`);
    let dictionary = (await clients.voiceInput.getVoiceInputDictionary({})).dictionary!;
    dictionary = (await clients.voiceInput.addVoiceInputDictionaryTerms({ expectedRevision: dictionary.revision, terms })).dictionary!;
    const firstEntry = dictionary.entries.find(entry => entry.text === terms[0])!;
    dictionary = (await clients.voiceInput.editVoiceInputDictionaryEntry({ expectedRevision: dictionary.revision,
      entryId: firstEntry.entryId, text: firstEntry.text, aliases: ["Alias excluded from ASR"] })).dictionary!;
    dictionary = (await clients.voiceInput.applyVoiceInputDictionaryLearning({ expectedRevision: dictionary.revision,
      actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_CANDIDATE, term: "Candidate excluded from ASR" }] })).dictionary!;
    expect(dictionary.entries).toHaveLength(201);
    expect(dictionary.refinementTerms).toHaveLength(200);
    const requestId = randomUUID();
    const input = { requestId, mimeType: "audio/pcm", recognitionContext: { contextData: [{ text: `  ${contextText.replaceAll("\n", "\r\n")}  ` }] } };
    const started = (await clients.voiceInput.startVoiceInput(input)).session!;
    expect(started.state).toBe(VoiceInputState.LISTENING);
    expect(sessions).toHaveLength(2);
    const recording = sessions[1]!;
    const frozenContext = recognitionContext(recording);
    expect(frozenContext).toEqual({ hotwords: dictionary.entries.map(entry => ({ word: entry.text })),
      context_type: "dialog_ctx", context_data: [{ text: contextText }] });
    expect(frozenContext.hotwords).toHaveLength(201);
    expect(configuration(recording).request.enable_nonstream).toBeUndefined();
    expect((await clients.voiceInput.startVoiceInput({ ...input,
      recognitionContext: { contextData: [{ text: contextText }] } })).session!.voiceInputId).toBe(started.voiceInputId);
    expect(sessions).toHaveLength(2);
    dictionary = (await clients.voiceInput.addVoiceInputDictionaryTerms({ expectedRevision: dictionary.revision, terms: ["Later dictionary term"] })).dictionary!;
    input.recognitionContext.contextData[0]!.text = "Changed caller context.";
    expect(recognitionContext(recording)).toEqual(frozenContext);
    const pcm = new Uint8Array(3_200).fill(7);
    const appended = (await clients.voiceInput.appendVoiceAudio({ voiceInputId: started.voiceInputId, chunkSequence: 1n,
      audio: pcm, durationMs: 100, voiced: true })).session!;
    expect(appended.acceptedAudioBytes).toBe(3_200n);
    expect(appended.nextChunkSequence).toBe(2n);
    const stopped = (await clients.voiceInput.stopVoiceInput({ voiceInputId: started.voiceInputId, expectedNextChunkSequence: 2n })).session!;
    expect(stopped).toMatchObject({ state: VoiceInputState.DONE, outcome: VoiceInputTerminalOutcome.SUCCESS,
      result: { text: "A verified final transcript." } });
    const audioPackets = recording.packets.filter(packet => packet.type === 2);
    expect(audioPackets.at(-1)!.sequence).toBeLessThan(0);
    expect(Buffer.concat(audioPackets.map(packet => packet.data))).toEqual(Buffer.from(pcm));
    expect(recording.packets.filter(packet => packet.type === 1)).toHaveLength(1);

    const cancelStart = (await clients.voiceInput.startVoiceInput({ requestId: randomUUID(), mimeType: "audio/pcm",
      recognitionContext: { contextData: [{ text: "Cancelled private context." }] } })).session!;
    const canceledSocket = sessions.at(-1)!;
    const canceled = (await clients.voiceInput.cancelVoiceInput({ voiceInputId: cancelStart.voiceInputId })).session!;
    expect(canceled.outcome).toBe(VoiceInputTerminalOutcome.CANCELLED);
    await expectClosedWithoutLateResult(canceledSocket);
    const canceledSnapshot = (await clients.voiceInput.getVoiceInputSession({ voiceInputId: cancelStart.voiceInputId })).session!;
    expect(canceledSnapshot.outcome).toBe(VoiceInputTerminalOutcome.CANCELLED);
    expect(canceledSnapshot.result).toBeUndefined();

    const configurationStart = (await clients.voiceInput.startVoiceInput({ requestId: randomUUID(), mimeType: "audio/pcm" })).session!;
    const retiredConfigurationSocket = sessions.at(-1)!;
    expect((await save({ sauc: { ...settings.sauc!, boostingTableId: "replacement-table-id" }, expectedRevision: settings.version!.revision })).state).toBe(OperationState.SUCCEEDED);
    await vi.waitFor(async () => expect((await clients.voiceInput.getVoiceInputSession({ voiceInputId: configurationStart.voiceInputId })).session!.outcome).toBe(VoiceInputTerminalOutcome.CANCELLED));
    await expectClosedWithoutLateResult(retiredConfigurationSocket);
    settings = (await clients.settings.getSettings({})).settings!.voiceInput!;
    assertPrivateDataAbsent(host.application.store, durableOperations, [primarySecret, fallbackSecret, contextText, "Cancelled private context.", "A verified final transcript."]);

    const originalConnection = paired;
    await host.close();
    host = await startVoiceHost(directory);
    paired = { ...originalConnection, clients: createE2eClients(host.baseUrl, originalConnection.authKey) };
    clients = paired.clients;
    const restored = (await clients.settings.getSettings({})).settings!.voiceInput!;
    expect(restored).toEqual(settings);
    expect(await clients.voiceInput.testVoiceInputConnection({})).toMatchObject({ ok: true });
    expect(sessions.at(-1)!.request.headers["x-api-access-key"]).toBe(primarySecret);
    expect(sessions.at(-1)!.packets.map(packet => packet.type)).toEqual([1]);
    rejectNextPrimary = true;
    const beforeFallback = sessions.length;
    const fallback = (await clients.voiceInput.startVoiceInput({ requestId: randomUUID(), mimeType: "audio/pcm",
      recognitionContext: { contextData: [{ text: contextText }] } })).session!;
    expect(fallback.state).toBe(VoiceInputState.LISTENING);
    expect(sessions.slice(beforeFallback)).toHaveLength(2);
    const backup = sessions.at(-1)!;
    expect(backup.request.url).toBe("/api/v3/sauc/bigmodel_async");
    expect(backup.request.headers["x-api-key"]).toBe(fallbackSecret);
    expect(backup.request.headers["x-api-access-key"]).toBeUndefined();
    expect(backup.request.headers["x-api-app-key"]).toBeUndefined();
    expect(configuration(backup).request).toMatchObject({ enable_nonstream: true, end_window_size: 300,
      corpus: { boosting_table_id: "backup-table-id" } });
    expect(recognitionContext(backup).context_data).toEqual([{ text: contextText }]);
    expect(recognitionContext(backup).hotwords.map(item => item.word)).toEqual(dictionary.entries.map(entry => entry.text));
    expect(recognitionContext(sessions[beforeFallback]!).context_data).toEqual(recognitionContext(backup).context_data);
    await clients.voiceInput.cancelVoiceInput({ voiceInputId: fallback.voiceInputId });

    const ownerStart = (await clients.voiceInput.startVoiceInput({ requestId: randomUUID(), mimeType: "audio/pcm" })).session!;
    const ownerSocket = sessions.at(-1)!;
    host.application.connections.revoke(paired.connectionId);
    await expectClosedWithoutLateResult(ownerSocket);
    const retiredOwner = host.application.voiceInput!.get({ ownerConnectionId: paired.connectionId, voiceInputId: ownerStart.voiceInputId });
    expect(retiredOwner.outcome).toBe("cancelled");
    expect(retiredOwner.result).toBeUndefined();
    const afterRetirement = sessions.length;
    await expect(clients.voiceInput.startVoiceInput({ requestId: randomUUID(), mimeType: "audio/pcm" })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(clients.voiceInput.getVoiceInputSession({ voiceInputId: ownerStart.voiceInputId })).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(sessions).toHaveLength(afterRetirement);

    paired = await host.pair(); clients = paired.clients;
    holdNextReady = true;
    const cancellation = new AbortController();
    const probeIndex = sessions.length;
    const canceledProbe = clients.voiceInput.testVoiceInputConnection({}, { signal: cancellation.signal });
    const rejectedProbe = expect(canceledProbe).rejects.toMatchObject({ code: Code.Canceled });
    await vi.waitFor(() => expect(sessions[probeIndex]?.packets).toHaveLength(1));
    cancellation.abort();
    await rejectedProbe;
    await vi.waitFor(() => expect(sessions[probeIndex]!.socket.readyState).toBe(3));
    expect(sessions[probeIndex]!.packets.map(packet => packet.type)).toEqual([1]);
    expect(await clients.voiceInput.testVoiceInputConnection({})).toMatchObject({ ok: true });
    assertPrivateDataAbsent(host.application.store, durableOperations, [primarySecret, fallbackSecret, contextText, "A verified final transcript."]);
    await host.close(); host = undefined;
    const encryptedCredentials = await readFile(join(directory, "data", "credentials", "records.json"), "utf8");
    expect(encryptedCredentials).not.toContain(primarySecret);
    expect(encryptedCredentials).not.toContain(fallbackSecret);
  } finally {
    await host?.close();
    for (const socket of gateway.clients) socket.terminate();
    await voiceDeadline(new Promise<void>(resolve => gateway.close(() => resolve())), 5_000);
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("joko-sauc-product-")) throw new Error("Unexpected voice test directory.");
    await rm(target, { recursive: true, force: true });
  }
}, 120_000);

async function startVoiceHost(directory: string) {
  const workspace = join(directory, "workspace");
  const dataDirectory = join(directory, "data");
  await mkdir(workspace, { recursive: true });
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317, publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"), allowInsecureLoopback: true, allowInsecureLan: false,
    lanDiscoveryEnabled: false, voiceDictionaryLanDiscoveryEnabled: false,
    piExecutable: join(directory, "missing-pi"), codexExecutable: join(directory, "missing-codex"), claudeCodeExecutable: join(directory, "missing-claude"),
    piAgentHome: join(dataDirectory, "pi-agent-home"), workspace: { id: "workspace-voice-product", root: workspace, displayName: "Voice product", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(directory, "unused-web"), corsOrigins: []
  };
  const application = await createOrchestratorApplication(config);
  const codes = new Map<string, string>();
  const unsubscribe = application.connections.onPairingIssued(challenge => codes.set(challenge.id, challenge.code));
  application.connections.openPairingWindow();
  const server = await createPublicServer(application);
  server.log.level = "silent";
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  let closing: Promise<void> | undefined;
  return { application, baseUrl,
    async pair(): Promise<PairedClient> {
      const anonymous = createE2eClients(baseUrl);
      const device = { deviceDisplayName: "Voice client", deviceKind: DeviceKind.MOBILE, platform: "android", appVersion: "voice-product-e2e" };
      const begun = await anonymous.connection.beginPairing(device);
      const challengeId = begun.challenge!.challengeId;
      const completed = (await anonymous.connection.completePairing({ ...device, challengeId, humanCode: codes.get(challengeId)! })).result!;
      return { authKey: completed.authKey, connectionId: completed.connection!.connectionId, deviceId: completed.device!.deviceId,
        clients: createE2eClients(baseUrl, completed.authKey) };
    },
    close(): Promise<void> {
      closing ??= (async () => { unsubscribe(); try { await voiceDeadline(server.close(), 8_000); }
        finally { await voiceDeadline(application.close(), 8_000); } })();
      return closing;
    }
  };
}

function configuration(session: GatewaySession): { request: { corpus?: Record<string, string>; enable_nonstream?: boolean; end_window_size?: number } } {
  return JSON.parse(session.packets.find(packet => packet.type === 1)!.data.toString());
}
function recognitionContext(session: GatewaySession): { hotwords: { word: string }[]; context_type: string; context_data: { text: string }[] } {
  return JSON.parse(configuration(session).request.corpus!.context!);
}
function saucResponse(payload: unknown, sequence = 1, last = false): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(payload)));
  const header = Buffer.alloc(12);
  header.set([0x11, last ? 0x93 : 0x91, 0x11, 0]);
  header.writeInt32BE(last ? -sequence : sequence, 4); header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body]);
}
function saucFailure(): Buffer {
  const header = Buffer.alloc(12);
  header.set([0x11, 0xf0, 0, 0]); header.writeUInt32BE(45000001, 4); header.writeUInt32BE(0, 8);
  return header;
}
async function expectClosedWithoutLateResult(session: GatewaySession): Promise<void> {
  await vi.waitFor(() => expect(session.socket.readyState).toBe(3));
  const error = await new Promise<Error | undefined>(resolve => session.socket.send(saucResponse({ result: { text: "A late retired transcript." } }, 9, true), resolve));
  expect(error).toBeInstanceOf(Error);
}
function assertPrivateDataAbsent(store: Awaited<ReturnType<typeof createOrchestratorApplication>>["store"], operations: unknown[], privateText: string[]): void {
  const serialized = JSON.stringify({ settings: store.listSettings(), events: store.listEvents(), operations: store.listOperations(),
    diagnostics: store.listDiagnostics(), responses: operations }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  for (const text of privateText) for (const line of text.split("\n")) if (line.trim()) expect(serialized).not.toContain(line.trim());
  expect(serialized).not.toContain("A late retired transcript.");
  expect(serialized).not.toContain("recognitionContext");
}
async function voiceDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Voice test cleanup exceeded its budget.")), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
