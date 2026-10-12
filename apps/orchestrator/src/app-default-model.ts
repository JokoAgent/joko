import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { appDefaultModelRouteId, sameAppDefaultModelRoute, type AppDefaultModelRouteValue } from "@joko/contracts";
import type { OperationalStore } from "@joko/store";

export interface AppDefaultModelChoice extends AppDefaultModelRouteValue {
  readonly id: string;
  readonly efforts: readonly string[];
  readonly supportsFastMode: boolean;
  readonly instanceGeneration: number;
  readonly defaultVisible?: boolean;
}
interface UiOwner {
  readonly connectionId: string;
  readonly id: string;
  readonly publish: (message: { ready: boolean; requestId: string }) => void;
  readonly assertCurrent: () => void;
  readonly assertLive: () => void;
}
interface Mirror {
  readonly owner: UiOwner;
  readonly current?: AppDefaultModelRouteValue;
  readonly hidden: ReadonlySet<string>;
  readonly visible: ReadonlySet<string>;
  readonly tuning: ReadonlyMap<string, AppDefaultModelRouteValue>;
}
interface PendingSelection {
  readonly id: string;
  readonly owner: UiOwner;
  readonly expected?: AppDefaultModelRouteValue;
  readonly requested: AppDefaultModelRouteValue;
  readonly catalog: string;
  readonly expiresAt: number;
  readonly assertCaller: () => void;
  readonly resolve: (route: AppDefaultModelRouteValue) => void;
  readonly reject: (error: unknown) => void;
  claimed: boolean;
}
const unavailable = () => new ConnectError("The application default model was not confirmed. Read its current state before explicitly retrying.", Code.FailedPrecondition);
export class AppDefaultModelCoordinator {
  readonly #owners: UiOwner[] = [];
  #mirror: Mirror | undefined;
  #pending: PendingSelection | undefined;
  #changed: Promise<void> = Promise.resolve();
  constructor(readonly store: OperationalStore, readonly catalog: () => readonly AppDefaultModelChoice[],
    readonly onChanged: (route: AppDefaultModelRouteValue) => Promise<void>, readonly now = Date.now) {}

  watch(connectionId: string, id: string, publish: UiOwner["publish"], assertCurrent: () => void, assertActive?: () => void): () => void {
    if (!/^[a-zA-Z0-9_-]{16,128}$/u.test(id) || this.#owners.some(owner => owner.connectionId === connectionId && owner.id === id)) {
      throw new ConnectError("The default-model UI owner is invalid or already connected.", Code.InvalidArgument);
    }
    const owner = { connectionId, id, publish, assertCurrent, assertLive: () => { assertActive?.(); assertCurrent(); } }; this.#owners.push(owner);
    if (this.#owners[0] === owner) publish({ ready: true, requestId: "" });
    return () => {
      const index = this.#owners.indexOf(owner); if (index < 0) return;
      this.#owners.splice(index, 1);
      if (this.#pending?.owner === owner) this.#pending.reject(unavailable());
      if (index === 0) this.#owners[0]?.publish({ ready: true, requestId: "" });
    };
  }
  #owner(connectionId: string, id: string): UiOwner {
    const owner = this.#owners[0];
    if (owner?.connectionId !== connectionId || owner.id !== id) throw unavailable();
    owner.assertLive(); return owner;
  }
  sync(connectionId: string, id: string, current: AppDefaultModelRouteValue | undefined,
    hidden: readonly string[], tuning: readonly AppDefaultModelRouteValue[], confirmedRequestId = "", visible: readonly string[] = []): boolean {
    const owner = this.#owners[0];
    if (owner?.connectionId !== connectionId || owner.id !== id) return false;
    owner.assertLive();
    if (hidden.length > 4_096 || visible.length > 4_096 || tuning.length > 4_096 || [...hidden, ...visible].some(item => !item || item.length > 2_048)
      || new Set(hidden).size !== hidden.length || new Set(visible).size !== visible.length || visible.some(item => hidden.includes(item))
      || new Set(tuning.map(appDefaultModelRouteId)).size !== tuning.length) {
      throw new ConnectError("The default-model UI mirror is invalid.", Code.InvalidArgument);
    }
    const before = this.#mirror?.current;
    this.#mirror = { owner, ...(current === undefined ? {} : { current }), hidden: new Set(hidden), visible: new Set(visible), tuning: new Map(tuning.map(route => [appDefaultModelRouteId(route), route])) };
    const pending = this.#pending;
    if (confirmedRequestId) {
      if (!pending || pending.id !== confirmedRequestId || pending.owner !== owner || !pending.claimed || this.now() >= pending.expiresAt
        || !sameAppDefaultModelRoute(current, pending.requested) || this.#catalogStamp() !== pending.catalog) throw unavailable();
      pending.assertCaller();
      this.#assertAvailable(pending.requested);
    } else if (pending && (!sameAppDefaultModelRoute(current, pending.expected) || this.#catalogStamp() !== pending.catalog)) {
      pending.reject(unavailable());
    }
    if (current !== undefined && !sameAppDefaultModelRoute(before, current)) {
      this.#changed = this.#changed.catch(() => undefined).then(() => this.onChanged(current));
      void this.#changed.catch(() => undefined);
    }
    if (confirmedRequestId) pending!.resolve(current!);
    return true;
  }
  read() {
    this.#mirror?.owner.assertCurrent();
    const available = this.#choices().map(({ instanceGeneration: _generation, defaultVisible: _visible, ...choice }) => choice);
    return { current: this.#mirror?.current ?? null, available };
  }
  current(): AppDefaultModelRouteValue | undefined {
    try { this.#mirror?.owner.assertCurrent(); return this.#mirror?.current; } catch { return undefined; }
  }
  #visible(choice: AppDefaultModelChoice): boolean {
    return !this.#mirror?.hidden.has(choice.id) && (this.#mirror?.visible.has(choice.id) === true || choice.defaultVisible !== false);
  }
  #choices(): readonly AppDefaultModelChoice[] {
    const mirror = this.#mirror;
    return this.catalog().filter(choice => this.#visible(choice)).map(choice => {
      const tuning = mirror?.tuning.get(choice.id);
      return { ...choice, effort: tuning !== undefined && (choice.efforts.length === 0 ? tuning.effort === "" : choice.efforts.includes(tuning.effort)) ? tuning.effort : choice.effort,
        fastMode: choice.supportsFastMode && (tuning?.fastMode ?? choice.fastMode) };
    });
  }
  #catalogStamp(): string { return JSON.stringify(this.catalog().filter(choice => this.#visible(choice))); }
  #assertAvailable(route: AppDefaultModelRouteValue): void {
    const choice = this.#choices().find(item => item.id === appDefaultModelRouteId(route));
    if (!choice || (choice.efforts.length === 0 ? route.effort !== "" : !choice.efforts.includes(route.effort)) || route.fastMode && !choice.supportsFastMode) {
      throw new ConnectError("The requested application default model or tuning is unavailable. Read the enabled models again.", Code.InvalidArgument);
    }
  }
  claim(connectionId: string, ownerId: string, requestId: string) {
    const owner = this.#owner(connectionId, ownerId), pending = this.#pending;
    if (!pending || pending.owner !== owner || pending.id !== requestId || pending.claimed || this.now() >= pending.expiresAt
      || !sameAppDefaultModelRoute(this.#mirror?.current, pending.expected) || this.#catalogStamp() !== pending.catalog) throw unavailable();
    pending.assertCaller(); this.#assertAvailable(pending.requested); pending.claimed = true;
    return { remainingMs: Math.max(0, pending.expiresAt - this.now()), expected: pending.expected, requested: pending.requested };
  }
  async select(input: { sessionId: string; id: string; effort?: string; fastMode?: boolean; assertCaller: () => void; signal?: AbortSignal }) {
    input.signal?.throwIfAborted(); input.assertCaller();
    const mirror = this.#mirror; if (!mirror || mirror.owner !== this.#owners[0] || this.#pending) throw unavailable();
    mirror.owner.assertLive();
    const choice = this.#choices().find(item => item.id === input.id);
    if (!choice) throw new ConnectError("Choose an enabled model id returned by get_app_default_model.", Code.InvalidArgument);
    const requested = { backendId: choice.backendId, providerId: choice.providerId, modelId: choice.modelId,
      effort: input.effort ?? choice.effort, fastMode: input.fastMode ?? choice.fastMode };
    this.#assertAvailable(requested);
    let timer: NodeJS.Timeout | undefined, abort: (() => void) | undefined;
    const result = new Promise<AppDefaultModelRouteValue>((resolve, reject) => {
      const pending: PendingSelection = { id: randomUUID(), owner: mirror.owner, expected: mirror.current, requested,
        catalog: this.#catalogStamp(), expiresAt: this.now() + 5_000, assertCaller: input.assertCaller, resolve, reject, claimed: false };
      this.#pending = pending;
      timer = setTimeout(() => reject(unavailable()), 5_000); timer.unref();
      abort = () => reject(input.signal?.reason ?? unavailable()); input.signal?.addEventListener("abort", abort, { once: true });
      try {
        const session = this.store.getSession(input.sessionId).descriptor;
        this.store.appendEvent({ backendId: session.backendId, targetId: session.targetId, sessionId: session.id, generation: session.binding.generation, traceId: pending.id,
          payload: { type: "app_default_model_requested", requestId: pending.id, uiOwnerId: pending.owner.id,
            connectionId: pending.owner.connectionId, expiresAt: pending.expiresAt } });
        input.assertCaller(); pending.owner.assertLive(); pending.owner.publish({ ready: false, requestId: pending.id });
      } catch (error) { reject(error); }
    });
    try {
      const current = await result;
      mirror.owner.assertCurrent();
      if (this.#mirror?.owner !== mirror.owner || !sameAppDefaultModelRoute(this.#mirror.current, current)) throw unavailable();
      await this.#changed;
      input.signal?.throwIfAborted(); mirror.owner.assertCurrent(); this.#assertAvailable(current);
      if (this.#mirror?.owner !== mirror.owner || !sameAppDefaultModelRoute(this.#mirror.current, current)) throw unavailable();
      return { current };
    } finally {
      if (timer) clearTimeout(timer); if (abort) input.signal?.removeEventListener("abort", abort);
      this.#pending = undefined;
    }
  }
}
