import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { VoiceInputFailureCode as NativeFailureCode } from "@joko/voice-input";
import { VoiceDictionaryPeerStoreError } from "@joko/store";
import { toProtoDuration, toProtoTimestamp } from "./proto-mapper.js";
import {
  VOICE_INPUT_LIMITS,
  VoiceInputControlError,
  type VoiceInputCapabilitySnapshot,
  type VoiceInputCoordinator,
  type VoiceInputSessionSnapshot
} from "./voice-input-coordinator.js";
import type { VoiceInputConnectionTestResult, VoiceInputSettingsController } from "./voice-input-settings.js";
import {
  VoiceDictionarySyncRepositoryError,
  type VoiceDictionarySyncRepository,
  type VoiceDictionaryReadOnlySnapshot,
  type VoiceDictionarySyncSnapshot
} from "./voice-dictionary-sync-repository.js";
import { VoiceDictionaryPeerManagerError, type VoiceDictionaryPeerManager, type VoiceDictionaryPeerStatus } from "./voice-dictionary-peer-manager.js";
import { watchVoiceDictionaryProjection } from "./voice-dictionary-projection-watch.js";

export interface VoiceInputRpcOwner {
  readonly connectionId: string;
}

export function createVoiceInputConnectService(
  coordinator: VoiceInputCoordinator | undefined,
  settings: Pick<VoiceInputSettingsController, "adviseDictionaryEdit" | "testConnection"> | undefined,
  dictionary: Pick<VoiceDictionarySyncRepository,
    "addManualTerms" | "applyLearning" | "deleteEntry" | "editEntry" | "setEnabled" | "snapshot" | "readOnlySnapshot" | "subscribe"> | undefined,
  authenticate: (context: HandlerContext) => VoiceInputRpcOwner,
  peers?: Pick<VoiceDictionaryPeerManager, "status" | "grantCandidate" | "revokePeer" | "syncNow" | "subscribe" |
    "configureListener" | "invitation" | "grantDirectPeer" | "clearPeerRoute">,
  onRevoked?: (connectionId: string, listener: () => void) => () => void,
  shutdownSignal?: AbortSignal
): ServiceImpl<typeof contract.VoiceInputService> {
  return {
    getVoiceInputCapabilities: async (_request, context) => voiceRpc(async () => {
      authenticate(context);
      return create(contract.GetVoiceInputCapabilitiesResponseSchema, {
        profile: toProtoCapability(coordinator?.capabilities() ?? unsupportedCapability())
      });
    }),
    testVoiceInputConnection: async (_request, context) => voiceRpc(async () => {
      const owner = authenticate(context);
      const revoked = new AbortController();
      const unsubscribe = onRevoked?.(owner.connectionId, () => revoked.abort());
      const signal = AbortSignal.any([context.signal, revoked.signal, ...(shutdownSignal === undefined ? [] : [shutdownSignal])]);
      try {
        if (signal.aborted) throw new ConnectError("Voice connection test was cancelled.", Code.Canceled);
        const result = await requireSettings(settings).testConnection(signal);
        if (signal.aborted) throw new ConnectError("Voice connection test was cancelled.", Code.Canceled);
        if (authenticate(context).connectionId !== owner.connectionId) throw new ConnectError("Voice connection authority changed.", Code.PermissionDenied);
        return create(contract.TestVoiceInputConnectionResponseSchema, { ok: result.ok, failure: toProtoConnectionTestFailure(result) });
      } finally { unsubscribe?.(); }
    }),
    getVoiceInputDictionary: async (_request, context) => voiceRpc(async () => {
      authenticate(context);
      return create(contract.GetVoiceInputDictionaryResponseSchema, {
        dictionary: toProtoDictionarySnapshot(requireDictionary(dictionary).snapshot())
      });
    }),
    watchVoiceInputDictionary: async function* (_request, context) {
      authenticate(context);
      const runtime = requireDictionary(dictionary);
      for await (const update of watchVoiceDictionaryProjection({ context, authenticate, onRevoked, shutdownSignal,
        subscribe: (listener) => runtime.subscribe(listener), read: () => toProtoDictionarySnapshot(runtime.snapshot()) })) {
        yield create(contract.WatchVoiceInputDictionaryResponseSchema, { sequence: update.sequence, dictionary: update.value });
      }
    },
    getVoiceInputDictionaryReadOnly: async (_request, context) => voiceRpc(async () => {
      authenticate(context);
      return create(contract.GetVoiceInputDictionaryReadOnlyResponseSchema, {
        dictionary: toProtoReadOnlySnapshot(requireDictionary(dictionary).readOnlySnapshot())
      });
    }),
    watchVoiceInputDictionaryReadOnly: async function* (_request, context) {
      authenticate(context);
      const runtime = requireDictionary(dictionary);
      for await (const update of watchVoiceDictionaryProjection({ context, authenticate, onRevoked, shutdownSignal,
        subscribe: (listener) => runtime.subscribe(listener), read: () => toProtoReadOnlySnapshot(runtime.readOnlySnapshot()) })) {
        yield create(contract.WatchVoiceInputDictionaryReadOnlyResponseSchema, { sequence: update.sequence, dictionary: update.value });
      }
    },
    watchVoiceInputDictionaryPeerStatus: async function* (_request, context) {
      authenticate(context);
      const runtime = requirePeers(peers);
      for await (const update of watchVoiceDictionaryProjection({ context, authenticate, onRevoked, shutdownSignal,
        subscribe: (listener) => runtime.subscribe(listener), read: () => toProtoPeerStatus(runtime.status()) })) {
        yield create(contract.WatchVoiceInputDictionaryPeerStatusResponseSchema, { sequence: update.sequence, status: update.value });
      }
    },
    getVoiceInputDictionaryPeerStatus: async (_request, context) => voiceRpc(async () => {
      authenticate(context);
      return create(contract.GetVoiceInputDictionaryPeerStatusResponseSchema, { status: toProtoPeerStatus(requirePeers(peers).status()) });
    }),
    configureVoiceInputDictionaryListener: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      let listener: contract.VoiceDictionaryPeerListener | undefined;
      try { listener = request.listener === undefined ? undefined : contract.readVoiceDictionaryPeerListener({
        host: request.listener.host, port: request.listener.port, listenPort: request.listener.listenPort }); }
      catch { throw new ConnectError("Dictionary listener is invalid.", Code.InvalidArgument); }
      const status = requirePeers(peers).configureListener(requirePeerRevision(request.expectedConfigurationRevision), listener);
      return create(contract.ConfigureVoiceInputDictionaryListenerResponseSchema, { status: toProtoPeerStatus(status) });
    }),
    getVoiceInputDictionaryPeerInvitation: async (_request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const invitation = await requirePeers(peers).invitation();
      requireActiveMutation(context);
      authenticate(context);
      return create(contract.GetVoiceInputDictionaryPeerInvitationResponseSchema, { invitation });
    }),
    grantVoiceInputDictionaryDirectPeer: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const status = requirePeers(peers).grantDirectPeer(requirePeerRevision(request.expectedConfigurationRevision),
        request.invitation, requireFingerprint(request.expectedFingerprint));
      return create(contract.GrantVoiceInputDictionaryDirectPeerResponseSchema, { status: toProtoPeerStatus(status) });
    }),
    clearVoiceInputDictionaryPeerRoute: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const status = requirePeers(peers).clearPeerRoute(requirePeerRevision(request.expectedConfigurationRevision), requirePeerId(request.peerId));
      return create(contract.ClearVoiceInputDictionaryPeerRouteResponseSchema, { status: toProtoPeerStatus(status) });
    }),
    grantVoiceInputDictionaryPeer: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const status = requirePeers(peers).grantCandidate(requirePeerRevision(request.expectedConfigurationRevision),
        requirePeerId(request.peerId), requireFingerprint(request.expectedFingerprint));
      return create(contract.GrantVoiceInputDictionaryPeerResponseSchema, { status: toProtoPeerStatus(status) });
    }),
    revokeVoiceInputDictionaryPeer: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const status = requirePeers(peers).revokePeer(requirePeerId(request.peerId), requirePeerRevision(request.expectedGrantRevision));
      return create(contract.RevokeVoiceInputDictionaryPeerResponseSchema, { status: toProtoPeerStatus(status) });
    }),
    syncVoiceInputDictionaryNow: async (request, context) => voiceRpc(async () => {
      const owner = authenticate(context);
      requireActiveMutation(context);
      const runtime = requirePeers(peers);
      if (runtime.status().configurationRevision !== requirePeerRevision(request.expectedConfigurationRevision)) throw new ConnectError("Dictionary peer authority changed.", Code.Aborted);
      const revoked = new AbortController();
      const unsubscribe = onRevoked?.(owner.connectionId, () => revoked.abort());
      const signal = onRevoked === undefined ? context.signal : AbortSignal.any([context.signal, revoked.signal]);
      const delivery = { signal, isCurrent: () => {
        if (signal.aborted) return false;
        try { authenticate(context); return true; } catch { return false; }
      } };
      try { await runtime.syncNow(request.peerId === undefined ? undefined : requirePeerId(request.peerId), delivery); }
      catch (error) { requireActiveMutation(context); authenticate(context); throw error; }
      finally { unsubscribe?.(); }
      requireActiveMutation(context);
      authenticate(context);
      return create(contract.SyncVoiceInputDictionaryNowResponseSchema, { status: toProtoPeerStatus(runtime.status()) });
    }),
    setVoiceInputDictionarySyncEnabled: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const snapshot = requireDictionary(dictionary).setEnabled(requireRevision(request.expectedRevision), request.enabled);
      if (request.enabled && peers !== undefined) void peers.syncNow().catch(() => undefined);
      return create(contract.SetVoiceInputDictionarySyncEnabledResponseSchema, {
        dictionary: toProtoDictionarySnapshot(snapshot)
      });
    }),
    addVoiceInputDictionaryTerms: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const snapshot = requireDictionary(dictionary).addManualTerms(
        requireRevision(request.expectedRevision),
        request.terms
      );
      return create(contract.AddVoiceInputDictionaryTermsResponseSchema, {
        dictionary: toProtoDictionarySnapshot(snapshot)
      });
    }),
    editVoiceInputDictionaryEntry: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const snapshot = requireDictionary(dictionary).editEntry(requireRevision(request.expectedRevision), {
        entryId: request.entryId,
        text: request.text,
        aliases: request.aliases
      });
      return create(contract.EditVoiceInputDictionaryEntryResponseSchema, {
        dictionary: toProtoDictionarySnapshot(snapshot)
      });
    }),
    deleteVoiceInputDictionaryEntry: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const snapshot = requireDictionary(dictionary).deleteEntry(
        requireRevision(request.expectedRevision),
        request.entryId
      );
      return create(contract.DeleteVoiceInputDictionaryEntryResponseSchema, {
        dictionary: toProtoDictionarySnapshot(snapshot)
      });
    }),
    applyVoiceInputDictionaryLearning: async (request, context) => voiceRpc(async () => {
      authenticate(context);
      requireActiveMutation(context);
      const snapshot = requireDictionary(dictionary).applyLearning(
        requireRevision(request.expectedRevision),
        request.actions.map((action) => ({
          text: action.term,
          aliases: action.aliases,
          stage: fromProtoDictionaryLearningStage(action.action)
        }))
      );
      return create(contract.ApplyVoiceInputDictionaryLearningResponseSchema, {
        dictionary: toProtoDictionarySnapshot(snapshot)
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
      const runtime = requireCoordinator(coordinator);
      const dictionaryTerms = requireDictionary(dictionary).snapshot().refinementTerms;
      let session: VoiceInputSessionSnapshot;
      try {
        session = await runtime.start({ ownerConnectionId: owner.connectionId, requestId: request.requestId,
          mimeType: request.mimeType,
          ...(request.locale === undefined ? {} : { locale: request.locale }),
          ...(request.refinementInstructions === undefined ? {} : { refinementInstructions: request.refinementInstructions }),
          ...(request.recognitionContext === undefined ? {} : { recognitionContext: {
            hotwords: [], contextData: request.recognitionContext.contextData.map((item) => ({ text: item.text })) } }),
          dictionaryTerms, signal: context.signal });
      } catch (error) {
        if (context.signal.aborted) throw new ConnectError("Voice input start was cancelled.", Code.Canceled);
        throw error;
      }
      try {
        if (context.signal.aborted) throw new ConnectError("Voice input start was cancelled.", Code.Canceled);
        if (authenticate(context).connectionId !== owner.connectionId) throw new ConnectError("Voice input authority changed.", Code.PermissionDenied);
      } catch (error) {
        await runtime.cancel({ ownerConnectionId: owner.connectionId, voiceInputId: session.id }).catch(() => undefined);
        throw error;
      }
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

function toProtoReadOnlySnapshot(value: VoiceDictionaryReadOnlySnapshot): contract.VoiceInputDictionaryReadOnlySnapshot {
  return create(contract.VoiceInputDictionaryReadOnlySnapshotSchema, {
    revision: BigInt(value.revision), syncEnabled: value.enabled,
    entries: value.entries.map((entry) => ({ text: entry.text, frequency: BigInt(entry.frequency),
      aliases: entry.aliases.map((alias) => ({ text: alias.text, count: BigInt(alias.count) })) })),
    stateVector: { versions: Object.entries(value.stateVector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([nodeId, stamp]) => ({ nodeId, stamp })) }
  });
}

function toProtoDictionarySnapshot(value: VoiceDictionarySyncSnapshot): contract.VoiceInputDictionarySnapshot {
  return create(contract.VoiceInputDictionarySnapshotSchema, {
    revision: BigInt(value.revision),
    syncEnabled: value.enabled,
    entries: value.dictionary.entries.map((entry) => create(contract.VoiceInputDictionarySnapshotEntrySchema, {
      entryId: entry.id,
      text: entry.text,
      source: entry.source === "automatic"
        ? contract.VoiceInputDictionaryEntrySource.AUTOMATIC
        : contract.VoiceInputDictionaryEntrySource.MANUAL,
      frequency: BigInt(entry.frequency),
      aliases: entry.aliases.map((alias) => create(contract.VoiceInputDictionarySnapshotAliasSchema, {
        text: alias.text,
        count: BigInt(alias.count),
        lastSeenAt: toProtoTimestamp(alias.lastSeenAt)
      })),
      createdAt: toProtoTimestamp(entry.createdAt),
      updatedAt: toProtoTimestamp(entry.updatedAt)
    })),
    candidates: value.dictionary.candidates.map((candidate) => create(contract.VoiceInputDictionarySnapshotCandidateSchema, {
      text: candidate.text,
      evidenceCount: BigInt(candidate.evidenceCount),
      aliases: candidate.aliases.map((alias) => create(contract.VoiceInputDictionarySnapshotAliasSchema, {
        text: alias.text,
        count: BigInt(alias.count),
        lastSeenAt: toProtoTimestamp(alias.lastSeenAt)
      })),
      createdAt: toProtoTimestamp(candidate.createdAt),
      updatedAt: toProtoTimestamp(candidate.updatedAt)
    })),
    suppressedAutomaticTerms: [...value.dictionary.suppressedAutomaticTexts],
    refinementTerms: [...value.refinementTerms]
  });
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
    supportedLocales: [...value.supportedLocales],
    supportsRecognitionContext: value.supportsRecognitionContext,
    recognitionContextMaximumItems: value.supportsRecognitionContext ? VOICE_INPUT_LIMITS.recognitionContextMaximumItems : 0,
    recognitionContextMaximumItemBytes: value.supportsRecognitionContext ? VOICE_INPUT_LIMITS.recognitionContextMaximumItemBytes : 0,
    recognitionContextMaximumBytes: value.supportsRecognitionContext ? VOICE_INPUT_LIMITS.recognitionContextMaximumBytes : 0,
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
    supportedLocales: [],
    supportsRecognitionContext: false,
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

function requireDictionary(
  value: Pick<VoiceDictionarySyncRepository,
    "addManualTerms" | "applyLearning" | "deleteEntry" | "editEntry" | "setEnabled" | "snapshot" | "readOnlySnapshot" | "subscribe"> | undefined
): Pick<VoiceDictionarySyncRepository,
  "addManualTerms" | "applyLearning" | "deleteEntry" | "editEntry" | "setEnabled" | "snapshot" | "readOnlySnapshot" | "subscribe"> {
  if (value === undefined) throw new VoiceInputControlError("not_supported");
  return value;
}

function requireRevision(value: bigint): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new ConnectError("Voice dictionary revision is invalid.", Code.InvalidArgument);
  }
  return revision;
}

function requireActiveMutation(context: HandlerContext): void {
  if (context.signal.aborted) throw new ConnectError("Voice dictionary mutation was cancelled.", Code.Canceled);
}

function fromProtoDictionaryLearningStage(
  value: contract.VoiceInputDictionaryLearningActionType
): "candidate" | "entry" {
  switch (value) {
    case contract.VoiceInputDictionaryLearningActionType.ADD_CANDIDATE: return "candidate";
    case contract.VoiceInputDictionaryLearningActionType.ADD_ENTRY:
    case contract.VoiceInputDictionaryLearningActionType.UPDATE_ENTRY: return "entry";
    case contract.VoiceInputDictionaryLearningActionType.UNSPECIFIED:
    default:
      throw new ConnectError("Voice dictionary learning action is invalid.", Code.InvalidArgument);
  }
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
    if (error instanceof VoiceDictionaryPeerStoreError || error instanceof VoiceDictionaryPeerManagerError) {
      const code = error.code === "INVALID" ? Code.InvalidArgument : error.code === "CONFLICT" ? Code.Aborted
        : error.code === "DISABLED" ? Code.FailedPrecondition : Code.Unavailable;
      throw new ConnectError("The dictionary peer operation could not be completed.", code);
    }
    if (error instanceof VoiceDictionarySyncRepositoryError) {
      const code = error.code === "INVALID" ? Code.InvalidArgument
        : error.code === "CONFLICT" ? Code.Aborted
          : Code.Unavailable;
      throw new ConnectError(error.message, code);
    }
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

function requirePeers<T>(peers: T | undefined): T {
  if (peers === undefined) throw new ConnectError("Dictionary sharing is unavailable.", Code.Unimplemented);
  return peers;
}
function requirePeerRevision(value: bigint): bigint {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("Dictionary peer revision is invalid.", Code.InvalidArgument);
  return value;
}
function requirePeerId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new ConnectError("Dictionary peer identity is invalid.", Code.InvalidArgument);
  return value;
}
function requireFingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new ConnectError("Dictionary peer fingerprint is invalid.", Code.InvalidArgument);
  return value;
}
function toProtoPeerStatus(value: VoiceDictionaryPeerStatus): contract.VoiceInputDictionaryPeerStatus {
  const phase = { off: contract.VoiceInputDictionaryPeerPhase.OFF, waiting: contract.VoiceInputDictionaryPeerPhase.WAITING,
    syncing: contract.VoiceInputDictionaryPeerPhase.SYNCING, up_to_date: contract.VoiceInputDictionaryPeerPhase.UP_TO_DATE,
    error: contract.VoiceInputDictionaryPeerPhase.ERROR }[value.phase];
  const errorCode = value.errorCode === undefined ? undefined : {
    identity_unavailable: contract.VoiceInputDictionaryPeerErrorCode.IDENTITY_UNAVAILABLE,
    dictionary_unavailable: contract.VoiceInputDictionaryPeerErrorCode.DICTIONARY_UNAVAILABLE,
    sync_failed: contract.VoiceInputDictionaryPeerErrorCode.SYNC_FAILED }[value.errorCode];
  return create(contract.VoiceInputDictionaryPeerStatusSchema, {
    available: value.available, configurationRevision: value.configurationRevision, nodeId: value.nodeId,
    fingerprint: value.fingerprint, enabled: value.enabled, phase, ...(errorCode === undefined ? {} : { errorCode }),
    ...(value.listener === undefined ? {} : { listener: create(contract.VoiceInputDictionaryListenerSchema, value.listener) }),
    peers: value.peers.map((peer) => create(contract.VoiceInputDictionaryPeerSchema, { ...peer,
      ...(peer.route === undefined ? {} : { route: create(contract.VoiceInputDictionaryPeerEndpointSchema, peer.route) }),
      grantedAt: toProtoTimestamp(peer.grantedAt), lastSyncAt: peer.lastSyncAt === undefined ? undefined : toProtoTimestamp(peer.lastSyncAt) })),
    candidates: value.candidates.map((candidate) => create(contract.VoiceInputDictionaryPeerCandidateSchema, { ...candidate,
      seenAt: toProtoTimestamp(candidate.seenAt) }))
  });
}
