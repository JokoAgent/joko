import type { ConnectionRecord, OperationalStore } from "@joko/store";

export class TaskActivityRequestError extends Error {
  constructor(readonly reason: "invalid" | "unavailable" | "capacity", message: string) { super(message); }
}

export interface TaskActivitySnapshot {
  readonly revision: bigint;
  readonly activeDevices: readonly { readonly deviceId: string; readonly displayName: string }[];
}
type Authority = Pick<ConnectionRecord, "id" | "authKeyDigest">;
interface TaskActivityAuthority {
  readonly current: (connection: Authority) => ConnectionRecord;
  readonly local: (connection: Authority) => boolean;
  readonly onRevoked: (connectionId: string, listener: () => void) => () => void;
}
interface View {
  readonly authority: Authority;
  readonly sessions: Set<string>;
  readonly detach: () => void;
}

/** Volatile, authenticated task-page subscriptions. A general connection or
 * task-list observer contributes no task activity. Each stream owns its lease. */
export class TaskActivityRegistry {
  readonly #store: OperationalStore;
  readonly #authority: TaskActivityAuthority;
  readonly #views = new Map<symbol, View>();
  readonly #listeners = new Set<() => void>();
  #detachStore?: () => void;
  #snapshot: TaskActivitySnapshot = Object.freeze({ revision: 0n, activeDevices: Object.freeze([]) });
  #projection = "[]";

  constructor(store: OperationalStore, authority: TaskActivityAuthority) {
    this.#store = store; this.#authority = authority;
  }
  open(connection: Authority, sessionIds: readonly string[]): () => void {
    const current = this.#authority.current(connection);
    if (!Array.isArray(sessionIds) || sessionIds.length > 16 || sessionIds.some(id => typeof id !== "string"
      || !id || id.length > 512 || /[\0\r\n]/u.test(id)) || new Set(sessionIds).size !== sessionIds.length) {
      throw new TaskActivityRequestError("invalid", "Task activity requires a bounded set of specific task identities.");
    }
    for (const id of sessionIds) if (!this.#live(id)) throw new TaskActivityRequestError("unavailable", "The viewed task is unavailable.");
    if (this.#views.size >= 4096) throw new TaskActivityRequestError("capacity", "Task activity subscription capacity is exhausted.");
    const token = Symbol(), authority = { id: current.id, authKeyDigest: current.authKeyDigest };
    const release = () => {
      const view = this.#views.get(token); if (!view) return;
      this.#views.delete(token); view.detach(); this.#refresh();
    };
    const detach = this.#authority.onRevoked(current.id, release);
    this.#views.set(token, { authority, sessions: new Set(sessionIds), detach });
    this.#refresh(); return release;
  }
  snapshot(): TaskActivitySnapshot { this.#refresh(); return this.#snapshot; }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    this.#detachStore ??= this.#store.subscribe(event => {
      if (event.payload.type === "device_changed" || event.payload.type === "session_changed") this.#refresh();
    });
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) { this.#detachStore?.(); this.#detachStore = undefined; }
    };
  }
  #live(sessionId: string): boolean {
    try { return this.#store.getSession(sessionId).descriptor.deletedAt === undefined; }
    catch { return false; }
  }
  #refresh(): void {
    const devices = new Map<string, { readonly deviceId: string; readonly displayName: string }>();
    for (const [token, view] of this.#views) {
      let connection: ConnectionRecord;
      try { connection = this.#authority.current(view.authority); }
      catch { this.#views.delete(token); view.detach(); continue; }
      for (const id of view.sessions) if (!this.#live(id)) view.sessions.delete(id);
      if (!view.sessions.size || this.#authority.local(view.authority)) continue;
      const device = this.#store.getDevice(connection.deviceId);
      if (device.state === "active") devices.set(device.id, Object.freeze({ deviceId: device.id, displayName: device.name }));
    }
    const activeDevices = [...devices.values()].sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
    const projection = JSON.stringify(activeDevices);
    if (projection === this.#projection) return;
    this.#projection = projection;
    this.#snapshot = Object.freeze({ revision: this.#snapshot.revision + 1n, activeDevices: Object.freeze(activeDevices) });
    for (const listener of this.#listeners) listener();
  }
}
