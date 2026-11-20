import type { BackendView, RemoteWorkspaceView, ResourceDraft } from "./model.js";

const RESOURCE_KINDS = ["extension", "skill", "prompt", "theme", "package"] as const;

export function resourceKindsForBackend(backend: BackendView | undefined): readonly ResourceDraft["kind"][] {
  const capability = backend?.capabilities.get("runtime.resources");
  if (capability?.supported !== true) return [];
  const options = new Set(capability.options);
  return RESOURCE_KINDS.filter((kind) => options.has(kind));
}

export function projectSupportsResourceDiscovery(
  backend: BackendView | undefined,
  remoteWorkspace?: RemoteWorkspaceView
): boolean {
  const kinds = resourceKindsForBackend(backend);
  if (remoteWorkspace === undefined) return kinds.length > 0;
  return remoteWorkspace.kind === "ssh" && backend?.id === "codex" && kinds.includes("skill");
}
