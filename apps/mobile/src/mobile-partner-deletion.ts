import type { PartnerDeletionView, PartnerDeletionResult } from "@joko/contracts";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileConnectionProfile, MobilePlainStorageDriver } from "./connection-storage";

export interface MobilePartnerDeletionTransport {
  readonly ownerKey: string;
  newRequestId(): string;
  listRequests(signal: AbortSignal): Promise<readonly string[]>;
  delete(requestId: string, partner: MobilePartnerDirectoryProfile, confirmName: string, signal: AbortSignal): Promise<PartnerDeletionView>;
  read(requestId: string, signal: AbortSignal): Promise<PartnerDeletionResult>;
  retry(requestId: string, signal: AbortSignal): Promise<PartnerDeletionView>;
  retire(requestId: string, signal: AbortSignal): Promise<PartnerDeletionResult>;
}

type Scope = Pick<MobileConnectionProfile, "serverId" | "profileId" | "deviceId" | "origin">;
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{16,80}$/u.test(id);
/** The current node's unresolved request IDs, with no profile body or credentials. */
export class MobilePartnerDeletionReceipts {
  #tail = Promise.resolve();
  constructor(private readonly storage: MobilePlainStorageDriver) {}
  #key(scope: Scope): string {
    const origin = new URL(scope.origin);
    if (![scope.serverId, scope.profileId, scope.deviceId].every((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id))
      || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error("The Partner deletion owner is invalid.");
    }
    return `joko.mobile.partner-deletion.v1:${encodeURIComponent(JSON.stringify([scope.serverId, scope.profileId, scope.deviceId, origin.href]))}`;
  }
  async load(scope: Scope, signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted(); const raw = await this.storage.getItem(this.#key(scope)); signal.throwIfAborted();
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 32 || value.some((id) => !validId(id)) || new Set(value).size !== value.length) {
      throw new Error("The Partner deletion receipts need recovery.");
    }
    return value as string[];
  }
  #serialize(action: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(action, action); this.#tail = next.then(() => undefined, () => undefined); return next;
  }
  claim(scope: Scope, requestId: string, signal: AbortSignal): Promise<void> {
    return this.#serialize(async () => {
      if (!validId(requestId)) throw new Error("The Partner deletion request is invalid.");
      const ids = await this.load(scope, signal);
      if (ids.includes(requestId) || ids.length >= 32) throw new Error("Recover the pending Partner deletion before another dispatch.");
      signal.throwIfAborted(); const raw = JSON.stringify([...ids, requestId].sort()); const key = this.#key(scope);
      await this.storage.setItem(key, raw);
      if (await this.storage.getItem(key) !== raw) throw new Error("The Partner deletion receipt was not saved.");
      signal.throwIfAborted();
    });
  }
  resolve(scope: Scope, requestId: string, signal: AbortSignal): Promise<void> {
    return this.#serialize(async () => {
      if (!validId(requestId)) throw new Error("The Partner deletion request is invalid.");
      const ids = (await this.load(scope, signal)).filter((id) => id !== requestId);
      signal.throwIfAborted(); const key = this.#key(scope); const raw = ids.length ? JSON.stringify(ids) : null;
      if (raw === null) await this.storage.removeItem(key); else await this.storage.setItem(key, raw);
      if (await this.storage.getItem(key) !== raw) throw new Error("The Partner deletion receipt is still pending.");
      signal.throwIfAborted();
    });
  }
}
