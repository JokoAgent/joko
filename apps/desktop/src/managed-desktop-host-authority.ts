import { createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport, normalizeEndpointPublicKey, requireEndpointTrust } from "@joko/connection-transport/node";
import { ConnectionService } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";

export interface ManagedDesktopHostAuthority {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly signal: AbortSignal;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly readDesktopHostAuthKey: () => string;
  readonly isAuthorityCurrent: (connection: DesktopManagedOrchestratorConnection) => boolean | Promise<boolean>;
  readonly transportFactory?: (
    origin: string,
    authKey: string | undefined,
    desktopHostAuthKey: string | undefined
  ) => Transport;
}

/** Send the two host proofs only to the captured managed endpoint after verifying its identity. */
export async function withManagedDesktopHostAuthority<T>(options: ManagedDesktopHostAuthority, read: (transport: Transport) => Promise<T>): Promise<T> {
  const origin = new URL(options.connection.origin).origin;
  if (origin !== options.connection.origin || options.signal.aborted) throw unavailable();
  const endpointPublicKey = options.connection.endpointPublicKey === undefined ? requireEndpointTrust({ origin }) : normalizeEndpointPublicKey(options.connection.endpointPublicKey);
  const transportFactory = options.transportFactory ?? ((target: string, auth: string | undefined, host: string | undefined) => createHostTransport(target, auth, host, endpointPublicKey));
  const identity = await createClient(ConnectionService, transportFactory(origin, undefined, undefined))
    .getServerInfo({}, { signal: options.signal });
  if (identity.server?.serverId !== options.connection.serverId ||
    !await options.isAuthorityCurrent(options.connection)) throw unavailable();
  const authKey = await options.readAuthKey(options.connection.profileId);
  const desktopHostAuthKey = options.readDesktopHostAuthKey();
  if (!validKey(authKey) || !validKey(desktopHostAuthKey) || options.signal.aborted ||
    !await options.isAuthorityCurrent(options.connection)) throw unavailable();
  const response = await read(transportFactory(origin, authKey, desktopHostAuthKey));
  if (!await options.isAuthorityCurrent(options.connection) || options.signal.aborted) throw unavailable();
  return response;
}

function createHostTransport(
  origin: string,
  authKey: string | undefined,
  desktopHostAuthKey: string | undefined,
  endpointPublicKey: string | undefined
): Transport {
  const interceptors: Interceptor[] = [];
  if (authKey !== undefined || desktopHostAuthKey !== undefined) interceptors.push((next) => (request) => {
    if (authKey !== undefined) request.header.set("authorization", `Bearer ${authKey}`);
    if (desktopHostAuthKey !== undefined) {
      request.header.set(DESKTOP_HOST_AUTHORIZATION_HEADER, `Bearer ${desktopHostAuthKey}`);
    }
    return next(request);
  });
  return createConnectTransport({
    baseUrl: origin,
    endpointPublicKey,
    httpVersion: "1.1",
    useBinaryFormat: true,
    interceptors,
    defaultTimeoutMs: 15_000
  });
}

function validKey(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function unavailable(): Error {
  return new Error("Managed Desktop host authority is unavailable.");
}
