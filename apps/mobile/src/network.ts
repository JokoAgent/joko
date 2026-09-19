import { Code, ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  ArtifactService, ConnectionService, DeviceKind, EventService, FileKind, OperationService, SessionService, TargetService,
  TransferDirection, WorkspaceEntryListingPolicy, WorkspaceFileChangeKind, WorkspaceService,
  JOKO_API_VERSION, SessionMessageSearchSemanticMode, SessionMessageSearchSessionStatus,
  isPrivateLanDiscoveryHost, validateDiscoveredNode,
  type Artifact, type BlobRef, type BlobTransferTicket, type Connection, type Device, type DiscoveredNodeRecord,
  type Event, type EventCursor, type FilePreview, type FileRevision, type Operation, type OperationMutation,
  type SessionMessageSearchMatch, type Snapshot, type Target, type WorkspaceEntry, type WorkspaceFileChange,
  type WorkspaceSearchMatch
} from "@joko/contracts";
import {
  canonicalWorkspacePath,
  normalizeMediaType,
  workspaceEntryRevisionKey,
  workspaceParentPath
} from "./workspace-files";

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
  readHistory(credential: PairedCredential, sessionId: string, before?: EventCursor, signal?: AbortSignal): Promise<{ events: Event[]; before?: EventCursor }>;
  readAround(credential: PairedCredential, sessionId: string, eventId: string, signal?: AbortSignal): Promise<Event[]>;
  searchSessionMessages(credential: PairedCredential, query: string, status: SessionMessageSearchSessionStatus, signal?: AbortSignal): Promise<readonly SessionMessageSearchMatch[]>;
  streamOwner(credential: PairedCredential, after: EventCursor, signal: AbortSignal): AsyncIterable<Event>;
  listWorkspaceDirectory(credential: PairedCredential, workspaceId: string, parentPath: string, signal?: AbortSignal): Promise<WorkspaceDirectorySnapshot>;
  listWorkspaceFileIndex(credential: PairedCredential, workspaceId: string, signal?: AbortSignal): Promise<WorkspaceFileIndexSnapshot>;
  searchWorkspace(credential: PairedCredential, workspaceId: string, query: string, caseSensitive: boolean, signal?: AbortSignal): Promise<WorkspaceSearchSnapshot>;
  watchWorkspace(credential: PairedCredential, workspaceId: string, signal: AbortSignal): AsyncIterable<WorkspaceFileChange>;
  readWorkspaceFile(credential: PairedCredential, workspaceId: string, relativePath: string, revision: FileRevision, signal?: AbortSignal): Promise<FilePreview>;
  listSessionArtifacts(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<ArtifactCatalogSnapshot>;
  downloadBlob(credential: PairedCredential, blob: BlobRef, signal?: AbortSignal): Promise<VerifiedBlobDownload>;
  prepareTarget(credential: PairedCredential, target: Target, signal?: AbortSignal): Promise<void>;
  submit(credential: PairedCredential, operationId: string, mutation: OperationMutation, signal?: AbortSignal): Promise<Operation>;
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

interface SessionMessageSearchPage {
  readonly matches: readonly SessionMessageSearchMatch[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
}

const MESSAGE_SEARCH_PAGE_SIZE = 100;
const WORKSPACE_PAGE_SIZE = 500;
export const MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES = 32 * 1024 * 1024;

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
  async downloadBlob(credential, blob, signal) {
    assertDownloadBlob(blob);
    const response = await createClient(ArtifactService, transport(credential.origin, credential.authKey))
      .getBlobDownloadTicket({ blobId: blob.blobId }, options(signal));
    return downloadVerifiedBlob(credential, blob, response.ticket, signal);
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
