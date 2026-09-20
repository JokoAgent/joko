import {
  CapabilitySupport,
  FileKind,
  TargetState,
  capabilityNames,
  type BackendDescriptor,
  type Snapshot,
  type WorkspaceEntry
} from "@joko/contracts";
import {
  normalizeMobileComposerDraft,
  type MobileComposerDraft,
  type MobileComposerPathRouteReferenceAtom
} from "./mobile-composer-document";
import {
  mobileComposerWorkspacePathComparisonKey,
  mobileComposerWorkspacePathRootSupported
} from "./mobile-composer-route-links";
import { canonicalWorkspacePath, workspaceParentPath } from "./workspace-files";

export interface MobileWorkspacePathPasteControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sessionId?: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly workspaceId: string;
  readonly serverPathDisplay: string;
}

export interface MobileWorkspacePathPasteResolution {
  readonly candidateRelativePath: string;
  readonly relativePath: string;
  readonly directory: boolean;
}

export function createMobileNewTaskWorkspacePathPasteControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  targetId: string
): MobileWorkspacePathPasteControls | undefined {
  if (!authorityKey || !owner || !targetId) return undefined;
  const target = unique(owner.targets, (item) => item.targetId === targetId);
  if (!target || target.state !== TargetState.ACTIVE || !target.workspaceId) return undefined;
  const backend = unique(owner.backends, (item) => item.backendId === target.backendId);
  const workspace = unique(owner.workspaces, (item) => item.workspaceId === target.workspaceId);
  if (!backend || !supportsWorkspaceFiles(backend) || !workspace
    || workspace.targetId !== target.targetId
    || !mobileComposerWorkspacePathRootSupported(workspace.serverPathDisplay)) return undefined;
  return controls(authorityKey, undefined, target.targetId, backend.backendId, workspace.workspaceId,
    workspace.serverPathDisplay, entityKey(workspace.version));
}

export function createMobileWorkspacePathPasteControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedId: string | undefined
): MobileWorkspacePathPasteControls | undefined {
  if (!authorityKey || !owner || !detail || !selectedId || owner.generation !== detail.generation) return undefined;
  const ownerSession = unique(owner.sessions, (item) => item.sessionId === selectedId);
  const detailSession = unique(detail.sessions, (item) => item.sessionId === selectedId);
  if (!ownerSession || !detailSession || ownerSession.backendId !== detailSession.backendId
    || ownerSession.targetId !== detailSession.targetId
    || entityKey(ownerSession.version) !== entityKey(detailSession.version)
    || ownerSession.nativeBinding?.runtimeGeneration !== detailSession.nativeBinding?.runtimeGeneration) return undefined;

  const ownerBackend = unique(owner.backends, (item) => item.backendId === detailSession.backendId);
  const detailBackend = unique(detail.backends, (item) => item.backendId === detailSession.backendId);
  const ownerTarget = unique(owner.targets, (item) => item.targetId === detailSession.targetId);
  const detailTarget = unique(detail.targets, (item) => item.targetId === detailSession.targetId);
  if (!ownerBackend || !detailBackend || !supportsWorkspaceFiles(ownerBackend) || !supportsWorkspaceFiles(detailBackend)
    || !ownerTarget || !detailTarget || ownerTarget.state !== TargetState.ACTIVE || detailTarget.state !== TargetState.ACTIVE
    || ownerTarget.backendId !== detailSession.backendId || detailTarget.backendId !== detailSession.backendId
    || entityKey(ownerTarget.version) !== entityKey(detailTarget.version)
    || !ownerTarget.workspaceId || ownerTarget.workspaceId !== detailTarget.workspaceId) return undefined;

  const ownerWorkspace = unique(owner.workspaces, (item) => item.workspaceId === ownerTarget.workspaceId);
  const detailWorkspace = unique(detail.workspaces, (item) => item.workspaceId === ownerTarget.workspaceId);
  if (!ownerWorkspace || !detailWorkspace || ownerWorkspace.targetId !== ownerTarget.targetId
    || detailWorkspace.targetId !== detailTarget.targetId
    || entityKey(ownerWorkspace.version) !== entityKey(detailWorkspace.version)
    || ownerWorkspace.serverPathDisplay !== detailWorkspace.serverPathDisplay
    || !mobileComposerWorkspacePathRootSupported(detailWorkspace.serverPathDisplay)) return undefined;
  return controls(authorityKey, selectedId, detailTarget.targetId, detailBackend.backendId,
    detailWorkspace.workspaceId, detailWorkspace.serverPathDisplay, entityKey(detailWorkspace.version));
}

export function projectMobileWorkspacePathPasteDirectory(
  controls: MobileWorkspacePathPasteControls,
  parentPath: string,
  entries: readonly WorkspaceEntry[],
  revision: string,
  candidateRelativePaths: readonly string[]
): readonly MobileWorkspacePathPasteResolution[] {
  const parent = canonicalWorkspacePath(parentPath, true);
  if (!revision) throw new Error("The Joko node returned an unfenced Workspace directory.");
  const projected = new Map<string, { readonly relativePath: string; readonly directory: boolean }>();
  const seenEntryPaths = new Set<string>();
  for (const entry of entries) {
    let path: string;
    try { path = canonicalWorkspacePath(entry.relativePath); }
    catch { throw new Error("The Joko node returned an invalid Workspace path candidate."); }
    const pathParent = workspaceParentPath(path);
    if (entry.workspaceId !== controls.workspaceId
      || comparisonKey(pathParent, controls) !== comparisonKey(parent, controls)) {
      throw new Error("The Joko node returned a Workspace path outside the requested directory.");
    }
    const key = comparisonKey(path, controls);
    if (seenEntryPaths.has(key)) throw new Error("The Joko node returned duplicate Workspace paths.");
    seenEntryPaths.add(key);
    if (entry.kind !== FileKind.REGULAR && entry.kind !== FileKind.DIRECTORY) continue;
    projected.set(key, { relativePath: path, directory: entry.kind === FileKind.DIRECTORY });
  }
  const seen = new Set<string>();
  return candidateRelativePaths.flatMap((candidateRelativePath) => {
    const candidate = canonicalWorkspacePath(candidateRelativePath);
    const key = comparisonKey(candidate, controls);
    if (seen.has(key)) return [];
    seen.add(key);
    const current = projected.get(key);
    return current === undefined ? [] : [{
      candidateRelativePath: candidate,
      relativePath: current.relativePath,
      directory: current.directory
    }];
  });
}

export function assertMobileWorkspacePathPasteDraft(
  controls: MobileWorkspacePathPasteControls | undefined,
  draft: MobileComposerDraft
): MobileComposerDraft {
  const exact = normalizeMobileComposerDraft(draft);
  const paths = mobileComposerWorkspacePathAtoms(exact);
  if (paths.length === 0) return exact;
  if (!controls) throw new Error("The exact Workspace for a retained path is no longer available. The draft was retained.");
  for (const atom of paths) {
    if (atom.workspaceId !== controls.workspaceId) {
      throw new Error("A retained path belongs to an earlier Workspace. Remove or replace it before sending.");
    }
    canonicalWorkspacePath(atom.relativePath);
  }
  return exact;
}

export function assertMobileWorkspacePathPasteResolutions(
  controls: MobileWorkspacePathPasteControls,
  draft: MobileComposerDraft,
  resolutions: readonly MobileWorkspacePathPasteResolution[]
): void {
  const paths = mobileComposerWorkspacePathAtoms(draft);
  for (const atom of paths) {
    const key = comparisonKey(atom.relativePath, controls);
    const matches = resolutions.filter((resolution) =>
      comparisonKey(resolution.candidateRelativePath, controls) === key);
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current || comparisonKey(current.relativePath, controls) !== key
      || current.directory !== atom.directory) {
      throw new Error("A retained Workspace path disappeared or changed file type. The draft was retained.");
    }
  }
}

export function mobileComposerWorkspacePathAtoms(
  draft: MobileComposerDraft
): readonly MobileComposerPathRouteReferenceAtom[] {
  return normalizeMobileComposerDraft(draft).atoms.filter(
    (atom): atom is MobileComposerPathRouteReferenceAtom => atom.kind === "route-reference" && atom.routeKind === "path"
  );
}

function controls(
  authorityKey: string,
  sessionId: string | undefined,
  targetId: string,
  backendId: string,
  workspaceId: string,
  serverPathDisplay: string,
  workspaceVersion: string
): MobileWorkspacePathPasteControls {
  return {
    authorityKey,
    surfaceOwnerKey: [authorityKey, "workspace-path-paste", workspaceId, workspaceVersion, serverPathDisplay].join("\u001f"),
    ...(sessionId === undefined ? {} : { sessionId }),
    targetId,
    backendId,
    workspaceId,
    serverPathDisplay
  };
}

function comparisonKey(path: string, controls: MobileWorkspacePathPasteControls): string {
  const key = mobileComposerWorkspacePathComparisonKey(path, controls.serverPathDisplay);
  if (key === undefined) throw new Error("The current Workspace server path is invalid.");
  return key;
}

function supportsWorkspaceFiles(backend: BackendDescriptor): boolean {
  const values = backend.capabilities?.capabilities.filter((item) => item.name === capabilityNames.workspaceFiles) ?? [];
  return values.length === 1 && values[0]!.support === CapabilitySupport.SUPPORTED;
}

function unique<T>(values: readonly T[], matches: (value: T) => boolean): T | undefined {
  const selected = values.filter(matches);
  return selected.length === 1 ? selected[0] : undefined;
}

function entityKey(version: {
  readonly generation: bigint;
  readonly revision?: { readonly value: bigint; readonly etag: string };
} | undefined): string {
  return [
    version?.generation.toString(10) ?? "",
    version?.revision?.value.toString(10) ?? "",
    version?.revision?.etag ?? ""
  ].join("\u001e");
}
