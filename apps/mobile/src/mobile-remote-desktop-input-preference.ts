export type MobileRemoteDesktopStoredInputMode = "touch" | "trackpad";

export interface MobileRemoteDesktopInputPreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export interface MobileRemoteDesktopInputPreferenceState<T> {
  readonly status: "loading" | "ready" | "error";
  readonly value: T;
  readonly saving: boolean;
  readonly notice?: "load-failed" | "save-failed";
}
export interface MobileRemoteDesktopInputPreferenceStore<T> {
  readonly snapshot: MobileRemoteDesktopInputPreferenceState<T>;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  update(value: T): Promise<void>;
  retryLoad(): Promise<void>;
}

const MODE_KEY = "joko.mobile.remote-desktop.input-mode.v1";
const BUTTONS_KEY = "joko.mobile.remote-desktop.show-mouse-buttons.v1";
const writes = new Map<string, Promise<void>>();

/** Phone-local choices are shared across targets; each setting owns its storage key. */
class InputPreferenceStore<T> implements MobileRemoteDesktopInputPreferenceStore<T> {
  #state: MobileRemoteDesktopInputPreferenceState<T>;
  #load?: Promise<void>;
  #revision = 0;
  readonly #listeners = new Set<() => void>();
  constructor(private readonly storage: MobileRemoteDesktopInputPreferenceStorage, private readonly key: string,
    private readonly field: "mode" | "enabled", private readonly defaultValue: T,
    private readonly valid: (value: unknown) => value is T) {
    this.#state = Object.freeze({ status: "loading", value: defaultValue, saving: false });
  }
  get snapshot(): MobileRemoteDesktopInputPreferenceState<T> { return this.#state; }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  };
  hydrate(): Promise<void> { this.#load ??= this.#read(); return this.#load; }
  async update(value: T): Promise<void> {
    if (!this.valid(value)) throw new Error("Invalid Remote Desktop input preference.");
    const revision = ++this.#revision;
    this.#set({ status: "ready", value, saving: true });
    const pending = (writes.get(this.key) ?? Promise.resolve()).then(() =>
      this.storage.setItem(this.key, JSON.stringify({ version: 1, [this.field]: value })));
    const settled = pending.then(() => undefined, () => undefined);
    writes.set(this.key, settled);
    void settled.then(() => { if (writes.get(this.key) === settled) writes.delete(this.key); });
    try {
      await pending;
      if (revision === this.#revision) this.#set({ status: "ready", value, saving: false });
    } catch {
      if (revision === this.#revision) this.#set({ status: "error", value, saving: false, notice: "save-failed" });
    }
  }
  retryLoad(): Promise<void> {
    if (this.#state.saving || this.#revision !== 0) return Promise.resolve();
    this.#load = undefined;
    this.#set({ ...this.#state, status: "loading", notice: undefined });
    return this.hydrate();
  }
  async #read(): Promise<void> {
    if (this.#revision !== 0) return;
    try {
      await writes.get(this.key);
      const raw = await this.storage.getItem(this.key);
      if (this.#revision !== 0) return;
      let value = this.defaultValue;
      if (raw !== null) {
        const stored: unknown = JSON.parse(raw);
        if (typeof stored !== "object" || stored === null || Array.isArray(stored)
          || Object.keys(stored).length !== 2 || !("version" in stored) || stored.version !== 1
          || !(this.field in stored) || !this.valid((stored as Record<string, unknown>)[this.field])) {
          throw new Error("Invalid stored input preference.");
        }
        value = (stored as Record<string, T>)[this.field]!;
      }
      this.#set({ status: "ready", value, saving: false });
    } catch {
      if (this.#revision === 0) this.#set({ ...this.#state, status: "error", saving: false, notice: "load-failed" });
    }
  }
  #set(state: MobileRemoteDesktopInputPreferenceState<T>): void {
    this.#state = Object.freeze(state); for (const listener of this.#listeners) listener();
  }
}

export function createInputModePreferenceStore(storage: MobileRemoteDesktopInputPreferenceStorage):
MobileRemoteDesktopInputPreferenceStore<MobileRemoteDesktopStoredInputMode> {
  return new InputPreferenceStore(storage, MODE_KEY, "mode", "touch",
    (value): value is MobileRemoteDesktopStoredInputMode => value === "touch" || value === "trackpad");
}
export function createMouseButtonsPreferenceStore(storage: MobileRemoteDesktopInputPreferenceStorage):
MobileRemoteDesktopInputPreferenceStore<boolean> {
  return new InputPreferenceStore(storage, BUTTONS_KEY, "enabled", false, (value): value is boolean => typeof value === "boolean");
}
