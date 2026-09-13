import { createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectionService, EventService } from "@joko/contracts";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";

export const MANAGED_RUNTIME_ACTIVITY_TIMEOUT_MS = 2_000;

export interface ManagedRuntimeActivityProbeOptions {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (connection: DesktopManagedOrchestratorConnection) => boolean | Promise<boolean>;
  readonly timeoutMs?: number;
  readonly transportFactory?: (origin: string, authKey: string | undefined, timeoutMs: number) => Transport;
}

export interface ManagedRuntimeActivityDecision {
  readonly blocksShutdown: boolean;
  readonly lastBlockingActivityAtMs?: number;
}

/** One-shot, authenticated authority query. Missing summaries and every transport
 * failure reject so callers can preserve the fail-closed "busy" decision. */
export async function probeManagedRuntimeActivity(
  options: ManagedRuntimeActivityProbeOptions
): Promise<ManagedRuntimeActivityDecision> {
  const timeoutMs = options.timeoutMs ?? MANAGED_RUNTIME_ACTIVITY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Managed runtime activity timeout must be a positive integer.");
  }
  const canonicalOrigin = new URL(options.connection.origin).origin;
  if (canonicalOrigin !== options.connection.origin) throw new Error("Managed runtime activity authority is invalid.");
  const transportFactory = options.transportFactory ?? createManagedRuntimeTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    // Never decrypt or send the durable bearer until the anonymous stable-ID
    // fence proves the loopback port still belongs to the saved Orchestrator.
    const identity = await createClient(ConnectionService, transportFactory(canonicalOrigin, undefined, timeoutMs))
      .getServerInfo({}, { signal: controller.signal });
    if (identity.server?.serverId !== options.connection.serverId) {
      throw new Error("Managed runtime identity changed.");
    }
    const authKey = await options.readAuthKey(options.connection.profileId);
    if (authKey === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(authKey) ||
      !await options.isAuthorityCurrent(options.connection)) {
      throw new Error("Managed runtime activity authority changed.");
    }
    const response = await createClient(
      EventService,
      transportFactory(canonicalOrigin, authKey, timeoutMs)
    ).getRuntimeActivity({}, {
      signal: controller.signal
    });
    if (response.summary === undefined) throw new Error("Managed runtime activity summary is unavailable.");
    if (!await options.isAuthorityCurrent(options.connection)) {
      throw new Error("Managed runtime activity authority changed.");
    }
    const lastBlockingActivityAtMs = timestampMilliseconds(response.summary.lastBlockingActivityAt);
    return Object.freeze({
      blocksShutdown: response.summary.blocksShutdown,
      ...(lastBlockingActivityAtMs === undefined ? {} : { lastBlockingActivityAtMs })
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function timestampMilliseconds(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined
): number | undefined {
  if (value === undefined) return undefined;
  if (value.nanos < 0 || value.nanos >= 1_000_000_000 || !Number.isSafeInteger(value.nanos)) {
    throw new Error("Managed runtime activity timestamp is invalid.");
  }
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("Managed runtime activity timestamp is invalid.");
  }
  return milliseconds;
}

function createManagedRuntimeTransport(origin: string, authKey: string | undefined, timeoutMs: number): Transport {
  const interceptors: Interceptor[] = [];
  if (authKey !== undefined) interceptors.push((next) => (request) => {
    request.header.set("authorization", `Bearer ${authKey}`);
    return next(request);
  });
  return createConnectTransport({
    baseUrl: origin,
    httpVersion: "1.1",
    useBinaryFormat: true,
    interceptors,
    defaultTimeoutMs: timeoutMs
  });
}
