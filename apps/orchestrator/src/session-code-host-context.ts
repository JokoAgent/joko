import {
  CodeHostProjectionCoordinator,
  CodeHostPullRequestNotFoundError,
  CodeHostProviderUnavailableError,
  extractCodeHostPullRequestReferences,
  materializeCodeHostSessionProjection,
  parseCodeHostPullRequestReference,
  type CodeHostPullRequestReference,
  type CodeHostNegativeObservation,
  type CodeHostProjectionRepository,
  type CodeHostProvider,
  type CodeHostSessionAuthorization,
  type CodeHostSessionAuthorizationPort,
  type CodeHostSessionProjection,
  type CodeHostSessionReferenceProjection
} from "@joko/code-host";
import type { OperationalStore, PersistedEvent, StoredSession } from "@joko/store";

export const SESSION_CODE_HOST_PROJECTION_SETTING_KEY = "codeHost.pullRequests.v1";
const ASSOCIATIONS_KEY = "codeHost.pullRequestAssociations.v1";
const MAXIMUM_ASSOCIATIONS = 16;
const MAXIMUM_PINNED_ASSOCIATIONS = 3;
const CONTEXT_EVENT_PAGE_SIZE = 200;
const REFRESH_CONCURRENCY = 4;

const installedRuntimes = new WeakMap<OperationalStore, SessionCodeHostContextRuntime>();

interface SessionCodeHostRefresh {
  references: readonly CodeHostPullRequestReference[];
  readonly result: Promise<CodeHostSessionProjection>;
}

export function installSessionCodeHostContextRuntime(options: {
  readonly store: OperationalStore;
  readonly providers?: readonly CodeHostProvider[];
  readonly now?: () => number;
}): SessionCodeHostContextRuntime {
  const existing = installedRuntimes.get(options.store);
  if (existing !== undefined) return existing;
  const runtime = new SessionCodeHostContextRuntime(options);
  installedRuntimes.set(options.store, runtime);
  runtime.install();
  return runtime;
}

export class OperationalCodeHostProjectionRepository implements CodeHostProjectionRepository {
  constructor(private readonly store: OperationalStore) {}

  read(sessionOwnerId: string): CodeHostSessionProjection | undefined {
    return materializeCodeHostSessionProjection(this.store.findSetting(
      "session",
      sessionOwnerId,
      SESSION_CODE_HOST_PROJECTION_SETTING_KEY
    )?.value, sessionOwnerId);
  }

  write(projection: CodeHostSessionProjection): void {
    this.store.setSetting(
      "session",
      projection.sessionOwnerId,
      SESSION_CODE_HOST_PROJECTION_SETTING_KEY,
      projection
    );
  }
}

/** Revalidates that a canonical reference still belongs to the same durable Session. */
export class OperationalCodeHostSessionAuthorization implements CodeHostSessionAuthorizationPort {
  constructor(private readonly store: OperationalStore) {}

  authorize(
    sessionOwnerId: string,
    reference: CodeHostPullRequestReference
  ): CodeHostSessionAuthorization | undefined {
    if (
      sessionOwnerId.length === 0
      || sessionOwnerId.length > 256
      || sessionOwnerId.trim() !== sessionOwnerId
      || /[\u0000-\u001f\u007f]/u.test(sessionOwnerId)
    ) return undefined;
    let session: StoredSession;
    try {
      session = this.store.getSession(sessionOwnerId);
    } catch {
      return undefined;
    }
    if (session.descriptor.id !== sessionOwnerId || session.descriptor.deletedAt !== undefined) return undefined;
    const authorized = effectiveReferences(this.store, session).some(candidate => sameReference(candidate, reference));
    if (!authorized) return undefined;
    const associations = associationSetting(this.store, sessionOwnerId);
    return Object.freeze({
      sessionOwnerId,
      referenceKey: reference.key,
      ownerRevision: associations === undefined ? session.revision.toString(10) : `${session.revision}:${associations.revision}`
    });
  }

  isCurrent(
    authorization: CodeHostSessionAuthorization,
    reference: CodeHostPullRequestReference
  ): boolean {
    const current = this.authorize(authorization.sessionOwnerId, reference);
    return current !== undefined
      && current.referenceKey === authorization.referenceKey
      && current.ownerRevision === authorization.ownerRevision;
  }
}

export class SessionCodeHostContextRuntime {
  private readonly store: OperationalStore;
  private readonly coordinator: CodeHostProjectionCoordinator;
  private readonly authorization: OperationalCodeHostSessionAuthorization;
  private readonly refreshes = new Map<string, SessionCodeHostRefresh>();
  private readonly pendingBackgroundSessions = new Set<string>();
  private backgroundRefreshScheduled = false;
  private installed = false;

  constructor(options: {
    readonly store: OperationalStore;
    readonly providers?: readonly CodeHostProvider[];
    readonly now?: () => number;
  }) {
    this.store = options.store;
    this.authorization = new OperationalCodeHostSessionAuthorization(this.store);
    this.coordinator = new CodeHostProjectionCoordinator({
      repository: new OperationalCodeHostProjectionRepository(options.store),
      providers: options.providers ?? [],
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  install(): void {
    if (this.installed || typeof (this.store as Partial<OperationalStore>).subscribe !== "function") return;
    this.installed = true;
    this.store.subscribe((event) => {
      if (event.traceId === "session-code-host-projection" || !eventCanChangeCodeHostContext(event, this.store)) return;
      this.refreshSessionInBackground(event.sessionId);
    });
  }

  isReferenceCurrent(sessionId: string, reference: CodeHostPullRequestReference): boolean {
    return this.authorization.authorize(sessionId, reference) !== undefined;
  }

  refreshAfterSignIn(sessionId: string, referenceKey: string, assertCurrent: () => void): Promise<void> {
    return this.refreshAndPublish(sessionId, { referenceKey, assertCurrent });
  }

  async refreshSession(sessionId: string, signIn?: {
    readonly referenceKey: string;
    readonly assertCurrent: () => void;
  }): Promise<CodeHostSessionProjection | undefined> {
    if (!storeSupportsCodeHostProjection(this.store)) return undefined;
    let recheck: CodeHostNegativeObservation | undefined;
    if (signIn !== undefined) {
      for (let pending = this.refreshes.get(sessionId); pending !== undefined; pending = this.refreshes.get(sessionId)) {
        await pending.result.catch(() => undefined);
        signIn.assertCurrent();
      }
      signIn.assertCurrent();
      const entry = readSessionCodeHostReferences(this.store, sessionId).find(item => item.reference.key === signIn.referenceKey);
      if (entry?.notFoundUntil !== undefined && entry.projection === undefined) {
        recheck = { referenceKey: signIn.referenceKey, notFoundUntil: entry.notFoundUntil };
      }
    }
    let session: StoredSession;
    try {
      session = this.store.getSession(sessionId);
    } catch {
      return undefined;
    }
    const references = session.descriptor.deletedAt === undefined ? effectiveReferences(this.store, session) : [];
    const pending = this.refreshes.get(sessionId);
    if (pending !== undefined) {
      if (!sameReferenceList(pending.references, references)) pending.references = references;
      return pending.result;
    }
    const flight: SessionCodeHostRefresh = {
      references,
      result: Promise.resolve().then(async () => {
        // Finish reconciling the latest local references before resolving any joined caller.
        for (;;) {
          const current = flight.references;
          const associationRevision = associationSetting(this.store, sessionId)?.revision;
          const refreshed = await this.coordinator.refreshSession(sessionId, current, (reference) => {
            signIn?.assertCurrent();
            if (associationSetting(this.store, sessionId)?.revision !== associationRevision) {
              const latest = this.store.getSession(sessionId);
              flight.references = latest.descriptor.deletedAt === undefined ? effectiveReferences(this.store, latest) : [];
              throw new Error("The Session pull request associations changed.");
            }
            if (flight.references !== current && (reference === undefined || !flight.references.some(candidate => sameReference(candidate, reference)))) {
              throw new Error("The Session pull request references changed.");
            }
          }, recheck).catch((error: unknown) => {
            signIn?.assertCurrent();
            if (flight.references === current) throw error;
            return undefined;
          });
          if (refreshed !== undefined && flight.references === current) return refreshed.projection;
        }
      }).finally(() => { this.refreshes.delete(sessionId); })
    };
    this.refreshes.set(sessionId, flight);
    return flight.result;
  }

  async refreshSessions(sessionIds: readonly string[]): Promise<void> {
    const unique = [...new Set(sessionIds)];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, unique.length) }, async () => {
      while (cursor < unique.length) {
        const index = cursor++;
        const sessionId = unique[index];
        if (sessionId !== undefined) await this.refreshSession(sessionId);
      }
    });
    await Promise.all(workers);
  }

  /** Core Session/Snapshot reads return the durable projection and refresh remote facts off-path. */
  refreshSessionsInBackground(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.pendingBackgroundSessions.add(sessionId);
    if (this.backgroundRefreshScheduled || this.pendingBackgroundSessions.size === 0) return;
    this.backgroundRefreshScheduled = true;
    // Store dispatches a committed history batch synchronously. Each Session
    // needs one read of the resulting history, including while a Provider read is in flight.
    queueMicrotask(() => {
      this.backgroundRefreshScheduled = false;
      const unique = [...this.pendingBackgroundSessions];
      this.pendingBackgroundSessions.clear();
      let cursor = 0;
      const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, unique.length) }, async () => {
        while (cursor < unique.length) {
          const index = cursor++;
          const sessionId = unique[index];
          // Provider faults retain the prior snapshot and never enter event text.
          if (sessionId !== undefined) await this.refreshAndPublish(sessionId).catch(() => undefined);
        }
      });
      void Promise.all(workers);
    });
  }

  refreshSessionInBackground(sessionId: string): void {
    this.refreshSessionsInBackground([sessionId]);
  }

  private async refreshAndPublish(sessionId: string, signIn?: {
    readonly referenceKey: string;
    readonly assertCurrent: () => void;
  }): Promise<void> {
    if (!storeSupportsCodeHostProjection(this.store)) return;
    const before = readSessionCodeHostProjection(this.store, sessionId);
    const after = await this.refreshSession(sessionId, signIn);
    signIn?.assertCurrent();
    if (after === undefined || samePublishedCodeHostProjection(before, after)) return;
    if ((before?.references.length ?? 0) === 0 && after.references.length === 0) return;
    const session = this.store.getSession(sessionId);
    this.store.appendEvent({
      backendId: session.descriptor.backendId,
      targetId: session.descriptor.targetId,
      sessionId,
      generation: session.descriptor.binding.generation,
      traceId: "session-code-host-projection",
      payload: { type: "session_changed" }
    });
  }
}

function samePublishedCodeHostProjection(
  left: CodeHostSessionProjection | undefined,
  right: CodeHostSessionProjection
): boolean {
  if (left === undefined) return false;
  const published = (projection: CodeHostSessionProjection): unknown => projection.references.map((entry) => ({
    reference: entry.reference,
    projection: entry.projection
  }));
  return JSON.stringify(published(left)) === JSON.stringify(published(right));
}

export function readSessionCodeHostProjection(
  store: Pick<OperationalStore, "findSetting">,
  sessionId: string
): CodeHostSessionProjection | undefined {
  return materializeCodeHostSessionProjection(store.findSetting(
    "session",
    sessionId,
    SESSION_CODE_HOST_PROJECTION_SETTING_KEY
  )?.value, sessionId);
}

export function readSessionCodeHostReferences(
  store: Pick<OperationalStore, "findSetting">,
  sessionId: string
): readonly CodeHostSessionReferenceProjection[] {
  return readSessionCodeHostProjection(store, sessionId)?.references ?? [];
}

export function refreshSessionCodeHostReferencesInBackground(store: OperationalStore, sessionIds: readonly string[]): void {
  installedRuntimes.get(store)?.refreshSessionsInBackground(sessionIds);
}

interface PullRequestAssociations {
  readonly format: 1;
  readonly orderedUrls: readonly string[];
  readonly removedUrls: readonly string[];
  readonly pinnedUrls?: readonly string[];
}

export function parseManagedPullRequestUrls(orderedUrls: readonly string[], removedUrls: readonly string[],
  pinnedUrls?: readonly string[], previousPinned: readonly string[] = []): PullRequestAssociations | undefined {
  if (orderedUrls.length > MAXIMUM_ASSOCIATIONS || removedUrls.length > MAXIMUM_ASSOCIATIONS) return undefined;
  const unique = new Set<string>();
  const normalize = (urls: readonly string[]) => urls.map(url => {
    const reference = parseCodeHostPullRequestReference(url.trim());
    if (!reference || !manageableReference(reference) || unique.has(reference.key)) return undefined;
    unique.add(reference.key);
    return reference.webUrl;
  });
  const ordered = normalize(orderedUrls), removed = normalize(removedUrls);
  if (!ordered.every(url => url !== undefined) || !removed.every(url => url !== undefined)) return undefined;
  const pinned = pinnedUrls?.map(url => parseCodeHostPullRequestReference(url.trim())?.webUrl)
    ?? previousPinned.filter(url => ordered.includes(url));
  if (pinned.length > MAXIMUM_PINNED_ASSOCIATIONS || new Set(pinned).size !== pinned.length
    || !pinned.every(url => url !== undefined) || !pinned.every(url => ordered.includes(url))) return undefined;
  return { format: 1, orderedUrls: ordered, removedUrls: removed, pinnedUrls: pinned };
}

export function readSessionPullRequestAssociations(store: OperationalStore, session: StoredSession) {
  const setting = associationSetting(store, session.descriptor.id);
  const active = effectiveReferences(store, session).filter(manageableReference);
  const pinned = new Set(setting?.value.pinnedUrls ?? []);
  return { revision: setting?.revision ?? 0n, active, pinned: active.filter(reference => pinned.has(reference.webUrl)),
    removed: parseReferences(setting?.value.removedUrls ?? []) };
}

export async function validateNewPullRequestAssociations(sessionId: string, associations: PullRequestAssociations,
  current: readonly CodeHostPullRequestReference[], providerFactory: (scope: CodeHostSessionAuthorizationPort) => readonly CodeHostProvider[],
  assertCurrent: () => void, signal: AbortSignal): Promise<void> {
  const present = new Set(current.map(reference => reference.key));
  const additions = parseReferences(associations.orderedUrls).filter(reference => !present.has(reference.key));
  if (additions.length === 0) return;
  const ids = new Map(additions.map(reference => [reference.key, reference]));
  const authorize = (owner: string, reference: CodeHostPullRequestReference): CodeHostSessionAuthorization | undefined => {
    assertCurrent();
    const expected = ids.get(reference.key);
    return owner === sessionId && expected !== undefined && sameReference(expected, reference)
      ? { sessionOwnerId: sessionId, referenceKey: reference.key, ownerRevision: "pending-association" } : undefined;
  };
  const providers = providerFactory({ authorize, isCurrent: (lease, reference) => authorize(lease.sessionOwnerId, reference)?.referenceKey === lease.referenceKey });
  for (const reference of additions) {
    let found = false;
    for (const provider of providers) {
      if (!provider.supports(reference)) continue;
      signal.throwIfAborted();
      assertCurrent();
      try {
        await provider.getPullRequest(reference, { sessionOwnerId: sessionId, signal });
        assertCurrent();
        found = true;
        break;
      } catch (error) {
        assertCurrent();
        if (!(error instanceof CodeHostProviderUnavailableError)) throw error;
      }
    }
    if (!found) throw new CodeHostPullRequestNotFoundError();
  }
}

export function writeSessionPullRequestAssociations(store: OperationalStore, session: StoredSession, associations: PullRequestAssociations) {
  const { id, backendId, targetId, binding } = session.descriptor;
  return store.transaction(current => {
    current.setSetting("session", id, ASSOCIATIONS_KEY, associations);
    const active = effectiveReferences(current, session);
    const previous = new Map(readSessionCodeHostReferences(current, id).map(entry => [entry.reference.key, entry]));
    new OperationalCodeHostProjectionRepository(current).write({ schemaVersion: 1, sessionOwnerId: id,
      references: active.map(reference => previous.get(reference.key) ?? { reference }) });
    current.appendEvent({ backendId, targetId, sessionId: id, generation: binding.generation,
      traceId: "session-code-host-associations", payload: { type: "session_changed" } });
    return readSessionPullRequestAssociations(current, session);
  });
}

function associationSetting(store: Pick<OperationalStore, "findSetting">, sessionId: string) {
  return store.findSetting<PullRequestAssociations>("session", sessionId, ASSOCIATIONS_KEY);
}

function manageableReference(reference: CodeHostPullRequestReference): boolean {
  return reference.host === "github.com" && reference.webUrl.includes("/pull/")
    || reference.webUrl.includes("/-/merge_requests/");
}

function parseReferences(urls: readonly string[]): readonly CodeHostPullRequestReference[] {
  return urls.flatMap(url => {
    const reference = parseCodeHostPullRequestReference(url);
    return reference !== undefined && manageableReference(reference) ? [reference] : [];
  });
}

function effectiveReferences(store: OperationalStore, session: StoredSession): readonly CodeHostPullRequestReference[] {
  const automatic = extractCodeHostPullRequestReferences(sessionCodeHostContext(store, session));
  const manual = associationSetting(store, session.descriptor.id)?.value;
  if (manual === undefined) return automatic;
  const removed = new Set(parseReferences(manual.removedUrls).map(reference => reference.key));
  const pinned = new Set(manual.pinnedUrls ?? []);
  const configured = parseReferences(manual.orderedUrls);
  const ordered = new Map([...configured.filter(reference => pinned.has(reference.webUrl)),
    ...configured.filter(reference => !pinned.has(reference.webUrl))].map(reference => [reference.key, reference]));
  for (const reference of automatic) {
    if (!removed.has(reference.key) && !ordered.has(reference.key)) ordered.set(reference.key, reference);
    if (ordered.size >= MAXIMUM_ASSOCIATIONS) break;
  }
  return [...ordered.values()].slice(0, MAXIMUM_ASSOCIATIONS);
}

function* sessionCodeHostContext(
  store: Pick<OperationalStore, "listEvents" | "getBackend">,
  session: StoredSession
): Generator<string> {
  const activeNativeTimeline = usesPiTimeline(store, session.descriptor.backendId);
  let beforeCursor: bigint | undefined;
  for (;;) {
    const page = store.listEvents({
      sessionId: session.descriptor.id,
      activeNativeTimeline,
      messageHttpsOnly: true,
      order: "desc",
      limit: CONTEXT_EVENT_PAGE_SIZE,
      ...(beforeCursor === undefined ? {} : { beforeCursor })
    });
    for (const event of page) {
      if (event.payload.type !== "message_complete" || event.payload.automaticContinuation !== undefined
        || event.payload.objectiveContinuation !== undefined || event.payload.inputHandoffContinuation !== undefined
        || event.payload.partnerPrivateOrigin !== undefined) continue;
      for (const block of event.payload.blocks) {
        if (block.kind === "text") yield block.text;
      }
    }
    if (page.length < CONTEXT_EVENT_PAGE_SIZE) break;
    const nextCursor = page[page.length - 1]!.globalCursor;
    if (beforeCursor !== undefined && nextCursor >= beforeCursor) throw new Error("Session reference history did not advance.");
    beforeCursor = nextCursor;
  }
  if (session.descriptor.summary !== undefined) yield session.descriptor.summary;
  yield session.descriptor.title;
}

function eventCanChangeCodeHostContext(event: PersistedEvent, store: Pick<OperationalStore, "getBackend">): boolean {
  return event.payload.type === "message_complete"
    || event.payload.type === "message_deleted"
    || (event.payload.type === "native_session_changed" && usesPiTimeline(store, event.backendId))
    || event.payload.type === "session_reset"
    || event.payload.type === "session_changed";
}

function usesPiTimeline(store: Pick<OperationalStore, "getBackend">, backendId: string): boolean {
  return store.getBackend(backendId).descriptor.adapterKind === "pi";
}

function storeSupportsCodeHostProjection(store: OperationalStore): boolean {
  const candidate = store as Partial<OperationalStore>;
  return typeof candidate.getSession === "function"
    && typeof candidate.getBackend === "function"
    && typeof candidate.listEvents === "function"
    && typeof candidate.findSetting === "function"
    && typeof candidate.setSetting === "function"
    && typeof candidate.appendEvent === "function";
}

function sameReference(
  left: CodeHostPullRequestReference,
  right: CodeHostPullRequestReference
): boolean {
  return left.key === right.key
    && left.host === right.host
    && left.repositoryOwner === right.repositoryOwner
    && left.repositoryName === right.repositoryName
    && left.number === right.number
    && left.webUrl === right.webUrl;
}

function sameReferenceList(left: readonly CodeHostPullRequestReference[], right: readonly CodeHostPullRequestReference[]): boolean {
  return left.length === right.length && left.every((reference, index) => sameReference(reference, right[index]!));
}
