import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { piProviderModel, isManagedChatModel, type PiManagedModel } from "@joko/adapter-pi";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifact-store.js";
import { OperationalArtifactRepository } from "../artifact-repository.js";
import { ConnectionManager } from "../connection-manager.js";
import { CredentialManager, ProviderCatalogManager } from "../credential-manager.js";
import { CredentialVault } from "../credential-vault.js";
import { createModelRouteCatalog } from "../personalization-inference.js";
import { SessionHost } from "../session-host.js";
import { mkdtemp } from "../test-paths.js";
import { DesktopVoiceConversationManager } from "./manager.js";
import { SpeechModelCatalog } from "./models.js";

const MODELS: readonly PiManagedModel[] = [
  { id: "ordinary-chat", input: ["text"], declaredOutputModalities: ["text"] },
  { id: "audio-chat", mode: "chat", declaredOutputModalities: ["text", "audio"] },
  { id: "unclassified-audio", declaredOutputModalities: ["audio"] },
  { id: "asr", mode: "audio_transcription" },
  { id: "music", mode: "audio_generation" },
  { id: "effects", mode: "audio_generation" },
  { id: "custom-speech", name: "Custom speech", mode: "audio_speech", declaredInputModalities: ["text"], declaredOutputModalities: ["audio"] },
  { id: "unknown-modalities", mode: "audio_speech" },
  { id: "discovered-speech", mode: "audio_speech", discoveredMetadata: { mode: "audio_speech" }, metadataOverrides: [] },
  { id: "no-audio", mode: "audio_speech", declaredOutputModalities: ["text"] },
  { id: "empty-output", mode: "audio_speech", declaredOutputModalities: [] },
  { id: "empty-input", mode: "audio_speech", declaredInputModalities: [] },
  { id: "image-input", mode: "audio_speech", input: ["image"] },
  { id: "tts-1" }, { id: "tts-1-copy" }, { id: "custom/tts-1" },
  { id: "eleven_v3", mode: "chat" },
  { id: "eleven_flash_v2_5", discoveredMetadata: { mode: "other" }, metadataOverrides: [] }
];
const ACCEPTED = ["custom-speech", "discovered-speech", "tts-1", "unknown-modalities"];

async function fixture(baseUrl = "https://api.openai.com/v1") {
  const root = await mkdtemp(join(tmpdir(), "joko-speech-purpose-"));
  const store = new OperationalStore(join(root, "store.db"));
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, "private-purpose-key");
  await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId,
    credentialReferenceId: "purpose-key", displayName: "Speech key", kind: "api_key" });
  const disabled = new Set<string>();
  const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi",
    providerEnabled: backendId => !disabled.has(backendId),
    modelEnabled: (backendId, _providerId, modelId) => !disabled.has(`${backendId}/${modelId}`) });
  providers.initialize();
  const add = async (backendId: string) => {
    const provider = { id: "purpose", baseUrl, api: "openai-completions" as const, apiKeyEnv: "PURPOSE_KEY", models: MODELS };
    await providers.upsert({ backendId, provider, displayName: "Purpose Provider", kind: "custom_endpoint", enabled: true,
      credentialOrigin: new URL(baseUrl).origin, credentialBindings: { PURPOSE_KEY: "purpose-key" },
      supportsLogin: false, supportsLogout: true, supportsRefresh: false });
    const existing = store.listBackends().find(item => item.descriptor.id === backendId)?.descriptor;
    store.upsertBackend({ id: backendId, adapterKind: "fixture", instanceGeneration: 1, displayName: backendId, version: "0.1.0",
      health: "healthy", installationState: "installed", authenticationState: "authenticated",
      ...existing, capabilities: new Map([...(existing?.capabilities ?? []),
        ["provider.managed_catalog", { key: "provider.managed_catalog", supported: true, options: [] }]]),
      models: existing?.models ?? MODELS.filter(isManagedChatModel).map(model => piProviderModel(provider, model)), tools: [], diagnostics: [] });
  };
  for (const backendId of ["pi", "codex", "claude-code"]) await add(backendId);
  const routes = createModelRouteCatalog(store, providers), catalog = new SpeechModelCatalog(store, routes);
  return { root, store, credentials, providers, disabled, routes, catalog, add,
    selection: (backendId: string, modelId: string) => ({ backendId, providerId: "purpose", modelId, protocol: "openai", voice: "alloy" }),
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

it.each(["https://api.openai.com/v1", "https://speech-proxy.example/custom/v1"])(
  "admits the exact configured speech purpose independently of chat on all Backends at %s", async baseUrl => {
    const f = await fixture(baseUrl);
    try {
      for (const backendId of ["pi", "codex", "claude-code"]) {
        expect(f.catalog.list().filter(row => row.backendId === backendId).map(row => row.modelId).sort()).toEqual(ACCEPTED);
        for (const model of MODELS) {
          const selected = f.selection(backendId, model.id);
          if (ACCEPTED.includes(model.id)) {
            expect(f.catalog.resolve(selected).connection).toMatchObject({ baseUrl, headers: { authorization: "Bearer private-purpose-key" } });
            expect(f.routes.resolve(selected)).toBeUndefined();
          } else expect(() => f.catalog.resolve(selected)).toThrow("model_unavailable");
        }
        expect(f.routes.resolve(f.selection(backendId, "ordinary-chat"))).toBeDefined();
        expect(f.routes.resolve(f.selection(backendId, "eleven_v3"))).toBeDefined();
      }
      expect(f.catalog.list().find(row => row.modelId === "custom-speech")).toMatchObject({ displayName: "Custom speech", providerName: "Purpose Provider" });
      expect(f.catalog.list().some(row => row.modelId === "gpt-4o-mini-tts")).toBe(false);
      const original = f.catalog.resolve(f.selection("pi", "custom-speech"));
      f.disabled.add("pi/custom-speech");
      expect(() => f.catalog.resolve(f.selection("pi", "custom-speech"))).toThrow("model_unavailable");
      expect(original.assertCurrent).toThrow("connection_changed");
      expect(f.catalog.resolve(f.selection("codex", "custom-speech"))).toBeDefined();
      f.disabled.add("pi");
      expect(f.catalog.list().some(row => row.backendId === "pi")).toBe(false);
      const credentialBound = f.catalog.resolve(f.selection("codex", "custom-speech"));
      await f.credentials.replaceSecret("purpose-key", "replacement-purpose-key");
      expect(credentialBound.assertCurrent).toThrow("connection_changed");
      expect(f.catalog.resolve(f.selection("codex", "custom-speech")).connection.headers.authorization).toBe("Bearer replacement-purpose-key");
      await f.credentials.delete("purpose-key");
      expect(f.catalog.list()).toEqual([]);
    } finally { await f.close(); }
  }
);

it("retires a discovered speech purpose and persists the withdrawal without changing another Backend", async () => {
  const f = await fixture();
  try {
    const selected = f.selection("pi", "discovered-speech"), original = f.catalog.resolve(selected);
    await f.providers.discoverProviderModels("pi", "purpose", vi.fn(async () => Response.json({ data: [
      { id: "discovered-speech", mode: "audio_transcription", modalities: { input: ["audio"], output: ["text"] } },
      { id: "new-asr", mode: "audio_transcription" },
      { id: "new-speech", mode: "audio_speech", modalities: { input: ["text"], output: ["audio"] } }
    ] })) as typeof fetch);
    expect(original.assertCurrent).toThrow("connection_changed");
    expect(() => f.catalog.resolve(selected)).toThrow("model_unavailable");
    expect(f.catalog.list().some(row => row.backendId === "pi" && row.modelId === "new-speech")).toBe(true);
    expect(f.providers.get("pi", "purpose").provider.models.some(model => model.id === "new-asr")).toBe(false);
    expect(f.catalog.resolve(f.selection("codex", "discovered-speech"))).toBeDefined();
    const eleven = f.selection("pi", "eleven_flash_v2_5");
    const refreshEleven = (allowed: boolean) => f.providers.discoverProviderModels("pi", "purpose",
      vi.fn(async () => Response.json({ data: [{ model_id: eleven.modelId, can_do_text_to_speech: allowed }] })) as typeof fetch);
    await refreshEleven(true);
    const beforeWithdrawal = f.catalog.resolve(eleven);
    await refreshEleven(false);
    expect(beforeWithdrawal.assertCurrent).toThrow("connection_changed");
    expect(() => f.catalog.resolve(eleven)).toThrow("model_unavailable");
    const reopened = new ProviderCatalogManager({ store: f.store, credentials: f.credentials, nativeBackendId: "pi" }); reopened.initialize();
    const restored = new SpeechModelCatalog(f.store, createModelRouteCatalog(f.store, reopened));
    expect(() => restored.resolve(selected)).toThrow("model_unavailable");
    expect(restored.list().some(row => row.backendId === "pi" && row.modelId === "new-speech")).toBe(true);
  } finally { await f.close(); }
});

it("rejects legacy chat selections at preference, voice-list and playback entry points before HTTP and still sends admitted speech", async () => {
  const f = await fixture("https://speech-proxy.example/custom/v1");
  const artifacts = new ArtifactStore({ rootDirectory: join(f.root, "artifacts"), repository: new OperationalArtifactRepository(f.store), ingestRoots: [f.root] });
  await artifacts.initialize();
  const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE), host = new SessionHost(f.store, artifacts, [adapter]); await host.initialize();
  await f.add("pi");
  const connections = new ConnectionManager(f.store);
  const desktop = connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(), defaultDeviceName: "Desktop",
    platform: process.platform, appVersion: "0.1.0", desktopHostAuthKey: "h".repeat(43) });
  connections.confirmTrustedDesktopConnection(desktop.connection.id, desktop.authKey);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "audio/pcm" } }));
  const manager = new DesktopVoiceConversationManager({ store: f.store, host, models: f.catalog, infer: vi.fn(async () => "unused"),
    companion: () => ({ identity: "Companion", token: "original" }), fetch: fetcher });
  try {
    await host.registerTarget({ id: "purpose-workspace", backendId: adapter.id, displayName: "Workspace", workspaceRoot: f.root, trusted: true, managed: true });
    const model = PI_LIKE_PROFILE.models[0]!;
    const sessionId = (await host.createSession({ operationId: "create-purpose-task", connection: desktop.connection, targetId: "purpose-workspace", title: "Purpose task",
      providerId: model.providerId, modelId: model.modelId, permissionMode: "ask", planMode: false, fastMode: false })).value.sessionId;
    const base = { windowId: "purpose-window", sessionId, sessionGeneration: BigInt(f.store.getSession(sessionId).descriptor.binding.generation) };
    const authority = { connection: desktop.connection, assertCurrent: () => { connections.authenticate(`Bearer ${desktop.authKey}`); } };
    const control = (action: contract.DesktopVoiceConversationAction, input: MessageInitShape<typeof contract.ControlDesktopVoiceConversationRequestSchema>) =>
      manager.control(create(contract.ControlDesktopVoiceConversationRequestSchema, { ...base, action, ...input }), authority);
    const invalid = f.selection("pi", "ordinary-chat");
    f.store.setSetting("session", sessionId, "desktop.voice-conversation.v1", { conversation: invalid, sentencePlayback: true, revision: 1 });
    await expect(control(contract.DesktopVoiceConversationAction.SAVE_PREFERENCE, { operationId: "save-invalid", preference: { conversation: invalid, revision: 1n } })).rejects.toThrow("model_unavailable");
    await expect(control(contract.DesktopVoiceConversationAction.VOICES, { selection: invalid })).rejects.toThrow("model_unavailable");
    await expect(control(contract.DesktopVoiceConversationAction.START, { callId: "invalid-call", operationId: "start-invalid", selection: invalid, playbackOnly: true })).rejects.toThrow("model_unavailable");
    expect(f.store.findSetting("session", sessionId, "desktop.voice-conversation.v1")?.value).toMatchObject({ conversation: invalid, revision: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    const selection = f.selection("pi", "custom-speech");
    await control(contract.DesktopVoiceConversationAction.START, { callId: "valid-call", operationId: "start-valid", selection, playbackOnly: true });
    await control(contract.DesktopVoiceConversationAction.SPEAK, { callId: "valid-call", speechRequestId: "speech-valid", text: "Read the original text." });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://speech-proxy.example/custom/v1/audio/speech");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "custom-speech", input: "Read the original text.", voice: "alloy" });
    expect(f.store.listQueueItems({ sessionId })).toHaveLength(0);
  } finally { manager.close(); await host.dispose(); await f.close(); }
});
