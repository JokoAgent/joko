import type { MobilePlainStorageDriver } from "./connection-storage";
import {
  cloneMobileComposerDraft,
  mobileComposerDraftsEqual,
  normalizeMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";

export interface MobileComposerDraftIdentity {
  readonly profileId: string;
  readonly sessionId: string;
}

export type MobileComposerDraftErrorListener = (
  identity: MobileComposerDraftIdentity,
  error: Error
) => void;

const storagePrefix = "joko.mobile.composer-draft.v2";
const persistDebounceMilliseconds = 400;
const maximumStoredCharacters = 1_008_192;

export class MobileComposerDraftStore {
  readonly #memory = new Map<string, MobileComposerDraft>();
  readonly #cleared = new Set<string>();
  readonly #dirty = new Set<string>();
  readonly #identities = new Map<string, MobileComposerDraftIdentity>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #listeners = new Set<MobileComposerDraftErrorListener>();

  constructor(readonly driver: MobilePlainStorageDriver) {}

  subscribeErrors(listener: MobileComposerDraftErrorListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  readSync(identity: MobileComposerDraftIdentity): MobileComposerDraft | null {
    const key = identityKey(identity);
    if (this.#cleared.has(key)) return null;
    const draft = this.#memory.get(key);
    return draft === undefined ? null : cloneMobileComposerDraft(draft);
  }

  async read(identity: MobileComposerDraftIdentity): Promise<MobileComposerDraft | null> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    const current = this.#memory.get(key);
    if (current !== undefined) return cloneMobileComposerDraft(current);
    if (this.#cleared.has(key)) return null;

    let stored: string | null;
    try {
      stored = await this.driver.getItem(storageKey(exact));
    } catch (cause) {
      const error = storageError("read", cause);
      this.#notify(exact, error);
      throw error;
    }

    const newer = this.#memory.get(key);
    if (newer !== undefined) return cloneMobileComposerDraft(newer);
    if (this.#cleared.has(key) || stored === null) return null;
    try {
      const draft = readRecord(stored, exact);
      this.#memory.set(key, draft);
      this.#identities.set(key, exact);
      return cloneMobileComposerDraft(draft);
    } catch (cause) {
      const error = storageError("read", cause);
      this.#notify(exact, error);
      throw error;
    }
  }

  save(identity: MobileComposerDraftIdentity, draft: MobileComposerDraft): void {
    const exact = normalizeIdentity(identity);
    const value = normalizeMobileComposerDraft(draft);
    const key = identityKey(exact);
    this.#cancelTimer(key);
    this.#identities.set(key, exact);
    this.#dirty.add(key);
    if (value.text.length === 0 && value.mentions.length === 0) {
      this.#memory.delete(key);
      this.#cleared.add(key);
      void this.#removeIfCurrent(exact).catch(() => undefined);
      return;
    }

    const serialized = serializeRecord(exact, value);
    this.#memory.set(key, value);
    this.#cleared.delete(key);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      void this.#persistIfCurrent(exact, value, serialized).catch(() => undefined);
    }, persistDebounceMilliseconds);
    this.#timers.set(key, timer);
  }

  async clear(identity: MobileComposerDraftIdentity): Promise<void> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    this.#cancelTimer(key);
    this.#memory.delete(key);
    this.#cleared.add(key);
    this.#dirty.add(key);
    this.#identities.set(key, exact);
    await this.#removeIfCurrent(exact);
  }

  async clearIfEqual(identity: MobileComposerDraftIdentity, expected: MobileComposerDraft): Promise<boolean> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    const current = this.#memory.get(key);
    if (current === undefined || !mobileComposerDraftsEqual(current, expected)) return false;
    await this.clear(exact);
    return true;
  }

  async flush(identity?: MobileComposerDraftIdentity): Promise<void> {
    const selectedKey = identity === undefined ? undefined : identityKey(identity);
    const pending = [...this.#timers.entries()].filter(([key]) => selectedKey === undefined || key === selectedKey);
    for (const [key, timer] of pending) {
      clearTimeout(timer);
      this.#timers.delete(key);
    }
    const keys = new Set([
      ...pending.map(([key]) => key),
      ...[...this.#dirty].filter((key) => selectedKey === undefined || key === selectedKey)
    ]);
    await Promise.all([...keys].map(async (key) => {
      const exact = this.#identities.get(key);
      const draft = this.#memory.get(key);
      if (!exact) return;
      if (draft !== undefined) await this.#persistIfCurrent(exact, draft, serializeRecord(exact, draft));
      else if (this.#cleared.has(key)) await this.#removeIfCurrent(exact);
    }));
    await Promise.all([...this.#operations.entries()]
      .filter(([key]) => selectedKey === undefined || key === selectedKey)
      .map(([, operation]) => operation));
  }

  async #persistIfCurrent(
    identity: MobileComposerDraftIdentity,
    draft: MobileComposerDraft,
    serialized: string
  ): Promise<void> {
    const key = identityKey(identity);
    const current = this.#memory.get(key);
    if (this.#cleared.has(key) || current === undefined || !mobileComposerDraftsEqual(current, draft)) return;
    await this.#enqueue(identity, () => this.driver.setItem(storageKey(identity), serialized));
    const latest = this.#memory.get(key);
    if (!this.#cleared.has(key) && latest !== undefined && mobileComposerDraftsEqual(latest, draft)) this.#dirty.delete(key);
  }

  async #removeIfCurrent(identity: MobileComposerDraftIdentity): Promise<void> {
    const key = identityKey(identity);
    if (!this.#cleared.has(key) || this.#memory.has(key)) return;
    await this.#enqueue(identity, () => this.driver.removeItem(storageKey(identity)));
    if (this.#cleared.has(key) && !this.#memory.has(key)) this.#dirty.delete(key);
  }

  #enqueue(identity: MobileComposerDraftIdentity, effect: () => Promise<void>): Promise<void> {
    const key = identityKey(identity);
    const previous = this.#operations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(effect).catch((cause) => {
      const error = storageError("write", cause);
      this.#notify(identity, error);
      throw error;
    });
    this.#operations.set(key, operation);
    void operation.finally(() => {
      if (this.#operations.get(key) === operation) this.#operations.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  #cancelTimer(key: string): void {
    const timer = this.#timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(key);
  }

  #notify(identity: MobileComposerDraftIdentity, error: Error): void {
    for (const listener of this.#listeners) listener(identity, error);
  }
}

export function mobileComposerDraftIdentityKey(identity: MobileComposerDraftIdentity): string {
  return identityKey(identity);
}

function normalizeIdentity(identity: MobileComposerDraftIdentity): MobileComposerDraftIdentity {
  assertLocalId(identity.profileId, "connection profile");
  assertLocalId(identity.sessionId, "task");
  return { profileId: identity.profileId, sessionId: identity.sessionId };
}

function identityKey(identity: MobileComposerDraftIdentity): string {
  const exact = normalizeIdentity(identity);
  return `${exact.profileId}\u001f${exact.sessionId}`;
}

function storageKey(identity: MobileComposerDraftIdentity): string {
  const exact = normalizeIdentity(identity);
  return `${storagePrefix}.${encodeURIComponent(exact.profileId)}.${encodeURIComponent(exact.sessionId)}`;
}

function serializeRecord(identity: MobileComposerDraftIdentity, draft: MobileComposerDraft): string {
  const serialized = JSON.stringify({ version: 2, identity: normalizeIdentity(identity), draft: normalizeMobileComposerDraft(draft) });
  if (serialized.length > maximumStoredCharacters) throw new Error("The local Joko structured task draft is too large.");
  return serialized;
}

function readRecord(serialized: string, identity: MobileComposerDraftIdentity): MobileComposerDraft {
  if (serialized.length > maximumStoredCharacters) throw new Error("saved task draft is too large");
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || value["version"] !== 2 || !isRecord(value["identity"])
    || value["identity"]["profileId"] !== identity.profileId || value["identity"]["sessionId"] !== identity.sessionId
    || !isRecord(value["draft"]) || typeof value["draft"]["text"] !== "string"
    || !Array.isArray(value["draft"]["mentions"])) {
    throw new Error("structured task draft identity or envelope mismatch");
  }
  return normalizeMobileComposerDraft(value["draft"] as unknown as MobileComposerDraft);
}

function assertLocalId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new Error(`The local Joko ${label} identity is invalid.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storageError(action: "read" | "write", cause: unknown): Error {
  const error = new Error(`The saved structured task draft could not be ${action === "read" ? "read" : "written"}. Your current message was kept in memory.`);
  error.name = "MobileComposerDraftStorageError";
  if (cause instanceof Error) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export const mobileComposerDraftTesting = {
  persistDebounceMilliseconds,
  storageKey
};
