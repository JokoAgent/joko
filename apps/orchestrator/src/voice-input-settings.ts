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
  SAUC_SUPPORTED_LOCALES,
  SaucTranscriptionProvider,
  probeSaucTranscriptionRoute,
  validateSaucTranscriptionConfiguration,
  type SaucAuthentication,
  type SaucCorpusConfiguration,
  type SaucTranscriptionMode
} from "@joko/adapter-transcription-sauc";
import {
  VoiceInputSaucAuthentication,
  VoiceInputSaucMode,
  VoiceInputSaucSettingsSchema,
  VoiceInputServiceSettingsSchema,
  VoiceInputTranscriptionProtocol,
  type ModelRouteRef,
  type VoiceInputSaucSettings,
  type VoiceInputServiceSettings,
  type VoiceInputServiceSettingsPatch
} from "@joko/contracts";
import type { OperationalStore, SettingRecord } from "@joko/store";
import {
  FallbackAsrProvider,
  normalizeRecognitionContext,
  type AsrEvent,
  type AsrProvider,
  type AsrRecognitionContext,
  type AsrStartRequest,
  type AudioChunk,
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

interface StoredSaucSettings {
  readonly mode: SaucTranscriptionMode;
  readonly authentication: "apiKey" | "accessToken";
  readonly appId: string;
  readonly useDictionaryHotwords: boolean;
  readonly boostingTableName: string;
  readonly boostingTableId: string;
  readonly correctTableName: string;
  readonly correctTableId: string;
}

interface StoredVoiceInputSettings {
  readonly format: 1;
  readonly enabled: boolean;
  readonly protocol: StoredTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly resourceId: string;
  readonly sauc: StoredSaucSettings | null;
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
  readonly fallbackSauc: StoredSaucSettings | null;
  readonly fallbackCredentialReferenceId: string;
  readonly fallbackKeyless: boolean;
}

interface TranscriptionRoute {
  readonly protocol: StoredTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly resourceId: string;
  readonly sauc: StoredSaucSettings | null;
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
  readonly dictionaryTerms?: () => readonly string[];
  readonly onConfigurationChanged?: () => void;
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
  readonly #dictionaryTerms: (() => readonly string[]) | undefined;
  readonly #onConfigurationChanged: (() => void) | undefined;
  #tail: Promise<void> = Promise.resolve();
  #activeConnectionTest?: { readonly revision: bigint; readonly promise: Promise<VoiceInputConnectionTestResult> };

  constructor(options: VoiceInputSettingsControllerOptions) {
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch;
    this.#providers = options.providers;
    this.#dictionaryTerms = options.dictionaryTerms;
    this.#onConfigurationChanged = options.onConfigurationChanged;
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
      ...(settings.sauc === null ? {} : { sauc: toProtoSauc(settings.sauc) }),
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
      ...(settings.fallbackSauc === null ? {} : { fallbackSauc: toProtoSauc(settings.fallbackSauc) }),
      fallbackKeyless: settings.fallbackKeyless,
      fallbackCredentialConfigured: this.#fallbackCredentialConfigured()
    });
  }

  describe(): VoiceInputProviderCapability {
    const settings = this.#settings();
    if (!settings.enabled) return unsupported("disabled_by_policy");
    if (this.#availableRoutes(settings).length === 0) return unsupported("temporarily_unavailable");
    const routes = this.#configuredRoutes(settings);
    const mimeTypes = routeMimeTypes(routes[0]!.protocol).filter((mimeType) =>
      routes.every((route) => routeMimeTypes(route.protocol).includes(mimeType)));
    if (mimeTypes.length === 0) return unsupported("temporarily_unavailable");
    const supportsLocale = routes.every((route) => route.protocol !== "volcengineSauc" || route.sauc?.mode === "streamInput");
    return {
      support: "supported",
      mimeTypes,
      supportsLocale,
      supportedLocales: supportsLocale && routes.some((route) => route.protocol === "volcengineSauc") ? SAUC_SUPPORTED_LOCALES : [],
      supportsLiveDrafts: routes.every((route) => route.protocol !== "openaiCompatibleBatch"
        && (route.protocol !== "volcengineSauc" || route.sauc?.mode !== "streamInput")),
      supportsRecognitionContext: routes.every((route) => route.protocol === "volcengineSauc"),
      supportsRefinement: this.#refinementAvailable(settings)
    };
  }

  create(input: { readonly mimeType: SupportedAudioMimeType; readonly locale?: string; readonly recognitionContext?: AsrRecognitionContext }): AsrProvider {
    const record = this.#record();
    const settings = record.value;
    const capability = this.describe();
    if (capability.support !== "supported") throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable.");
    const routes = this.#availableRoutes(settings)
      .filter((route) => routeMimeTypes(route.protocol).includes(input.mimeType));
    if (routes.length === 0) {
      throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable.");
    }
    if (!capability.mimeTypes.includes(input.mimeType)
      || (input.locale !== undefined && (!capability.supportsLocale
        || (capability.supportedLocales!.length > 0 && !capability.supportedLocales!.includes(input.locale))))
      || (input.recognitionContext !== undefined && capability.supportsRecognitionContext !== true)) {
      throw invalid("The configured transcription routes do not support this request.");
    }
    const normalized = normalizeRecognitionContext(input.recognitionContext);
    const hotwords = routes.some((route) => route.sauc?.useDictionaryHotwords)
      ? [...(this.#dictionaryTerms?.() ?? [])] : [];
    const context = normalizeRecognitionContext({ hotwords, contextData: normalized?.contextData ?? [] })!;
    const isCurrent = (): boolean => this.#isConfigurationCurrent(record.revision);
    const providers: AsrProvider[] = [];
    try {
      for (const route of routes) providers.push(this.#createRouteProvider(route, { ...input, recognitionContext: context }, isCurrent));
    } catch (error) {
      for (const provider of providers) void provider.stop().catch(() => undefined);
      providers.length = 0;
      throw error;
    }
    const factories = providers.map((_provider, index) => () => {
      if (!isCurrent() || providers[index] === undefined) {
        throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable.");
      }
      return providers[index]!;
    });
    const delegate = providers.length === 1 ? providers[0]! : new FallbackAsrProvider(factories);
    return new CapturedTranscriptionProvider(delegate, providers, isCurrent);
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

  testConnection(signal?: AbortSignal): Promise<VoiceInputConnectionTestResult> {
    const record = this.#record();
    const active = this.#activeConnectionTest;
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "network" });
    if (signal === undefined && active !== undefined) {
      return active.revision === record.revision
        ? active.promise
        : Promise.resolve({ ok: false, reason: "serviceError" });
    }
    const settings = record.value;
    const credentialGeneration = this.#credentials.find(settings.credentialReferenceId)?.generation;
    const isCurrent = (): boolean => this.#isConfigurationCurrent(record.revision) && signal?.aborted !== true
      && (settings.keyless || (this.#credentials.find(settings.credentialReferenceId)?.configured === true
        && this.#credentials.find(settings.credentialReferenceId)?.generation === credentialGeneration));
    let apiKey: string | undefined;
    if (!settings.keyless) {
      try { apiKey = this.#credentials.resolve(settings.credentialReferenceId); }
      catch { return Promise.resolve({ ok: false, reason: "credentialsMissing" }); }
    }
    const task: Promise<VoiceInputConnectionTestResult> = settings.protocol === "openaiCompatibleBatch"
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
          ? probeSaucTranscriptionRoute({
              endpoint: settings.endpoint, resourceId: settings.resourceId, mode: settings.sauc!.mode,
              corpus: saucCorpus(settings.sauc!), authentication: saucAuthentication(settings.sauc!, apiKey!),
              isCurrent
            }, signal === undefined ? {} : { signal })
          : probeRealtimeTranscriptionRoute({
          protocol: realtimeProtocol(settings.protocol),
          endpoint: settings.endpoint,
          model: settings.model,
          ...(apiKey === undefined ? {} : { apiKey })
        });
    const promise: Promise<VoiceInputConnectionTestResult> = task.then((result) =>
      isCurrent()
        ? result : { ok: false, reason: "serviceError" });
    if (signal !== undefined) return promise;
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
      sauc: patch.sauc === undefined
        ? (patch.protocol !== undefined && patch.protocol !== VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC ? null : current.sauc)
        : fromProtoSauc(patch.sauc),
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
      fallbackSauc: patch.fallbackSauc === undefined
        ? (patch.fallbackProtocol !== undefined && patch.fallbackProtocol !== VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC ? null : current.fallbackSauc)
        : fromProtoSauc(patch.fallbackSauc),
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
      (next.protocol !== current.protocol || credentialOrigin(next.endpoint) !== credentialOrigin(current.endpoint)
        || saucCredentialAuthorityChanged(current.sauc, next.sauc))
      && this.#credentialConfigured()
      && ticketId === undefined
      && patch.clearCredential !== true
    ) throw invalid("Replace or clear the transcription credential when changing protocol, endpoint origin, authentication or APP ID.");
    if (
      (next.fallbackProtocol !== current.fallbackProtocol || credentialOrigin(next.fallbackEndpoint) !== credentialOrigin(current.fallbackEndpoint)
        || saucCredentialAuthorityChanged(current.fallbackSauc, next.fallbackSauc))
      && this.#fallbackCredentialConfigured()
      && fallbackTicketId === undefined
      && patch.clearFallbackCredential !== true
    ) throw invalid("Replace or clear the transcription fallback credential when changing protocol, endpoint origin, authentication or APP ID.");
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
    this.#onConfigurationChanged?.();
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

  #configuredRoutes(settings: StoredVoiceInputSettings): readonly TranscriptionRoute[] {
    const routes: TranscriptionRoute[] = [];
      routes.push({
        protocol: settings.protocol,
        endpoint: settings.endpoint,
        model: settings.model,
        resourceId: settings.resourceId,
        sauc: settings.sauc,
        keyless: settings.keyless,
        credentialReferenceId: settings.credentialReferenceId
      });
    if (settings.fallbackEnabled) {
      routes.push({
        protocol: settings.fallbackProtocol,
        endpoint: settings.fallbackEndpoint,
        model: settings.fallbackModel,
        resourceId: settings.fallbackResourceId,
        sauc: settings.fallbackSauc,
        keyless: settings.fallbackKeyless,
        credentialReferenceId: settings.fallbackCredentialReferenceId
      });
    }
    return routes;
  }

  #availableRoutes(settings: StoredVoiceInputSettings): readonly TranscriptionRoute[] {
    return this.#configuredRoutes(settings).filter((route) => route.keyless
      || this.#credentials.find(route.credentialReferenceId)?.configured === true);
  }

  #createRouteProvider(
    route: TranscriptionRoute,
    input: { readonly mimeType: SupportedAudioMimeType; readonly locale?: string; readonly recognitionContext?: AsrRecognitionContext },
    isCurrent: () => boolean
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
      const sauc = route.sauc!;
      const generation = this.#credentials.find(route.credentialReferenceId)?.generation;
      return new SaucTranscriptionProvider({ endpoint: route.endpoint, resourceId: route.resourceId,
        mode: sauc.mode, corpus: saucCorpus(sauc), authentication: saucAuthentication(sauc, apiKey!),
        recognitionContext: {
          hotwords: sauc.useDictionaryHotwords ? input.recognitionContext?.hotwords ?? [] : [],
          contextData: input.recognitionContext?.contextData ?? []
        }, isCurrent: () => isCurrent() && this.#credentials.find(route.credentialReferenceId)?.configured === true
          && this.#credentials.find(route.credentialReferenceId)?.generation === generation });
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
  #isConfigurationCurrent(revision: bigint): boolean {
    try { return this.#record().revision === revision; } catch { return false; }
  }
}

function defaultSettings(): StoredVoiceInputSettings {
  return {
    format: 1,
    enabled: false,
    protocol: "openaiCompatibleBatch",
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    resourceId: "",
    sauc: null,
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
    fallbackSauc: null,
    fallbackCredentialReferenceId: "",
    fallbackKeyless: false
  };
}

function fromProtoSauc(value: VoiceInputSaucSettings): StoredSaucSettings {
  const mode = value.mode === VoiceInputSaucMode.ASYNC_TWO_PASS ? "asyncTwoPass"
    : value.mode === VoiceInputSaucMode.BIDIRECTIONAL ? "bidirectional"
      : value.mode === VoiceInputSaucMode.STREAM_INPUT ? "streamInput" : undefined;
  const authentication = value.authentication === VoiceInputSaucAuthentication.API_KEY ? "apiKey"
    : value.authentication === VoiceInputSaucAuthentication.ACCESS_TOKEN ? "accessToken" : undefined;
  return requireStoredSauc({ mode, authentication, appId: value.appId, useDictionaryHotwords: value.useDictionaryHotwords,
    boostingTableName: value.boostingTableName, boostingTableId: value.boostingTableId,
    correctTableName: value.correctTableName, correctTableId: value.correctTableId })!;
}

function toProtoSauc(value: StoredSaucSettings): VoiceInputSaucSettings {
  return create(VoiceInputSaucSettingsSchema, { ...value,
    mode: value.mode === "asyncTwoPass" ? VoiceInputSaucMode.ASYNC_TWO_PASS
      : value.mode === "bidirectional" ? VoiceInputSaucMode.BIDIRECTIONAL : VoiceInputSaucMode.STREAM_INPUT,
    authentication: value.authentication === "apiKey" ? VoiceInputSaucAuthentication.API_KEY : VoiceInputSaucAuthentication.ACCESS_TOKEN });
}

function requireStoredSauc(value: unknown): StoredSaucSettings | null {
  if (value === null) return null;
  const fields = ["mode", "authentication", "appId", "useDictionaryHotwords", "boostingTableName", "boostingTableId", "correctTableName", "correctTableId"];
  if (!isRecord(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || (value["mode"] !== "asyncTwoPass" && value["mode"] !== "bidirectional" && value["mode"] !== "streamInput")
    || (value["authentication"] !== "apiKey" && value["authentication"] !== "accessToken")
    || typeof value["useDictionaryHotwords"] !== "boolean" || typeof value["appId"] !== "string") {
    throw invalid("The SAUC configuration is invalid.");
  }
  const appId = value["appId"].trim();
  if (value["authentication"] === "apiKey" ? appId !== "" : !/^[\x21-\x7e]{1,256}$/u.test(appId)) {
    throw invalid("The SAUC APP ID does not match its authentication.");
  }
  return { mode: value["mode"], authentication: value["authentication"], appId,
    useDictionaryHotwords: value["useDictionaryHotwords"], boostingTableName: requireCorpusReference(value["boostingTableName"]),
    boostingTableId: requireCorpusReference(value["boostingTableId"]), correctTableName: requireCorpusReference(value["correctTableName"]),
    correctTableId: requireCorpusReference(value["correctTableId"]) };
}

function requireCorpusReference(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw invalid("The SAUC corpus reference is invalid.");
  }
  return value.trim();
}

function saucCorpus(value: StoredSaucSettings): SaucCorpusConfiguration {
  return { ...(value.boostingTableName === "" ? {} : { boostingTableName: value.boostingTableName }),
    ...(value.boostingTableId === "" ? {} : { boostingTableId: value.boostingTableId }),
    ...(value.correctTableName === "" ? {} : { correctTableName: value.correctTableName }),
    ...(value.correctTableId === "" ? {} : { correctTableId: value.correctTableId }) };
}

function saucAuthentication(value: StoredSaucSettings, secret: string): SaucAuthentication {
  return value.authentication === "apiKey" ? { type: "apiKey", apiKey: secret }
    : { type: "accessToken", appId: value.appId, accessToken: secret };
}

function saucCredentialAuthorityChanged(before: StoredSaucSettings | null, after: StoredSaucSettings | null): boolean {
  return before?.authentication !== after?.authentication || before?.appId !== after?.appId;
}

/** Holds all start-only fallback captures and releases even the unselected transports. */
class CapturedTranscriptionProvider implements AsrProvider {
  #stopped = false;
  #stopTask: Promise<void> | undefined;
  constructor(private readonly delegate: AsrProvider, private readonly providers: AsrProvider[],
    private readonly isCurrent: () => boolean) {}

  async start(request: AsrStartRequest): Promise<void> {
    this.#assertCurrent();
    await this.delegate.start(request);
    if (!this.isCurrent()) { await this.stop(); throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable."); }
  }
  appendAudio(chunk: AudioChunk): void {
    if (this.#stopped) return;
    if (!this.isCurrent()) { void this.stop().catch(() => undefined); return; }
    this.delegate.appendAudio(chunk);
  }
  async flushAudio(): Promise<void> { this.#assertCurrent(); await this.delegate.flushAudio(); this.#assertCurrent(); }
  async recover(): Promise<void> {
    this.#assertCurrent();
    if (this.delegate.recover === undefined) throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable.");
    await this.delegate.recover();
    this.#assertCurrent();
  }
  onEvent(listener: (event: AsrEvent) => void): () => void {
    return this.delegate.onEvent((event) => { if (!this.#stopped && this.isCurrent()) listener(event); });
  }
  stop(): Promise<void> {
    if (this.#stopTask !== undefined) return this.#stopTask;
    this.#stopped = true;
    const providers = new Set([this.delegate, ...this.providers]);
    this.providers.length = 0;
    this.#stopTask = Promise.allSettled([...providers].map((provider) => provider.stop())).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.#stopTask;
  }
  #assertCurrent(): void {
    if (this.#stopped || !this.isCurrent()) throw new VoiceInputSettingsError("credential_unavailable", "Voice input transcription is unavailable.");
  }
}

function decodeSettings(value: unknown): StoredVoiceInputSettings {
  const fields = ["format", "enabled", "protocol", "endpoint", "model", "resourceId", "sauc", "credentialReferenceId", "keyless",
    "refinementEnabled", "refinerModel", "refinerFallbackModel", "fallbackEnabled", "fallbackProtocol", "fallbackEndpoint",
    "fallbackModel", "fallbackResourceId", "fallbackSauc", "fallbackCredentialReferenceId", "fallbackKeyless"];
  if (!isRecord(value) || value["format"] !== 1 || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) throw invalid("Stored voice input settings are invalid.");
  return validateSettings({
    format: 1,
    enabled: value["enabled"],
    protocol: value["protocol"],
    endpoint: value["endpoint"],
    model: value["model"],
    resourceId: value["resourceId"],
    sauc: value["sauc"],
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
    fallbackSauc: value["fallbackSauc"],
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
  readonly sauc: unknown;
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
  readonly fallbackSauc: unknown;
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
  const sauc = requireStoredSauc(value.sauc);
  const fallbackSauc = requireStoredSauc(value.fallbackSauc);
  try {
    route = validateTranscriptionRoute(value.protocol, value.endpoint, value.model, value.resourceId, value.keyless, sauc);
    fallbackRoute = validateTranscriptionRoute(value.fallbackProtocol, value.fallbackEndpoint, value.fallbackModel, value.fallbackResourceId, value.fallbackKeyless, fallbackSauc);
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
    sauc,
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
    fallbackSauc,
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
  keyless: boolean,
  sauc: StoredSaucSettings | null
): { readonly endpoint: string; readonly model: string; readonly resourceId: string } {
  if (protocol === "volcengineSauc") {
    if (model !== "" || keyless || sauc === null) throw invalid("SAUC requires a resource ID, mode and managed authentication.");
    const route = validateSaucTranscriptionConfiguration({ endpoint, resourceId, mode: sauc.mode, corpus: saucCorpus(sauc) });
    return { endpoint: route.endpoint, model: "", resourceId: route.resourceId };
  }
  if (resourceId !== "" || sauc !== null) throw invalid("This transcription protocol does not use SAUC configuration.");
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
