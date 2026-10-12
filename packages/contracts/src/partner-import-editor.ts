import { PartnerImportStatus, PartnerImportCategory, type PartnerImportResult, type PartnerImportSource } from "./gen/joko/v1/partner_import_pb.js";
import { defaultImportSelection, importSelectionInput, toggleImportEntry, type PartnerImportApi, type PartnerImportPreview } from "./partner-import.js";

export interface ImportReceiptStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
  exclusive?<T>(key: string, action: () => Promise<T>): Promise<T>;
}
const receiptLanes = new Map<string, Promise<unknown>>();
/** Only an opaque request identity is persisted on controllers; source bodies remain on the service. */
export class PartnerImportReceipts {
  readonly key: string;
  constructor(private readonly storage: ImportReceiptStorage, nodeKey: string) { this.key = `joko.partner-import.v1:${encodeURIComponent(nodeKey)}`; }
  async #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = (receiptLanes.get(this.key) ?? Promise.resolve()).catch(() => {}).then(() => this.storage.exclusive ? this.storage.exclusive(this.key, action) : action());
    receiptLanes.set(this.key, result);
    try { return await result; } finally { if (receiptLanes.get(this.key) === result) receiptLanes.delete(this.key); }
  }
  async read(): Promise<string | undefined> {
    const value = await this.storage.getItem(this.key); if (value === null) return undefined;
    const row: unknown = JSON.parse(value);
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 2
      || (row as { version?: unknown }).version !== 1 || typeof (row as { requestId?: unknown }).requestId !== "string"
      || !/^[A-Za-z0-9_-]{16,100}$/.test((row as { requestId: string }).requestId)) throw new Error("IMPORT_RECEIPT_INVALID");
    return (row as { requestId: string }).requestId;
  }
  async claim(requestId: string): Promise<void> {
    return this.#exclusive(async () => {
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw new Error("IMPORT_RECEIPT_INVALID");
      const previous = await this.read(); if (previous && previous !== requestId) throw new Error("IMPORT_PENDING");
      await this.storage.setItem(this.key, JSON.stringify({ version: 1, requestId }));
      if (await this.read() !== requestId) throw new Error("IMPORT_RECEIPT_INVALID");
    });
  }
  async release(requestId: string): Promise<void> { return this.#exclusive(async () => { if (await this.read() === requestId) await this.storage.removeItem(this.key); }); }
}

export interface PartnerImportEditorState {
  readonly sources?: readonly PartnerImportSource[]; readonly preview?: PartnerImportPreview;
  readonly selected: ReadonlySet<string>; readonly name: string; readonly avatarImageBase64?: string;
  readonly takeover: boolean; readonly busy: boolean; readonly hydrated: boolean; readonly pendingId?: string;
  readonly result?: PartnerImportResult; readonly absent: boolean; readonly error?: string;
  readonly category?: PartnerImportCategory; readonly query: string; readonly page: number; readonly detailPage: number;
}
/** All clients use this exact same intent, recovery and selection state machine. */
export class PartnerImportEditor {
  #state: PartnerImportEditorState = { selected: new Set(), name: "", takeover: true, busy: false, hydrated: false, absent: false, query: "", page: 0, detailPage: 0 };
  #listeners = new Set<() => void>(); #request?: AbortController; #disposed = false;
  #intent?: ReturnType<typeof importSelectionInput>;
  constructor(readonly api: PartnerImportApi, private readonly receipts: PartnerImportReceipts) {}
  get state(): PartnerImportEditorState { return this.#state; }
  get active(): boolean { return !this.#disposed; }
  get locked(): boolean { return this.#disposed || this.state.busy || !!this.state.pendingId || !this.state.hydrated; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  snapshot = (): PartnerImportEditorState => this.#state;
  #set(patch: Partial<PartnerImportEditorState>): void { if (this.#disposed) return; this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener(); }
  #current(signal: AbortSignal): void { signal.throwIfAborted(); if (this.#disposed) throw new Error("IMPORT_OWNER_CHANGED"); }
  suspend(): void { this.#request?.abort(); this.#request = undefined; this.#set({ busy: false }); }
  dispose(): void { this.suspend(); this.#disposed = true; this.#listeners.clear(); }
  async #perform(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#disposed || this.state.busy) return;
    const request = new AbortController(); this.#request = request; this.#set({ busy: true, error: undefined });
    try { await action(request.signal); }
    catch (error) { if (!request.signal.aborted && !this.#disposed) {
      const code = error instanceof Error ? error.message.match(/\b[A-Z][A-Z_]{3,90}\b/)?.[0] : undefined;
      this.#set({ error: code ?? "IMPORT_FAILED" });
    } }
    finally { if (this.#request === request) { this.#request = undefined; this.#set({ busy: false }); } }
  }
  async load(): Promise<void> {
    await this.#perform(async signal => {
      const pendingId = await this.receipts.read(); this.#current(signal); this.#set({ pendingId, hydrated: true });
      if (pendingId) await this.#observe(pendingId, signal);
      else { const sources = await this.api.sources(signal); this.#current(signal); this.#set({ sources }); }
    });
  }
  async choose(sourceId: string): Promise<void> {
    if (this.locked) return;
    await this.#perform(async signal => {
      const preview = await this.api.preview(sourceId, signal); this.#current(signal);
      this.#set({ preview, name: preview.name, avatarImageBase64: preview.avatarImageBase64,
        selected: defaultImportSelection(preview.entries), category: undefined, query: "", page: 0, result: undefined });
    });
  }
  edit(patch: Partial<Pick<PartnerImportEditorState, "name" | "avatarImageBase64" | "takeover">>): void { if (!this.locked) this.#set(patch); }
  select(ids: readonly string[], enabled: boolean): void {
    if (this.locked || !this.state.preview) return;
    let selected = this.state.selected;
    for (const id of ids) selected = toggleImportEntry(this.state.preview.entries, selected, id, enabled);
    this.#set({ selected });
  }
  filter(category?: PartnerImportCategory, query = ""): void { this.#set({ category, query, page: 0 }); }
  page(page: number, details = false): void { if (Number.isSafeInteger(page) && page >= 0) this.#set(details ? { detailPage: page } : { page }); }
  async start(): Promise<void> {
    if (!this.state.preview || this.state.busy || !this.state.hydrated) return;
    await this.#perform(async signal => {
      this.#intent ??= importSelectionInput(this.state.preview!, this.state.selected, {
        requestId: this.api.newRequestId(), name: this.state.name.trim(), avatarImageBase64: this.state.avatarImageBase64,
        takeover: this.state.takeover, deferSetup: true });
      const requestId = this.#intent.requestId;
      this.#set({ pendingId: requestId, absent: false });
      try { await this.receipts.claim(requestId); } catch (error) {
        this.#current(signal);
        if (error instanceof Error && error.message === "IMPORT_PENDING") {
          const existing = await this.receipts.read(); this.#current(signal); this.#intent = undefined;
          if (existing) { this.#set({ pendingId: existing }); await this.#observe(existing, signal); }
        }
        throw error;
      }
      this.#current(signal);
      let result = await this.api.status(requestId, signal); this.#current(signal);
      if (!result) result = await this.api.start(this.#intent, signal);
      else if (result.status === PartnerImportStatus.NEEDS_ATTENTION) result = await this.api.retry(requestId, false, signal);
      this.#current(signal); this.#set({ result, detailPage: 0 }); await this.#poll(requestId, signal);
    });
  }
  async refresh(): Promise<void> { if (!this.state.pendingId) return this.load(); await this.#perform(signal => this.#observe(this.state.pendingId!, signal)); }
  async retry(resumeSetup = false): Promise<void> {
    if (!this.state.pendingId || this.state.absent) return;
    await this.#perform(async signal => {
      const result = await this.api.retry(this.state.pendingId!, resumeSetup, signal); this.#current(signal);
      this.#set({ result, detailPage: 0 }); await this.#poll(result.requestId, signal);
    });
  }
  async #observe(requestId: string, signal: AbortSignal): Promise<void> {
    const result = await this.api.status(requestId, signal); this.#current(signal);
    this.#set({ result, absent: !result, detailPage: 0 }); if (result) await this.#poll(requestId, signal);
  }
  async #poll(requestId: string, signal: AbortSignal): Promise<void> {
    while (this.state.result?.status === PartnerImportStatus.RUNNING) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("IMPORT_OWNER_CHANGED")); };
        const timer = setTimeout(done, 1000); signal.addEventListener("abort", abort, { once: true });
      });
      this.#current(signal); const result = await this.api.status(requestId, signal); this.#current(signal);
      if (!result) throw new Error("IMPORT_RECEIPT_MISSING"); this.#set({ result });
    }
  }
  /** Only an authoritative absent receipt or a saved canonical task allows a new intent. */
  async release(): Promise<void> {
    const result = this.state.result;
    if (this.state.busy || !this.state.pendingId || !this.state.absent && !(result?.saved && result.canonicalSessionId)) return;
    await this.#perform(async signal => {
      await this.receipts.release(this.state.pendingId!); this.#current(signal); this.#intent = undefined;
      this.#set({ pendingId: undefined, result: undefined, preview: undefined, selected: new Set(), absent: false });
      const sources = await this.api.sources(signal); this.#current(signal); this.#set({ sources });
    });
  }
}
