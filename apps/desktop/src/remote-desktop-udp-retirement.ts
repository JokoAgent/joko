import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport, EndpointTrustError } from "@joko/connection-transport/node";
import { ConnectionService, DesktopHostedAgentService } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import type { DesktopManagedOrchestratorConnection } from "./channels.js";

/** Captured Main-only cleanup proof. Neither keys nor provider configuration
 * cross into the capture preload or a product renderer. Cleanup remains usable
 * after revocation, but its service endpoint can only retire the exact capture. */
export async function createDesktopRemoteDesktopUdpRetirement(options: {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly readAuthKey: () => Promise<string | undefined>;
  readonly readHostKey: () => Promise<string | undefined>;
  readonly current: () => boolean;
  readonly transport?: Transport;
}): Promise<((leaseId: string, attemptId: string) => Promise<void>) | undefined> {
  const connection = Object.freeze({ ...options.connection });
  const origin = new URL(connection.origin);
  if (!["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Desktop media cleanup requires its local managed node.");
  const check = (): void => { if (!options.current()) throw new Error("The original Main authority retired."); };
  check();
  const transport = options.transport ?? createConnectTransport({ baseUrl: connection.origin, endpointPublicKey: connection.endpointPublicKey, httpVersion: "1.1", defaultTimeoutMs: 10_000, readMaxBytes: 4096, writeMaxBytes: 4096 });
  const info = await createClient(ConnectionService, transport).getServerInfo({}, { signal: AbortSignal.timeout(10_000) });
  if (info.server?.serverId !== connection.serverId) throw new EndpointTrustError("The local Desktop media node identity changed.");
  check(); const [key, proof] = await Promise.all([options.readAuthKey(), options.readHostKey()]); check();
  if (!key || !proof || !/^[A-Za-z0-9_-]{43}$/u.test(key) || !/^[A-Za-z0-9_-]{43}$/u.test(proof)) throw new Error("Desktop Main cleanup authority is unavailable.");
  const client = createClient(DesktopHostedAgentService, transport);
  const headers = { authorization: `Bearer ${key}`, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${proof}` };
  const policy = await client.getDesktopMediaUdpPolicy({ format: 1 }, { headers, signal: AbortSignal.timeout(10_000) });
  check(); if (policy.format !== 1) throw new Error("Desktop media policy was not confirmed.");
  if (!policy.retirementRequired) return undefined;
  return async (leaseId, attemptId) => {
    if (!leaseId || leaseId.length > 256 || /[\0\r\n]/u.test(leaseId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(attemptId)) throw new Error("The exact capture retirement identity is required.");
    const reply = await client.retireDesktopMediaUdp({ format: 1, connectionId: connection.profileId, leaseId, attemptId }, { headers, signal: AbortSignal.timeout(10_000) });
    if (reply.format !== 1) throw new Error("The original UDP media retirement was not confirmed.");
  };
}
