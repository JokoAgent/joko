import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { isRemoteSshError } from "@joko/remote-ssh";
import {
  InvalidStateTransitionError,
  NotFoundError,
  RevisionConflictError,
  StoreClosedError,
  StoreError,
  type RemoteHostFailureCode as StoredFailureCode,
  type RemoteHostRecord
} from "@joko/store";

import { fromProtoRevision, ProtoMappingError, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";
import {
  RemoteBackendRuntimeSetupError,
  type RemoteBackendRuntimeInstallEvent,
  type RemoteBackendRuntimeSetupManager,
  type RemoteBackendRuntimeSnapshot
} from "./remote-backend-runtime-setup.js";
import {
  RemoteHostRegistry,
  type RemoteHostRegistryChange
} from "./remote-host-registry.js";

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 500;
const MAXIMUM_WATCH_BACKLOG = 256;

export interface RemoteHostRpcOwner {
  readonly connectionId: string;
}

export type RemoteHostRevocationSubscription = (
  connectionId: string,
  listener: () => void
) => () => void;

/**
 * Public Remote Host API. Owner identity is deliberately absent from this
 * boundary and remains fixed inside the supplied registry.
 */
export function createRemoteHostConnectService(
  registry: RemoteHostRegistry | undefined,
  authenticate: (context: HandlerContext) => RemoteHostRpcOwner,
  onRevoked?: RemoteHostRevocationSubscription,
  now: () => number = Date.now,
  runtimeSetup?: RemoteBackendRuntimeSetupManager
): ServiceImpl<typeof contract.RemoteHostService> {
  return {
    getRemoteHostCapabilities: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const targetId = publicIdentity(request.targetId, "target_id");
      if (registry !== undefined) registry.list(targetId);
      const available = registry?.capabilities();
      const catalogSupport = registry === undefined
        ? contract.CapabilitySupport.NOT_IMPLEMENTED
        : contract.CapabilitySupport.SUPPORTED;
      const connectionSupport = available?.connectionLifecycle === true
        ? contract.CapabilitySupport.SUPPORTED
        : registry === undefined
          ? contract.CapabilitySupport.NOT_IMPLEMENTED
          : contract.CapabilitySupport.UPSTREAM_MISSING;
      const testSupport = available?.connectionTest === true
        ? contract.CapabilitySupport.SUPPORTED
        : registry === undefined
          ? contract.CapabilitySupport.NOT_IMPLEMENTED
          : contract.CapabilitySupport.UPSTREAM_MISSING;
      const transportSupport = (supported: boolean | undefined): contract.CapabilitySupport =>
        supported === true
          ? contract.CapabilitySupport.SUPPORTED
          : registry === undefined
            ? contract.CapabilitySupport.NOT_IMPLEMENTED
            : contract.CapabilitySupport.UPSTREAM_MISSING;
      return create(contract.GetRemoteHostCapabilitiesResponseSchema, {
        capabilities: [
          capability(
            contract.RemoteHostCapabilityKind.CATALOG,
            contract.capabilityNames.remoteHostCatalog,
            catalogSupport
          ),
          capability(
            contract.RemoteHostCapabilityKind.MANAGEMENT,
            contract.capabilityNames.remoteHostManagement,
            catalogSupport
          ),
          capability(
            contract.RemoteHostCapabilityKind.CONNECTION_CONTROL,
            contract.capabilityNames.remoteHostConnectionControl,
            connectionSupport
          ),
          capability(
            contract.RemoteHostCapabilityKind.CONNECTION_TEST,
            contract.capabilityNames.remoteHostConnectionTest,
            testSupport
          ),
          capability(
            contract.RemoteHostCapabilityKind.TRUST_RESET,
            contract.capabilityNames.remoteHostTrustReset,
            catalogSupport
          ),
          capability(
            contract.RemoteHostCapabilityKind.COMMAND_EXECUTION,
            contract.capabilityNames.remoteHostCommandExecution,
            transportSupport(available?.commandExecution)
          ),
          capability(
            contract.RemoteHostCapabilityKind.PROCESS_STREAMING,
            contract.capabilityNames.remoteHostProcessStreaming,
            transportSupport(available?.processStreaming)
          ),
          capability(
            contract.RemoteHostCapabilityKind.FILE_TRANSFER,
            contract.capabilityNames.remoteHostFileTransfer,
            transportSupport(available?.fileTransfer)
          ),
          capability(
            contract.RemoteHostCapabilityKind.TCP_FORWARDING,
            contract.capabilityNames.remoteHostTcpForwarding,
            transportSupport(available?.tcpForwarding)
          ),
          capability(
            contract.RemoteHostCapabilityKind.BACKEND_RUNTIME_SETUP,
            contract.capabilityNames.remoteHostBackendRuntimeSetup,
            runtimeSetup?.supportsTarget(targetId) === true
              ? contract.CapabilitySupport.SUPPORTED
              : runtimeSetup === undefined
                ? contract.CapabilitySupport.NOT_IMPLEMENTED
                : contract.CapabilitySupport.UPSTREAM_MISSING
          )
        ],
        observedAt: toProtoTimestamp(now())
      });
    }),

    listRemoteHosts: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const targetId = publicIdentity(request.targetId, "target_id");
      const result = paginate(requireRegistry(registry).list(targetId), request.page);
      return create(contract.ListRemoteHostsResponseSchema, {
        hosts: result.values.map(toProtoRemoteHost),
        page: result.page
      });
    }),

    getRemoteHost: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const host = requireRegistry(registry).get(
        publicIdentity(request.targetId, "target_id"),
        publicHostAlias(request.hostId)
      );
      return create(contract.GetRemoteHostResponseSchema, { host: toProtoRemoteHost(host) });
    }),

    watchRemoteHosts: async function* (request, context) {
      const owner = authenticate(context);
      const targetId = publicIdentity(request.targetId, "target_id");
      const authority = requireRegistry(registry);
      const queue = new BoundedRemoteHostQueue(context.signal, MAXIMUM_WATCH_BACKLOG);
      let unsubscribe = (): void => undefined;
      let stopRevocation = (): void => undefined;
      try {
        // Subscribe before the authoritative read so no synchronous mutation
        // can be lost between the snapshot and live change stream.
        unsubscribe = authority.subscribe(targetId, (change) => {
          if (!queue.push(change)) queue.close();
        });
        stopRevocation = onRevoked?.(owner.connectionId, () => queue.close()) ?? (() => undefined);
        authenticate(context);
        let sequence = 1n;
        yield create(contract.WatchRemoteHostsResponseSchema, {
          update: {
            case: "snapshot",
            value: create(contract.RemoteHostCatalogSnapshotSchema, {
              hosts: authority.list(targetId).map(toProtoRemoteHost),
              observedAt: toProtoTimestamp(now())
            })
          },
          sequence
        });
        while (!context.signal.aborted) {
          const change = await queue.next();
          if (change === undefined) return;
          authenticate(context);
          sequence += 1n;
          yield create(contract.WatchRemoteHostsResponseSchema, {
            update: {
              case: "change",
              value: create(contract.RemoteHostChangeSchema, {
                kind: change.kind === "upserted"
                  ? contract.RemoteHostChangeKind.UPSERTED
                  : contract.RemoteHostChangeKind.DELETED,
                host: toProtoRemoteHost(change.host),
                observedAt: toProtoTimestamp(now())
              })
            },
            sequence
          });
        }
      } catch (error) {
        throw remoteHostConnectError(error);
      } finally {
        unsubscribe();
        stopRevocation();
        queue.close();
      }
    },

    refreshRemoteHostCatalog: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      publicIdentity(request.requestId, "request_id");
      const hosts = await requireRegistry(registry).refresh(publicIdentity(request.targetId, "target_id"));
      return create(contract.RefreshRemoteHostCatalogResponseSchema, {
        hosts: hosts.map(toProtoRemoteHost),
        refreshedAt: toProtoTimestamp(now())
      });
    }),

    createRemoteHost: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      publicIdentity(request.requestId, "request_id");
      const authenticationMode = publicAuthenticationMode(request.authenticationMode);
      const credentialReferenceId = request.credentialReferenceId === undefined
        ? undefined
        : publicCredentialReference(request.credentialReferenceId);
      assertPublicAuthentication(authenticationMode, credentialReferenceId, request.nodeKey);
      const host = requireRegistry(registry).create({
        targetId: publicIdentity(request.targetId, "target_id"),
        id: publicHostAlias(request.hostId),
        hostname: publicHostname(request.hostname),
        ...(request.port === 0 ? {} : { port: publicPort(request.port) }),
        user: publicUser(request.user),
        source: "manual",
        authenticationMode,
        ...(request.nodeKey === undefined ? {} : { nodeKey: { id: request.nodeKey.id, expectedFingerprint: request.nodeKey.expectedFingerprint } }),
        ...(credentialReferenceId === undefined
          ? {}
          : { credentialReferenceId }),
        createdAt: now()
      });
      return create(contract.CreateRemoteHostResponseSchema, { host: toProtoRemoteHost(host) });
    }),

    updateRemoteHost: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const authenticationMode = publicAuthenticationMode(request.authenticationMode);
      const credentialReferenceId = request.credentialReferenceId === undefined
        ? undefined
        : publicCredentialReference(request.credentialReferenceId);
      assertPublicAuthentication(authenticationMode, credentialReferenceId, request.nodeKey);
      const host = requireRegistry(registry).update({
        targetId: publicIdentity(request.targetId, "target_id"),
        id: publicHostAlias(request.hostId),
        hostname: publicHostname(request.hostname),
        port: publicPort(request.port),
        user: publicUser(request.user),
        authenticationMode,
        credentialReferenceId: credentialReferenceId ?? null,
        nodeKey: request.nodeKey === undefined ? null : { id: request.nodeKey.id, expectedFingerprint: request.nodeKey.expectedFingerprint },
        expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
        updatedAt: now()
      });
      return create(contract.UpdateRemoteHostResponseSchema, { host: toProtoRemoteHost(host) });
    }),

    deleteRemoteHost: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const host = requireRegistry(registry).delete({
        targetId: publicIdentity(request.targetId, "target_id"),
        id: publicHostAlias(request.hostId),
        expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision")
      });
      return create(contract.DeleteRemoteHostResponseSchema, { host: toProtoRemoteHost(host) });
    }),

    connectRemoteHost: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const result = await requireRegistry(registry).connect(
        publicIdentity(request.targetId, "target_id"),
        publicHostAlias(request.hostId),
        fromProtoRevision(request.expectedRevision, "expected_revision"),
        context.signal
      );
      return create(contract.ConnectRemoteHostResponseSchema, { host: toProtoRemoteHost(result.host) });
    }),

    disconnectRemoteHost: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const host = await requireRegistry(registry).disconnect(
        publicIdentity(request.targetId, "target_id"),
        publicHostAlias(request.hostId),
        fromProtoRevision(request.expectedRevision, "expected_revision")
      );
      return create(contract.DisconnectRemoteHostResponseSchema, { host: toProtoRemoteHost(host) });
    }),

    testRemoteHostConnection: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const result = await requireRegistry(registry).test(
        publicIdentity(request.targetId, "target_id"),
        publicHostAlias(request.hostId),
        fromProtoRevision(request.expectedRevision, "expected_revision"),
        context.signal
      );
      return create(contract.TestRemoteHostConnectionResponseSchema, {
        result: create(contract.RemoteHostConnectionTestResultSchema, {
          outcome: result.ok
            ? contract.RemoteHostConnectionTestOutcome.SUCCEEDED
            : contract.RemoteHostConnectionTestOutcome.FAILED,
          host: toProtoRemoteHost(result.host),
          testedAt: toProtoTimestamp(now())
        })
      });
    }),

    clearRemoteHostTrust: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const host = requireRegistry(registry).clearTrust({
        targetId: publicIdentity(request.targetId, "target_id"),
        id: publicHostAlias(request.hostId),
        expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"),
        clearedAt: now()
      });
      return create(contract.ClearRemoteHostTrustResponseSchema, { host: toProtoRemoteHost(host) });
    }),

    probeRemoteBackendRuntime: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const runtime = await requireRuntimeSetup(runtimeSetup).probe({
        targetId: publicIdentity(request.targetId, "target_id"),
        hostId: publicHostAlias(request.hostId),
        expectedTargetRevision: fromProtoRevision(request.expectedTargetRevision, "expected_target_revision"),
        expectedHostRevision: fromProtoRevision(request.expectedHostRevision, "expected_host_revision")
      }, context.signal);
      return create(contract.ProbeRemoteBackendRuntimeResponseSchema, {
        runtime: toProtoRemoteBackendRuntime(runtime)
      });
    }),

    installRemoteBackendRuntime: async function* (request, context) {
      try {
        authenticate(context);
        const events = requireRuntimeSetup(runtimeSetup).install({
          requestId: publicIdentity(request.requestId, "request_id"),
          targetId: publicIdentity(request.targetId, "target_id"),
          hostId: publicHostAlias(request.hostId),
          expectedTargetRevision: fromProtoRevision(request.expectedTargetRevision, "expected_target_revision"),
          expectedHostRevision: fromProtoRevision(request.expectedHostRevision, "expected_host_revision"),
          reinstall: request.reinstall
        }, context.signal);
        for await (const event of events) yield toProtoRemoteBackendRuntimeInstallEvent(event);
      } catch (error) {
        throw remoteHostConnectError(error);
      }
    },

    uninstallRemoteBackendRuntime: async (request, context) => remoteHostRpc(async () => {
      authenticate(context);
      const runtime = await requireRuntimeSetup(runtimeSetup).uninstall({
        requestId: publicIdentity(request.requestId, "request_id"),
        targetId: publicIdentity(request.targetId, "target_id"),
        hostId: publicHostAlias(request.hostId),
        expectedTargetRevision: fromProtoRevision(request.expectedTargetRevision, "expected_target_revision"),
        expectedHostRevision: fromProtoRevision(request.expectedHostRevision, "expected_host_revision")
      });
      return create(contract.UninstallRemoteBackendRuntimeResponseSchema, {
        runtime: toProtoRemoteBackendRuntime(runtime)
      });
    })
  } satisfies ServiceImpl<typeof contract.RemoteHostService>;
}

function requireRuntimeSetup(value: RemoteBackendRuntimeSetupManager | undefined): RemoteBackendRuntimeSetupManager {
  if (value === undefined) throw new ConnectError("Remote Backend runtime setup is not available.", Code.Unimplemented);
  return value;
}

function requireRegistry(value: RemoteHostRegistry | undefined): RemoteHostRegistry {
  if (value === undefined) {
    throw new ConnectError("Remote Host management is not available.", Code.Unimplemented);
  }
  return value;
}

function capability(
  kind: contract.RemoteHostCapabilityKind,
  name: string,
  support: contract.CapabilitySupport
): contract.RemoteHostCapabilityDescriptor {
  return create(contract.RemoteHostCapabilityDescriptorSchema, { kind, name, support });
}

function toProtoRemoteHost(value: RemoteHostRecord): contract.RemoteHost {
  return create(contract.RemoteHostSchema, {
    targetId: value.targetId,
    hostId: value.id,
    hostname: value.hostname,
    port: value.port,
    user: value.user,
    source: value.source === "manual"
      ? contract.RemoteHostSource.MANUAL
      : contract.RemoteHostSource.SSH_CONFIG,
    authenticationMode: value.authenticationMode === "system_agent"
      ? contract.RemoteHostAuthenticationMode.SYSTEM_AGENT
      : value.authenticationMode === "node_key" ? contract.RemoteHostAuthenticationMode.NODE_KEY : contract.RemoteHostAuthenticationMode.PRIVATE_KEY,
    ...(value.nodeKey === undefined ? {} : { nodeKey: create(contract.SshKeyReferenceSchema, value.nodeKey) }),
    ...(value.credentialReferenceId === undefined
      ? {}
      : { credentialReferenceId: value.credentialReferenceId }),
    ...(value.trust === undefined
      ? {}
      : {
          trust: create(contract.RemoteHostTrustPinSchema, {
            algorithm: value.trust.algorithm,
            sha256Fingerprint: value.trust.fingerprint,
            pinnedAt: toProtoTimestamp(value.trust.pinnedAt)
          })
        }),
    status: create(contract.RemoteHostStatusSnapshotSchema, {
      state: toProtoStatus(value.status.state),
      changedAt: toProtoTimestamp(value.status.changedAt),
      ...(value.status.failure === undefined
        ? {}
        : {
            failure: create(contract.RemoteHostFailureSchema, {
              code: toProtoFailureCode(value.status.failure.code),
              retryable: value.status.failure.retryable
            })
          })
    }),
    createdAt: toProtoTimestamp(value.createdAt),
    updatedAt: toProtoTimestamp(value.updatedAt),
    revision: toProtoRevision(value.revision)
  });
}

function toProtoStatus(value: RemoteHostRecord["status"]["state"]): contract.RemoteHostStatus {
  switch (value) {
    case "disconnected": return contract.RemoteHostStatus.DISCONNECTED;
    case "connecting": return contract.RemoteHostStatus.CONNECTING;
    case "authenticating": return contract.RemoteHostStatus.AUTHENTICATING;
    case "ready": return contract.RemoteHostStatus.READY;
    case "failed": return contract.RemoteHostStatus.FAILED;
  }
}

function toProtoFailureCode(value: StoredFailureCode): contract.RemoteHostFailureCode {
  switch (value) {
    case "aborted": return contract.RemoteHostFailureCode.ABORTED;
    case "authentication_failed": return contract.RemoteHostFailureCode.AUTHENTICATION_FAILED;
    case "node_key_changed": return contract.RemoteHostFailureCode.NODE_KEY_CHANGED;
    case "node_key_unavailable": return contract.RemoteHostFailureCode.NODE_KEY_UNAVAILABLE;
    case "connection_failed": return contract.RemoteHostFailureCode.CONNECTION_FAILED;
    case "connection_timeout": return contract.RemoteHostFailureCode.CONNECTION_TIMEOUT;
    case "connector_protocol": return contract.RemoteHostFailureCode.CONNECTOR_PROTOCOL;
    case "connector_unavailable": return contract.RemoteHostFailureCode.CONNECTOR_UNAVAILABLE;
    case "host_key_changed": return contract.RemoteHostFailureCode.HOST_KEY_CHANGED;
    case "host_key_conflict": return contract.RemoteHostFailureCode.HOST_KEY_CONFLICT;
    case "host_key_invalid": return contract.RemoteHostFailureCode.HOST_KEY_INVALID;
    case "host_key_missing": return contract.RemoteHostFailureCode.HOST_KEY_MISSING;
    case "host_key_store_corrupt": return contract.RemoteHostFailureCode.HOST_KEY_STORE_CORRUPT;
    case "host_key_store_missing": return contract.RemoteHostFailureCode.HOST_KEY_STORE_MISSING;
    case "host_key_store_unreadable": return contract.RemoteHostFailureCode.HOST_KEY_STORE_UNREADABLE;
    case "host_key_store_write_failed": return contract.RemoteHostFailureCode.HOST_KEY_STORE_WRITE_FAILED;
  }
}

interface PageSlice<T> {
  readonly values: readonly T[];
  readonly page: contract.PageInfo;
}

function paginate<T>(values: readonly T[], request: contract.PageRequest | undefined): PageSlice<T> {
  const offset = decodePageToken(request?.pageToken ?? "");
  if (offset > values.length) {
    throw new ConnectError("Remote Host page token is outside the current catalog.", Code.FailedPrecondition);
  }
  const size = Math.min(Math.max(request?.pageSize || DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);
  const selected = values.slice(offset, offset + size);
  const next = offset + selected.length;
  return {
    values: selected,
    page: create(contract.PageInfoSchema, {
      nextPageToken: next < values.length ? encodePageToken(next) : "",
      totalSize: BigInt(values.length)
    })
  };
}

function encodePageToken(offset: number): string {
  return Buffer.from(`joko-remote-host-page:${offset}`, "utf8").toString("base64url");
}

function decodePageToken(token: string): number {
  if (token === "") return 0;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) throw new Error("canonical");
    const match = /^joko-remote-host-page:(\d+)$/u.exec(decoded);
    if (match?.[1] === undefined) throw new Error("format");
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("range");
    return offset;
  } catch {
    throw new ConnectError("Remote Host page_token is malformed.", Code.InvalidArgument);
  }
}

function publicIdentity(value: string, field: string): string {
  if (
    typeof value !== "string" || value === "" || value !== value.trim() ||
    value.length > 256 || /[\p{Cc}\u2028\u2029]/u.test(value)
  ) {
    throw new ConnectError(`Remote Host ${field} is invalid.`, Code.InvalidArgument);
  }
  return value;
}

function publicHostAlias(value: string): string {
  const alias = publicIdentity(value, "host_id");
  if (alias.startsWith("!") || /[\s*?'"\\#]/u.test(alias)) {
    throw new ConnectError("Remote Host host_id must identify one concrete host.", Code.InvalidArgument);
  }
  return alias;
}

function publicHostname(value: string): string {
  if (
    typeof value !== "string" || value === "" || value !== value.trim() || value.length > 1_024 ||
    /[\p{Cc}\u2028\u2029\s\/@'"\\#]/u.test(value)
  ) throw new ConnectError("Remote Host hostname is invalid.", Code.InvalidArgument);
  return value;
}

function publicPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new ConnectError("Remote Host port must be between 1 and 65535.", Code.InvalidArgument);
  }
  return value;
}

function publicUser(value: string): string {
  const user = publicIdentity(value, "user");
  if (/[\s@'"\\#]/u.test(user)) {
    throw new ConnectError("Remote Host user is invalid.", Code.InvalidArgument);
  }
  return user;
}

function publicCredentialReference(value: string): string {
  if (value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(value)) {
    throw new ConnectError("Remote Host credential_reference_id is invalid.", Code.InvalidArgument);
  }
  return value;
}

function publicAuthenticationMode(
  value: contract.RemoteHostAuthenticationMode
): "system_agent" | "private_key" | "node_key" {
  if (value === contract.RemoteHostAuthenticationMode.SYSTEM_AGENT) return "system_agent";
  if (value === contract.RemoteHostAuthenticationMode.PRIVATE_KEY) return "private_key";
  if (value === contract.RemoteHostAuthenticationMode.NODE_KEY) return "node_key";
  throw new ConnectError("Remote Host authentication_mode is required.", Code.InvalidArgument);
}

function assertPublicAuthentication(
  mode: "system_agent" | "private_key" | "node_key",
  credentialReferenceId: string | undefined,
  nodeKey: contract.SshKeyReference | undefined
): void {
  if ((mode === "private_key") !== (credentialReferenceId !== undefined) ||
    (mode === "node_key") !== (nodeKey !== undefined)) {
    throw new ConnectError("Remote Host authentication metadata is inconsistent.", Code.InvalidArgument);
  }
  if (nodeKey !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(nodeKey.id) ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(nodeKey.expectedFingerprint))) {
    throw new ConnectError("Remote Host node_key identity is invalid.", Code.InvalidArgument);
  }
}

function toProtoRemoteBackendRuntime(value: RemoteBackendRuntimeSnapshot): contract.RemoteBackendRuntime {
  return create(contract.RemoteBackendRuntimeSchema, {
    targetId: value.targetId,
    hostId: value.hostId,
    displayName: value.displayName,
    expectedVersion: value.expectedVersion,
    ...(value.installedVersion === undefined ? {} : { installedVersion: value.installedVersion }),
    state: toProtoRemoteBackendRuntimeState(value.state),
    canInstall: value.canInstall,
    canReinstall: value.canReinstall,
    canUninstall: value.canUninstall,
    ...(value.failure === undefined ? {} : {
      failure: create(contract.RemoteBackendRuntimeFailureSchema, {
        code: toProtoRemoteBackendRuntimeFailureCode(value.failure.code),
        retryable: value.failure.retryable
      })
    }),
    observedAt: toProtoTimestamp(value.observedAt),
    targetRevision: toProtoRevision(value.targetRevision),
    hostRevision: toProtoRevision(value.hostRevision)
  });
}

function toProtoRemoteBackendRuntimeInstallEvent(
  value: RemoteBackendRuntimeInstallEvent
): contract.InstallRemoteBackendRuntimeResponse {
  return create(contract.InstallRemoteBackendRuntimeResponseSchema, {
    requestId: value.requestId,
    sequence: value.sequence,
    phase: toProtoRemoteBackendRuntimeInstallPhase(value.phase),
    runtime: toProtoRemoteBackendRuntime(value.runtime),
    observedAt: toProtoTimestamp(value.observedAt)
  });
}

function toProtoRemoteBackendRuntimeState(
  value: RemoteBackendRuntimeSnapshot["state"]
): contract.RemoteBackendRuntimeState {
  switch (value) {
    case "probing": return contract.RemoteBackendRuntimeState.PROBING;
    case "not_installed": return contract.RemoteBackendRuntimeState.NOT_INSTALLED;
    case "installing": return contract.RemoteBackendRuntimeState.INSTALLING;
    case "ready": return contract.RemoteBackendRuntimeState.READY;
    case "failed": return contract.RemoteBackendRuntimeState.FAILED;
    case "outcome_unknown": return contract.RemoteBackendRuntimeState.OUTCOME_UNKNOWN;
  }
}

function toProtoRemoteBackendRuntimeInstallPhase(
  value: RemoteBackendRuntimeInstallEvent["phase"]
): contract.RemoteBackendRuntimeInstallPhase {
  switch (value) {
    case "probing": return contract.RemoteBackendRuntimeInstallPhase.PROBING;
    case "downloading": return contract.RemoteBackendRuntimeInstallPhase.DOWNLOADING;
    case "installing": return contract.RemoteBackendRuntimeInstallPhase.INSTALLING;
    case "validating": return contract.RemoteBackendRuntimeInstallPhase.VALIDATING;
    case "complete": return contract.RemoteBackendRuntimeInstallPhase.COMPLETE;
    case "failed": return contract.RemoteBackendRuntimeInstallPhase.FAILED;
    case "outcome_unknown": return contract.RemoteBackendRuntimeInstallPhase.OUTCOME_UNKNOWN;
  }
}

function toProtoRemoteBackendRuntimeFailureCode(
  value: NonNullable<RemoteBackendRuntimeSnapshot["failure"]>["code"]
): contract.RemoteBackendRuntimeFailureCode {
  switch (value) {
    case "aborted": return contract.RemoteBackendRuntimeFailureCode.ABORTED;
    case "authority_changed": return contract.RemoteBackendRuntimeFailureCode.AUTHORITY_CHANGED;
    case "host_not_ready": return contract.RemoteBackendRuntimeFailureCode.HOST_NOT_READY;
    case "not_supported": return contract.RemoteBackendRuntimeFailureCode.NOT_SUPPORTED;
    case "probe_failed": return contract.RemoteBackendRuntimeFailureCode.PROBE_FAILED;
    case "install_failed": return contract.RemoteBackendRuntimeFailureCode.INSTALL_FAILED;
    case "uninstall_failed": return contract.RemoteBackendRuntimeFailureCode.UNINSTALL_FAILED;
    case "busy": return contract.RemoteBackendRuntimeFailureCode.BUSY;
  }
}

class BoundedRemoteHostQueue {
  readonly #signal: AbortSignal;
  readonly #capacity: number;
  readonly #values: RemoteHostRegistryChange[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  constructor(signal: AbortSignal, capacity: number) {
    this.#signal = signal;
    this.#capacity = capacity;
    signal.addEventListener("abort", this.#abort, { once: true });
  }

  push(value: RemoteHostRegistryChange): boolean {
    if (this.#closed || this.#values.length >= this.#capacity) return false;
    this.#values.push(value);
    this.#wake?.();
    this.#wake = undefined;
    return true;
  }

  async next(): Promise<RemoteHostRegistryChange | undefined> {
    while (!this.#closed && !this.#signal.aborted) {
      const value = this.#values.shift();
      if (value !== undefined) return value;
      await new Promise<void>((resolvePromise) => { this.#wake = resolvePromise; });
    }
    return undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values.length = 0;
    this.#signal.removeEventListener("abort", this.#abort);
    this.#wake?.();
    this.#wake = undefined;
  }

  readonly #abort = (): void => this.close();
}

async function remoteHostRpc<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    throw remoteHostConnectError(error);
  }
}

function remoteHostConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
    return new ConnectError("The Remote Host request was cancelled.", Code.Canceled);
  }
  if (error instanceof NotFoundError) return new ConnectError("Remote Host was not found.", Code.NotFound);
  if (error instanceof RevisionConflictError) {
    return new ConnectError("Remote Host changed; reload it and retry.", Code.Aborted);
  }
  if (error instanceof StoreClosedError) {
    return new ConnectError("Remote Host storage is unavailable.", Code.Unavailable);
  }
  if (error instanceof RemoteBackendRuntimeSetupError) {
    const code = error.code === "aborted"
      ? Code.Canceled
      : error.code === "authority_changed"
        ? Code.Aborted
        : error.code === "not_supported"
          ? Code.Unimplemented
          : Code.FailedPrecondition;
    return new ConnectError("Remote Backend runtime request failed safely.", code);
  }
  if (isRemoteSshError(error)) {
    const code = error.code === "ABORTED" ? Code.Canceled
      : error.code === "CONFIG_CONFLICT" ? Code.Aborted
        : error.code === "CONFIG_IO" ? Code.Unavailable
          : error.code === "INVALID_ARGUMENT" || error.code === "OWNER_SCOPE_MISMATCH"
            ? Code.InvalidArgument
            : Code.FailedPrecondition;
    return new ConnectError("Remote Host request failed safely.", code);
  }
  if (error instanceof InvalidStateTransitionError || error instanceof StoreError) {
    return new ConnectError("Remote Host request is not valid in its current state.", Code.FailedPrecondition);
  }
  if (error instanceof ProtoMappingError || error instanceof RangeError) {
    return new ConnectError("Remote Host request contains an invalid value.", Code.InvalidArgument);
  }
  return new ConnectError("Orchestrator could not complete the Remote Host request.", Code.Internal);
}
