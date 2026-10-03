import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_STABLE_WAIT_MS,
  MAXIMUM_AUDIO_BYTES,
  MAXIMUM_AUDIO_CHUNK_BYTES,
  MAXIMUM_AUDIO_CHUNK_DURATION_MS,
  MAXIMUM_AUDIO_DURATION_MS,
  MAXIMUM_LOCALE_CHARACTERS,
  MAXIMUM_RECOGNITION_CONTEXT_ITEMS,
  MAXIMUM_RECOGNITION_CONTEXT_ITEM_BYTES,
  MAXIMUM_RECOGNITION_CONTEXT_BYTES,
  VoiceInputBoundsError,
  VoiceInputController,
  VoiceInputOperationError,
  normalizeDictionaryTerms,
  normalizeLocale,
  normalizeMimeType,
  normalizeRefinementInstructions,
  normalizeRecognitionContext,
  type AsrProvider,
  type AsrRecognitionContext,
  type SupportedAudioMimeType,
  type VoiceRefiner,
  type VoiceInputFailure,
  type VoiceInputState,
  type VoiceInputTerminalOutcome
} from "@joko/voice-input";

export type VoiceInputCapabilitySupport =
  | "supported"
  | "upstream_missing"
  | "not_implemented"
  | "platform_limited"
  | "disabled_by_policy"
  | "temporarily_unavailable";

export interface VoiceInputProviderCapability {
  readonly support: VoiceInputCapabilitySupport;
  readonly mimeTypes: readonly string[];
  readonly supportsLocale: boolean;
  readonly supportedLocales?: readonly string[];
  readonly supportsRecognitionContext?: boolean;
  readonly supportsLiveDrafts?: boolean;
  readonly supportsRefinement?: boolean;
}

/** Provider credentials remain private to this factory and never cross this port. */
export interface VoiceInputProviderFactory {
  describe(): VoiceInputProviderCapability;
  create(input: {
    readonly mimeType: SupportedAudioMimeType;
    readonly locale?: string;
    readonly recognitionContext?: AsrRecognitionContext;
  }): Promise<AsrProvider> | AsrProvider;
  createRefiner?(input: {
    readonly locale?: string;
    readonly refinementInstructions?: string;
    readonly dictionaryTerms: readonly string[];
  }): Promise<VoiceRefiner | undefined> | VoiceRefiner | undefined;
}

export interface VoiceInputCapabilitySnapshot {
  readonly support: VoiceInputCapabilitySupport;
  readonly mimeTypes: readonly SupportedAudioMimeType[];
  readonly supportsLocale: boolean;
  readonly supportedLocales: readonly string[];
  readonly supportsRecognitionContext: boolean;
  readonly supportsLiveDrafts: boolean;
  readonly supportsRefinement: boolean;
  readonly maximumConcurrentSessions: number;
}

export interface VoiceInputDraftSnapshot {
  readonly text: string;
  readonly source: "partial" | "stable";
}

export interface VoiceInputResultSnapshot {
  readonly text: string;
  readonly source: "partial" | "stable";
  readonly salvaged: boolean;
  readonly rawTranscriptText?: string;
}

export interface VoiceInputSessionSnapshot {
  readonly id: string;
  readonly state: VoiceInputState;
  readonly outcome?: VoiceInputTerminalOutcome;
  readonly draft?: VoiceInputDraftSnapshot;
  readonly result?: VoiceInputResultSnapshot;
  readonly failure?: VoiceInputFailure;
  readonly nextChunkSequence: bigint;
  readonly acceptedAudioBytes: number;
  readonly acceptedAudioDurationMs: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recoveryAttempts: number;
  readonly stallWarning: boolean;
}

export type VoiceInputControlErrorCode =
  | "conflict"
  | "invalid_argument"
  | "not_found"
  | "not_supported"
  | "provider_unavailable"
  | "resource_exhausted";

export class VoiceInputControlError extends Error {
  readonly code: VoiceInputControlErrorCode;

  constructor(code: VoiceInputControlErrorCode) {
    super(VOICE_CONTROL_ERROR_MESSAGES[code]);
    this.name = "VoiceInputControlError";
    this.code = code;
  }
}

interface VoiceInputRecord {
  readonly id: string;
  readonly ownerConnectionId: string;
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  controller?: VoiceInputController;
  state: VoiceInputState;
  outcome?: VoiceInputTerminalOutcome;
  draft?: VoiceInputDraftSnapshot;
  result?: VoiceInputResultSnapshot;
  submittedText?: string;
  failure?: VoiceInputFailure;
  resultRevision: number;
  nextChunkSequence: bigint;
  acceptedAudioBytes: number;
  acceptedAudioDurationMs: number;
  drainDeadlineAt?: number;
  drainTimer?: ReturnType<typeof setTimeout>;
  updatedAt: number;
  recoveryAttempts: number;
  stallWarning: boolean;
  disposeOwner?: () => void;
}

interface PendingStart {
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly promise: Promise<VoiceInputSessionSnapshot>;
}

export interface VoiceInputCoordinatorOptions {
  readonly provider?: VoiceInputProviderFactory;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly maximumConcurrentSessions?: number;
  readonly terminalRetentionMs?: number;
  readonly maximumSessionAgeMs?: number;
  readonly onOwnerRetired?: (ownerConnectionId: string, listener: () => void) => () => void;
}

const VOICE_CONTROL_ERROR_MESSAGES: Readonly<Record<VoiceInputControlErrorCode, string>> = {
  conflict: "Voice input state changed before this request could be applied.",
  invalid_argument: "The Voice input request is invalid.",
  not_found: "The Voice input session was not found.",
  not_supported: "Voice input is not currently supported.",
  provider_unavailable: "Voice input is temporarily unavailable.",
  resource_exhausted: "The Voice input session limit has been reached."
};

const DEFAULT_MAXIMUM_CONCURRENT_SESSIONS = 8;
const DEFAULT_TERMINAL_RETENTION_MS = 2 * 60_000;
const DEFAULT_MAXIMUM_SESSION_AGE_MS = 12 * 60_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Owns only ephemeral Voice sessions. It has no Store, EventHub, filesystem,
 * logger, or credential dependency, so audio and text cannot become durable.
 */
export class VoiceInputCoordinator {
  private readonly provider: VoiceInputProviderFactory | undefined;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maximumConcurrentSessions: number;
  private readonly terminalRetentionMs: number;
  private readonly maximumSessionAgeMs: number;
  private readonly onOwnerRetired: VoiceInputCoordinatorOptions["onOwnerRetired"];
  private readonly sessions = new Map<string, VoiceInputRecord>();
  private readonly requests = new Map<string, string>();
  private readonly activeByOwner = new Map<string, string>();
  private readonly pendingByOwner = new Map<string, PendingStart>();
  private closed = false;
  private providerGeneration = 0;

  constructor(options: VoiceInputCoordinatorOptions = {}) {
    this.provider = options.provider;
    this.onOwnerRetired = options.onOwnerRetired;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.maximumConcurrentSessions = boundedPositiveInteger(
      options.maximumConcurrentSessions ?? DEFAULT_MAXIMUM_CONCURRENT_SESSIONS,
      1,
      64
    );
    this.terminalRetentionMs = boundedPositiveInteger(
      options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS,
      1_000,
      60 * 60_000
    );
    this.maximumSessionAgeMs = boundedPositiveInteger(
      options.maximumSessionAgeMs ?? DEFAULT_MAXIMUM_SESSION_AGE_MS,
      60_000,
      60 * 60_000
    );
  }

  capabilities(): VoiceInputCapabilitySnapshot {
    if (this.closed || this.provider === undefined) return unsupportedCapability("not_implemented", this.maximumConcurrentSessions);
    let described: VoiceInputProviderCapability;
    try {
      described = this.provider.describe();
    } catch {
      return unsupportedCapability("temporarily_unavailable", this.maximumConcurrentSessions);
    }
    if (described.support !== "supported") {
      return unsupportedCapability(described.support, this.maximumConcurrentSessions);
    }
    try {
      const mimeTypes = [...new Set(described.mimeTypes.map(normalizeMimeType))];
      if (mimeTypes.length === 0) return unsupportedCapability("temporarily_unavailable", this.maximumConcurrentSessions);
      return {
        support: "supported",
        mimeTypes,
        supportsLocale: described.supportsLocale,
        supportedLocales: described.supportsLocale ? [...new Set((described.supportedLocales ?? []).map((locale) => {
          const value = normalizeLocale(locale);
          if (value === undefined) throw new VoiceInputBoundsError("locale");
          return value;
        }))] : [],
        supportsRecognitionContext: described.supportsRecognitionContext ?? false,
        supportsLiveDrafts: described.supportsLiveDrafts ?? true,
        supportsRefinement: described.supportsRefinement ?? false,
        maximumConcurrentSessions: this.maximumConcurrentSessions
      };
    } catch {
      return unsupportedCapability("temporarily_unavailable", this.maximumConcurrentSessions);
    }
  }

  async start(input: {
    readonly ownerConnectionId: string;
    readonly requestId: string;
    readonly mimeType: string;
    readonly locale?: string;
    readonly refinementInstructions?: string;
    readonly dictionaryTerms?: readonly string[];
    readonly recognitionContext?: AsrRecognitionContext;
    readonly signal?: AbortSignal;
  }): Promise<VoiceInputSessionSnapshot> {
    this.assertOpen();
    this.sweepExpired();
    const ownerConnectionId = requireIdentifier(input.ownerConnectionId);
    const requestId = requireRequestId(input.requestId);
    let mimeType: SupportedAudioMimeType;
    let locale: string | undefined;
    let refinementInstructions: string | undefined;
    let dictionaryTerms: readonly string[];
    let recognitionContext: AsrRecognitionContext | undefined;
    try {
      mimeType = normalizeMimeType(input.mimeType);
      locale = normalizeLocale(input.locale);
      refinementInstructions = normalizeRefinementInstructions(input.refinementInstructions);
      dictionaryTerms = normalizeDictionaryTerms(input.dictionaryTerms);
      recognitionContext = normalizeRecognitionContext(input.recognitionContext);
    } catch (error) {
      throw boundsControlError(error);
    }
    if (input.signal?.aborted) throw new VoiceInputControlError("provider_unavailable");
    const fingerprint = voiceRequestFingerprint({ mimeType, locale, refinementInstructions, dictionaryTerms, recognitionContext });
    const requestKey = `${ownerConnectionId}\u0000${requestId}`;
    const priorId = this.requests.get(requestKey);
    if (priorId !== undefined) {
      const prior = this.sessions.get(priorId);
      if (prior === undefined) this.requests.delete(requestKey);
      else {
        if (prior.fingerprint !== fingerprint) throw new VoiceInputControlError("conflict");
        return Promise.resolve(snapshot(prior));
      }
    }
    const pending = this.pendingByOwner.get(ownerConnectionId);
    if (pending !== undefined) {
      if (pending.requestKey === requestKey && pending.fingerprint === fingerprint) return pending.promise;
      throw new VoiceInputControlError("conflict");
    }
    const activeId = this.activeByOwner.get(ownerConnectionId);
    if (activeId !== undefined && this.sessions.get(activeId)?.outcome === undefined) {
      throw new VoiceInputControlError("conflict");
    }

    const promise = this.beginStart({
      ownerConnectionId,
      requestKey,
      fingerprint,
      mimeType,
      locale,
      refinementInstructions,
      dictionaryTerms,
      recognitionContext,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
      .finally(() => {
        if (this.pendingByOwner.get(ownerConnectionId)?.promise === promise) {
          this.pendingByOwner.delete(ownerConnectionId);
        }
      });
    this.pendingByOwner.set(ownerConnectionId, { requestKey, fingerprint, promise });
    return promise;
  }

  append(input: {
    readonly ownerConnectionId: string;
    readonly voiceInputId: string;
    readonly chunkSequence: bigint;
    readonly audio: Uint8Array;
    readonly durationMs: number;
    readonly voiced: boolean;
  }): VoiceInputSessionSnapshot {
    this.assertOpen();
    this.sweepExpired();
    const record = this.ownedRecord(input.ownerConnectionId, input.voiceInputId);
    if (record.outcome !== undefined || record.state !== "listening" || record.controller === undefined) {
      throw new VoiceInputControlError("conflict");
    }
    if (input.chunkSequence !== record.nextChunkSequence) throw new VoiceInputControlError("conflict");
    if (!(input.audio instanceof Uint8Array)) throw new VoiceInputControlError("invalid_argument");
    const audio = Uint8Array.from(input.audio).buffer;
    try {
      record.controller.appendAudio({ data: audio, durationMs: input.durationMs, voiced: input.voiced });
    } catch (error) {
      if (error instanceof VoiceInputBoundsError) throw new VoiceInputControlError("invalid_argument");
      if (error instanceof VoiceInputOperationError) return snapshot(record);
      throw new VoiceInputControlError("provider_unavailable");
    }
    record.acceptedAudioBytes += input.audio.byteLength;
    record.acceptedAudioDurationMs += input.durationMs;
    record.nextChunkSequence += 1n;
    record.updatedAt = this.now();
    return snapshot(record);
  }

  async stop(input: {
    readonly ownerConnectionId: string;
    readonly voiceInputId: string;
    readonly expectedNextChunkSequence: bigint;
  }): Promise<VoiceInputSessionSnapshot> {
    this.assertOpen();
    this.sweepExpired();
    const record = this.ownedRecord(input.ownerConnectionId, input.voiceInputId);
    if (input.expectedNextChunkSequence !== record.nextChunkSequence) {
      throw new VoiceInputControlError("conflict");
    }
    if (record.outcome === undefined && record.state === "listening" && record.drainDeadlineAt === undefined) {
      this.beginDrainDeadline(record);
    }
    await record.controller?.stop();
    return snapshot(record);
  }

  async cancel(input: {
    readonly ownerConnectionId: string;
    readonly voiceInputId: string;
  }): Promise<VoiceInputSessionSnapshot> {
    this.assertOpen();
    this.sweepExpired();
    const record = this.ownedRecord(input.ownerConnectionId, input.voiceInputId);
    await record.controller?.cancel();
    return snapshot(record);
  }

  get(input: { readonly ownerConnectionId: string; readonly voiceInputId: string }): VoiceInputSessionSnapshot {
    this.assertOpen();
    this.sweepExpired();
    return snapshot(this.ownedRecord(input.ownerConnectionId, input.voiceInputId));
  }

  async retireProviderConfiguration(): Promise<void> {
    this.providerGeneration += 1;
    await Promise.all([...this.sessions.values()].filter((record) => record.outcome === undefined)
      .map((record) => record.controller?.cancel().catch(() => undefined)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.sessions.values()];
    for (const record of records) this.clearDrainTimer(record);
    await Promise.all(records.map((record) => record.controller?.cancel().catch(() => undefined)));
    for (const record of records) record.controller?.detach();
    this.sessions.clear();
    this.requests.clear();
    this.activeByOwner.clear();
    this.pendingByOwner.clear();
  }

  private async beginStart(input: {
    readonly ownerConnectionId: string;
    readonly requestKey: string;
    readonly fingerprint: string;
    readonly mimeType: SupportedAudioMimeType;
    readonly locale?: string;
    readonly refinementInstructions?: string;
    readonly dictionaryTerms: readonly string[];
    readonly recognitionContext?: AsrRecognitionContext;
    readonly signal?: AbortSignal;
  }): Promise<VoiceInputSessionSnapshot> {
    const capability = this.capabilities();
    if (capability.support !== "supported") {
      throw new VoiceInputControlError(capability.support === "temporarily_unavailable"
        ? "provider_unavailable"
        : "not_supported");
    }
    if (!capability.mimeTypes.includes(input.mimeType)) throw new VoiceInputControlError("not_supported");
    if (input.locale !== undefined && !capability.supportsLocale) throw new VoiceInputControlError("not_supported");
    if (input.locale !== undefined && capability.supportedLocales.length > 0
      && !capability.supportedLocales.includes(input.locale)) throw new VoiceInputControlError("not_supported");
    if (input.recognitionContext !== undefined && !capability.supportsRecognitionContext) throw new VoiceInputControlError("not_supported");
    if (
      [...this.sessions.values()].filter(({ outcome }) => outcome === undefined).length +
      this.pendingByOwner.size >= this.maximumConcurrentSessions
    ) {
      throw new VoiceInputControlError("resource_exhausted");
    }

    let provider: AsrProvider;
    let refiner: VoiceRefiner | undefined;
    const providerGeneration = this.providerGeneration;
    let retired = input.signal?.aborted === true;
    let activeController: VoiceInputController | undefined;
    const retire = (): void => { retired = true; void activeController?.cancel().catch(() => undefined); };
    const disposeOwner = this.onOwnerRetired?.(input.ownerConnectionId, retire);
    input.signal?.addEventListener("abort", retire, { once: true });
    if (retired) {
      disposeOwner?.();
      input.signal?.removeEventListener("abort", retire);
      throw new VoiceInputControlError("provider_unavailable");
    }
    try {
      provider = await this.provider!.create({
        mimeType: input.mimeType,
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(input.recognitionContext === undefined ? {} : { recognitionContext: input.recognitionContext })
      });
    } catch {
      disposeOwner?.();
      input.signal?.removeEventListener("abort", retire);
      throw new VoiceInputControlError("provider_unavailable");
    }
    if (this.closed || retired || providerGeneration !== this.providerGeneration) {
      disposeOwner?.();
      input.signal?.removeEventListener("abort", retire);
      await provider.stop().catch(() => undefined);
      throw new VoiceInputControlError("provider_unavailable");
    }
    try {
      refiner = await this.provider!.createRefiner?.({
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(input.refinementInstructions === undefined ? {} : { refinementInstructions: input.refinementInstructions }),
        dictionaryTerms: input.dictionaryTerms
      });
    } catch {
      // Refinement is an optional delayed lane. Raw ASR remains usable when
      // its independently authenticated route disappears at session start.
      refiner = undefined;
    }
    if (this.closed || retired || providerGeneration !== this.providerGeneration) {
      disposeOwner?.();
      input.signal?.removeEventListener("abort", retire);
      await provider.stop().catch(() => undefined);
      throw new VoiceInputControlError("provider_unavailable");
    }

    const id = requireIdentifier(this.createId());
    if (this.sessions.has(id)) {
      disposeOwner?.();
      input.signal?.removeEventListener("abort", retire);
      await provider.stop().catch(() => undefined);
      throw new VoiceInputControlError("provider_unavailable");
    }
    const createdAt = this.now();
    const record: VoiceInputRecord = {
      id,
      ownerConnectionId: input.ownerConnectionId,
      requestKey: input.requestKey,
      fingerprint: input.fingerprint,
      createdAt,
      state: "idle",
      nextChunkSequence: 1n,
      acceptedAudioBytes: 0,
      acceptedAudioDurationMs: 0,
      updatedAt: createdAt,
      recoveryAttempts: 0,
      stallWarning: false,
      resultRevision: 0,
      ...(disposeOwner === undefined ? {} : { disposeOwner })
    };
    const touch = (): void => { record.updatedAt = this.now(); };
    let controller: VoiceInputController;
    try {
      controller = new VoiceInputController({
        provider,
        ...(refiner === undefined ? {} : { refiner }),
        createId: () => id,
        callbacks: {
        onStateChanged: (state, outcome) => {
          record.state = state;
          if (outcome !== undefined) {
            this.clearDrainTimer(record);
            record.disposeOwner?.();
            delete record.disposeOwner;
            record.outcome = outcome;
            record.draft = undefined;
            if (this.activeByOwner.get(record.ownerConnectionId) === record.id) {
              this.activeByOwner.delete(record.ownerConnectionId);
            }
          }
          touch();
        },
        onDraftChanged: (text, _segment, source) => {
          record.draft = { text, source };
          touch();
        },
        onSubmitted: (submission) => {
          record.result = { text: submission.text, source: submission.source, salvaged: submission.salvaged };
          record.submittedText = submission.text;
          record.resultRevision = 0;
          record.draft = undefined;
          touch();
          return {
            id: `result-${record.id}`,
            startOffset: 0,
            endOffset: submission.text.length,
            revision: 0
          };
        },
        inspectEditorRange: (range) => ({
          exists: record.result !== undefined,
          revision: record.resultRevision,
          userEdited: range.userEdited === true
        }),
        applyRefinement: ({ expectedRevision, refinedText }) => {
          if (record.result === undefined) return { applied: false, reason: "range_missing" };
          if (expectedRevision !== record.resultRevision) return { applied: false, reason: "stale_revision" };
          record.result = {
            ...record.result,
            text: refinedText,
            ...(record.submittedText === undefined || record.submittedText === refinedText
              ? {}
              : { rawTranscriptText: record.submittedText })
          };
          record.resultRevision += 1;
          touch();
          return { applied: true, revision: record.resultRevision };
        },
        onError: (failure) => {
          record.failure = failure;
          touch();
        },
        onDiagnostic: (event) => {
          if (event.type === "recovery_attempted") record.recoveryAttempts = event.attempt;
          if (event.type === "stall_warning") record.stallWarning = true;
          touch();
        }
        }
      });
    } catch {
      disposeOwner?.();
      input.signal?.removeEventListener("abort", retire);
      await provider.stop().catch(() => undefined);
      throw new VoiceInputControlError("provider_unavailable");
    }
    record.controller = controller;
    activeController = controller;
    this.sessions.set(id, record);
    this.requests.set(input.requestKey, id);
    this.activeByOwner.set(input.ownerConnectionId, id);
    try {
      await controller.start({ mimeType: input.mimeType, ...(input.locale === undefined ? {} : { locale: input.locale }) });
    } catch (error) {
      if (!(error instanceof VoiceInputOperationError)) {
        this.remove(record);
        throw new VoiceInputControlError("provider_unavailable");
      }
    } finally {
      input.signal?.removeEventListener("abort", retire);
    }
    if (retired || providerGeneration !== this.providerGeneration) {
      await controller.cancel();
      throw new VoiceInputControlError("provider_unavailable");
    }
    return snapshot(record);
  }

  private ownedRecord(ownerConnectionId: string, voiceInputId: string): VoiceInputRecord {
    const owner = requireIdentifier(ownerConnectionId);
    const id = requireIdentifier(voiceInputId);
    const record = this.sessions.get(id);
    if (record === undefined || record.ownerConnectionId !== owner) throw new VoiceInputControlError("not_found");
    return record;
  }

  private sweepExpired(): void {
    const at = this.now();
    for (const record of [...this.sessions.values()]) {
      const expiresAt = record.outcome === undefined
        ? record.drainDeadlineAt ?? record.createdAt + this.maximumSessionAgeMs
        : record.updatedAt + this.terminalRetentionMs;
      if (at < expiresAt) continue;
      if (record.outcome === undefined) void record.controller?.cancel().catch(() => undefined);
      this.remove(record);
    }
  }

  private beginDrainDeadline(record: VoiceInputRecord): void {
    const budgetMs = Math.max(record.acceptedAudioDurationMs, Math.ceil(record.acceptedAudioBytes / 32)) + 90_000;
    const deadline = this.now() + budgetMs;
    record.drainDeadlineAt = deadline;
    const expire = (): void => {
      if (this.sessions.get(record.id) !== record || record.drainDeadlineAt !== deadline || record.outcome !== undefined) return;
      const remainingMs = deadline - this.now();
      if (remainingMs > 0) {
        record.drainTimer = setTimeout(expire, remainingMs);
        return;
      }
      void record.controller?.cancel().catch(() => undefined);
      this.remove(record);
    };
    record.drainTimer = setTimeout(expire, budgetMs);
  }

  private clearDrainTimer(record: VoiceInputRecord): void {
    if (record.drainTimer === undefined) return;
    clearTimeout(record.drainTimer);
    delete record.drainTimer;
  }

  private remove(record: VoiceInputRecord): void {
    this.clearDrainTimer(record);
    record.disposeOwner?.();
    delete record.disposeOwner;
    record.controller?.detach();
    this.sessions.delete(record.id);
    if (this.requests.get(record.requestKey) === record.id) this.requests.delete(record.requestKey);
    if (this.activeByOwner.get(record.ownerConnectionId) === record.id) {
      this.activeByOwner.delete(record.ownerConnectionId);
    }
    record.draft = undefined;
    record.result = undefined;
    record.submittedText = undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw new VoiceInputControlError("provider_unavailable");
  }
}

export const VOICE_INPUT_LIMITS = Object.freeze({
  maximumAudioChunkBytes: MAXIMUM_AUDIO_CHUNK_BYTES,
  maximumAudioBytes: MAXIMUM_AUDIO_BYTES,
  maximumAudioChunkDurationMs: MAXIMUM_AUDIO_CHUNK_DURATION_MS,
  maximumAudioDurationMs: MAXIMUM_AUDIO_DURATION_MS,
  maximumLocaleCharacters: MAXIMUM_LOCALE_CHARACTERS,
  recognitionContextMaximumItems: MAXIMUM_RECOGNITION_CONTEXT_ITEMS,
  recognitionContextMaximumItemBytes: MAXIMUM_RECOGNITION_CONTEXT_ITEM_BYTES,
  recognitionContextMaximumBytes: MAXIMUM_RECOGNITION_CONTEXT_BYTES,
  stableWaitMs: DEFAULT_STABLE_WAIT_MS
});

function unsupportedCapability(
  support: Exclude<VoiceInputCapabilitySupport, "supported">,
  maximumConcurrentSessions: number
): VoiceInputCapabilitySnapshot {
  return {
    support,
    mimeTypes: [],
    supportsLocale: false,
    supportedLocales: [],
    supportsRecognitionContext: false,
    supportsLiveDrafts: false,
    supportsRefinement: false,
    maximumConcurrentSessions
  };
}

function snapshot(record: VoiceInputRecord): VoiceInputSessionSnapshot {
  return {
    id: record.id,
    state: record.state,
    ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
    ...(record.draft === undefined ? {} : { draft: { ...record.draft } }),
    ...(record.result === undefined ? {} : { result: { ...record.result } }),
    ...(record.failure === undefined ? {} : { failure: { ...record.failure } }),
    nextChunkSequence: record.nextChunkSequence,
    acceptedAudioBytes: record.acceptedAudioBytes,
    acceptedAudioDurationMs: record.acceptedAudioDurationMs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recoveryAttempts: record.recoveryAttempts,
    stallWarning: record.stallWarning
  };
}

function requireIdentifier(value: string): string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw new VoiceInputControlError("invalid_argument");
  }
  return value;
}

function requireRequestId(value: string): string {
  return requireIdentifier(value);
}

function voiceRequestFingerprint(input: {
  readonly mimeType: SupportedAudioMimeType;
  readonly locale?: string;
  readonly refinementInstructions?: string;
  readonly dictionaryTerms: readonly string[];
  readonly recognitionContext?: AsrRecognitionContext;
}): string {
  return createHash("sha256")
    .update(input.mimeType)
    .update("\0")
    .update(input.locale ?? "")
    .update("\0")
    .update(input.refinementInstructions ?? "")
    .update("\0")
    .update(JSON.stringify(input.dictionaryTerms))
    .update("\0")
    .update(JSON.stringify(input.recognitionContext ?? null))
    .digest("hex");
}

function boundsControlError(error: unknown): VoiceInputControlError {
  return error instanceof VoiceInputBoundsError
    ? new VoiceInputControlError("invalid_argument")
    : new VoiceInputControlError("provider_unavailable");
}

function boundedPositiveInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError("Voice input coordinator bound is invalid.");
  }
  return value;
}
