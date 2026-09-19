import type { MobilePlainStorageDriver } from "./connection-storage";

export interface MobileComposerDraftIdentity {
  readonly profileId: string;
  readonly sessionId: string;
}

export type MobileComposerDraftErrorListener = (
  identity: MobileComposerDraftIdentity,
  error: Error
) => void;

const storagePrefix = "joko.mobile.composer-draft.v1";
const persistDebounceMilliseconds = 400;

export class MobileComposerDraftStore {
  readonly #memory = new Map<string, string>();
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

  readSync(identity: MobileComposerDraftIdentity): string | null {
    const key = identityKey(identity);
    if (this.#cleared.has(key)) return null;
    return this.#memory.get(key) ?? null;
  }

  async read(identity: MobileComposerDraftIdentity): Promise<string | null> {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    const current = this.#memory.get(key);
    if (current !== undefined) return current;
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
    if (newer !== undefined) return newer;
    if (this.#cleared.has(key) || stored === null) return null;
    this.#memory.set(key, stored);
    this.#identities.set(key, exact);
    return stored;
  }

  save(identity: MobileComposerDraftIdentity, text: string): void {
    const exact = normalizeIdentity(identity);
    const key = identityKey(exact);
    this.#cancelTimer(key);
    this.#identities.set(key, exact);
    this.#dirty.add(key);
    if (text.length === 0) {
      this.#memory.delete(key);
      this.#cleared.add(key);
      void this.#removeIfCurrent(exact).catch(() => undefined);
      return;
    }

    this.#memory.set(key, text);
    this.#cleared.delete(key);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      void this.#persistIfCurrent(exact, text).catch(() => undefined);
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
      const text = this.#memory.get(key);
      if (!exact) return;
      if (text !== undefined) await this.#persistIfCurrent(exact, text);
      else if (this.#cleared.has(key)) await this.#removeIfCurrent(exact);
    }));
    const operations = [...this.#operations.entries()]
      .filter(([key]) => selectedKey === undefined || key === selectedKey)
      .map(([, operation]) => operation);
    await Promise.all(operations);
  }

  async #persistIfCurrent(identity: MobileComposerDraftIdentity, text: string): Promise<void> {
    const key = identityKey(identity);
    if (this.#cleared.has(key) || this.#memory.get(key) !== text) return;
    await this.#enqueue(identity, () => this.driver.setItem(storageKey(identity), text));
    if (!this.#cleared.has(key) && this.#memory.get(key) === text) this.#dirty.delete(key);
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
  return `${storagePrefix}.${encodeURIComponent(identity.profileId)}.${encodeURIComponent(identity.sessionId)}`;
}

function assertLocalId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new Error(`The local Joko ${label} identity is invalid.`);
}

function storageError(action: "read" | "write", cause: unknown): Error {
  const error = new Error(`The saved task draft could not be ${action === "read" ? "read" : "written"}. Your current text was kept in memory.`);
  error.name = "MobileComposerDraftStorageError";
  if (cause instanceof Error) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export const mobileComposerDraftTesting = {
  persistDebounceMilliseconds,
  storageKey
};
