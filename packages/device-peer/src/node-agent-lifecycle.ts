import type { NodeDevicePeerAgentExecutor } from "./node-agent-executor.js";
import {
  runNodeDevicePeerAgentRoute,
  type NodeDevicePeerAgentConnection,
  type NodeDevicePeerAgentRouteOptions
} from "./node-agent-route.js";

const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAXIMUM_DELAY_MS = 30_000;

type DevicePeerAgentExecutor = Pick<
  NodeDevicePeerAgentExecutor,
  "capabilities" | "execute" | "retire"
>;

type DevicePeerAgentRouteRunner = (
  options: NodeDevicePeerAgentRouteOptions
) => Promise<void>;

export interface NodeDevicePeerAgentLifecycleOptions {
  readonly createExecutor: (
    connection: NodeDevicePeerAgentConnection
  ) => DevicePeerAgentExecutor | Promise<DevicePeerAgentExecutor>;
  /** Owning Connection bearer used for the authenticated identity probe. */
  readonly readAuthKey: (credentialId: string) => Promise<string | undefined>;
  readonly readRouteAuthorization?: (credentialId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (
    connection: NodeDevicePeerAgentConnection
  ) => boolean | Promise<boolean>;
  readonly runRoute?: DevicePeerAgentRouteRunner;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly retryBaseDelayMs?: number;
  readonly retryMaximumDelayMs?: number;
}

interface ActiveAttempt {
  readonly connection: NodeDevicePeerAgentConnection;
  readonly revision: number;
  readonly controller: AbortController;
  readonly executor: DevicePeerAgentExecutor;
  retirement?: Promise<void>;
}

interface RetryBackoff {
  readonly connection: NodeDevicePeerAgentConnection;
  readonly revision: number;
  readonly controller: AbortController;
}

/**
 * Trusted Node-host owner for exactly one Device peer route. Desired authority is
 * replaced synchronously: the old route is aborted and its executor starts
 * retirement before any new route may be created. Transient failures are
 * retried with a capped exponential delay only while the exact authority is
 * still current. Failures are intentionally not logged because they can be
 * adjacent to protected credentials or peer command payloads.
 */
export class NodeDevicePeerAgentLifecycle {
  readonly #options: Required<Pick<
    NodeDevicePeerAgentLifecycleOptions,
    "createExecutor" | "readAuthKey" | "isAuthorityCurrent"
  >> & {
    readonly readRouteAuthorization?: (credentialId: string) => Promise<string | undefined>;
    readonly runRoute: DevicePeerAgentRouteRunner;
    readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly retryBaseDelayMs: number;
    readonly retryMaximumDelayMs: number;
  };
  #desired: NodeDevicePeerAgentConnection | undefined;
  #revision = 0;
  #active: ActiveAttempt | undefined;
  #backoff: RetryBackoff | undefined;
  #worker: Promise<void> | undefined;
  #disposed = false;

  constructor(options: NodeDevicePeerAgentLifecycleOptions) {
    const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const retryMaximumDelayMs = options.retryMaximumDelayMs ?? DEFAULT_RETRY_MAXIMUM_DELAY_MS;
    if (!positiveInteger(retryBaseDelayMs) || !positiveInteger(retryMaximumDelayMs)
      || retryBaseDelayMs > retryMaximumDelayMs) {
      throw new TypeError("Device peer reconnect delays are invalid.");
    }
    this.#options = {
      createExecutor: options.createExecutor,
      readAuthKey: options.readAuthKey,
      ...(options.readRouteAuthorization === undefined
        ? {}
        : { readRouteAuthorization: options.readRouteAuthorization }),
      isAuthorityCurrent: options.isAuthorityCurrent,
      runRoute: options.runRoute ?? runNodeDevicePeerAgentRoute,
      wait: options.wait ?? abortableDelay,
      retryBaseDelayMs,
      retryMaximumDelayMs
    };
  }

  /** Reconcile the single ready managed Connection, or retire it immediately. */
  setConnection(connection: NodeDevicePeerAgentConnection | undefined): void {
    if (this.#disposed && connection !== undefined) {
      throw new Error("Device peer agent lifecycle is disposed.");
    }
    const sameDesired = sameConnection(this.#desired, connection);
    if (sameDesired && (connection === undefined || this.#worker !== undefined)) return;

    if (!sameDesired) {
      this.#desired = connection;
      this.#revision += 1;
      const active = this.#active;
      if (active !== undefined) {
        active.controller.abort();
        void retireAttempt(active);
      }
      this.#backoff?.controller.abort();
    }
    if (connection !== undefined) this.#ensureWorker();
  }

  async stop(): Promise<void> {
    this.setConnection(undefined);
    await this.#worker;
  }

  async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.setConnection(undefined);
    }
    await this.#worker;
  }

  #ensureWorker(): void {
    if (this.#worker !== undefined || this.#desired === undefined || this.#disposed) return;
    const worker = this.#run().catch(() => {
      // Route, identity, credential, and native executor failures stay inside
      // the trusted Node host owner and never include untrusted detail in logs.
    }).finally(() => {
      if (this.#worker === worker) this.#worker = undefined;
    });
    this.#worker = worker;
  }

  async #run(): Promise<void> {
    let retryIndex = 0;
    let observedRevision = this.#revision;

    while (!this.#disposed) {
      const connection = this.#desired;
      const revision = this.#revision;
      if (connection === undefined) return;
      if (revision !== observedRevision) {
        observedRevision = revision;
        retryIndex = 0;
      }
      if (!await this.#authorityCurrent(connection, revision)) {
        if (revision !== this.#revision) continue;
        return;
      }

      const controller = new AbortController();
      let executor: DevicePeerAgentExecutor;
      try {
        executor = await this.#options.createExecutor(connection);
      } catch {
        if (!await this.#retry(connection, revision, controller, retryIndex++)) {
          if (revision !== this.#revision) continue;
          return;
        }
        continue;
      }

      const attempt: ActiveAttempt = { connection, revision, controller, executor };
      if (!await this.#authorityCurrent(connection, revision)) {
        await retireAttempt(attempt);
        if (revision !== this.#revision) continue;
        return;
      }
      this.#active = attempt;
      try {
        await this.#options.runRoute({
          connection,
          executor,
          signal: controller.signal,
          readAuthKey: this.#options.readAuthKey,
          ...(this.#options.readRouteAuthorization === undefined
            ? {}
            : { readRouteAuthorization: this.#options.readRouteAuthorization }),
          isAuthorityCurrent: (candidate) => this.#authorityCurrent(candidate, revision)
        });
      } catch {
        // A generic route failure contains no payload or credential. Retry is
        // decided solely by the exact local authority below.
      } finally {
        if (this.#active === attempt) this.#active = undefined;
        await retireAttempt(attempt);
      }

      if (!await this.#retry(connection, revision, controller, retryIndex++)) {
        if (revision !== this.#revision) continue;
        return;
      }
    }
  }

  async #retry(
    connection: NodeDevicePeerAgentConnection,
    revision: number,
    controller: AbortController,
    retryIndex: number
  ): Promise<boolean> {
    if (!await this.#authorityCurrent(connection, revision)) return false;
    const delay = retryDelay(
      this.#options.retryBaseDelayMs,
      this.#options.retryMaximumDelayMs,
      retryIndex
    );
    const backoff: RetryBackoff = { connection, revision, controller };
    this.#backoff = backoff;
    try {
      await this.#options.wait(delay, controller.signal);
    } catch {
      return false;
    } finally {
      if (this.#backoff === backoff) this.#backoff = undefined;
    }
    return !controller.signal.aborted && await this.#authorityCurrent(connection, revision);
  }

  async #authorityCurrent(
    connection: NodeDevicePeerAgentConnection,
    revision: number
  ): Promise<boolean> {
    if (this.#disposed || revision !== this.#revision || !sameConnection(this.#desired, connection)) return false;
    try {
      return await this.#options.isAuthorityCurrent(connection);
    } catch {
      return false;
    }
  }
}

function retireAttempt(attempt: ActiveAttempt): Promise<void> {
  attempt.retirement ??= Promise.resolve().then(() => attempt.executor.retire()).catch(() => undefined);
  return attempt.retirement;
}

function retryDelay(base: number, maximum: number, index: number): number {
  const exponent = Math.min(Math.max(index, 0), 30);
  return Math.min(maximum, base * (2 ** exponent));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Device peer reconnect was cancelled."));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", cancel, { once: true });
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
    function finish(): void {
      cleanup();
      resolveDelay();
    }
    function cancel(): void {
      cleanup();
      rejectDelay(new Error("Device peer reconnect was cancelled."));
    }
  });
}

function sameConnection(
  left: NodeDevicePeerAgentConnection | undefined,
  right: NodeDevicePeerAgentConnection | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.credentialId === right.credentialId
    && left.deviceId === right.deviceId
    && left.serverId === right.serverId
    && left.expectedDeviceKind === right.expectedDeviceKind
    && left.origin === right.origin;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
