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
  ScribeTranscriptionProvider,
  probeScribeTranscriptionRoute,
  validateScribeTranscriptionRoute
} from "@joko/adapter-transcription-scribe";
import {
  SaucTranscriptionProvider,
  probeSaucTranscriptionRoute,
  validateSaucTranscriptionConfiguration
} from "@joko/adapter-transcription-sauc";
import {
  VoiceInputServiceSettingsSchema,
  VoiceInputTranscriptionProtocol,
  type ModelRouteRef,
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
const CREDENTIAL_JOURNAL_KEY = "settings.voice_input_owned_credentials";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";

type StoredTranscriptionProtocol = "openaiCompatibleBatch" | "openaiCompatibleRealtime" | "qwenCompatibleRealtime" | "elevenLabsScribeRealtime" | "volcengineSauc";

type StoredRefinerModel = Pick<ModelRouteRef, "backendId" | "providerId" | "modelId">;

interface StoredVoiceInputSettings {
  readonly format: 1;
  readonly enabled: boolean;
  readonly protocol: StoredTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly resourceId: string;
  readonly credentialReferenceId: string;
  readonly keyless: boolean;
  readonly refinementEnabled: boolean;
  readonly refinerModel: StoredRefinerModel | null;
  readonly refinerFallbackModel: StoredRefinerModel | null;
  readonly fallbackEnabled: boolean;
  readonly fallbackProtocol: StoredTranscriptionProtocol;
  readonly fallbackEndpoint: string;
  readonly fallbackModel: string;
  readonly fallbackResourceId: string;
  readonly fallbackCredentialReferenceId: string;
  readonly fallbackKeyless: boolean;
}

interface TranscriptionRoute {
  readonly protocol: StoredTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly resourceId: string;
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
    const settings = this.#settings();
    for (const reference of new Set([...this.#credentialJournal(), settings.credentialReferenceId, settings.fallbackCredentialReferenceId])) {
      if (reference !== "") this.#credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "api_key" });
    }
    this.#tail = this.#cleanupCredentials();
  }

  snapshot(): VoiceInputServiceSettings {
    const record = this.#record();
    const settings = record.value;
    return create(VoiceInputServiceSettingsSchema, {
      enabled: settings.enabled,
      protocol: toProtoProtocol(settings.protocol),
      endpoint: settings.endpoint,
      model: settings.model,
      resourceId: settings.resourceId,
      keyless: settings.keyless,
      credentialConfigured: this.#credentialConfigured(),
      version: toProtoEntityVersion(record.revision, 0, record.updatedAt),
      refinementEnabled: settings.refinementEnabled,
      ...(settings.refinerModel === null ? {} : { refinerModel: settings.refinerModel }),
      ...(settings.refinerFallbackModel === null ? {} : { refinerFallbackModel: settings.refinerFallbackModel }),
      fallbackEnabled: settings.fallbackEnabled,
      fallbackProtocol: toProtoProtocol(settings.fallbackProtocol),
      fallbackEndpoint: settings.fallbackEndpoint,
      fallbackModel: settings.fallbackModel,
      fallbackResourceId: settings.fallbackResourceId,
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
      supportsLocale: routes.every((route) => route.protocol !== "volcengineSauc"),
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
    const routes = [settings.refinerModel, settings.refinerFallbackModel];
    const refiners = routes.flatMap((model) => {
      if (model === null) return [];
      let route: ReturnType<NonNullable<VoiceInputSettingsControllerOptions["providers"]>["resolveInferenceRoute"]>;
      try { route = this.#providers?.resolveInferenceRoute(model.backendId, model.providerId, model.modelId); }
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
    const routes = [settings.refinerModel, settings.refinerFallbackModel];
    for (const model of routes) {
      if (model === null) continue;
      let route: ReturnType<NonNullable<VoiceInputSettingsControllerOptions["providers"]>["resolveInferenceRoute"]>;
      try { route = this.#providers?.resolveInferenceRoute(model.backendId, model.providerId, model.modelId); }
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
      try { apiKey = this.#credentials.resolve(settings.credentialReferenceId); }
      catch { return Promise.resolve({ ok: false, reason: "credentialsMissing" }); }
    }
    const promise: Promise<VoiceInputConnectionTestResult> = settings.protocol === "openaiCompatibleBatch"
      ? probeOpenAiTranscriptionRoute({
          endpoint: settings.endpoint,
          model: settings.model,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
        })
      : settings.protocol === "elevenLabsScribeRealtime"
        ? probeScribeTranscriptionRoute({
            endpoint: settings.endpoint,
            model: settings.model,
            ...(apiKey === undefined ? {} : { apiKey })
          })
        : settings.protocol === "volcengineSauc"
          ? probeSaucTranscriptionRoute({ endpoint: settings.endpoint, resourceId: settings.resourceId, apiKey: apiKey! })
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
      resourceId: patch.resourceId ?? current.resourceId,
      credentialReferenceId: current.credentialReferenceId,
      keyless: patch.keyless ?? current.keyless,
      refinementEnabled: patch.refinementEnabled ?? current.refinementEnabled,
      refinerModel: patch.refinerModel === undefined ? current.refinerModel : readRefinerModelPatch(patch.refinerModel),
      refinerFallbackModel: patch.refinerFallbackModel === undefined ? current.refinerFallbackModel : readRefinerModelPatch(patch.refinerFallbackModel),
      fallbackEnabled: patch.fallbackEnabled ?? current.fallbackEnabled,
      fallbackProtocol: patch.fallbackProtocol === undefined
        ? current.fallbackProtocol
        : fromProtoProtocol(patch.fallbackProtocol),
      fallbackEndpoint: patch.fallbackEndpoint ?? current.fallbackEndpoint,
      fallbackModel: patch.fallbackModel ?? current.fallbackModel,
      fallbackResourceId: patch.fallbackResourceId ?? current.fallbackResourceId,
      fallbackCredentialReferenceId: current.fallbackCredentialReferenceId,
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
      (next.protocol !== current.protocol || credentialOrigin(next.endpoint) !== credentialOrigin(current.endpoint))
      && this.#credentialConfigured()
      && ticketId === undefined
      && patch.clearCredential !== true
    ) throw invalid("Replace or clear the transcription credential when changing protocol or endpoint origin.");
    if (
      (next.fallbackProtocol !== current.fallbackProtocol || credentialOrigin(next.fallbackEndpoint) !== credentialOrigin(current.fallbackEndpoint))
      && this.#fallbackCredentialConfigured()
      && fallbackTicketId === undefined
      && patch.clearFallbackCredential !== true
    ) throw invalid("Replace or clear the transcription fallback credential when changing protocol or endpoint origin.");
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

    let credentialReferenceId = patch.clearCredential === true ? "" : current.credentialReferenceId;
    let fallbackCredentialReferenceId = patch.clearFallbackCredential === true ? "" : current.fallbackCredentialReferenceId;
    try {
      if (ticketId !== undefined) credentialReferenceId = await this.#commitCredential(ticketId, connectionId, "Voice input transcription key");
      if (fallbackTicketId !== undefined) fallbackCredentialReferenceId = await this.#commitCredential(fallbackTicketId, connectionId, "Voice input transcription fallback key");
      this.#store.setSetting<StoredVoiceInputSettings>(SCOPE_TYPE, SCOPE_ID, SETTING_KEY,
        { ...next, credentialReferenceId, fallbackCredentialReferenceId }, this.#now());
    } catch (error) {
      await this.#cleanupCredentials();
      throw error;
    }
    const saved = this.snapshot();
    await this.#cleanupCredentials();
    return saved;
  }

  #credentialConfigured(): boolean {
    return this.#credentials.find(this.#settings().credentialReferenceId)?.configured === true;
  }

  #fallbackCredentialConfigured(): boolean {
    return this.#credentials.find(this.#settings().fallbackCredentialReferenceId)?.configured === true;
  }

  async #commitCredential(ticketId: string, connectionId: string, displayName: string): Promise<string> {
    const credential = await this.#credentials.commitNewManagedUpload({
      credentialUploadTicketId: requireCredentialTicketId(ticketId), displayName, kind: "api_key",
      connectionId: requireIdentifier(connectionId, "connection"),
      onReserved: (reference) => {
        const references = this.#credentialJournal();
        if (references.length >= 256) throw invalid("Voice input credential retirement is unavailable.");
        this.#store.setSetting(SCOPE_TYPE, SCOPE_ID, CREDENTIAL_JOURNAL_KEY, { format: 1, references: [...references, reference] }, this.#now());
      }
    });
    return credential.credentialReferenceId;
  }

  #credentialJournal(): readonly string[] {
    const record = this.#store.findSetting<unknown>(SCOPE_TYPE, SCOPE_ID, CREDENTIAL_JOURNAL_KEY);
    if (record === undefined) return [];
    const value = record.value;
    if (!isRecord(value) || value["format"] !== 1 || !Array.isArray(value["references"]) || value["references"].length > 256) {
      throw invalid("Voice input credential journal is invalid.");
    }
    return value["references"].map((reference) => requireStoredCredentialReference(reference, false));
  }

  async #cleanupCredentials(): Promise<void> {
    try {
      for (const reference of this.#credentialJournal()) {
        const settings = this.#settings();
        if (reference === settings.credentialReferenceId || reference === settings.fallbackCredentialReferenceId) continue;
        this.#credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "api_key" });
        const generation = this.#credentials.find(reference)?.generation;
        if (!await this.#credentials.retireManagedCredential(reference, generation)) continue;
        this.#store.setSetting(SCOPE_TYPE, SCOPE_ID, CREDENTIAL_JOURNAL_KEY,
          { format: 1, references: this.#credentialJournal().filter((value) => value !== reference) }, this.#now());
      }
    } catch {
      try {
        this.#store.appendDiagnostic({ severity: "warning", component: "voice-input", code: "CREDENTIAL_RETIREMENT_FAILED",
          message: "An unused voice input credential could not be retired. Retirement will be retried." });
      } catch { /* A diagnostic failure cannot undo an adopted settings revision. */ }
    }
  }

  #availableRoutes(settings: StoredVoiceInputSettings): readonly TranscriptionRoute[] {
    const routes: TranscriptionRoute[] = [];
    if (settings.keyless || this.#credentialConfigured()) {
      routes.push({
        protocol: settings.protocol,
        endpoint: settings.endpoint,
        model: settings.model,
        resourceId: settings.resourceId,
        keyless: settings.keyless,
        credentialReferenceId: settings.credentialReferenceId
      });
    }
    if (settings.fallbackEnabled && (settings.fallbackKeyless || this.#fallbackCredentialConfigured())) {
      routes.push({
        protocol: settings.fallbackProtocol,
        endpoint: settings.fallbackEndpoint,
        model: settings.fallbackModel,
        resourceId: settings.fallbackResourceId,
        keyless: settings.fallbackKeyless,
        credentialReferenceId: settings.fallbackCredentialReferenceId
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
    if (route.protocol === "elevenLabsScribeRealtime") {
      return new ScribeTranscriptionProvider({
        endpoint: route.endpoint,
        model: route.model,
        ...(apiKey === undefined ? {} : { apiKey })
      });
    }
    if (route.protocol === "volcengineSauc") {
      return new SaucTranscriptionProvider({ endpoint: route.endpoint, resourceId: route.resourceId, apiKey: apiKey! });
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
    return [settings.refinerModel, settings.refinerFallbackModel].some((model) => {
      if (model === null) return false;
      try { return this.#providers?.resolveInferenceRoute(model.backendId, model.providerId, model.modelId) !== undefined; }
      catch { return false; }
    });
  }

  #refinementConfigurationAvailable(settings: StoredVoiceInputSettings): boolean {
    if (settings.refinerModel === null) return false;
    return [settings.refinerModel, settings.refinerFallbackModel].every((model) => {
      if (model === null) return true;
      try { return this.#providers?.resolveInferenceRoute(model.backendId, model.providerId, model.modelId) !== undefined; }
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
    resourceId: "",
    credentialReferenceId: "",
    keyless: false,
    refinementEnabled: false,
    refinerModel: null,
    refinerFallbackModel: null,
    fallbackEnabled: false,
    fallbackProtocol: "openaiCompatibleBatch",
    fallbackEndpoint: DEFAULT_ENDPOINT,
    fallbackModel: DEFAULT_MODEL,
    fallbackResourceId: "",
    fallbackCredentialReferenceId: "",
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
    resourceId: value["resourceId"],
    credentialReferenceId: value["credentialReferenceId"],
    keyless: value["keyless"],
    refinementEnabled: value["refinementEnabled"],
    refinerModel: value["refinerModel"],
    refinerFallbackModel: value["refinerFallbackModel"],
    fallbackEnabled: value["fallbackEnabled"],
    fallbackProtocol: value["fallbackProtocol"],
    fallbackEndpoint: value["fallbackEndpoint"],
    fallbackModel: value["fallbackModel"],
    fallbackResourceId: value["fallbackResourceId"],
    fallbackCredentialReferenceId: value["fallbackCredentialReferenceId"],
    fallbackKeyless: value["fallbackKeyless"]
  });
}

function validateSettings(value: {
  readonly format: 1;
  readonly enabled: unknown;
  readonly protocol: unknown;
  readonly endpoint: unknown;
  readonly model: unknown;
  readonly resourceId: unknown;
  readonly credentialReferenceId: unknown;
  readonly keyless: unknown;
  readonly refinementEnabled: unknown;
  readonly refinerModel: unknown;
  readonly refinerFallbackModel: unknown;
  readonly fallbackEnabled: unknown;
  readonly fallbackProtocol: unknown;
  readonly fallbackEndpoint: unknown;
  readonly fallbackModel: unknown;
  readonly fallbackResourceId: unknown;
  readonly fallbackCredentialReferenceId: unknown;
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
    || typeof value.resourceId !== "string" || typeof value.fallbackResourceId !== "string"
    || typeof value.fallbackEndpoint !== "string" || typeof value.fallbackModel !== "string"
  ) throw invalid("Voice input route is invalid.");
  let route: { readonly endpoint: string; readonly model: string; readonly resourceId: string };
  let fallbackRoute: { readonly endpoint: string; readonly model: string; readonly resourceId: string };
  try {
    route = validateTranscriptionRoute(value.protocol, value.endpoint, value.model, value.resourceId, value.keyless);
    fallbackRoute = validateTranscriptionRoute(value.fallbackProtocol, value.fallbackEndpoint, value.fallbackModel, value.fallbackResourceId, value.fallbackKeyless);
  }
  catch { throw invalid("Voice input route is invalid."); }
  const refinerModel = requireStoredRefinerModel(value.refinerModel);
  const refinerFallbackModel = requireStoredRefinerModel(value.refinerFallbackModel);
  if (refinerModel !== null && refinerFallbackModel !== null
    && refinerModel.backendId === refinerFallbackModel.backendId
    && refinerModel.providerId === refinerFallbackModel.providerId
    && refinerModel.modelId === refinerFallbackModel.modelId) {
    throw invalid("Voice input refinement fallback must differ from the primary route.");
  }
  if (
    value.fallbackEnabled
    && value.fallbackProtocol === value.protocol
    && fallbackRoute.endpoint === route.endpoint
    && fallbackRoute.model === route.model
    && fallbackRoute.resourceId === route.resourceId
  ) throw invalid("Voice input transcription fallback must differ from the primary route.");
  return {
    format: 1,
    enabled: value.enabled,
    protocol: value.protocol,
    endpoint: route.endpoint,
    model: route.model,
    resourceId: route.resourceId,
    credentialReferenceId: requireStoredCredentialReference(value.credentialReferenceId),
    keyless: value.keyless,
    refinementEnabled: value.refinementEnabled,
    refinerModel,
    refinerFallbackModel,
    fallbackEnabled: value.fallbackEnabled,
    fallbackProtocol: value.fallbackProtocol,
    fallbackEndpoint: fallbackRoute.endpoint,
    fallbackModel: fallbackRoute.model,
    fallbackResourceId: fallbackRoute.resourceId,
    fallbackCredentialReferenceId: requireStoredCredentialReference(value.fallbackCredentialReferenceId),
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

function readRefinerModelPatch(value: ModelRouteRef): StoredRefinerModel | null {
  if (!isRecord(value)) throw invalid("Voice input refinement route is invalid.");
  const model = {
    backendId: normalizeRouteIdentifier(value.backendId),
    providerId: normalizeRouteIdentifier(value.providerId),
    modelId: normalizeRouteIdentifier(value.modelId)
  };
  if (Object.values(model).every((part) => part === "")) return null;
  return requireStoredRefinerModel(model);
}

function requireStoredRefinerModel(value: unknown): StoredRefinerModel | null {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).length !== 3
    || typeof value["backendId"] !== "string" || typeof value["providerId"] !== "string" || typeof value["modelId"] !== "string") {
    throw invalid("Voice input refinement route is invalid.");
  }
  const model = {
    backendId: normalizeRouteIdentifier(value["backendId"]),
    providerId: normalizeRouteIdentifier(value["providerId"]),
    modelId: normalizeRouteIdentifier(value["modelId"])
  };
  if (Object.entries(model).some(([key, part]) => part === "" || part !== value[key])) {
    throw invalid("Voice input refinement route is incomplete or invalid.");
  }
  return model;
}

function normalizeRouteIdentifier(value: unknown): string {
  if (typeof value !== "string") throw invalid("Voice input refinement route is invalid.");
  const normalized = value.trim();
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalid("Voice input refinement route is invalid.");
  }
  return normalized;
}

function isStoredProtocol(value: unknown): value is StoredTranscriptionProtocol {
  return value === "openaiCompatibleBatch"
    || value === "openaiCompatibleRealtime"
    || value === "qwenCompatibleRealtime"
    || value === "elevenLabsScribeRealtime"
    || value === "volcengineSauc";
}

function fromProtoProtocol(value: VoiceInputTranscriptionProtocol): StoredTranscriptionProtocol {
  switch (value) {
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH: return "openaiCompatibleBatch";
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME: return "openaiCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME: return "qwenCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.ELEVENLABS_SCRIBE_REALTIME: return "elevenLabsScribeRealtime";
    case VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC: return "volcengineSauc";
    case VoiceInputTranscriptionProtocol.UNSPECIFIED:
      throw invalid("Voice input transcription protocol is unsupported.");
  }
}

function toProtoProtocol(value: StoredTranscriptionProtocol): VoiceInputTranscriptionProtocol {
  switch (value) {
    case "openaiCompatibleBatch": return VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH;
    case "openaiCompatibleRealtime": return VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME;
    case "qwenCompatibleRealtime": return VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME;
    case "elevenLabsScribeRealtime": return VoiceInputTranscriptionProtocol.ELEVENLABS_SCRIBE_REALTIME;
    case "volcengineSauc": return VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC;
  }
}

function realtimeProtocol(value: Exclude<StoredTranscriptionProtocol, "openaiCompatibleBatch" | "elevenLabsScribeRealtime" | "volcengineSauc">): RealtimeTranscriptionProtocol {
  return value === "qwenCompatibleRealtime" ? "qwenRealtime" : "openaiRealtime";
}

function routeMimeTypes(protocol: StoredTranscriptionProtocol): readonly SupportedAudioMimeType[] {
  return protocol === "openaiCompatibleBatch" ? OPENAI_TRANSCRIPTION_MIME_TYPES : ["audio/pcm"];
}

function validateTranscriptionRoute(
  protocol: StoredTranscriptionProtocol,
  endpoint: string,
  model: string,
  resourceId: string,
  keyless: boolean
): { readonly endpoint: string; readonly model: string; readonly resourceId: string } {
  if (protocol === "volcengineSauc") {
    if (model !== "" || keyless) throw invalid("SAUC requires a resource ID and an API key.");
    const route = validateSaucTranscriptionConfiguration({ endpoint, resourceId });
    return { endpoint: route.endpoint, model: "", resourceId: route.resourceId };
  }
  if (resourceId !== "") throw invalid("This transcription protocol does not use a resource ID.");
  const route = protocol === "openaiCompatibleBatch" ? validateOpenAiTranscriptionRoute({ endpoint, model })
    : protocol === "elevenLabsScribeRealtime" ? validateScribeTranscriptionRoute({ endpoint, model })
      : validateRealtimeTranscriptionRoute({ protocol: realtimeProtocol(protocol), endpoint, model });
  return { endpoint: route.endpoint, model: route.model, resourceId: "" };
}

function requireStoredCredentialReference(value: unknown, allowEmpty = true): string {
  if (typeof value !== "string" || (!(allowEmpty && value === "") && !/^cred_managed_[0-9a-f-]{36}$/u.test(value))) {
    throw invalid("Stored voice input credential reference is invalid.");
  }
  return value;
}

function credentialOrigin(endpoint: string): string {
  try { return new URL(endpoint).origin; }
  catch { return "invalid"; }
}

function invalid(message: string): VoiceInputSettingsError { return new VoiceInputSettingsError("invalid", message); }

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
