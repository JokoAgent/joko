import type { OperationalStore } from "@joko/store";
import type { CredentialManager } from "./credential-manager.js";
import type { CredentialVault, EncryptedCredential } from "./credential-vault.js";
import type { ExtensionCatalogManager } from "./extension-catalog.js";
import type { ExtensionMainViewSurface } from "./extension-main-view-manager.js";
import { checkExtensionSecretCandidate } from "./extension-secret-check.js";

const MAXIMUM_BYTES = 64 * 1024;
function routingData(raw: string, redact: (value: string) => string): Record<string, unknown> {
  if (Buffer.byteLength(raw) > MAXIMUM_BYTES || redact(raw) !== raw) throw new Error("Plugin parameters must be bounded and contain no credentials.");
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin parameters must be an object.");
  let remaining = 8_192;
  const visit = (value: unknown, depth: number) => {
    if (--remaining < 0 || depth > 24) throw new Error("Plugin parameters exceed their limit.");
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Plugin parameter key is invalid.");
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0); return value as Record<string, unknown>;
}

/** Settings and runtime share their original encrypted routing-data owner. */
export class ExtensionSettingsManager {
  readonly #checks = new Map<string, number>();
  constructor(private readonly options: { readonly store: OperationalStore; readonly vault: CredentialVault;
    readonly credentials: CredentialManager; readonly catalog: ExtensionCatalogManager; readonly fetch: typeof fetch }) {}

  #assertSurface(surface: ExtensionMainViewSurface): void {
    if (!surface.authority.settings) throw new Error("This surface does not own plugin settings.");
    const current = this.options.catalog.get(surface.extensionId);
    if (!current.installed || current.owner.kind !== "resource" || current.owner.resourceId !== surface.authority.resourceId
      || current.owner.resourceVersion !== surface.authority.resourceRevision || current.owner.discoveredRevision !== surface.authority.discoveredRevision) {
      throw new Error("Plugin settings installation changed.");
    }
  }

  read(surface: ExtensionMainViewSurface): { readonly revision: string; readonly dataJson: string } {
    this.#assertSurface(surface);
    const record = this.options.store.findSetting<EncryptedCredential>("service", "extension-runtime-kv", surface.extensionId);
    if (!record) return { revision: "0", dataJson: "{}" };
    const stored = JSON.parse(this.options.vault.open(record.value, surface.extensionId)) as { version?: unknown; data?: unknown };
    if (stored.version !== 1) throw new Error("Plugin parameters are unavailable.");
    const raw = JSON.stringify(stored.data); routingData(raw, value => this.options.credentials.redactText(value));
    return { revision: record.revision.toString(), dataJson: raw };
  }

  write(surface: ExtensionMainViewSurface, expectedRevision: string, raw: string): void {
    this.#assertSurface(surface);
    if (this.read(surface).revision !== expectedRevision) throw new Error("Plugin parameters changed. Reload before saving.");
    const data = routingData(raw, value => this.options.credentials.redactText(value));
    this.options.store.setSetting("service", "extension-runtime-kv", surface.extensionId,
      this.options.vault.seal(JSON.stringify({ version: 1, data }), surface.extensionId));
  }

  validateRoutingData(raw: string): void { routingData(raw, value => this.options.credentials.redactText(value)); }

  #secret(surface: ExtensionMainViewSurface, key: string) {
    this.#assertSurface(surface);
    const declaration = this.options.catalog.get(surface.extensionId).runtime?.network;
    const secret = declaration?.secrets?.find(secret => secret.key === key && secret.source !== "oauth" && secret.check !== undefined);
    if (!secret || !declaration) throw new Error("This plugin does not declare credential validation.");
    return { declaration, secret };
  }
  beginCheck(surface: ExtensionMainViewSurface, key: string, connectionId: string) {
    this.#secret(surface, key);
    return this.options.credentials.createUploadTicket({ maximumBytes: MAXIMUM_BYTES, connectionId, kind: "header_secret",
      servicePurpose: `extension-settings-check:${surface.id}:${key}` });
  }
  async check(surface: ExtensionMainViewSurface, key: string, ticketId: string, connectionId: string,
    signal: AbortSignal, assertCurrent: () => void) {
    const { declaration, secret } = this.#secret(surface, key), id = surface.extensionId;
    if ((this.#checks.get(id) ?? 0) >= 2) throw new Error("Two credential checks are already running for this plugin.");
    this.#checks.set(id, (this.#checks.get(id) ?? 0) + 1);
    try {
      signal.throwIfAborted(); assertCurrent();
      const value = this.options.credentials.consumeServiceInput({ credentialUploadTicketId: ticketId, connectionId, kind: "header_secret",
        servicePurpose: `extension-settings-check:${surface.id}:${key}` });
      return await checkExtensionSecretCandidate({ declaration, secret, value, fetch: this.options.fetch, signal,
        assertCurrent: () => { assertCurrent(); this.#secret(surface, key); } });
    } finally {
      const count = (this.#checks.get(id) ?? 1) - 1; if (count > 0) this.#checks.set(id, count); else this.#checks.delete(id);
    }
  }
}
