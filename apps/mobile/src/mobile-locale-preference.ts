import type { MobilePlainStorageDriver } from "./connection-storage";

export const MOBILE_SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;
export type MobileSupportedLocale = typeof MOBILE_SUPPORTED_LOCALES[number];
export type MobileLocalePreference = "system" | MobileSupportedLocale;

export interface MobileLocalePreferenceState {
  readonly status: "loading" | "ready" | "error";
  readonly preference: MobileLocalePreference;
  readonly effectiveLocale: MobileSupportedLocale;
  readonly saving: boolean;
  readonly error?: string;
}

const STORAGE_KEY = "joko.mobile.locale.v1";

export class MobileLocalePreferenceStore {
  #state: MobileLocalePreferenceState = {
    status: "loading",
    preference: "system",
    effectiveLocale: "en",
    saving: false
  };
  #listeners = new Set<() => void>();
  #hydrate?: Promise<void>;

  constructor(
    private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">,
    private readonly systemLocale: () => string | null | undefined = detectMobileSystemLanguageTag
  ) {
    this.#state = { ...this.#state, effectiveLocale: this.#effective("system") };
  }

  get snapshot(): MobileLocalePreferenceState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hydrate(): Promise<void> {
    if (this.#state.status !== "loading") return Promise.resolve();
    if (!this.#hydrate) this.#hydrate = this.#read();
    return this.#hydrate;
  }

  async setPreference(preference: MobileLocalePreference): Promise<void> {
    if (!isMobileLocalePreference(preference)) throw new Error("The mobile language preference is invalid.");
    if (this.#state.status === "loading") throw new Error("Wait for the mobile language preference to finish loading.");
    if (this.#state.saving) throw new Error("A mobile language change is already being saved.");
    if (this.#state.preference === preference && this.#state.status === "ready") return;
    const previous = this.#state;
    this.#publish({ ...previous, saving: true, error: undefined });
    try {
      await this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, locale: preference }));
      this.#publish({
        status: "ready",
        preference,
        effectiveLocale: this.#effective(preference),
        saving: false
      });
    } catch (cause) {
      const error = `The mobile language could not be saved: ${errorText(cause)}`;
      this.#publish({ ...previous, saving: false, error });
      throw new Error(error);
    }
  }

  refreshSystemLocale(): void {
    if (this.#state.status === "loading" || this.#state.preference !== "system" || this.#state.saving) return;
    const effectiveLocale = this.#effective("system");
    if (effectiveLocale === this.#state.effectiveLocale) return;
    this.#publish({ ...this.#state, effectiveLocale });
  }

  async #read(): Promise<void> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      const preference = raw === null ? "system" : parseMobileLocalePreference(raw);
      this.#publish({
        status: "ready",
        preference,
        effectiveLocale: this.#effective(preference),
        saving: false
      });
    } catch (cause) {
      this.#publish({
        status: "error",
        preference: "system",
        effectiveLocale: this.#effective("system"),
        saving: false,
        error: `The saved mobile language is unavailable. This phone's language is being used: ${errorText(cause)}`
      });
    }
  }

  #effective(preference: MobileLocalePreference): MobileSupportedLocale {
    if (preference !== "system") return preference;
    try { return resolveMobileSystemLocale(this.systemLocale()); }
    catch { return "en"; }
  }

  #publish(state: MobileLocalePreferenceState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export function resolveMobileSystemLocale(languageTag: string | null | undefined): MobileSupportedLocale {
  const tag = typeof languageTag === "string" ? languageTag.trim().toLowerCase().replace(/_/gu, "-") : "";
  if (tag.startsWith("zh")) {
    if (tag.includes("hant") || /(?:^|-)(?:tw|hk|mo)(?:-|$)/u.test(tag)) return "zh-TW";
    return "zh-CN";
  }
  if (tag.startsWith("ja")) return "ja";
  if (tag.startsWith("ko")) return "ko";
  return "en";
}

export function detectMobileSystemLanguageTag(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().locale; }
  catch { return undefined; }
}

function parseMobileLocalePreference(raw: string): MobileLocalePreference {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the record is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "locale" || keys[1] !== "version"
    || record.version !== 1 || !isMobileLocalePreference(record.locale)) {
    throw new Error("the record is not the strict current-v1 shape");
  }
  return record.locale;
}

function isMobileLocalePreference(value: unknown): value is MobileLocalePreference {
  return value === "system" || typeof value === "string"
    && (MOBILE_SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "storage failed";
}

export const mobileLocalePreferenceTesting = { storageKey: STORAGE_KEY };
