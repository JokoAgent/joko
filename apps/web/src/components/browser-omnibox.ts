const SEARCH_URL_PREFIX = "https://www.google.com/search?q=";

export interface BrowserOmniboxOptions {
  readonly ctrlEnter?: boolean;
}

/** URL-or-search parsing narrowed to Joko's safe HTTP(S) takeover channel. */
export function parseBrowserOmnibox(input: string, options: BrowserOmniboxOptions = {}): string {
  const value = input.trim();
  if (value === "") return "about:blank";
  const lower = value.toLowerCase();
  if (lower === "about:blank") return "about:blank";
  if (lower.startsWith("http://") || lower.startsWith("https://")) return value;

  if (options.ctrlEnter === true && /^[a-z0-9-]+$/iu.test(value)) {
    return `https://www.${value}.com`;
  }
  if (/\s/u.test(value)) return SEARCH_URL_PREFIX + encodeURIComponent(value);
  if (looksLikeHost(value)) return `https://${value}`;
  return SEARCH_URL_PREFIX + encodeURIComponent(value);
}

function looksLikeHost(value: string): boolean {
  if (value.includes(".")) return value.replace(/\./gu, "") !== "";
  const colon = value.indexOf(":");
  if (colon <= 0) return false;
  return /^\d{1,5}$/u.test(value.slice(colon + 1));
}
