import { nativeHistoryEventContext, type NativeHistoryProjection, type SessionDescriptor } from "@joko/core";
import type { OperationalStore } from "./operational-store.js";
import type { PersistedEvent } from "./types.js";
import { StoreError } from "./errors.js";

export const SIDE_CHAT_HISTORY_BOUNDARY_KEY = "session.side-chat-history-boundary.v1";
const MAX_ENTRIES = 100_000, MAX_CHARACTERS = 8 * 1024 * 1024;
interface SideChatHistoryBoundary {
  readonly format: 1;
  readonly sourceSessionId: string;
  readonly sourceEventId: string;
  readonly sourceGeneration: number;
  readonly sourceCursor: string;
  readonly nativeBoundaryId: string;
  readonly entryIds: readonly string[];
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");

/** Only bounded native identities are retained here; native content stays with its Adapter. */
export function readSideChatHistoryBoundary(store: OperationalStore, session: SessionDescriptor): ReadonlySet<string> | undefined {
  if (!session.derivationOrigin?.sideChat) return undefined;
  const setting = store.findSetting("service", session.id, SIDE_CHAT_HISTORY_BOUNDARY_KEY);
  if (!setting) return undefined;
  const value = setting.value as Partial<SideChatHistoryBoundary>;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== 1
    || Object.keys(value).some(key => !["format", "sourceSessionId", "sourceEventId", "sourceGeneration", "sourceCursor", "nativeBoundaryId", "entryIds"].includes(key))
    || value.sourceSessionId !== session.derivationOrigin.sourceSessionId || value.sourceEventId !== session.derivationOrigin.sourceEventId
    || !Number.isSafeInteger(value.sourceGeneration) || value.sourceGeneration! < 0
    || typeof value.sourceCursor !== "string" || !/^[1-9][0-9]*$/u.test(value.sourceCursor)
    || !identity(value.nativeBoundaryId) || !Array.isArray(value.entryIds) || value.entryIds.length === 0 || value.entryIds.length > MAX_ENTRIES
    || !value.entryIds.every(identity) || value.entryIds.reduce((count, id) => count + id.length, 0) > MAX_CHARACTERS
    || new Set(value.entryIds).size !== value.entryIds.length || !value.entryIds.includes(value.nativeBoundaryId)) {
    throw new StoreError("The original Side Chat history boundary is invalid.");
  }
  return new Set(value.entryIds);
}

export function sideChatHistoryEventVisible(session: SessionDescriptor, event: PersistedEvent, inherited: ReadonlySet<string> | undefined): boolean {
  if (!session.derivationOrigin?.sideChat) return true;
  const entryId = nativeHistoryEventContext(event.payload)?.identity?.entryId;
  return entryId === undefined || inherited !== undefined && !inherited.has(entryId);
}

export function ensureSideChatHistoryBoundary(store: OperationalStore, session: SessionDescriptor, history: NativeHistoryProjection): ReadonlySet<string> | undefined {
  if (!session.derivationOrigin?.sideChat) return undefined;
  const existing = readSideChatHistoryBoundary(store, session);
  if (existing) return existing;
  const origin = session.derivationOrigin;
  const source = store.getSession(origin.sourceSessionId).descriptor;
  const anchor = origin.sourceEventId === undefined ? undefined : store.findEvent(origin.sourceEventId);
  const nativeBoundaryId = anchor?.payload.type === "message_complete" ? anchor.payload.nativeHistory?.identity?.entryId : undefined;
  if (!anchor || anchor.sessionId !== source.id || anchor.generation !== source.binding.generation || source.deletedAt !== undefined
    || anchor.payload.type !== "message_complete" || anchor.payload.role !== "assistant" || !identity(nativeBoundaryId)
    || store.findVisibleSessionMessageOrigin({ sessionId: source.id, eventId: anchor.id })?.messageId !== origin.sourceMessageId) {
    throw new StoreError("The completed Side Chat source is no longer available for its original history boundary.");
  }
  const anchorProjection = history.events.find(event => event.nativeEntryId === nativeBoundaryId);
  if (!anchorProjection) throw new StoreError("The native Side Chat history does not prove its completed source boundary.");
  const parents = new Map<string, string | undefined>();
  const add = (entryId: string, parentId: string | undefined) => {
    if (!identity(entryId) || parentId !== undefined && !identity(parentId)
      || parents.has(entryId) && parents.get(entryId) !== parentId) throw new StoreError("The native Side Chat parent chain changed.");
    parents.set(entryId, parentId);
  };
  for (const event of history.events) add(event.nativeEntryId, event.nativeParentEntryId);
  for (const entry of history.activeLineage ?? []) add(entry.entryId, entry.parentEntryId);
  // Codex forks a completed turn. Its assistant message may precede other
  // records in that same turn; those records are inherited context as well.
  const turnId = anchorProjection.metadata?.fields["turnId"];
  const ends = typeof turnId === "string" ? history.events.filter(event => event.metadata?.fields["turnId"] === turnId).map(event => event.nativeEntryId) : [nativeBoundaryId];
  const inherited = new Set<string>();
  for (const end of ends) {
    let entry: string | undefined = end;
    const branch = new Set<string>();
    while (entry !== undefined && !inherited.has(entry)) {
      if (!identity(entry) || !parents.has(entry) || branch.has(entry) || inherited.size >= MAX_ENTRIES) throw new StoreError("The native Side Chat prefix is incomplete or exceeds its identity boundary.");
      branch.add(entry); inherited.add(entry); entry = parents.get(entry);
    }
    if (entry !== undefined && branch.has(entry)) throw new StoreError("The native Side Chat parent chain contains a cycle.");
  }
  if (!inherited.has(nativeBoundaryId) || [...inherited].reduce((count, id) => count + id.length, 0) > MAX_CHARACTERS) throw new StoreError("The native Side Chat prefix is incomplete or too large.");
  const boundary: SideChatHistoryBoundary = { format: 1, sourceSessionId: source.id, sourceEventId: anchor.id,
    sourceGeneration: anchor.generation, sourceCursor: anchor.globalCursor.toString(), nativeBoundaryId, entryIds: [...inherited] };
  store.setSetting("service", session.id, SIDE_CHAT_HISTORY_BOUNDARY_KEY, boundary);
  return inherited;
}
