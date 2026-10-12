import type { MessageInitShape } from "@bufbuild/protobuf";
import { PartnerMemoryKind, type PartnerMemoryOwner, type PartnerMemorySummary, type PartnerMemoryEntry,
  type ListPartnerMemoriesResponse, type ReadPartnerMemoryResponse, type UpdatePartnerMemoryResponse,
  type DeletePartnerMemoryResponse, type UpdatePartnerMemoryRequestSchema, type DeletePartnerMemoryRequestSchema,
  type PartnerMemoryPreferences, type GetPartnerMemoryPreferencesResponse, type UpdatePartnerMemoryPreferencesResponse,
  type UpdatePartnerMemoryPreferencesRequestSchema } from "./gen/joko/v1/partner_pb.js";

export const PARTNER_MEMORY_KINDS = ["user", "feedback", "project", "reference"] as const;
export type PartnerMemoryType = typeof PARTNER_MEMORY_KINDS[number];
export interface MemoryOwner { readonly partnerId: string; readonly homeTargetId: string; readonly canonicalSessionId: string; readonly revision: bigint; readonly readOnly: boolean; readonly memoryEnabled: boolean; }
export interface MemoryPreferencesDraft { readonly enabled: boolean; readonly userContext: string }
export interface MemoryPreferencesDetail extends MemoryPreferencesDraft { readonly owner: MemoryOwner; readonly revision?: bigint }
export interface MemorySummary { readonly id: string; readonly kind: PartnerMemoryType; readonly title: string; readonly preview: string; readonly updatedAt: number; readonly revision: bigint; }
export interface MemoryDetail extends MemorySummary { readonly owner: MemoryOwner; readonly body: string; }
export interface MemoryCatalog { readonly owner: MemoryOwner; readonly groups: readonly { readonly kind: PartnerMemoryType; readonly count: number; readonly entries: readonly MemorySummary[] }[]; readonly truncated: boolean; }
export interface MemoryDraft { readonly title: string; readonly body: string; }
export interface PartnerMemoryApi {
  readonly ownerKey: string;
  list(query: string, signal: AbortSignal): Promise<MemoryCatalog>;
  read(id: string, signal: AbortSignal): Promise<{ readonly owner: MemoryOwner; readonly entry?: MemoryDetail }>;
  save(detail: MemoryDetail, draft: MemoryDraft, signal: AbortSignal): Promise<MemoryDetail>;
  remove(detail: MemoryDetail, signal: AbortSignal): Promise<void>;
  preferences(signal: AbortSignal): Promise<MemoryPreferencesDetail>;
  savePreferences(base: MemoryPreferencesDetail, patch: Partial<MemoryPreferencesDraft>, signal: AbortSignal): Promise<MemoryPreferencesDetail>;
}
interface MemoryRpc {
  listPartnerMemories(request: { partnerId: string; query: string }, options: { signal: AbortSignal }): Promise<ListPartnerMemoriesResponse>;
  readPartnerMemory(request: { partnerId: string; entryId: string }, options: { signal: AbortSignal }): Promise<ReadPartnerMemoryResponse>;
  updatePartnerMemory(request: MessageInitShape<typeof UpdatePartnerMemoryRequestSchema>, options: { signal: AbortSignal }): Promise<UpdatePartnerMemoryResponse>;
  deletePartnerMemory(request: MessageInitShape<typeof DeletePartnerMemoryRequestSchema>, options: { signal: AbortSignal }): Promise<DeletePartnerMemoryResponse>;
  getPartnerMemoryPreferences(request: { partnerId: string }, options: { signal: AbortSignal }): Promise<GetPartnerMemoryPreferencesResponse>;
  updatePartnerMemoryPreferences(request: MessageInitShape<typeof UpdatePartnerMemoryPreferencesRequestSchema>, options: { signal: AbortSignal }): Promise<UpdatePartnerMemoryPreferencesResponse>;
}
function identity(value: string): boolean { return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value); }
function owner(value: PartnerMemoryOwner | undefined, partnerId: string): MemoryOwner {
  if (!value || value.partnerId !== partnerId || !identity(value.partnerId) || !identity(value.homeTargetId)
    || !identity(value.canonicalSessionId) || !value.revision || value.revision.value < 1n || typeof value.memoryEnabled !== "boolean") throw new Error("Invalid memory owner.");
  return { partnerId, homeTargetId: value.homeTargetId, canonicalSessionId: value.canonicalSessionId, revision: value.revision.value, readOnly: value.readOnly, memoryEnabled: value.memoryEnabled };
}
function preferences(value: PartnerMemoryPreferences | undefined, partnerId: string): MemoryPreferencesDetail {
  if (!value || value.revision && value.revision.value < 1n || value.userContext.includes("\0")) throw new Error("Invalid memory preferences.");
  const current = owner(value.owner, partnerId);
  if (current.memoryEnabled !== value.enabled) throw new Error("Inconsistent memory preference.");
  return { owner: current, enabled: value.enabled, userContext: value.userContext, ...(value.revision ? { revision: value.revision.value } : {}) };
}
function samePreferences(a: MemoryPreferencesDraft, b: MemoryPreferencesDraft): boolean { return a.enabled === b.enabled && a.userContext === b.userContext; }
export function validMemoryPreferencesDraft(value: MemoryPreferencesDraft): boolean { return typeof value.enabled === "boolean" && value.userContext.length <= 12_000 && !value.userContext.includes("\0"); }
function summary(value: PartnerMemorySummary): MemorySummary {
  const kind = ({ [PartnerMemoryKind.USER]: "user", [PartnerMemoryKind.FEEDBACK]: "feedback",
    [PartnerMemoryKind.PROJECT]: "project", [PartnerMemoryKind.REFERENCE]: "reference" } as const)[value.kind as PartnerMemoryKind.USER];
  const time = value.updatedAt;
  const updatedAt = time ? Number(time.seconds) * 1000 + Math.floor(time.nanos / 1_000_000) : NaN;
  if (!kind || !identity(value.entryId) || !value.title || Array.from(value.title).length > 100
    || Array.from(value.preview).length > 241 || !value.revision || value.revision.value < 1n
    || !Number.isSafeInteger(updatedAt) || updatedAt < 0 || !time || time.nanos < 0 || time.nanos >= 1_000_000_000) throw new Error("Invalid memory entry.");
  return { id: value.entryId, kind, title: value.title, preview: value.preview, revision: value.revision.value, updatedAt };
}
function detail(value: PartnerMemoryEntry | undefined, current: MemoryOwner, id: string): MemoryDetail {
  if (!value?.summary || !validMemoryDraft({ title: value.summary.title, body: value.body }) || value.summary.entryId !== id) throw new Error("Invalid memory content.");
  return { ...summary(value.summary), owner: current, body: value.body };
}
export function normalizedMemoryDraft(value: MemoryDraft): MemoryDraft { return { title: value.title.replace(/\s+/gu, " ").trim(), body: value.body.trim() }; }
export function validMemoryDraft(value: MemoryDraft): boolean {
  const draft = normalizedMemoryDraft(value);
  return !!draft.title && Array.from(draft.title).length <= 100 && !!draft.body && memoryUtf8Length(draft.body) <= 8192;
}
export function memoryUtf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) { const code = char.codePointAt(0)!; bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return bytes;
}
function same(a: MemoryDraft, b: MemoryDraft): boolean { const x = normalizedMemoryDraft(a); const y = normalizedMemoryDraft(b); return x.title === y.title && x.body === y.body; }
export function createPartnerMemoryApi(input: { readonly rpc: MemoryRpc; readonly partnerId: string; readonly ownerKey: string; readonly assertCurrent: (signal: AbortSignal) => void }): PartnerMemoryApi {
  const invoke = async <T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> => { signal.throwIfAborted(); input.assertCurrent(signal); const value = await call(); signal.throwIfAborted(); input.assertCurrent(signal); return value; };
  const request = (entry: MemoryDetail) => ({ partnerId: input.partnerId, entryId: entry.id,
    expectedPartnerRevision: { value: entry.owner.revision }, expectedRevision: { value: entry.revision } });
  return { ownerKey: input.ownerKey,
    list: async (query, signal) => {
      const response = await invoke(signal, () => input.rpc.listPartnerMemories({ partnerId: input.partnerId, query }, { signal }));
      const current = owner(response.owner, input.partnerId); const ids = new Set<string>();
      if (response.groups.length !== 4) throw new Error("Invalid memory groups.");
      const groups = response.groups.map((group, index) => {
        const kind = PARTNER_MEMORY_KINDS[index]!;
        if (group.kind !== index + 1 || group.entries.length > 2000 || group.count < group.entries.length) throw new Error("Invalid memory group.");
        const entries = group.entries.map(item => { const entry = summary(item); if (entry.kind !== kind || ids.has(entry.id)) throw new Error("Invalid memory ownership."); ids.add(entry.id); return entry; });
        return { kind, count: group.count, entries };
      });
      if (!response.truncated && groups.some(group => group.count !== group.entries.length)) throw new Error("Unreported memory truncation.");
      return { owner: current, groups, truncated: response.truncated };
    },
    read: async (id, signal) => {
      const response = await invoke(signal, () => input.rpc.readPartnerMemory({ partnerId: input.partnerId, entryId: id }, { signal }));
      const current = owner(response.owner, input.partnerId);
      return { owner: current, ...(response.entry ? { entry: detail(response.entry, current, id) } : {}) };
    },
    save: async (entry, draft, signal) => {
      if (entry.owner.partnerId !== input.partnerId || entry.owner.readOnly || !validMemoryDraft(draft)) throw new Error("Memory is not editable.");
      const normalized = normalizedMemoryDraft(draft);
      const response = await invoke(signal, () => input.rpc.updatePartnerMemory({ ...request(entry), ...normalized }, { signal }));
      const current = owner(response.owner, input.partnerId); const saved = detail(response.entry, current, entry.id);
      if (current.homeTargetId !== entry.owner.homeTargetId || current.canonicalSessionId !== entry.owner.canonicalSessionId
        || current.revision !== entry.owner.revision || saved.kind !== entry.kind
        || saved.revision < entry.revision || !same(saved, normalized)) throw new Error("Memory save was not confirmed.");
      return saved;
    },
    preferences: async signal => preferences((await invoke(signal, () => input.rpc.getPartnerMemoryPreferences({ partnerId: input.partnerId }, { signal }))).preferences, input.partnerId),
    savePreferences: async (base, patch, signal) => {
      if (base.owner.partnerId !== input.partnerId || base.owner.readOnly || patch.userContext !== undefined && !validMemoryPreferencesDraft({ enabled: patch.enabled ?? base.enabled, userContext: patch.userContext })) throw new Error("Memory preferences are not editable.");
      const response = await invoke(signal, () => input.rpc.updatePartnerMemoryPreferences({ partnerId: input.partnerId,
        expectedPartnerRevision: { value: base.owner.revision }, ...(base.revision ? { expectedRevision: { value: base.revision } } : {}), ...patch }, { signal }));
      const result = preferences(response.preferences, input.partnerId);
      if (result.owner.homeTargetId !== base.owner.homeTargetId || result.owner.canonicalSessionId !== base.owner.canonicalSessionId
        || result.owner.revision !== base.owner.revision || patch.enabled !== undefined && result.enabled !== patch.enabled
        || patch.userContext !== undefined && result.userContext !== patch.userContext) throw new Error("Memory preferences save was not confirmed.");
      return result;
    },
    remove: async (entry, signal) => {
      if (entry.owner.partnerId !== input.partnerId || entry.owner.readOnly) throw new Error("Memory is not editable.");
      const response = await invoke(signal, () => input.rpc.deletePartnerMemory(request(entry), { signal }));
      const current = owner(response.owner, input.partnerId);
      if (response.entryId !== entry.id || current.homeTargetId !== entry.owner.homeTargetId
        || current.canonicalSessionId !== entry.owner.canonicalSessionId || current.revision !== entry.owner.revision) throw new Error("Memory deletion was not confirmed.");
    }
  };
}

export interface PartnerMemoryState {
  readonly view: "list" | "detail" | "edit" | "preferences";
  readonly query: string; readonly busy: boolean;
  readonly catalog?: MemoryCatalog; readonly detail?: MemoryDetail; readonly draft?: MemoryDraft; readonly latest?: MemoryDetail;
  readonly selectedId?: string; readonly error?: "failed" | "changed" | "missing" | "unknown" | "invalid" | "suspended";
  readonly receipt?: "saved" | "deleted";
  readonly pending?: "save" | "delete" | "preferences"; readonly requiresRefresh?: boolean;
  readonly preferences?: MemoryPreferencesDetail; readonly preferencesDraft?: MemoryPreferencesDraft; readonly latestPreferences?: MemoryPreferencesDetail;
}
/** The saved-memory page keeps drafts in process and reconciles ambiguous writes by reading. */
export class PartnerMemoryEditor {
  #state: PartnerMemoryState = { view: "list", query: "", busy: false };
  #listeners = new Set<() => void>(); #request?: AbortController; #search?: ReturnType<typeof setTimeout>; #active = true; #disposed = false;
  #submitted?: MemoryDraft;
  #submittedPreferences?: MemoryPreferencesDraft;
  constructor(readonly api: PartnerMemoryApi, readonly initial: Pick<MemoryOwner, "partnerId" | "homeTargetId" | "canonicalSessionId">) {}
  get state(): PartnerMemoryState { return this.#state; }
  get dirty(): boolean { return this.state.view === "preferences" ? !!this.state.preferences && !!this.state.preferencesDraft && !samePreferences(this.state.preferences, this.state.preferencesDraft)
    : !!this.state.draft && !!this.state.detail && !same(this.state.draft, this.state.detail); }
  get writable(): boolean { return this.#active && !this.#disposed && !this.state.busy && !this.state.pending && !this.state.requiresRefresh && !this.state.latest && !this.state.latestPreferences
    && !(this.state.view === "preferences" ? this.state.preferences?.owner.readOnly : this.state.detail?.owner.readOnly ?? this.state.catalog?.owner.readOnly); }
  get editable(): boolean { return this.#active && !this.#disposed && !this.state.requiresRefresh && !this.state.latest && !this.state.detail?.owner.readOnly
    && (!this.state.pending || this.state.pending === "save" && this.state.busy); }
  snapshot = (): PartnerMemoryState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #set(patch: Partial<PartnerMemoryState>): void { if (this.#disposed) return; this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener(); }
  #owner(value: MemoryOwner): void { if (value.partnerId !== this.initial.partnerId || value.homeTargetId !== this.initial.homeTargetId || value.canonicalSessionId !== this.initial.canonicalSessionId || value.revision < 1n) throw new Error("Memory owner changed."); }
  #current(request: AbortController): boolean { return this.#request === request && this.#active && !this.#disposed && !request.signal.aborted; }
  async #run(call: (request: AbortController) => Promise<void>): Promise<void> {
    if (!this.#active || this.#disposed || this.#request) return;
    const request = new AbortController(); this.#request = request; this.#set({ busy: true, receipt: undefined });
    try { await call(request); } catch { if (this.#current(request)) this.#set({ error: this.state.pending ? "unknown" : "failed", requiresRefresh: true }); }
    finally { if (this.#request === request) { this.#request = undefined; if (this.#currentAfter(request)) this.#set({ busy: false }); } }
  }
  #currentAfter(request: AbortController): boolean { return this.#active && !this.#disposed && !request.signal.aborted; }
  async refresh(): Promise<void> {
    if (this.state.view === "preferences" || this.state.pending === "preferences" || this.state.latestPreferences) { await this.checkPreferences(); return; }
    if (this.state.pending || this.state.view !== "list") { await this.check(); return; }
    await this.#run(async request => {
      const catalog = await this.api.list(this.state.query.trim(), request.signal);
      if (!this.#current(request)) return; this.#owner(catalog.owner);
      this.#set({ catalog, error: undefined, requiresRefresh: false });
    });
  }
  search(query: string): void {
    if (this.state.view !== "list" || !this.#active || this.#disposed) return;
    this.#request?.abort(); this.#request = undefined;
    if (this.#search) clearTimeout(this.#search);
    this.#set({ query: query.slice(0, 200), catalog: undefined, error: undefined, busy: false });
    this.#search = setTimeout(() => { this.#search = undefined; void this.refresh(); }, 200);
  }
  async open(id: string): Promise<void> {
    if (this.state.busy || this.dirty || this.state.pending) return;
    this.#set({ view: "detail", selectedId: id, detail: undefined, draft: undefined, latest: undefined, error: undefined });
    await this.check();
  }
  edit(): void { if (!this.state.detail || !this.writable) return; this.#set({ view: "edit", draft: { title: this.state.detail.title, body: this.state.detail.body }, error: undefined, receipt: undefined }); }
  change(patch: Partial<MemoryDraft>): void { if (!this.editable || !this.state.draft) return; this.#set({ draft: { ...this.state.draft, ...patch }, receipt: undefined, error: undefined }); }
  async check(): Promise<void> {
    const id = this.state.selectedId;
    if (!id) { await this.refresh(); return; }
    await this.#run(async request => {
      const response = await this.api.read(id, request.signal);
      if (!this.#current(request)) return; this.#owner(response.owner);
      const next = response.entry;
      if (!next) {
        if (this.state.pending === "delete") { this.#set({ view: "list", selectedId: undefined, detail: undefined, draft: undefined, pending: undefined, requiresRefresh: false, error: undefined, receipt: "deleted", catalog: undefined }); }
        else this.#set({ error: "missing", pending: undefined, requiresRefresh: true });
        return;
      }
      if (this.state.pending === "save" && this.#submitted && same(next, this.#submitted)) {
        const draft = this.state.draft && !same(this.state.draft, this.#submitted) ? this.state.draft : normalizedMemoryDraft(next);
        this.#submitted = undefined;
        this.#set({ detail: next, draft, latest: undefined, pending: undefined, requiresRefresh: false, error: undefined, receipt: same(draft, next) ? "saved" : undefined }); return;
      }
      const changed = !!this.state.detail && next.revision !== this.state.detail.revision;
      if (changed && (this.dirty || this.state.pending === "delete")) this.#set({ latest: next, error: "changed", pending: undefined, requiresRefresh: false });
      else this.#set({ detail: next, latest: undefined, pending: undefined, requiresRefresh: false, error: undefined });
    });
    if (this.state.view === "list" && !this.state.catalog && !this.state.busy) { const receipt = this.state.receipt; await this.refresh(); if (receipt) this.#set({ receipt }); }
  }
  async save(): Promise<boolean> {
    if (this.state.view === "preferences") return this.savePreferences();
    if (!this.dirty) return !this.state.pending && !this.state.requiresRefresh;
    if (!this.writable || !this.state.detail || !this.state.draft) return false;
    await this.#run(async request => {
      while (this.dirty && this.state.detail && this.state.draft) {
        const base = this.state.detail; const draft = normalizedMemoryDraft(this.state.draft);
        if (!validMemoryDraft(draft)) { this.#set({ error: "invalid" }); return; }
        const fresh = await this.api.read(base.id, request.signal);
        if (!this.#current(request)) return; this.#owner(fresh.owner);
        if (!fresh.entry) { this.#set({ error: "missing", requiresRefresh: true }); return; }
        if (fresh.entry.revision !== base.revision) { this.#set({ latest: fresh.entry, error: "changed" }); return; }
        this.#submitted = draft;
        this.#set({ pending: "save", detail: fresh.entry });
        const next = await this.api.save(fresh.entry, draft, request.signal);
        if (!this.#current(request)) return; this.#owner(next.owner);
        const shown = this.state.draft && !same(this.state.draft, draft) ? this.state.draft : normalizedMemoryDraft(next);
        this.#submitted = undefined;
        this.#set({ detail: next, draft: shown, latest: undefined, pending: undefined, error: undefined, requiresRefresh: false, receipt: same(shown, next) ? "saved" : undefined });
      }
    });
    if (this.state.pending && this.#active && !this.state.busy) await this.check();
    return !this.dirty && !this.state.pending && !this.state.requiresRefresh && !this.state.latest;
  }
  useLatest(): void { if (!this.state.latest || this.state.busy) return; const next = this.state.latest; this.#set({ detail: next, draft: { title: next.title, body: next.body }, latest: undefined, error: undefined, receipt: undefined }); }
  async keepMine(): Promise<void> { if (!this.state.latest || this.state.busy || !this.#active) return; this.#set({ detail: this.state.latest, latest: undefined, error: undefined }); await this.save(); }
  async remove(): Promise<void> {
    if (!this.writable || !this.state.detail || this.dirty) return;
    const base = this.state.detail;
    await this.#run(async request => {
      const fresh = await this.api.read(base.id, request.signal);
      if (!this.#current(request)) return; this.#owner(fresh.owner);
      if (!fresh.entry) { this.#set({ error: "missing", requiresRefresh: true }); return; }
      if (fresh.entry.revision !== base.revision) { this.#set({ detail: fresh.entry, error: "changed" }); return; }
      this.#set({ pending: "delete", detail: fresh.entry });
      await this.api.remove(fresh.entry, request.signal);
      if (!this.#current(request)) return;
      this.#set({ view: "list", selectedId: undefined, detail: undefined, draft: undefined, pending: undefined, error: undefined, requiresRefresh: false, catalog: undefined, receipt: "deleted" });
    });
    if (this.state.pending && this.#active && !this.state.busy) await this.check();
    if (this.state.view === "list" && !this.state.catalog && !this.state.busy) { await this.refresh(); this.#set({ receipt: "deleted" }); }
  }
  discard(): void { if (!this.state.busy && !this.state.pending) this.#set({ draft: undefined, latest: undefined, preferencesDraft: undefined, latestPreferences: undefined, view: this.state.view === "preferences" ? "list" : "detail", error: undefined }); }
  async back(): Promise<boolean> {
    if (this.state.busy || this.state.pending) return false;
    if (this.state.view === "preferences") { if (this.dirty && !await this.savePreferences()) return false;
      this.#set({ view: "list", preferencesDraft: undefined, latestPreferences: undefined }); await this.refresh(); return true; }
    if (this.state.view === "edit") { if (this.dirty && !await this.save()) return false; this.#set({ view: "detail", draft: undefined }); return true; }
    this.#set({ view: "list", selectedId: undefined, detail: undefined, draft: undefined, latest: undefined, error: undefined }); await this.refresh(); return true;
  }
  suspend(): void { this.#active = false; this.#request?.abort(); this.#request = undefined; if (this.#search) clearTimeout(this.#search); this.#search = undefined; this.#set({ busy: false, requiresRefresh: true, error: "suspended" }); }
  activate(): void { if (!this.#disposed) this.#active = true; }
  dispose(): void { this.suspend(); this.#disposed = true; this.#listeners.clear(); }
  async openPreferences(): Promise<void> {
    if (this.state.busy || this.state.pending || this.dirty) return;
    this.#set({ view: "preferences", preferences: undefined, preferencesDraft: undefined, latestPreferences: undefined, error: undefined }); await this.checkPreferences();
  }
  changePreferences(patch: Partial<MemoryPreferencesDraft>): void { if (this.writable && this.state.preferencesDraft) this.#set({ preferencesDraft: { ...this.state.preferencesDraft, ...patch }, error: undefined, receipt: undefined }); }
  async checkPreferences(): Promise<void> {
    await this.#run(async request => {
      const next = await this.api.preferences(request.signal); if (!this.#current(request)) return; this.#owner(next.owner);
      if (this.state.pending === "preferences" && this.#submittedPreferences && samePreferences(next, this.#submittedPreferences)) {
        this.#submittedPreferences = undefined; this.#set({ preferences: next, preferencesDraft: { enabled: next.enabled, userContext: next.userContext }, pending: undefined, latestPreferences: undefined, error: undefined, requiresRefresh: false, receipt: "saved" });
      } else if (this.state.preferences && this.state.preferences.revision !== next.revision && (this.dirty || this.state.pending === "preferences")) {
        this.#set({ latestPreferences: next, pending: undefined, error: "changed", requiresRefresh: false });
      } else { const notApplied = this.state.pending === "preferences"; this.#submittedPreferences = undefined;
        this.#set({ preferences: next, ...(this.dirty ? {} : { preferencesDraft: { enabled: next.enabled, userContext: next.userContext } }), pending: undefined, latestPreferences: undefined, error: notApplied ? "failed" : undefined, requiresRefresh: false }); }
    });
    if (this.state.view === "list" && !this.state.busy && !this.state.pending && !this.state.requiresRefresh) { await this.refresh(); }
  }
  async #writePreferences(base: MemoryPreferencesDetail, patch: Partial<MemoryPreferencesDraft>): Promise<void> {
    await this.#run(async request => {
      const fresh = await this.api.preferences(request.signal); if (!this.#current(request)) return; this.#owner(fresh.owner);
      if (fresh.revision !== base.revision || !samePreferences(fresh, base)) { this.#set({ latestPreferences: fresh, error: "changed" }); return; }
      this.#submittedPreferences = { enabled: patch.enabled ?? fresh.enabled, userContext: patch.userContext ?? fresh.userContext };
      this.#set({ pending: "preferences", preferences: fresh });
      const next = await this.api.savePreferences(fresh, patch, request.signal); if (!this.#current(request)) return; this.#owner(next.owner);
      this.#submittedPreferences = undefined;
      this.#set({ preferences: next, preferencesDraft: { enabled: next.enabled, userContext: next.userContext }, latestPreferences: undefined, pending: undefined, error: undefined, requiresRefresh: false, receipt: "saved" });
    });
    if (this.state.pending === "preferences" && this.#active && !this.state.busy) await this.checkPreferences();
  }
  async savePreferences(): Promise<boolean> {
    if (!this.dirty) return !this.state.pending && !this.state.requiresRefresh && !this.state.latestPreferences;
    if (!this.writable || !this.state.preferences || !this.state.preferencesDraft) return false;
    const base = this.state.preferences; const draft = this.state.preferencesDraft;
    if (draft.userContext !== base.userContext && !validMemoryPreferencesDraft(draft)) { this.#set({ error: "invalid" }); return false; }
    await this.#writePreferences(base, { ...(draft.enabled !== base.enabled ? { enabled: draft.enabled } : {}),
      ...(draft.userContext !== base.userContext ? { userContext: draft.userContext } : {}) });
    return !this.dirty && !this.state.pending && !this.state.requiresRefresh && !this.state.latestPreferences;
  }
  useLatestPreferences(): void { const next = this.state.latestPreferences; if (next && !this.state.busy) this.#set({ preferences: next, preferencesDraft: { enabled: next.enabled, userContext: next.userContext }, latestPreferences: undefined, error: undefined }); }
  async keepPreferences(): Promise<void> { if (!this.state.latestPreferences || !this.state.preferencesDraft || this.state.busy) return; this.#set({ preferences: this.state.latestPreferences, latestPreferences: undefined, error: undefined }); await this.savePreferences(); }
  async setMemoryEnabled(enabled: boolean): Promise<void> {
    if (!this.writable || this.state.view !== "list") return;
    let base: MemoryPreferencesDetail | undefined;
    await this.#run(async request => { const next = await this.api.preferences(request.signal); if (this.#current(request)) { this.#owner(next.owner); base = next; } });
    if (!base || !this.writable) return;
    await this.#writePreferences(base, { enabled });
    if (!this.state.pending && !this.state.requiresRefresh && !this.state.latestPreferences) await this.refresh();
  }
}
