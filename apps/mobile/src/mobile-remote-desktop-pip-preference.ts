export interface MobileRemoteDesktopPipPreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export interface MobileRemoteDesktopPipPreferenceState {
  readonly status: "loading" | "ready" | "error";
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly notice?: "load-failed" | "save-failed";
}
const KEY = "joko.mobile.remote-desktop.picture-in-picture.v1";
let writes: Promise<void> = Promise.resolve();

/** Phone-local intent; neither closing PiP nor changing the target edits it. */
export class MobileRemoteDesktopPipPreferenceStore {
  #state: MobileRemoteDesktopPipPreferenceState = { status: "loading", enabled: false, saving: false };
  #load?: Promise<void>;
  #revision = 0;
  readonly #listeners = new Set<() => void>();
  constructor(private readonly storage: MobileRemoteDesktopPipPreferenceStorage) {}
  get snapshot(): MobileRemoteDesktopPipPreferenceState { return this.#state; }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  };
  hydrate(): Promise<void> { this.#load ??= this.#read(); return this.#load; }
  async update(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Invalid Remote Desktop background preference.");
    const revision = ++this.#revision;
    this.#set({ ...this.#state, saving: true, notice: undefined });
    const pending = writes.catch(() => undefined).then(() => this.storage.setItem(KEY, JSON.stringify({ version: 1, enabled })));
    writes = pending.catch(() => undefined);
    try {
      await pending;
      if (revision === this.#revision) this.#set({ status: "ready", enabled, saving: false });
    } catch {
      if (revision === this.#revision) this.#set({ ...this.#state, status: "error", saving: false, notice: "save-failed" });
    }
  }
  retryLoad(): Promise<void> {
    if (this.#state.saving) return Promise.resolve();
    this.#load = undefined;
    this.#set({ ...this.#state, status: "loading", notice: undefined });
    return this.hydrate();
  }
  async #read(): Promise<void> {
    const revision = this.#revision;
    try {
      await writes;
      const raw = await this.storage.getItem(KEY);
      if (revision !== this.#revision) return;
      let enabled = false;
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value)
          || Object.keys(value).length !== 2 || !("version" in value) || value.version !== 1
          || !("enabled" in value) || typeof value.enabled !== "boolean") throw new Error("Invalid stored preference.");
        enabled = value.enabled;
      }
      this.#set({ status: "ready", enabled, saving: false });
    } catch {
      if (revision === this.#revision) this.#set({ ...this.#state, status: "error", saving: false, notice: "load-failed" });
    }
  }
  #set(state: MobileRemoteDesktopPipPreferenceState): void {
    this.#state = Object.freeze(state); for (const listener of this.#listeners) listener();
  }
}
