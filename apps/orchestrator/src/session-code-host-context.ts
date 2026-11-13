import {
  CodeHostProjectionCoordinator,
  extractCodeHostPullRequestReferences,
  materializeCodeHostSessionProjection,
  type CodeHostPullRequestReference,
  type CodeHostProjectionRepository,
  type CodeHostProvider,
  type CodeHostSessionAuthorization,
  type CodeHostSessionAuthorizationPort,
  type CodeHostSessionProjection,
  type CodeHostSessionReferenceProjection
} from "@joko/code-host";
import type { OperationalStore, PersistedEvent, StoredSession } from "@joko/store";

export const SESSION_CODE_HOST_PROJECTION_SETTING_KEY = "codeHost.pullRequests.v1";
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
    const authorized = extractCodeHostPullRequestReferences(
      sessionCodeHostContext(this.store, session)
    ).some((candidate) => sameReference(candidate, reference));
    if (!authorized) return undefined;
    return Object.freeze({
      sessionOwnerId,
      referenceKey: reference.key,
      ownerRevision: session.revision.toString(10)
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
  private readonly refreshes = new Map<string, SessionCodeHostRefresh>();
  private installed = false;

  constructor(options: {
    readonly store: OperationalStore;
    readonly providers?: readonly CodeHostProvider[];
    readonly now?: () => number;
  }) {
    this.store = options.store;
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
      queueMicrotask(() => { void this.refreshAndPublish(event.sessionId); });
    });
  }

  async refreshSession(sessionId: string): Promise<CodeHostSessionProjection | undefined> {
    if (!storeSupportsCodeHostProjection(this.store)) return undefined;
    let session: StoredSession;
    try {
      session = this.store.getSession(sessionId);
    } catch {
      return undefined;
    }
    const references = session.descriptor.deletedAt === undefined
      ? extractCodeHostPullRequestReferences(sessionCodeHostContext(this.store, session)) : [];
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
          const refreshed = await this.coordinator.refreshSession(sessionId, current, (reference) => {
            if (flight.references !== current && (reference === undefined || !flight.references.some(candidate => sameReference(candidate, reference)))) {
              throw new Error("The Session pull request references changed.");
            }
          }).catch((error: unknown) => {
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
    const unique = [...new Set(sessionIds)];
    if (unique.length === 0) return;
    queueMicrotask(() => {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, unique.length) }, async () => {
        while (cursor < unique.length) {
          const index = cursor++;
          const sessionId = unique[index];
          if (sessionId !== undefined) await this.refreshAndPublish(sessionId);
        }
      });
      void Promise.all(workers);
    });
  }

  refreshSessionInBackground(sessionId: string): void {
    this.refreshSessionsInBackground([sessionId]);
  }

  private async refreshAndPublish(sessionId: string): Promise<void> {
    if (!storeSupportsCodeHostProjection(this.store)) return;
    try {
      const before = readSessionCodeHostProjection(this.store, sessionId);
      const after = await this.refreshSession(sessionId);
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
    } catch {
      // Provider faults retain the prior snapshot and never enter diagnostics or event text.
    }
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
