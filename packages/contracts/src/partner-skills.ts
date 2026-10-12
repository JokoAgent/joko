import type { MessageInitShape } from "@bufbuild/protobuf";
import type { PartnerSkill, PartnerSkillSummary, PartnerSkillsOwner, ListPartnerSkillsResponse, ReadPartnerSkillResponse,
  UpdatePartnerSkillResponse, DeletePartnerSkillResponse, UpdatePartnerSkillRequestSchema, DeletePartnerSkillRequestSchema } from "./gen/joko/v1/partner_pb.js";

export interface PersonalSkillsOwner { readonly partnerId: string; readonly homeTargetId: string; readonly canonicalSessionId: string; readonly revision: bigint; readonly readOnly: boolean }
export interface PersonalSkillSummary { readonly id: string; readonly slug: string; readonly name: string; readonly description: string; readonly updatedAt: string;
  readonly enabled: boolean; readonly revision: bigint; readonly contentRevision: string }
export interface PersonalSkillDraft { readonly name: string; readonly description: string; readonly body: string }
export interface PersonalSkillDetail extends PersonalSkillDraft { readonly owner: PersonalSkillsOwner; readonly summary: PersonalSkillSummary; readonly readOnly: boolean; readonly bodyBytes: bigint }
export interface PersonalSkillsPage { readonly owner: PersonalSkillsOwner; readonly skills: readonly PersonalSkillSummary[]; readonly total: number; readonly nextOffset?: number }
export interface PartnerSkillsApi {
  readonly ownerKey: string;
  list(query: string, offset: number, signal: AbortSignal): Promise<PersonalSkillsPage>;
  read(id: string, signal: AbortSignal): Promise<PersonalSkillDetail | undefined>;
  save(base: PersonalSkillDetail, draft: PersonalSkillDraft, signal: AbortSignal): Promise<PersonalSkillDetail>;
  remove(base: PersonalSkillDetail, signal: AbortSignal): Promise<void>;
}
interface Rpc {
  listPartnerSkills(request: { partnerId: string; query: string; offset: number; limit: number }, options: { signal: AbortSignal }): Promise<ListPartnerSkillsResponse>;
  readPartnerSkill(request: { partnerId: string; skillId: string }, options: { signal: AbortSignal }): Promise<ReadPartnerSkillResponse>;
  updatePartnerSkill(request: MessageInitShape<typeof UpdatePartnerSkillRequestSchema>, options: { signal: AbortSignal }): Promise<UpdatePartnerSkillResponse>;
  deletePartnerSkill(request: MessageInitShape<typeof DeletePartnerSkillRequestSchema>, options: { signal: AbortSignal }): Promise<DeletePartnerSkillResponse>;
}
const revision = (value: bigint | undefined) => value !== undefined && value >= 1n;
function owner(value: PartnerSkillsOwner | undefined, partnerId: string): PersonalSkillsOwner {
  if (!value || value.partnerId !== partnerId || !value.homeTargetId || !value.canonicalSessionId || !revision(value.revision?.value)) throw new Error("Invalid skill owner.");
  return { partnerId, homeTargetId: value.homeTargetId, canonicalSessionId: value.canonicalSessionId, revision: value.revision!.value, readOnly: value.readOnly };
}
function summary(value: PartnerSkillSummary): PersonalSkillSummary {
  if (!value.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.slug) || !value.name || value.name.length > 64 || value.description.length > 280
    || !revision(value.revision?.value) || !/^sha256:[a-f0-9]{64}$/u.test(value.contentRevision)) throw new Error("Invalid skill summary.");
  return { id: value.id, slug: value.slug, name: value.name, description: value.description, updatedAt: value.updatedAt,
    enabled: value.enabled, revision: value.revision!.value, contentRevision: value.contentRevision };
}
function detail(value: PartnerSkill | undefined, current: PersonalSkillsOwner, id: string): PersonalSkillDetail {
  if (!value?.summary || value.summary.id !== id || value.bodyBytes < 0n || value.body.length > 55_000) throw new Error("Invalid skill detail.");
  const entry = summary(value.summary);
  return { owner: current, summary: entry, name: entry.name, description: entry.description, body: value.body,
    bodyBytes: value.bodyBytes, readOnly: value.readOnly || current.readOnly };
}
export function createPartnerSkillsApi({ rpc, partnerId, ownerKey, assertCurrent }: {
  readonly rpc: Rpc; readonly partnerId: string; readonly ownerKey: string; readonly assertCurrent: (signal: AbortSignal) => void;
}): PartnerSkillsApi {
  return { ownerKey,
    list: async (query, offset, signal) => {
      assertCurrent(signal); const result = await rpc.listPartnerSkills({ partnerId, query, offset, limit: 20 }, { signal }); assertCurrent(signal);
      const entries = result.skills.map(summary);
      if (new Set(entries.map(item => item.id)).size !== entries.length || result.total < entries.length
        || result.nextOffset !== undefined && (result.nextOffset <= offset || result.nextOffset >= result.total)) throw new Error("Invalid skill page.");
      return { owner: owner(result.owner, partnerId), skills: entries, total: result.total, ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }) };
    },
    read: async (id, signal) => {
      assertCurrent(signal);
      try { const result = await rpc.readPartnerSkill({ partnerId, skillId: id }, { signal }); assertCurrent(signal); return detail(result.skill, owner(result.owner, partnerId), id); }
      catch (error) { assertCurrent(signal); if (error && typeof error === "object" && "code" in error && error.code === 5) return undefined; throw error; }
    },
    save: async (base, draft, signal) => {
      assertCurrent(signal); if (base.owner.partnerId !== partnerId || base.readOnly) throw new Error("Skill owner changed.");
      const result = await rpc.updatePartnerSkill({ partnerId, skillId: base.summary.id, expectedPartnerRevision: { value: base.owner.revision },
        expectedRevision: { value: base.summary.revision }, expectedContentRevision: base.summary.contentRevision, ...draft }, { signal });
      assertCurrent(signal); return detail(result.skill, owner(result.owner, partnerId), base.summary.id);
    },
    remove: async (base, signal) => {
      assertCurrent(signal); if (base.owner.partnerId !== partnerId || base.readOnly) throw new Error("Skill owner changed.");
      const result = await rpc.deletePartnerSkill({ partnerId, skillId: base.summary.id, expectedPartnerRevision: { value: base.owner.revision },
        expectedRevision: { value: base.summary.revision }, expectedContentRevision: base.summary.contentRevision }, { signal });
      assertCurrent(signal); owner(result.owner, partnerId); if (result.skillId !== base.summary.id) throw new Error("Invalid skill deletion acknowledgement.");
    }
  };
}
const draftOf = (value: PersonalSkillDraft): PersonalSkillDraft => ({ name: value.name.replace(/[\r\n]+/gu, " ").trim(),
  description: value.description.replace(/[\r\n]+/gu, " ").trim(), body: value.body.replace(/\r\n/gu, "\n").trim() });
const same = (a: PersonalSkillDraft, b: PersonalSkillDraft) => {
  const first = draftOf(a), second = draftOf(b); return first.name === second.name && first.description === second.description && first.body === second.body;
};
const acknowledged = (value: PersonalSkillDetail, draft: PersonalSkillDraft) => same(value, draft)
  || value.readOnly && value.name === draft.name.trim() && value.description === draft.description.trim()
    && value.bodyBytes === BigInt(new TextEncoder().encode(draft.body.trim()).byteLength)
    && value.body === `${draft.body.trim().slice(0, 12_000).replace(/[\uD800-\uDBFF]$/u, "")}${draft.body.trim().length > 12_000 ? "\n…" : ""}`;
const changed = (a: PersonalSkillDetail, b: PersonalSkillDetail) => a.summary.id !== b.summary.id || a.owner.revision !== b.owner.revision
  || a.summary.revision !== b.summary.revision || a.summary.contentRevision !== b.summary.contentRevision || a.readOnly !== b.readOnly || !same(a, b);
export interface PartnerSkillsState { readonly busy: boolean; readonly view: "list" | "detail" | "edit"; readonly query: string;
  readonly page?: PersonalSkillsPage; readonly detail?: PersonalSkillDetail; readonly draft?: PersonalSkillDraft; readonly latest?: PersonalSkillDetail;
  readonly error?: "failed" | "changed" | "unknown" | "suspended" | "missing"; readonly requiresRefresh?: boolean; readonly saved?: boolean }
/** One Native draft retains the exact Owner and never repeats an ambiguous file write. */
export class PartnerSkillsEditor {
  #state: PartnerSkillsState = { busy: false, view: "list", query: "" }; #listeners = new Set<() => void>(); #request?: AbortController;
  #active = true; #disposed = false; #submitted?: { readonly base: PersonalSkillDetail; readonly draft?: PersonalSkillDraft };
  constructor(readonly api: PartnerSkillsApi, readonly initial: Pick<PersonalSkillsOwner, "partnerId" | "homeTargetId" | "canonicalSessionId">) {}
  get state() { return this.#state; }
  get dirty() { return !!this.state.detail && !!this.state.draft && !same(this.state.detail, this.state.draft); }
  get editable() { return this.#active && !this.#disposed && !this.state.busy && !!this.state.detail && !this.state.detail.readOnly && !this.state.latest && !this.state.requiresRefresh; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #set(patch: Partial<PartnerSkillsState>) { this.#state = { ...this.state, ...patch }; for (const listener of this.#listeners) listener(); }
  #owner(value: PersonalSkillsOwner) { if (value.partnerId !== this.initial.partnerId || value.homeTargetId !== this.initial.homeTargetId || value.canonicalSessionId !== this.initial.canonicalSessionId) throw new Error("Personal skill owner changed."); }
  #begin() { this.#request?.abort(); const request = new AbortController(); this.#request = request; this.#set({ busy: true, saved: false }); return request; }
  #current(request: AbortController) { return !this.#disposed && this.#active && this.#request === request && !request.signal.aborted; }
  query(value: string) { if (!this.state.busy) this.#set({ query: value.slice(0, 1_024), page: undefined }); }
  async refresh(more = false): Promise<void> {
    if (!this.#active || this.#disposed || this.state.busy) return;
    if (this.state.view !== "list" && this.state.detail) { await this.#read(this.state.detail.summary.id, true); return; }
    const offset = more ? this.state.page?.nextOffset : 0; if (offset === undefined) return;
    const request = this.#begin();
    try {
      const page = await this.api.list(this.state.query, offset, request.signal); if (!this.#current(request)) return; this.#owner(page.owner);
      const prior = more ? this.state.page?.skills ?? [] : [];
      if (more && this.state.page?.owner.revision !== page.owner.revision) throw new Error("Skill catalog owner changed.");
      this.#set({ page: { ...page, skills: [...new Map([...prior, ...page.skills].map(item => [item.id, item])).values()] }, error: undefined, requiresRefresh: false });
    } catch { if (this.#current(request)) this.#set({ error: "failed", requiresRefresh: true }); }
    finally { if (this.#current(request)) this.#set({ busy: false }); }
  }
  async #read(id: string, reconcile = false): Promise<void> {
    if (!this.#active || this.#disposed || this.state.busy) return;
    const request = this.#begin();
    try {
      const value = await this.api.read(id, request.signal); if (!this.#current(request)) return;
      if (!value) {
        if (this.#submitted && !this.#submitted.draft) { this.#submitted = undefined; this.#set({ view: "list", detail: undefined, draft: undefined, latest: undefined, error: undefined, requiresRefresh: false, saved: true }); }
        else this.#set({ error: "missing", requiresRefresh: true });
        return;
      }
      this.#owner(value.owner);
      if (this.#submitted?.draft && same(value, this.#submitted.draft)) {
        this.#submitted = undefined; this.#set({ detail: value, draft: draftOf(value), latest: undefined, error: undefined, requiresRefresh: false, saved: true });
      } else if (reconcile && this.dirty && this.state.detail && changed(this.state.detail, value)) {
        this.#submitted = undefined; this.#set({ latest: value, error: "changed", requiresRefresh: false });
      } else {
        this.#submitted = undefined; this.#set({ detail: value, draft: reconcile && this.state.view === "edit" ? this.state.draft ?? draftOf(value) : undefined,
          ...(reconcile ? {} : { view: "detail" as const }), latest: undefined, error: undefined, requiresRefresh: false });
      }
    } catch { if (this.#current(request)) this.#set({ error: this.#submitted ? "unknown" : "failed", requiresRefresh: true }); }
    finally { if (this.#current(request)) this.#set({ busy: false }); }
  }
  open(id: string) { return this.#read(id); }
  edit() { if (this.editable && this.state.detail) this.#set({ view: "edit", draft: draftOf(this.state.detail), saved: false }); }
  change(patch: Partial<PersonalSkillDraft>) { if (this.editable && this.state.draft) this.#set({ draft: { ...this.state.draft, ...patch }, error: undefined, saved: false }); }
  useLatest() { if (!this.state.busy && this.state.latest) { const value = this.state.latest; this.#set({ detail: value,
    draft: value.readOnly ? undefined : draftOf(value), ...(value.readOnly ? { view: "detail" as const } : {}), latest: undefined, error: undefined, requiresRefresh: false }); } }
  keepMine() { if (this.#active && !this.state.busy && this.state.latest) this.#set({ detail: this.state.latest, latest: undefined, error: undefined, requiresRefresh: false }); }
  back() { if (this.state.busy || this.dirty || this.state.error === "unknown") return false;
    this.#set({ view: "list", detail: undefined, draft: undefined, latest: undefined, error: undefined }); return true; }
  discard() { if (!this.state.busy) { this.#submitted = undefined; this.#set({ draft: undefined, latest: undefined, view: "detail", error: undefined, requiresRefresh: false }); } }
  async save(): Promise<boolean> {
    if (!this.dirty) return !this.state.busy && !this.state.requiresRefresh;
    if (!this.editable || !this.state.detail || !this.state.draft) return false;
    const base = this.state.detail, draft = draftOf(this.state.draft);
    if (!draft.name.trim() || draft.name.length > 64 || !draft.description.trim() || draft.description.length > 280 || !draft.body.trim() || draft.body.length > 55_000) { this.#set({ error: "failed" }); return false; }
    return this.#mutate(base, draft);
  }
  remove(): Promise<boolean> { return this.editable && this.state.detail && !this.dirty ? this.#mutate(this.state.detail) : Promise.resolve(false); }
  async #mutate(base: PersonalSkillDetail, draft?: PersonalSkillDraft): Promise<boolean> {
    const request = this.#begin();
    try {
      const latest = await this.api.read(base.summary.id, request.signal); if (!this.#current(request)) return false;
      if (!latest) { this.#set({ error: "missing", requiresRefresh: true }); return false; }
      this.#owner(latest.owner); if (changed(base, latest) || latest.readOnly) { this.#set({ latest, error: "changed" }); return false; }
      this.#submitted = { base, ...(draft ? { draft } : {}) };
      if (draft) {
        const result = await this.api.save(base, draft, request.signal); if (!this.#current(request)) return false; this.#owner(result.owner);
        if (!acknowledged(result, draft)) throw new Error("Skill save acknowledgement changed.");
        this.#submitted = undefined; this.#set({ detail: result, draft: result.readOnly ? undefined : draftOf(result),
          ...(result.readOnly ? { view: "detail" as const } : {}), error: undefined, saved: true, requiresRefresh: false });
      } else {
        await this.api.remove(base, request.signal); if (!this.#current(request)) return false;
        this.#submitted = undefined; this.#set({ view: "list", detail: undefined, draft: undefined, error: undefined, saved: true, requiresRefresh: false,
          page: this.state.page ? { ...this.state.page, skills: this.state.page.skills.filter(item => item.id !== base.summary.id) } : undefined });
      }
      return true;
    } catch (error) {
      if (!this.#current(request)) return false;
      if (error && typeof error === "object" && "code" in error && error.code === 3) {
        this.#submitted = undefined; this.#set({ error: "failed", requiresRefresh: false }); return false;
      }
      if (this.#submitted) {
        try {
          const value = await this.api.read(base.summary.id, request.signal); if (!this.#current(request)) return false;
          if (value) this.#owner(value.owner);
          if (draft && value && same(value, draft) || !draft && !value) {
            this.#submitted = undefined; this.#set({ ...(value ? { detail: value, draft: draftOf(value) } : { view: "list" as const, detail: undefined, draft: undefined }),
              error: undefined, requiresRefresh: false, saved: true }); return true;
          }
          this.#submitted = undefined; this.#set({ latest: value, error: value ? "changed" : "missing", requiresRefresh: !value });
        } catch { if (this.#current(request)) this.#set({ error: "unknown", requiresRefresh: true }); }
      } else this.#set({ error: "failed", requiresRefresh: true });
      return false;
    } finally { if (this.#current(request)) this.#set({ busy: false }); }
  }
  suspend() { this.#active = false; this.#request?.abort(); this.#set({ busy: false, requiresRefresh: true, error: this.#submitted ? "unknown" : "suspended" }); }
  activate() { if (!this.#disposed) this.#active = true; }
  dispose() { this.#disposed = true; this.#active = false; this.#request?.abort(); this.#listeners.clear(); }
}
