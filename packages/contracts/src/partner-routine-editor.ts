import { create } from "@bufbuild/protobuf";
import { TimestampSchema, type Timestamp } from "@bufbuild/protobuf/wkt";
import { RoutineDefinitionSchema, RoutineTriggerSchema, type RoutineDefinition, type RoutineTrigger,
  type PartnerRoutine, type PartnerRoutineRun, type ListPartnerRoutinesResponse } from "./gen/joko/v1/partner_routine_pb.js";
import { newRoutineDefinition, routineDefinitionKey, type PartnerRoutineApi, type RoutineCreationReceipts } from "./partner-routines.js";

export interface RoutineEditorState {
  readonly catalog?: ListPartnerRoutinesResponse;
  readonly selected?: PartnerRoutine;
  readonly draft?: RoutineDefinition;
  readonly baseline: string;
  readonly runs: readonly PartnerRoutineRun[];
  readonly nextOffset?: number;
  readonly pendingId?: string;
  readonly busy: boolean;
  readonly requiresRefresh: boolean;
  readonly draftConflict?: boolean;
  readonly error?: "failed" | "pending" | "storage";
}

/** Owns one visible editor. Closing/backgrounding retires late results and never replays mutations. */
export class PartnerRoutineEditor {
  #state: RoutineEditorState = { baseline: "", runs: [], busy: false, requiresRefresh: false };
  #listeners = new Set<() => void>();
  #request?: AbortController;
  #observation?: AbortController;
  #disposed = false;
  #draftPartnerRevision?: bigint;
  #retryObservation = false;
  constructor(readonly api: PartnerRoutineApi, private readonly receipts: RoutineCreationReceipts, readonly partnerId: string) {}
  get state(): RoutineEditorState { return this.#state; }
  get dirty(): boolean { return !!this.state.draft && routineDefinitionKey(this.state.draft) !== this.state.baseline; }
  get writable(): boolean { return !!this.state.catalog?.writable && !this.state.busy && !this.state.requiresRefresh && !this.#disposed; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  snapshot = (): RoutineEditorState => this.#state;
  #set(patch: Partial<RoutineEditorState>): void { if (this.#disposed) return; this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener(); }
  suspend(): void { this.#retryObservation = false; this.#observation?.abort(); this.#request?.abort(); this.#request = undefined; this.#set({ busy: false, requiresRefresh: true }); }
  dispose(): void { this.suspend(); this.#disposed = true; this.#listeners.clear(); }
  async #perform(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#disposed || this.state.busy) return;
    this.#retryObservation = false;
    this.#observation?.abort();
    const request = new AbortController(); this.#request = request; this.#set({ busy: true, error: undefined });
    try { await action(request.signal); }
    catch { if (!request.signal.aborted) this.#set({ error: "failed", requiresRefresh: true }); }
    finally { if (this.#request === request) { this.#request = undefined; this.#set({ busy: false }); } }
  }
  #current(signal: AbortSignal): void { signal.throwIfAborted(); if (this.#disposed) throw new Error("Editor closed."); }
  #select(routine?: PartnerRoutine): void {
    const draft = routine?.definition ? create(RoutineDefinitionSchema, routine.definition) : newRoutineDefinition();
    this.#draftPartnerRevision = this.state.catalog?.partnerRevision?.value;
    this.#set({ selected: routine, draft, baseline: routineDefinitionKey(draft), runs: [], nextOffset: undefined, draftConflict: false });
  }
  select(routine?: PartnerRoutine): void { if (!this.state.busy && !this.state.requiresRefresh && !this.dirty) this.#select(routine); }
  discard(): void { if (!this.state.busy) this.#select(this.state.selected); }
  edit(patch: Partial<RoutineDefinition>): void {
    if (!this.writable || !this.state.draft) return;
    if (this.state.selected?.builtin && Object.keys(patch).some(key => key !== "sessionMode" && key !== "modelOverride")) return;
    this.#set({ draft: create(RoutineDefinitionSchema, { ...this.state.draft, ...patch }) });
  }
  #conflicts(catalog: ListPartnerRoutinesResponse, updated?: PartnerRoutine): boolean {
    return this.dirty && (this.#draftPartnerRevision !== catalog.partnerRevision?.value
      || this.state.selected?.revision?.value !== updated?.revision?.value);
  }
  async refresh(): Promise<void> {
    await this.#perform(async signal => {
      const [catalog, pendingId] = await Promise.all([this.api.list(signal), this.receipts.read(this.partnerId)]);
      this.#current(signal);
      const selected = catalog.routines.find(item => item.id === this.state.selected?.id);
      const draftConflict = this.#conflicts(catalog, selected);
      this.#set({ catalog, pendingId, requiresRefresh: draftConflict, draftConflict });
      if (this.dirty) return;
      this.#select(selected);
      if (pendingId) await this.#recover(pendingId, false, signal);
    });
  }
  async observe(): Promise<void> {
    if (this.#disposed || this.state.busy || this.state.requiresRefresh && !this.#retryObservation || this.#observation) return;
    const request = new AbortController(); this.#observation = request;
    try {
      const catalog = await this.api.list(request.signal); this.#current(request.signal);
      const selected = this.state.selected; const updated = selected && catalog.routines.find(item => item.id === selected.id);
      const draftConflict = this.#conflicts(catalog, updated);
      if (draftConflict || selected && !updated) {
        this.#retryObservation = false;
        this.#set({ catalog, draftConflict, requiresRefresh: true }); return;
      }
      if (!this.dirty) this.#draftPartnerRevision = catalog.partnerRevision?.value;
      this.#set({ catalog });
      if (updated && updated.revision?.value !== selected?.revision?.value) this.#select(updated);
      if (updated) await this.#observeHistory(updated.id, request.signal);
      if (this.#retryObservation) {
        this.#retryObservation = false;
        this.#set({ error: undefined, requiresRefresh: false });
      }
    } catch {
      if (!request.signal.aborted && !this.#disposed) {
        this.#retryObservation = true;
        this.#set({ error: "failed", requiresRefresh: true });
      }
    }
    finally { if (this.#observation === request) this.#observation = undefined; }
  }
  async #recover(id: string, retire: boolean, signal: AbortSignal): Promise<void> {
    const result = retire ? await this.api.retire(id, signal) : await this.api.lookup(id, signal);
    this.#current(signal);
    if (!result.routine && !result.retired) { this.#set({ error: "pending" }); return; }
    await this.receipts.resolve(this.partnerId, id); this.#current(signal);
    this.#set({ pendingId: undefined, error: undefined });
    if (result.routine) { this.#replace(result.routine); this.#select(result.routine); }
  }
  async recover(retire = false): Promise<void> { if (this.state.pendingId) await this.#perform(signal => this.#recover(this.state.pendingId!, retire, signal)); }
  #replace(routine: PartnerRoutine): void {
    const catalog = this.state.catalog;
    if (catalog) this.#set({ catalog: { ...catalog, routines: [...catalog.routines.filter(item => item.id !== routine.id), routine] } });
  }
  async save(): Promise<void> {
    const { catalog, draft, selected, pendingId } = this.state;
    if (!this.writable || !catalog?.partnerRevision || !draft || pendingId) return;
    await this.#perform(async signal => {
      let requestId: string | undefined;
      if (!selected) {
        requestId = this.api.newRequestId(); await this.receipts.claim(this.partnerId, requestId);
        this.#current(signal); this.#set({ pendingId: requestId });
      }
      const result = await this.api.save(catalog.partnerRevision!.value, draft, selected ? { routine: selected } : { requestId: requestId! }, signal);
      if (requestId) await this.receipts.resolve(this.partnerId, requestId);
      this.#current(signal); this.#set({ pendingId: undefined }); this.#replace(result); this.#select(result);
    });
  }
  async toggle(routine: PartnerRoutine): Promise<void> {
    const catalog = this.state.catalog;
    if (!this.writable || !catalog?.partnerRevision || this.dirty || !routine.definition) return;
    const definition = routine.definition;
    await this.#perform(async signal => {
      const result = await this.api.save(catalog.partnerRevision!.value, create(RoutineDefinitionSchema, { ...definition, enabled: !definition.enabled }), { routine }, signal);
      this.#current(signal);
      this.#replace(result); if (this.state.selected?.id === result.id) this.#select(result);
    });
  }
  async run(): Promise<void> {
    const { catalog, selected } = this.state;
    if (!this.writable || this.dirty || !catalog?.partnerRevision || !selected || selected.builtin) return;
    await this.#perform(async signal => {
      let requestId = await this.receipts.readRun(this.partnerId, selected.id);
      if (!requestId) { requestId = this.api.newRequestId(); await this.receipts.claimRun(this.partnerId, selected.id, requestId); }
      this.#current(signal);
      await this.api.run(catalog.partnerRevision!.value, selected, requestId, signal);
      await this.receipts.resolveRun(this.partnerId, selected.id, requestId); this.#current(signal);
      await this.#history(selected.id, 0, signal);
    });
  }
  async remove(): Promise<void> {
    const { catalog, selected } = this.state;
    if (!this.writable || !catalog?.partnerRevision || !selected || selected.builtin || this.dirty) return;
    await this.#perform(async signal => {
      await this.api.remove(catalog.partnerRevision!.value, selected, signal); this.#current(signal);
      this.#set({ catalog: { ...catalog, routines: catalog.routines.filter(item => item.id !== selected.id) } }); this.#select();
    });
  }
  async #history(id: string, offset: number, signal: AbortSignal): Promise<void> {
    const result = await this.api.history(id, offset, signal); this.#current(signal);
    const runs = new Map((offset ? this.state.runs : []).map(run => [run.id, run]));
    for (const run of result.runs) runs.set(run.id, run);
    this.#set({ runs: [...runs.values()], nextOffset: result.nextOffset });
  }
  async #observeHistory(id: string, signal: AbortSignal): Promise<void> {
    const previous = this.state.runs;
    const positions = new Map(previous.map((run, index) => [run.id, index]));
    const fresh = new Map<string, PartnerRoutineRun>();
    let offset = 0;
    for (;;) {
      const page = await this.api.history(id, offset, signal); this.#current(signal);
      if (this.state.selected?.id !== id) return;
      for (const run of page.runs) fresh.set(run.id, run);
      const tail = page.runs.at(-1);
      const overlap = tail && positions.get(tail.id);
      if (page.nextOffset === undefined || !previous.length || page.runs.some(run => positions.has(run.id))) {
        const older = overlap !== undefined && page.nextOffset !== undefined
          ? previous.slice(overlap + 1).filter(run => !fresh.has(run.id)) : [];
        const atEnd = overlap !== undefined && this.state.nextOffset === undefined;
        this.#set({ runs: [...fresh.values(), ...older],
          nextOffset: page.nextOffset === undefined || atEnd ? undefined : page.nextOffset + older.length });
        return;
      }
      // A whole page arrived since the last observation. Find the cached rows before reusing their offset.
      offset = page.nextOffset;
    }
  }
  async history(more = false): Promise<void> {
    const selected = this.state.selected;
    const offset = more ? this.state.nextOffset : 0;
    if (selected && offset !== undefined && !this.state.requiresRefresh) await this.#perform(signal => this.#history(selected.id, offset, signal));
  }
}

export function newRoutineTrigger(kind: "cron" | "interval" | "once" | "event", id: string): RoutineTrigger {
  return create(RoutineTriggerSchema, { id, kind: kind === "cron" ? { case: "cron", value: { expression: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } }
    : kind === "interval" ? { case: "interval", value: { intervalMs: 3_600_000n } }
      : kind === "once" ? { case: "once", value: { at: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 } } }
        : { case: "event", value: { sourceId: "", eventType: "", filters: [] } } });
}
export function routineTime(value: { seconds: bigint; nanos: number } | undefined): number { return value ? Number(value.seconds) * 1000 + value.nanos / 1_000_000 : NaN; }
export function routineDateInput(value: { seconds: bigint; nanos: number } | undefined): string {
  const date = new Date(routineTime(value)); return Number.isNaN(date.valueOf()) ? "" : new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function routineTimestamp(value: string): Timestamp | undefined {
  const time = new Date(value).valueOf(); return Number.isNaN(time) ? undefined : create(TimestampSchema, { seconds: BigInt(Math.floor(time / 1000)), nanos: 0 });
}
export function routineMilliseconds(value: string, scale = 1): bigint {
  const number = Number(value) * scale; return Number.isSafeInteger(number) && number >= 0 ? BigInt(number) : 0n;
}
export function validRoutineDraft(value: RoutineDefinition): boolean {
  return !!value.name.trim() && !!value.prompt.trim() && (!value.enabled || value.triggers.length > 0)
    && (!value.preRunHook || !!value.preRunHook.command.trim() && (value.preRunHook.timeoutMs === undefined || value.preRunHook.timeoutMs > 0n))
    && value.triggers.every(trigger => trigger.kind.case === "cron" ? !!trigger.kind.value.expression.trim() && !!trigger.kind.value.timezone.trim()
      : trigger.kind.case === "interval" ? trigger.kind.value.intervalMs >= 60_000n
        : trigger.kind.case === "once" ? Number.isFinite(routineTime(trigger.kind.value.at))
          : trigger.kind.case === "event" ? !!trigger.kind.value.sourceId && !!trigger.kind.value.eventType && trigger.kind.value.filters.every(filter => !!filter.field.trim() && filter.operator > 0 && !!filter.value.trim()) : false);
}
