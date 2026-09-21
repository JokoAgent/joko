import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  PartnerStoreError,
  type PartnerCapabilitiesRecord,
  type PartnerDelegationStatus,
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

export function createPartnerConnectService(
  manager: PartnerManager | undefined,
  authenticate: (context: HandlerContext) => unknown
): ServiceImpl<typeof contract.PartnerService> {
  const owner = (): PartnerManager => {
    if (manager === undefined) throw new ConnectError("Partners are unavailable.", Code.Unimplemented);
    return manager;
  };
  return {
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
            toProtoProfile(partner, active.activity(partner.id))),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    getPartner: (request, context) => {
      authenticate(context);
      return partnerRpc(() => create(contract.GetPartnerResponseSchema, {
        partner: toProtoProfile(owner().getPartner(request.partnerId), owner().activity(request.partnerId))
      }));
    },
    createPartner: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => {
        const active = owner();
        const draft = required(request.draft, "draft");
        const capabilities = draft.capabilities === undefined
          ? active.directory().state.defaultCapabilities
          : fromProtoCapabilities(draft.capabilities);
        if (capabilities === undefined) {
          throw new ConnectError("draft.capabilities or configured directory defaults are required.", Code.FailedPrecondition);
        }
        const partner = await active.createPartner({
          expectedDirectoryRevision: fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"),
          displayName: draft.displayName,
          avatar: draft.avatar,
          identitySource: draft.identitySource,
          templateId: draft.templateId,
          capabilities,
          usesDirectoryDefaults: draft.usesDirectoryDefaults
        });
        return create(contract.CreatePartnerResponseSchema, {
          partner: toProtoProfile(partner, active.activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    updatePartner: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => {
        const active = owner();
        const patch = required(request.patch, "patch");
        const current = active.getPartner(request.partnerId);
        const hasCapabilityPatch = patch.modelChain !== undefined
          || patch.permissionMode !== undefined || patch.planMode !== undefined;
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
              planMode: patch.planMode ?? current.capabilities.planMode
            }
          : undefined;
        const partner = await active.updatePartner(
          request.partnerId,
          fromProtoRevision(request.expectedRevision, "expected_revision"),
          {
            ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
            ...(patch.avatar === undefined ? {} : { avatar: patch.avatar }),
            ...(patch.identitySource === undefined ? {} : { identitySource: patch.identitySource }),
            ...(capabilities === undefined ? {} : { capabilities }),
            ...(patch.usesDirectoryDefaults === undefined
              ? {}
              : { usesDirectoryDefaults: patch.usesDirectoryDefaults })
          }
        );
        return create(contract.UpdatePartnerResponseSchema, {
          partner: toProtoProfile(partner, active.activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    setPartnerLifecycle: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => {
        const active = owner();
        const partner = await active.setLifecycle(
          request.partnerId,
          fromProtoRevision(request.expectedRevision, "expected_revision"),
          fromProtoLifecycle(request.lifecycle)
        );
        return create(contract.SetPartnerLifecycleResponseSchema, {
          partner: toProtoProfile(partner, active.activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
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
          partner: toProtoProfile(partner, active.activity(partner.id)),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    updatePartnerDefaults: async (request, context) => {
      authenticate(context);
      return partnerRpc(async () => {
        const active = owner();
        const affected = await active.updateDirectoryDefaults(
          fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"),
          fromProtoCapabilities(required(request.capabilities, "capabilities"))
        );
        return create(contract.UpdatePartnerDefaultsResponseSchema, {
          directory: toProtoDirectory(active.directory()),
          affectedPartners: affected.map((partner) => toProtoProfile(partner, active.activity(partner.id)))
        });
      });
    },
    listPartnerSessions: (request, context) => {
      authenticate(context);
      return partnerRpc(() => create(contract.ListPartnerSessionsResponseSchema, {
        sessions: owner().listSessions(request.partnerId).map(toProtoPartnerSession)
      }));
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
          activity: toProtoActivity(active.activity(request.partnerId))
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

function toProtoProfile(
  profile: PartnerProfileRecord,
  activity: PartnerActivitySummary
): contract.PartnerProfile {
  return create(contract.PartnerProfileSchema, {
    partnerId: profile.id,
    revision: toProtoRevision(profile.revision),
    profileVersion: BigInt(profile.profileVersion),
    displayName: profile.displayName,
    avatar: profile.avatar,
    identitySource: profile.identitySource,
    templateId: profile.templateId,
    lifecycle: toProtoLifecycle(profile.lifecycle),
    initializationState: toProtoInitializationState(profile.initializationState),
    invitationStage: toProtoInvitationStage(profile.invitationStage),
    ...(profile.initializationErrorCode === undefined
      ? {}
      : { initializationErrorCode: toProtoInitializationError(profile.initializationErrorCode) }),
    homeTargetId: profile.homeTargetId,
    ...(profile.canonicalSessionId === undefined ? {} : { canonicalSessionId: profile.canonicalSessionId }),
    capabilities: toProtoCapabilities(profile.capabilities),
    createdAt: toProtoTimestamp(profile.createdAt),
    updatedAt: toProtoTimestamp(profile.updatedAt),
    usesDirectoryDefaults: profile.usesDirectoryDefaults,
    activity: toProtoActivity(activity)
  });
}

function toProtoActivity(activity: PartnerActivitySummary): contract.PartnerActivity {
  return create(contract.PartnerActivitySchema, {
    partnerId: activity.partnerId,
    unreadReplyCount: BigInt(activity.unreadReplyCount),
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
      : view.link.role === "history"
        ? contract.PartnerSessionRole.HISTORY
        : contract.PartnerSessionRole.DELEGATION,
    profileVersion: BigInt(view.link.profileVersion),
    ...(view.link.parentSessionId === undefined ? {} : { parentSessionId: view.link.parentSessionId }),
    ...(view.link.delegationId === undefined ? {} : { delegationId: view.link.delegationId }),
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
    modelChain: value.modelChain.map((route) => create(contract.PartnerModelRouteSchema, route)),
    permissionMode: value.permissionMode === "ask"
      ? contract.PermissionMode.ASK
      : contract.PermissionMode.AUTO,
    planMode: value.planMode
  });
}

function fromProtoCapabilities(value: contract.PartnerCapabilities): PartnerCapabilitiesRecord {
  return {
    modelChain: value.modelChain.map(fromProtoRoute),
    permissionMode: fromProtoPermission(value.permissionMode),
    planMode: value.planMode
  };
}

function fromProtoRoute(value: contract.PartnerModelRoute): PartnerModelRouteRecord {
  return {
    backendId: value.backendId,
    providerId: value.providerId,
    modelId: value.modelId,
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    fastMode: value.fastMode
  };
}

function fromProtoPermission(value: contract.PermissionMode): "ask" | "auto" {
  if (value === contract.PermissionMode.ASK) return "ask";
  if (value === contract.PermissionMode.AUTO) return "auto";
  throw new ConnectError("Partner permission mode must be Ask or Auto.", Code.InvalidArgument);
}

function toProtoLifecycle(value: PartnerLifecycle): contract.PartnerLifecycle {
  if (value === "active") return contract.PartnerLifecycle.ACTIVE;
  if (value === "archived") return contract.PartnerLifecycle.ARCHIVED;
  return contract.PartnerLifecycle.DELETED;
}

function fromProtoLifecycle(value: contract.PartnerLifecycle): PartnerLifecycle {
  if (value === contract.PartnerLifecycle.ACTIVE) return "active";
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
          || error.code === "PARTNER_DELEGATION_CHANGED" ? Code.Aborted
          : error.code === "PARTNER_NAME_CONFLICT" ? Code.AlreadyExists
            : error.code === "PARTNER_SESSION_CONFLICT" ? Code.FailedPrecondition
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
