import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { VoiceInputFailureCode as NativeFailureCode } from "@joko/voice-input";
import { toProtoDuration, toProtoTimestamp } from "./proto-mapper.js";
import {
  VOICE_INPUT_LIMITS,
  VoiceInputControlError,
  type VoiceInputCapabilitySnapshot,
  type VoiceInputCoordinator,
  type VoiceInputSessionSnapshot
} from "./voice-input-coordinator.js";
import type { VoiceInputConnectionTestResult, VoiceInputSettingsController } from "./voice-input-settings.js";

export interface VoiceInputRpcOwner {
  readonly connectionId: string;
}

export function createVoiceInputConnectService(
  coordinator: VoiceInputCoordinator | undefined,
  settings: Pick<VoiceInputSettingsController, "adviseDictionaryEdit" | "testConnection"> | undefined,
  authenticate: (context: HandlerContext) => VoiceInputRpcOwner
): ServiceImpl<typeof contract.VoiceInputService> {
  return {
    getVoiceInputCapabilities: async (_request, context) => voiceRpc(async () => {
      authenticate(context);
      return create(contract.GetVoiceInputCapabilitiesResponseSchema, {
        profile: toProtoCapability(coordinator?.capabilities() ?? unsupportedCapability())
      });
    }),
    testVoiceInputConnection: async (_request, context) => voiceRpc(async () => {
      authenticate(context);
      const result = await requireSettings(settings).testConnection();
      return create(contract.TestVoiceInputConnectionResponseSchema, {
        ok: result.ok,
        failure: toProtoConnectionTestFailure(result)
      });
    }),
    adviseVoiceInputDictionaryEdit: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      const result = await requireSettings(settings).adviseDictionaryEdit({
        beforeText: request.beforeText,
        afterText: request.afterText,
        ...(request.rawTranscriptText === undefined ? {} : { rawTranscriptText: request.rawTranscriptText }),
        ...(request.locale === undefined ? {} : { locale: request.locale }),
        existingEntries: request.existingEntries.map((entry) => ({
          term: entry.term,
          source: entry.source === contract.VoiceInputDictionaryEntrySource.AUTOMATIC ? "automatic" : "manual",
          frequency: entry.frequency,
          aliases: entry.aliases.map((alias) => ({ text: alias.text, count: alias.count }))
        })),
        existingCandidates: request.existingCandidates.map((candidate) => ({
          term: candidate.term,
          evidenceCount: candidate.evidenceCount,
          aliases: candidate.aliases.map((alias) => ({ text: alias.text, count: alias.count }))
        }))
      }, context.signal);
      return create(contract.AdviseVoiceInputDictionaryEditResponseSchema, {
        actions: result.actions.map((action) => create(contract.VoiceInputDictionaryLearningActionSchema, {
          action: toProtoDictionaryAction(action.action),
          term: action.term,
          aliases: [...action.aliases],
          termType: toProtoDictionaryTermType(action.type),
          confidence: action.confidence === "high"
            ? contract.VoiceInputDictionaryLearningConfidence.HIGH
            : contract.VoiceInputDictionaryLearningConfidence.MEDIUM
        }))
      });
    }),
    startVoiceInput: async (request, context) => voiceRpc(async () => {
      const owner = authenticate(context);
      const session = await requireCoordinator(coordinator).start({
        ownerConnectionId: owner.connectionId,
        requestId: request.requestId,
        mimeType: request.mimeType,
        ...(request.locale === undefined ? {} : { locale: request.locale }),
        ...(request.refinementInstructions === undefined ? {} : { refinementInstructions: request.refinementInstructions }),
        dictionaryTerms: request.dictionaryTerms
      });
      return create(contract.StartVoiceInputResponseSchema, { session: toProtoSession(session) });
    }),
    appendVoiceAudio: async (request, context) => voiceRpc(async () => {
      const owner = authenticate(context);
      const session = requireCoordinator(coordinator).append({
        ownerConnectionId: owner.connectionId,
        voiceInputId: request.voiceInputId,
        chunkSequence: request.chunkSequence,
        audio: request.audio,
        durationMs: request.durationMs,
        voiced: request.voiced
      });
      return create(contract.AppendVoiceAudioResponseSchema, { session: toProtoSession(session) });
    }),
    stopVoiceInput: async (request, context) => voiceRpc(async () => {
      const owner = authenticate(context);
      const session = await requireCoordinator(coordinator).stop({
        ownerConnectionId: owner.connectionId,
        voiceInputId: request.voiceInputId,
        expectedNextChunkSequence: request.expectedNextChunkSequence
      });
      return create(contract.StopVoiceInputResponseSchema, { session: toProtoSession(session) });
    }),
    cancelVoiceInput: async (request, context) => voiceRpc(async () => {
      const owner = authenticate(context);
      const session = await requireCoordinator(coordinator).cancel({
        ownerConnectionId: owner.connectionId,
        voiceInputId: request.voiceInputId
      });
      return create(contract.CancelVoiceInputResponseSchema, { session: toProtoSession(session) });
    }),
    getVoiceInputSession: async (request, context) => voiceRpc(async () => {
      const owner = authenticate(context);
      const session = requireCoordinator(coordinator).get({
        ownerConnectionId: owner.connectionId,
        voiceInputId: request.voiceInputId
      });
      return create(contract.GetVoiceInputSessionResponseSchema, { session: toProtoSession(session) });
    })
  } satisfies ServiceImpl<typeof contract.VoiceInputService>;
}

function toProtoCapability(value: VoiceInputCapabilitySnapshot): contract.VoiceInputCapabilityProfile {
  return create(contract.VoiceInputCapabilityProfileSchema, {
    capability: create(contract.CapabilitySchema, {
      name: contract.capabilityNames.voiceInput,
      support: toProtoSupport(value.support),
      reason: value.support === "supported" ? "" : value.support,
      options: create(contract.CapabilityOptionsSchema, {
        kind: {
          case: "input",
          value: create(contract.InputCapabilityOptionsSchema, {
            mediaTypes: [...value.mimeTypes],
            maximumBytes: BigInt(VOICE_INPUT_LIMITS.maximumAudioBytes),
            maximumItems: 0
          })
        }
      })
    }),
    limits: create(contract.VoiceInputLimitsSchema, {
      supportedMimeTypes: [...value.mimeTypes],
      maximumAudioChunkBytes: BigInt(VOICE_INPUT_LIMITS.maximumAudioChunkBytes),
      maximumAudioBytes: BigInt(VOICE_INPUT_LIMITS.maximumAudioBytes),
      maximumAudioChunkDuration: toProtoDuration(VOICE_INPUT_LIMITS.maximumAudioChunkDurationMs),
      maximumAudioDuration: toProtoDuration(VOICE_INPUT_LIMITS.maximumAudioDurationMs),
      maximumLocaleCharacters: VOICE_INPUT_LIMITS.maximumLocaleCharacters,
      stableWait: toProtoDuration(VOICE_INPUT_LIMITS.stableWaitMs),
      maximumConcurrentSessions: value.maximumConcurrentSessions
    }),
    supportsLocale: value.supportsLocale,
    supportsLiveDrafts: value.supportsLiveDrafts,
    supportsRefinement: value.supportsRefinement
  });
}

function toProtoSession(value: VoiceInputSessionSnapshot): contract.VoiceInputSession {
  return create(contract.VoiceInputSessionSchema, {
    voiceInputId: value.id,
    state: toProtoState(value.state),
    outcome: toProtoOutcome(value.outcome),
    draft: value.draft === undefined
      ? undefined
      : create(contract.VoiceInputDraftSchema, {
          text: value.draft.text,
          source: toProtoSource(value.draft.source)
        }),
    result: value.result === undefined
      ? undefined
      : create(contract.VoiceInputResultSchema, {
          text: value.result.text,
          source: toProtoSource(value.result.source),
          salvaged: value.result.salvaged,
          ...(value.result.rawTranscriptText === undefined ? {} : { rawTranscriptText: value.result.rawTranscriptText })
        }),
    failure: value.failure === undefined
      ? undefined
      : create(contract.VoiceInputFailureSchema, {
          code: toProtoFailureCode(value.failure.code),
          transcriptKept: value.failure.transcriptKept
        }),
    nextChunkSequence: value.nextChunkSequence,
    acceptedAudioBytes: BigInt(value.acceptedAudioBytes),
    acceptedAudioDuration: toProtoDuration(value.acceptedAudioDurationMs),
    createdAt: toProtoTimestamp(value.createdAt),
    updatedAt: toProtoTimestamp(value.updatedAt),
    recoveryAttempts: value.recoveryAttempts,
    stallWarning: value.stallWarning
  });
}

function toProtoSupport(value: VoiceInputCapabilitySnapshot["support"]): contract.CapabilitySupport {
  switch (value) {
    case "supported": return contract.CapabilitySupport.SUPPORTED;
    case "upstream_missing": return contract.CapabilitySupport.UPSTREAM_MISSING;
    case "not_implemented": return contract.CapabilitySupport.NOT_IMPLEMENTED;
    case "platform_limited": return contract.CapabilitySupport.PLATFORM_LIMITED;
    case "disabled_by_policy": return contract.CapabilitySupport.DISABLED_BY_POLICY;
    case "temporarily_unavailable": return contract.CapabilitySupport.TEMPORARILY_UNAVAILABLE;
  }
}

function toProtoState(value: VoiceInputSessionSnapshot["state"]): contract.VoiceInputState {
  switch (value) {
    case "idle": return contract.VoiceInputState.IDLE;
    case "listening": return contract.VoiceInputState.LISTENING;
    case "submitting": return contract.VoiceInputState.SUBMITTING;
    case "refining": return contract.VoiceInputState.REFINING;
    case "done": return contract.VoiceInputState.DONE;
    case "error": return contract.VoiceInputState.ERROR;
  }
}

function toProtoOutcome(value: VoiceInputSessionSnapshot["outcome"]): contract.VoiceInputTerminalOutcome {
  switch (value) {
    case undefined: return contract.VoiceInputTerminalOutcome.UNSPECIFIED;
    case "success": return contract.VoiceInputTerminalOutcome.SUCCESS;
    case "no_speech": return contract.VoiceInputTerminalOutcome.NO_SPEECH;
    case "failed": return contract.VoiceInputTerminalOutcome.FAILED;
    case "cancelled": return contract.VoiceInputTerminalOutcome.CANCELLED;
  }
}

function toProtoSource(value: "partial" | "stable"): contract.VoiceInputTextSource {
  return value === "stable" ? contract.VoiceInputTextSource.STABLE : contract.VoiceInputTextSource.PARTIAL;
}

function toProtoFailureCode(value: NativeFailureCode): contract.VoiceInputFailureCode {
  switch (value) {
    case "connection_interrupted": return contract.VoiceInputFailureCode.CONNECTION_INTERRUPTED;
    case "empty_transcript": return contract.VoiceInputFailureCode.EMPTY_TRANSCRIPT;
    case "host_submission_failed": return contract.VoiceInputFailureCode.HOST_SUBMISSION_FAILED;
    case "provider_authentication": return contract.VoiceInputFailureCode.PROVIDER_AUTHENTICATION;
    case "provider_close_failed": return contract.VoiceInputFailureCode.PROVIDER_CLOSE_FAILED;
    case "provider_error": return contract.VoiceInputFailureCode.PROVIDER_ERROR;
    case "provider_flush_failed": return contract.VoiceInputFailureCode.PROVIDER_FLUSH_FAILED;
    case "provider_protocol": return contract.VoiceInputFailureCode.PROVIDER_PROTOCOL;
    case "provider_quota": return contract.VoiceInputFailureCode.PROVIDER_QUOTA;
    case "provider_start_failed": return contract.VoiceInputFailureCode.PROVIDER_START_FAILED;
  }
}

function unsupportedCapability(): VoiceInputCapabilitySnapshot {
  return {
    support: "not_implemented",
    mimeTypes: [],
    supportsLocale: false,
    supportsLiveDrafts: true,
    supportsRefinement: false,
    maximumConcurrentSessions: 0
  };
}

function requireCoordinator(value: VoiceInputCoordinator | undefined): VoiceInputCoordinator {
  if (value === undefined) throw new VoiceInputControlError("not_supported");
  return value;
}

function requireSettings(
  value: Pick<VoiceInputSettingsController, "adviseDictionaryEdit" | "testConnection"> | undefined
): Pick<VoiceInputSettingsController, "adviseDictionaryEdit" | "testConnection"> {
  if (value === undefined) throw new VoiceInputControlError("not_supported");
  return value;
}

function toProtoDictionaryAction(
  value: "add_candidate" | "add_entry" | "update_entry"
): contract.VoiceInputDictionaryLearningActionType {
  switch (value) {
    case "add_candidate": return contract.VoiceInputDictionaryLearningActionType.ADD_CANDIDATE;
    case "add_entry": return contract.VoiceInputDictionaryLearningActionType.ADD_ENTRY;
    case "update_entry": return contract.VoiceInputDictionaryLearningActionType.UPDATE_ENTRY;
  }
}

function toProtoDictionaryTermType(
  value: "product_name" | "project_name" | "technical_term" | "person_name" | "team_name" | "code_name" | "phrase" | "other"
): contract.VoiceInputDictionaryTermType {
  switch (value) {
    case "product_name": return contract.VoiceInputDictionaryTermType.PRODUCT_NAME;
    case "project_name": return contract.VoiceInputDictionaryTermType.PROJECT_NAME;
    case "technical_term": return contract.VoiceInputDictionaryTermType.TECHNICAL_TERM;
    case "person_name": return contract.VoiceInputDictionaryTermType.PERSON_NAME;
    case "team_name": return contract.VoiceInputDictionaryTermType.TEAM_NAME;
    case "code_name": return contract.VoiceInputDictionaryTermType.CODE_NAME;
    case "phrase": return contract.VoiceInputDictionaryTermType.PHRASE;
    case "other": return contract.VoiceInputDictionaryTermType.OTHER;
  }
}

function toProtoConnectionTestFailure(
  value: VoiceInputConnectionTestResult
): contract.VoiceInputConnectionTestFailure {
  if (value.ok) return contract.VoiceInputConnectionTestFailure.UNSPECIFIED;
  switch (value.reason) {
    case "credentialsMissing": return contract.VoiceInputConnectionTestFailure.CREDENTIALS_MISSING;
    case "authenticationFailed": return contract.VoiceInputConnectionTestFailure.AUTHENTICATION_FAILED;
    case "routeUnavailable": return contract.VoiceInputConnectionTestFailure.ROUTE_UNAVAILABLE;
    case "timeout": return contract.VoiceInputConnectionTestFailure.TIMEOUT;
    case "network": return contract.VoiceInputConnectionTestFailure.NETWORK;
    case "serviceError": return contract.VoiceInputConnectionTestFailure.SERVICE_ERROR;
  }
  return contract.VoiceInputConnectionTestFailure.SERVICE_ERROR;
}

async function voiceRpc<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (!(error instanceof VoiceInputControlError)) throw error;
    const code = error.code === "invalid_argument" ? Code.InvalidArgument
      : error.code === "not_found" ? Code.NotFound
        : error.code === "not_supported" ? Code.Unimplemented
          : error.code === "provider_unavailable" ? Code.Unavailable
            : error.code === "resource_exhausted" ? Code.ResourceExhausted
              : Code.Aborted;
    throw new ConnectError(error.message, code);
  }
}
