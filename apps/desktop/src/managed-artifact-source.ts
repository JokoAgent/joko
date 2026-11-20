import { createClient } from "@connectrpc/connect";
import { ArtifactService, WorkspaceService } from "@joko/contracts";
import { isAbsolute, resolve } from "node:path";

import { withManagedDesktopHostAuthority, type ManagedDesktopHostAuthority } from "./managed-desktop-host-authority.js";

export interface ManagedArtifactSourceResolverOptions extends ManagedDesktopHostAuthority {
  readonly sessionId: string;
  readonly artifactId: string;
}

export interface ManagedWorkspaceFileSourceResolverOptions extends ManagedDesktopHostAuthority {
  readonly workspaceId: string;
  readonly path: string;
  readonly revision: string;
}

/** Resolve a private path only after anonymous server identity and exact managed authority fences. */
export async function resolveManagedArtifactSource(options: ManagedArtifactSourceResolverOptions): Promise<string> {
  const response = await withManagedDesktopHostAuthority(options, transport => createClient(ArtifactService, transport)
    .resolveArtifactSource({ sessionId: options.sessionId, artifactId: options.artifactId }, { signal: options.signal }));
  return exactAbsolutePath(response.absolutePath);
}

export async function resolveManagedWorkspaceFileSource(options: ManagedWorkspaceFileSourceResolverOptions):
  Promise<{ readonly path: string; readonly metadataRevision: string }> {
  const response = await withManagedDesktopHostAuthority(options, transport => createClient(WorkspaceService, transport)
    .resolveWorkspaceFileSource({ workspaceId: options.workspaceId, relativePath: options.path,
      expectedRevision: { opaqueRevision: options.revision } }, { signal: options.signal }));
  const metadataRevision = response.verifiedMetadataRevision?.opaqueRevision;
  if (!metadataRevision?.startsWith("meta:") || metadataRevision.length > 320) throw unavailable();
  return { path: exactAbsolutePath(response.absolutePath), metadataRevision };
}

function exactAbsolutePath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 32_768 || path.includes("\0")) throw unavailable();
  return path;
}

function unavailable(): Error {
  return new Error("Managed file source authority is unavailable.");
}
