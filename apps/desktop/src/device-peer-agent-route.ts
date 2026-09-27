import {
  DEFAULT_NODE_DEVICE_PEER_AGENT_ROUTE_PORT,
  runNodeDevicePeerAgentRoute,
  type NodeDevicePeerAgentConnection,
  type NodeDevicePeerAgentRoutePort
} from "@joko/device-peer";
import { DeviceKind } from "@joko/contracts";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";
import type { DesktopDevicePeerAgentExecutor } from "./device-peer-agent.js";

export type DesktopDevicePeerAgentRoutePort = NodeDevicePeerAgentRoutePort;

export interface DesktopDevicePeerAgentRouteOptions {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly executor: Pick<DesktopDevicePeerAgentExecutor, "capabilities" | "execute" | "retire">;
  readonly signal: AbortSignal;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly readRouteAuthorization: (profileId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (
    connection: DesktopManagedOrchestratorConnection
  ) => boolean | Promise<boolean>;
  readonly heartbeatIntervalMs?: number;
  readonly port?: DesktopDevicePeerAgentRoutePort;
}

/** Maps Desktop's protected profile identity into the neutral Node route owner. */
export function runDesktopDevicePeerAgentRoute(
  options: DesktopDevicePeerAgentRouteOptions
): Promise<void> {
  const connection: NodeDevicePeerAgentConnection = {
    credentialId: options.connection.profileId,
    deviceId: options.connection.deviceId,
    serverId: options.connection.serverId,
    origin: options.connection.origin,
    expectedDeviceKind: DeviceKind.DESKTOP
  };
  return runNodeDevicePeerAgentRoute({
    connection,
    executor: options.executor,
    signal: options.signal,
    readAuthKey: options.readAuthKey,
    readRouteAuthorization: options.readRouteAuthorization,
    isAuthorityCurrent: async (candidate) => sameNodeConnection(candidate, connection)
      && await options.isAuthorityCurrent(options.connection),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.port === undefined ? {} : { port: options.port })
  });
}

export const DEFAULT_DEVICE_PEER_AGENT_ROUTE_PORT = DEFAULT_NODE_DEVICE_PEER_AGENT_ROUTE_PORT;

function sameNodeConnection(
  left: NodeDevicePeerAgentConnection,
  right: NodeDevicePeerAgentConnection
): boolean {
  return left.credentialId === right.credentialId
    && left.deviceId === right.deviceId
    && left.serverId === right.serverId
    && left.expectedDeviceKind === right.expectedDeviceKind
    && left.origin === right.origin;
}
