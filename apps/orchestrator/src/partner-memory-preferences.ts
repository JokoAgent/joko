import { redactSecrets } from "@joko/core";
import { RevisionConflictError, StoreError, type OperationalStore } from "@joko/store";
import type { CredentialVault } from "./credential-vault.js";

const key = "partner-memory.preferences";
interface SealedContext { readonly nonceHex: string; readonly ciphertextHex: string; readonly tagHex: string }
interface StoredPreferences { readonly format: 1; readonly enabled: boolean; readonly context?: SealedContext }
export interface MemoryPreferences { readonly enabled: boolean; readonly userContext?: string; readonly revision?: bigint }
export class PartnerMemoryPreferences {
  constructor(readonly store: OperationalStore, readonly vault: CredentialVault,
    readonly inheritedContext?: (partnerId: string, assertCurrent: () => void) => Promise<string>) {}
  read(targetId: string): MemoryPreferences {
    const record = this.store.findSetting<unknown>("target", targetId, key);
    if (!record) return { enabled: true };
    const value = record.value as Partial<StoredPreferences> | null;
    if (!value || value.format !== 1 || typeof value.enabled !== "boolean"
      || Object.keys(value).some(field => !["format", "enabled", "context"].includes(field))) throw new StoreError("Private memory preferences are invalid.");
    let userContext: string | undefined;
    if (value.context !== undefined) {
      const cipher = value.context;
      if (!cipher || Object.keys(cipher).some(field => !["nonceHex", "ciphertextHex", "tagHex"].includes(field))) throw new StoreError("Private memory context is invalid.");
      const bytes = (input: unknown, size?: number) => {
        if (typeof input !== "string" || input.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(input) || size !== undefined && input.length !== size * 2) throw new StoreError("Private memory context is invalid.");
        return Buffer.from(input, "hex").toString("base64");
      };
      try { userContext = this.vault.open({ algorithm: "aes-256-gcm", nonce: bytes(cipher.nonceHex, 12),
        ciphertext: bytes(cipher.ciphertextHex), tag: bytes(cipher.tagHex, 16) }, `partner-memory:${targetId}`); }
      catch { throw new StoreError("Private memory context is unavailable."); }
      validateMemoryUserContext(userContext);
    }
    return { enabled: value.enabled, userContext, revision: record.revision };
  }
  update(targetId: string, expected: bigint | undefined, patch: { readonly enabled?: boolean; readonly userContext?: string }): MemoryPreferences {
    if (patch.enabled === undefined && patch.userContext === undefined || patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new StoreError("Memory preferences patch is invalid.");
    if (patch.userContext !== undefined) validateMemoryUserContext(patch.userContext);
    return this.store.transaction(() => {
      const current = this.read(targetId);
      if (current.revision !== expected) throw new RevisionConflictError("Memory preferences", targetId, expected ?? 0n, current.revision ?? 0n);
      const enabled = patch.enabled ?? current.enabled; const userContext = patch.userContext ?? current.userContext;
      if (enabled === current.enabled && userContext === current.userContext) return current;
      const cipher = userContext === undefined ? undefined : this.vault.seal(userContext, `partner-memory:${targetId}`);
      const context: SealedContext | undefined = cipher && { nonceHex: Buffer.from(cipher.nonce, "base64").toString("hex"),
        ciphertextHex: Buffer.from(cipher.ciphertext, "base64").toString("hex"), tagHex: Buffer.from(cipher.tag, "base64").toString("hex") };
      this.store.setSetting("target", targetId, key, { format: 1, enabled, ...(context ? { context } : {}) } satisfies StoredPreferences);
      return this.read(targetId);
    });
  }
  enabled(targetId: string): boolean { return this.read(targetId).enabled; }
  remove(targetId: string): void { this.store.deleteSetting("target", targetId, key); }
}
export function validateMemoryUserContext(value: string): void {
  if (typeof value !== "string" || value.length > 12_000 || value.includes("\0") || redactSecrets(value) !== value) throw new StoreError("Memory context is invalid, too long or contains credential-like content.");
}
