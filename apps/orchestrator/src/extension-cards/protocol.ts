export const EXTENSION_CARD_HTML_MAX_BYTES = 32 * 1024;
export const EXTENSION_CARD_HEIGHT_MIN = 120;
export const EXTENSION_CARD_HEIGHT_MAX = 900;
export const EXTENSION_CARD_HEIGHT_DEFAULT = 240;
export const EXTENSION_CARD_MIN_INTERVAL_MS = 1000;
export const EXTENSION_CARD_WORKING_WINDOW_MS = 30 * 60_000;
export const EXTENSION_CARD_REOPEN_WINDOW_MS = 600_000;
export const EXTENSION_CARD_ACTION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
export const EXTENSION_CARD_ACTION_INFLIGHT_MS = 8000;
export const EXTENSION_CARD_ACTION_PROMPT_MAX_LEN = 2000;
export const EXTENSION_CARD_PROMPT_PLACEHOLDER_MAX_LEN = 128;
export const EXTENSION_CARD_SPAWN_SEP = "::sp";
export const EXTENSION_CARD_ID_KEY = "joko_card_id";

export function extensionCardRootCallId(callId: string): string {
  const index = callId.indexOf(EXTENSION_CARD_SPAWN_SEP);
  return index === -1 ? callId : callId.slice(0, index);
}
export function isExtensionCardLinkAllowed(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !!url.hostname; }
  catch { return false; }
}
