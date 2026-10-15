import { useMemo, useSyncExternalStore } from "react";
import type { TaskSharingApi, ListTaskSharesResponse } from "@joko/contracts";

export interface TaskSharingDirectory {
  readonly loading: boolean;
  readonly value?: ListTaskSharesResponse;
  readonly error?: string;
}
const disconnected: TaskSharingDirectory = { loading: false };
const stores = new WeakMap<TaskSharingApi, DirectoryStore>();

class DirectoryStore {
  #state: TaskSharingDirectory = { loading: true };
  #listeners = new Set<() => void>();
  #abort: AbortController | undefined;
  #flight: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly api: TaskSharingApi) {}
  read = (): TaskSharingDirectory => this.#state;
  #publish(state: TaskSharingDirectory): void { this.#state = state; for (const listener of this.#listeners) listener(); }
  #visible = (): void => {
    if (document.visibilityState === "hidden") this.#abort?.abort();
    else void this.refresh();
  };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      document.addEventListener("visibilitychange", this.#visible);
      window.addEventListener("focus", this.#visible);
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#abort?.abort();
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#timer = undefined;
        document.removeEventListener("visibilitychange", this.#visible);
        window.removeEventListener("focus", this.#visible);
      }
    };
  };
  refresh = (): Promise<void> => {
    if (this.#flight) return this.#flight;
    if (this.#listeners.size === 0 || document.visibilityState === "hidden") return Promise.resolve();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const abort = new AbortController(); this.#abort = abort;
    this.#publish({ ...this.#state, loading: true });
    const flight = this.api.list(abort.signal).then(value => {
      if (!abort.signal.aborted && this.#abort === abort) this.#publish({ value, loading: false });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted && this.#abort === abort) this.#publish({ ...this.#state, loading: false,
        error: error instanceof Error ? error.message : "The shared task directory could not be refreshed." });
    }).finally(() => {
      if (this.#flight === flight) this.#flight = undefined;
      if (this.#abort === abort) this.#abort = undefined;
      if (this.#listeners.size > 0) this.#timer = setTimeout(() => { void this.refresh(); }, 5_000);
    });
    this.#flight = flight; return flight;
  };
}

function storeFor(api: TaskSharingApi): DirectoryStore {
  let store = stores.get(api);
  if (!store) { store = new DirectoryStore(api); stores.set(api, store); }
  return store;
}
export function useTaskSharingDirectory(api: TaskSharingApi | undefined): TaskSharingDirectory & { readonly refresh: () => Promise<void> } {
  const store = useMemo(() => api === undefined ? undefined : storeFor(api), [api]);
  const state = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), store?.read ?? (() => disconnected));
  return { ...state, refresh: store?.refresh ?? (() => Promise.resolve()) };
}
