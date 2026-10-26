import {
  NodeDevicePeerAgentLifecycle,
  type NodeDevicePeerAgentConnection,
  type NodeDevicePeerAgentRetirementStage,
  type NodeDevicePeerAgentWorkerRetirementStage,
  type NodeDevicePeerAgentLifecycleOptions
} from "@joko/device-peer";
import { DeviceKind, DevicePeerCapabilityKind } from "@joko/contracts";

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
  /** A Main-only proof probe. A transient native service failure leaves the
   * file/process route available; successful recovery republishes that route. */
  readonly recoverNativeAgents?: (connection: DesktopManagedOrchestratorConnection, signal: AbortSignal) => Promise<boolean>;
  readonly observeRetirement?: (stage: NodeDevicePeerAgentRetirementStage | NodeDevicePeerAgentWorkerRetirementStage
    | "worker_wait_started" | "worker_wait_completed"
    | "native_recovery_wait_started" | "native_recovery_wait_completed") => void;
}

interface NativeRecovery {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly controller: AbortController;
}

/** Desktop retains only profile/credential composition. Route, reconnect,
 * replacement and retirement are owned by the shared pure-Node lifecycle also
 * used by standalone Service Devices. */
export class DesktopDevicePeerAgentLifecycle {
  readonly #lifecycle: NodeDevicePeerAgentLifecycle;
  #desired: DesktopManagedOrchestratorConnection | undefined;
  #nodeDesired: NodeDevicePeerAgentConnection | undefined;
  #nativeRecovery: NativeRecovery | undefined;
  readonly #recoveries = new Set<Promise<void>>();
  readonly #observeRetirement: DesktopDevicePeerAgentLifecycleOptions["observeRetirement"];

  constructor(options: DesktopDevicePeerAgentLifecycleOptions) {
    this.#observeRetirement = options.observeRetirement;
    const runRoute = options.runRoute ?? runDesktopDevicePeerAgentRoute;
    const lifecycleOptions: NodeDevicePeerAgentLifecycleOptions = {
      ...(options.observeRetirement === undefined ? {} : { observeRetirement: options.observeRetirement }),
      createExecutor: async () => {
        const desktop = this.#requireDesired(), executor = await options.createExecutor(desktop);
        if (sameConnection(this.#desired, desktop)) {
          if (executor.capabilities.includes(DevicePeerCapabilityKind.NATIVE_AGENTS)) this.#cancelNativeRecovery();
          else if (options.recoverNativeAgents) this.#startNativeRecovery(desktop, options);
        }
        return executor;
      },
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
          ...(options.observeRetirement === undefined ? {} : { observeRetirement: options.observeRetirement }),
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
    this.#cancelNativeRecovery();
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
      endpointPublicKey: connection.endpointPublicKey,
      expectedDeviceKind: DeviceKind.DESKTOP
    });
    this.#lifecycle.setConnection(this.#nodeDesired);
  }

  async stop(): Promise<void> {
    this.#cancelNativeRecovery();
    this.#desired = undefined;
    this.#nodeDesired = undefined;
    await this.#lifecycle.stop();
    await Promise.all([...this.#recoveries]);
  }

  async dispose(): Promise<void> {
    this.#cancelNativeRecovery();
    this.#desired = undefined;
    this.#nodeDesired = undefined;
    this.#retirementProgress("worker_wait_started");
    await this.#lifecycle.dispose();
    this.#retirementProgress("worker_wait_completed");
    this.#retirementProgress("native_recovery_wait_started");
    await Promise.all([...this.#recoveries]);
    this.#retirementProgress("native_recovery_wait_completed");
  }

  #retirementProgress(stage: Parameters<NonNullable<DesktopDevicePeerAgentLifecycleOptions["observeRetirement"]>>[0]): void {
    try { this.#observeRetirement?.(stage); } catch { /* Diagnostics never own retirement. */ }
  }

  #cancelNativeRecovery(): void { this.#nativeRecovery?.controller.abort(); this.#nativeRecovery = undefined; }

  #startNativeRecovery(connection: DesktopManagedOrchestratorConnection, options: DesktopDevicePeerAgentLifecycleOptions): void {
    if (sameConnection(this.#nativeRecovery?.connection, connection)) return;
    this.#cancelNativeRecovery();
    const recovery: NativeRecovery = { connection, controller: new AbortController() };
    this.#nativeRecovery = recovery;
    const current = async () => this.#nativeRecovery === recovery && !recovery.controller.signal.aborted &&
      sameConnection(this.#desired, connection) && await options.isAuthorityCurrent(connection);
    const wait = options.wait ?? recoveryDelay;
    const base = options.retryBaseDelayMs ?? 500, maximum = options.retryMaximumDelayMs ?? 30_000;
    const worker = (async () => {
      let attempt = 0;
      while (await current()) {
        await wait(Math.min(maximum, base * 2 ** Math.min(attempt++, 20)), recovery.controller.signal);
        if (!await current()) return;
        try {
          if (!await options.recoverNativeAgents!(connection, recovery.controller.signal)) continue;
          if (!await current()) return;
          this.#nativeRecovery = undefined;
          // Use the established lifecycle's generation change and exact old
          // executor retirement. A recovered capability never mutates a live
          // route or borrows its outstanding native calls.
          this.#lifecycle.setConnection(undefined);
          this.#lifecycle.setConnection(this.#nodeDesired);
          return;
        } catch { /* Proof, endpoint and native details remain Main-private. */ }
      }
    })().catch(() => {}).finally(() => {
      this.#recoveries.delete(worker);
      if (this.#nativeRecovery === recovery) this.#nativeRecovery = undefined;
    });
    this.#recoveries.add(worker);
  }

  #requireDesired(): DesktopManagedOrchestratorConnection {
    const connection = this.#desired;
    if (connection === undefined) throw new Error("Desktop Device peer authority is unavailable.");
    return connection;
  }
}

function recoveryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); resolve(); };
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new Error("Native recovery was cancelled.")); };
    const timer = setTimeout(done, milliseconds); timer.unref(); signal.addEventListener("abort", aborted, { once: true });
  });
}

function sameNodeIdentity(
  left: NodeDevicePeerAgentConnection,
  right: DesktopManagedOrchestratorConnection
): boolean {
  return left.credentialId === right.profileId
    && left.deviceId === right.deviceId
    && left.serverId === right.serverId
    && left.origin === right.origin
    && left.endpointPublicKey === right.endpointPublicKey
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
    && left.origin === right.origin
    && left.endpointPublicKey === right.endpointPublicKey;
}
