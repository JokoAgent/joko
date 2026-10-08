export const MOBILE_REMOTE_CLIPBOARD_TEXT_CHARS = 16_384;
export const MOBILE_REMOTE_CLIPBOARD_CHUNK_CHARS = 64 * 1_024;
export const MOBILE_REMOTE_CLIPBOARD_TRANSFER_CHARS = 32 * 1_024 * 1_024;
export const MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS = 60_000;

const PORTABLE_KEYS = Object.freeze(["text", "html", "rtf", "url", "png"] as const);
const PORTABLE_KEY_SET = new Set<string>(PORTABLE_KEYS);
const PNG_BASE64 = /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u;

export interface MobileRemoteClipboardItem {
  readonly text?: string;
  readonly html?: string;
  readonly rtf?: string;
  readonly url?: string;
  readonly png?: string;
}

export type MobileRemoteClipboardFailureCode =
  | "empty" | "unsupported" | "too-long" | "changed" | "retired" | "unavailable" | "failed";

export class MobileRemoteClipboardError extends Error {
  constructor(readonly code: MobileRemoteClipboardFailureCode) {
    super(`Remote Desktop clipboard ${code}.`);
  }
}

export interface MobileRemoteClipboardSystem {
  readonly richAvailable: boolean;
  readPortable(check: () => void): Promise<MobileRemoteClipboardItem>;
  writePortable(item: MobileRemoteClipboardItem, check: () => void): Promise<void>;
  readLegacyText(check: () => void): Promise<string>;
  writeLegacyText(text: string, check: () => void): Promise<void>;
}

interface LegacyClipboard {
  hasImageAsync(): Promise<boolean>;
  getStringAsync(): Promise<string>;
  setStringAsync(text: string): Promise<boolean>;
}

interface NativeRemoteClipboard {
  readClipboard?(): Promise<string>;
  writeClipboard?(json: string): Promise<void>;
}

export function createMobileRemoteClipboardSystem(
  native: NativeRemoteClipboard | null,
  legacy: LegacyClipboard
): MobileRemoteClipboardSystem {
  const richAvailable = typeof native?.readClipboard === "function"
    && typeof native.writeClipboard === "function";
  return Object.freeze({
    richAvailable,
    async readPortable(check: () => void): Promise<MobileRemoteClipboardItem> {
      if (!richAvailable) throw new MobileRemoteClipboardError("unavailable");
      check();
      let json: string;
      try {
        json = await native!.readClipboard!();
      } catch (error) {
        throw normalizeMobileRemoteClipboardError(error);
      }
      check();
      return parseMobileRemoteClipboardItem(json);
    },
    async writePortable(item: MobileRemoteClipboardItem, check: () => void): Promise<void> {
      if (!richAvailable) throw new MobileRemoteClipboardError("unavailable");
      const json = serializeMobileRemoteClipboardItem(item);
      check();
      try {
        await native!.writeClipboard!(json);
      } catch (error) {
        throw normalizeMobileRemoteClipboardError(error);
      }
      check();
    },
    async readLegacyText(check: () => void): Promise<string> {
      check();
      let hasImage: boolean;
      try {
        hasImage = await legacy.hasImageAsync();
      } catch {
        throw new MobileRemoteClipboardError("failed");
      }
      check();
      if (hasImage) throw new MobileRemoteClipboardError("unavailable");
      let text: string;
      try {
        text = await legacy.getStringAsync();
      } catch {
        throw new MobileRemoteClipboardError("failed");
      }
      check();
      return assertMobileRemoteClipboardText(text);
    },
    async writeLegacyText(text: string, check: () => void): Promise<void> {
      const value = assertMobileRemoteClipboardText(text);
      check();
      let written: boolean;
      try {
        written = await legacy.setStringAsync(value);
      } catch {
        throw new MobileRemoteClipboardError("failed");
      }
      check();
      if (!written) throw new MobileRemoteClipboardError("failed");
    }
  });
}

export function parseMobileRemoteClipboardItem(value: unknown): MobileRemoteClipboardItem {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length < 2 || value.length > MOBILE_REMOTE_CLIPBOARD_TRANSFER_CHARS) {
      throw new MobileRemoteClipboardError(value.length > MOBILE_REMOTE_CLIPBOARD_TRANSFER_CHARS
        ? "too-long" : "unsupported");
    }
    try { parsed = JSON.parse(value); }
    catch { throw new MobileRemoteClipboardError("unsupported"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MobileRemoteClipboardError("unsupported");
  }
  const source = parsed as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length < 1 || keys.length > PORTABLE_KEYS.length || keys.some((key) => !PORTABLE_KEY_SET.has(key))) {
    throw new MobileRemoteClipboardError("unsupported");
  }
  const item: Record<string, string> = {};
  for (const key of keys) {
    const content = source[key];
    if (typeof content !== "string" || content.length < 1) {
      throw new MobileRemoteClipboardError("unsupported");
    }
    item[key] = content;
  }
  if (item.url !== undefined) {
    if (!portableHttpUrl(item.url)) {
      throw new MobileRemoteClipboardError("unsupported");
    }
  }
  if (item.png !== undefined && (item.png.length % 4 !== 0 || !PNG_BASE64.test(item.png))) {
    throw new MobileRemoteClipboardError("unsupported");
  }
  const serialized = JSON.stringify(item);
  if (serialized.length > MOBILE_REMOTE_CLIPBOARD_TRANSFER_CHARS) {
    throw new MobileRemoteClipboardError("too-long");
  }
  return Object.freeze(item);
}

export function serializeMobileRemoteClipboardItem(item: MobileRemoteClipboardItem): string {
  return JSON.stringify(parseMobileRemoteClipboardItem(item));
}

export function normalizeMobileRemoteClipboardError(error: unknown): MobileRemoteClipboardError {
  if (error instanceof MobileRemoteClipboardError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("REMOTE_DESKTOP_CLIPBOARD_EMPTY")) return new MobileRemoteClipboardError("empty");
  if (message.includes("REMOTE_DESKTOP_CLIPBOARD_TOO_LONG")) return new MobileRemoteClipboardError("too-long");
  if (message.includes("REMOTE_DESKTOP_CLIPBOARD_CHANGED")) return new MobileRemoteClipboardError("changed");
  if (message.includes("REMOTE_DESKTOP_CLIPBOARD_RETIRED")) return new MobileRemoteClipboardError("retired");
  if (message.includes("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED")) return new MobileRemoteClipboardError("unsupported");
  return new MobileRemoteClipboardError("failed");
}

function assertMobileRemoteClipboardText(value: string): string {
  if (!value) throw new MobileRemoteClipboardError("empty");
  if (value.length > MOBILE_REMOTE_CLIPBOARD_TEXT_CHARS) {
    throw new MobileRemoteClipboardError("too-long");
  }
  return value;
}

function portableHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const mobileRemoteClipboardTesting = Object.freeze({ portableHttpUrl });
