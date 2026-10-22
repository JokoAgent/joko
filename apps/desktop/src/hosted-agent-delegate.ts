import { randomUUID } from "node:crypto";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectionService, DesktopHostedAgentService } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES, devicePeerNativeAgentMethodEffect, type DevicePeerNativeAgentPort } from "@joko/device-peer";
import type { DesktopManagedOrchestratorConnection } from "./channels.js";

export interface DesktopHostedAgentDelegateOptions {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly readHostKey: (profileId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (connection: DesktopManagedOrchestratorConnection) => boolean | Promise<boolean>;
  readonly transport?: Transport;
  readonly signal?: AbortSignal;
}

/** Main-only delegation to the committed local service. Executable discovery
 * alone never grants native capability. The returned port belongs to exactly
 * one Device route and its cleanup retains only that captured delegate. */
export async function createDesktopHostedAgentDelegate(options: DesktopHostedAgentDelegateOptions): Promise<DevicePeerNativeAgentPort> {
  const connection = Object.freeze({ ...options.connection });
  assertLocalOrigin(connection.origin);
  const assertCurrent = async (): Promise<void> => {
    options.signal?.throwIfAborted();
    if (!await options.isAuthorityCurrent(connection)) throw new Error("Native Desktop authority has retired.");
  };
  await assertCurrent();
  const transport = options.transport ?? createConnectTransport({ baseUrl: connection.origin, httpVersion: "1.1", defaultTimeoutMs: 45_000,
    readMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES + 4_096, writeMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES + 4_096 });
  const initialOptions = options.signal === undefined ? {} : { signal: options.signal };
  const server = await createClient(ConnectionService, transport).getServerInfo({}, initialOptions);
  if (server.server?.serverId !== connection.serverId) throw new Error("Native Desktop service identity changed.");
  await assertCurrent();
  const [authKey, hostKey] = await Promise.all([options.readAuthKey(connection.profileId), options.readHostKey(connection.profileId)]);
  if (!authKey || !hostKey || !/^[A-Za-z0-9_-]{43}$/u.test(authKey) || !/^[A-Za-z0-9_-]{43}$/u.test(hostKey)) {
    throw new Error("Native Desktop authorization is unavailable.");
  }
  await assertCurrent();
  const client = createClient(DesktopHostedAgentService, transport);
  const headers = { authorization: `Bearer ${authKey}`, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${hostKey}` };
  const routeInstanceId = randomUUID();
  const opened = await client.openDesktopHostedAgentDelegate({ format: 1, routeInstanceId }, { headers, ...initialOptions });
  if (opened.format !== 1 || opened.serverId !== connection.serverId || !/^[A-Za-z0-9_-]{43}$/u.test(opened.delegateId)) {
    throw new Error("Native Desktop delegation is invalid.");
  }
  const delegateId = opened.delegateId;
  const lifetime = new AbortController();
  let retirement: Promise<void> | undefined;
  const retire = (): Promise<void> => {
    lifetime.abort();
    // Captured cleanup remains usable after the route's normal authority has
    // retired. The service independently fences the proof and exact delegate;
    // revocation also triggers service-owned cleanup without this HTTP call.
    return retirement ??= client.closeDesktopHostedAgentDelegate({ format: 1, delegateId }, { headers }).then(response => {
      if (response.format !== 1) throw new Error("Native Desktop cleanup could not be confirmed.");
    }).catch(error => { retirement = undefined; throw error; });
  };
  try { await assertCurrent(); } catch (error) { await retire().catch(() => {}); throw error; }
  return {
    invoke: async (method, bytes, signal, authority) => {
      lifetime.signal.throwIfAborted(); signal.throwIfAborted(); await assertCurrent();
      if (devicePeerNativeAgentMethodEffect(method) === undefined || !(bytes instanceof Uint8Array) || bytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES ||
        !authority.controllerDeviceId || authority.controllerDeviceId.length > 256 || /[\0\r\n]/u.test(authority.controllerDeviceId)) {
        throw new Error("Native Desktop request is invalid.");
      }
      const result = await client.invokeDesktopHostedAgentDelegate({ format: 1, delegateId, method, requestBytes: bytes,
        controllerDeviceId: authority.controllerDeviceId }, { headers, signal: AbortSignal.any([lifetime.signal, signal]) });
      lifetime.signal.throwIfAborted(); signal.throwIfAborted(); await assertCurrent();
      if (result.format !== 1 || result.responseBytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) {
        throw new Error("Native Desktop response is invalid.");
      }
      return result.responseBytes;
    },
    retire
  };
}

/** A capability-recovery probe never starts a native run. Retain its exact
 * delegate while close is uncertain instead of allocating another on retry. */
export async function probeDesktopHostedAgentDelegate(options: DesktopHostedAgentDelegateOptions & { readonly signal: AbortSignal }): Promise<boolean> {
  const delegate = await createDesktopHostedAgentDelegate(options);
  let delay = 500;
  for (;;) {
    try { await delegate.retire(); return true; }
    catch {
      options.signal.throwIfAborted();
      if (!await options.isAuthorityCurrent(options.connection)) throw new Error("Native Desktop recovery authority retired.");
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); options.signal.removeEventListener("abort", abort); reject(new Error("Native Desktop recovery was cancelled.")); };
        const timer = setTimeout(() => { options.signal.removeEventListener("abort", abort); resolve(); }, delay);
        timer.unref(); options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      });
      delay = Math.min(30_000, delay * 2);
    }
  }
}
function assertLocalOrigin(value: string): void {
  const origin = new URL(value);
  if (!["http:", "https:"].includes(origin.protocol) || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash || origin.origin !== value) {
    throw new Error("Native Desktop delegation requires the managed loopback service.");
  }
}
