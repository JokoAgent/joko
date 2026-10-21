import { createHash, randomUUID } from "node:crypto";
import type { OperationalStore } from "@joko/store";
import type { CredentialManager } from "../credential-manager.js";
import { extensionConnectionCredentialReference, extensionConnectionScope, normalizeExtensionConnectionHost, type ExtensionNetworkConnection } from "./network-manifest.js";

interface Row { readonly id: string; readonly credentialId: string; readonly host: string; readonly label?: string; readonly createdAt: number }
interface Saved { readonly version: 1; readonly rows: readonly Row[]; readonly defaultId?: string }
export interface ExtensionConnectionView {
  readonly id: string; readonly host: string; readonly label?: string; readonly isDefault: boolean; readonly configured: boolean;
  readonly changeId: string;
}
export interface ExtensionConnectionReservation {
  readonly extensionId: string; readonly declaration: ExtensionNetworkConnection; readonly row: Row;
  readonly reference: string; readonly previous: string;
  readonly previousReference?: string;
}
const OWNER = "extension-network-connections", UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** Addresses are metadata; all token bytes remain in the existing Credential
 * owner. A declaration change cannot repurpose another slot's credential. */
export class ExtensionNetworkConnections {
  constructor(private readonly options: { readonly store: OperationalStore; readonly credentials: CredentialManager }) {}
  #load(extensionId: string, declaration: ExtensionNetworkConnection): Saved {
    const saved = this.options.store.findSetting<Saved>("service", OWNER, extensionConnectionScope(extensionId, declaration))?.value;
    if (!saved) return { version: 1, rows: [] };
    if (saved.version !== 1 || !Array.isArray(saved.rows) || saved.rows.length > 8
      || saved.rows.some(row => !row || !UUID.test(row.id) || !UUID.test(row.credentialId) || normalizeExtensionConnectionHost(row.host) !== row.host
        || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || row.label !== undefined && (!row.label.trim() || row.label.length > 64 || /[\u0000-\u001f\u007f]/u.test(row.label)))
      || new Set(saved.rows.map(row => row.id)).size !== saved.rows.length || new Set(saved.rows.map(row => row.host)).size !== saved.rows.length
      || (saved.rows.length > 0 ? !saved.rows.some(row => row.id === saved.defaultId) : saved.defaultId !== undefined)) throw new Error("Extension connection metadata is unavailable.");
    return structuredClone(saved);
  }
  #write(extensionId: string, declaration: ExtensionNetworkConnection, value: Saved): void {
    this.options.store.setSetting("service", OWNER, extensionConnectionScope(extensionId, declaration), value);
  }
  #reference(extensionId: string, declaration: ExtensionNetworkConnection, row: Row): string {
    return extensionConnectionCredentialReference(extensionId, declaration, `${row.id}:${row.credentialId}`);
  }
  #revision(extensionId: string, declaration: ExtensionNetworkConnection, saved = this.#load(extensionId, declaration)): string {
    return createHash("sha256").update(JSON.stringify({ saved, credentials: saved.rows.map(row => this.options.credentials.find(this.#reference(extensionId, declaration, row))?.generation ?? null) })).digest("hex");
  }
  list(extensionId: string, declaration: ExtensionNetworkConnection): readonly ExtensionConnectionView[] {
    const saved = this.#load(extensionId, declaration);
    return saved.rows.map(row => ({ id: row.id, host: row.host, ...(row.label ? { label: row.label } : {}), isDefault: row.id === saved.defaultId,
      changeId: row.credentialId, configured: this.options.credentials.find(this.#reference(extensionId, declaration, row))?.kind === "header_secret" }));
  }
  identity(extensionId: string, declaration: ExtensionNetworkConnection): string { return this.#revision(extensionId, declaration); }
  /** Metadata references let the settings owner reserve and retire its own
   * credentials after restart, including a crash before a staged commit. */
  references(): ReadonlySet<string> {
    const references = new Set<string>();
    for (const setting of this.options.store.listSettings("service", OWNER)) {
      const saved = setting.value as Saved;
      if (!/^[a-f0-9]{64}$/u.test(setting.key) || saved?.version !== 1 || !Array.isArray(saved.rows)) throw new Error("Extension connection metadata is unavailable.");
      for (const row of saved.rows) {
        if (!UUID.test(row.id) || !UUID.test(row.credentialId)) throw new Error("Extension connection metadata is unavailable.");
        references.add(`extension-connection:${setting.key}:${row.id}:${row.credentialId}`);
      }
    }
    return references;
  }
  prune(scopes: ReadonlySet<string>): void {
    for (const setting of this.options.store.listSettings("service", OWNER)) {
      if (!scopes.has(setting.key)) this.options.store.deleteSetting("service", OWNER, setting.key);
    }
  }
  authorization(extensionId: string, declaration: ExtensionNetworkConnection): string | undefined {
    const rows = this.list(extensionId, declaration); return rows.length && rows.every(row => row.configured) ? this.#revision(extensionId, declaration) : undefined;
  }
  reserve(extensionId: string, declaration: ExtensionNetworkConnection, input: { readonly host: string; readonly label?: string }): ExtensionConnectionReservation {
    const host = normalizeExtensionConnectionHost(input.host), saved = this.#load(extensionId, declaration), existing = saved.rows.find(row => row.host === host);
    if (!existing && saved.rows.length >= (declaration.maxConnections ?? 8)) throw new Error("Extension connection limit reached.");
    if (input.label !== undefined && (input.label.length > 64 || /[\u0000-\u001f\u007f]/u.test(input.label))) throw new Error("Extension connection label is invalid.");
    const label = input.label === undefined ? existing?.label : input.label.trim() || undefined;
    const row: Row = { id: existing?.id ?? randomUUID(), credentialId: randomUUID(), host, createdAt: existing?.createdAt ?? Date.now(), ...(label ? { label } : {}) };
    return { extensionId, declaration: structuredClone(declaration), row, reference: this.#reference(extensionId, declaration, row),
      ...(existing ? { previousReference: this.#reference(extensionId, declaration, existing) } : {}), previous: createHash("sha256").update(JSON.stringify(saved)).digest("hex") };
  }
  install(reservation: ExtensionConnectionReservation): void {
    const { extensionId, declaration, row } = reservation, saved = this.#load(extensionId, declaration);
    // The staged token is unreachable until the caller atomically commits this
    // metadata pointer with its original catalog authority.
    if (!UUID.test(row.id) || !UUID.test(row.credentialId) || normalizeExtensionConnectionHost(row.host) !== row.host || reservation.reference !== this.#reference(extensionId, declaration, row)
      || reservation.previous !== createHash("sha256").update(JSON.stringify(saved)).digest("hex")
      || this.options.credentials.find(reservation.reference)?.kind !== "header_secret") throw new Error("Extension connection credential is unavailable.");
    const existing = saved.rows.find(value => value.host === row.host);
    if (existing && existing.id !== row.id || !existing && saved.rows.length >= (declaration.maxConnections ?? 8)) throw new Error("Extension connection changed before installation.");
    this.#write(extensionId, declaration, { version: 1, rows: existing ? saved.rows.map(value => value.id === row.id ? row : value) : [...saved.rows, row], defaultId: saved.defaultId ?? row.id });
  }
  hosts(extensionId: string, declaration: ExtensionNetworkConnection): readonly string[] { return this.#load(extensionId, declaration).rows.map(row => row.host); }
  token(extensionId: string, declaration: ExtensionNetworkConnection, hostname: string): string | undefined {
    const host = normalizeExtensionConnectionHost(hostname), row = this.#load(extensionId, declaration).rows.find(row => row.host === host);
    if (!row) return;
    const reference = this.#reference(extensionId, declaration, row);
    if (this.options.credentials.find(reference)?.kind !== "header_secret") return;
    return this.options.credentials.resolve(reference);
  }
  setDefault(extensionId: string, declaration: ExtensionNetworkConnection, id: string): void {
    const saved = this.#load(extensionId, declaration); if (!saved.rows.some(row => row.id === id)) throw new Error("Extension connection is unavailable.");
    this.#write(extensionId, declaration, { ...saved, defaultId: id });
  }
  remove(extensionId: string, declaration: ExtensionNetworkConnection, id: string): string | undefined {
    const saved = this.#load(extensionId, declaration); if (!saved.rows.some(row => row.id === id)) return;
    const rows = saved.rows.filter(row => row.id !== id);
    this.#write(extensionId, declaration, { version: 1, rows, ...(rows.length ? { defaultId: saved.defaultId === id ? rows[0]!.id : saved.defaultId! } : {}) });
    return this.#reference(extensionId, declaration, saved.rows.find(row => row.id === id)!);
  }
}
