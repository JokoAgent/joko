import type { Locale, LocalePreference, SystemLocale } from "./model.js";

export const DEFAULT_SYSTEM_LOCALE: SystemLocale = "en";

export interface SystemLocaleHost {
  readonly navigator?: {
    readonly languages?: readonly string[];
    readonly language?: string;
  };
  readonly jokoDesktop?: unknown;
}

function normalizeLocaleTag(raw: string | null | undefined): Intl.Locale | null {
  const tag = raw?.trim().replace(/_/g, "-").replace(/\..*$/, "");
  if (!tag) return null;

  try {
    return new Intl.Locale(tag);
  } catch {
    return null;
  }
}

function matchChineseLocale(locale: Intl.Locale): SystemLocale {
  const script = locale.script?.toLowerCase() ?? "";
  const region = locale.region?.toLowerCase() ?? "";

  // Script is authoritative when it conflicts with the region. Both branches
  // currently use zh-CN until the zh-TW catalog lands in its own parity slice.
  if (script === "hans") return "zh-CN";
  if (script === "hant") return "zh-CN";
  if (region === "cn" || region === "sg") return "zh-CN";
  if (region === "tw" || region === "hk" || region === "mo") return "zh-CN";
  return "zh-CN";
}

function matchCurrentSystemLocale(raw: string | null | undefined): SystemLocale | null {
  const locale = normalizeLocaleTag(raw);
  if (!locale) return null;

  const language = locale.language.toLowerCase();
  if (language === "zh") return matchChineseLocale(locale);
  if (language === "en") return "en";
  return null;
}

/** Map one OS/browser language tag onto the currently available catalogs. */
export function resolveSystemLocale(raw: string | null | undefined): SystemLocale {
  return matchCurrentSystemLocale(raw) ?? DEFAULT_SYSTEM_LOCALE;
}

/** Resolve the first supported entry in the host's preferred-language list. */
export function resolvePreferredSystemLocale(
  preferredLanguages: readonly string[]
): SystemLocale {
  for (const raw of preferredLanguages) {
    const locale = matchCurrentSystemLocale(raw);
    if (locale) return locale;
  }
  return DEFAULT_SYSTEM_LOCALE;
}

/** Resolve a durable preference to the concrete locale consumed by UI surfaces. */
export function resolveLocalePreference(
  preference: LocalePreference,
  systemLocale: SystemLocale
): Locale {
  return preference === "system" ? systemLocale : preference;
}

/** Read the host-owned system locale, preferring the Desktop bridge when present. */
export function readHostSystemLocale(ownerWindow?: SystemLocaleHost): SystemLocale {
  const host = ownerWindow ?? (typeof window === "undefined" ? undefined : window);
  if (!host) return DEFAULT_SYSTEM_LOCALE;

  const desktop = host.jokoDesktop;
  if (desktop && typeof desktop === "object" && "preferredSystemLocale" in desktop) {
    const preferred = (desktop as { readonly preferredSystemLocale?: unknown }).preferredSystemLocale;
    if (preferred === "en" || preferred === "zh-CN") return preferred;
  }

  const languages = host.navigator?.languages;
  if (languages && languages.length > 0) return resolvePreferredSystemLocale(languages);

  const language = host.navigator?.language;
  return resolvePreferredSystemLocale(typeof language === "string" ? [language] : []);
}
