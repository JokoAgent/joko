import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionRecord } from "@joko/store";

import type { ConnectionManager } from "./connection-manager.js";
import { fromProtoRouteIdentity } from "./device-peer-connect-service.js";
import type { DevicePeerOwner, DevicePeerSelectionIdentity, DevicePeerSelectionView } from "./device-peer-owner.js";
import {
  RemoteDesktopCoordinatorError,
  type RemoteDesktopCoordinator
} from "./remote-desktop-coordinator.js";
import { toProtoRevision } from "./proto-mapper.js";

const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;

type RemoteDesktopConnections = Pick<ConnectionManager, "authenticate" | "fence">;

export interface RemoteDesktopConnectServiceDependencies {
  readonly coordinator: RemoteDesktopCoordinator;
  readonly owner: DevicePeerOwner;
  readonly connections: RemoteDesktopConnections;
}

/** Authenticated controller surface; target identity is always route-fenced. */
export function createRemoteDesktopConnectService(
  dependencies: RemoteDesktopConnectServiceDependencies
): ServiceImpl<typeof contract.RemoteDesktopService> {
  return {
    listRemoteDesktopHosts: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const hosts = dependencies.owner.listForCapabilities(connection, ["remote_desktop"], { kind: "desktop" });
      const page = paginate(hosts, request.page, `remote-desktop-hosts:${connection.deviceId}`);
      dependencies.connections.fence(connection);
      return create(contract.ListRemoteDesktopHostsResponseSchema, {
        hosts: page.values.map(toProtoHost),
        page: page.page
      });
    }),

    getRemoteDesktopCapabilities: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const capabilities = await dependencies.coordinator.getCapabilities(connection, peer, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.GetRemoteDesktopCapabilitiesResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        capabilities
      });
    }),

    getRemoteDesktopPermissions: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const permissions = await dependencies.coordinator.getPermissions(connection, peer, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.GetRemoteDesktopPermissionsResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        permissions
      });
    }),

    showRemoteDesktopPermissionGuide: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const permissions = await dependencies.coordinator.showPermissionGuide(connection, peer, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.ShowRemoteDesktopPermissionGuideResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        permissions
      });
    }),

    startRemoteDesktop: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const lease = await dependencies.coordinator.start(connection, peer, {
        displayId: request.displayId,
        mode: request.mode
      }, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.StartRemoteDesktopResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        lease
      });
    }),

    heartbeatRemoteDesktop: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const state = await dependencies.coordinator.heartbeat(connection, peer, request.leaseId, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.HeartbeatRemoteDesktopResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        state
      });
    }),

    stopRemoteDesktop: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      await dependencies.coordinator.stop(connection, peer, request.leaseId, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.StopRemoteDesktopResponseSchema, { peer: toProtoRouteIdentity(peer) });
    }),

    setRemoteDesktopControl: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const state = await dependencies.coordinator.setControl(connection, peer, {
        leaseId: request.leaseId,
        enabled: request.enabled
      }, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.SetRemoteDesktopControlResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        state
      });
    }),

    setRemoteDesktopPresentation: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const state = await dependencies.coordinator.setPresentation(connection, peer, {
        leaseId: request.leaseId,
        enabled: request.enabled
      }, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.SetRemoteDesktopPresentationResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        state
      });
    }),

    sendRemoteDesktopInput: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      await dependencies.coordinator.sendInput(connection, peer, {
        leaseId: request.leaseId,
        sequence: request.sequence,
        events: request.events
      }, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.SendRemoteDesktopInputResponseSchema, { peer: toProtoRouteIdentity(peer) });
    }),

    getRemoteDesktopIceConfiguration: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const iceServers = await dependencies.coordinator.getIceConfiguration(
        connection,
        peer,
        request.leaseId,
        context.signal
      );
      dependencies.connections.fence(connection);
      return create(contract.GetRemoteDesktopIceConfigurationResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        iceServers: [...iceServers]
      });
    }),

    createRemoteDesktopOffer: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const offer = await dependencies.coordinator.createOffer(connection, peer, {
        leaseId: request.leaseId,
        attemptId: request.attemptId,
        offerSdp: request.offerSdp,
        ...(request.settings === undefined ? {} : { settings: request.settings })
      }, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.CreateRemoteDesktopOfferResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        offer
      });
    }),

    exchangeRemoteDesktopIce: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const exchange = await dependencies.coordinator.exchangeIce(connection, peer, {
        leaseId: request.leaseId,
        attemptId: request.attemptId,
        candidates: request.candidates,
        after: request.after
      }, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.ExchangeRemoteDesktopIceResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        exchange
      });
    }),

    getRemoteDesktopFrame: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      const result = await dependencies.coordinator.getFrame(connection, peer, request.leaseId, context.signal);
      dependencies.connections.fence(connection);
      return create(contract.GetRemoteDesktopFrameResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        result
      });
    }),

    transferRemoteDesktopClipboardText: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      if (request.transfer === undefined) {
        throw new ConnectError("Remote Desktop clipboard transfer is required.", Code.InvalidArgument);
      }
      const result = await dependencies.coordinator.transferClipboardText(
        connection,
        peer,
        request.transfer,
        context.signal
      );
      dependencies.connections.fence(connection);
      return create(contract.TransferRemoteDesktopClipboardTextResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        result
      });
    }),

    transferRemoteDesktopClipboardContent: (request, context) => remoteDesktopRpc(async () => {
      const connection = authenticate(dependencies.connections, context);
      const peer = fromProtoRouteIdentity(request.peer);
      if (request.transfer === undefined) {
        throw new ConnectError("Remote Desktop clipboard transfer is required.", Code.InvalidArgument);
      }
      const result = await dependencies.coordinator.transferClipboardContent(
        connection,
        peer,
        request.transfer,
        context.signal
      );
      dependencies.connections.fence(connection);
      return create(contract.TransferRemoteDesktopClipboardContentResponseSchema, {
        peer: toProtoRouteIdentity(peer),
        result
      });
    })
  };
}

function authenticate(connections: RemoteDesktopConnections, context: HandlerContext): ConnectionRecord {
  return connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
}

async function remoteDesktopRpc<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (!(error instanceof RemoteDesktopCoordinatorError)) throw error;
    const code = error.code === "invalid_argument" ? Code.InvalidArgument
      : error.code === "not_found" ? Code.NotFound
        : error.code === "permission_denied" ? Code.PermissionDenied
          : error.code === "unimplemented" ? Code.Unimplemented
            : error.code === "unavailable" ? Code.Unavailable
              : error.code === "aborted" ? Code.Aborted
                : error.code === "cancelled" ? Code.Canceled
                  : error.code === "internal" ? Code.Internal : Code.FailedPrecondition;
    throw new ConnectError(
      error.message,
      code,
      undefined,
      error.detail === undefined ? undefined : [{ desc: contract.RemoteDesktopFailureSchema, value: error.detail }],
      error
    );
  }
}

interface PageSlice<T> {
  readonly values: readonly T[];
  readonly page: contract.PageInfo;
}

function paginate<T>(values: readonly T[], request: contract.PageRequest | undefined, kind: string): PageSlice<T> {
  const offset = decodePageToken(request?.pageToken ?? "", kind);
  const size = Math.min(Math.max(request?.pageSize || DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);
  const next = Math.min(offset + size, values.length);
  return {
    values: values.slice(offset, next),
    page: create(contract.PageInfoSchema, {
      nextPageToken: next < values.length ? encodePageToken(kind, next) : "",
      totalSize: BigInt(values.length)
    })
  };
}

function encodePageToken(kind: string, offset: number): string {
  return Buffer.from(`v1\u0000${kind}\u0000${offset}`, "utf8").toString("base64url");
}

function decodePageToken(token: string, kind: string): number {
  if (token === "") return 0;
  if (token.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(token)) throw invalidPageToken();
  let decoded: string;
  try { decoded = Buffer.from(token, "base64url").toString("utf8"); }
  catch { throw invalidPageToken(); }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== token) throw invalidPageToken();
  const prefix = `v1\u0000${kind}\u0000`;
  if (!decoded.startsWith(prefix)) throw invalidPageToken();
  const raw = decoded.slice(prefix.length);
  if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(raw)) throw invalidPageToken();
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset)) throw invalidPageToken();
  return offset;
}

function invalidPageToken(): ConnectError {
  return new ConnectError("The page token is invalid.", Code.InvalidArgument);
}

function toProtoRouteIdentity(value: DevicePeerSelectionIdentity): contract.DevicePeerRouteIdentity {
  return create(contract.DevicePeerRouteIdentitySchema, {
    targetDeviceId: value.targetDeviceId,
    relationId: value.relationId,
    targetDeviceRevision: toProtoRevision(value.targetDeviceRevision),
    relationRevision: toProtoRevision(value.relationRevision),
    routeGeneration: BigInt(value.routeGeneration)
  });
}

function toProtoHost(value: DevicePeerSelectionView): contract.DevicePeerDescriptor {
  return create(contract.DevicePeerDescriptorSchema, {
    route: toProtoRouteIdentity(value),
    displayName: value.displayName,
    kind: contract.DeviceKind.DESKTOP,
    platform: value.platform,
    presence: contract.DevicePresenceState.ONLINE,
    capabilities: [contract.DevicePeerCapabilityKind.REMOTE_DESKTOP]
  });
}
