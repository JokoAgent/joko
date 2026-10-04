import type { DesktopSystemLocale } from "./channels.js";

const DEFAULT_DESKTOP_SYSTEM_LOCALE: DesktopSystemLocale = "en";

export interface DesktopSystemLocaleSource {
  getPreferredSystemLanguages(): readonly string[];
  getLocale(): string;
}

/** Resolve the current Desktop catalog locale without exposing the raw OS language list. */
export function resolveDesktopPreferredSystemLocale(
  rawLocales: readonly (string | null | undefined)[]
): DesktopSystemLocale {
  for (const rawLocale of rawLocales) {
    const matched = matchDesktopSystemLocale(rawLocale);
    if (matched !== null) return matched;
  }
  return DEFAULT_DESKTOP_SYSTEM_LOCALE;
}

/** Read Electron's ordered preference list, falling back to its single locale only when empty. */
export function readDesktopPreferredSystemLocale(
  source: DesktopSystemLocaleSource
): DesktopSystemLocale {
  let preferredLanguages: readonly string[] = [];
  try {
    preferredLanguages = source.getPreferredSystemLanguages();
  } catch {
    // Electron can reject locale reads before app readiness; use the bounded fallback below.
  }
  if (preferredLanguages.length > 0) {
    return resolveDesktopPreferredSystemLocale(preferredLanguages);
  }

  try {
    return resolveDesktopPreferredSystemLocale([source.getLocale()]);
  } catch {
    return DEFAULT_DESKTOP_SYSTEM_LOCALE;
  }
}

function matchDesktopSystemLocale(rawLocale: string | null | undefined): DesktopSystemLocale | null {
  const locale = normalizeLocale(rawLocale);
  if (locale === null) return null;

  const language = locale.language.toLowerCase();
  if (language === "en") return "en";
  if (language !== "zh") return null;

  const script = locale.script?.toLowerCase() ?? "";
  const region = locale.region?.toLowerCase() ?? "";
  // Script is authoritative when it conflicts with region. The current Desktop catalog has
  // only Simplified Chinese, so both Chinese families intentionally project to zh-CN until
  // the Traditional Chinese catalog lands; neither path may leak an unsupported locale.
  if (script === "hans") return "zh-CN";
  if (script === "hant") return "zh-CN";
  if (region === "cn" || region === "sg") return "zh-CN";
  if (region === "tw" || region === "hk" || region === "mo") return "zh-CN";
  return "zh-CN";
}

function normalizeLocale(rawLocale: string | null | undefined): Intl.Locale | null {
  const normalized = rawLocale?.trim().replaceAll("_", "-").replace(/\..*$/u, "");
  if (!normalized) return null;
  try {
    return new Intl.Locale(normalized);
  } catch {
    return null;
  }
}
