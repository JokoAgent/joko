import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  PartnerStoreError,
  type ConnectionRecord,
  type PartnerCapabilitiesRecord,
  type PartnerAvatarInput,
  type PartnerAvatarRecord,
  type PartnerDelegationStatus,
  type PartnerDeletionRecord,
  type PartnerRestartRecord,
  type PartnerInitializationErrorCode,
  type PartnerInitializationState,
  type PartnerInvitationStage,
  type PartnerLifecycle,
  type PartnerModelRouteRecord,
  type PartnerPrivateMessageDeliveryStatus,
  type PartnerPrivateMessageRecord,
  type PartnerPrivateThreadCloseReason,
  type PartnerPrivateThreadReadStateRecord,
  type PartnerPrivateThreadRecord,
  type PartnerProfileRecord
} from "@joko/store";

import {
  PartnerManager,
  PartnerManagerError,
  type PartnerActivitySummary,
  type PartnerDelegationView,
  type PartnerDirectoryView,
  type PartnerSessionView
} from "./partner-manager.js";
import { fromProtoRevision, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";
import { createPartnerWorkbenchConnectMethods } from "./partner-workbench-connect-service.js";
import type { PartnerWorkbenchManager } from "./partner-workbench-manager.js";
import type { PartnerWorkingStatusManager } from "./partner-working-status.js";
import { createPartnerMemoryConnectMethods, type PartnerMemoryManager } from "./partner-memory.js";
import { createPartnerConnectionMethods, type PartnerConnectionsManager } from "./partner-connections.js";
import { createPartnerSkillMethods, type PartnerSkillsManager } from "./partner-skills.js";
import type { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { createPartnerSessionTaskControl, toProtoSessionTask } from "./partner-session-task-connect.js";
import { PartnerTaskOutputChangedError, type PartnerTaskOutputProjection, type PartnerTaskOutputRow } from "./partner-task-outputs.js";
import { createPartnerAutonomyConnectMethods } from "./partner-autonomy-connect-service.js";
import type { PartnerAutonomyManager } from "./partner-autonomy.js";
import { createPartnerTodoConnectMethods } from "./partner-todo-connect-service.js";
import type { PartnerTodoManager } from "./partner-todos.js";

type PublicActivity = PartnerActivitySummary & { readonly workingStatus?: contract.SessionWorkingStatus };

export function createPartnerConnectService(
  manager: PartnerManager | undefined,
  authenticate: (context: HandlerContext) => unknown,
  workbench?: PartnerWorkbenchManager,
  working?: PartnerWorkingStatusManager,
  memory?: PartnerMemoryManager,
  connections?: PartnerConnectionsManager,
  skills?: PartnerSkillsManager,
  tasks?: PartnerSessionTaskManager,
  outputs?: PartnerTaskOutputProjection,
  autonomy?: PartnerAutonomyManager,
  todos?: PartnerTodoManager
): ServiceImpl<typeof contract.PartnerService> {
  const owner = (): PartnerManager => {
    if (manager === undefined) throw new ConnectError("Partners are unavailable.", Code.Unimplemented);
    return manager;
  };
  const activity = (partnerId: string): PublicActivity => {
    const status = working?.status(partnerId);
    return { ...owner().activity(partnerId), ...(status === undefined ? {} : { workingStatus: status }) };
  };
  const assertPermissionOwner = (context: HandlerContext): void => {
    authenticate(context);
    if (context.signal.aborted) throw new ConnectError("The Partner permission request was canceled.", Code.Canceled);
  };
  return {
    ...createPartnerAutonomyConnectMethods(autonomy, authenticate),
    ...createPartnerTodoConnectMethods(todos, authenticate),
    ...createPartnerWorkbenchConnectMethods(workbench, authenticate),
    ...createPartnerMemoryConnectMethods(memory, authenticate),
    ...createPartnerConnectionMethods(connections, authenticate),
    ...createPartnerSkillMethods(skills, authenticate),
    controlPartnerSessionTask: createPartnerSessionTaskControl(tasks, authenticate),
    listPartnerTaskOutputs: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => {
        if (!outputs) throw new ConnectError("Partner task outputs are unavailable.", Code.Unimplemented);
        if (!request.partnerId.trim()) throw new ConnectError("partner_id is required.", Code.InvalidArgument);
        if (context.signal.aborted) throw new ConnectError("The task output read was canceled.", Code.Canceled);
        const rows = await outputs.list(request.partnerId);
        authenticate(context);
        if (context.signal.aborted) throw new ConnectError("The task output read was canceled.", Code.Canceled);
        return create(contract.ListPartnerTaskOutputsResponseSchema, {
          partnerId: request.partnerId,
          outputs: rows.slice(0, 200).map(toProtoTaskOutput),
          truncated: rows.length > 200
        });
      });
    },
    getPartnerDirectory: (_request, context) => {
      authenticate(context);
      return partnerRpc(() => create(contract.GetPartnerDirectoryResponseSchema, {
        directory: toProtoDirectory(owner().directory())
      }));
    },
    listPartners: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const active = owner();
        const lifecycle = request.lifecycle === undefined ? undefined : fromProtoLifecycle(request.lifecycle);
        if (lifecycle === "deleted") {
          throw new ConnectError("Deleted partner profiles are not listable.", Code.InvalidArgument);
        }
        return create(contract.ListPartnersResponseSchema, {
          partners: active.listPartners(lifecycle).map((partner) =>
            toProtoProfile(partner, activity(partner.id))),
          directory: toProtoDirectory(active.directory()),
          pendingDeletions: active.listPendingDeletions().map(toProtoDeletion),
          pendingRestarts: active.listPendingRestarts().map(toProtoRestart)
        });
      });
    },
    getPartner: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const partner = owner().getPartner(request.partnerId);
        if (partner.lifecycle === "deleted") throw new ConnectError("The partner profile is being removed.", Code.NotFound);
        return create(contract.GetPartnerResponseSchema, { partner: toProtoProfile(partner, activity(request.partnerId)) });
      });
    },
    readPartnerAvatar: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const result = owner().readPartnerAvatar(request.partnerId,
          fromProtoRevision(request.expectedRevision, "expected_revision"), request.sha256);
        return create(contract.ReadPartnerAvatarResponseSchema, {
          image: { ...result.image, byteLength: BigInt(result.image.byteLength) }, content: result.content
        });
      });
    },
    readPartnerWorkingStatus: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => {
        if (!working) throw new ConnectError("Partner working status is unavailable.", Code.Unimplemented);
        const phase = contract.fromPartnerWorkingPhase(request.phase);
        if (!phase || !["en", "zh-CN", "zh-TW", "ja", "ko"].includes(request.locale)) {
          throw new ConnectError("Working phase or language is invalid.", Code.InvalidArgument);
        }
        const current = working.status(request.partnerId);
        if (!current || current.sessionId !== request.sessionId || current.generation !== request.generation
          || current.runId !== request.runId || current.attemptId !== request.attemptId || current.phase !== phase) {
          return create(contract.ReadPartnerWorkingStatusResponseSchema);
        }
        context.signal.throwIfAborted();
        const result = await working.readCaption(request.partnerId, current, request.locale);
        authenticate(context); context.signal.throwIfAborted();
        return create(contract.ReadPartnerWorkingStatusResponseSchema, {
          ...(result === undefined ? {} : { workingStatus: { ...result, phase: contract.toPartnerWorkingPhase(result.phase) } })
        });
      });
    },
    createPartner: async (request, context) => {
      assertPermissionOwner(context);
      return partnerRpc(async () => {
        const active = owner();
        const draft = required(request.draft, "draft");
        if (draft.usesDirectoryDefaults && draft.capabilities !== undefined) {
          throw new ConnectError("Capability overrides cannot accompany uses_directory_defaults=true.", Code.InvalidArgument);
        }
        if (!draft.usesDirectoryDefaults && draft.capabilities === undefined) {
          throw new ConnectError("draft.capabilities are required for an explicit override.", Code.InvalidArgument);
        }
        const capabilities = draft.capabilities === undefined
          ? active.directory().state.defaultCapabilities
          : fromProtoCapabilities(draft.capabilities);
        if (capabilities === undefined) {
          throw new ConnectError("draft.capabilities or configured directory defaults are required.", Code.FailedPrecondition);
        }
        const partner = await active.createPartner({
          requestId: request.requestId,
          expectedDirectoryRevision: fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"),
          displayName: draft.displayName,
          description: draft.description,
          avatar: fromProtoAvatarInput(draft.avatar),
          identitySource: draft.identitySource,
          templateId: draft.templateId,
          capabilities,
          usesDirectoryDefaults: draft.usesDirectoryDefaults
        }, () => assertPermissionOwner(context));
        assertPermissionOwner(context);
        return create(contract.CreatePartnerResponseSchema, {
          partner: toProtoProfile(partner, activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    getPartnerCreation: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const active = owner();
        const partner = active.getPartnerCreation(request.requestId);
        return create(contract.GetPartnerCreationResponseSchema, {
          partner: toProtoProfile(partner, activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    retirePartnerCreation: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const active = owner();
        const partner = active.retirePartnerCreation(request.requestId);
        return create(contract.RetirePartnerCreationResponseSchema, {
          retired: partner === undefined,
          ...(partner === undefined ? {} : { partner: toProtoProfile(partner, activity(partner.id)) }),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    updatePartner: async (request, context) => {
      assertPermissionOwner(context);
      return partnerRpc(async () => {
        const active = owner();
        const patch = required(request.patch, "patch");
        if (patch.taskModelPreference.case === "inheritTaskModel" && patch.taskModelPreference.value !== true) {
          throw new ConnectError("Task model inheritance must be explicitly enabled.", Code.InvalidArgument);
        }
        const current = active.getPartner(request.partnerId);
        const hasCapabilityPatch = patch.modelChain !== undefined
          || patch.permissionMode !== undefined || patch.planMode !== undefined || patch.inputHandoff !== undefined;
        if (patch.usesDirectoryDefaults === true && hasCapabilityPatch) {
          throw new ConnectError("Capability overrides cannot accompany uses_directory_defaults=true.", Code.InvalidArgument);
        }
        const capabilities: PartnerCapabilitiesRecord | undefined = hasCapabilityPatch
          ? {
              modelChain: patch.modelChain === undefined
                ? current.capabilities.modelChain
                : patch.modelChain.routes.map(fromProtoRoute),
              permissionMode: patch.permissionMode === undefined
                ? current.capabilities.permissionMode
                : fromProtoPermission(patch.permissionMode),
              planMode: patch.planMode ?? current.capabilities.planMode,
              inputHandoff: patch.inputHandoff ?? current.capabilities.inputHandoff ?? true
            }
          : undefined;
        const partner = await active.updatePartner(
          request.partnerId,
          fromProtoRevision(request.expectedRevision, "expected_revision"),
          {
            ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
            ...(patch.description === undefined ? {} : { description: patch.description }),
            ...(patch.avatar === undefined ? {} : { avatar: fromProtoAvatarInput(patch.avatar) }),
            ...(patch.identitySource === undefined ? {} : { identitySource: patch.identitySource }),
            ...(patch.taskModelPreference.case === undefined ? {} : { taskModelOverride: patch.taskModelPreference.case === "inheritTaskModel"
              ? null : fromProtoRoute(patch.taskModelPreference.value) }),
            ...(capabilities === undefined ? {} : { capabilities }),
            ...(patch.usesDirectoryDefaults === undefined
              ? {}
              : { usesDirectoryDefaults: patch.usesDirectoryDefaults })
          },
          () => assertPermissionOwner(context)
        );
        assertPermissionOwner(context);
        return create(contract.UpdatePartnerResponseSchema, {
          partner: toProtoProfile(partner, activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    setPartnerLifecycle: async (request, context) => {
      authenticate(context); context.signal.throwIfAborted();
      return partnerRpc(async () => {
        const active = owner();
        const partner = await active.setLifecycle(
          request.partnerId,
          fromProtoRevision(request.expectedRevision, "expected_revision"),
          fromProtoLifecycle(request.lifecycle)
        );
        authenticate(context); context.signal.throwIfAborted();
        return create(contract.SetPartnerLifecycleResponseSchema, {
          partner: toProtoProfile(partner, activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    deletePartner: async (request, context) => {
      authenticate(context); context.signal.throwIfAborted();
      return partnerRpc(async () => {
        const deletion = await owner().deletePartner({ requestId: request.requestId, partnerId: request.partnerId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"), confirmName: request.confirmName });
        authenticate(context);
        return create(contract.DeletePartnerResponseSchema, { deletion: toProtoDeletion(deletion) });
      });
    },
    getPartnerDeletion: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const deletion = owner().getDeletion(request.requestId);
        return create(contract.GetPartnerDeletionResponseSchema, { ...(deletion ? { deletion: toProtoDeletion(deletion) } : {}),
          retired: owner().isDeletionRetired(request.requestId) });
      });
    },
    retirePartnerDeletion: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const deletion = owner().retireDeletion(request.requestId);
        return create(contract.RetirePartnerDeletionResponseSchema, { ...(deletion ? { deletion: toProtoDeletion(deletion) } : {}),
          retired: deletion === undefined });
      });
    },
    retryPartnerDeletion: async (request, context) => {
      authenticate(context); context.signal.throwIfAborted();
      return partnerRpc(async () => {
        const deletion = await owner().retryDeletion(request.requestId);
        authenticate(context);
        return create(contract.RetryPartnerDeletionResponseSchema, { deletion: toProtoDeletion(deletion) });
      });
    },
    getPartnerRestartControls: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const controls = owner().restartControls(request.partnerId);
        return create(contract.GetPartnerRestartControlsResponseSchema, { revision: toProtoRevision(controls.revision), available: controls.available });
      });
    },
    restartPartner: async (request, context) => {
      authenticate(context); context.signal.throwIfAborted();
      return partnerRpc(async () => {
        const restart = await owner().restartPartner({ requestId: request.requestId, partnerId: request.partnerId,
          expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision") });
        authenticate(context);
        return create(contract.RestartPartnerResponseSchema, { restart: toProtoRestart(restart) });
      });
    },
    getPartnerRestart: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const restart = owner().getRestart(request.requestId);
        return create(contract.GetPartnerRestartResponseSchema, { ...(restart ? { restart: toProtoRestart(restart) } : {}),
          retired: owner().isRestartRetired(request.requestId) });
      });
    },
    retirePartnerRestart: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const restart = owner().retireRestart(request.requestId);
        return create(contract.RetirePartnerRestartResponseSchema, { ...(restart ? { restart: toProtoRestart(restart) } : {}), retired: restart === undefined });
      });
    },
    retryPartnerRestart: async (request, context) => {
      authenticate(context); context.signal.throwIfAborted();
      return partnerRpc(async () => {
        const restart = await owner().retryRestart(request.requestId); authenticate(context);
        return create(contract.RetryPartnerRestartResponseSchema, { restart: toProtoRestart(restart) });
      });
    },
    retryPartnerInitialization: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => {
        const active = owner();
        const partner = await active.retryInitialization(
          request.partnerId,
          fromProtoRevision(request.expectedRevision, "expected_revision")
        );
        return create(contract.RetryPartnerInitializationResponseSchema, {
          partner: toProtoProfile(partner, activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    updatePartnerDefaults: async (request, context) => {
      assertPermissionOwner(context);
      return partnerRpc(async () => {
        const active = owner();
        const affected = await active.updateDirectoryDefaults(
          fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"),
          fromProtoCapabilities(required(request.capabilities, "capabilities"))
        );
        assertPermissionOwner(context);
        return create(contract.UpdatePartnerDefaultsResponseSchema, {
          directory: toProtoDirectory(active.directory()),
          affectedPartners: affected.map((partner) => toProtoProfile(partner, activity(partner.id)))
        });
      });
    },
    listPartnerSessions: (request, context) => {
      authenticate(context);
      return partnerRpc(() => create(contract.ListPartnerSessionsResponseSchema, {
        sessions: owner().listSessions(request.partnerId).map(toProtoPartnerSession),
        tasks: tasks?.list(request.partnerId).map(task => toProtoSessionTask(tasks, task)) ?? []
      }));
    },
    ensurePartnerTopic: (request, context) => partnerRpc(async () => {
      const connection = authenticate(context) as ConnectionRecord | undefined;
      if (!connection?.id || !connection.authKeyDigest) throw new ConnectError('The authenticated topic owner is unavailable.', Code.Unauthenticated);
      const root = required(request.root, 'root');
      if (root.generation < 1n || root.generation > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError('The topic root generation is invalid.', Code.InvalidArgument);
      const topic = await owner().ensureTopic({ operationId: request.operationId, connection, partnerId: request.partnerId,
        expectedRevision: fromProtoRevision(request.expectedPartnerRevision, 'expected_partner_revision'),
        root: { sessionId: root.sessionId, generation: Number(root.generation), eventId: root.eventId, messageId: root.messageId },
        assertCurrent: () => assertPermissionOwner(context) });
      assertPermissionOwner(context);
      return create(contract.EnsurePartnerTopicResponseSchema, { topic: toProtoPartnerSession(topic) });
    }),
    getPartnerTopic: (request, context) => {
      authenticate(context);
      return partnerRpc(() => { const topic = owner().getTopic(request.sessionId);
        return create(contract.GetPartnerTopicResponseSchema, { ...(topic ? { topic: toProtoPartnerSession(topic) } : {}) }); });
    },
    markPartnerRead: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const active = owner();
        active.markRead(
          request.partnerId,
          fromProtoRevision(request.throughCursor, "through_cursor")
        );
        return create(contract.MarkPartnerReadResponseSchema, {
          activity: toProtoActivity(activity(request.partnerId))
        });
      });
    },
    listPartnerPrivateThreads: (request, context) => {
      authenticate(context);
      return partnerRpc(() => create(contract.ListPartnerPrivateThreadsResponseSchema, {
        threads: owner().listPrivateThreads(request.partnerId).map(toProtoPrivateThread)
      }));
    },
    getPartnerPrivateThread: (request, context) => {
      authenticate(context);
      return partnerRpc(() => {
        const view = owner().getPrivateThread(request.threadId, request.partnerId);
        return create(contract.GetPartnerPrivateThreadResponseSchema, {
          thread: toProtoPrivateThread(view.thread),
          messages: view.messages.map(toProtoPrivateMessage),
          ...(view.readState === undefined ? {} : { readState: toProtoPrivateReadState(view.readState) })
        });
      });
    },
    markPartnerPrivateThreadRead: (request, context) => {
      authenticate(context);
      return partnerRpc(() => create(contract.MarkPartnerPrivateThreadReadResponseSchema, {
        readState: toProtoPrivateReadState(owner().markPrivateThreadRead(
          request.threadId,
          request.partnerId,
          safeProtoNumber(request.throughSequence, "through_sequence")
        ))
      }));
    },
    listPartnerDelegations: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => create(contract.ListPartnerDelegationsResponseSchema, {
        delegations: (await owner().listDelegations(request.partnerId)).map(toProtoDelegation)
      }));
    },
    getPartnerDelegation: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => create(contract.GetPartnerDelegationResponseSchema, {
        delegation: toProtoDelegation(await owner().getDelegation(request.delegationId, request.partnerId))
      }));
    },
    cancelPartnerDelegation: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => create(contract.CancelPartnerDelegationResponseSchema, {
        delegation: toProtoDelegation(await owner().cancelDelegation(
          request.delegationId,
          request.partnerId,
          fromProtoRevision(request.expectedRevision, "expected_revision")
        ))
      }));
    }
  };
}

function toProtoRestart(record: PartnerRestartRecord): contract.PartnerRestart {
  return create(contract.PartnerRestartSchema, { requestId: record.requestId, partnerId: record.partnerId,
    phase: record.phase === "closing" ? contract.PartnerRestartPhase.CLOSING : contract.PartnerRestartPhase.READY,
    runtimeClosePending: record.failure !== undefined,
    createdAt: toProtoTimestamp(record.createdAt), updatedAt: toProtoTimestamp(record.updatedAt) });
}

function toProtoDeletion(record: PartnerDeletionRecord): contract.PartnerDeletion {
  return create(contract.PartnerDeletionSchema, { requestId: record.requestId, partnerId: record.partnerId,
    phase: record.phase === "closing" ? contract.PartnerDeletionPhase.CLOSING : record.phase === "cleanup"
      ? contract.PartnerDeletionPhase.CLEANUP : contract.PartnerDeletionPhase.COMPLETED,
    failure: record.failure === "runtime_close_pending" ? contract.PartnerDeletionFailure.RUNTIME_CLOSE_PENDING
      : record.failure === "home_cleanup_pending" ? contract.PartnerDeletionFailure.HOME_CLEANUP_PENDING : contract.PartnerDeletionFailure.UNSPECIFIED,
    createdAt: toProtoTimestamp(record.createdAt), updatedAt: toProtoTimestamp(record.updatedAt) });
}

function toProtoDirectory(view: PartnerDirectoryView): contract.PartnerDirectory {
  return create(contract.PartnerDirectorySchema, {
    revision: toProtoRevision(view.state.revision),
    activeCount: view.state.activeCount,
    archivedCount: view.state.archivedCount,
    errorCount: view.state.errorCount,
    updatedAt: toProtoTimestamp(view.state.updatedAt),
    templates: view.templates.map((template) => create(contract.PartnerTemplateSchema, template)),
    avatarPresets: [...view.avatarPresets],
    ...(view.state.defaultCapabilities === undefined
      ? {}
      : { defaultCapabilities: toProtoCapabilities(view.state.defaultCapabilities) })
  });
}

function fromProtoAvatarInput(value: contract.PartnerAvatarInput | undefined): PartnerAvatarInput {
  if (value?.value.case === "presetId") return value.value.value;
  if (value?.value.case === "imageBase64") return { base64: value.value.value };
  throw new ConnectError("A Partner avatar preset or image is required.", Code.InvalidArgument);
}

function toProtoAvatar(avatar: PartnerAvatarRecord): contract.PartnerAvatar {
  return create(contract.PartnerAvatarSchema, { value: typeof avatar === "string"
    ? { case: "presetId", value: avatar }
    : { case: "image", value: { ...avatar, byteLength: BigInt(avatar.byteLength) } } });
}

function toProtoProfile(
  profile: PartnerProfileRecord,
  activity: PublicActivity
): contract.PartnerProfile {
  return create(contract.PartnerProfileSchema, {
    partnerId: profile.id,
    revision: toProtoRevision(profile.revision),
    profileVersion: BigInt(profile.profileVersion),
    displayName: profile.displayName,
    description: profile.description,
    avatar: toProtoAvatar(profile.avatar),
    identitySource: profile.identitySource,
    templateId: profile.templateId,
    lifecycle: toProtoLifecycle(profile.lifecycle),
    ...(profile.pauseCleanupPending === undefined ? {} : { pauseCleanupPending: profile.pauseCleanupPending }),
    initializationState: toProtoInitializationState(profile.initializationState),
    invitationStage: toProtoInvitationStage(profile.invitationStage),
    ...(profile.initializationErrorCode === undefined
      ? {}
      : { initializationErrorCode: toProtoInitializationError(profile.initializationErrorCode) }),
    homeTargetId: profile.homeTargetId,
    ...(profile.canonicalSessionId === undefined ? {} : { canonicalSessionId: profile.canonicalSessionId }),
    capabilities: toProtoCapabilities(profile.capabilities),
    ...(profile.taskModelOverride === undefined ? {} : { taskModelOverride: create(contract.PartnerModelRouteSchema, { ...profile.taskModelOverride, ...contract.encodeModelSpeed(profile.taskModelOverride.fastMode) }) }),
    createdAt: toProtoTimestamp(profile.createdAt),
    updatedAt: toProtoTimestamp(profile.updatedAt),
    usesDirectoryDefaults: profile.usesDirectoryDefaults,
    activity: toProtoActivity(activity)
  });
}

function toProtoActivity(activity: PublicActivity): contract.PartnerActivity {
  return create(contract.PartnerActivitySchema, {
    partnerId: activity.partnerId,
    unreadReplyCount: BigInt(activity.unreadReplyCount),
    latestReplyPreview: activity.latestReplyPreview,
    ...(activity.workingStatus === undefined ? {} : { workingStatus: {
      ...activity.workingStatus, phase: contract.toPartnerWorkingPhase(activity.workingStatus.phase)
    } }),
    ...(activity.latestReplyCursor === undefined
      ? {}
      : { latestReplyCursor: toProtoRevision(activity.latestReplyCursor) }),
    ...(activity.latestReplyAt === undefined
      ? {}
      : { latestReplyAt: toProtoTimestamp(activity.latestReplyAt) }),
    artifactCount: BigInt(activity.artifactCount),
    activeDelegationCount: BigInt(activity.activeDelegationCount),
    readThroughCursor: toProtoRevision(activity.readState.throughCursor),
    readUpdatedAt: toProtoTimestamp(activity.readState.updatedAt)
  });
}

function toProtoPartnerSession(view: PartnerSessionView): contract.PartnerSession {
  return create(contract.PartnerSessionSchema, {
    sessionId: view.link.sessionId,
    partnerId: view.link.partnerId,
    role: view.link.role === "canonical"
      ? contract.PartnerSessionRole.CANONICAL
      : view.link.role === 'routine' ? contract.PartnerSessionRole.ROUTINE : view.link.role === 'channel' ? contract.PartnerSessionRole.CHANNEL : view.link.role === 'topic' ? contract.PartnerSessionRole.TOPIC : view.link.role === "history"
        ? contract.PartnerSessionRole.HISTORY
        : contract.PartnerSessionRole.DELEGATION,
    profileVersion: BigInt(view.link.profileVersion),
    ...(view.link.parentSessionId === undefined ? {} : { parentSessionId: view.link.parentSessionId }),
    ...(view.link.delegationId === undefined ? {} : { delegationId: view.link.delegationId }),
    ...(view.link.topicRoot ? { topicRoot: { ...view.link.topicRoot, generation: BigInt(view.link.topicRoot.generation) } } : {}),
    displayName: view.session?.title ?? "Unavailable partner task",
    available: view.available,
    readOnly: view.readOnly,
    archived: view.session?.archived ?? false,
    deleted: view.session?.deletedAt !== undefined,
    createdAt: toProtoTimestamp(view.session?.createdAt ?? view.link.createdAt),
    ...(view.session === undefined ? {} : { lastActivityAt: toProtoTimestamp(view.session.updatedAt) })
  });
}

function toProtoPrivateThread(thread: PartnerPrivateThreadRecord): contract.PartnerPrivateThread {
  return create(contract.PartnerPrivateThreadSchema, {
    threadId: thread.id,
    firstPartnerId: thread.firstPartnerId,
    secondPartnerId: thread.secondPartnerId,
    status: thread.status === "active"
      ? contract.PartnerPrivateThreadStatus.ACTIVE
      : contract.PartnerPrivateThreadStatus.CLOSED,
    ...(thread.closeReason === undefined
      ? {}
      : { closeReason: toProtoPrivateThreadCloseReason(thread.closeReason) }),
    messageCount: thread.messageCount,
    maxMessages: thread.maxMessages,
    expiresAt: toProtoTimestamp(thread.expiresAt),
    ...(thread.blockedUntil === undefined ? {} : { blockedUntil: toProtoTimestamp(thread.blockedUntil) }),
    createdAt: toProtoTimestamp(thread.createdAt),
    updatedAt: toProtoTimestamp(thread.updatedAt),
    ...(thread.closedAt === undefined ? {} : { closedAt: toProtoTimestamp(thread.closedAt) })
  });
}

function toProtoPrivateThreadCloseReason(
  reason: PartnerPrivateThreadCloseReason
): contract.PartnerPrivateThreadCloseReason {
  return reason === "message_limit"
    ? contract.PartnerPrivateThreadCloseReason.MESSAGE_LIMIT
    : contract.PartnerPrivateThreadCloseReason.IDLE_TIMEOUT;
}

function toProtoPrivateMessage(message: PartnerPrivateMessageRecord): contract.PartnerPrivateMessage {
  return create(contract.PartnerPrivateMessageSchema, {
    messageId: message.id,
    threadId: message.threadId,
    sequence: BigInt(message.sequence),
    senderPartnerId: message.senderPartnerId,
    recipientPartnerId: message.recipientPartnerId,
    content: message.content,
    deliveryStatus: toProtoPrivateDeliveryStatus(message.deliveryStatus),
    createdAt: toProtoTimestamp(message.createdAt),
    ...(message.deliveredAt === undefined ? {} : { deliveredAt: toProtoTimestamp(message.deliveredAt) })
  });
}

function toProtoPrivateDeliveryStatus(
  status: PartnerPrivateMessageDeliveryStatus
): contract.PartnerPrivateMessageDeliveryStatus {
  if (status === "pending") return contract.PartnerPrivateMessageDeliveryStatus.PENDING;
  if (status === "delivered") return contract.PartnerPrivateMessageDeliveryStatus.DELIVERED;
  return contract.PartnerPrivateMessageDeliveryStatus.FAILED;
}

function toProtoPrivateReadState(
  state: PartnerPrivateThreadReadStateRecord
): contract.PartnerPrivateThreadReadState {
  return create(contract.PartnerPrivateThreadReadStateSchema, {
    threadId: state.threadId,
    partnerId: state.partnerId,
    throughSequence: BigInt(state.throughSequence),
    updatedAt: toProtoTimestamp(state.updatedAt)
  });
}

function toProtoDelegation(view: PartnerDelegationView): contract.PartnerDelegation {
  const delegation = view.delegation;
  return create(contract.PartnerDelegationSchema, {
    delegationId: delegation.id,
    revision: toProtoRevision(delegation.revision),
    requesterPartnerId: delegation.requesterPartnerId,
    targetPartnerId: delegation.targetPartnerId,
    parentSessionId: delegation.parentSessionId,
    targetProfileVersion: BigInt(delegation.targetProfileVersion),
    title: delegation.title,
    objective: delegation.objective,
    status: toProtoDelegationStatus(delegation.status),
    ...(delegation.childSessionId === undefined ? {} : { childSessionId: delegation.childSessionId }),
    ...(delegation.runId === undefined ? {} : { runId: delegation.runId }),
    ...(delegation.resultSummary === undefined ? {} : { resultSummary: delegation.resultSummary }),
    ...(delegation.errorText === undefined ? {} : { error: delegation.errorText }),
    artifactCount: BigInt(view.artifactCount),
    createdAt: toProtoTimestamp(delegation.createdAt),
    updatedAt: toProtoTimestamp(delegation.updatedAt),
    ...(delegation.startedAt === undefined ? {} : { startedAt: toProtoTimestamp(delegation.startedAt) }),
    ...(delegation.completedAt === undefined ? {} : { completedAt: toProtoTimestamp(delegation.completedAt) })
  });
}

function toProtoDelegationStatus(status: PartnerDelegationStatus): contract.PartnerDelegationStatus {
  if (status === "preparing") return contract.PartnerDelegationStatus.PREPARING;
  if (status === "queued") return contract.PartnerDelegationStatus.QUEUED;
  if (status === "running") return contract.PartnerDelegationStatus.RUNNING;
  if (status === "waiting") return contract.PartnerDelegationStatus.WAITING;
  if (status === "completed") return contract.PartnerDelegationStatus.COMPLETED;
  if (status === "failed") return contract.PartnerDelegationStatus.FAILED;
  if (status === "cancelled") return contract.PartnerDelegationStatus.CANCELLED;
  return contract.PartnerDelegationStatus.UNKNOWN;
}

function toProtoCapabilities(value: PartnerCapabilitiesRecord): contract.PartnerCapabilities {
  return create(contract.PartnerCapabilitiesSchema, {
    modelChain: value.modelChain.map((route) => create(contract.PartnerModelRouteSchema, { ...route, ...contract.encodeModelSpeed(route.fastMode) })),
    permissionMode: value.permissionMode === "ask"
      ? contract.PermissionMode.ASK
      : value.permissionMode === "acceptEdits" ? contract.PermissionMode.ACCEPT_EDITS : value.permissionMode === "auto" ? contract.PermissionMode.AUTO : contract.PermissionMode.BYPASS_PERMISSIONS,
    planMode: value.planMode,
    inputHandoff: value.inputHandoff !== false
  });
}

function fromProtoCapabilities(value: contract.PartnerCapabilities): PartnerCapabilitiesRecord {
  return {
    modelChain: value.modelChain.map(fromProtoRoute),
    permissionMode: fromProtoPermission(value.permissionMode),
    planMode: value.planMode,
    inputHandoff: value.inputHandoff ?? true
  };
}

function fromProtoRoute(value: contract.PartnerModelRoute): PartnerModelRouteRecord {
  return {
    backendId: value.backendId,
    providerId: value.providerId,
    modelId: value.modelId,
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    fastMode: contract.decodeModelSpeed(value)
  };
}

function fromProtoPermission(value: contract.PermissionMode): PartnerCapabilitiesRecord["permissionMode"] {
  if (value === contract.PermissionMode.ASK) return "ask";
  if (value === contract.PermissionMode.ACCEPT_EDITS) return "acceptEdits";
  if (value === contract.PermissionMode.AUTO) return "auto";
  if (value === contract.PermissionMode.BYPASS_PERMISSIONS) return "bypassPermissions";
  throw new ConnectError("Partner permission mode is invalid.", Code.InvalidArgument);
}

function toProtoLifecycle(value: PartnerLifecycle): contract.PartnerLifecycle {
  if (value === "active") return contract.PartnerLifecycle.ACTIVE;
  if (value === "paused") return contract.PartnerLifecycle.PAUSED;
  if (value === "archived") return contract.PartnerLifecycle.ARCHIVED;
  return contract.PartnerLifecycle.DELETED;
}

function fromProtoLifecycle(value: contract.PartnerLifecycle): PartnerLifecycle {
  if (value === contract.PartnerLifecycle.ACTIVE) return "active";
  if (value === contract.PartnerLifecycle.PAUSED) return "paused";
  if (value === contract.PartnerLifecycle.ARCHIVED) return "archived";
  if (value === contract.PartnerLifecycle.DELETED) return "deleted";
  throw new ConnectError("Partner lifecycle is required.", Code.InvalidArgument);
}

function toProtoInitializationState(value: PartnerInitializationState): contract.PartnerInitializationState {
  if (value === "pending") return contract.PartnerInitializationState.PENDING;
  if (value === "ready") return contract.PartnerInitializationState.READY;
  return contract.PartnerInitializationState.ERROR;
}

function toProtoInvitationStage(value: PartnerInvitationStage): contract.PartnerInvitationStage {
  if (value === "home") return contract.PartnerInvitationStage.HOME;
  if (value === "avatar") return contract.PartnerInvitationStage.AVATAR;
  if (value === "session") return contract.PartnerInvitationStage.SESSION;
  if (value === "ready") return contract.PartnerInvitationStage.READY;
  return contract.PartnerInvitationStage.FAILED;
}

function toProtoInitializationError(value: PartnerInitializationErrorCode): contract.PartnerInitializationErrorCode {
  if (value === "home_unavailable") return contract.PartnerInitializationErrorCode.HOME_UNAVAILABLE;
  if (value === "avatar_unavailable") return contract.PartnerInitializationErrorCode.AVATAR_UNAVAILABLE;
  if (value === "model_unavailable") return contract.PartnerInitializationErrorCode.MODEL_UNAVAILABLE;
  if (value === "session_unavailable") return contract.PartnerInitializationErrorCode.SESSION_UNAVAILABLE;
  return contract.PartnerInitializationErrorCode.STATE_CHANGED;
}

function toProtoTaskOutput(row: PartnerTaskOutputRow): contract.PartnerTaskOutput {
  return create(contract.PartnerTaskOutputSchema, {
    sourceKind: row.kind === "task" ? contract.PartnerTaskOutputSourceKind.SESSION_TASK : contract.PartnerTaskOutputSourceKind.DELEGATION,
    sourceId: row.id,
    parentSessionId: row.parentSessionId,
    sessionId: row.sessionId,
    execution: BigInt(row.execution),
    runIds: [...row.runIds],
    sourceRevision: toProtoRevision(row.revision),
    title: row.title,
    readiness: row.readiness === "ready" ? contract.PartnerTaskOutputReadiness.READY
      : row.readiness === "pending" ? contract.PartnerTaskOutputReadiness.PENDING : contract.PartnerTaskOutputReadiness.UNAVAILABLE,
    files: row.files.map(file => ({ path: file.path, status: file.status === "added" ? contract.PartnerTaskOutputFileStatus.ADDED
      : file.status === "modified" ? contract.PartnerTaskOutputFileStatus.MODIFIED : contract.PartnerTaskOutputFileStatus.RENAMED })),
    truncated: row.truncated
  });
}

async function partnerRpc<T>(effect: () => Promise<T>): Promise<T>;
function partnerRpc<T>(effect: () => T): T;
function partnerRpc<T>(effect: () => T | Promise<T>): T | Promise<T> {
  try {
    const result = effect();
    return result instanceof Promise
      ? result.catch((error: unknown) => { throw partnerConnectError(error); })
      : result;
  } catch (error) {
    throw partnerConnectError(error);
  }
}

function partnerConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof PartnerTaskOutputChangedError) return new ConnectError("Partner task outputs changed. Read them again.", Code.Aborted);
  if (error instanceof PartnerManagerError) {
    return new ConnectError(error.message,
      error.code === "PARTNER_TEMPLATE_INVALID" || error.code === "PARTNER_AVATAR_INVALID"
        ? Code.InvalidArgument
        : Code.FailedPrecondition);
  }
  if (error instanceof PartnerStoreError) {
    const code = error.code === "PARTNER_INVALID" ? Code.InvalidArgument
      : error.code === "PARTNER_NOT_FOUND" ? Code.NotFound
        : error.code === "PARTNER_CHANGED" || error.code === "PARTNER_DIRECTORY_CHANGED"
          || error.code === "PARTNER_DELEGATION_CHANGED" || error.code === "PARTNER_CREATION_CONFLICT" ? Code.Aborted
          : error.code === "PARTNER_NAME_CONFLICT" ? Code.AlreadyExists
            : error.code === "PARTNER_SESSION_CONFLICT" || error.code === "PARTNER_CREATION_RETIRED" ? Code.FailedPrecondition
              : error.code === "PARTNER_PRIVATE_LIMIT" ? Code.ResourceExhausted
                : error.code === "PARTNER_PRIVATE_WAIT" ? Code.FailedPrecondition
              : Code.Unavailable;
    return new ConnectError(error.message, code);
  }
  return new ConnectError("The partner operation failed.", Code.Internal);
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new ConnectError(`${field} is required.`, Code.InvalidArgument);
  return value;
}

function safeProtoNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError(`${field} is outside the supported range.`, Code.InvalidArgument);
  }
  return Number(value);
}
