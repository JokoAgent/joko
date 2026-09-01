import { create } from "@bufbuild/protobuf";
import {
  VoiceInputServiceSettingsPatchSchema,
  VoiceInputTranscriptionProtocol
} from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import type { AsrEvent } from "@joko/voice-input";
import { readFile } from "node:fs/promises";
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

describe("VoiceInputSettingsController", () => {
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
    const resolveInferenceRoute = vi.fn((providerId: string, modelId: string) => providerId === "provider-one" && modelId === "model-one"
      ? {
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
    const saved = await controller.apply(create(VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      keyless: true,
      refinementEnabled: true,
      refinerProviderId: "provider-one",
      refinerModelId: "model-one",
      expectedRevision: initial.version?.revision
    }), "connection-a");

    expect(saved).toMatchObject({
      refinementEnabled: true,
      refinerProviderId: "provider-one",
      refinerModelId: "model-one"
    });
    expect(controller.describe()).toMatchObject({ support: "supported", supportsRefinement: true });
    const result = await controller.createRefiner({ dictionaryTerms: [] })?.refine({
      runId: "voice-run",
      text: "please inspect src/app.ts",
      locale: "en-US",
      signal: new AbortController().signal,
      onPreview: () => undefined
    });

    expect(resolveInferenceRoute).toHaveBeenCalledWith("provider-one", "model-one");
    expect(result).toEqual({
      accepted: true,
      basedOnText: "please inspect src/app.ts",
      refinedText: "Please inspect src/app.ts."
    });
    expect(JSON.stringify(store.listSettings().map((record) => record.value))).not.toContain("provider-secret");
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
    const resolveInferenceRoute = vi.fn((providerId: string, modelId: string) => ({
      providerId,
      generationId: `generation-${providerId}`,
      modelId,
      api: "openai-responses" as const,
      baseUrl: `https://${providerId}.example/v1`,
      authorization: `Bearer ${providerId}-credential`,
      headers: {},
      supportsImages: false
    }));
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("primary.example")
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify({
          output_text: JSON.stringify({ text: "Use the backup route." })
        }), { status: 200 }));
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
      refinerProviderId: "primary",
      refinerModelId: "primary-model",
      refinerFallbackProviderId: "backup",
      refinerFallbackModelId: "backup-model",
      expectedRevision: initial.version?.revision
    }), "connection-a");

    const result = await controller.createRefiner({ dictionaryTerms: [] })?.refine({
      runId: "voice-run",
      text: "use the backup route",
      signal: new AbortController().signal,
      onPreview: () => undefined
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      accepted: true,
      basedOnText: "use the backup route",
      refinedText: "Use the backup route."
    });
    store.close();
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
      providers: { resolveInferenceRoute: (providerId, modelId) => ({
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
      refinerProviderId: "provider-one",
      refinerModelId: "model-one",
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
