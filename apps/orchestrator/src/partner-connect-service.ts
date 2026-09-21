import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  PartnerStoreError,
  type PartnerCapabilitiesRecord,
  type PartnerInitializationErrorCode,
  type PartnerInitializationState,
  type PartnerInvitationStage,
  type PartnerLifecycle,
  type PartnerModelRouteRecord,
  type PartnerProfileRecord
} from "@joko/store";

import { PartnerManager, PartnerManagerError, type PartnerDirectoryView } from "./partner-manager.js";
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
          partners: active.listPartners(lifecycle).map(toProtoProfile),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    getPartner: (request, context) => {
      authenticate(context);
      return partnerRpc(() => create(contract.GetPartnerResponseSchema, {
        partner: toProtoProfile(owner().getPartner(request.partnerId))
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
          partner: toProtoProfile(partner),
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
          partner: toProtoProfile(partner),
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
          partner: toProtoProfile(partner),
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
          partner: toProtoProfile(partner),
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
          affectedPartners: affected.map(toProtoProfile)
        });
      });
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

function toProtoProfile(profile: PartnerProfileRecord): contract.PartnerProfile {
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
    usesDirectoryDefaults: profile.usesDirectoryDefaults
  });
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
        : error.code === "PARTNER_CHANGED" || error.code === "PARTNER_DIRECTORY_CHANGED" ? Code.Aborted
          : error.code === "PARTNER_NAME_CONFLICT" ? Code.AlreadyExists
            : error.code === "PARTNER_SESSION_CONFLICT" ? Code.FailedPrecondition
              : Code.Unavailable;
    return new ConnectError(error.message, code);
  }
  return new ConnectError("The partner operation failed.", Code.Internal);
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new ConnectError(`${field} is required.`, Code.InvalidArgument);
  return value;
}
