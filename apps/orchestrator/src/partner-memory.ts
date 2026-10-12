import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { NotFoundError, RevisionConflictError, StoreError, type MakerMemoryEntry, type OperationalStore } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import type { MakerMemoryController } from "./maker-memory.js";
import type { PartnerMemoryPreferences } from "./partner-memory-preferences.js";
import { fromProtoRevision, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";

const kinds = ["user", "feedback", "project", "reference"] as const;
const protoKind = { user: contract.PartnerMemoryKind.USER, feedback: contract.PartnerMemoryKind.FEEDBACK,
  project: contract.PartnerMemoryKind.PROJECT, reference: contract.PartnerMemoryKind.REFERENCE };

function plainText(body: string): string {
  return body.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "").replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim();
}
export function partnerMemoryDescription(body: string): string {
  const text = plainText(body);
  return (/^.+?[。！？!?；;](?=\s|$|[^。！？!?；;])/u.exec(text)?.[0] ?? text)
    .slice(0, 200).replace(/[\uD800-\uDBFF]$/u, "").trim();
}
function summary(entry: MakerMemoryEntry): contract.PartnerMemorySummary {
  if (entry.kind === "digest") throw new ConnectError("Memory not found.", Code.NotFound);
  const text = plainText(entry.body); const chars = Array.from(text);
  return create(contract.PartnerMemorySummarySchema, { entryId: entry.id, kind: protoKind[entry.kind], title: entry.title,
    preview: chars.length > 240 ? `${chars.slice(0, 240).join("")}…` : text,
    revision: toProtoRevision(entry.revision), updatedAt: toProtoTimestamp(entry.updatedAt) });
}

/** Private memory writes share the synchronous SQLite transaction used by agent tools. */
export class PartnerMemoryManager {
  constructor(readonly partners: PartnerManager, readonly store: OperationalStore, readonly memory: MakerMemoryController,
    readonly preferences?: PartnerMemoryPreferences) {}
  owner(partnerId: string, expected?: bigint, writable = false): contract.PartnerMemoryOwner {
    const partner = this.partners.getPartner(partnerId);
    if (partner.lifecycle === "deleted" || partner.initializationState !== "ready" || !partner.canonicalSessionId) {
      throw new ConnectError("Partner memory is unavailable.", Code.FailedPrecondition);
    }
    if (expected !== undefined && partner.revision !== expected) throw new ConnectError("Partner changed.", Code.Aborted);
    const session = this.store.getSession(partner.canonicalSessionId).descriptor;
    const target = this.store.getTarget(partner.homeTargetId).descriptor;
    if (session.targetId !== target.id || target.id !== partner.homeTargetId || session.deletedAt !== undefined) {
      throw new ConnectError("Partner memory owner changed.", Code.FailedPrecondition);
    }
    const readOnly = partner.lifecycle === "archived" || partner.pauseCleanupPending === true
      || this.partners.listPendingRestarts().some(item => item.partnerId === partnerId);
    if (writable && readOnly) throw new ConnectError("Partner memory is read-only.", Code.FailedPrecondition);
    return create(contract.PartnerMemoryOwnerSchema, { partnerId, homeTargetId: target.id,
      canonicalSessionId: session.id, revision: toProtoRevision(partner.revision), readOnly, memoryEnabled: this.memory.targetMemoryEnabled(target.id) });
  }
  entry(owner: contract.PartnerMemoryOwner, entryId: string): MakerMemoryEntry | undefined {
    if (!entryId || entryId.length > 128 || /[\u0000-\u001f\u007f]/u.test(entryId)) throw new ConnectError("Invalid memory identity.", Code.InvalidArgument);
    try {
      const entry = this.store.getMakerMemoryEntry(entryId);
      if (entry.targetId !== owner.homeTargetId || entry.kind === "digest") throw new ConnectError("Memory not found.", Code.NotFound);
      return entry;
    } catch (error) { if (error instanceof NotFoundError) return undefined; throw error; }
  }
  list(partnerId: string, rawQuery: string): contract.ListPartnerMemoriesResponse {
    const owner = this.owner(partnerId);
    if (rawQuery.length > 200 || /[\u0000-\u001f\u007f]/u.test(rawQuery)) throw new ConnectError("Invalid memory search.", Code.InvalidArgument);
    const query = rawQuery.trim();
    const entries = query ? kinds.flatMap(kind => this.store.searchMakerMemory(owner.homeTargetId, query, { kind, limit: 50 }))
      .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, 50)
      .map(hit => this.store.getMakerMemoryEntry(hit.id)) : this.memory.list(owner.homeTargetId)
      .filter(entry => entry.kind !== "digest").sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    let used = 0; let truncated = false;
    const groups = kinds.map(kind => {
      const all = entries.filter(entry => entry.kind === kind);
      const shown: contract.PartnerMemorySummary[] = [];
      for (const entry of all) {
        const item = summary(entry);
        if (used >= 400_000) item.preview = "";
        const size = Buffer.byteLength(JSON.stringify([item.entryId, item.title, item.preview])) + 128;
        if (shown.length >= 2_000 || used + size > 1_000_000) { truncated = true; continue; }
        used += size; shown.push(item);
      }
      return create(contract.PartnerMemoryGroupSchema, { kind: protoKind[kind], count: all.length, entries: shown });
    });
    return create(contract.ListPartnerMemoriesResponseSchema, { owner, groups, truncated });
  }
  read(partnerId: string, entryId: string): contract.ReadPartnerMemoryResponse {
    const owner = this.owner(partnerId); const entry = this.entry(owner, entryId);
    return create(contract.ReadPartnerMemoryResponseSchema, { owner,
      ...(entry ? { entry: { summary: summary(entry), body: entry.body } } : {}) });
  }
  update(request: contract.UpdatePartnerMemoryRequest): contract.UpdatePartnerMemoryResponse {
    const expectedPartner = fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision");
    const expected = fromProtoRevision(request.expectedRevision, "expected_revision");
    const title = request.title.replace(/\s+/gu, " ").trim(); const body = request.body.trim();
    if (!title || Array.from(title).length > 100 || !body || Buffer.byteLength(body) > 8192) {
      throw new ConnectError("Memory requires a title of at most 100 characters and content of at most 8192 UTF-8 bytes.", Code.InvalidArgument);
    }
    let changed = false;
    const result = this.store.transaction(() => {
      const owner = this.owner(request.partnerId, expectedPartner, true);
      const current = this.entry(owner, request.entryId);
      if (!current) throw new ConnectError("Memory not found.", Code.NotFound);
      if (current.revision !== expected) throw new RevisionConflictError("Memory", current.id, expected, current.revision);
      if (current.title === title && current.body === body) return create(contract.UpdatePartnerMemoryResponseSchema,
        { owner, entry: { summary: summary(current), body: current.body } });
      const saved = this.store.putMakerMemoryEntry({ targetId: current.targetId, kind: current.kind, slug: current.slug,
        title, body, description: current.body === body ? current.description : partnerMemoryDescription(body) || title, mode: "update" });
      changed = true;
      return create(contract.UpdatePartnerMemoryResponseSchema, { owner, entry: { summary: summary(saved), body: saved.body } });
    });
    if (changed) this.memory.requestEntriesRefresh();
    return result;
  }
  remove(request: contract.DeletePartnerMemoryRequest): contract.DeletePartnerMemoryResponse {
    const expectedPartner = fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision");
    const expected = fromProtoRevision(request.expectedRevision, "expected_revision");
    const result = this.store.transaction(() => {
      const owner = this.owner(request.partnerId, expectedPartner, true);
      const current = this.entry(owner, request.entryId);
      if (!current) throw new ConnectError("Memory not found.", Code.NotFound);
      if (current.revision !== expected) throw new RevisionConflictError("Memory", current.id, expected, current.revision);
      this.store.deleteMakerMemoryEntry(current.id);
      return create(contract.DeletePartnerMemoryResponseSchema, { owner, entryId: current.id });
    });
    this.memory.requestEntriesRefresh();
    return result;
  }
  async readPreferences(partnerId: string): Promise<contract.GetPartnerMemoryPreferencesResponse> {
    if (!this.preferences) throw new ConnectError("Memory preferences are unavailable.", Code.Unimplemented);
    const owner = this.owner(partnerId); const saved = this.preferences.read(owner.homeTargetId);
    const assertCurrent = () => { this.owner(partnerId, owner.revision!.value); };
    const userContext = saved.userContext ?? await this.preferences.inheritedContext?.(partnerId, assertCurrent) ?? "";
    assertCurrent();
    const current = this.preferences.read(owner.homeTargetId);
    if (current.revision !== saved.revision) throw new ConnectError("Memory preferences changed.", Code.Aborted);
    return create(contract.GetPartnerMemoryPreferencesResponseSchema, { preferences: { owner, enabled: saved.enabled, userContext,
      ...(saved.revision ? { revision: toProtoRevision(saved.revision) } : {}) } });
  }
  async updatePreferences(request: contract.UpdatePartnerMemoryPreferencesRequest): Promise<contract.UpdatePartnerMemoryPreferencesResponse> {
    if (!this.preferences) throw new ConnectError("Memory preferences are unavailable.", Code.Unimplemented);
    const expected = fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision");
    const memoryRevision = request.expectedRevision ? fromProtoRevision(request.expectedRevision, "expected_revision") : undefined;
    this.store.transaction(() => { const owner = this.owner(request.partnerId, expected, true);
      this.preferences!.update(owner.homeTargetId, memoryRevision, { enabled: request.enabled, userContext: request.userContext }); });
    this.memory.requestEntriesRefresh();
    const response = await this.readPreferences(request.partnerId);
    return create(contract.UpdatePartnerMemoryPreferencesResponseSchema, { preferences: response.preferences });
  }
}

type MemoryMethods = Pick<ServiceImpl<typeof contract.PartnerService>, "listPartnerMemories" | "readPartnerMemory" | "updatePartnerMemory" | "deletePartnerMemory" | "getPartnerMemoryPreferences" | "updatePartnerMemoryPreferences">;
export function createPartnerMemoryConnectMethods(manager: PartnerMemoryManager | undefined, authenticate: (context: HandlerContext) => unknown): MemoryMethods {
  const run = <T>(context: HandlerContext, operation: (owner: PartnerMemoryManager) => T): T => {
    authenticate(context); context.signal.throwIfAborted();
    if (!manager) throw new ConnectError("Partner memory is unavailable.", Code.Unimplemented);
    try { return operation(manager); } catch (error) {
      if (error instanceof ConnectError) throw error;
      if (error instanceof RevisionConflictError) throw new ConnectError("Memory changed. Read the latest content before saving.", Code.Aborted);
      if (error instanceof NotFoundError) throw new ConnectError("Partner memory is unavailable.", Code.NotFound);
      if (error instanceof StoreError) throw new ConnectError("Memory content is invalid or unavailable.", Code.InvalidArgument);
      throw new ConnectError("Partner memory could not be read or changed.", Code.Unavailable);
    }
  };
  const asyncRun = async <T>(context: HandlerContext, operation: (owner: PartnerMemoryManager) => Promise<T>): Promise<T> => {
    authenticate(context); context.signal.throwIfAborted(); if (!manager) throw new ConnectError("Partner memory is unavailable.", Code.Unimplemented);
    try { const result = await operation(manager); authenticate(context); context.signal.throwIfAborted(); return result; }
    catch (error) { if (error instanceof ConnectError) throw error;
      if (error instanceof RevisionConflictError) throw new ConnectError("Memory preferences changed.", Code.Aborted);
      if (error instanceof StoreError) throw new ConnectError("Memory preferences are invalid or unavailable.", Code.InvalidArgument);
      throw new ConnectError("Memory preferences could not be read or changed.", Code.Unavailable); }
  };
  return { listPartnerMemories: (request, context) => run(context, owner => owner.list(request.partnerId, request.query)),
    readPartnerMemory: (request, context) => run(context, owner => owner.read(request.partnerId, request.entryId)),
    updatePartnerMemory: (request, context) => run(context, owner => owner.update(request)),
    deletePartnerMemory: (request, context) => run(context, owner => owner.remove(request)),
    getPartnerMemoryPreferences: (request, context) => asyncRun(context, owner => owner.readPreferences(request.partnerId)),
    updatePartnerMemoryPreferences: (request, context) => asyncRun(context, owner => owner.updatePreferences(request)) };
}
