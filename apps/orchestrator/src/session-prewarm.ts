import { createHash } from "node:crypto";
import type { OperationalStore, ConnectionRecord } from "@joko/store";

export const PROVISIONAL_SESSION_KEY = "session.provisional-draft.v1";
export interface ProvisionalSessionOwner {
  readonly format: 1;
  readonly draftId: string;
  readonly connectionId: string;
  readonly authKeyDigest: string;
  readonly configuration: string;
  readonly targetRevision: string;
}

export function readProvisionalSession(store: OperationalStore, sessionId: string): ProvisionalSessionOwner | undefined {
  const setting = store.findSetting("service", sessionId, PROVISIONAL_SESSION_KEY);
  if (!setting) return undefined;
  const value = setting.value as Partial<ProvisionalSessionOwner>;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== 1
    || Object.keys(value).some(key => !["format", "draftId", "connectionId", "authKeyDigest", "configuration", "targetRevision"].includes(key))
    || !validDraftId(value.draftId) || typeof value.connectionId !== "string" || !value.connectionId
    || typeof value.authKeyDigest !== "string" || !value.authKeyDigest
    || typeof value.configuration !== "string" || !/^[a-f0-9]{64}$/u.test(value.configuration)
    || typeof value.targetRevision !== "string" || !/^[1-9][0-9]*$/u.test(value.targetRevision)) {
    throw new Error("The provisional task owner is invalid.");
  }
  return value as ProvisionalSessionOwner;
}

export function assertProvisionalSessionOwner(store: OperationalStore, sessionId: string, connection: ConnectionRecord, draftId: string): ProvisionalSessionOwner {
  const owner = readProvisionalSession(store, sessionId);
  const current = store.getConnection(connection.id);
  if (!validDraftId(draftId) || !owner || owner.draftId !== draftId || owner.connectionId !== connection.id
    || owner.authKeyDigest !== connection.authKeyDigest || current.state !== "active" || current.authKeyDigest !== connection.authKeyDigest) {
    throw new Error("The unused task belongs to a different draft or connection.");
  }
  return owner;
}

export function validDraftId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/u.test(value);
}

export function provisionalConfiguration(value: {
  readonly targetId: string; readonly providerId?: string; readonly modelId?: string; readonly effort?: string;
  readonly fastMode: boolean | "ultrafast"; readonly permissionMode: string; readonly planMode: boolean;
  readonly appendSystemPrompt?: string; readonly initialPlacement?: "project" | "dialogue";
}): string {
  return createHash("sha256").update(JSON.stringify([value.targetId, value.providerId ?? "", value.modelId ?? "", value.effort ?? "",
    value.fastMode, value.permissionMode, value.planMode, value.appendSystemPrompt ?? "", value.initialPlacement ?? "project"])).digest("hex");
}

interface WarmEntry {
  readonly id: string;
  readonly close: (stillUnused: () => boolean) => Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
  starting: boolean;
}

/** Only unused native owners count here. Unknown closure retains its slot. */
export class SessionPrewarmer {
  readonly #entries = new Map<string, WarmEntry>();
  readonly #flights = new Map<string, Promise<unknown>>();
  #tail: Promise<void> = Promise.resolve();
  constructor(readonly options: { readonly maximum?: number; readonly idleMs?: number; readonly onError?: (error: unknown) => void } = {}) {}

  async start<T>(id: string, start: () => Promise<T>, close: WarmEntry["close"]): Promise<T | undefined> {
    const previous = this.#flights.get(id);
    if (previous) return previous as Promise<T | undefined>;
    const flight = this.#serial(async () => {
      const existing = this.#entries.get(id);
      if (existing) { this.#arm(existing); return undefined; }
      while (this.#entries.size >= (this.options.maximum ?? 2)) {
        const oldest = [...this.#entries.values()].find(entry => !entry.starting);
        if (!oldest || !await this.#release(oldest)) return undefined;
      }
      const entry: WarmEntry = { id, close, starting: true }; this.#entries.set(id, entry);
      try {
        const result = await start(); entry.starting = false;
        if (this.#entries.get(id) === entry) this.#arm(entry);
        return result;
      } catch (error) {
        entry.starting = false;
        // The caller's existing creation cleanup owns unknown native effects.
        // Retain capacity until it positively proves the original owner closed.
        if (this.#entries.get(id) === entry) await this.#release(entry);
        throw error;
      }
    });
    this.#flights.set(id, flight);
    try { return await flight; } finally { if (this.#flights.get(id) === flight) this.#flights.delete(id); }
  }

  touch(id: string): void { const entry = this.#entries.get(id); if (entry && !entry.starting) this.#arm(entry); }
  used(id: string): void {
    const entry = this.#entries.get(id); if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer); this.#entries.delete(id);
  }
  async settle(id: string): Promise<void> { await this.#flights.get(id); await this.#tail; }
  dispose(): void { for (const entry of this.#entries.values()) if (entry.timer) clearTimeout(entry.timer); }
  #arm(entry: WarmEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    this.#entries.delete(entry.id); this.#entries.set(entry.id, entry);
    entry.timer = setTimeout(() => { void this.#serial(() => this.#release(entry)).catch(error => this.options.onError?.(error)); }, this.options.idleMs ?? 10 * 60_000);
    entry.timer.unref?.();
  }
  async #release(entry: WarmEntry): Promise<boolean> {
    if (this.#entries.get(entry.id) !== entry) return true;
    if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined;
    try {
      const closed = await entry.close(() => this.#entries.get(entry.id) === entry);
      if (closed) { if (this.#entries.get(entry.id) === entry) this.#entries.delete(entry.id); return true; }
    } catch (error) { this.options.onError?.(error); }
    if (this.#entries.get(entry.id) === entry) this.#arm(entry);
    return false;
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action, action); this.#tail = result.then(() => undefined, () => undefined); return result;
  }
}
