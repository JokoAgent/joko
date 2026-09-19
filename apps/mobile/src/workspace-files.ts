import {
  CapabilitySupport,
  FileKind,
  capabilityNames,
  type Artifact,
  type BackendDescriptor,
  type FileRevision,
  type Snapshot,
  type WorkspaceDescriptor,
  type WorkspaceEntry,
  type WorkspaceSearchMatch
} from "@joko/contracts";

export type MobileFilesLocation =
  | { readonly kind: "workspace"; readonly path: string }
  | { readonly kind: "generated" };

export type MobileFilesSearchMode = "name" | "content";

export interface MobileWorkspaceAuthority {
  readonly sessionId: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly workspace: WorkspaceDescriptor;
  readonly watchSupported: boolean;
  readonly key: string;
}

export type MobileFileSearchResult =
  | { readonly kind: "workspace-name"; readonly relativePath: string }
  | { readonly kind: "workspace-content"; readonly match: WorkspaceSearchMatch }
  | { readonly kind: "artifact"; readonly artifact: Artifact };

interface MobilePreviewBase {
  readonly title: string;
  readonly sourceLabel: string;
  readonly mediaType: string;
  readonly byteSize: bigint;
  readonly revisionKey: string;
}

export type MobileFilePreview =
  | (MobilePreviewBase & {
      readonly kind: "loading";
    })
  | (MobilePreviewBase & {
      readonly kind: "text";
      readonly text: string;
      readonly languageId: string;
      readonly startByte: bigint;
      readonly endByte: bigint;
      readonly totalLines: number;
      readonly truncated: boolean;
    })
  | (MobilePreviewBase & {
      readonly kind: "image";
      readonly dataUri: string;
      readonly altText: string;
      readonly widthPixels: number;
      readonly heightPixels: number;
    })
  | (MobilePreviewBase & {
      readonly kind: "unsupported";
      readonly reason: string;
    })
  | (MobilePreviewBase & {
      readonly kind: "error";
      readonly reason: string;
    });

export interface MobileFilesState {
  readonly open: boolean;
  readonly status: "idle" | "loading" | "ready" | "offline" | "error";
  readonly authorityKey?: string;
  readonly sessionId?: string;
  readonly workspace?: WorkspaceDescriptor;
  readonly location: MobileFilesLocation;
  readonly entries: readonly WorkspaceEntry[];
  readonly directoryRevision?: string;
  readonly fileIndex: readonly string[];
  readonly fileIndexRevision?: string;
  readonly fileIndexTruncated: boolean;
  readonly artifacts: readonly Artifact[];
  readonly artifactsRevision?: string;
  readonly searchQuery: string;
  readonly searchMode: MobileFilesSearchMode;
  readonly searchCaseSensitive: boolean;
  readonly searchStatus: "idle" | "searching" | "ready" | "error";
  readonly searchResults: readonly MobileFileSearchResult[];
  readonly searchTruncated: boolean;
  readonly searchTotalFiles: number;
  readonly searchError?: string;
  readonly preview?: MobileFilePreview;
  readonly watchStatus: "idle" | "watching" | "unavailable" | "error";
  readonly watchError?: string;
  readonly error?: string;
}

export function emptyMobileFilesState(): MobileFilesState {
  return {
    open: false,
    status: "idle",
    location: { kind: "workspace", path: "" },
    entries: [],
    fileIndex: [],
    fileIndexTruncated: false,
    artifacts: [],
    searchQuery: "",
    searchMode: "name",
    searchCaseSensitive: false,
    searchStatus: "idle",
    searchResults: [],
    searchTruncated: false,
    searchTotalFiles: 0,
    watchStatus: "idle"
  };
}

export function resolveMobileWorkspaceAuthority(
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedId: string | undefined
): MobileWorkspaceAuthority | undefined {
  if (!owner || !selectedId) return undefined;
  const ownerSession = owner.sessions.find((item) => item.sessionId === selectedId);
  const detailSession = detail?.sessions.find((item) => item.sessionId === selectedId);
  if (!ownerSession || (detail && !detailSession)) return undefined;
  const session = detailSession ?? ownerSession;
  if (ownerSession.targetId !== session.targetId || ownerSession.backendId !== session.backendId) {
    return undefined;
  }

  const ownerBackend = owner.backends.find((item) => item.backendId === session.backendId);
  const detailBackend = detail?.backends.find((item) => item.backendId === session.backendId);
  const backend = detailBackend ?? ownerBackend;
  if (!ownerBackend || !backend || ownerBackend.backendId !== backend.backendId
    || !supports(ownerBackend, capabilityNames.workspaceFiles)
    || !supports(backend, capabilityNames.workspaceFiles)) return undefined;
  const ownerTarget = owner.targets.find((item) => item.targetId === session.targetId);
  const detailTarget = detail?.targets.find((item) => item.targetId === session.targetId);
  const target = detailTarget ?? ownerTarget;
  if (!ownerTarget || !target || target.backendId !== session.backendId || !target.workspaceId) return undefined;
  if (ownerTarget.backendId !== target.backendId || ownerTarget.workspaceId !== target.workspaceId) return undefined;

  const ownerWorkspace = owner.workspaces.find((item) => item.workspaceId === target.workspaceId);
  const detailWorkspace = detail?.workspaces.find((item) => item.workspaceId === target.workspaceId);
  const workspace = detailWorkspace ?? ownerWorkspace;
  if (!ownerWorkspace || !workspace || workspace.targetId !== target.targetId
    || ownerWorkspace.targetId !== workspace.targetId) return undefined;

  const key = [
    snapshotKey(owner),
    snapshotKey(detail),
    selectedId,
    entityKey(session.version),
    session.nativeBinding?.runtimeGeneration.toString(10) ?? "",
    target.targetId,
    entityKey(target.version),
    workspace.workspaceId,
    entityKey(workspace.version),
    entityKey(backend.entityVersion)
  ].join("\u001f");
  return {
    sessionId: selectedId,
    targetId: target.targetId,
    backendId: backend.backendId,
    workspace,
    watchSupported: supports(backend, capabilityNames.workspaceFilesWatch),
    key
  };
}

export function canonicalWorkspacePath(value: string, allowRoot = false): string {
  if (allowRoot && value === "") return "";
  if (
    value === ""
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error("The Joko node returned a non-canonical workspace path.");
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("The Joko node returned a non-canonical workspace path.");
  }
  return value;
}

export function workspaceParentPath(value: string): string {
  const path = canonicalWorkspacePath(value, true);
  if (path === "") return "";
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function workspaceBasename(value: string): string {
  const path = canonicalWorkspacePath(value);
  return path.slice(path.lastIndexOf("/") + 1);
}

export function workspaceEntryRevisionKey(revision: FileRevision | undefined): string {
  if (!revision?.opaqueRevision) throw new Error("The Joko node returned an unfenced workspace file.");
  const modified = revision.modifiedAt === undefined
    ? ""
    : `${revision.modifiedAt.seconds.toString(10)}.${revision.modifiedAt.nanos}`;
  return [revision.opaqueRevision, revision.sha256Hex, revision.byteSize.toString(10), modified].join(":");
}

export function sortWorkspaceEntries(entries: readonly WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    const leftDirectory = left.kind === FileKind.DIRECTORY;
    const rightDirectory = right.kind === FileKind.DIRECTORY;
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    return compareDisplay(left.displayName || workspaceBasename(left.relativePath), right.displayName || workspaceBasename(right.relativePath));
  });
}

export function sortArtifacts(artifacts: readonly Artifact[]): Artifact[] {
  return [...artifacts].sort((left, right) => {
    const title = compareDisplay(artifactTitle(left), artifactTitle(right));
    if (title !== 0) return title;
    const leftCreated = left.createdAt?.seconds ?? 0n;
    const rightCreated = right.createdAt?.seconds ?? 0n;
    if (leftCreated !== rightCreated) return leftCreated > rightCreated ? -1 : 1;
    return left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0;
  });
}

export function filterWorkspaceFileNames(
  paths: readonly string[],
  artifacts: readonly Artifact[],
  query: string,
  caseSensitive: boolean
): MobileFileSearchResult[] {
  const needle = caseSensitive ? query.trim() : query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const includes = (value: string): boolean => (caseSensitive ? value : value.toLocaleLowerCase()).includes(needle);
  const files: MobileFileSearchResult[] = paths
    .filter((path) => includes(workspaceBasename(path)))
    .sort(compareDisplay)
    .map((relativePath) => ({ kind: "workspace-name" as const, relativePath }));
  const generated: MobileFileSearchResult[] = sortArtifacts(artifacts)
    .filter((artifact) => includes(artifactTitle(artifact)))
    .map((artifact) => ({ kind: "artifact" as const, artifact }));
  return [...files, ...generated];
}

export function artifactTitle(artifact: Artifact): string {
  return artifact.title.trim() || artifact.blob?.fileName.trim() || "Generated file";
}

export function isTextMediaType(value: string): boolean {
  const mediaType = normalizeMediaType(value);
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType === "application/ld+json"
    || mediaType === "application/xml"
    || mediaType === "application/javascript"
    || mediaType.endsWith("+json")
    || mediaType.endsWith("+xml");
}

export function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLocaleLowerCase();
}

export function bytesToDataUri(bytes: Uint8Array, mediaType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  return `data:${normalizeMediaType(mediaType)};base64,${btoa(binary)}`;
}

function supports(backend: BackendDescriptor, name: string): boolean {
  return backend.capabilities?.capabilities.some((item) => item.name === name && item.support === CapabilitySupport.SUPPORTED) === true;
}

function snapshotKey(snapshot: Snapshot | undefined): string {
  if (!snapshot) return "";
  return [
    snapshot.snapshotId,
    snapshot.generation.toString(10),
    snapshot.revision?.etag ?? "",
    snapshot.revision?.value.toString(10) ?? ""
  ].join(":");
}

function entityKey(version: { readonly revision?: { readonly etag: string; readonly value: bigint } } | undefined): string {
  return `${version?.revision?.etag ?? ""}:${version?.revision?.value.toString(10) ?? ""}`;
}

function compareDisplay(left: string, right: string): number {
  const folded = left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase(), "en", { numeric: true });
  return folded !== 0 ? folded : left.localeCompare(right, "en", { numeric: true });
}
