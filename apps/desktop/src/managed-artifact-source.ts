import { createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ArtifactService, ConnectionService } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { isAbsolute, resolve } from "node:path";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";

export interface ManagedArtifactSourceResolverOptions {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly sessionId: string;
  readonly artifactId: string;
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

/** Resolve a private path only after anonymous server identity and exact managed authority fences. */
export async function resolveManagedArtifactSource(options: ManagedArtifactSourceResolverOptions): Promise<string> {
  const origin = new URL(options.connection.origin).origin;
  if (origin !== options.connection.origin || options.signal.aborted) throw unavailable();
  const transportFactory = options.transportFactory ?? createManagedArtifactSourceTransport;
  const identity = await createClient(ConnectionService, transportFactory(origin, undefined, undefined))
    .getServerInfo({}, { signal: options.signal });
  if (identity.server?.serverId !== options.connection.serverId ||
    !await options.isAuthorityCurrent(options.connection)) throw unavailable();
  const authKey = await options.readAuthKey(options.connection.profileId);
  const desktopHostAuthKey = options.readDesktopHostAuthKey();
  if (!validKey(authKey) || !validKey(desktopHostAuthKey) ||
    !await options.isAuthorityCurrent(options.connection)) throw unavailable();
  const response = await createClient(
    ArtifactService,
    transportFactory(origin, authKey, desktopHostAuthKey)
  ).resolveArtifactSource({ sessionId: options.sessionId, artifactId: options.artifactId }, { signal: options.signal });
  if (!await options.isAuthorityCurrent(options.connection) || options.signal.aborted ||
    !isAbsolute(response.absolutePath) || resolve(response.absolutePath) !== response.absolutePath ||
    response.absolutePath.length > 32_768 || response.absolutePath.includes("\0")) throw unavailable();
  return response.absolutePath;
}

function createManagedArtifactSourceTransport(
  origin: string,
  authKey: string | undefined,
  desktopHostAuthKey: string | undefined
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
  return new Error("Managed Artifact source authority is unavailable.");
}
