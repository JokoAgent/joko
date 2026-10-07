import {
  NodeDevicePeerAgentLifecycle,
  type NodeDevicePeerAgentConnection,
  type NodeDevicePeerAgentLifecycleOptions
} from "@joko/device-peer";
import { DeviceKind } from "@joko/contracts";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";
import type { DesktopDevicePeerAgentExecutor } from "./device-peer-agent.js";
import {
  runDesktopDevicePeerAgentRoute,
  type DesktopDevicePeerAgentRouteOptions
} from "./device-peer-agent-route.js";

type DevicePeerAgentExecutor = Pick<
  DesktopDevicePeerAgentExecutor,
  "capabilities" | "execute" | "retire"
>;

type DevicePeerAgentRouteRunner = (
  options: DesktopDevicePeerAgentRouteOptions
) => Promise<void>;

export interface DesktopDevicePeerAgentLifecycleOptions {
  readonly createExecutor: (
    connection: DesktopManagedOrchestratorConnection
  ) => DevicePeerAgentExecutor | Promise<DevicePeerAgentExecutor>;
  /** Renderer-profile bearer used only for the authenticated identity probe. */
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly readDefaultDeviceName: () => string;
  /** Main-only bootstrap authority; never backed by renderer credential IPC. */
  readonly readRouteAuthorization: (profileId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (
    connection: DesktopManagedOrchestratorConnection
  ) => boolean | Promise<boolean>;
  readonly runRoute?: DevicePeerAgentRouteRunner;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly retryBaseDelayMs?: number;
  readonly retryMaximumDelayMs?: number;
}

/** Desktop retains only profile/credential composition. Route, reconnect,
 * replacement and retirement are owned by the shared pure-Node lifecycle also
 * used by standalone Service Devices. */
export class DesktopDevicePeerAgentLifecycle {
  readonly #lifecycle: NodeDevicePeerAgentLifecycle;
  #desired: DesktopManagedOrchestratorConnection | undefined;
  #nodeDesired: NodeDevicePeerAgentConnection | undefined;

  constructor(options: DesktopDevicePeerAgentLifecycleOptions) {
    const runRoute = options.runRoute ?? runDesktopDevicePeerAgentRoute;
    const lifecycleOptions: NodeDevicePeerAgentLifecycleOptions = {
      createExecutor: () => options.createExecutor(this.#requireDesired()),
      readAuthKey: options.readAuthKey,
      readDefaultDeviceName: options.readDefaultDeviceName,
      readRouteAuthorization: options.readRouteAuthorization,
      isAuthorityCurrent: () => options.isAuthorityCurrent(this.#requireDesired()),
      runRoute: async (nodeOptions) => {
        const desktop = this.#requireDesired();
        await runRoute({
          connection: desktop,
          executor: nodeOptions.executor,
          signal: nodeOptions.signal,
          readAuthKey: nodeOptions.readAuthKey,
          readDefaultDeviceName: nodeOptions.readDefaultDeviceName,
          readRouteAuthorization: nodeOptions.readRouteAuthorization
            ?? (() => Promise.resolve(undefined)),
          isAuthorityCurrent: (candidate) => sameConnection(candidate, desktop)
            && nodeOptions.isAuthorityCurrent(nodeOptions.connection)
        });
      },
      ...(options.wait === undefined ? {} : { wait: options.wait }),
      ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
      ...(options.retryMaximumDelayMs === undefined
        ? {}
        : { retryMaximumDelayMs: options.retryMaximumDelayMs })
    };
    this.#lifecycle = new NodeDevicePeerAgentLifecycle(lifecycleOptions);
  }

  setConnection(connection: DesktopManagedOrchestratorConnection | undefined): void {
    if (sameConnection(this.#desired, connection)) {
      this.#lifecycle.setConnection(this.#nodeDesired);
      return;
    }
    // Presentation-name replacement is still an exact Desktop authority
    // change even though the neutral route identity has no display field.
    if (connection !== undefined && this.#nodeDesired !== undefined
      && sameNodeIdentity(this.#nodeDesired, connection)) {
      this.#lifecycle.setConnection(undefined);
    }
    this.#desired = connection;
    this.#nodeDesired = connection === undefined ? undefined : Object.freeze({
      credentialId: connection.profileId,
      deviceId: connection.deviceId,
      serverId: connection.serverId,
      origin: connection.origin,
      expectedDeviceKind: DeviceKind.DESKTOP
    });
    this.#lifecycle.setConnection(this.#nodeDesired);
  }

  async stop(): Promise<void> {
    this.#desired = undefined;
    this.#nodeDesired = undefined;
    await this.#lifecycle.stop();
  }

  async dispose(): Promise<void> {
    this.#desired = undefined;
    this.#nodeDesired = undefined;
    await this.#lifecycle.dispose();
  }

  #requireDesired(): DesktopManagedOrchestratorConnection {
    const connection = this.#desired;
    if (connection === undefined) throw new Error("Desktop Device peer authority is unavailable.");
    return connection;
  }
}

function sameNodeIdentity(
  left: NodeDevicePeerAgentConnection,
  right: DesktopManagedOrchestratorConnection
): boolean {
  return left.credentialId === right.profileId
    && left.deviceId === right.deviceId
    && left.serverId === right.serverId
    && left.origin === right.origin
    && left.expectedDeviceKind === DeviceKind.DESKTOP;
}

function sameConnection(
  left: DesktopManagedOrchestratorConnection | undefined,
  right: DesktopManagedOrchestratorConnection | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.profileId === right.profileId
    && left.deviceId === right.deviceId
    && left.serverId === right.serverId
    && left.name === right.name
    && left.origin === right.origin;
}
