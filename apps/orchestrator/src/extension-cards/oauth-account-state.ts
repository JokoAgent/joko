// Adapted from the fixed account metadata model. See NOTICE / LICENSE.cindy.
import { createHash } from "node:crypto";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault, EncryptedCredential } from "../credential-vault.js";

export interface ExtensionOAuthAccountRow {
  readonly id: string; readonly revision: string; readonly label?: string; readonly displayLabel?: string;
  readonly status: "connected" | "expired"; readonly expiredReason?: "client_changed"; readonly createdAt: number;
  readonly builtinClientHash: string; readonly refreshReference?: string;
  readonly authScopes: readonly string[]; readonly authFace: "full" | "subset"; readonly insufficientScopes?: readonly string[];
}
export interface ExtensionOAuthSaved {
  readonly version: 1; readonly accounts: readonly ExtensionOAuthAccountRow[];
  readonly defaultId?: string; readonly clientReference?: string;
}
export const EXTENSION_OAUTH_STATE_OWNER = "extension-oauth-accounts";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "u"), HASH_RE = /^[a-f0-9]{64}$/u;
export const EXTENSION_OAUTH_REFERENCE = new RegExp(`^extension-oauth:[a-f0-9]{64}:(?:client|refresh):${UUID}$`, "u");
export function extensionOAuthScope(extensionId: string, key: string): string { return createHash("sha256").update(JSON.stringify({ extensionId, key })).digest("hex"); }
export function extensionOAuthHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item) ?? "null").digest("hex"); }
export function extensionOAuthCredential(scope: string, role: "client" | "refresh", id: string): string {
  const reference = `extension-oauth:${scope}:${role}:${id}`; if (!EXTENSION_OAUTH_REFERENCE.test(reference)) throw new Error("OAuth credential identity is invalid."); return reference;
}
const scopesValid = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 256 && new Set(value).size === value.length
  && value.every(scope => typeof scope === "string" && scope.length > 0 && scope.length <= 200 && !/\s|[\u0000-\u001f\u007f]/u.test(scope));
const labelValid = (value: unknown) => value === undefined || typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);

/** No token or client credential bytes are stored in account metadata. */
export class ExtensionOAuthAccountState {
  constructor(private readonly options: { readonly store: OperationalStore; readonly vault: CredentialVault }) {}
  #aad(scope: string): string { return `extension-oauth:${scope}:metadata`; }
  #validate(scope: string, value: ExtensionOAuthSaved): ExtensionOAuthSaved {
    const reference = (value: unknown, role: string) => value === undefined || typeof value === "string" && new RegExp(`^extension-oauth:${scope}:${role}:${UUID}$`, "u").test(value);
    if (!HASH_RE.test(scope) || value?.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 8 || !reference(value.clientReference, "client")
      || value.accounts.some(row => !row || !UUID_RE.test(row.id) || !UUID_RE.test(row.revision) || !labelValid(row.label) || !labelValid(row.displayLabel)
        || !["connected", "expired"].includes(row.status) || row.expiredReason !== undefined && row.expiredReason !== "client_changed" || !HASH_RE.test(row.builtinClientHash)
        || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !reference(row.refreshReference, "refresh") || !scopesValid(row.authScopes)
        || !["full", "subset"].includes(row.authFace) || row.insufficientScopes !== undefined && !scopesValid(row.insufficientScopes))
      || new Set(value.accounts.map(row => row.id)).size !== value.accounts.length
      || (value.accounts.length ? !value.accounts.some(row => row.id === value.defaultId) : value.defaultId !== undefined)) throw new Error("OAuth account metadata is unavailable.");
    return value;
  }
  get(scope: string): ExtensionOAuthSaved {
    const saved = this.options.store.findSetting<EncryptedCredential>("service", EXTENSION_OAUTH_STATE_OWNER, scope)?.value;
    return saved ? this.#validate(scope, JSON.parse(this.options.vault.open(saved, this.#aad(scope))) as ExtensionOAuthSaved) : { version: 1, accounts: [] };
  }
  put(scope: string, value: ExtensionOAuthSaved): void {
    this.#validate(scope, value);
    this.options.store.setSetting("service", EXTENSION_OAUTH_STATE_OWNER, scope, this.options.vault.seal(JSON.stringify(value), this.#aad(scope)));
  }
  entries(): readonly { readonly scope: string; readonly saved: ExtensionOAuthSaved }[] {
    return this.options.store.listSettings("service", EXTENSION_OAUTH_STATE_OWNER).map(setting => ({ scope: setting.key, saved: this.get(setting.key) }));
  }
  references(): ReadonlySet<string> {
    return new Set(this.entries().flatMap(({ saved }) => [...(saved.clientReference ? [saved.clientReference] : []), ...saved.accounts.flatMap(row => row.refreshReference ? [row.refreshReference] : [])]));
  }
  remove(scope: string): void { this.options.store.deleteSetting("service", EXTENSION_OAUTH_STATE_OWNER, scope); }
}
