import type { PartnerGroupApi } from "./partner-groups.js";
import type { GetPartnerGroupResponse, ListPartnerGroupsResponse, PartnerGroupDetail, PartnerGroupPlan, PartnerGroupSummary } from "./gen/joko/v1/partner_group_pb.js";

const GROUP_REFRESH_INTERVAL_MS = 1_000;
const GROUP_READ_TIMEOUT_MS = 5_000;
interface GroupRefresh {
  readonly epoch: number;
  promise: Promise<void>;
  again: boolean;
  forceDetail: boolean;
}

export interface PartnerGroupViewState {
  readonly status: "loading" | "ready" | "offline" | "error";
  readonly catalog?: ListPartnerGroupsResponse;
  readonly detail?: GetPartnerGroupResponse;
  readonly selectedId?: string;
  readonly refreshing: boolean;
  readonly busy: boolean;
  readonly error?: string;
}
/** Both clients observe the same authoritative pages; drafts stay in their owning surface. */
export class PartnerGroupViewController {
  readonly #listeners = new Set<() => void>();
  readonly #readThrough = new Map<string, bigint>();
  #state: PartnerGroupViewState = { status: "loading", refreshing: false, busy: false };
  #abort: AbortController | undefined;
  #epoch = 0;
  #catalogReadEpoch = 0;
  #readEpoch = 0;
  #disposed = false;
  #refresh: GroupRefresh | undefined;
  constructor(readonly api: PartnerGroupApi) {}
  get state(): PartnerGroupViewState { return this.#state; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #update(patch: Partial<PartnerGroupViewState>): void {
    if (this.#disposed) return; this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener();
  }
  setActive(active: boolean): void {
    this.#abort?.abort(); this.#abort = undefined; this.#epoch++;
    if (!active || this.#disposed) { this.#update({ status: "offline", refreshing: false, busy: false }); return; }
    const abort = this.#abort = new AbortController(), epoch = this.#epoch;
    this.#update({ status: this.#state.catalog ? "ready" : "loading", refreshing: true });
    void this.#observe(epoch, abort.signal);
  }
  #current(epoch: number, signal: AbortSignal): boolean { return !this.#disposed && epoch === this.#epoch && !signal.aborted; }
  async #observe(epoch: number, signal: AbortSignal): Promise<void> {
    try {
      while (this.#current(epoch, signal)) {
        await this.#refreshCurrent(epoch, signal, false, false);
        if (!this.#current(epoch, signal)) return;
        await groupRefreshDelay(signal);
      }
    } catch (error) { if (this.#current(epoch, signal)) this.#update({ status: "error", refreshing: false, error: errorText(error) }); }
  }
  async refresh(): Promise<void> {
    const signal = this.#abort?.signal; if (!signal || signal.aborted) return;
    this.#catalogReadEpoch++; this.#readEpoch++;
    await this.#refreshCurrent(this.#epoch, signal, true, true);
  }
  #refreshCurrent(epoch: number, signal: AbortSignal, forceDetail: boolean, afterCurrent: boolean): Promise<void> {
    const pending = this.#refresh;
    if (pending?.epoch === epoch) {
      pending.forceDetail ||= forceDetail;
      pending.again ||= afterCurrent;
      return pending.promise;
    }
    const refresh: GroupRefresh = { epoch, promise: Promise.resolve(), again: false, forceDetail };
    this.#refresh = refresh;
    this.#update({ refreshing: true });
    refresh.promise = (async () => {
      try {
        do {
          refresh.again = false;
          const catalogRead = this.#catalogReadEpoch;
          const previousSequence = this.#state.catalog?.changeSequence;
          const catalog = await boundedGroupRead(signal, current => this.api.list(current));
          if (!this.#current(epoch, signal)) return;
          if (catalogRead !== this.#catalogReadEpoch) { refresh.again = true; continue; }
          this.#update({ catalog, status: "ready", error: undefined });
          let needsDetail = refresh.forceDetail || previousSequence !== catalog.changeSequence;
          refresh.forceDetail = false;
          while (this.#current(epoch, signal)) {
            const selectedId = this.#state.selectedId;
            if (!selectedId) break;
            if (!catalog.groups.some(group => group.id === selectedId)) { this.#update({ selectedId: undefined, detail: undefined }); break; }
            if (!needsDetail && this.#state.detail?.detail?.group?.id === selectedId) break;
            await this.#detail(selectedId, signal);
            if (!this.#current(epoch, signal)) return;
            if (this.#state.selectedId === selectedId && this.#state.detail?.detail?.group?.id === selectedId && !refresh.forceDetail) break;
            needsDetail = true; refresh.forceDetail = false;
          }
        } while (refresh.again && this.#current(epoch, signal));
      } catch (error) {
        if (this.#current(epoch, signal)) this.#update({ status: "error", error: errorText(error) });
      } finally {
        if (this.#refresh === refresh) this.#refresh = undefined;
        if (this.#current(epoch, signal)) this.#update({ refreshing: false });
      }
    })();
    return refresh.promise;
  }
  select(id: string | undefined): void {
    this.#readEpoch++; this.#update({ selectedId: id, detail: undefined, error: undefined });
    const signal = this.#abort?.signal;
    if (id && signal && !signal.aborted) void this.#refreshCurrent(this.#epoch, signal, true, false);
  }
  async #detail(groupId: string, signal: AbortSignal): Promise<void> {
    const epoch = this.#epoch, read = ++this.#readEpoch, response = await boundedGroupRead(signal, current => this.api.get(groupId, undefined, current));
    if (!this.#current(epoch, signal) || read !== this.#readEpoch || this.#state.selectedId !== groupId) return;
    const previous = this.#state.detail?.detail, incoming = response.detail!;
    this.#update({ detail: { ...response, detail: mergeDetail(previous, incoming) } });
  }
  async older(): Promise<void> {
    const selectedId = this.#state.selectedId, previous = this.#state.detail, signal = this.#abort?.signal;
    const first = previous?.detail?.messages[0]; if (!selectedId || !first || !signal || signal.aborted || !previous.detail?.hasMoreBefore) return;
    const epoch = this.#epoch;
    await this.action(async current => {
      const response = await boundedGroupRead(current, signal => this.api.get(selectedId, first.sequence, signal));
      if (!this.#current(epoch, current) || this.#state.selectedId !== selectedId) return;
      const latest = this.#state.detail;
      if (latest?.detail) this.#update({ detail: { ...latest, detail: { ...latest.detail, messages: mergeMessages(response.detail!.messages, latest.detail.messages),
        plans: mergePlans(response.detail!.plans, latest.detail.plans), hasMoreBefore: response.detail!.hasMoreBefore } } });
    }, false);
  }
  markVisible(throughSequence: bigint): void {
    const id = this.#state.selectedId, signal = this.#abort?.signal;
    if (!id || !signal || signal.aborted || throughSequence <= (this.#readThrough.get(id) ?? 0n)) return;
    this.#readThrough.set(id, throughSequence);
    void this.api.markRead(id, throughSequence, signal).catch(() => { if (this.#readThrough.get(id) === throughSequence) this.#readThrough.delete(id); });
  }
  async action<T>(run: (signal: AbortSignal) => Promise<T>, refresh = true, throwOnError = false): Promise<T | undefined> {
    const signal = this.#abort?.signal; if (this.#state.busy || !signal || signal.aborted || this.#state.status !== "ready") {
      if (throwOnError) throw new Error("The group action owner is unavailable."); return undefined;
    }
    const epoch = this.#epoch; this.#catalogReadEpoch++; this.#readEpoch++;
    this.#update({ busy: true, error: undefined });
    try { const result = await run(signal); if (!this.#current(epoch, signal)) { if (throwOnError) throw new Error("The group action owner changed."); return undefined; } if (refresh) await this.refresh(); return result; }
    catch (error) { if (this.#current(epoch, signal)) this.#update({ error: errorText(error) }); if (throwOnError) throw error; return undefined; }
    finally { if (this.#current(epoch, signal)) this.#update({ busy: false }); }
  }
  group(): PartnerGroupSummary | undefined { return this.#state.detail?.detail?.group; }
  dispose(): void { this.#disposed = true; this.#abort?.abort(); this.#listeners.clear(); }
}
function groupRefreshDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, GROUP_REFRESH_INTERVAL_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function boundedGroupRead<T>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const abort = new AbortController();
  const retire = () => abort.abort(signal.reason);
  signal.addEventListener("abort", retire, { once: true });
  const timer = setTimeout(() => abort.abort(new Error("The group read timed out. Refresh to retry.")), GROUP_READ_TIMEOUT_MS);
  let stop: (() => void) | undefined;
  const retired = new Promise<never>((_resolve, reject) => {
    stop = () => reject(abort.signal.reason);
    abort.signal.addEventListener("abort", stop, { once: true });
  });
  try {
    const result = await Promise.race([read(abort.signal), retired]);
    signal.throwIfAborted(); abort.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", retire);
    if (stop) abort.signal.removeEventListener("abort", stop);
  }
}
function mergeMessages(left: PartnerGroupDetail["messages"], right: PartnerGroupDetail["messages"]) {
  return [...new Map([...left, ...right].map(message => [message.id, message])).values()].sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
}
function mergePlans(left: PartnerGroupPlan[], right: PartnerGroupPlan[]) { return [...new Map([...left, ...right].map(plan => [plan.id, plan])).values()]; }
function mergeDetail(previous: PartnerGroupDetail | undefined, incoming: PartnerGroupDetail): PartnerGroupDetail {
  if (!previous || previous.group?.id !== incoming.group?.id || !incoming.messages.length) return incoming;
  const last = previous.messages.at(-1), first = incoming.messages[0]!;
  if (last && last.sequence + 1n < first.sequence) return incoming;
  return { ...incoming, messages: mergeMessages(previous.messages, incoming.messages), plans: mergePlans(previous.plans, incoming.plans), hasMoreBefore: previous.hasMoreBefore };
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "The group action could not be confirmed. Refresh before retrying."; }
