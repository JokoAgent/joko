import type { ExtensionCatalogManager } from "../extension-catalog.js";
import type { CredentialManager } from "../credential-manager.js";
import { ExtensionNetworkConnections, type ExtensionConnectionReservation } from "./network-connections.js";
import { extensionConnectionScope } from "./network-manifest.js";

interface Ticket {
  readonly reservation: ExtensionConnectionReservation;
  readonly revision: bigint;
  readonly authority: string;
  readonly connectionId: string;
  readonly expiresAt: number;
  pending?: Promise<ReturnType<ExtensionNetworkSettings["get"]>>;
}

/** Formal settings are the only writer. The plugin SDK sees address metadata;
 * credential bytes enter through the paired Connection's protected channel. */
export class ExtensionNetworkSettings {
  readonly #tickets = new Map<string, Ticket>();
  readonly #references = new Set<string>();
  #cleanup = Promise.resolve();
  #unsubscribe?: () => void;
  #stopped = false;
  constructor(private readonly options: {
    readonly catalog: ExtensionCatalogManager;
    readonly connections: ExtensionNetworkConnections;
    readonly credentials: CredentialManager;
  }) {}

  async initialize(): Promise<void> {
    for (const reference of this.options.connections.references()) this.#reserve(reference);
    // Reservations are process-local. Orphaned staged credentials from an
    // interrupted commit are discoverable before they become public records.
    for (const credential of this.options.credentials.list()) {
      if (/^extension-connection:[a-f0-9]{64}:[a-f0-9-]{36}:[a-f0-9-]{36}$/u.test(credential.credentialReferenceId)) this.#reserve(credential.credentialReferenceId);
    }
    await this.#reconcile();
    this.#unsubscribe = this.options.catalog.onAuthorityChanged(() => { this.#cleanup = this.#cleanup.then(() => this.#reconcile()).catch(() => undefined); });
  }
  #reserve(reference: string): void {
    this.options.credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "header_secret" });
    this.#references.add(reference);
  }
  #extension(extensionId: string, revision?: bigint) {
    if (this.#stopped) throw new Error("Extension connection settings stopped.");
    const extension = this.options.catalog.get(extensionId);
    if (!extension.installed || extension.owner.kind !== "resource" || revision !== undefined && extension.revision !== revision) throw new Error("Extension installation changed.");
    return extension;
  }
  get(extensionId: string) {
    const extension = this.#extension(extensionId);
    return { extensionId, revision: { value: extension.revision }, slots: (extension.runtime?.network?.connections ?? []).map(declaration => ({
      key: declaration.key, label: declaration.label, ...(declaration.hint ? { hint: declaration.hint } : {}), maximumConnections: declaration.maxConnections ?? 8,
      connections: this.options.connections.list(extensionId, declaration).map(({ id, host, label, isDefault, configured }) => ({ connectionId: id, host, ...(label ? { label } : {}), isDefault, configured }))
    })) };
  }
  #slot(extensionId: string, revision: bigint, slotKey: string) {
    const extension = this.#extension(extensionId, revision), declaration = extension.runtime?.network?.connections?.find(value => value.key === slotKey);
    if (!declaration) throw new Error("Extension connection type is unavailable.");
    return declaration;
  }
  #authority(extensionId: string, revision: bigint): string {
    const extension = this.#extension(extensionId, revision);
    return JSON.stringify({ owner: extension.owner, network: extension.runtime?.network }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  }
  #assertTicket(ticket: Ticket): void {
    if (this.#authority(ticket.reservation.extensionId, ticket.revision) !== ticket.authority) throw new Error("Extension connection owner changed.");
    this.#slot(ticket.reservation.extensionId, ticket.revision, ticket.reservation.declaration.key);
  }
  begin(input: { readonly extensionId: string; readonly revision: bigint; readonly slotKey: string; readonly host: string; readonly label?: string; readonly connectionId: string }) {
    const declaration = this.#slot(input.extensionId, input.revision, input.slotKey);
    this.#purge();
    if (this.#tickets.size >= 64) throw new Error("Too many pending extension connection changes.");
    const reservation = this.options.connections.reserve(input.extensionId, declaration, input);
    this.#reserve(reservation.reference);
    const ticket = this.options.credentials.createUploadTicket({ maximumBytes: 16_384, kind: "header_secret", connectionId: input.connectionId, credentialReferenceId: reservation.reference });
    this.#tickets.set(ticket.credentialUploadTicketId, { reservation, revision: input.revision, authority: this.#authority(input.extensionId, input.revision), connectionId: input.connectionId, expiresAt: ticket.expiresAt });
    return ticket;
  }
  commit(extensionId: string, ticketId: string, connectionId: string, assertCurrent: () => void): Promise<ReturnType<ExtensionNetworkSettings["get"]>> {
    this.#purge();
    const ticket = this.#tickets.get(ticketId);
    if (!ticket || ticket.connectionId !== connectionId || ticket.reservation.extensionId !== extensionId) throw new Error("Extension connection upload is unavailable.");
    assertCurrent(); this.#assertTicket(ticket);
    if (ticket.pending) return ticket.pending;
    ticket.pending = this.#commit(ticketId, ticket, assertCurrent);
    return ticket.pending;
  }
  async #commit(ticketId: string, ticket: Ticket, assertCurrent: () => void) {
    const { reservation, revision, connectionId } = ticket, { extensionId, reference } = reservation;
    let installed = false;
    try {
      assertCurrent(); this.#assertTicket(ticket);
      await this.options.credentials.commitManagedUpload({ credentialUploadTicketId: ticketId, credentialReferenceId: reference, displayName: reservation.declaration.label, kind: "header_secret", connectionId });
      const value = this.options.credentials.resolve(reference);
      if (!value || /[\r\n\u0000]/u.test(value)) throw new Error("Extension connection token is invalid.");
      assertCurrent(); this.#assertTicket(ticket);
      this.options.catalog.updateNetworkConfiguration(extensionId, revision, () => this.options.connections.install(reservation));
      installed = true;
      return this.get(extensionId);
    } finally {
      this.#tickets.delete(ticketId);
      if (!installed) await this.#retire(reference);
      else if (reservation.previousReference) await this.#retire(reservation.previousReference);
    }
  }
  async change(input: { readonly extensionId: string; readonly revision: bigint; readonly slotKey: string; readonly id: string; readonly action: "remove" | "default" }, assertCurrent: () => void) {
    const declaration = this.#slot(input.extensionId, input.revision, input.slotKey);
    assertCurrent(); let removed: string | undefined;
    this.options.catalog.updateNetworkConfiguration(input.extensionId, input.revision, () => {
      if (input.action === "remove") removed = this.options.connections.remove(input.extensionId, declaration, input.id);
      else this.options.connections.setDefault(input.extensionId, declaration, input.id);
    });
    if (removed) await this.#retire(removed);
    return this.get(input.extensionId);
  }
  #purge(): void {
    for (const [id, ticket] of this.#tickets) if (!ticket.pending && ticket.expiresAt <= Date.now()) this.#tickets.delete(id);
  }
  async #retire(reference: string): Promise<void> {
    if (!this.#references.has(reference)) this.#reserve(reference);
    const generation = this.options.credentials.find(reference)?.generation;
    if (await this.options.credentials.retireManagedCredential(reference, generation)) this.#references.delete(reference);
  }
  async #reconcile(): Promise<void> {
    if (this.#stopped) return;
    this.#purge();
    const scopes = new Set(this.options.catalog.snapshot().entries.flatMap(extension => extension.installed && extension.owner.kind === "resource"
      ? (extension.runtime?.network?.connections ?? []).map(declaration => extensionConnectionScope(extension.id, declaration)) : []));
    this.options.connections.prune(scopes);
    for (const reference of [...this.#references]) {
      const retained = this.options.connections.references();
      if (!retained.has(reference) && ![...this.#tickets.values()].some(ticket => ticket.reservation.reference === reference)) await this.#retire(reference);
    }
  }
  async dispose(): Promise<void> {
    if (this.#stopped) return;
    this.#unsubscribe?.(); this.#stopped = true;
    const pending = [...this.#tickets.values()].flatMap(ticket => ticket.pending ? [ticket.pending] : []);
    this.#tickets.clear();
    await Promise.allSettled(pending);
    await this.#cleanup;
    for (const reference of [...this.#references]) if (!this.options.connections.references().has(reference)) await this.#retire(reference);
  }
}
