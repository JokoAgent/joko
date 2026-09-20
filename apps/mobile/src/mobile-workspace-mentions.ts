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
  canonicalWorkspacePath,
  sortWorkspaceEntries,
  workspaceBasename,
  workspaceParentPath
} from "./workspace-files";
import {
  normalizeMobileComposerDraft,
  type MobileComposerDraft,
  type MobileComposerWorkspaceMention,
  type MobileWorkspaceLineRange
} from "./mobile-composer-document";

export interface MobileWorkspaceMentionPolicy {
  readonly files: boolean;
  readonly directories: boolean;
  readonly lineRanges: boolean;
}

export interface MobileWorkspaceMentionControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sessionId?: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly workspaceId: string;
  readonly workspaceDisplayName: string;
  readonly policy: MobileWorkspaceMentionPolicy;
}

export function createMobileNewTaskWorkspaceMentionControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  targetId: string
): MobileWorkspaceMentionControls | undefined {
  if (!authorityKey || !owner || !targetId) return undefined;
  const target = unique(owner.targets, (item) => item.targetId === targetId);
  if (!target || target.state !== TargetState.ACTIVE || !target.workspaceId) return undefined;
  const backend = unique(owner.backends, (item) => item.backendId === target.backendId);
  const workspace = unique(owner.workspaces, (item) => item.workspaceId === target.workspaceId);
  const policy = mobileWorkspaceMentionPolicy(backend);
  if (!backend || !workspace || workspace.targetId !== target.targetId || !policy) return undefined;
  return {
    authorityKey,
    surfaceOwnerKey: [
      authorityKey,
      "new-task-workspace-mentions",
      workspace.workspaceId,
      entityKey(workspace.version),
      workspace.displayName,
      policy.files ? "file" : "",
      policy.directories ? "directory" : "",
      policy.lineRanges ? "lines" : ""
    ].join("\u001f"),
    targetId: target.targetId,
    backendId: backend.backendId,
    workspaceId: workspace.workspaceId,
    workspaceDisplayName: safeWorkspaceLabel(workspace.displayName, workspace.workspaceId),
    policy
  };
}

export interface MobileWorkspaceMentionCandidate {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly displayText: string;
  readonly directory: boolean;
}

export interface MobileWorkspaceMentionDirectory {
  readonly parentPath: string;
  readonly entries: readonly MobileWorkspaceMentionCandidate[];
  readonly revision: string;
}

export interface MobileWorkspaceMentionFileIndex {
  readonly paths: readonly string[];
  readonly revision: string;
  readonly truncated: boolean;
}

export interface MobileWorkspaceMentionResults {
  readonly items: readonly MobileWorkspaceMentionCandidate[];
  readonly truncated: boolean;
}

const maximumVisibleResults = 500;
const maximumDisplayCharacters = 256;
const maximumLineNumber = 0xffff_ffff;

export function createMobileWorkspaceMentionControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedId: string | undefined
): MobileWorkspaceMentionControls | undefined {
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
  if (!ownerBackend || !detailBackend || !ownerTarget || !detailTarget
    || ownerTarget.backendId !== detailSession.backendId || detailTarget.backendId !== detailSession.backendId
    || ownerTarget.state !== TargetState.ACTIVE || detailTarget.state !== TargetState.ACTIVE
    || entityKey(ownerTarget.version) !== entityKey(detailTarget.version)
    || !ownerTarget.workspaceId || ownerTarget.workspaceId !== detailTarget.workspaceId) return undefined;

  const ownerPolicy = mobileWorkspaceMentionPolicy(ownerBackend);
  const detailPolicy = mobileWorkspaceMentionPolicy(detailBackend);
  if (!ownerPolicy || !detailPolicy || !samePolicy(ownerPolicy, detailPolicy)) return undefined;
  const ownerWorkspace = unique(owner.workspaces, (item) => item.workspaceId === ownerTarget.workspaceId);
  const detailWorkspace = unique(detail.workspaces, (item) => item.workspaceId === ownerTarget.workspaceId);
  if (!ownerWorkspace || !detailWorkspace || ownerWorkspace.targetId !== ownerTarget.targetId
    || detailWorkspace.targetId !== detailTarget.targetId
    || entityKey(ownerWorkspace.version) !== entityKey(detailWorkspace.version)) return undefined;

  const surfaceOwnerKey = [
    authorityKey,
    "workspace-mentions",
    ownerWorkspace.workspaceId,
    entityKey(ownerWorkspace.version),
    ownerWorkspace.displayName,
    ownerPolicy.files ? "file" : "",
    ownerPolicy.directories ? "directory" : "",
    ownerPolicy.lineRanges ? "lines" : ""
  ].join("\u001f");
  return {
    authorityKey,
    surfaceOwnerKey,
    sessionId: detailSession.sessionId,
    targetId: detailTarget.targetId,
    backendId: detailBackend.backendId,
    workspaceId: detailWorkspace.workspaceId,
    workspaceDisplayName: safeWorkspaceLabel(detailWorkspace.displayName, detailWorkspace.workspaceId),
    policy: detailPolicy
  };
}

export function mobileWorkspaceMentionPolicy(
  backend: BackendDescriptor | undefined
): MobileWorkspaceMentionPolicy | undefined {
  const capabilities = backend?.capabilities?.capabilities.filter((item) => item.name === capabilityNames.inputMention) ?? [];
  if (capabilities.length !== 1 || capabilities[0]!.support !== CapabilitySupport.SUPPORTED) return undefined;
  const options = capabilities[0]!.options?.kind.case === "input"
    ? capabilities[0]!.options.kind.value.mediaTypes
    : [];
  if (options.length === 0 || new Set(options).size !== options.length) return undefined;
  const policy = {
    files: options.includes("workspace_file"),
    directories: options.includes("workspace_directory"),
    lineRanges: options.includes("workspace_file") && options.includes("workspace_line_range")
  };
  return policy.files || policy.directories ? policy : undefined;
}

export function projectMobileWorkspaceMentionDirectory(
  controls: MobileWorkspaceMentionControls,
  parentPath: string,
  entries: readonly WorkspaceEntry[],
  revision: string
): MobileWorkspaceMentionDirectory {
  const parent = canonicalWorkspacePath(parentPath, true);
  if (!revision) throw new Error("The Joko node returned an unfenced Workspace directory.");
  const projected = sortWorkspaceEntries(entries).flatMap((entry) => {
    let path: string;
    try { path = canonicalWorkspacePath(entry.relativePath); }
    catch { throw new Error("The Joko node returned an invalid Workspace reference candidate."); }
    if (entry.workspaceId !== controls.workspaceId || workspaceParentPath(path) !== parent) {
      throw new Error("The Joko node returned a Workspace reference candidate outside the current directory.");
    }
    if (entry.kind === FileKind.DIRECTORY) return [candidate(controls.workspaceId, path, entry.displayName, true)];
    if (entry.kind === FileKind.REGULAR && controls.policy.files) {
      return [candidate(controls.workspaceId, path, entry.displayName, false)];
    }
    return [];
  });
  const paths = projected.map((entry) => entry.relativePath);
  if (new Set(paths).size !== paths.length) throw new Error("The Joko node returned duplicate Workspace reference candidates.");
  return { parentPath: parent, entries: projected, revision };
}

export function projectMobileWorkspaceMentionFileIndex(
  controls: MobileWorkspaceMentionControls,
  paths: readonly string[],
  revision: string,
  truncated: boolean
): MobileWorkspaceMentionFileIndex {
  if (!controls.policy.files) throw new Error("This Backend does not support Workspace file references.");
  if (!revision) throw new Error("The Joko node returned an unfenced Workspace file index.");
  const canonical = paths.map((path) => canonicalWorkspacePath(path));
  if (new Set(canonical).size !== canonical.length) throw new Error("The Joko node returned duplicate Workspace file paths.");
  return { paths: canonical, revision, truncated };
}

export function filterMobileWorkspaceMentionCandidates(
  controls: MobileWorkspaceMentionControls,
  directory: MobileWorkspaceMentionDirectory | undefined,
  fileIndex: MobileWorkspaceMentionFileIndex | undefined,
  query: string
): MobileWorkspaceMentionResults {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { items: directory?.entries ?? [], truncated: false };
  const directories = (directory?.entries ?? []).filter((entry) => entry.directory
    && (`${entry.displayText}\u0000${entry.relativePath}`).toLocaleLowerCase().includes(needle));
  const files = controls.policy.files
    ? (fileIndex?.paths ?? []).filter((path) => (`${workspaceBasename(path)}\u0000${path}`).toLocaleLowerCase().includes(needle))
      .map((path) => candidate(controls.workspaceId, path, "", false))
    : [];
  const items = [...directories, ...files].slice(0, maximumVisibleResults);
  return {
    items,
    truncated: items.length < directories.length + files.length || (fileIndex?.truncated ?? false)
  };
}

export function assertMobileWorkspaceMentionCandidate(
  controls: MobileWorkspaceMentionControls | undefined,
  value: MobileWorkspaceMentionCandidate
): MobileWorkspaceMentionCandidate {
  if (!controls || value.workspaceId !== controls.workspaceId || typeof value.directory !== "boolean") {
    throw new Error("The Workspace reference owner changed. Reopen the reference list and try again.");
  }
  const path = canonicalWorkspacePath(value.relativePath);
  if (value.directory ? !controls.policy.directories : !controls.policy.files) {
    throw new Error(`This Backend no longer supports Workspace ${value.directory ? "directory" : "file"} references.`);
  }
  return candidate(value.workspaceId, path, value.displayText, value.directory);
}

export function assertMobileWorkspaceMentionDraft(
  controls: MobileWorkspaceMentionControls | undefined,
  draft: MobileComposerDraft
): MobileComposerDraft {
  const exact = normalizeMobileComposerDraft(draft);
  const mentions = exact.mentions.filter((mention): mention is MobileComposerWorkspaceMention => mention.kind === "workspace");
  if (mentions.length === 0) return exact;
  if (!controls) throw new Error("This Backend no longer supports Workspace references. The draft was retained.");
  for (const mention of mentions) {
    if (mention.workspaceId !== controls.workspaceId) {
      throw new Error("A Workspace reference belongs to an earlier task Workspace. Remove or replace it before sending.");
    }
    if (mention.directory ? !controls.policy.directories : !controls.policy.files) {
      throw new Error(`This Backend no longer supports Workspace ${mention.directory ? "directory" : "file"} references. The draft was retained.`);
    }
    if (mention.lineRange !== undefined && !controls.policy.lineRanges) {
      throw new Error("This Backend no longer supports Workspace line references. The draft was retained.");
    }
  }
  return exact;
}

export function normalizeMobileWorkspaceLineRange(
  startLine: number,
  endLine: number
): MobileWorkspaceLineRange {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine > maximumLineNumber) {
    throw new Error("Enter paired, ordered one-based start and end lines.");
  }
  return { startLine, endLine };
}

function candidate(
  workspaceId: string,
  relativePath: string,
  displayName: string,
  directory: boolean
): MobileWorkspaceMentionCandidate {
  const path = canonicalWorkspacePath(relativePath);
  const displayText = safeWorkspaceLabel(displayName, workspaceBasename(path));
  return { workspaceId, relativePath: path, displayText, directory };
}

function safeWorkspaceLabel(value: string, fallback: string): string {
  const exact = value.trim();
  if (exact && exact.length <= maximumDisplayCharacters && !/[\u0000-\u001f\u007f]/u.test(exact)) return exact;
  const safeFallback = fallback.trim();
  if (!safeFallback || safeFallback.length > maximumDisplayCharacters || /[\u0000-\u001f\u007f]/u.test(safeFallback)) {
    throw new Error("The Joko node returned an invalid Workspace reference label.");
  }
  return safeFallback;
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

function samePolicy(left: MobileWorkspaceMentionPolicy, right: MobileWorkspaceMentionPolicy): boolean {
  return left.files === right.files && left.directories === right.directories && left.lineRanges === right.lineRanges;
}

export const mobileWorkspaceMentionTesting = {
  maximumVisibleResults,
  maximumLineNumber
};
