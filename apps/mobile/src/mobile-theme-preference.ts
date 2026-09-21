import type { MobilePlainStorageDriver } from "./connection-storage";

export type MobileThemePreference = "system" | "light" | "dark";

export interface MobileThemePreferenceState {
  readonly status: "loading" | "ready" | "error";
  readonly preference: MobileThemePreference;
  readonly saving: boolean;
  readonly error?: string;
}

const STORAGE_KEY = "joko.mobile.theme.v1";

export class MobileThemePreferenceStore {
  #state: MobileThemePreferenceState = { status: "loading", preference: "system", saving: false };
  #listeners = new Set<() => void>();
  #hydrate?: Promise<void>;

  constructor(private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">) {}

  get snapshot(): MobileThemePreferenceState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hydrate(): Promise<void> {
    if (this.#state.status !== "loading") return Promise.resolve();
    if (this.#hydrate) return this.#hydrate;
    this.#hydrate = this.#read();
    return this.#hydrate;
  }

  async setPreference(preference: MobileThemePreference): Promise<void> {
    if (!isMobileThemePreference(preference)) throw new Error("The mobile theme preference is invalid.");
    if (this.#state.status === "loading") throw new Error("Wait for the mobile theme preference to finish loading.");
    if (this.#state.saving) throw new Error("A mobile theme change is already being saved.");
    if (this.#state.preference === preference && this.#state.status === "ready") return;
    const previous = this.#state;
    this.#publish({ ...previous, saving: true, error: undefined });
    try {
      await this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, theme: preference }));
      this.#publish({ status: "ready", preference, saving: false });
    } catch (cause) {
      const error = `The mobile theme could not be saved: ${errorText(cause)}`;
      this.#publish({ ...previous, saving: false, error });
      throw new Error(error);
    }
  }

  async #read(): Promise<void> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      const preference = raw === null ? "system" : parseMobileThemePreference(raw);
      this.#publish({ status: "ready", preference, saving: false });
    } catch (cause) {
      this.#publish({
        status: "error",
        preference: "system",
        saving: false,
        error: `The saved mobile theme is unavailable. System appearance is being used: ${errorText(cause)}`
      });
    }
  }

  #publish(state: MobileThemePreferenceState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export function resolveMobileDarkTheme(
  preference: MobileThemePreference,
  systemScheme: "light" | "dark" | "unspecified" | null | undefined
): boolean {
  return preference === "dark" || preference === "system" && systemScheme === "dark";
}

function parseMobileThemePreference(raw: string): MobileThemePreference {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the record is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "theme" || keys[1] !== "version"
    || record.version !== 1 || !isMobileThemePreference(record.theme)) {
    throw new Error("the record is not the current v1 shape");
  }
  return record.theme;
}

function isMobileThemePreference(value: unknown): value is MobileThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "storage failed";
}
