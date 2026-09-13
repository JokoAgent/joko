import { create } from "@bufbuild/protobuf";
import {
  VoiceInputServiceSettingsPatchSchema,
  VoiceInputTranscriptionProtocol
} from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import type { AsrEvent } from "@joko/voice-input";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { VoiceInputSettingsController, VoiceInputSettingsError } from "./voice-input-settings.js";

async function fixture() {
  const now = 1_800_000_000_000;
  const root = await mkdtemp(join(tmpdir(), "joko-voice-settings-"));
  const credentialPath = join(root, "credential-records.json");
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({ vault, storagePath: credentialPath, now: () => now });
  await credentials.initialize();
  const store = new OperationalStore(join(root, "orchestrator.db"), { now: () => now });
  return { credentialPath, credentials, now, store };
}

function saucResponse(last: boolean): Buffer {
  const data = Buffer.from(JSON.stringify(last ? { result: { text: "ephemeral transcription words" } } : {}));
  const header = Buffer.from([0x11, last ? 0x92 : 0x90, 0x10, 0, 0, 0, 0, 0]);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe("VoiceInputSettingsController", () => {
  it("keeps old route authority on a partial credential failure and retires only unadopted generations", async () => {
    const { credentials, store, credentialPath } = await fixture();
    const sent: Array<{ endpoint: string; authorization: string | null }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ endpoint: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ text: "" }), { status: 200 });
    });
    const controller = new VoiceInputSettingsController({ store, credentials, fetch: fetch as typeof globalThis.fetch });
    const ticket = (secret: string, connectionId = "connection-a") => {
      const value = credentials.createUploadTicket({ kind: "api_key", connectionId });
      credentials.upload(value.credentialUploadTicketId, secret, connectionId);
      return value.credentialUploadTicketId;
    };
    const stored = () => store.getSetting<Record<string, unknown>>("service", "orchestrator", "settings.voice_input");
    try {
      await controller.apply(create(VoiceInputServiceSettingsPatchSchema, { enabled: true, endpoint: "https://old.example/transcribe",
        model: "model", credentialUploadTicketId: ticket("old-key") }), "connection-a");
      const original = stored();
      const oldReference = original.value["credentialReferenceId"] as string;
      const wrongOwner = ticket("backup-key", "connection-b");
      const update = { endpoint: "https://new.example/transcribe", credentialUploadTicketId: ticket("new-key"),
        fallbackEnabled: true, fallbackEndpoint: "https://backup.example/transcribe", fallbackModel: "backup-model",
        fallbackCredentialUploadTicketId: wrongOwner };
      await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, update), "connection-a")).rejects.toThrow("does not authorize");
      expect(stored()).toEqual(original);
      expect(credentials.resolve(oldReference)).toBe("old-key");
      expect(await controller.testConnection()).toEqual({ ok: true });
      expect(sent).toEqual([{ endpoint: "https://old.example/transcribe", authorization: "Bearer old-key" }]);
      expect(credentials.list()).toEqual([]);
      expect(JSON.parse(await readFile(credentialPath, "utf8")).records).toHaveLength(1);

      const setSetting = store.setSetting.bind(store);
      const failure = vi.spyOn(store, "setSetting").mockImplementation((scopeType, scopeId, key, value, updatedAt) => {
        if (key === "settings.voice_input") throw new Error("Injected configuration write failure");
        return setSetting(scopeType, scopeId, key, value, updatedAt);
      });
      await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
        endpoint: update.endpoint, credentialUploadTicketId: ticket("write-failure-key")
      }), "connection-a")).rejects.toThrow("configuration write failure");
      failure.mockRestore();
      expect(stored()).toEqual(original);
      expect(credentials.resolve(oldReference)).toBe("old-key");
      expect(JSON.parse(await readFile(credentialPath, "utf8")).records).toHaveLength(1);

      const retire = vi.spyOn(credentials, "retireManagedCredential").mockRejectedValueOnce(new Error("private secret failure payload"));
      const saved = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
        endpoint: update.endpoint, credentialUploadTicketId: ticket("adopted-key")
      }), "connection-a");
      retire.mockRestore();
      expect(saved.endpoint).toBe(update.endpoint);
      const newReference = stored().value["credentialReferenceId"] as string;
      expect(newReference).not.toBe(oldReference);
      expect(credentials.resolve(newReference)).toBe("adopted-key");
      expect(store.listDiagnostics()).toMatchObject([{ code: "CREDENTIAL_RETIREMENT_FAILED" }]);
      expect(JSON.stringify(store.listDiagnostics().map(({ message, details }) => ({ message, details })))).not.toContain("private secret");
      const reopenedVault = await CredentialVault.open(join(credentialPath, "..", "vault.key"));
      const reopenedCredentials = new CredentialManager({ vault: reopenedVault, storagePath: credentialPath });
      await reopenedCredentials.initialize();
      const reopened = new VoiceInputSettingsController({ store, credentials: reopenedCredentials });
      await reopened.apply(create(VoiceInputServiceSettingsPatchSchema, { enabled: true }), "connection-a");
      expect(reopenedCredentials.list()).toEqual([]);
      expect(reopenedCredentials.find(oldReference)).toBeUndefined();
      expect(reopenedCredentials.resolve(newReference)).toBe("adopted-key");
      expect(reopened.snapshot().credentialConfigured).toBe(true);
    } finally { store.close(); }
  });

  it.each(["primary", "backup"].flatMap((position) => [
    { position, name: "Scribe", protocol: VoiceInputTranscriptionProtocol.ELEVENLABS_SCRIBE_REALTIME, model: "scribe_v2_realtime", resourceId: "", path: "/realtime" },
    { position, name: "SAUC", protocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC, model: "", resourceId: "volc.seedasr.sauc.duration", path: "/api/v3/sauc/bigmodel_async" }
  ]))("constructs the $name $position route from its own credential without persisting audio", async ({ position, name, protocol, model, resourceId, path }) => {
    const { credentialPath, credentials, store } = await fixture();
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No socket address.");
    const endpoint = `ws://127.0.0.1:${address.port}${path}`;
    const headers: Array<string | string[] | undefined> = [];
    server.on("connection", (socket, request) => {
      headers.push(request.headers[name === "Scribe" ? "xi-api-key" : "x-api-key"]);
      if (name === "Scribe") socket.send(JSON.stringify({ message_type: "session_started", config: { model_id: "scribe_v2_realtime", audio_format: "pcm_16000", sample_rate: 16_000 } }));
      else expect(request.headers["x-api-resource-id"]).toBe(resourceId);
      socket.on("message", (raw) => {
        if (name === "Scribe") {
          if (JSON.parse(raw.toString()).commit === true) socket.send(JSON.stringify({ message_type: "committed_transcript", text: "ephemeral transcription words" }));
        } else {
          const packet = Buffer.from(raw as Buffer);
          if ((packet[1]! >> 4) === 1) socket.send(saucResponse(false));
          else if ((packet[1]! & 3) === 3) socket.send(saucResponse(true));
        }
      });
    });
    const controller = new VoiceInputSettingsController({ store, credentials });
    const secret = `test-transcription-${name}-${position}-credential`;
    const ticket = credentials.createUploadTicket({ kind: "api_key", connectionId: "connection-a" });
    credentials.upload(ticket.credentialUploadTicketId, secret, "connection-a");
    let provider: ReturnType<typeof controller.create> | undefined;
    try {
      const route = { endpoint, model, resourceId, protocol };
      await controller.apply(create(VoiceInputServiceSettingsPatchSchema, position === "primary" ? {
        enabled: true, ...route, credentialUploadTicketId: ticket.credentialUploadTicketId
      } : {
        enabled: true, protocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME,
        endpoint: "ws://127.0.0.1:1/realtime", model: "unavailable", keyless: true,
        fallbackEnabled: true, fallbackProtocol: route.protocol, fallbackEndpoint: endpoint, fallbackModel: route.model,
        fallbackResourceId: resourceId,
        fallbackCredentialUploadTicketId: ticket.credentialUploadTicketId
      }), "connection-a");
      expect(controller.describe()).toMatchObject({ support: "supported", supportsLiveDrafts: true, mimeTypes: ["audio/pcm"] });
      expect(controller.describe().supportsLocale).toBe(name !== "SAUC");
      // Keyless cannot park an old credential under a new authority for later reuse.
      await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, position === "primary" ? {
        endpoint: "wss://different.example/realtime", keyless: true
      } : {
        fallbackEndpoint: "wss://different.example/realtime", fallbackKeyless: true
      }), "connection-a")).rejects.toMatchObject({ code: "invalid" });
      if (position === "primary") {
        expect(await controller.testConnection()).toEqual({ ok: true });
        await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
          protocol: VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME
        }), "connection-a")).rejects.toMatchObject({ code: "invalid" });
      }
      provider = controller.create({ mimeType: "audio/pcm" });
      const events: AsrEvent[] = [];
      provider.onEvent((event) => events.push(event));
      await provider.start({ runId: "scribe-run", mimeType: "audio/pcm" });
      provider.appendAudio({ data: new Uint8Array(3_200).buffer, durationMs: 100, voiced: true });
      await provider.flushAudio();
      expect(events.at(-1)).toEqual({ type: "stable", text: "ephemeral transcription words" });
      expect(headers.every((header) => header === secret)).toBe(true);
      const durable = JSON.stringify(store.listSettings().map((record) => record.value));
      expect(durable).not.toContain(secret);
      expect(durable).not.toContain("ephemeral transcription words");
      expect(await readFile(credentialPath, "utf8")).not.toContain(secret);
    } finally {
      await provider?.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });

  it("requires the current resource field shape and rejects model or keyless aliases for SAUC", async () => {
    const { credentials, store } = await fixture();
    try {
      const controller = new VoiceInputSettingsController({ store, credentials });
      const route = { protocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC,
        endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async", model: "", resourceId: "volc.seedasr.sauc.duration", keyless: false };
      for (const patch of [{ ...route, keyless: true }, { ...route, model: route.resourceId, resourceId: "" }, { ...route, resourceId: "unsupported" }]) {
        await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, patch), "connection-a")).rejects.toMatchObject({ code: "invalid" });
      }
      await controller.apply(create(VoiceInputServiceSettingsPatchSchema, route), "connection-a");
      expect(controller.snapshot()).toMatchObject({ model: "", resourceId: route.resourceId });
      const current = store.findSetting<Record<string, unknown>>("service", "orchestrator", "settings.voice_input")!;
      for (const field of ["fallbackProtocol", "refinerModel", "refinerFallbackModel", "credentialReferenceId", "fallbackCredentialReferenceId"]) {
        const incomplete = { ...current.value }; delete incomplete[field];
        store.setSetting("service", "orchestrator", "settings.voice_input", incomplete, 1_800_000_000_000);
        expect(() => new VoiceInputSettingsController({ store, credentials })).toThrow(VoiceInputSettingsError);
      }
    } finally { store.close(); }
  });

  it("commits a connection-bound credential and constructs a content-safe transcription provider", async () => {
    const { credentialPath, credentials, store } = await fixture();
    const secret = "voice-provider-secret-value";
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
      return new Response(JSON.stringify({ text: "spoken words" }), { status: 200 });
    });
    const controller = new VoiceInputSettingsController({ store, credentials, fetch: fetch as typeof globalThis.fetch });
    const initial = controller.snapshot();

    expect(initial).toMatchObject({ enabled: false, credentialConfigured: false });
    expect(controller.describe().support).toBe("disabled_by_policy");
    await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      expectedRevision: initial.version?.revision
    }), "connection-a")).rejects.toMatchObject({ code: "credential_unavailable" });

    const ticket = credentials.createUploadTicket({ kind: "api_key", connectionId: "connection-a" });
    credentials.upload(ticket.credentialUploadTicketId, secret, "connection-a");
    const saved = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      protocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH,
      endpoint: "https://speech.example/v1/audio/transcriptions",
      model: "voice-model",
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      expectedRevision: initial.version?.revision
    }), "connection-a");

    expect(saved).toMatchObject({ enabled: true, model: "voice-model", credentialConfigured: true });
    expect(controller.describe()).toMatchObject({ support: "supported", supportsLiveDrafts: false, supportsRefinement: false });
    const provider = controller.create({ mimeType: "audio/webm", locale: "en-US" });
    const events: AsrEvent[] = [];
    provider.onEvent((event) => events.push(event));
    await provider.start({ runId: "voice-run", mimeType: "audio/webm", locale: "en-US" });
    provider.appendAudio({ data: Uint8Array.of(1, 2, 3).buffer, durationMs: 250, voiced: true });
    await provider.flushAudio();
    await provider.stop();

    expect(fetch).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "stable" && event.text === "spoken words")).toBe(true);
    expect(JSON.stringify(store.listSettings().map((record) => record.value))).not.toContain(secret);
    expect(await readFile(credentialPath, "utf8")).not.toContain(secret);
    store.close();
  });

  it("rejects stale revisions and unsafe routes without consuming configuration", async () => {
    const { credentials, store } = await fixture();
    const controller = new VoiceInputSettingsController({ store, credentials });
    const initial = controller.snapshot();
    const saved = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      keyless: true,
      endpoint: "http://127.0.0.1:9000/transcribe",
      expectedRevision: initial.version?.revision
    }), "connection-a");

    await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      expectedRevision: initial.version?.revision
    }), "connection-a")).rejects.toEqual(expect.objectContaining<Partial<VoiceInputSettingsError>>({ code: "conflict" }));
    await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      endpoint: "http://speech.example/transcribe",
      expectedRevision: saved.version?.revision
    }), "connection-a")).rejects.toMatchObject({ code: "invalid" });
    expect(controller.snapshot()).toMatchObject({ enabled: false, endpoint: "http://127.0.0.1:9000/transcribe" });
    store.close();
  });

  it("resolves transcript refinement through one exact authenticated Provider route", async () => {
    const { credentials, store } = await fixture();
    const resolveInferenceRoute = vi.fn((backendId: string, providerId: string, modelId: string) => backendId === "backend-one" && providerId === "provider-one" && modelId === "model-one"
      ? {
          backendId,
          providerId,
          generationId: "generation-one",
          modelId,
          api: "openai-responses" as const,
          baseUrl: "https://text.example/v1",
          authorization: "Bearer provider-secret",
          headers: { "x-route": "voice-refinement" },
          supportsImages: false
        }
      : undefined);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://text.example/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ text: "Please inspect src/app.ts." })
      }), { status: 200 });
    });
    const controller = new VoiceInputSettingsController({
      store,
      credentials,
      providers: { resolveInferenceRoute },
      fetch: fetch as typeof globalThis.fetch
    });
    const initial = controller.snapshot();
    expect(initial.refinerModel).toBeUndefined();
    expect(initial.refinerFallbackModel).toBeUndefined();
    for (const refinerModel of [{ backendId: "backend-one" }, { providerId: "provider-one", modelId: "model-one" }]) {
      await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, { refinerModel }), "connection-a"))
        .rejects.toMatchObject({ code: "invalid" });
    }
    const saved = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      keyless: true,
      refinementEnabled: true,
      refinerModel: { backendId: "backend-one", providerId: "provider-one", modelId: "model-one" },
      expectedRevision: initial.version?.revision
    }), "connection-a");

    expect(saved).toMatchObject({
      refinementEnabled: true,
      refinerModel: { backendId: "backend-one", providerId: "provider-one", modelId: "model-one" }
    });
    expect(controller.describe()).toMatchObject({ support: "supported", supportsRefinement: true });
    const result = await controller.createRefiner({ dictionaryTerms: [] })?.refine({
      runId: "voice-run",
      text: "please inspect src/app.ts",
      locale: "en-US",
      signal: new AbortController().signal,
      onPreview: () => undefined
    });

    expect(resolveInferenceRoute).toHaveBeenCalledWith("backend-one", "provider-one", "model-one");
    expect(result).toEqual({
      accepted: true,
      basedOnText: "please inspect src/app.ts",
      refinedText: "Please inspect src/app.ts."
    });
    expect(JSON.stringify(store.listSettings().map((record) => record.value))).not.toContain("provider-secret");
    await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      refinerFallbackModel: { backendId: "backend-one", providerId: "provider-one", modelId: "model-one" }
    }), "connection-a")).rejects.toMatchObject({ code: "invalid" });
    await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      refinerModel: { backendId: "backend-other", providerId: "provider-one", modelId: "model-one" }
    }), "connection-a")).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(controller.snapshot().refinerModel).toMatchObject({ backendId: "backend-one" });
    await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      refinementEnabled: false,
      refinerModel: { backendId: "backend-other", providerId: "provider-one", modelId: "model-one" }
    }), "connection-a");
    const retained = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {}), "connection-a");
    expect(retained.refinerModel).toMatchObject({ backendId: "backend-other", providerId: "provider-one", modelId: "model-one" });
    await expect(controller.apply(create(VoiceInputServiceSettingsPatchSchema, { refinementEnabled: true }), "connection-a"))
      .rejects.toMatchObject({ code: "credential_unavailable" });
    expect(fetch).toHaveBeenCalledOnce();
    const cleared = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, { refinerModel: {}, refinerFallbackModel: {} }), "connection-a");
    expect(cleared.refinerModel).toBeUndefined();
    expect(cleared.refinerFallbackModel).toBeUndefined();
    expect(store.getSetting<Record<string, unknown>>("service", "orchestrator", "settings.voice_input").value)
      .toMatchObject({ refinerModel: null, refinerFallbackModel: null });
    store.close();
  });

  it("coalesces bounded connection probes and reports content-free failure categories", async () => {
    const { credentials, store } = await fixture();
    let resolveProbe!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveProbe = resolve; });
    const fetch = vi.fn(async () => pending);
    const controller = new VoiceInputSettingsController({
      store,
      credentials,
      fetch: fetch as typeof globalThis.fetch
    });
    const initial = controller.snapshot();
    await expect(controller.testConnection()).resolves.toEqual({ ok: false, reason: "credentialsMissing" });
    await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      keyless: true,
      endpoint: "https://speech.example/v1/audio/transcriptions",
      expectedRevision: initial.version?.revision
    }), "connection-a");

    const first = controller.testConnection();
    const second = controller.testConnection();
    expect(fetch).toHaveBeenCalledOnce();
    resolveProbe(new Response(JSON.stringify({ text: "" }), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(JSON.stringify(store.listSettings().map((record) => record.value))).not.toMatch(/authorization|private-key/iu);
    store.close();
  });

  it("uses one exact backup refinement route after a primary transport failure", async () => {
    const { credentials, store } = await fixture();
    const resolveInferenceRoute = vi.fn((backendId: string, providerId: string, modelId: string) => ({
      backendId,
      providerId,
      generationId: `generation-${backendId}`,
      modelId,
      api: "openai-responses" as const,
      baseUrl: `https://${backendId}.example/v1`,
      authorization: `Bearer ${backendId}-credential`,
      headers: {},
      supportsImages: false
    }));
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const backendId = new URL(String(url)).hostname.split(".")[0];
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${backendId}-credential`);
      return String(url).includes("primary.example")
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify({
          output_text: JSON.stringify({ text: "Use the backup route." })
        }), { status: 200 });
    });
    const controller = new VoiceInputSettingsController({
      store,
      credentials,
      providers: { resolveInferenceRoute },
      fetch: fetch as typeof globalThis.fetch
    });
    const initial = controller.snapshot();
    await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      keyless: true,
      refinementEnabled: true,
      refinerModel: { backendId: "primary", providerId: "shared-provider", modelId: "shared-model" },
      refinerFallbackModel: { backendId: "backup", providerId: "shared-provider", modelId: "shared-model" },
      expectedRevision: initial.version?.revision
    }), "connection-a");

    const result = await controller.createRefiner({ dictionaryTerms: [] })?.refine({
      runId: "voice-run",
      text: "use the backup route",
      signal: new AbortController().signal,
      onPreview: () => undefined
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(resolveInferenceRoute).toHaveBeenCalledWith("primary", "shared-provider", "shared-model");
    expect(resolveInferenceRoute).toHaveBeenCalledWith("backup", "shared-provider", "shared-model");
    expect(result).toEqual({
      accepted: true,
      basedOnText: "use the backup route",
      refinedText: "Use the backup route."
    });
    store.close();
  });

  it.each([
    { primaryOutput: "malformed model output", expectedRequests: 2, expectedTerms: ["VoiceKit"] },
    { primaryOutput: JSON.stringify({ actions: [] }), expectedRequests: 1, expectedTerms: [] }
  ])("retries malformed dictionary output while accepting an empty advice result: $expectedRequests request(s)", async ({ primaryOutput, expectedRequests, expectedTerms }) => {
    const { credentials, store } = await fixture();
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({
      output_text: String(url).includes("primary.example") ? primaryOutput : JSON.stringify({ actions: [{
        action: "add_candidate",
        term: "VoiceKit",
        aliases: ["voice kit"],
        type: "product_name",
        confidence: "medium"
      }] })
    }), { status: 200 }));
    const controller = new VoiceInputSettingsController({
      store,
      credentials,
      providers: { resolveInferenceRoute: (backendId, providerId, modelId) => ({
        backendId,
        providerId,
        generationId: `generation-${providerId}`,
        modelId,
        api: "openai-responses",
        baseUrl: `https://${providerId}.example/v1`,
        authorization: `Bearer ${providerId}-credential`,
        headers: {},
        supportsImages: false
      }) },
      fetch: fetch as typeof globalThis.fetch
    });
    await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      refinementEnabled: true,
      refinerModel: { backendId: "backend-one", providerId: "primary", modelId: "primary-model" },
      refinerFallbackModel: { backendId: "backend-one", providerId: "secondary", modelId: "secondary-model" },
      expectedRevision: controller.snapshot().version?.revision
    }), "connection-a");

    try {
      const result = await controller.adviseDictionaryEdit({
        beforeText: "Use voice kit in this project.",
        afterText: "Use VoiceKit in this project."
      }, new AbortController().signal);
      expect(result.actions.map((action) => action.term)).toEqual(expectedTerms);
      expect(fetch).toHaveBeenCalledTimes(expectedRequests);
      expect(fetch.mock.calls.map(([url]) => new URL(String(url)).host))
        .toEqual(expectedRequests === 1 ? ["primary.example"] : ["primary.example", "secondary.example"]);
    } finally {
      store.close();
    }
  });

  it("advises grounded dictionary learning without persisting edit evidence", async () => {
    const { credentials, store } = await fixture();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ actions: [{
        action: "add_entry",
        term: "VoiceKit",
        aliases: ["voice kit"],
        type: "product_name",
        confidence: "high"
      }] })
    }), { status: 200 }));
    const controller = new VoiceInputSettingsController({
      store,
      credentials,
      providers: { resolveInferenceRoute: (backendId, providerId, modelId) => ({
        backendId,
        providerId,
        generationId: "generation-one",
        modelId,
        api: "openai-responses",
        baseUrl: "https://text.example/v1",
        authorization: "Bearer provider-secret",
        headers: {},
        supportsImages: false
      }) },
      fetch: fetch as typeof globalThis.fetch
    });
    const initial = controller.snapshot();
    await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      refinementEnabled: true,
      refinerModel: { backendId: "backend-one", providerId: "provider-one", modelId: "model-one" },
      expectedRevision: initial.version?.revision
    }), "connection-a");

    await expect(controller.adviseDictionaryEdit({
      beforeText: "Use voice kit in this project.",
      afterText: "Use VoiceKit in this project.",
      existingEntries: [],
      existingCandidates: []
    }, new AbortController().signal)).resolves.toEqual({ actions: [{
      action: "add_entry",
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "product_name",
      confidence: "high"
    }] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.listSettings().map((record) => record.value))).not.toMatch(/voice kit|VoiceKit/iu);
    store.close();
  });

  it("falls back from a realtime handshake failure to batch PCM without exposing either route credential", async () => {
    const { credentials, store } = await fixture();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "backup transcript" }), { status: 200 }));
    const controller = new VoiceInputSettingsController({
      store,
      credentials,
      fetch: fetch as typeof globalThis.fetch
    });
    const initial = controller.snapshot();
    const saved = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      protocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME,
      endpoint: "ws://127.0.0.1:1/v1/realtime?intent=transcription",
      model: "realtime-model",
      keyless: true,
      fallbackEnabled: true,
      fallbackProtocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH,
      fallbackEndpoint: "https://speech.example/v1/audio/transcriptions",
      fallbackModel: "batch-model",
      fallbackKeyless: true,
      expectedRevision: initial.version?.revision
    }), "connection-a");

    expect(saved).toMatchObject({
      protocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME,
      fallbackEnabled: true,
      fallbackProtocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH
    });
    expect(controller.describe()).toMatchObject({
      support: "supported",
      supportsLiveDrafts: true,
      mimeTypes: expect.arrayContaining(["audio/pcm", "audio/webm"])
    });
    const provider = controller.create({ mimeType: "audio/pcm", locale: "en" });
    const events: AsrEvent[] = [];
    provider.onEvent((event) => events.push(event));
    await provider.start({ runId: "fallback-run", mimeType: "audio/pcm", locale: "en" });
    provider.appendAudio({ data: new Uint8Array(3_200).buffer, durationMs: 100, voiced: true });
    await provider.flushAudio();
    await provider.stop();

    expect(fetch).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "stable", text: "backup transcript" });
    store.close();
  });
});
