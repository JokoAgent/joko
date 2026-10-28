import type { PartnerTodo } from "./gen/joko/v1/partner_todo_pb.js";
import type { PartnerAutonomyApi } from "./partner-autonomy.js";
import { partnerMutationWasRejected } from "./partner-autonomy.js";

export interface PartnerGlanceTodoState {
  readonly open: readonly PartnerTodo[]; readonly done: readonly PartnerTodo[];
  readonly openTotal: number; readonly doneTotal: number; readonly loaded: boolean; readonly failed: boolean;
  readonly saving: boolean; readonly pending: boolean; readonly deleted?: PartnerTodo; readonly partnerRevision?: bigint;
  readonly nextDeferredAt?: number; readonly now: number;
}
/** Bounded page reads, expired deferrals and the exact mutation request are shared by both clients. */
export class PartnerGlanceTodos {
  readonly #listeners = new Set<() => void>(); #request: AbortController | undefined; #closed = false; #foreground = false;
  #epoch = 0; #timer: ReturnType<typeof setTimeout> | undefined;
  #attempt: { readonly operationId: string; readonly revision: bigint; readonly todo: PartnerTodo; readonly action: "delete" | "restore" } | undefined;
  #state: PartnerGlanceTodoState = { open: [], done: [], openTotal: 0, doneTotal: 0, loaded: false, failed: false, saving: false, pending: false, now: Date.now() };
  constructor(readonly api: PartnerAutonomyApi, readonly partnerId: string) {}
  snapshot = (): PartnerGlanceTodoState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #set(patch: Partial<PartnerGlanceTodoState>) { if (this.#closed) return; this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener(); }
  activate(): void { if (this.#closed) return; this.#foreground = true; void this.refresh(); }
  suspend(): void { this.#foreground = false; this.#epoch++; this.#request?.abort(); clearTimeout(this.#timer); }
  dispose(): void { this.suspend(); this.#closed = true; this.#listeners.clear(); }
  async refresh(): Promise<void> {
    if (!this.#foreground || this.#closed || this.#state.saving) return;
    const epoch = ++this.#epoch, request = new AbortController(); this.#request?.abort(); this.#request = request;
    try {
      const read = async (view: "open" | "done") => {
        let page = await this.api.todos(this.partnerId, view, 0, request.signal), items = [...page.items], offset = page.nextOffset;
        const first = page;
        while (offset !== undefined && items.length < Math.min(page.total, 200)) {
          page = await this.api.todos(this.partnerId, view, offset, request.signal);
          if (page.partnerRevision?.value !== first.partnerRevision?.value || page.items.length === 0) break;
          items.push(...page.items);
          if (page.nextOffset !== undefined && page.nextOffset <= offset) throw new Error("The affair cursor did not advance.");
          offset = page.nextOffset;
        }
        const unique = new Map(items.map(todo => [todo.id, todo]));
        return { ...first, items: [...unique.values()].slice(0, 200), total: page.total };
      };
      const [open, done] = await Promise.all([read("open"), read("done")]);
      if (request.signal.aborted || epoch !== this.#epoch || !this.#foreground || this.#closed) return;
      if (open.partnerRevision?.value !== done.partnerRevision?.value) throw new Error("The affair owner changed during pagination.");
      this.#set({ open: open.items, done: [...done.items].reverse(), openTotal: open.total, doneTotal: done.total, loaded: true, failed: false,
        partnerRevision: open.partnerRevision!.value, nextDeferredAt: open.nextDeferredAt ? Number(open.nextDeferredAt.seconds * 1000n) : undefined, now: Date.now() });
      this.#arm();
    } catch { if (!request.signal.aborted && epoch === this.#epoch) this.#set({ loaded: true, failed: true }); }
    finally { if (this.#request === request) this.#request = undefined; }
  }
  #arm(): void {
    clearTimeout(this.#timer); if (!this.#foreground || this.#closed) return;
    const until = this.#state.nextDeferredAt, delay = until === undefined ? 60_000 : Math.max(0, Math.min(60_000, until - Date.now()));
    this.#timer = setTimeout(() => { this.#set({ now: Date.now() }); void this.refresh(); }, delay);
  }
  async mutate(todo?: PartnerTodo, action?: "delete" | "restore"): Promise<void> {
    if (this.#closed || !this.#foreground || this.#state.saving || !this.#state.partnerRevision) return;
    if (!this.#attempt) {
      if (!todo || !action) return;
      this.#attempt = { operationId: this.api.newOperationId(), revision: this.#state.partnerRevision, todo, action };
    }
    const attempt = this.#attempt, request = new AbortController(); this.#request?.abort(); this.#request = request; this.#epoch++;
    this.#set({ saving: true, failed: false, pending: true });
    try {
      const updated = await this.api.updateTodo(attempt.operationId, this.partnerId, attempt.revision, attempt.todo, attempt.action, request.signal);
      if (request.signal.aborted || this.#closed || !this.#foreground) return;
      if (this.#attempt === attempt) this.#attempt = undefined;
      this.#set({ deleted: attempt.action === "delete" ? updated : undefined, pending: false });
    } catch (error) { if (!request.signal.aborted) { if (partnerMutationWasRejected(error)) { this.#attempt = undefined; this.#set({ pending: false }); } this.#set({ failed: true }); } }
    finally {
      if (this.#request === request) this.#request = undefined;
      this.#set({ saving: false }); if (!this.#attempt) await this.refresh(); else this.#arm();
    }
  }
}
function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(part => parts.find(item => item.type === part)!.value).join("-");
}
export function partnerTodoDue(todo: PartnerTodo, now = Date.now()): boolean {
  const deadline = todo.deadline; return todo.status === "open" && !!deadline && deadline.date <= localDate(new Date(now), deadline.timeZone);
}
export function partnerTodoDate(todo: PartnerTodo, locale = "en"): string {
  const deadline = todo.deadline; if (!deadline) return "";
  return deadline.kind === "instant" && deadline.at ? new Intl.DateTimeFormat(locale, { timeZone: deadline.timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(deadline.at))
    : new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "numeric", day: "numeric" }).format(new Date(`${deadline.date}T12:00:00Z`));
}
