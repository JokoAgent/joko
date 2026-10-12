import type { MessageInitShape } from "@bufbuild/protobuf";
import { PartnerConnectionKind, PartnerConnectionMode, type PartnerConnections,
  type GetPartnerConnectionsResponse, type UpdatePartnerConnectionsResponse, type UpdatePartnerConnectionsRequestSchema } from "./gen/joko/v1/partner_pb.js";

export type ConnectionKind = "mcp" | "toolsets" | "skills";
export interface ConnectionSelectionDraft { readonly mode: "inherit" | "allowlist"; readonly ids: readonly string[] }
export interface ConnectionsDraft { readonly mcp: ConnectionSelectionDraft; readonly toolsets: ConnectionSelectionDraft; readonly skills: ConnectionSelectionDraft }
export interface ConnectionsOwner { readonly partnerId: string; readonly homeTargetId: string; readonly canonicalSessionId: string; readonly revision: bigint; readonly readOnly: boolean }
export interface ConnectionEntry { readonly kind: ConnectionKind; readonly id: string; readonly name: string; readonly available: boolean; readonly inherited: boolean; readonly personal?: boolean; readonly description?: string }
export interface ConnectionsDetail extends ConnectionsDraft { readonly owner: ConnectionsOwner; readonly revision?: bigint; readonly catalogRevision: string; readonly entries: readonly ConnectionEntry[] }
export interface PartnerConnectionsApi { readonly ownerKey: string; read(signal: AbortSignal): Promise<ConnectionsDetail>; save(base: ConnectionsDetail, draft: ConnectionsDraft, signal: AbortSignal): Promise<ConnectionsDetail> }
interface ConnectionsRpc {
  getPartnerConnections(request: { partnerId: string }, options: { signal: AbortSignal }): Promise<GetPartnerConnectionsResponse>;
  updatePartnerConnections(request: MessageInitShape<typeof UpdatePartnerConnectionsRequestSchema>, options: { signal: AbortSignal }): Promise<UpdatePartnerConnectionsResponse>;
}
const identity = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const selection = (value: PartnerConnections["mcp"], explicit = false): ConnectionSelectionDraft => {
  if (!value || value.mode !== PartnerConnectionMode.INHERIT && value.mode !== PartnerConnectionMode.ALLOWLIST
    || value.ids.some(id => !identity(id)) || new Set(value.ids).size !== value.ids.length
    || value.mode === PartnerConnectionMode.INHERIT && (explicit || value.ids.length > 0)) throw new Error("Invalid connection selection.");
  return { mode: value.mode === PartnerConnectionMode.INHERIT ? "inherit" : "allowlist", ids: [...value.ids].sort() };
};
function detail(value: PartnerConnections | undefined, partnerId: string): ConnectionsDetail {
  const owner = value?.owner;
  if (!value || !owner || owner.partnerId !== partnerId || !identity(owner.partnerId) || !identity(owner.homeTargetId)
    || !identity(owner.canonicalSessionId) || !owner.revision || owner.revision.value < 1n || value.revision && value.revision.value < 1n
    || !/^[0-9a-f]{64}$/u.test(value.catalogRevision)) throw new Error("Invalid connection owner.");
  const seen = new Set<string>();
  const entries = value.entries.map((entry): ConnectionEntry => {
    const kind = entry.kind === PartnerConnectionKind.MCP ? "mcp" : entry.kind === PartnerConnectionKind.TOOLSET ? "toolsets" : entry.kind === PartnerConnectionKind.SKILL ? "skills" : undefined;
    const key = `${kind}:${entry.id}`;
    if (!kind || !identity(entry.id) || !entry.name || entry.name.includes("\0") || seen.has(key) || entry.inherited && (!entry.available || kind === "skills")
      || entry.personal && kind !== "skills" || entry.description.includes("\0")) throw new Error("Invalid connection catalog.");
    seen.add(key); return { kind, id: entry.id, name: entry.name, available: entry.available, inherited: entry.inherited, personal: entry.personal, description: entry.description };
  });
  return { owner: { partnerId, homeTargetId: owner.homeTargetId, canonicalSessionId: owner.canonicalSessionId, revision: owner.revision.value, readOnly: owner.readOnly },
    ...(value.revision ? { revision: value.revision.value } : {}), catalogRevision: value.catalogRevision, entries, mcp: selection(value.mcp), toolsets: selection(value.toolsets), skills: selection(value.skills, true) };
}
export function createPartnerConnectionsApi({ rpc, partnerId, ownerKey, assertCurrent }: {
  rpc: ConnectionsRpc; partnerId: string; ownerKey: string; assertCurrent: (signal: AbortSignal) => void;
}): PartnerConnectionsApi {
  const wire = (value: ConnectionSelectionDraft) => ({ mode: value.mode === "inherit" ? PartnerConnectionMode.INHERIT : PartnerConnectionMode.ALLOWLIST, ids: [...value.ids] });
  return { ownerKey, read: async signal => { assertCurrent(signal); const result = await rpc.getPartnerConnections({ partnerId }, { signal }); assertCurrent(signal); return detail(result.connections, partnerId); },
    save: async (base, draft, signal) => { assertCurrent(signal);
      if (base.owner.partnerId !== partnerId) throw new Error("Connection owner changed.");
      const result = await rpc.updatePartnerConnections({ partnerId, expectedPartnerRevision: { value: base.owner.revision },
        ...(base.revision ? { expectedRevision: { value: base.revision } } : {}), expectedCatalogRevision: base.catalogRevision, mcp: wire(draft.mcp), toolsets: wire(draft.toolsets), skills: wire(draft.skills) }, { signal });
      assertCurrent(signal); return detail(result.connections, partnerId); } };
}
const draftOf = (value: ConnectionsDraft): ConnectionsDraft => ({ mcp: { mode: value.mcp.mode, ids: [...value.mcp.ids].sort() }, toolsets: { mode: value.toolsets.mode, ids: [...value.toolsets.ids].sort() }, skills: { mode: value.skills.mode, ids: [...value.skills.ids].sort() } });
const same = (a: ConnectionsDraft, b: ConnectionsDraft) => JSON.stringify(draftOf(a)) === JSON.stringify(draftOf(b));
export interface ConnectionsState { readonly busy: boolean; readonly detail?: ConnectionsDetail; readonly draft?: ConnectionsDraft; readonly latest?: ConnectionsDetail;
  readonly query: string; readonly error?: "failed" | "changed" | "unknown" | "suspended"; readonly saved?: boolean; readonly requiresRefresh?: boolean }
/** One in-process draft owner is shared by Desktop and Native; ambiguous writes are read back. */
export class PartnerConnectionsEditor {
  #state: ConnectionsState = { busy: false, query: "" }; #listeners = new Set<() => void>(); #request?: AbortController;
  #active = true; #disposed = false; #submitted?: ConnectionsDraft;
  constructor(readonly api: PartnerConnectionsApi, readonly initial: Pick<ConnectionsOwner, "partnerId" | "homeTargetId" | "canonicalSessionId">) {}
  get state() { return this.#state; }
  get dirty() { return !!this.state.detail && !!this.state.draft && !same(this.state.detail, this.state.draft); }
  get editable() { return this.#active && !this.#disposed && !this.state.busy && !!this.state.detail && !this.state.detail.owner.readOnly && !this.state.latest && !this.state.requiresRefresh; }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  snapshot = () => this.state;
  #set(patch: Partial<ConnectionsState>) { this.#state = { ...this.state, ...patch }; for (const listener of this.#listeners) listener(); }
  #owner(value: ConnectionsDetail) { if (value.owner.partnerId !== this.initial.partnerId || value.owner.homeTargetId !== this.initial.homeTargetId || value.owner.canonicalSessionId !== this.initial.canonicalSessionId) throw new Error("Connection settings owner changed."); }
  #begin() { this.#request?.abort(); const request = new AbortController(); this.#request = request; this.#set({ busy: true, saved: false }); return request; }
  #current(request: AbortController) { return !this.#disposed && this.#active && this.#request === request && !request.signal.aborted; }
  query(value: string) { this.#set({ query: value.slice(0, 200) }); }
  rows(kind: ConnectionKind): readonly ConnectionEntry[] {
    const value = this.state.detail, selected = this.state.draft?.[kind]; if (!value || !selected) return [];
    const rows = value.entries.filter(entry => entry.kind === kind);
    for (const id of selected.ids) if (!rows.some(entry => entry.id === id)) rows.push({ kind, id, name: id, available: false, inherited: false });
    const query = this.state.query.trim().toLocaleLowerCase(); return rows.filter(entry => !query || `${entry.id} ${entry.name} ${entry.description ?? ""}`.toLocaleLowerCase().includes(query));
  }
  selected(entry: ConnectionEntry) { const value = this.state.draft?.[entry.kind]; return entry.personal ? entry.available : value?.mode === "inherit" ? entry.inherited : value?.ids.includes(entry.id) === true; }
  toggle(entry: ConnectionEntry, enabled: boolean) {
    if (!this.editable || !this.state.draft || !this.state.detail || entry.personal || enabled && !entry.available) return;
    const current = this.state.draft[entry.kind];
    const ids = new Set(current.mode === "inherit" ? this.state.detail.entries.filter(item => item.kind === entry.kind && item.inherited).map(item => item.id) : current.ids);
    if (enabled) ids.add(entry.id); else ids.delete(entry.id);
    this.#set({ draft: { ...this.state.draft, [entry.kind]: { mode: "allowlist", ids: [...ids].sort() } }, error: undefined, saved: false });
  }
  inherit(kind: ConnectionKind) { if (kind !== "skills" && this.editable && this.state.draft) this.#set({ draft: { ...this.state.draft, [kind]: { mode: "inherit", ids: [] } }, error: undefined, saved: false }); }
  customize(kind: ConnectionKind) {
    if (this.editable && this.state.draft && this.state.detail) this.#set({ draft: { ...this.state.draft,
      [kind]: { mode: "allowlist", ids: this.state.detail.entries.filter(entry => entry.kind === kind && entry.inherited).map(entry => entry.id).sort() } }, error: undefined, saved: false });
  }
  async refresh(): Promise<void> {
    if (!this.#active || this.#disposed || this.state.busy) return;
    const request = this.#begin();
    try { const value = await this.api.read(request.signal); if (!this.#current(request)) return; this.#owner(value);
      if (this.#submitted && same(value, this.#submitted)) { this.#submitted = undefined; this.#set({ detail: value, draft: draftOf(value), latest: undefined, error: undefined, requiresRefresh: false, saved: true }); }
      else if (this.dirty) { this.#submitted = undefined; this.#set({ latest: value, error: "changed", requiresRefresh: false }); }
      else { this.#submitted = undefined; this.#set({ detail: value, draft: draftOf(value), latest: undefined, error: undefined, requiresRefresh: false }); }
    } catch { if (this.#current(request)) this.#set({ error: this.#submitted ? "unknown" : "failed", requiresRefresh: true }); }
    finally { if (this.#current(request)) this.#set({ busy: false }); }
  }
  useLatest() { if (!this.state.busy && this.state.latest) { const value = this.state.latest; this.#submitted = undefined; this.#set({ detail: value, draft: draftOf(value), latest: undefined, error: undefined, requiresRefresh: false }); } }
  keepMine() { if (this.#active && !this.state.busy && this.state.latest) { const value = this.state.latest; this.#submitted = undefined; this.#set({ detail: value, latest: undefined, error: undefined, requiresRefresh: false }); } }
  async save(): Promise<boolean> {
    if (!this.dirty) return !this.state.busy && !this.state.requiresRefresh;
    if (!this.editable || !this.state.detail || !this.state.draft) return false;
    const base = this.state.detail, draft = draftOf(this.state.draft), request = this.#begin();
    try { const latest = await this.api.read(request.signal); if (!this.#current(request)) return false; this.#owner(latest);
      if (latest.owner.readOnly || latest.owner.revision !== base.owner.revision || latest.revision !== base.revision || latest.catalogRevision !== base.catalogRevision || !same(base, latest)) {
        this.#set({ latest, error: "changed" }); return false;
      }
      this.#submitted = draft;
      const result = await this.api.save(base, draft, request.signal); if (!this.#current(request)) return false; this.#owner(result);
      if (!same(result, draft)) throw new Error("Connection save acknowledgement changed.");
      this.#submitted = undefined; this.#set({ detail: result, draft: draftOf(result), latest: undefined, error: undefined, requiresRefresh: false, saved: true }); return true;
    } catch { if (!this.#current(request)) return false;
      if (this.#submitted) {
        try { const value = await this.api.read(request.signal); if (!this.#current(request)) return false; this.#owner(value);
          if (same(value, this.#submitted)) { this.#submitted = undefined; this.#set({ detail: value, draft: draftOf(value), error: undefined, requiresRefresh: false, saved: true }); return true; }
          this.#submitted = undefined; this.#set({ latest: value, error: "changed" });
        } catch { if (this.#current(request)) this.#set({ error: "unknown", requiresRefresh: true }); }
      } else this.#set({ error: "failed", requiresRefresh: true });
      return false;
    } finally { if (this.#current(request)) this.#set({ busy: false }); }
  }
  suspend() { this.#active = false; this.#request?.abort(); this.#set({ busy: false, requiresRefresh: true, error: this.#submitted ? "unknown" : "suspended" }); }
  activate() { if (!this.#disposed) this.#active = true; }
  dispose() { this.#disposed = true; this.#active = false; this.#request?.abort(); this.#listeners.clear(); }
}
