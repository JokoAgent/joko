import { create } from "@bufbuild/protobuf";
import {
  FallbackDictationRefiner,
  ManagedDictationDictionaryAdvisor,
  ManagedDictationRefiner,
  type DictationDictionaryAdviceInput,
  type DictationDictionaryAdviceResult
} from "@joko/adapter-dictation-refinement";
import {
  OPENAI_TRANSCRIPTION_MIME_TYPES,
  OpenAiTranscriptionProvider,
  probeOpenAiTranscriptionRoute,
  type OpenAiTranscriptionProbeResult,
  validateOpenAiTranscriptionRoute
} from "@joko/adapter-transcription-openai";
import {
  RealtimeTranscriptionProvider,
  probeRealtimeTranscriptionRoute,
  validateRealtimeTranscriptionRoute,
  type RealtimeTranscriptionProtocol
} from "@joko/adapter-transcription-realtime";
import {
  VoiceInputServiceSettingsSchema,
  VoiceInputTranscriptionProtocol,
  type VoiceInputServiceSettings,
  type VoiceInputServiceSettingsPatch
} from "@joko/contracts";
import type { OperationalStore, SettingRecord } from "@joko/store";
import {
  FallbackAsrProvider,
  type AsrProvider,
  type SupportedAudioMimeType,
  type VoiceRefiner
} from "@joko/voice-input";

import type { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { requestManagedTextInference } from "./personalization-inference.js";
import { fromProtoRevision, toProtoEntityVersion } from "./proto-mapper.js";
import type {
  VoiceInputProviderCapability,
  VoiceInputProviderFactory
} from "./voice-input-coordinator.js";

const SCOPE_TYPE = "service" as const;
const SCOPE_ID = "orchestrator";
const SETTING_KEY = "settings.voice_input";
const CREDENTIAL_REFERENCE_ID = "cred_voice_input_transcription";
const FALLBACK_CREDENTIAL_REFERENCE_ID = "cred_voice_input_transcription_fallback";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";

type StoredTranscriptionProtocol = "openaiCompatibleBatch" | "openaiCompatibleRealtime" | "qwenCompatibleRealtime";

interface StoredVoiceInputSettings {
  readonly format: 1;
  readonly enabled: boolean;
  readonly protocol: StoredTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly keyless: boolean;
  readonly refinementEnabled: boolean;
  readonly refinerProviderId: string;
  readonly refinerModelId: string;
  readonly refinerFallbackProviderId: string;
  readonly refinerFallbackModelId: string;
  readonly fallbackEnabled: boolean;
  readonly fallbackProtocol: StoredTranscriptionProtocol;
  readonly fallbackEndpoint: string;
  readonly fallbackModel: string;
  readonly fallbackKeyless: boolean;
}

interface TranscriptionRoute {
  readonly protocol: StoredTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly keyless: boolean;
  readonly credentialReferenceId: string;
}

export class VoiceInputSettingsError extends Error {
  readonly code: "invalid" | "conflict" | "credential_unavailable";

  constructor(code: VoiceInputSettingsError["code"], message: string) {
    super(message);
    this.name = "VoiceInputSettingsError";
    this.code = code;
  }
}

export interface VoiceInputSettingsControllerOptions {
  readonly store: OperationalStore;
  readonly credentials: CredentialManager;
  readonly providers?: Pick<ProviderCatalogManager, "resolveInferenceRoute">;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

export type VoiceInputConnectionTestResult = OpenAiTranscriptionProbeResult
  | { readonly ok: false; readonly reason: "credentialsMissing" };

/**
 * Owns the durable, non-secret transcription selection and resolves its
 * encrypted credential only while constructing an ephemeral ASR transport.
 */
export class VoiceInputSettingsController implements VoiceInputProviderFactory {
  readonly #store: OperationalStore;
  readonly #credentials: CredentialManager;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #providers: VoiceInputSettingsControllerOptions["providers"];
  #tail: Promise<void> = Promise.resolve();
  #activeConnectionTest?: { readonly revision: bigint; readonly promise: Promise<VoiceInputConnectionTestResult> };

  constructor(options: VoiceInputSettingsControllerOptions) {
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch;
    this.#providers = options.providers;
    const stored = this.#store.findSetting<unknown>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY);
    if (stored === undefined) {
      this.#store.setSetting<StoredVoiceInputSettings>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY, defaultSettings(), this.#now());
    } else {
      decodeSettings(stored.value);
    }
  }

  snapshot(): VoiceInputServiceSettings {
    const record = this.#record();
    const settings = record.value;
    return create(VoiceInputServiceSettingsSchema, {
      enabled: settings.enabled,
      protocol: toProtoProtocol(settings.protocol),
      endpoint: settings.endpoint,
      model: settings.model,
      keyless: settings.keyless,
      credentialConfigured: this.#credentialConfigured(),
      version: toProtoEntityVersion(record.revision, 0, record.updatedAt),
      refinementEnabled: settings.refinementEnabled,
      refinerProviderId: settings.refinerProviderId,
      refinerModelId: settings.refinerModelId,
      refinerFallbackProviderId: settings.refinerFallbackProviderId,
      refinerFallbackModelId: settings.refinerFallbackModelId,
      fallbackEnabled: settings.fallbackEnabled,
      fallbackProtocol: toProtoProtocol(settings.fallbackProtocol),
      fallbackEndpoint: settings.fallbackEndpoint,
      fallbackModel: settings.fallbackModel,
      fallbackKeyless: settings.fallbackKeyless,
      fallbackCredentialConfigured: this.#fallbackCredentialConfigured()
    });
  }

  describe(): VoiceInputProviderCapability {
    const settings = this.#settings();
    if (!settings.enabled) return unsupported("disabled_by_policy");
    const routes = this.#availableRoutes(settings);
    if (routes.length === 0) return unsupported("temporarily_unavailable");
    const mimeTypes = [...new Set(routes.flatMap((route) => routeMimeTypes(route.protocol)))];
    return {
      support: "supported",
      mimeTypes,
      supportsLocale: true,
      supportsLiveDrafts: routes.some((route) => route.protocol !== "openaiCompatibleBatch"),
      supportsRefinement: this.#refinementAvailable(settings)
    };
  }

  create(input: { readonly mimeType: SupportedAudioMimeType; readonly locale?: string }): AsrProvider {
    const settings = this.#settings();
    const capability = this.describe();
    if (capability.support !== "supported") throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable.");
    const routes = this.#availableRoutes(settings)
      .filter((route) => routeMimeTypes(route.protocol).includes(input.mimeType));
    if (routes.length === 0) {
      throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable.");
    }
    const factories = routes.map((route) => () => this.#createRouteProvider(route, input));
    return factories.length === 1 ? factories[0]!() : new FallbackAsrProvider(factories);
  }

  createRefiner(input: {
    readonly refinementInstructions?: string;
    readonly dictionaryTerms: readonly string[];
  }): VoiceRefiner | undefined {
    const settings = this.#settings();
    if (!settings.refinementEnabled) return undefined;
    const routes = [
      [settings.refinerProviderId, settings.refinerModelId],
      [settings.refinerFallbackProviderId, settings.refinerFallbackModelId]
    ] as const;
    const refiners = routes.flatMap(([providerId, modelId]) => {
      if (providerId === "" || modelId === "") return [];
      let route: ReturnType<NonNullable<VoiceInputSettingsControllerOptions["providers"]>["resolveInferenceRoute"]>;
      try { route = this.#providers?.resolveInferenceRoute(providerId, modelId); }
      catch { return []; }
      if (route === undefined) return [];
      return [new ManagedDictationRefiner({
        ...(input.refinementInstructions === undefined ? {} : { instructions: input.refinementInstructions }),
        dictionaryTerms: input.dictionaryTerms,
        request: ({ system, user, maxTokens, signal }) => requestManagedTextInference({
          route,
          system,
          user,
          maxTokens,
          signal,
          timeoutMs: 30_000,
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
        })
      })];
    });
    if (refiners.length === 0) return undefined;
    return refiners.length === 1 ? refiners[0] : new FallbackDictationRefiner(refiners);
  }

  /**
   * Evaluates one post-dictation edit through the configured refinement route.
   * The evidence and response remain request-scoped and never enter Store.
   */
  async adviseDictionaryEdit(
    input: DictationDictionaryAdviceInput,
    signal: AbortSignal
  ): Promise<DictationDictionaryAdviceResult> {
    const settings = this.#settings();
    if (!settings.refinementEnabled || signal.aborted) return { actions: [] };
    const routes = [
      [settings.refinerProviderId, settings.refinerModelId],
      [settings.refinerFallbackProviderId, settings.refinerFallbackModelId]
    ] as const;
    for (const [providerId, modelId] of routes) {
      if (providerId === "" || modelId === "") continue;
      let route: ReturnType<NonNullable<VoiceInputSettingsControllerOptions["providers"]>["resolveInferenceRoute"]>;
      try { route = this.#providers?.resolveInferenceRoute(providerId, modelId); }
      catch { continue; }
      if (route === undefined) continue;
      const advisor = new ManagedDictationDictionaryAdvisor({
        request: ({ system, user, maxTokens, signal: requestSignal }) => requestManagedTextInference({
          route,
          system,
          user,
          maxTokens,
          signal: requestSignal,
          timeoutMs: 30_000,
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
        })
      });
      try { return await advisor.advise(input, signal); }
      catch (error) {
        if (signal.aborted) throw error;
      }
    }
    return { actions: [] };
  }

  testConnection(): Promise<VoiceInputConnectionTestResult> {
    const record = this.#record();
    const active = this.#activeConnectionTest;
    if (active !== undefined) {
      return active.revision === record.revision
        ? active.promise
        : Promise.resolve({ ok: false, reason: "serviceError" });
    }
    const settings = record.value;
    let apiKey: string | undefined;
    if (!settings.keyless) {
      try { apiKey = this.#credentials.resolve(CREDENTIAL_REFERENCE_ID); }
      catch { return Promise.resolve({ ok: false, reason: "credentialsMissing" }); }
    }
    const promise: Promise<VoiceInputConnectionTestResult> = settings.protocol === "openaiCompatibleBatch"
      ? probeOpenAiTranscriptionRoute({
          endpoint: settings.endpoint,
          model: settings.model,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
        })
      : probeRealtimeTranscriptionRoute({
          protocol: realtimeProtocol(settings.protocol),
          endpoint: settings.endpoint,
          model: settings.model,
          ...(apiKey === undefined ? {} : { apiKey })
        });
    this.#activeConnectionTest = { revision: record.revision, promise };
    const clear = (): void => {
      if (this.#activeConnectionTest?.promise === promise) this.#activeConnectionTest = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  apply(patch: VoiceInputServiceSettingsPatch, connectionId: string): Promise<VoiceInputServiceSettings> {
    const task = this.#tail.then(() => this.#apply(patch, connectionId));
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async #apply(patch: VoiceInputServiceSettingsPatch, connectionId: string): Promise<VoiceInputServiceSettings> {
    if (patch === null || typeof patch !== "object") throw invalid("Voice input settings patch is required.");
    const record = this.#record();
    if (patch.expectedRevision !== undefined) {
      let expected: bigint;
      try { expected = fromProtoRevision(patch.expectedRevision, "voice_input.expected_revision"); }
      catch { throw invalid("Voice input settings revision is invalid."); }
      if (expected !== record.revision) throw new VoiceInputSettingsError("conflict", "Voice input settings changed before this update.");
    }
    if (patch.credentialUploadTicketId !== undefined && patch.clearCredential === true) {
      throw invalid("Voice input credential cannot be replaced and cleared together.");
    }
    if (patch.fallbackCredentialUploadTicketId !== undefined && patch.clearFallbackCredential === true) {
      throw invalid("Voice input fallback credential cannot be replaced and cleared together.");
    }

    const current = record.value;
    const next = validateSettings({
      format: 1,
      enabled: patch.enabled ?? current.enabled,
      protocol: patch.protocol === undefined ? current.protocol : fromProtoProtocol(patch.protocol),
      endpoint: patch.endpoint ?? current.endpoint,
      model: patch.model ?? current.model,
      keyless: patch.keyless ?? current.keyless,
      refinementEnabled: patch.refinementEnabled ?? current.refinementEnabled,
      refinerProviderId: patch.refinerProviderId ?? current.refinerProviderId,
      refinerModelId: patch.refinerModelId ?? current.refinerModelId,
      refinerFallbackProviderId: patch.refinerFallbackProviderId ?? current.refinerFallbackProviderId,
      refinerFallbackModelId: patch.refinerFallbackModelId ?? current.refinerFallbackModelId,
      fallbackEnabled: patch.fallbackEnabled ?? current.fallbackEnabled,
      fallbackProtocol: patch.fallbackProtocol === undefined
        ? current.fallbackProtocol
        : fromProtoProtocol(patch.fallbackProtocol),
      fallbackEndpoint: patch.fallbackEndpoint ?? current.fallbackEndpoint,
      fallbackModel: patch.fallbackModel ?? current.fallbackModel,
      fallbackKeyless: patch.fallbackKeyless ?? current.fallbackKeyless
    });
    const ticketId = patch.credentialUploadTicketId;
    const fallbackTicketId = patch.fallbackCredentialUploadTicketId;
    if (ticketId !== undefined && next.keyless) {
      throw invalid("A keyless transcription route cannot receive a credential.");
    }
    if (fallbackTicketId !== undefined && next.fallbackKeyless) {
      throw invalid("A keyless transcription fallback cannot receive a credential.");
    }
    if (
      next.endpoint !== current.endpoint
      && credentialOrigin(next.endpoint) !== credentialOrigin(current.endpoint)
      && this.#credentialConfigured()
      && ticketId === undefined
      && patch.clearCredential !== true
      && !next.keyless
    ) throw invalid("Replace or clear the transcription credential when changing endpoint origin.");
    if (
      next.fallbackEndpoint !== current.fallbackEndpoint
      && credentialOrigin(next.fallbackEndpoint) !== credentialOrigin(current.fallbackEndpoint)
      && this.#fallbackCredentialConfigured()
      && fallbackTicketId === undefined
      && patch.clearFallbackCredential !== true
      && !next.fallbackKeyless
    ) throw invalid("Replace or clear the transcription fallback credential when changing endpoint origin.");
    const credentialWillExist = ticketId !== undefined
      || (patch.clearCredential !== true && this.#credentialConfigured());
    if (next.enabled && !next.keyless && !credentialWillExist) {
      throw new VoiceInputSettingsError("credential_unavailable", "Configure a transcription credential before enabling voice input.");
    }
    const fallbackCredentialWillExist = fallbackTicketId !== undefined
      || (patch.clearFallbackCredential !== true && this.#fallbackCredentialConfigured());
    if (next.enabled && next.fallbackEnabled && !next.fallbackKeyless && !fallbackCredentialWillExist) {
      throw new VoiceInputSettingsError("credential_unavailable", "Configure a transcription fallback credential before enabling it.");
    }
    if (next.refinementEnabled && !this.#refinementConfigurationAvailable(next)) {
      throw new VoiceInputSettingsError("credential_unavailable", "Configure an authenticated refinement Provider before enabling refinement.");
    }

    if (ticketId !== undefined) {
      await this.#credentials.commitUpload({
        credentialUploadTicketId: requireCredentialTicketId(ticketId),
        credentialReferenceId: CREDENTIAL_REFERENCE_ID,
        displayName: "Voice input transcription key",
        kind: "api_key",
        connectionId: requireIdentifier(connectionId, "connection")
      });
    }
    if (fallbackTicketId !== undefined) {
      await this.#credentials.commitUpload({
        credentialUploadTicketId: requireCredentialTicketId(fallbackTicketId),
        credentialReferenceId: FALLBACK_CREDENTIAL_REFERENCE_ID,
        displayName: "Voice input transcription fallback key",
        kind: "api_key",
        connectionId: requireIdentifier(connectionId, "connection")
      });
    }

    this.#store.setSetting<StoredVoiceInputSettings>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY, next, this.#now());
    if (patch.clearCredential === true) await this.#credentials.delete(CREDENTIAL_REFERENCE_ID);
    if (patch.clearFallbackCredential === true) await this.#credentials.delete(FALLBACK_CREDENTIAL_REFERENCE_ID);
    return this.snapshot();
  }

  #credentialConfigured(): boolean {
    return this.#credentials.find(CREDENTIAL_REFERENCE_ID)?.configured === true;
  }

  #fallbackCredentialConfigured(): boolean {
    return this.#credentials.find(FALLBACK_CREDENTIAL_REFERENCE_ID)?.configured === true;
  }

  #availableRoutes(settings: StoredVoiceInputSettings): readonly TranscriptionRoute[] {
    const routes: TranscriptionRoute[] = [];
    if (settings.keyless || this.#credentialConfigured()) {
      routes.push({
        protocol: settings.protocol,
        endpoint: settings.endpoint,
        model: settings.model,
        keyless: settings.keyless,
        credentialReferenceId: CREDENTIAL_REFERENCE_ID
      });
    }
    if (settings.fallbackEnabled && (settings.fallbackKeyless || this.#fallbackCredentialConfigured())) {
      routes.push({
        protocol: settings.fallbackProtocol,
        endpoint: settings.fallbackEndpoint,
        model: settings.fallbackModel,
        keyless: settings.fallbackKeyless,
        credentialReferenceId: FALLBACK_CREDENTIAL_REFERENCE_ID
      });
    }
    return routes;
  }

  #createRouteProvider(
    route: TranscriptionRoute,
    input: { readonly mimeType: SupportedAudioMimeType; readonly locale?: string }
  ): AsrProvider {
    let apiKey: string | undefined;
    if (!route.keyless) {
      try { apiKey = this.#credentials.resolve(route.credentialReferenceId); }
      catch { throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable."); }
    }
    if (route.protocol === "openaiCompatibleBatch") {
      return new OpenAiTranscriptionProvider({
        endpoint: route.endpoint,
        model: route.model,
        ...(apiKey === undefined ? {} : { apiKey }),
        mimeType: input.mimeType,
        inputPcmSampleRate: 16_000,
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
      });
    }
    if (input.mimeType !== "audio/pcm") {
      throw new VoiceInputSettingsError("invalid", "Realtime transcription requires PCM audio.");
    }
    return new RealtimeTranscriptionProvider({
      protocol: realtimeProtocol(route.protocol),
      endpoint: route.endpoint,
      model: route.model,
      ...(apiKey === undefined ? {} : { apiKey }),
      inputPcmSampleRate: 16_000,
      ...(input.locale === undefined ? {} : { locale: input.locale })
    });
  }

  #refinementAvailable(settings: StoredVoiceInputSettings): boolean {
    if (!settings.refinementEnabled) return false;
    return [
      [settings.refinerProviderId, settings.refinerModelId],
      [settings.refinerFallbackProviderId, settings.refinerFallbackModelId]
    ].some(([providerId, modelId]) => {
      if (providerId === "" || modelId === "") return false;
      try { return this.#providers?.resolveInferenceRoute(providerId!, modelId!) !== undefined; }
      catch { return false; }
    });
  }

  #refinementConfigurationAvailable(settings: StoredVoiceInputSettings): boolean {
    if (settings.refinerProviderId === "" || settings.refinerModelId === "") return false;
    const routes = [
      [settings.refinerProviderId, settings.refinerModelId],
      [settings.refinerFallbackProviderId, settings.refinerFallbackModelId]
    ].filter(([providerId]) => providerId !== "");
    if (routes.length === 0) return false;
    return routes.every(([providerId, modelId]) => {
      try { return this.#providers?.resolveInferenceRoute(providerId!, modelId!) !== undefined; }
      catch { return false; }
    });
  }

  #record(): SettingRecord<StoredVoiceInputSettings> {
    const record = this.#store.getSetting<unknown>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY);
    return { ...record, value: decodeSettings(record.value) };
  }

  #settings(): StoredVoiceInputSettings { return this.#record().value; }
}

function defaultSettings(): StoredVoiceInputSettings {
  return {
    format: 1,
    enabled: false,
    protocol: "openaiCompatibleBatch",
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    keyless: false,
    refinementEnabled: false,
    refinerProviderId: "",
    refinerModelId: "",
    refinerFallbackProviderId: "",
    refinerFallbackModelId: "",
    fallbackEnabled: false,
    fallbackProtocol: "openaiCompatibleBatch",
    fallbackEndpoint: DEFAULT_ENDPOINT,
    fallbackModel: DEFAULT_MODEL,
    fallbackKeyless: false
  };
}

function decodeSettings(value: unknown): StoredVoiceInputSettings {
  if (!isRecord(value) || value["format"] !== 1) throw invalid("Stored voice input settings are invalid.");
  return validateSettings({
    format: 1,
    enabled: value["enabled"],
    protocol: value["protocol"],
    endpoint: value["endpoint"],
    model: value["model"],
    keyless: value["keyless"],
    refinementEnabled: value["refinementEnabled"] ?? false,
    refinerProviderId: value["refinerProviderId"] ?? "",
    refinerModelId: value["refinerModelId"] ?? "",
    refinerFallbackProviderId: value["refinerFallbackProviderId"] ?? "",
    refinerFallbackModelId: value["refinerFallbackModelId"] ?? "",
    fallbackEnabled: value["fallbackEnabled"] ?? false,
    fallbackProtocol: value["fallbackProtocol"] ?? "openaiCompatibleBatch",
    fallbackEndpoint: value["fallbackEndpoint"] ?? DEFAULT_ENDPOINT,
    fallbackModel: value["fallbackModel"] ?? DEFAULT_MODEL,
    fallbackKeyless: value["fallbackKeyless"] ?? false
  });
}

function validateSettings(value: {
  readonly format: 1;
  readonly enabled: unknown;
  readonly protocol: unknown;
  readonly endpoint: unknown;
  readonly model: unknown;
  readonly keyless: unknown;
  readonly refinementEnabled: unknown;
  readonly refinerProviderId: unknown;
  readonly refinerModelId: unknown;
  readonly refinerFallbackProviderId: unknown;
  readonly refinerFallbackModelId: unknown;
  readonly fallbackEnabled: unknown;
  readonly fallbackProtocol: unknown;
  readonly fallbackEndpoint: unknown;
  readonly fallbackModel: unknown;
  readonly fallbackKeyless: unknown;
}): StoredVoiceInputSettings {
  if (
    typeof value.enabled !== "boolean" || typeof value.keyless !== "boolean"
    || typeof value.refinementEnabled !== "boolean" || !isStoredProtocol(value.protocol)
    || typeof value.fallbackEnabled !== "boolean" || typeof value.fallbackKeyless !== "boolean"
    || !isStoredProtocol(value.fallbackProtocol)
  ) {
    throw invalid("Voice input settings are invalid.");
  }
  if (
    typeof value.endpoint !== "string" || typeof value.model !== "string"
    || typeof value.fallbackEndpoint !== "string" || typeof value.fallbackModel !== "string"
    || typeof value.refinerProviderId !== "string" || typeof value.refinerModelId !== "string"
    || typeof value.refinerFallbackProviderId !== "string" || typeof value.refinerFallbackModelId !== "string"
  ) throw invalid("Voice input route is invalid.");
  let route: { readonly endpoint: string; readonly model: string };
  let fallbackRoute: { readonly endpoint: string; readonly model: string };
  try {
    route = validateTranscriptionRoute(value.protocol, value.endpoint, value.model);
    fallbackRoute = validateTranscriptionRoute(value.fallbackProtocol, value.fallbackEndpoint, value.fallbackModel);
  }
  catch { throw invalid("Voice input route is invalid."); }
  const refinerProviderId = normalizeRouteIdentifier(value.refinerProviderId);
  const refinerModelId = normalizeRouteIdentifier(value.refinerModelId);
  const refinerFallbackProviderId = normalizeRouteIdentifier(value.refinerFallbackProviderId);
  const refinerFallbackModelId = normalizeRouteIdentifier(value.refinerFallbackModelId);
  if ((refinerProviderId === "") !== (refinerModelId === "")) throw invalid("Voice input refinement route is incomplete.");
  if ((refinerFallbackProviderId === "") !== (refinerFallbackModelId === "")) throw invalid("Voice input refinement fallback route is incomplete.");
  if (refinerFallbackProviderId !== "" && refinerFallbackProviderId === refinerProviderId && refinerFallbackModelId === refinerModelId) {
    throw invalid("Voice input refinement fallback must differ from the primary route.");
  }
  if (
    value.fallbackEnabled
    && value.fallbackProtocol === value.protocol
    && fallbackRoute.endpoint === route.endpoint
    && fallbackRoute.model === route.model
  ) throw invalid("Voice input transcription fallback must differ from the primary route.");
  return {
    format: 1,
    enabled: value.enabled,
    protocol: value.protocol,
    endpoint: route.endpoint,
    model: route.model,
    keyless: value.keyless,
    refinementEnabled: value.refinementEnabled,
    refinerProviderId,
    refinerModelId,
    refinerFallbackProviderId,
    refinerFallbackModelId,
    fallbackEnabled: value.fallbackEnabled,
    fallbackProtocol: value.fallbackProtocol,
    fallbackEndpoint: fallbackRoute.endpoint,
    fallbackModel: fallbackRoute.model,
    fallbackKeyless: value.fallbackKeyless
  };
}

function unsupported(support: Exclude<VoiceInputProviderCapability["support"], "supported">): VoiceInputProviderCapability {
  return {
    support,
    mimeTypes: [],
    supportsLocale: false,
    supportsLiveDrafts: false,
    supportsRefinement: false
  };
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) throw invalid(`Voice input ${label} is invalid.`);
  return normalized;
}

function requireCredentialTicketId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{32}$/u.test(normalized)) throw invalid("Voice input credential ticket is invalid.");
  return normalized;
}

function normalizeRouteIdentifier(value: string): string {
  const normalized = value.trim();
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalid("Voice input refinement route is invalid.");
  }
  return normalized;
}

function isStoredProtocol(value: unknown): value is StoredTranscriptionProtocol {
  return value === "openaiCompatibleBatch"
    || value === "openaiCompatibleRealtime"
    || value === "qwenCompatibleRealtime";
}

function fromProtoProtocol(value: VoiceInputTranscriptionProtocol): StoredTranscriptionProtocol {
  switch (value) {
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH: return "openaiCompatibleBatch";
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME: return "openaiCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME: return "qwenCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.UNSPECIFIED:
      throw invalid("Voice input transcription protocol is unsupported.");
  }
}

function toProtoProtocol(value: StoredTranscriptionProtocol): VoiceInputTranscriptionProtocol {
  switch (value) {
    case "openaiCompatibleBatch": return VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH;
    case "openaiCompatibleRealtime": return VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME;
    case "qwenCompatibleRealtime": return VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME;
  }
}

function realtimeProtocol(value: Exclude<StoredTranscriptionProtocol, "openaiCompatibleBatch">): RealtimeTranscriptionProtocol {
  return value === "qwenCompatibleRealtime" ? "qwenRealtime" : "openaiRealtime";
}

function routeMimeTypes(protocol: StoredTranscriptionProtocol): readonly SupportedAudioMimeType[] {
  return protocol === "openaiCompatibleBatch" ? OPENAI_TRANSCRIPTION_MIME_TYPES : ["audio/pcm"];
}

function validateTranscriptionRoute(
  protocol: StoredTranscriptionProtocol,
  endpoint: string,
  model: string
): { readonly endpoint: string; readonly model: string } {
  if (protocol === "openaiCompatibleBatch") return validateOpenAiTranscriptionRoute({ endpoint, model });
  const route = validateRealtimeTranscriptionRoute({ protocol: realtimeProtocol(protocol), endpoint, model });
  return { endpoint: route.endpoint, model: route.model };
}

function credentialOrigin(endpoint: string): string {
  try { return new URL(endpoint).origin; }
  catch { return "invalid"; }
}

function invalid(message: string): VoiceInputSettingsError { return new VoiceInputSettingsError("invalid", message); }

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
