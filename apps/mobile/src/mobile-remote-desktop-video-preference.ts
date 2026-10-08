import AsyncStorage from "@react-native-async-storage/async-storage";

export interface MobileRemoteDesktopVideoSettings {
  readonly fps: 30 | 60;
  readonly quality: "auto" | "saver" | "hd";
  readonly audio: boolean;
}

export interface MobileRemoteDesktopVideoPreferenceState {
  readonly status: "loading" | "ready" | "error";
  readonly settings: MobileRemoteDesktopVideoSettings;
  readonly saving: boolean;
  readonly error?: string;
}

export interface MobileRemoteDesktopVideoPreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export const MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS: MobileRemoteDesktopVideoSettings =
  Object.freeze({ fps: 30, quality: "auto", audio: true });

const STORAGE_KEY = "joko.mobile.remote-desktop.audio.v1";

/** Per-viewer settings store. Only audio is durable; quality resets for every screen occurrence. */
export class MobileRemoteDesktopVideoPreferenceStore {
  #state: MobileRemoteDesktopVideoPreferenceState = {
    status: "loading",
    settings: MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS,
    saving: false
  };
  readonly #listeners = new Set<() => void>();
  #hydrate?: Promise<void>;
  #edited = false;
  #writeSequence = 0;
  #writes: Promise<void> = Promise.resolve();

  constructor(private readonly storage: MobileRemoteDesktopVideoPreferenceStorage) {}

  get snapshot(): MobileRemoteDesktopVideoPreferenceState { return this.#state; }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  hydrate(): Promise<void> {
    this.#hydrate ??= this.#read();
    return this.#hydrate;
  }

  update(settings: MobileRemoteDesktopVideoSettings): void {
    if (!isMobileRemoteDesktopVideoSettings(settings)) {
      throw new Error("The Remote Desktop video settings are invalid.");
    }
    const previous = this.#state.settings;
    this.#edited = true;
    this.#publish({
      status: this.#state.status === "loading" ? "loading" : "ready",
      settings: Object.freeze({ ...settings }),
      saving: previous.audio !== settings.audio || this.#state.saving,
      error: undefined
    });
    if (previous.audio === settings.audio) return;
    const sequence = ++this.#writeSequence;
    const encoded = JSON.stringify({ version: 1, audio: settings.audio });
    this.#writes = this.#writes
      .catch(() => undefined)
      .then(() => this.storage.setItem(STORAGE_KEY, encoded))
      .then(() => {
        if (sequence === this.#writeSequence) {
          this.#publish({ ...this.#state, status: "ready", saving: false, error: undefined });
        }
      })
      .catch((cause) => {
        if (sequence === this.#writeSequence) {
          this.#publish({ ...this.#state, status: "error", saving: false,
            error: `The Remote Desktop audio preference could not be saved: ${errorText(cause)}` });
        }
      });
  }

  async #read(): Promise<void> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (this.#edited) {
        this.#publish({ ...this.#state, status: "ready" });
        return;
      }
      const audio = raw === null ? true : parseAudioPreference(raw);
      this.#publish({ status: "ready", settings: Object.freeze({
        ...MOBILE_REMOTE_DESKTOP_DEFAULT_VIDEO_SETTINGS,
        audio
      }), saving: false });
    } catch (cause) {
      this.#publish({ ...this.#state, status: "error", saving: false,
        error: `The saved Remote Desktop audio preference is unavailable: ${errorText(cause)}` });
    }
  }

  #publish(state: MobileRemoteDesktopVideoPreferenceState): void {
    this.#state = Object.freeze(state);
    for (const listener of this.#listeners) listener();
  }
}

export function createMobileRemoteDesktopVideoPreferenceStore(): MobileRemoteDesktopVideoPreferenceStore {
  return new MobileRemoteDesktopVideoPreferenceStore({
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value)
  });
}

export function isMobileRemoteDesktopVideoSettings(
  value: unknown
): value is MobileRemoteDesktopVideoSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return (settings.fps === 30 || settings.fps === 60)
    && (settings.quality === "auto" || settings.quality === "saver" || settings.quality === "hd")
    && typeof settings.audio === "boolean";
}

function parseAudioPreference(raw: string): boolean {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the record is not an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "audio" || keys[1] !== "version"
    || record.version !== 1 || typeof record.audio !== "boolean") {
    throw new Error("the record is not the current v1 shape");
  }
  return record.audio;
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "storage failed";
}
