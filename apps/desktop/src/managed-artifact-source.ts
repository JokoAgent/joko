import { createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport, normalizeEndpointPublicKey, requireEndpointTrust } from "@joko/connection-transport/node";
import { ArtifactService, ConnectionService, WorkspaceService } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { isAbsolute, resolve } from "node:path";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";

interface ManagedFileSourceAuthority {
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

export interface ManagedArtifactSourceResolverOptions extends ManagedFileSourceAuthority {
  readonly sessionId: string;
  readonly artifactId: string;
}

export interface ManagedWorkspaceFileSourceResolverOptions extends ManagedFileSourceAuthority {
  readonly workspaceId: string;
  readonly path: string;
  readonly revision: string;
}

/** Resolve a private path only after anonymous server identity and exact managed authority fences. */
export async function resolveManagedArtifactSource(options: ManagedArtifactSourceResolverOptions): Promise<string> {
  const response = await withManagedFileSourceAuthority(options, transport => createClient(ArtifactService, transport)
    .resolveArtifactSource({ sessionId: options.sessionId, artifactId: options.artifactId }, { signal: options.signal }));
  return exactAbsolutePath(response.absolutePath);
}

export async function resolveManagedWorkspaceFileSource(options: ManagedWorkspaceFileSourceResolverOptions):
  Promise<{ readonly path: string; readonly metadataRevision: string }> {
  const response = await withManagedFileSourceAuthority(options, transport => createClient(WorkspaceService, transport)
    .resolveWorkspaceFileSource({ workspaceId: options.workspaceId, relativePath: options.path,
      expectedRevision: { opaqueRevision: options.revision } }, { signal: options.signal }));
  const metadataRevision = response.verifiedMetadataRevision?.opaqueRevision;
  if (!metadataRevision?.startsWith("meta:") || metadataRevision.length > 320) throw unavailable();
  return { path: exactAbsolutePath(response.absolutePath), metadataRevision };
}

async function withManagedFileSourceAuthority<T>(options: ManagedFileSourceAuthority, read: (transport: Transport) => Promise<T>): Promise<T> {
  const origin = new URL(options.connection.origin).origin;
  if (origin !== options.connection.origin || options.signal.aborted) throw unavailable();
  const endpointPublicKey = options.connection.endpointPublicKey === undefined ? requireEndpointTrust({ origin }) : normalizeEndpointPublicKey(options.connection.endpointPublicKey);
  const transportFactory = options.transportFactory ?? ((target: string, auth: string | undefined, host: string | undefined) => createManagedArtifactSourceTransport(target, auth, host, endpointPublicKey));
  const identity = await createClient(ConnectionService, transportFactory(origin, undefined, undefined))
    .getServerInfo({}, { signal: options.signal });
  if (identity.server?.serverId !== options.connection.serverId ||
    !await options.isAuthorityCurrent(options.connection)) throw unavailable();
  const authKey = await options.readAuthKey(options.connection.profileId);
  const desktopHostAuthKey = options.readDesktopHostAuthKey();
  if (!validKey(authKey) || !validKey(desktopHostAuthKey) ||
    !await options.isAuthorityCurrent(options.connection)) throw unavailable();
  const response = await read(transportFactory(origin, authKey, desktopHostAuthKey));
  if (!await options.isAuthorityCurrent(options.connection) || options.signal.aborted) throw unavailable();
  return response;
}

function exactAbsolutePath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 32_768 || path.includes("\0")) throw unavailable();
  return path;
}

function createManagedArtifactSourceTransport(
  origin: string,
  authKey: string | undefined,
  desktopHostAuthKey: string | undefined,
  endpointPublicKey?: string
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
  return new Error("Managed file source authority is unavailable.");
}
