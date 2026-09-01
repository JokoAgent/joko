import type { DesktopAttentionKey } from "./channels.js";

export const MAXIMUM_DESKTOP_ATTENTION_KEYS = 512;
export const MAXIMUM_DESKTOP_ATTENTION_KEY_CHARACTERS = 256;

export interface DesktopAttentionPresentation {
  clear(): void;
  show(count: number, signal: boolean): void;
}

export function parseDesktopAttentionKey(value: unknown): DesktopAttentionKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Desktop attention key must be an exact object.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "ownerId,sessionId") {
    throw new TypeError("Desktop attention key must contain only ownerId and sessionId.");
  }
  if (!isBoundedIdentity(candidate["ownerId"]) || !isBoundedIdentity(candidate["sessionId"])) {
    throw new TypeError("Desktop attention owner and task identities must be bounded exact strings.");
  }
  return Object.freeze({ ownerId: candidate["ownerId"], sessionId: candidate["sessionId"] });
}

export class DesktopAttentionBadgeController {
  readonly #presentation: DesktopAttentionPresentation;
  readonly #maximumKeys: number;
  readonly #keysBySource = new Map<number, Map<string, DesktopAttentionKey>>();
  #foreground = true;
  #presentedCount = 0;
  #disposed = false;

  constructor(presentation: DesktopAttentionPresentation, maximumKeys = MAXIMUM_DESKTOP_ATTENTION_KEYS) {
    if (!Number.isSafeInteger(maximumKeys) || maximumKeys < 1) {
      throw new RangeError("Desktop attention key capacity must be a positive safe integer.");
    }
    this.#presentation = presentation;
    this.#maximumKeys = maximumKeys;
  }

  get count(): number {
    return this.#uniqueKeys().size;
  }

  mark(sourceId: number, key: DesktopAttentionKey): void {
    this.#assertActiveSource(sourceId);
    const token = attentionKeyToken(key);
    let sourceKeys = this.#keysBySource.get(sourceId);
    if (sourceKeys?.has(token) === true) return;
    const uniqueKeys = this.#uniqueKeys();
    if (!uniqueKeys.has(token) && uniqueKeys.size >= this.#maximumKeys) {
      throw new RangeError("Desktop attention key capacity was reached.");
    }
    if (sourceKeys === undefined) {
      sourceKeys = new Map();
      this.#keysBySource.set(sourceId, sourceKeys);
    }
    sourceKeys.set(token, key);
    this.#render(true);
  }

  clear(sourceId: number, key: DesktopAttentionKey): void {
    this.#assertActiveSource(sourceId);
    const sourceKeys = this.#keysBySource.get(sourceId);
    if (sourceKeys === undefined || !sourceKeys.delete(attentionKeyToken(key))) return;
    if (sourceKeys.size === 0) this.#keysBySource.delete(sourceId);
    this.#render(false);
  }

  releaseSource(sourceId: number): void {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !this.#keysBySource.delete(sourceId)) return;
    this.#render(false);
  }

  setForeground(foreground: boolean): void {
    if (this.#disposed || this.#foreground === foreground) return;
    this.#foreground = foreground;
    this.#render(false, true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#keysBySource.clear();
    this.#presentedCount = 0;
    this.#safeClear();
  }

  #assertActiveSource(sourceId: number): void {
    if (this.#disposed) throw new Error("Desktop attention badge is disposed.");
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) {
      throw new TypeError("Desktop attention source identity must be a positive safe integer.");
    }
  }

  #uniqueKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const sourceKeys of this.#keysBySource.values()) {
      for (const token of sourceKeys.keys()) keys.add(token);
    }
    return keys;
  }

  #render(signal: boolean, force = false): void {
    const count = this.count;
    if (this.#foreground || count === 0) {
      if (force || this.#presentedCount !== 0) this.#safeClear();
      this.#presentedCount = 0;
      return;
    }
    if (!force && count === this.#presentedCount && !signal) return;
    try {
      this.#presentation.show(count, signal && count > this.#presentedCount);
      this.#presentedCount = count;
    } catch {
      this.#presentedCount = 0;
      this.#safeClear();
    }
  }

  #safeClear(): void {
    try {
      this.#presentation.clear();
    } catch {
      // Native badge support is optional. Failure must not affect task state.
    }
  }
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= MAXIMUM_DESKTOP_ATTENTION_KEY_CHARACTERS && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function attentionKeyToken(key: DesktopAttentionKey): string {
  return JSON.stringify([key.ownerId, key.sessionId]);
}
