import { Code, ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  ArtifactKind, ArtifactService, BlobDisposition, ConnectionService, DeviceKind, EventService, FileKind, OperationService, OperationState,
  ResourceKind, SessionService, TargetService, VoiceInputService,
  TransferDirection, WorkspaceEntryListingPolicy, WorkspaceFileChangeKind, WorkspaceService,
  JOKO_API_VERSION, SessionMessageSearchSemanticMode, SessionMessageSearchSessionStatus,
  isPrivateLanDiscoveryHost, validateDiscoveredNode,
  type Artifact, type BlobRef, type BlobTransferTicket, type Connection, type Device, type DiscoveredNodeRecord,
  type Event, type EventCursor, type FilePreview, type FileRevision, type Operation, type OperationMutation,
  type NativeSessionTree, type PendingBlobUpload, type RuntimeCommand, type SessionMessageSearchMatch, type SessionResource, type Snapshot, type Target,
  type WorkspaceEntry, type WorkspaceFileChange,
  type WorkspaceSearchMatch
} from "@joko/contracts";
import {
  canonicalWorkspacePath,
  normalizeMediaType,
  workspaceEntryRevisionKey,
  workspaceParentPath
} from "./workspace-files";
import {
  projectMobileVoiceCapability,
  projectMobileVoiceSession,
  type MobileVoiceCapability,
  type MobileVoiceSession
} from "./mobile-voice-input";

export interface PairedCredential {
  readonly profileId: string;
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly authKey: string;
}

export interface NodeIdentity {
  readonly serverId: string;
  readonly displayName: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly health: number;
  readonly pairingEnabled: boolean;
}

export interface MobileNetwork {
  inspect(origin: string, signal?: AbortSignal): Promise<NodeIdentity>;
  discover(origin: string, signal?: AbortSignal): Promise<readonly DiscoveredNodeRecord[]>;
  requestPairing(origin: string, deviceName: string, platform: string, signal?: AbortSignal): Promise<{ identity: NodeIdentity; challengeId: string }>;
  completePairing(origin: string, challengeId: string, code: string, deviceName: string, platform: string, signal?: AbortSignal): Promise<{ credential: PairedCredential; identity: NodeIdentity }>;
  readOwner(credential: PairedCredential, signal?: AbortSignal): Promise<{ connection: Connection; device: Device; snapshot: Snapshot }>;
  readSession(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<Snapshot>;
  readNativeSessionTree(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<NativeSessionTree>;
  readHistory(credential: PairedCredential, sessionId: string, before?: EventCursor, signal?: AbortSignal): Promise<{ events: Event[]; before?: EventCursor }>;
  readAround(credential: PairedCredential, sessionId: string, eventId: string, signal?: AbortSignal): Promise<Event[]>;
  searchSessionMessages(credential: PairedCredential, query: string, status: SessionMessageSearchSessionStatus, signal?: AbortSignal): Promise<readonly SessionMessageSearchMatch[]>;
  streamOwner(credential: PairedCredential, after: EventCursor, signal: AbortSignal): AsyncIterable<Event>;
  listWorkspaceDirectory(credential: PairedCredential, workspaceId: string, parentPath: string, signal?: AbortSignal): Promise<WorkspaceDirectorySnapshot>;
  listWorkspaceFileIndex(credential: PairedCredential, workspaceId: string, signal?: AbortSignal): Promise<WorkspaceFileIndexSnapshot>;
  searchWorkspace(credential: PairedCredential, workspaceId: string, query: string, caseSensitive: boolean, signal?: AbortSignal): Promise<WorkspaceSearchSnapshot>;
  watchWorkspace(credential: PairedCredential, workspaceId: string, signal: AbortSignal): AsyncIterable<WorkspaceFileChange>;
  readWorkspaceFile(credential: PairedCredential, workspaceId: string, relativePath: string, revision: FileRevision, signal?: AbortSignal): Promise<FilePreview>;
  materializeWorkspaceFileBlob(credential: PairedCredential, workspaceId: string, relativePath: string, revision: FileRevision, signal?: AbortSignal): Promise<MaterializedWorkspaceBlob>;
  listSessionArtifacts(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<ArtifactCatalogSnapshot>;
  listRuntimeCommands(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<readonly RuntimeCommand[]>;
  listSessionResources(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<readonly SessionResource[]>;
  listArtifactReferenceCatalog(credential: PairedCredential, sessionId: string, generation: bigint, signal?: AbortSignal): Promise<ArtifactCatalogSnapshot>;
  downloadBlob(credential: PairedCredential, blob: BlobRef, signal?: AbortSignal): Promise<VerifiedBlobDownload>;
  authorizeBlobDownload(credential: PairedCredential, blob: BlobRef, signal?: AbortSignal): Promise<AuthorizedBlobDownload>;
  uploadBlob(credential: PairedCredential, source: MobileBlobUploadSource, signal?: AbortSignal): Promise<BlobRef>;
  getVoiceInputCapabilities(credential: PairedCredential, signal?: AbortSignal): Promise<MobileVoiceCapability>;
  startVoiceInput(credential: PairedCredential, requestId: string, mimeType: string, locale?: string, signal?: AbortSignal): Promise<MobileVoiceSession>;
  appendVoiceAudio(credential: PairedCredential, voiceInputId: string, chunkSequence: bigint, audio: Uint8Array, durationMs: number, voiced: boolean, signal?: AbortSignal): Promise<MobileVoiceSession>;
  stopVoiceInput(credential: PairedCredential, voiceInputId: string, expectedNextChunkSequence: bigint, signal?: AbortSignal): Promise<MobileVoiceSession>;
  cancelVoiceInput(credential: PairedCredential, voiceInputId: string, signal?: AbortSignal): Promise<MobileVoiceSession>;
  getVoiceInputSession(credential: PairedCredential, voiceInputId: string, signal?: AbortSignal): Promise<MobileVoiceSession>;
  prepareTarget(credential: PairedCredential, target: Target, signal?: AbortSignal): Promise<void>;
  submit(credential: PairedCredential, operationId: string, mutation: OperationMutation, signal?: AbortSignal): Promise<Operation>;
  waitOperation(credential: PairedCredential, operationId: string, signal?: AbortSignal): Promise<Operation>;
  getOperation(credential: PairedCredential, operationId: string, signal?: AbortSignal): Promise<Operation | undefined>;
}

export interface WorkspaceDirectorySnapshot {
  readonly entries: readonly WorkspaceEntry[];
  readonly revision: string;
}

export interface WorkspaceFileIndexSnapshot {
  readonly paths: readonly string[];
  readonly revision: string;
  readonly truncated: boolean;
}

export interface WorkspaceSearchSnapshot {
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly revision: string;
  readonly truncated: boolean;
  readonly totalFiles: number;
}

export interface ArtifactCatalogSnapshot {
  readonly artifacts: readonly Artifact[];
  readonly revision: string;
}

export interface VerifiedBlobDownload {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface MaterializedWorkspaceBlob {
  readonly entry: WorkspaceEntry;
  readonly blob: BlobRef;
}

export interface AuthorizedBlobDownload {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly blobId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

export interface MobileBlobUploadSource {
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

export type MobileNativeBlobUploader = (
  endpoint: string,
  sourceUri: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal
) => Promise<{ readonly status: number; readonly body?: string }>;

interface SessionMessageSearchPage {
  readonly matches: readonly SessionMessageSearchMatch[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
}

const MESSAGE_SEARCH_PAGE_SIZE = 100;
const WORKSPACE_PAGE_SIZE = 500;
export const MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES = 32 * 1024 * 1024;
export const MOBILE_FILE_SHARE_MAXIMUM_BYTES = 256 * 1024 * 1024;

interface WorkspaceDirectoryPage {
  readonly entries: readonly WorkspaceEntry[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
}

interface WorkspaceSearchPage {
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
  readonly truncated: boolean;
  readonly totalFiles: bigint;
}

interface ArtifactPage {
  readonly artifacts: readonly Artifact[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
}

export async function collectSessionMessageSearchPages(
  readPage: (pageToken: string) => Promise<SessionMessageSearchPage>
): Promise<readonly SessionMessageSearchMatch[]> {
  const matches: SessionMessageSearchMatch[] = [];
  const pageTokens = new Set<string>();
  let pageToken = "";
  let totalSize: bigint | undefined;
  let pageCount = 0n;
  while (true) {
    const page = await readPage(pageToken);
    pageCount += 1n;
    if (page.totalSize < 0n) throw new Error("The Joko node returned an invalid message-search result count.");
    if (totalSize === undefined) totalSize = page.totalSize;
    else if (page.totalSize !== totalSize) throw new Error("The Joko message-search result count changed while paging.");
    matches.push(...page.matches);
    if (!page.nextPageToken) {
      if (BigInt(matches.length) !== totalSize) {
        throw new Error("The Joko node returned an incomplete message-search result set.");
      }
      return matches;
    }
    const expectedPages = (totalSize + BigInt(MESSAGE_SEARCH_PAGE_SIZE) - 1n) / BigInt(MESSAGE_SEARCH_PAGE_SIZE);
    if (pageCount >= expectedPages || pageTokens.has(page.nextPageToken)) {
      throw new Error("The Joko node returned an invalid message-search page sequence.");
    }
    pageTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
}

export async function collectWorkspaceDirectoryPages(
  workspaceId: string,
  parentPath: string,
  readPage: (pageToken: string) => Promise<WorkspaceDirectoryPage>
): Promise<WorkspaceDirectorySnapshot> {
  const canonicalParent = canonicalWorkspacePath(parentPath, true);
  const pages = await collectStablePages(readPage, "workspace directory", (page) => page.entries);
  const seen = new Set<string>();
  for (const entry of pages.values) {
    const path = canonicalWorkspacePath(entry.relativePath);
    if (entry.workspaceId !== workspaceId || workspaceParentPath(path) !== canonicalParent || seen.has(path)) {
      throw new Error("The Joko node returned an invalid workspace directory.");
    }
    seen.add(path);
    if (entry.kind !== FileKind.DIRECTORY && !entry.revision?.opaqueRevision) {
      throw new Error("The Joko node returned an unfenced workspace file.");
    }
  }
  return { entries: pages.values, revision: pages.revision };
}

export async function collectWorkspaceSearchPages(
  workspaceId: string,
  readPage: (pageToken: string) => Promise<WorkspaceSearchPage>
): Promise<WorkspaceSearchSnapshot> {
  if (!workspaceId) throw new Error("A current Workspace is required.");
  const matches: WorkspaceSearchMatch[] = [];
  const tokens = new Set<string>();
  let pageToken = "";
  let revision: string | undefined;
  let totalSize: bigint | undefined;
  let totalFiles: bigint | undefined;
  let truncated: boolean | undefined;
  while (true) {
    const page = await readPage(pageToken);
    if (!page.revision || page.totalSize < 0n || page.totalFiles < 0n) {
      throw new Error("The Joko node returned invalid workspace-search metadata.");
    }
    if (revision === undefined) {
      revision = page.revision;
      totalSize = page.totalSize;
      totalFiles = page.totalFiles;
      truncated = page.truncated;
    } else if (revision !== page.revision || totalSize !== page.totalSize || totalFiles !== page.totalFiles || truncated !== page.truncated) {
      throw new Error("Workspace search results changed while paging.");
    }
    for (const match of page.matches) {
      canonicalWorkspacePath(match.relativePath);
      if (!match.revision?.opaqueRevision) throw new Error("The Joko node returned an unfenced workspace-search match.");
      matches.push(match);
    }
    if (!page.nextPageToken) break;
    if (page.nextPageToken === pageToken || tokens.has(page.nextPageToken)) {
      throw new Error("The Joko node returned a cyclic workspace-search page token.");
    }
    tokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
    if (tokens.size > 10_000) throw new Error("Workspace search exceeded the supported page count.");
  }
  if (BigInt(matches.length) !== totalSize) throw new Error("The Joko node returned an incomplete workspace-search result set.");
  return {
    matches,
    revision: revision!,
    truncated: truncated!,
    totalFiles: safeResultCount(totalFiles!, "workspace-search file")
  };
}

export async function collectArtifactPages(
  sessionId: string,
  readPage: (pageToken: string) => Promise<ArtifactPage>
): Promise<ArtifactCatalogSnapshot> {
  const pages = await collectStablePages(readPage, "Artifact catalog", (page) => page.artifacts);
  const ids = new Set<string>();
  for (const artifact of pages.values) {
    if (!artifact.artifactId || artifact.sessionId !== sessionId || ids.has(artifact.artifactId)) {
      throw new Error("The Joko node returned an invalid Artifact catalog.");
    }
    ids.add(artifact.artifactId);
  }
  return { artifacts: pages.values, revision: pages.revision };
}

export function assertSessionResourceCatalog(
  sessionId: string,
  resources: readonly SessionResource[]
): readonly SessionResource[] {
  if (!validCatalogIdentity(sessionId, 1_024)) throw new Error("A current task is required for its Resource catalog.");
  const ids = new Set<string>();
  for (const resource of resources) {
    if (resource.sessionId !== sessionId
      || !validCatalogIdentity(resource.resourceId)
      || ids.has(resource.resourceId)
      || !validCatalogLabel(resource.name)
      || !validCatalogIdentity(resource.discoveredRevision)
      || resource.resourceVersion < 1n
      || resource.runtimeGeneration < 1n
      || ![ResourceKind.EXTENSION, ResourceKind.SKILL, ResourceKind.PROMPT_TEMPLATE, ResourceKind.PACKAGE].includes(resource.kind)) {
      throw new Error("The Joko node returned an invalid task Resource catalog.");
    }
    ids.add(resource.resourceId);
  }
  return resources;
}

export async function collectArtifactReferencePages(
  readPage: (pageToken: string) => Promise<ArtifactPage>,
  now = Date.now()
): Promise<ArtifactCatalogSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const pages = await collectStablePages(readPage, "Artifact reference catalog", (page) => page.artifacts);
      const identities = new Set<string>();
      const artifacts: Artifact[] = [];
      for (const artifact of pages.values) {
        const identity = `${artifact.sessionId}\u0000${artifact.artifactId}`;
        const blob = artifact.blob;
        const createdAt = safeCatalogTimestamp(artifact.createdAt);
        const expiresAt = artifact.expiresAt === undefined ? undefined : safeCatalogTimestamp(artifact.expiresAt);
        if (!validCatalogIdentity(artifact.sessionId, 1_024)
          || !validCatalogIdentity(artifact.artifactId)
          || identities.has(identity)
          || !artifactReferenceKind(artifact.kind)
          || !blob
          || !validCatalogIdentity(blob.blobId)
          || !/^[a-f0-9]{64}$/u.test(blob.sha256Hex)
          || blob.byteSize < 0n || blob.byteSize > BigInt(Number.MAX_SAFE_INTEGER)
          || !validCatalogLabel(blob.mediaType)
          || !validCatalogLabel(artifact.title || blob.fileName)
          || createdAt === undefined
          || artifact.expiresAt !== undefined && expiresAt === undefined) {
          throw new Error("The Joko node returned an invalid Artifact reference catalog identity.");
        }
        identities.add(identity);
        if (expiresAt === undefined || expiresAt > now) artifacts.push(artifact);
      }
      return { artifacts, revision: pages.revision };
    } catch (error) {
      const drift = error instanceof Error && error.message === "Artifact reference catalog changed while paging.";
      if (attempt === 0 && drift) continue;
      throw error;
    }
  }
  throw new Error("The Artifact reference catalog changed repeatedly while it was loading.");
}

export function assertWorkspaceFilePreview(
  workspaceId: string,
  relativePath: string,
  revision: FileRevision,
  preview: FilePreview | undefined
): FilePreview {
  const path = canonicalWorkspacePath(relativePath);
  if (!workspaceId || !revision.opaqueRevision || !preview?.entry
    || preview.entry.workspaceId !== workspaceId || preview.entry.relativePath !== path
    || !preview.entry.revision?.opaqueRevision
    || !acceptedWorkspacePreviewRevision(revision, preview.entry.revision)) {
    throw new Error("The Joko node returned a mismatched workspace file preview.");
  }
  return preview;
}

export function assertMaterializedWorkspaceBlob(
  workspaceId: string,
  relativePath: string,
  revision: FileRevision,
  preview: FilePreview | undefined
): MaterializedWorkspaceBlob {
  const exact = assertWorkspaceFilePreview(workspaceId, relativePath, revision, preview);
  const entry = exact.entry;
  const blob = exact.content.case === "image"
    ? exact.content.value.blob
    : exact.content.case === "blob"
      ? exact.content.value
      : undefined;
  const mediaType = normalizeMediaType(entry?.mediaType ?? "") || "application/octet-stream";
  const filePath = canonicalWorkspacePath(relativePath);
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (!entry || entry.kind !== FileKind.REGULAR || exact.truncated || !entry.revision
    || !blob?.blobId || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)
    || blob.fileName !== fileName
    || blob.byteSize < 0n || blob.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)
    || entry.revision.byteSize !== blob.byteSize || entry.revision.sha256Hex !== blob.sha256Hex
    || entry.revision.opaqueRevision !== `sha256:${blob.sha256Hex}:${blob.byteSize.toString(10)}`
    || normalizeMediaType(blob.mediaType) !== mediaType) {
    throw new Error("The Joko node returned a mismatched complete Workspace Blob.");
  }
  return { entry, blob };
}

function acceptedWorkspacePreviewRevision(expected: FileRevision, actual: FileRevision): boolean {
  if (workspaceEntryRevisionKey(actual) === workspaceEntryRevisionKey(expected)) return true;
  if (expected.opaqueRevision.startsWith("sha256:") || !actual.opaqueRevision.startsWith("sha256:")
    || !/^[0-9a-f]{64}$/u.test(actual.sha256Hex)) return false;
  if (actual.opaqueRevision !== `sha256:${actual.sha256Hex}:${actual.byteSize.toString(10)}`) return false;
  if (expected.sha256Hex !== "" && expected.sha256Hex !== actual.sha256Hex) return false;
  if (expected.byteSize !== 0n && expected.byteSize !== actual.byteSize) return false;
  if (expected.modifiedAt !== undefined) {
    if (actual.modifiedAt === undefined || expected.modifiedAt.seconds !== actual.modifiedAt.seconds
      || expected.modifiedAt.nanos !== actual.modifiedAt.nanos) return false;
  }
  return true;
}

export async function downloadVerifiedBlob(
  credential: Pick<PairedCredential, "origin" | "authKey">,
  blob: BlobRef,
  ticket: BlobTransferTicket | undefined,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  digestBytes: (bytes: Uint8Array) => Promise<string> = sha256Hex
): Promise<VerifiedBlobDownload> {
  signal?.throwIfAborted();
  assertDownloadBlob(blob);
  if (!ticket?.ticketId || ticket.direction !== TransferDirection.DOWNLOAD || ticket.blobId !== blob.blobId) {
    throw new Error("The Joko node returned a mismatched Blob download ticket.");
  }
  if (ticket.maximumBytes !== blob.byteSize || normalizeMediaType(ticket.requiredMediaType) !== normalizeMediaType(blob.mediaType)) {
    throw new Error("The Joko node returned a Blob ticket with mismatched limits or media type.");
  }
  if (ticket.expiresAt && Number(ticket.expiresAt.seconds) * 1_000 <= Date.now()) {
    throw new Error("The Joko node returned an expired Blob download ticket.");
  }
  const endpoint = authorizedBlobEndpoint(credential.origin, ticket.relativeEndpoint);
  const response = await fetcher(endpoint, {
    headers: { authorization: `Bearer ${credential.authKey}` },
    cache: "no-store",
    signal
  });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`Blob download failed (${response.status}).`);
  const declaredLength = response.headers.get("content-length")?.trim();
  if (!declaredLength || !/^(0|[1-9][0-9]*)$/u.test(declaredLength) || BigInt(declaredLength) !== blob.byteSize) {
    throw new Error("The Blob response length did not match its authenticated metadata.");
  }
  if (normalizeMediaType(response.headers.get("content-type") ?? "") !== normalizeMediaType(blob.mediaType)) {
    throw new Error("The Blob response media type did not match its authenticated metadata.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal?.throwIfAborted();
  if (BigInt(bytes.byteLength) !== blob.byteSize || BigInt(bytes.byteLength) > ticket.maximumBytes) {
    throw new Error("The Blob response size did not match its authenticated metadata.");
  }
  if (await digestBytes(bytes) !== blob.sha256Hex) {
    throw new Error("The Blob response failed SHA-256 verification.");
  }
  signal?.throwIfAborted();
  return { bytes, mediaType: normalizeMediaType(blob.mediaType) };
}

export function authorizeVerifiedBlobDownload(
  credential: Pick<PairedCredential, "origin" | "authKey">,
  blob: BlobRef,
  ticket: BlobTransferTicket | undefined
): AuthorizedBlobDownload {
  assertShareBlob(blob);
  if (!ticket?.ticketId || ticket.direction !== TransferDirection.DOWNLOAD || ticket.blobId !== blob.blobId) {
    throw new Error("The Joko node returned a mismatched Blob download ticket.");
  }
  const mediaType = normalizeMediaType(blob.mediaType);
  if (ticket.maximumBytes !== blob.byteSize || normalizeMediaType(ticket.requiredMediaType) !== mediaType) {
    throw new Error("The Joko node returned a Blob ticket with mismatched limits or media type.");
  }
  if (ticket.expiresAt && Number(ticket.expiresAt.seconds) * 1_000 <= Date.now()) {
    throw new Error("The Joko node returned an expired Blob download ticket.");
  }
  return {
    url: authorizedBlobEndpoint(credential.origin, ticket.relativeEndpoint),
    headers: { authorization: `Bearer ${credential.authKey}` },
    blobId: blob.blobId,
    fileName: blob.fileName,
    mediaType,
    byteSize: Number(blob.byteSize),
    sha256Hex: blob.sha256Hex
  };
}

export async function uploadVerifiedBlob(
  credential: Pick<PairedCredential, "origin" | "authKey">,
  source: MobileBlobUploadSource,
  pending: PendingBlobUpload | undefined,
  complete: (uploadId: string, signal?: AbortSignal) => Promise<BlobRef | undefined>,
  signal?: AbortSignal,
  uploader: MobileNativeBlobUploader = uploadNativeBlobFile
): Promise<BlobRef> {
  signal?.throwIfAborted();
  const exact = assertBlobUploadSource(source);
  const ticket = pending?.ticket;
  if (!validBlobTransferIdentity(pending?.uploadId) || !validBlobTransferIdentity(ticket?.ticketId)
    || ticket.blobId !== ""
    || ticket.direction !== TransferDirection.UPLOAD
    || pending.expectedSha256Hex !== exact.sha256Hex
    || pending.expectedByteSize !== BigInt(exact.byteSize)
    || ticket.maximumBytes !== BigInt(exact.byteSize)
    || normalizeMediaType(ticket.requiredMediaType) !== exact.mediaType) {
    throw new Error("The Joko node returned a mismatched Blob upload ticket.");
  }
  if (ticket.expiresAt && Number(ticket.expiresAt.seconds) * 1_000 <= Date.now()) {
    throw new Error("The Joko node returned an expired Blob upload ticket.");
  }
  const endpoint = authorizedBlobEndpoint(credential.origin, ticket.relativeEndpoint);
  const response = await uploader(endpoint, exact.uri, {
    authorization: `Bearer ${credential.authKey}`,
    "content-type": "application/octet-stream"
  }, signal);
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Attachment upload failed (${response.status || "unknown"}).`);
  }
  const blob = await complete(pending.uploadId, signal);
  signal?.throwIfAborted();
  if (!blob?.blobId || blob.fileName !== exact.fileName
    || normalizeMediaType(blob.mediaType) !== exact.mediaType
    || blob.byteSize !== BigInt(exact.byteSize) || blob.sha256Hex !== exact.sha256Hex
    || blob.disposition !== BlobDisposition.ATTACHMENT) {
    throw new Error("The Joko node committed a mismatched attachment Blob.");
  }
  return blob;
}

function authorizedBlobEndpoint(origin: string, relativeEndpoint: string): string {
  if (!relativeEndpoint.startsWith("/") || relativeEndpoint.startsWith("//") || relativeEndpoint.includes("\\")
    || relativeEndpoint.includes("?") || relativeEndpoint.includes("#")) {
    throw new Error("The Joko node returned a non-root-relative Blob endpoint.");
  }
  const base = new URL(normalizeNodeOrigin(origin));
  const endpoint = new URL(relativeEndpoint, base);
  if (endpoint.origin !== base.origin || endpoint.pathname !== relativeEndpoint) {
    throw new Error("The Joko node returned a cross-origin Blob endpoint.");
  }
  return endpoint.toString();
}

function assertDownloadBlob(blob: BlobRef): void {
  if (!blob.blobId || !normalizeMediaType(blob.mediaType) || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)
    || blob.byteSize < 0n || blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) {
    throw new Error("The Blob is missing valid bounded download metadata.");
  }
}

function assertShareBlob(blob: BlobRef): void {
  const mediaType = normalizeMediaType(blob.mediaType);
  if (!blob.blobId || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)
    || blob.byteSize < 0n || blob.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)
    || blob.byteSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The Blob is missing valid bounded file-sharing metadata.");
  }
}

function assertBlobUploadSource(source: MobileBlobUploadSource): MobileBlobUploadSource & { readonly mediaType: string } {
  const mediaType = normalizeMediaType(source.mediaType);
  if (!source || typeof source !== "object" || typeof source.uri !== "string" || !source.uri
    || typeof source.fileName !== "string" || !source.fileName.trim() || source.fileName.length > 512
    || /[\u0000-\u001f\u007f]/u.test(source.fileName) || !mediaType
    || !Number.isSafeInteger(source.byteSize) || source.byteSize <= 0
    || !/^[0-9a-f]{64}$/u.test(source.sha256Hex)) {
    throw new Error("The staged attachment upload metadata is invalid.");
  }
  return { ...source, mediaType };
}

function validBlobTransferIdentity(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 512 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function uploadNativeBlobFile(
  endpoint: string,
  sourceUri: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal
): Promise<{ readonly status: number; readonly body?: string }> {
  const { File, UploadType } = await import("expo-file-system");
  signal?.throwIfAborted();
  const result = await new File(sourceUri).upload(endpoint, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { ...headers },
    sessionType: "foreground",
    signal
  });
  return { status: result.status, body: result.body };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { CryptoDigestAlgorithm, digest } = await import("expo-crypto");
  const value = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes).buffer));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function collectStablePages<T, Page extends {
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
}>(
  readPage: (pageToken: string) => Promise<Page>,
  label: string,
  valuesOf: (page: Page) => readonly T[]
): Promise<{ readonly values: T[]; readonly revision: string }> {
  const values: T[] = [];
  const tokens = new Set<string>();
  let pageToken = "";
  let totalSize: bigint | undefined;
  let revision: string | undefined;
  while (true) {
    const page = await readPage(pageToken);
    const pageValues = valuesOf(page);
    if (page.totalSize < 0n || !page.revision) throw new Error(`The Joko node returned invalid ${label} metadata.`);
    if (totalSize === undefined) { totalSize = page.totalSize; revision = page.revision; }
    else if (totalSize !== page.totalSize || revision !== page.revision) throw new Error(`${label} changed while paging.`);
    values.push(...pageValues);
    if (!page.nextPageToken) break;
    if (page.nextPageToken === pageToken || tokens.has(page.nextPageToken)) {
      throw new Error(`The Joko node returned a cyclic ${label} page token.`);
    }
    tokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
    if (tokens.size > 10_000) throw new Error(`${label} exceeded the supported page count.`);
  }
  if (BigInt(values.length) !== totalSize) throw new Error(`The Joko node returned an incomplete ${label}.`);
  return { values, revision: revision! };
}

function safeResultCount(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The Joko node returned an oversized ${label} count.`);
  return Number(value);
}

function responseRevision(revision: { readonly etag: string; readonly value: bigint } | undefined): string {
  const value = revision?.etag || revision?.value.toString(10) || "";
  if (!value) throw new Error("The Joko node returned an unfenced result.");
  return value;
}

function validCatalogIdentity(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validCatalogLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function artifactReferenceKind(value: ArtifactKind): boolean {
  return value === ArtifactKind.FILE || value === ArtifactKind.IMAGE || value === ArtifactKind.EXPORT
    || value === ArtifactKind.TOOL_RESULT || value === ArtifactKind.DIAGNOSTICS || value === ArtifactKind.DIFF;
}

function safeCatalogTimestamp(value: {
  readonly seconds: bigint;
  readonly nanos: number;
} | undefined): number | undefined {
  if (value === undefined || value.seconds < 0n || value.seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))
    || !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) return undefined;
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function normalizeNodeOrigin(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Use an HTTP(S) Joko node address.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Use only the Joko node origin, without credentials, path, query or fragment.");
  }
  if (parsed.protocol === "http:" && !isPrivateLanDiscoveryHost(parsed.hostname)) {
    throw new Error("Unencrypted HTTP is allowed only for a local/private-network Joko node. Use HTTPS elsewhere.");
  }
  return parsed.origin;
}

function transport(origin: string, authKey?: string): Transport {
  const interceptors: Interceptor[] = authKey === undefined ? [] : [
    (next) => async (request) => {
      request.header.set("authorization", `Bearer ${authKey}`);
      request.header.set("x-joko-client-version", "0.1.0");
      return next(request);
    }
  ];
  return createConnectTransport({ baseUrl: origin, useBinaryFormat: true, interceptors });
}

export function parseNodeIdentity(server: {
  serverId: string;
  displayName: string;
  version: string;
  apiVersion: string;
  health: number;
  pairingEnabled: boolean;
} | undefined): NodeIdentity {
  if (!server?.serverId.trim() || !server.apiVersion.trim()) throw new Error("This address did not return a valid Joko node identity.");
  if (server.apiVersion !== JOKO_API_VERSION) {
    throw new Error(`This Joko app supports API ${JOKO_API_VERSION}, but the node reports ${server.apiVersion}.`);
  }
  return {
    serverId: server.serverId,
    displayName: server.displayName || "Joko node",
    version: server.version,
    apiVersion: server.apiVersion,
    health: server.health,
    pairingEnabled: server.pairingEnabled
  };
}

function options(signal?: AbortSignal): { signal: AbortSignal } | undefined { return signal === undefined ? undefined : { signal }; }

export const mobileNetwork: MobileNetwork = {
  async inspect(origin, signal) {
    const response = await createClient(ConnectionService, transport(normalizeNodeOrigin(origin))).getServerInfo({}, options(signal));
    return parseNodeIdentity(response.server);
  },
  async discover(rawOrigin, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const response = await createClient(ConnectionService, transport(origin)).listDiscoveredNodes({}, options(signal));
    const receivedAt = Date.now();
    return response.nodes.map((node) => {
      const value: DiscoveredNodeRecord = {
        serverId: node.serverId,
        displayName: node.displayName,
        origin: node.origin,
        version: node.version,
        apiVersion: node.apiVersion,
        pairingEnabled: node.pairingEnabled,
        lastSeen: receivedAt
      };
      validateDiscoveredNode(value);
      return value;
    });
  },
  async requestPairing(rawOrigin, deviceName, platform, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const client = createClient(ConnectionService, transport(origin));
    const node = parseNodeIdentity((await client.getServerInfo({}, options(signal))).server);
    if (!node.pairingEnabled) throw new Error("Pairing is closed on this Joko node. Ask the node owner to open pairing.");
    const args = { deviceDisplayName: deviceName.trim(), deviceKind: DeviceKind.MOBILE, platform, appVersion: "0.1.0" };
    const challenge = (await client.beginPairing(args, options(signal))).challenge;
    if (!challenge?.challengeId) throw new Error("The Joko node did not return a pairing challenge.");
    return { identity: node, challengeId: challenge.challengeId };
  },
  async completePairing(rawOrigin, challengeId, code, deviceName, platform, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const client = createClient(ConnectionService, transport(origin));
    const node = parseNodeIdentity((await client.getServerInfo({}, options(signal))).server);
    const args = { deviceDisplayName: deviceName.trim(), deviceKind: DeviceKind.MOBILE, platform, appVersion: "0.1.0" };
    const result = (await client.completePairing({ ...args, challengeId, humanCode: code.trim() }, options(signal))).result;
    if (!result?.connection?.connectionId || !result.connection.connectionProfileId || !result.device?.deviceId
      || result.connection.deviceId !== result.device.deviceId || !result.authKey) {
      throw new Error("Pairing completed without a matching device and connection credential.");
    }
    return {
      identity: node,
      credential: {
        profileId: result.connection.connectionProfileId,
        origin, serverId: node.serverId, connectionId: result.connection.connectionId,
        deviceId: result.device.deviceId, displayName: result.connection.displayName || deviceName.trim(), authKey: result.authKey
      }
    };
  },
  async readOwner(credential, signal) {
    const client = createClient(ConnectionService, transport(credential.origin, credential.authKey));
    const [connection, device, snapshot] = await Promise.all([
      client.getConnection({ connectionId: credential.connectionId }, options(signal)),
      client.getDevice({ deviceId: credential.deviceId }, options(signal)),
      createClient(EventService, transport(credential.origin, credential.authKey)).getSnapshot({ scope: { kind: { case: "owner", value: {} } } }, options(signal))
    ]);
    if (!connection.connection || !device.device || !snapshot.snapshot) throw new Error("The Joko node returned an incomplete owner snapshot.");
    return { connection: connection.connection, device: device.device, snapshot: snapshot.snapshot };
  },
  async readSession(credential, sessionId, signal) {
    const response = await createClient(EventService, transport(credential.origin, credential.authKey)).getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    }, options(signal));
    if (!response.snapshot || !response.snapshot.sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("The selected task is no longer available on this Joko node.");
    }
    return response.snapshot;
  },
  async readNativeSessionTree(credential, sessionId, signal) {
    if (!sessionId) throw new Error("A current task is required for native branches.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .getNativeSessionTree({ sessionId }, options(signal));
    if (!response.tree) throw new Error("The Joko node returned no native branch tree.");
    return response.tree;
  },
  async readHistory(credential, sessionId, before, signal) {
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey)).listSessionTimeline({
      sessionId, limit: 120, ...(before === undefined ? {} : { beforeCursor: before })
    }, options(signal));
    return { events: response.events, ...(response.nextBeforeCursor === undefined ? {} : { before: response.nextBeforeCursor }) };
  },
  async readAround(credential, sessionId, eventId, signal) {
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey)).listSessionTimeline({
      sessionId, aroundEventId: eventId, limit: 120
    }, options(signal));
    return response.events;
  },
  async searchSessionMessages(credential, query, status, signal) {
    const client = createClient(SessionService, transport(credential.origin, credential.authKey));
    return collectSessionMessageSearchPages(async (pageToken) => {
      const response = await client.searchSessionMessages({
        scope: { case: "owner", value: {} },
        query,
        page: { pageSize: MESSAGE_SEARCH_PAGE_SIZE, pageToken },
        semanticMode: SessionMessageSearchSemanticMode.UNSPECIFIED,
        filters: { sessionStatus: status }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return message-search page metadata.");
      return {
        matches: response.matches,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize
      };
    });
  },
  async listWorkspaceDirectory(credential, workspaceId, parentPath, signal) {
    if (!workspaceId) throw new Error("A current Workspace is required.");
    const parent = canonicalWorkspacePath(parentPath, true);
    const client = createClient(WorkspaceService, transport(credential.origin, credential.authKey));
    return collectWorkspaceDirectoryPages(workspaceId, parent, async (pageToken) => {
      const response = await client.listWorkspaceEntries({
        workspaceId,
        parentRelativePath: parent,
        includeHidden: true,
        listingPolicy: WorkspaceEntryListingPolicy.DOCUMENT_TREE,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return workspace-directory page metadata.");
      return {
        entries: response.entries,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision)
      };
    });
  },
  async listWorkspaceFileIndex(credential, workspaceId, signal) {
    if (!workspaceId) throw new Error("A current Workspace is required.");
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey))
      .listWorkspaceFiles({ workspaceId }, options(signal));
    if (response.relativePaths.length > 30_000) throw new Error("The Joko node returned an oversized workspace file index.");
    const paths = response.relativePaths.map((path) => canonicalWorkspacePath(path));
    if (new Set(paths).size !== paths.length) throw new Error("The Joko node returned duplicate workspace file-index paths.");
    return { paths, truncated: response.truncated, revision: responseRevision(response.revision) };
  },
  async searchWorkspace(credential, workspaceId, query, caseSensitive, signal) {
    if (!workspaceId || !query) throw new Error("A current Workspace and literal search query are required.");
    const client = createClient(WorkspaceService, transport(credential.origin, credential.authKey));
    return collectWorkspaceSearchPages(workspaceId, async (pageToken) => {
      const response = await client.searchWorkspace({
        workspaceId,
        query,
        relativePathPrefix: "",
        caseSensitive,
        regularExpression: false,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return workspace-search page metadata.");
      return {
        matches: response.matches,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision),
        truncated: response.truncated,
        totalFiles: response.totalFiles
      };
    });
  },
  async *watchWorkspace(credential, workspaceId, signal) {
    if (!workspaceId) throw new Error("A current Workspace is required.");
    const client = createClient(WorkspaceService, transport(credential.origin, credential.authKey));
    let previousSequence = 0n;
    for await (const response of client.watchWorkspaceFileChanges({
      scope: { kind: { case: "workspace", value: { workspaceId } } }
    }, { signal })) {
      const change = response.change;
      if (!change || change.workspaceId !== workspaceId || change.sequence <= previousSequence || !change.streamRevision) {
        throw new Error("The Joko node returned an invalid workspace change stream.");
      }
      if (change.kind !== WorkspaceFileChangeKind.OVERFLOW && change.kind !== WorkspaceFileChangeKind.RESYNC) {
        canonicalWorkspacePath(change.relativePath);
      }
      if (change.kind === WorkspaceFileChangeKind.RENAMED) canonicalWorkspacePath(change.previousRelativePath);
      previousSequence = change.sequence;
      yield change;
    }
  },
  async readWorkspaceFile(credential, workspaceId, relativePath, revision, signal) {
    const path = canonicalWorkspacePath(relativePath);
    if (!workspaceId || !revision.opaqueRevision) throw new Error("A current Workspace file revision is required.");
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey)).readWorkspaceFile({
      workspaceId,
      relativePath: path,
      startByte: 0n,
      maximumBytes: 2_097_152n,
      expectedRevision: revision
    }, options(signal));
    return assertWorkspaceFilePreview(workspaceId, path, revision, response.preview);
  },
  async materializeWorkspaceFileBlob(credential, workspaceId, relativePath, revision, signal) {
    const path = canonicalWorkspacePath(relativePath);
    if (!workspaceId || !revision.opaqueRevision) throw new Error("A current Workspace file revision is required.");
    if (revision.byteSize < 0n || revision.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)) {
      throw new Error("The Workspace file exceeds the mobile sharing limit.");
    }
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey)).readWorkspaceFile({
      workspaceId,
      relativePath: path,
      startByte: 0n,
      maximumBytes: BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES),
      expectedRevision: revision,
      requireBlob: true
    }, options(signal));
    return assertMaterializedWorkspaceBlob(workspaceId, path, revision, response.preview);
  },
  async listSessionArtifacts(credential, sessionId, signal) {
    if (!sessionId) throw new Error("A current task is required for Generated files.");
    const client = createClient(ArtifactService, transport(credential.origin, credential.authKey));
    return collectArtifactPages(sessionId, async (pageToken) => {
      const response = await client.listArtifacts({
        sessionId,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Artifact page metadata.");
      return {
        artifacts: response.artifacts,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision)
      };
    });
  },
  async listRuntimeCommands(credential, sessionId, signal) {
    if (!validCatalogIdentity(sessionId, 1_024)) throw new Error("A current task is required for its runtime command catalog.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .listRuntimeCommands({ sessionId }, options(signal));
    return response.commands;
  },
  async listSessionResources(credential, sessionId, signal) {
    if (!validCatalogIdentity(sessionId, 1_024)) throw new Error("A current task is required for its Resource catalog.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .listSessionResources({ sessionId }, options(signal));
    return assertSessionResourceCatalog(sessionId, response.resources);
  },
  async listArtifactReferenceCatalog(credential, sessionId, generation, signal) {
    if (!validCatalogIdentity(sessionId, 1_024) || generation < 1n || generation > 0xffff_ffff_ffff_ffffn) {
      throw new Error("A current task generation is required for its Artifact reference catalog.");
    }
    const client = createClient(ArtifactService, transport(credential.origin, credential.authKey));
    return collectArtifactReferencePages(async (pageToken) => {
      const response = await client.listArtifacts({
        referenceTargetSessionId: sessionId,
        referenceTargetGeneration: generation,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Artifact reference page metadata.");
      return {
        artifacts: response.artifacts,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision)
      };
    });
  },
  async downloadBlob(credential, blob, signal) {
    assertDownloadBlob(blob);
    const response = await createClient(ArtifactService, transport(credential.origin, credential.authKey))
      .getBlobDownloadTicket({ blobId: blob.blobId }, options(signal));
    return downloadVerifiedBlob(credential, blob, response.ticket, signal);
  },
  async authorizeBlobDownload(credential, blob, signal) {
    assertShareBlob(blob);
    const response = await createClient(ArtifactService, transport(credential.origin, credential.authKey))
      .getBlobDownloadTicket({ blobId: blob.blobId }, options(signal));
    signal?.throwIfAborted();
    return authorizeVerifiedBlobDownload(credential, blob, response.ticket);
  },
  async uploadBlob(credential, source, signal) {
    const exact = assertBlobUploadSource(source);
    const client = createClient(ArtifactService, transport(credential.origin, credential.authKey));
    const response = await client.beginBlobUpload({
      fileName: exact.fileName,
      mediaType: exact.mediaType,
      byteSize: BigInt(exact.byteSize),
      sha256Hex: exact.sha256Hex,
      disposition: BlobDisposition.ATTACHMENT
    }, options(signal));
    return uploadVerifiedBlob(
      credential,
      exact,
      response.upload,
      async (uploadId, completeSignal) => (await client.completeBlobUpload(
        { uploadId },
        options(completeSignal)
      )).blob,
      signal
    );
  },
  async getVoiceInputCapabilities(credential, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .getVoiceInputCapabilities({}, options(signal));
    return projectMobileVoiceCapability(response.profile);
  },
  async startVoiceInput(credential, requestId, mimeType, locale, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .startVoiceInput({ requestId, mimeType, ...(locale === undefined ? {} : { locale }) }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async appendVoiceAudio(credential, voiceInputId, chunkSequence, audio, durationMs, voiced, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .appendVoiceAudio({ voiceInputId, chunkSequence, audio: Uint8Array.from(audio), durationMs, voiced }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async stopVoiceInput(credential, voiceInputId, expectedNextChunkSequence, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .stopVoiceInput({ voiceInputId, expectedNextChunkSequence }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async cancelVoiceInput(credential, voiceInputId, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .cancelVoiceInput({ voiceInputId }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async getVoiceInputSession(credential, voiceInputId, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .getVoiceInputSession({ voiceInputId }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async *streamOwner(credential, after, signal) {
    const client = createClient(EventService, transport(credential.origin, credential.authKey));
    for await (const response of client.streamEvents({
      scope: { kind: { case: "owner", value: {} } }, afterCursor: after
    }, { signal })) {
      if (response.event) yield response.event;
    }
  },
  async prepareTarget(credential, target, signal) {
    const revision = target.version?.revision;
    if (!target.targetId || !revision || revision.value < 1n) throw new Error("A current target revision is required.");
    const response = await createClient(TargetService, transport(credential.origin, credential.authKey)).prepareTargetWorkspace({
      targetId: target.targetId, expectedTargetRevision: revision
    }, options(signal));
    if (!response.workspace || response.workspace.targetId !== target.targetId
      || response.workspace.version?.revision?.value !== revision.value || !response.workspace.workspaceId) {
      throw new Error("The prepared workspace did not match the selected target revision.");
    }
  },
  async submit(credential, operationId, mutation, signal) {
    const response = await createClient(OperationService, transport(credential.origin, credential.authKey)).submitOperation({
      operationId, connectionId: credential.connectionId, mutation
    }, options(signal));
    if (!response.operation || response.operation.operationId !== operationId || response.operation.connectionId !== credential.connectionId) {
      throw new Error("The Joko node returned a mismatched operation receipt.");
    }
    return response.operation;
  },
  async waitOperation(credential, operationId, signal) {
    const client = createClient(OperationService, transport(credential.origin, credential.authKey));
    let revision = 0n;
    for await (const response of client.watchOperation({ operationId }, options(signal))) {
      const operation = response.operation;
      if (!operation || operation.operationId !== operationId || operation.connectionId !== credential.connectionId) {
        throw new Error("The Joko node returned a mismatched operation update.");
      }
      const nextRevision = operation.version?.revision?.value ?? 0n;
      if (nextRevision > 0n && nextRevision < revision) {
        throw new Error("The Joko node returned a regressed operation update.");
      }
      revision = nextRevision > revision ? nextRevision : revision;
      if ([OperationState.SUCCEEDED, OperationState.FAILED, OperationState.CANCELLED, OperationState.CONFLICT].includes(operation.state)) {
        return operation;
      }
    }
    throw new Error("The Joko operation stream closed before a durable result.");
  },
  async getOperation(credential, operationId, signal) {
    let response;
    try {
      response = await createClient(OperationService, transport(credential.origin, credential.authKey)).getOperation({ operationId }, options(signal));
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
      throw error;
    }
    if (response.operation && (response.operation.operationId !== operationId || response.operation.connectionId !== credential.connectionId)) {
      throw new Error("The Joko node returned a mismatched operation identity.");
    }
    return response.operation;
  }
};
