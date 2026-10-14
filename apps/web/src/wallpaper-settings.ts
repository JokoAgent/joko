import { useMemo, useSyncExternalStore } from "react";

type WallpaperApi = NonNullable<JokoDesktopApi["wallpaper"]>;
type WallpaperPatch = Omit<JokoDesktopWallpaperSettingsChange, "expectedRevision">;
type OperationKind = "set" | "import" | "remove" | "reset";

export interface WallpaperSettingsState {
  readonly available: boolean;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly operation?: OperationKind;
  readonly settings?: JokoDesktopWallpaperSettings;
  readonly error?: "load" | "save";
}

interface PendingOperation {
  readonly kind: OperationKind;
  readonly patch?: WallpaperPatch;
}

const UNAVAILABLE: WallpaperSettingsState = Object.freeze({ available: false, loading: false, busy: false });
const stores = new WeakMap<WallpaperApi, WallpaperSettingsStore>();

function currentWallpaperApi(): WallpaperApi | undefined {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const api = desktop?.wallpaper;
  return Array.isArray(desktop?.capabilities) && desktop.capabilities.includes("appearance.wallpaper")
    && typeof api?.get === "function" && typeof api.set === "function"
    && typeof api.import === "function" && typeof api.remove === "function"
    && typeof api.reset === "function" && typeof api.onChanged === "function"
    ? api : undefined;
}

/** App and its Settings surface share one current native occurrence and write queue. */
class WallpaperSettingsStore {
  #state: WallpaperSettingsState = { available: true, loading: true, busy: false };
  #confirmed: JokoDesktopWallpaperSettings | undefined;
  #listeners = new Set<() => void>();
  #pending: PendingOperation[] = [];
  #tail: Promise<void> = Promise.resolve();
  #epoch = 0;
  #read = 0;
  #changed = 0;
  #unsubscribe: (() => void) | undefined;
  #active = false;

  constructor(readonly api: WallpaperApi, readonly owner: Window) {}

  snapshot = (): WallpaperSettingsState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.owner.addEventListener("pagehide", this.#hide);
      this.owner.addEventListener("pageshow", this.#show);
      this.#start();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.owner.removeEventListener("pagehide", this.#hide);
        this.owner.removeEventListener("pageshow", this.#show);
        this.#retire();
      }
    };
  };
  #hide = (): void => this.#retire();
  #show = (): void => this.#start();

  #start(): void {
    if (this.#active || currentWallpaperApi() !== this.api) return;
    this.#active = true;
    const epoch = ++this.#epoch;
    this.#publish({ available: true, loading: true, busy: false });
    try {
      this.#unsubscribe = this.api.onChanged((value) => {
        if (!this.#current(epoch)) return;
        try {
          const settings = normalizeWallpaperSettings(value);
          this.#changed += 1;
          this.#accept(settings);
          this.#project();
        } catch {
          // Invalid notifications cannot replace the last confirmed projection.
        }
      });
      void this.reload();
    } catch {
      this.#publish({ available: true, loading: false, busy: false, error: "load" });
    }
  }

  #retire(): void {
    this.#active = false;
    this.#epoch += 1;
    this.#read += 1;
    this.#pending = [];
    this.#tail = Promise.resolve();
    this.#confirmed = undefined;
    try { this.#unsubscribe?.(); } catch { /* Retirement must still complete. */ }
    this.#unsubscribe = undefined;
    this.#publish({ available: true, loading: true, busy: false });
  }

  #current(epoch: number): boolean {
    return this.#active && this.#epoch === epoch && currentWallpaperApi() === this.api;
  }

  #accept(settings: JokoDesktopWallpaperSettings): void {
    if (this.#confirmed === undefined || settings.revision > this.#confirmed.revision) this.#confirmed = settings;
  }

  #publish(state: WallpaperSettingsState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #project(error?: "load" | "save"): void {
    let settings = this.#confirmed;
    for (const operation of this.#pending) {
      if (settings === undefined) break;
      if (operation.kind === "set") settings = { ...settings, ...operation.patch };
      else if (operation.kind === "reset") settings = { ...settings, mode: "none", maskOpacity: 0.2 };
    }
    this.#publish({
      available: true, loading: settings === undefined, busy: this.#pending.length > 0,
      ...(this.#pending[0] === undefined ? {} : { operation: this.#pending[0].kind }),
      ...(settings === undefined ? {} : { settings }), ...(error === undefined ? {} : { error })
    });
  }

  reload = async (): Promise<void> => {
    const epoch = this.#epoch;
    if (!this.#current(epoch) || this.#pending.length > 0) return;
    const read = ++this.#read;
    const changed = this.#changed;
    this.#project();
    try {
      const settings = normalizeWallpaperSettings(await this.api.get());
      if (!this.#current(epoch) || read !== this.#read || changed !== this.#changed) return;
      this.#accept(settings);
      this.#project();
    } catch {
      if (!this.#current(epoch) || read !== this.#read || changed !== this.#changed) return;
      this.#publish({ ...this.#state, loading: false, error: "load" });
    }
  };

  #enqueue(operation: PendingOperation): Promise<void> {
    const epoch = this.#epoch;
    if (!this.#current(epoch) || this.#confirmed === undefined) return Promise.resolve();
    if (operation.kind !== "set" && this.#pending.length > 0) return Promise.resolve();
    this.#read += 1;
    this.#pending.push(operation);
    this.#project();
    const work = async (): Promise<void> => {
      if (!this.#current(epoch) || !this.#pending.includes(operation) || this.#confirmed === undefined) return;
      let error: "save" | undefined;
      const expectedRevision = this.#confirmed.revision;
      try {
        let result: JokoDesktopWallpaperSettings | undefined;
        if (operation.kind === "set") result = await this.api.set({ expectedRevision, ...operation.patch });
        else if (operation.kind === "reset") result = await this.api.reset(expectedRevision);
        else if (operation.kind === "remove") result = await this.api.remove(expectedRevision);
        else {
          const imported = await this.api.import(expectedRevision);
          if (!isImportResult(imported)) throw new TypeError("Invalid wallpaper import result.");
          if (!imported.cancelled) result = imported.settings;
        }
        if (!this.#current(epoch)) return;
        if (result !== undefined) this.#accept(normalizeWallpaperSettings(result));
      } catch {
        if (!this.#current(epoch)) return;
        error = "save";
        const changed = this.#changed;
        try {
          const settings = normalizeWallpaperSettings(await this.api.get());
          if (!this.#current(epoch)) return;
          if (changed === this.#changed) this.#accept(settings);
        } catch { /* Keep the last confirmed image when recovery also fails. */ }
      } finally {
        if (this.#current(epoch)) {
          this.#pending = this.#pending.filter((pending) => pending !== operation);
          this.#project(error);
        }
      }
    };
    this.#tail = this.#tail.then(work, work);
    return this.#tail;
  }

  setMode = (mode: JokoDesktopWallpaperSettings["mode"]): Promise<void> => {
    if (mode === "custom" && this.#confirmed?.customImage === null) return this.importImage();
    return this.#enqueue({ kind: "set", patch: { mode } });
  };
  setMaskOpacity = (value: number): Promise<void> => {
    if (!Number.isFinite(value)) return Promise.resolve();
    const maskOpacity = Math.round(Math.min(0.6, Math.max(0, value)) * 20) / 20;
    return this.#enqueue({ kind: "set", patch: { maskOpacity } });
  };
  importImage = (): Promise<void> => this.#enqueue({ kind: "import" });
  removeImage = (): Promise<void> => this.#enqueue({ kind: "remove" });
  reset = (): Promise<void> => this.#enqueue({ kind: "reset" });
}

function isImportResult(value: unknown): value is JokoDesktopWallpaperImportResult {
  if (!record(value)) return false;
  return value["cancelled"] === true ? keys(value) === "cancelled"
    : value["cancelled"] === false && keys(value) === "cancelled,settings";
}

function normalizeWallpaperSettings(value: unknown): JokoDesktopWallpaperSettings {
  if (!record(value) || keys(value) !== "customImage,maskOpacity,mode,revision,version"
    || value["version"] !== 1 || !Number.isSafeInteger(value["revision"]) || (value["revision"] as number) < 1
    || (value["mode"] !== "none" && value["mode"] !== "custom")
    || typeof value["maskOpacity"] !== "number" || !Number.isFinite(value["maskOpacity"])
    || value["maskOpacity"] < 0 || value["maskOpacity"] > 0.6
    || Math.abs(value["maskOpacity"] * 20 - Math.round(value["maskOpacity"] * 20)) > 0.000001) {
    throw new TypeError("Invalid wallpaper settings.");
  }
  const image = value["customImage"];
  if (image !== null && (!record(image) || keys(image) !== "height,id,url,width"
    || typeof image["id"] !== "string" || !/^[a-f0-9]{64}$/u.test(image["id"])
    || image["url"] !== `joko-wallpaper://image/${image["id"]}.webp`
    || !Number.isSafeInteger(image["width"]) || !Number.isSafeInteger(image["height"])
    || (image["width"] as number) < 1 || (image["width"] as number) > 3840
    || (image["height"] as number) < 1 || (image["height"] as number) > 3840)) {
    throw new TypeError("Invalid wallpaper image.");
  }
  if (value["mode"] === "custom" && image === null) throw new TypeError("Missing wallpaper image.");
  return {
    version: 1, revision: value["revision"] as number, mode: value["mode"], maskOpacity: value["maskOpacity"],
    customImage: image === null ? null : {
      id: image["id"] as string, url: image["url"] as string,
      width: image["width"] as number, height: image["height"] as number
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>): string { return Object.keys(value).sort().join(","); }
const noSubscribe = (): (() => void) => () => undefined;
const unavailableSnapshot = (): WallpaperSettingsState => UNAVAILABLE;
const noOperation = (): Promise<void> => Promise.resolve();

export function useWallpaperSettings() {
  const api = currentWallpaperApi();
  const store = useMemo(() => {
    if (api === undefined) return undefined;
    let existing = stores.get(api);
    if (existing === undefined) { existing = new WallpaperSettingsStore(api, window); stores.set(api, existing); }
    return existing;
  }, [api]);
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? unavailableSnapshot, unavailableSnapshot);
  return {
    state, reload: store?.reload ?? noOperation, setMode: store?.setMode ?? noOperation,
    setMaskOpacity: store?.setMaskOpacity ?? noOperation, importImage: store?.importImage ?? noOperation,
    removeImage: store?.removeImage ?? noOperation, reset: store?.reset ?? noOperation
  };
}
