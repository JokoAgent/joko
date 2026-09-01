import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  provisionManagedCatalog,
  type PiManagedProvider,
  type PiManagedSettings
} from "@joko/adapter-pi";
import type { OperationalStore } from "@joko/store";

import { CredentialVault, type EncryptedCredential } from "./credential-vault.js";
import {
  ProviderModelDiscoveryError,
  fetchProviderModels,
  type ProviderModelDiscoverySpec
} from "./provider-model-discovery.js";
import {
  PROVIDER_ACCOUNT_USAGE_CAPABILITY,
  type ProviderAccountUsageCredential,
  type ProviderAccountUsageCredentialIdentity
} from "./provider-account-usage.js";

export type CredentialKind = "api_key" | "oauth" | "subscription" | "local_keyless" | "header_secret" | "ssh_private_key";

export interface CredentialDescriptor {
  readonly credentialReferenceId: string;
  /** Service-only opaque ciphertext generation; changes on every durable replacement. */
  readonly generation: string;
  readonly displayName: string;
  readonly kind: CredentialKind;
  readonly providerId?: string;
  readonly configured: boolean;
  readonly expiresAt?: number;
  readonly lastRefreshedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error?: string;
}

interface StoredCredential extends Omit<CredentialDescriptor, "configured" | "generation" | "error"> {
  readonly sealed: EncryptedCredential;
}

interface CredentialFile {
  readonly format: 1;
  readonly records: readonly StoredCredential[];
}

interface UploadTicket {
  readonly id: string;
  readonly expiresAt: number;
  readonly maximumBytes: number;
  readonly kind?: CredentialKind;
  readonly providerId?: string;
  readonly connectionId?: string;
  readonly credentialReferenceId?: string;
  providerLoginInput?: {
    readonly flowId: string;
    readonly promptId: string;
  };
  sealed?: EncryptedCredential;
  consumed: boolean;
}

interface ManagedCredentialReservation {
  readonly kind: CredentialKind;
  readonly providerId?: string;
}

export interface CredentialManagerOptions {
  readonly vault: CredentialVault;
  readonly storagePath: string;
  readonly ticketTtlMs?: number;
  readonly maximumSecretBytes?: number;
  readonly now?: () => number;
}

/**
 * Owns the only durable secret-bearing file in Orchestrator. Upload tickets are
 * memory-only, short lived and single use; durable records contain AES-GCM
 * ciphertext bound to their opaque reference.
 */
export class CredentialManager {
  readonly #vault: CredentialVault;
  readonly #storagePath: string;
  readonly #ticketTtlMs: number;
  readonly #maximumSecretBytes: number;
  readonly #now: () => number;
  readonly #tickets = new Map<string, UploadTicket>();
  readonly #records = new Map<string, StoredCredential>();
  readonly #managedReferences = new Map<string, ManagedCredentialReservation>();
  #initialized = false;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: CredentialManagerOptions) {
    if (!isAbsolute(options.storagePath) || resolve(options.storagePath) !== options.storagePath) {
      throw new Error("Credential storage path must be a normalized absolute path.");
    }
    this.#vault = options.vault;
    this.#storagePath = options.storagePath;
    this.#ticketTtlMs = options.ticketTtlMs ?? 5 * 60_000;
    this.#maximumSecretBytes = options.maximumSecretBytes ?? 64 * 1024;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#ticketTtlMs) || this.#ticketTtlMs < 1_000) {
      throw new RangeError("Credential ticket lifetime must be at least one second.");
    }
    if (!Number.isSafeInteger(this.#maximumSecretBytes) || this.#maximumSecretBytes < 1) {
      throw new RangeError("Credential maximum size must be a positive integer.");
    }
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const parent = dirname(this.#storagePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Credential storage directory must be a regular directory.");
    }
    const canonicalParent = await realpath(parent);
    if (!samePath(canonicalParent, parent)) {
      throw new Error("Credential storage directory contains a path alias or junction.");
    }
    let parsed: CredentialFile | undefined;
    try {
      parsed = JSON.parse(await readFile(this.#storagePath, "utf8")) as CredentialFile;
    } catch (error) {
      if (!isMissing(error)) throw new Error("Credential record file is unreadable.", { cause: error });
    }
    if (parsed !== undefined) {
      if (parsed.format !== 1 || !Array.isArray(parsed.records)) throw new Error("Credential record file has an unsupported format.");
      for (const candidate of parsed.records) {
        const record = validateStoredCredential(candidate);
        if (this.#records.has(record.credentialReferenceId)) throw new Error("Credential record file contains duplicate references.");
        // Verify authentication tags at startup without retaining plaintext.
        void this.#vault.open(record.sealed, record.credentialReferenceId);
        this.#records.set(record.credentialReferenceId, record);
      }
    }
    this.#initialized = true;
  }

  createUploadTicket(input: number | {
    readonly maximumBytes?: number;
    readonly kind?: CredentialKind;
    readonly providerId?: string;
    readonly connectionId?: string;
    readonly credentialReferenceId?: string;
  } = {}): {
    readonly credentialUploadTicketId: string;
    readonly expiresAt: number;
    readonly maximumBytes: number;
  } {
    this.#assertInitialized();
    this.#purgeTickets();
    const options = typeof input === "number" ? { maximumBytes: input } : input;
    const maximumBytes = options.maximumBytes ?? this.#maximumSecretBytes;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > this.#maximumSecretBytes) {
      throw new RangeError("Credential upload size is outside the configured limit.");
    }
    if (options.kind !== undefined) validateCredentialKind(options.kind);
    const id = randomBytes(24).toString("base64url");
    const expiresAt = this.#now() + this.#ticketTtlMs;
    this.#tickets.set(id, {
      id,
      expiresAt,
      maximumBytes,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.providerId === undefined ? {} : { providerId: nonBlank(options.providerId, "Provider ID") }),
      ...(options.connectionId === undefined ? {} : { connectionId: nonBlank(options.connectionId, "Connection ID") }),
      ...(options.credentialReferenceId === undefined ? {} : { credentialReferenceId: normalizeReference(options.credentialReferenceId) }),
      consumed: false
    });
    return { credentialUploadTicketId: id, expiresAt, maximumBytes };
  }

  /**
   * Creates a short-lived, memory-only ticket for an OAuth prompt answer.
   * Its sealed value can only be consumed by the exact flow/prompt/connection
   * tuple and can never be committed as a durable CredentialDescriptor.
   */
  createProviderLoginInputTicket(input: {
    readonly flowId: string;
    readonly promptId: string;
    readonly connectionId: string;
    readonly maximumBytes?: number;
  }): {
    readonly credentialUploadTicketId: string;
    readonly expiresAt: number;
    readonly maximumBytes: number;
  } {
    const ticket = this.createUploadTicket({
      maximumBytes: input.maximumBytes ?? Math.min(16 * 1024, this.#maximumSecretBytes),
      connectionId: nonBlank(input.connectionId, "Connection ID")
    });
    const stored = this.#tickets.get(ticket.credentialUploadTicketId);
    if (stored === undefined) throw new Error("Credential upload ticket was not created.");
    stored.providerLoginInput = {
      flowId: nonBlank(input.flowId, "Provider login flow ID"),
      promptId: nonBlank(input.promptId, "Provider login prompt ID")
    };
    return ticket;
  }

  /** Called only by the credential upload endpoint; no secret is returned. */
  upload(credentialUploadTicketId: string, value: string, connectionId?: string): void {
    this.#assertInitialized();
    const ticket = this.#requireTicket(credentialUploadTicketId);
    if (ticket.connectionId !== undefined && ticket.connectionId !== connectionId) {
      throw new Error("Credential upload ticket belongs to a different connection.");
    }
    if (ticket.sealed !== undefined) throw new Error("Credential upload ticket has already received a value.");
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes === 0 || bytes > ticket.maximumBytes || value.includes("\0")) {
      throw new Error("Credential value is empty or exceeds the upload policy.");
    }
    ticket.sealed = this.#vault.seal(value, ticketReference(ticket.id));
  }

  /** Strict UTF-8 variant for an application/octet-stream credential route. */
  uploadBytes(credentialUploadTicketId: string, value: Uint8Array, connectionId?: string): void {
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(value); }
    catch { throw new Error("Credential upload must be valid UTF-8."); }
    this.upload(credentialUploadTicketId, decoded, connectionId);
  }

  /** Consumes an ephemeral OAuth prompt value without creating a durable record. */
  consumeProviderLoginInput(input: {
    readonly credentialUploadTicketId: string;
    readonly flowId: string;
    readonly promptId: string;
    readonly connectionId: string;
  }): string {
    this.#assertInitialized();
    const ticket = this.#requireTicket(input.credentialUploadTicketId);
    const binding = ticket.providerLoginInput;
    if (
      binding === undefined ||
      binding.flowId !== input.flowId ||
      binding.promptId !== input.promptId ||
      ticket.connectionId !== input.connectionId
    ) {
      throw new Error("Provider login input ticket does not match the active prompt.");
    }
    if (ticket.sealed === undefined) throw new Error("Provider login input ticket has no uploaded value.");
    const value = this.#vault.open(ticket.sealed, ticketReference(ticket.id));
    ticket.consumed = true;
    this.#tickets.delete(ticket.id);
    return value;
  }

  async commitUpload(input: {
    readonly credentialUploadTicketId: string;
    readonly credentialReferenceId?: string;
    readonly displayName: string;
    readonly kind: CredentialKind;
    readonly providerId?: string;
    readonly expiresAt?: number;
    readonly connectionId?: string;
  }): Promise<CredentialDescriptor> {
    this.#assertInitialized();
    const ticket = this.#requireTicket(input.credentialUploadTicketId);
    if (ticket.providerLoginInput !== undefined) {
      throw new Error("Provider login input tickets cannot be committed as credentials.");
    }
    if (ticket.sealed === undefined) throw new Error("Credential upload ticket has no uploaded value.");
    if (ticket.kind !== undefined && ticket.kind !== input.kind) throw new Error("Credential upload ticket is bound to a different credential kind.");
    if (ticket.providerId !== undefined && ticket.providerId !== input.providerId) throw new Error("Credential upload ticket is bound to a different provider.");
    if (ticket.connectionId !== undefined && ticket.connectionId !== input.connectionId) throw new Error("Credential upload ticket is bound to a different connection.");
    const reference = normalizeReference(input.credentialReferenceId ?? `cred_${randomUUID()}`);
    this.#assertUserManagedReference(reference);
    const displayName = nonBlank(input.displayName, "Credential display name");
    validateCredentialKind(input.kind);
    const now = this.#now();
    if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) {
      throw new Error("Credential expiry must be in the future.");
    }
    const secret = this.#vault.open(ticket.sealed, ticketReference(ticket.id));
    try {
      const previous = this.#records.get(reference);
      const record: StoredCredential = {
        credentialReferenceId: reference,
        displayName,
        kind: input.kind,
        ...(input.providerId === undefined ? {} : { providerId: nonBlank(input.providerId, "Provider ID") }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        lastRefreshedAt: now,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        sealed: this.#vault.seal(secret, reference)
      };
      await this.#mutate(async () => {
        this.#records.set(reference, record);
        try {
          await this.#persist();
        } catch (error) {
          if (previous === undefined) this.#records.delete(reference);
          else this.#records.set(reference, previous);
          throw error;
        }
      });
      ticket.consumed = true;
      this.#tickets.delete(ticket.id);
      return descriptor(record, now);
    } finally {
      // JavaScript strings cannot be zeroed; do not retain or interpolate it.
    }
  }

  async replaceSecret(
    credentialReferenceId: string,
    secret: string,
    input: { readonly expiresAt?: number; readonly refreshedAt?: number } = {}
  ): Promise<CredentialDescriptor> {
    this.#assertInitialized();
    const reference = normalizeReference(credentialReferenceId);
    this.#assertUserManagedReference(reference);
    const current = this.#requireRecord(reference);
    if (Buffer.byteLength(secret, "utf8") === 0 || Buffer.byteLength(secret, "utf8") > this.#maximumSecretBytes) {
      throw new Error("Replacement credential value is outside the configured limit.");
    }
    const now = input.refreshedAt ?? this.#now();
    if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) {
      throw new Error("Replacement credential expiry must be in the future.");
    }
    const { expiresAt: _previousExpiry, ...withoutExpiry } = current;
    const updated: StoredCredential = {
      ...withoutExpiry,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      lastRefreshedAt: now,
      updatedAt: now,
      sealed: this.#vault.seal(secret, reference)
    };
    await this.#mutate(async () => {
      this.#records.set(reference, updated);
      try {
        await this.#persist();
      } catch (error) {
        this.#records.set(reference, current);
        throw error;
      }
    });
    return descriptor(updated, this.#now());
  }

  /** Commits a ticket into an exact service-owned credential reservation. */
  async commitManagedUpload(input: {
    readonly credentialUploadTicketId: string;
    readonly credentialReferenceId: string;
    readonly displayName: string;
    readonly kind: CredentialKind;
    readonly providerId?: string;
    readonly connectionId?: string;
  }): Promise<CredentialDescriptor> {
    this.#assertInitialized();
    const ticket = this.#requireTicket(input.credentialUploadTicketId);
    if (ticket.providerLoginInput !== undefined) {
      throw new Error("Provider login input tickets cannot be committed as credentials.");
    }
    if (ticket.sealed === undefined) throw new Error("Credential upload ticket has no uploaded value.");
    if (ticket.kind !== undefined && ticket.kind !== input.kind) throw new Error("Credential upload ticket is bound to a different credential kind.");
    if (ticket.providerId !== undefined && ticket.providerId !== input.providerId) throw new Error("Credential upload ticket is bound to a different provider.");
    if (ticket.connectionId !== undefined && ticket.connectionId !== input.connectionId) throw new Error("Credential upload ticket is bound to a different connection.");
    const reference = normalizeReference(input.credentialReferenceId);
    const providerId = input.providerId === undefined ? undefined : nonBlank(input.providerId, "Provider ID");
    if (ticket.credentialReferenceId !== reference) {
      throw new Error("Credential upload ticket is bound to a different managed credential surface.");
    }
    this.#assertManagedReservation(reference, input.kind, providerId);
    const displayName = nonBlank(input.displayName, "Credential display name");
    validateCredentialKind(input.kind);
    const now = this.#now();
    const secret = this.#vault.open(ticket.sealed, ticketReference(ticket.id));
    try {
      const previous = this.#records.get(reference);
      const record: StoredCredential = {
        credentialReferenceId: reference,
        displayName,
        kind: input.kind,
        ...(providerId === undefined ? {} : { providerId }),
        lastRefreshedAt: now,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        sealed: this.#vault.seal(secret, reference)
      };
      await this.#mutate(async () => {
        this.#records.set(reference, record);
        try {
          await this.#persist();
        } catch (error) {
          if (previous === undefined) this.#records.delete(reference);
          else this.#records.set(reference, previous);
          throw error;
        }
      });
      ticket.consumed = true;
      this.#tickets.delete(ticket.id);
      return descriptor(record, now);
    } finally {
      // JavaScript strings cannot be zeroed; do not retain or interpolate it.
    }
  }

  /** Atomic adapter-owned rotation that never exposes plaintext outside Orchestrator memory. */
  async compareAndSetManagedSecret(input: {
    readonly credentialReferenceId: string;
    readonly expectedSecret: string | undefined;
    readonly secret: string;
    readonly displayName: string;
    readonly kind: CredentialKind;
    readonly providerId?: string;
    readonly expiresAt: number;
  }): Promise<boolean> {
    this.#assertInitialized();
    const reference = normalizeReference(input.credentialReferenceId);
    const displayName = nonBlank(input.displayName, "Credential display name");
    validateCredentialKind(input.kind);
    const providerId = input.providerId === undefined ? undefined : nonBlank(input.providerId, "Provider ID");
    this.#assertManagedReservation(reference, input.kind, providerId);
    const byteLength = Buffer.byteLength(input.secret, "utf8");
    if (byteLength === 0 || byteLength > this.#maximumSecretBytes || input.secret.includes("\0")) {
      throw new Error("Managed credential value is outside the configured limit.");
    }
    const now = this.#now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw new Error("Managed credential expiry must be in the future.");
    }
    return this.#mutate(async () => {
      const current = this.#records.get(reference);
      const matches = input.expectedSecret === undefined
        ? current === undefined
        : current !== undefined
          && constantTimeTextEqual(this.#vault.open(current.sealed, reference), input.expectedSecret);
      if (!matches) return false;
      const updated: StoredCredential = {
        credentialReferenceId: reference,
        displayName,
        kind: input.kind,
        ...(providerId === undefined ? {} : { providerId }),
        expiresAt: input.expiresAt,
        lastRefreshedAt: now,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        sealed: this.#vault.seal(input.secret, reference)
      };
      this.#records.set(reference, updated);
      try {
        await this.#persist();
      } catch (error) {
        if (current === undefined) this.#records.delete(reference);
        else this.#records.set(reference, current);
        throw error;
      }
      return true;
    });
  }

  async deleteManagedSecretIfCurrent(
    credentialReferenceId: string,
    expectedSecret: string
  ): Promise<boolean> {
    this.#assertInitialized();
    const reference = normalizeReference(credentialReferenceId);
    if (!this.#managedReferences.has(reference)) {
      throw new Error("Managed credential reference is not reserved by an adapter.");
    }
    return this.#mutate(async () => {
      const current = this.#records.get(reference);
      if (current === undefined
        || !constantTimeTextEqual(this.#vault.open(current.sealed, reference), expectedSecret)) return false;
      this.#records.delete(reference);
      try {
        await this.#persist();
      } catch (error) {
        this.#records.set(reference, current);
        throw error;
      }
      return true;
    });
  }

  async deleteManagedSecret(credentialReferenceId: string): Promise<boolean> {
    this.#assertInitialized();
    const reference = normalizeReference(credentialReferenceId);
    if (!this.#managedReferences.has(reference)) {
      throw new Error("Managed credential reference is not reserved by an adapter.");
    }
    const current = this.#records.get(reference);
    if (current === undefined) return false;
    await this.#mutate(async () => {
      this.#records.delete(reference);
      try {
        await this.#persist();
      } catch (error) {
        this.#records.set(reference, current);
        throw error;
      }
    });
    return true;
  }

  /** Exact rollback for an adapter-owned record; an already-expired prior value remains expired. */
  async restoreManagedSecretExact(input: {
    readonly credentialReferenceId: string;
    readonly expectedSecret: string;
    readonly secret: string;
    readonly displayName: string;
    readonly kind: CredentialKind;
    readonly providerId?: string;
    readonly expiresAt: number;
  }): Promise<boolean> {
    this.#assertInitialized();
    const reference = normalizeReference(input.credentialReferenceId);
    const displayName = nonBlank(input.displayName, "Credential display name");
    validateCredentialKind(input.kind);
    const providerId = input.providerId === undefined ? undefined : nonBlank(input.providerId, "Provider ID");
    this.#assertManagedReservation(reference, input.kind, providerId);
    const byteLength = Buffer.byteLength(input.secret, "utf8");
    if (byteLength === 0 || byteLength > this.#maximumSecretBytes || input.secret.includes("\0")) {
      throw new Error("Managed credential value is outside the configured limit.");
    }
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) {
      throw new Error("Managed credential rollback expiry is invalid.");
    }
    return this.#mutate(async () => {
      const current = this.#records.get(reference);
      if (current === undefined
        || !constantTimeTextEqual(this.#vault.open(current.sealed, reference), input.expectedSecret)) return false;
      const now = this.#now();
      const restored: StoredCredential = {
        credentialReferenceId: reference,
        displayName,
        kind: input.kind,
        ...(providerId === undefined ? {} : { providerId }),
        expiresAt: input.expiresAt,
        lastRefreshedAt: now,
        createdAt: current.createdAt,
        updatedAt: now,
        sealed: this.#vault.seal(input.secret, reference)
      };
      this.#records.set(reference, restored);
      try {
        await this.#persist();
      } catch (error) {
        this.#records.set(reference, current);
        throw error;
      }
      return true;
    });
  }

  resolve(credentialReferenceId: string): string {
    this.#assertInitialized();
    const record = this.#requireRecord(normalizeReference(credentialReferenceId));
    if (record.expiresAt !== undefined && record.expiresAt <= this.#now()) throw new Error("Credential is expired.");
    return this.#vault.open(record.sealed, record.credentialReferenceId);
  }

  /**
   * Reads an expired credential only for a provider-native refresh operation.
   * Request-serving code must continue to use resolve(), which enforces expiry.
   */
  resolveForRefresh(credentialReferenceId: string): string {
    this.#assertInitialized();
    const record = this.#requireRecord(normalizeReference(credentialReferenceId));
    return this.#vault.open(record.sealed, record.credentialReferenceId);
  }

  find(credentialReferenceId: string): CredentialDescriptor | undefined {
    this.#assertInitialized();
    const record = this.#records.get(credentialReferenceId);
    return record === undefined ? undefined : descriptor(record, this.#now());
  }

  list(filter: { readonly providerId?: string; readonly kind?: CredentialKind } = {}): readonly CredentialDescriptor[] {
    this.#assertInitialized();
    const now = this.#now();
    return [...this.#records.values()]
      .filter((record) => !this.#managedReferences.has(record.credentialReferenceId))
      .filter((record) => filter.providerId === undefined || record.providerId === filter.providerId)
      .filter((record) => filter.kind === undefined || record.kind === filter.kind)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en") || left.credentialReferenceId.localeCompare(right.credentialReferenceId, "en"))
      .map((record) => descriptor(record, now));
  }

  async delete(credentialReferenceId: string): Promise<boolean> {
    this.#assertInitialized();
    const reference = normalizeReference(credentialReferenceId);
    this.#assertUserManagedReference(reference);
    const previous = this.#records.get(reference);
    if (previous === undefined) return false;
    await this.#mutate(async () => {
      this.#records.delete(reference);
      try {
        await this.#persist();
      } catch (error) {
        this.#records.set(reference, previous);
        throw error;
      }
    });
    return true;
  }

  reserveManagedSecret(input: {
    readonly credentialReferenceId: string;
    readonly kind: CredentialKind;
    readonly providerId?: string;
  }): void {
    this.#assertInitialized();
    const reference = normalizeReference(input.credentialReferenceId);
    validateCredentialKind(input.kind);
    const providerId = input.providerId === undefined ? undefined : nonBlank(input.providerId, "Provider ID");
    const existingReservation = this.#managedReferences.get(reference);
    if (existingReservation !== undefined) {
      this.#assertManagedReservation(reference, input.kind, providerId);
      return;
    }
    const record = this.#records.get(reference);
    if (record !== undefined && (record.kind !== input.kind || record.providerId !== providerId)) {
      throw new Error("Managed credential reference has an unexpected persisted owner.");
    }
    this.#managedReferences.set(reference, {
      kind: input.kind,
      ...(providerId === undefined ? {} : { providerId })
    });
  }

  redactText(text: string): string {
    this.#assertInitialized();
    let result = text;
    for (const record of this.#records.values()) {
      const secret = this.#vault.open(record.sealed, record.credentialReferenceId);
      for (const fragment of secretFragments(secret)) {
        result = result.split(fragment).join("[REDACTED]");
      }
    }
    return result;
  }

  #requireTicket(id: string): UploadTicket {
    this.#purgeTickets();
    const ticket = this.#tickets.get(id);
    if (ticket === undefined || ticket.consumed || ticket.expiresAt <= this.#now()) {
      throw new Error("Credential upload ticket is invalid, expired, or already consumed.");
    }
    return ticket;
  }

  #requireRecord(reference: string): StoredCredential {
    const record = this.#records.get(reference);
    if (record === undefined) throw new Error("Credential reference does not exist.");
    return record;
  }

  #assertUserManagedReference(reference: string): void {
    if (this.#managedReferences.has(reference)) {
      throw new Error("Adapter-owned credentials must be changed through their Provider account operation.");
    }
  }

  #assertManagedReservation(reference: string, kind: CredentialKind, providerId: string | undefined): void {
    const reservation = this.#managedReferences.get(reference);
    if (reservation === undefined || reservation.kind !== kind || reservation.providerId !== providerId) {
      throw new Error("Managed credential reference is not reserved for this adapter account.");
    }
  }

  #purgeTickets(): void {
    const now = this.#now();
    for (const [id, ticket] of this.#tickets) if (ticket.expiresAt <= now || ticket.consumed) this.#tickets.delete(id);
  }

  async #persist(): Promise<void> {
    const body = JSON.stringify({
      format: 1,
      records: [...this.#records.values()].sort((left, right) => left.credentialReferenceId.localeCompare(right.credentialReferenceId, "en"))
    } satisfies CredentialFile, null, 2) + "\n";
    const temporary = join(dirname(this.#storagePath), `.${randomUUID()}.credential.tmp`);
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, this.#storagePath);
      await chmod(this.#storagePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("Credential record persistence failed.", { cause: error });
    }
  }

  #mutate<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.#writeTail.then(callback, callback);
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Credential manager is not initialized.");
  }
}

export type ProviderKind = "managed" | "api_key" | "oauth" | "subscription" | "local_keyless" | "custom_endpoint";
export type ProviderAuthenticationState = "not_required" | "signed_out" | "pending" | "authenticated" | "expired" | "refreshing" | "error";
export type ProviderLoginMethod = "api_key" | "oauth_browser" | "device_code" | "subscription";

function nativeProviderLoginMethods(
  advertised: readonly ProviderLoginMethod[] | undefined,
  kind: ProviderKind
): readonly ProviderLoginMethod[] {
  const methods = advertised ?? (kind === "api_key"
    ? ["api_key" as const]
    : kind === "oauth"
      ? ["oauth_browser" as const, "device_code" as const]
      : kind === "subscription" ? ["subscription" as const] : []);
  const supported = new Set<ProviderLoginMethod>(["api_key", "oauth_browser", "device_code", "subscription"]);
  if (methods.some((method) => !supported.has(method)) || new Set(methods).size !== methods.length) {
    throw new Error("Pi native Provider login methods are invalid.");
  }
  return [...methods];
}

export interface ManagedProviderEntry {
  readonly provider: PiManagedProvider;
  readonly displayName: string;
  readonly kind: ProviderKind;
  /** Environment variable name -> opaque credential reference. */
  readonly credentialBindings: Readonly<Record<string, string>>;
  /** OAuth/subscription credential consumed by Pi's native ModelRuntime. */
  readonly nativeCredentialReferenceId?: string;
  readonly enabled: boolean;
  readonly supportsLogin: boolean;
  readonly supportsLogout: boolean;
  readonly supportsRefresh: boolean;
  readonly version: bigint;
  readonly updatedAt: number;
  readonly error?: string;
}

interface StoredProviderEntry extends Omit<ManagedProviderEntry, "version" | "provider" | "credentialBindings"> {
  readonly version: string;
  readonly provider: Omit<PiManagedProvider, "headers"> & {
    readonly headerEnvironmentReferences?: readonly { readonly headerName: string; readonly environmentName: string }[];
  };
  readonly credentialEnvironmentReferences: readonly {
    readonly environmentName: string;
    readonly credentialReferenceId: string;
  }[];
}

interface StoredProviderCatalog {
  readonly format: 1;
  readonly generation: number;
  readonly entries: readonly StoredProviderEntry[];
}

interface StoredNativeProviderAuthEntry {
  readonly providerId: string;
  readonly displayName: string;
  readonly kind: "api_key" | "oauth" | "subscription" | "local_keyless";
  readonly credentialReferenceId?: string;
  readonly version: string;
  readonly updatedAt: number;
}

interface StoredNativeProviderAuthCatalog {
  readonly format: 1;
  readonly entries: readonly StoredNativeProviderAuthEntry[];
}

interface NativeProviderAuthEntry {
  readonly providerId: string;
  readonly displayName: string;
  readonly kind: "api_key" | "oauth" | "subscription" | "local_keyless";
  readonly credentialReferenceId?: string;
  readonly version: bigint;
  readonly updatedAt: number;
  /** Authoritative runtime metadata is intentionally not persisted. */
  readonly runtimeProvider?: PiManagedProvider;
  /** Runtime-only native catalog capability; never inferred from a Provider ID. */
  readonly modelRefreshAvailable?: boolean;
  /** Runtime-only Provider/account capability declared by the native auth catalog. */
  readonly accountUsageAvailable?: boolean;
  /** Runtime-only native login methods; never inferred from a Provider ID. */
  readonly loginMethods?: readonly ProviderLoginMethod[];
}

export interface NativeProviderAuthRegistration {
  readonly provider: PiManagedProvider;
  readonly displayName: string;
  /** Runtime-native catalog entry. Native credentials never enter models.json. */
  readonly kind: "api_key" | "oauth" | "subscription" | "local_keyless";
  readonly modelRefreshAvailable?: boolean;
  readonly accountUsageAvailable?: boolean;
  readonly loginMethods?: readonly ProviderLoginMethod[];
}

export interface NativePiOAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export interface NativePiApiKeyCredential {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type NativePiCredential = NativePiOAuthCredential | NativePiApiKeyCredential;

export interface NativePiAuthLoadResult {
  readonly catalogGeneration: number;
  readonly credentials: Readonly<Record<string, NativePiCredential>>;
}

export interface NativePiAuthPersistResult {
  readonly catalogGeneration: number;
  readonly credentialReferenceId: string;
  readonly expiresAt?: number;
}

export class ProviderAuthGenerationConflictError extends Error {
  readonly code = "STALE_PROVIDER_AUTH_GENERATION";

  constructor(readonly expectedGeneration: number, readonly actualGeneration: number) {
    super("Pi native Provider credential generation is stale.");
    this.name = "ProviderAuthGenerationConflictError";
  }
}

export interface ProviderDescriptor extends Omit<ManagedProviderEntry, "credentialBindings"> {
  readonly credentialReferenceIds: readonly string[];
  readonly authenticationState: ProviderAuthenticationState;
  readonly credentialExpiresAt?: number;
  readonly supportsModelRefresh?: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly loginMethods?: readonly ProviderLoginMethod[];
}

export interface ProviderModelDiscoveryResult {
  readonly providerId: string;
  readonly addedModelIds: readonly string[];
  readonly modelCount: number;
}

export interface ProviderLoginFlow {
  readonly providerId: string;
  readonly method: ProviderLoginMethod;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly expiresAt?: number;
  readonly opaqueFlowId: string;
}

/** Native auth orchestration is injected after the catalog has initialized. */
export interface ProviderNativeAuthSupervisor {
  canHandle(providerId: string): boolean;
  beginLogin(providerId: string, method: ProviderLoginFlow["method"]): Promise<ProviderLoginFlow>;
  refreshCredential(providerId: string): Promise<void>;
  logout(providerId: string): Promise<void>;
}

/** A stable, non-secret signal that a native Pi auth surface cannot be represented safely. */
export class ProviderAuthUnsupportedError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY";

  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthUnsupportedError";
  }
}

export interface ProviderCatalogManagerOptions {
  readonly store: OperationalStore;
  readonly credentials: CredentialManager;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly loginHandlers?: Readonly<Record<string, (method: ProviderLoginFlow["method"]) => Promise<ProviderLoginFlow>>>;
  readonly nativeAuth?: ProviderNativeAuthSupervisor;
  readonly providerEnabled?: (providerId: string) => boolean;
  readonly modelEnabled?: (providerId: string, modelId: string) => boolean;
}

export interface PiProviderGenerationSnapshot {
  readonly catalogGeneration: number;
  readonly agentHome: string;
  readonly providers: readonly PiManagedProvider[];
  /** Authoritative Pi built-ins eligible for native credential injection; never written to models.json. */
  readonly nativeAuthProviderIds: readonly string[];
  /** Non-secret subset whose current public authentication state is authenticated. */
  readonly nativeAuthenticatedProviderIds: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly secretEnvironmentNames: readonly string[];
}

/** In-process only. This secret-bearing route must never cross Connect or Store. */
export interface OpenAiEmbeddingRoute {
  readonly providerId: string;
  /**
   * Non-secret identity of the exact Provider configuration generation used
   * to produce vectors. A Provider ID/model pair is not sufficient because
   * credentials, endpoints, and declared model metadata can change in place.
   */
  readonly generationId: string;
  readonly modelId: string;
  readonly endpoint: string;
  readonly authorization?: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** In-process only route used by Vision Bridge and ephemeral prompt
 * prediction. Plaintext authorization is resolved at the final Orchestrator
 * boundary and must never be persisted, projected, or logged. */
export interface ProviderInferenceRoute {
  readonly providerId: string;
  readonly generationId: string;
  readonly modelId: string;
  readonly api: "anthropic-messages" | "openai-responses" | "openai-completions";
  readonly baseUrl: string;
  readonly authorization?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly supportsImages: boolean;
}

/** Public provider catalog plus an in-memory credential join for Pi spawning. */
export class ProviderCatalogManager {
  readonly #store: OperationalStore;
  readonly #credentials: CredentialManager;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #loginHandlers: Readonly<Record<string, (method: ProviderLoginFlow["method"]) => Promise<ProviderLoginFlow>>>;
  readonly #providerEnabled: (providerId: string) => boolean;
  readonly #modelEnabled: (providerId: string, modelId: string) => boolean;
  readonly #entries = new Map<string, ManagedProviderEntry>();
  readonly #nativeEntries = new Map<string, NativeProviderAuthEntry>();
  readonly #authentication = new Map<string, { readonly state: ProviderAuthenticationState; readonly error?: string }>();
  #generation = 0;
  #initialized = false;
  #nativeAuth: ProviderNativeAuthSupervisor | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ProviderCatalogManagerOptions) {
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
    this.#loginHandlers = options.loginHandlers ?? {};
    this.#nativeAuth = options.nativeAuth;
    this.#providerEnabled = options.providerEnabled ?? (() => true);
    this.#modelEnabled = options.modelEnabled ?? (() => true);
  }

  attachNativeAuth(supervisor: ProviderNativeAuthSupervisor): void {
    this.#assertInitialized();
    if (this.#nativeAuth !== undefined && this.#nativeAuth !== supervisor) {
      throw new Error("A native Provider auth supervisor is already attached.");
    }
    this.#nativeAuth = supervisor;
  }

  /** Seeds only public runtime Provider metadata; native Providers never enter models.json. */
  async registerNativeAuthProviders(registrations: readonly NativeProviderAuthRegistration[]): Promise<void> {
    this.#assertInitialized();
    const authoritative = new Map<string, NativeProviderAuthRegistration>();
    for (const registration of registrations) {
      const providerId = nonBlank(registration.provider.id, "Native Provider ID");
      if (authoritative.has(providerId)) throw new Error("Pi native auth registry contains duplicate Provider IDs.");
      if (!["api_key", "oauth", "subscription", "local_keyless"].includes(registration.kind)) {
        throw new Error("Pi native Provider registry kind is invalid.");
      }
      if (!Array.isArray(registration.provider.models)) throw new Error("Pi native auth registry Provider models are malformed.");
      authoritative.set(providerId, registration);
    }

    await this.#mutate(async () => {
      let durableChanged = false;
      for (const [providerId, current] of this.#nativeEntries) {
        const registration = authoritative.get(providerId);
        if (registration === undefined) {
          if (current.runtimeProvider !== undefined) {
            const {
              runtimeProvider: _runtimeProvider,
              modelRefreshAvailable: _modelRefreshAvailable,
              accountUsageAvailable: _accountUsageAvailable,
              loginMethods: _loginMethods,
              ...durable
            } = current;
            this.#nativeEntries.set(providerId, durable);
          }
          continue;
        }
        const displayName = nonBlank(registration.displayName, "Native Provider display name");
        const accountUsageAvailable = registration.accountUsageAvailable === true;
        const loginMethods = nativeProviderLoginMethods(registration.loginMethods, registration.kind);
        const metadataChanged = current.displayName !== displayName || current.kind !== registration.kind
          || current.accountUsageAvailable === true !== accountUsageAvailable;
        this.#nativeEntries.set(providerId, {
          ...current,
          displayName,
          kind: registration.kind,
          runtimeProvider: registration.provider,
          modelRefreshAvailable: registration.modelRefreshAvailable === true,
          accountUsageAvailable,
          loginMethods,
          ...(metadataChanged ? { version: current.version + 1n, updatedAt: this.#now() } : {})
        });
        durableChanged ||= metadataChanged;
        authoritative.delete(providerId);
      }
      for (const [providerId, registration] of authoritative) {
        this.#nativeEntries.set(providerId, {
          providerId,
          displayName: nonBlank(registration.displayName, "Native Provider display name"),
          kind: registration.kind,
          version: 1n,
          updatedAt: this.#now(),
          runtimeProvider: registration.provider,
          modelRefreshAvailable: registration.modelRefreshAvailable === true,
          accountUsageAvailable: registration.accountUsageAvailable === true,
          loginMethods: nativeProviderLoginMethods(registration.loginMethods, registration.kind)
        });
        durableChanged = true;
      }
      if (durableChanged) await this.#bumpAndPersistNative();
    });
  }

  initialize(): void {
    if (this.#initialized) return;
    const stored = this.#store.findSetting<StoredProviderCatalog>("service", this.#scopeId, "provider_catalog");
    if (stored !== undefined) {
      if (stored.value.format !== 1 || !Array.isArray(stored.value.entries) || !Number.isSafeInteger(stored.value.generation)) {
        throw new Error("Provider catalog setting has an unsupported format.");
      }
      this.#generation = stored.value.generation;
      for (const item of stored.value.entries) {
        const entry = providerFromStorage(item);
        validateProviderEntry(entry);
        if (this.#entries.has(entry.provider.id)) throw new Error("Provider catalog contains duplicate provider IDs.");
        this.#entries.set(entry.provider.id, entry);
      }
    }
    const storedNative = this.#store.findSetting<StoredNativeProviderAuthCatalog>("service", this.#scopeId, "native_provider_auth_catalog");
    if (storedNative !== undefined) {
      if (storedNative.value.format !== 1 || !Array.isArray(storedNative.value.entries)) {
        throw new Error("Native Provider auth catalog setting has an unsupported format.");
      }
      for (const item of storedNative.value.entries) {
        const entry = nativeProviderAuthFromStorage(item);
        if (this.#nativeEntries.has(entry.providerId)) throw new Error("Native Provider auth catalog contains duplicate Provider IDs.");
        this.#nativeEntries.set(entry.providerId, entry);
      }
    }
    this.#initialized = true;
  }

  get generation(): number {
    this.#assertInitialized();
    return this.#generation;
  }

  list(): readonly ProviderDescriptor[] {
    this.#assertInitialized();
    const managed = [...this.#entries.values()].map((entry) => this.#descriptor(entry, this.#nativeEntries.get(entry.provider.id)));
    const native = [...this.#nativeEntries.values()]
      .filter((entry) => entry.runtimeProvider !== undefined && !this.#entries.has(entry.providerId))
      .map((entry) => this.#nativeDescriptor(entry));
    return [...managed, ...native]
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en") || left.provider.id.localeCompare(right.provider.id, "en"))
      ;
  }

  get(providerId: string): ProviderDescriptor {
    this.#assertInitialized();
    const normalized = nonBlank(providerId, "Provider ID");
    const managed = this.#entries.get(normalized);
    const native = this.#nativeEntries.get(normalized);
    if (managed !== undefined) return this.#descriptor(managed, native);
    if (native?.runtimeProvider !== undefined) return this.#nativeDescriptor(native);
    throw new Error("Provider does not exist.");
  }

  /**
   * Resolve an explicitly catalogued model onto an OpenAI-compatible
   * `/embeddings` route. No endpoint is inferred from a Provider that did not
   * declare the model, and plaintext credentials remain inside Orchestrator.
   */
  resolveOpenAiEmbeddingRoute(modelId: string, providerId?: string): OpenAiEmbeddingRoute | undefined {
    this.#assertInitialized();
    const normalizedModelId = nonBlank(modelId, "Embedding model ID");
    const normalizedProviderId = providerId === undefined ? undefined : nonBlank(providerId, "Embedding Provider ID");
    const candidates = [...this.#entries.values()]
      .filter((entry) => entry.enabled)
      .filter((entry) => this.#providerEnabled(entry.provider.id))
      .filter((entry) => this.#modelEnabled(entry.provider.id, normalizedModelId))
      .filter((entry) => entry.provider.baseUrl !== undefined)
      .filter((entry) => entry.provider.models.some((model) => model.id === normalizedModelId))
      .filter((entry) => normalizedProviderId === undefined || entry.provider.id === normalizedProviderId)
      .filter((entry) => safeEmbeddingBaseUrl(entry.provider.baseUrl!))
      .sort((left, right) => left.provider.id.localeCompare(right.provider.id, "en"));
    // Selecting a Provider is a durable security choice, not dictionary-order
    // routing. An unpinned generation is available only when exactly one
    // eligible Provider exists; the coordinator then pins its ID in Store.
    if (normalizedProviderId === undefined && candidates.length !== 1) return undefined;
    for (const entry of candidates) {
      const baseUrl = entry.provider.baseUrl;
      if (baseUrl === undefined) continue;
      const apiKeyEnvironment = entry.provider.apiKeyEnv;
      let authorization: string | undefined;
      if (apiKeyEnvironment !== undefined) {
        const reference = entry.credentialBindings[apiKeyEnvironment];
        if (reference === undefined) continue;
        try {
          authorization = `Bearer ${this.#credentials.resolve(reference)}`;
        } catch {
          continue;
        }
      } else if (entry.provider.keyless !== true && Object.keys(entry.provider.headers ?? {}).length === 0) {
        continue;
      }
      const headers: Record<string, string> = {};
      let complete = true;
      for (const [headerName, source] of Object.entries(entry.provider.headers ?? {})) {
        const reference = entry.credentialBindings[source.env];
        if (reference === undefined) {
          complete = false;
          break;
        }
        try {
          headers[headerName] = this.#credentials.resolve(reference);
        } catch {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      const endpointBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const endpoint = new URL("embeddings", endpointBase).toString();
      const generationId = createHash("sha256")
        .update(`${entry.provider.id}\0${entry.version.toString(10)}\0${normalizedModelId}\0${endpoint}`)
        .digest("hex");
      return {
        providerId: entry.provider.id,
        generationId,
        modelId: normalizedModelId,
        endpoint,
        ...(authorization === undefined ? {} : { authorization }),
        headers
      };
    }
    return undefined;
  }

  /** Resolve one exact, catalogued inference route. Unlike embedding routing,
   * this never guesses among Providers: both IDs are an explicit owner or
   * Session selection. Native OAuth routes stay inside Pi and are therefore
   * intentionally unavailable to this independent Orchestrator one-shot channel. */
  hasInferenceModel(
    providerId: string,
    modelId: string,
    options: { readonly requireImages?: boolean } = {}
  ): boolean {
    this.#assertInitialized();
    const normalizedProviderId = nonBlank(providerId, "Inference Provider ID");
    const normalizedModelId = nonBlank(modelId, "Inference model ID");
    const entry = this.#entries.get(normalizedProviderId);
    if (
      entry === undefined
      || !entry.enabled
      || !this.#providerEnabled(normalizedProviderId)
      || !this.#modelEnabled(normalizedProviderId, normalizedModelId)
      || entry.provider.baseUrl === undefined
    ) return false;
    const model = entry.provider.models.find((candidate) => candidate.id === normalizedModelId);
    if (model === undefined) return false;
    const api = model.api ?? entry.provider.api;
    if (api !== "anthropic-messages" && api !== "openai-responses" && api !== "openai-completions") return false;
    if (options.requireImages === true && model.input?.includes("image") !== true) return false;
    return safeEmbeddingBaseUrl(entry.provider.baseUrl);
  }

  resolveInferenceRoute(
    providerId: string,
    modelId: string,
    options: { readonly requireImages?: boolean } = {}
  ): ProviderInferenceRoute | undefined {
    this.#assertInitialized();
    const normalizedProviderId = nonBlank(providerId, "Inference Provider ID");
    const normalizedModelId = nonBlank(modelId, "Inference model ID");
    const entry = this.#entries.get(normalizedProviderId);
    if (
      entry === undefined
      || !entry.enabled
      || !this.#providerEnabled(normalizedProviderId)
      || !this.#modelEnabled(normalizedProviderId, normalizedModelId)
      || entry.provider.baseUrl === undefined
    ) return undefined;
    const model = entry.provider.models.find((candidate) => candidate.id === normalizedModelId);
    if (model === undefined) return undefined;
    const api = model.api ?? entry.provider.api;
    if (api !== "anthropic-messages" && api !== "openai-responses" && api !== "openai-completions") return undefined;
    const supportsImages = model.input?.includes("image") === true;
    if (options.requireImages === true && !supportsImages) return undefined;
    if (!safeEmbeddingBaseUrl(entry.provider.baseUrl)) return undefined;

    let secret: string | undefined;
    if (entry.provider.apiKeyEnv !== undefined) {
      const reference = entry.credentialBindings[entry.provider.apiKeyEnv];
      if (reference === undefined) return undefined;
      try {
        secret = this.#credentials.resolve(reference);
      } catch {
        return undefined;
      }
    } else if (entry.provider.keyless !== true && Object.keys(entry.provider.headers ?? {}).length === 0) {
      return undefined;
    }
    const headers: Record<string, string> = {};
    for (const [headerName, source] of Object.entries(entry.provider.headers ?? {})) {
      const reference = entry.credentialBindings[source.env];
      if (reference === undefined) return undefined;
      try {
        headers[headerName] = this.#credentials.resolve(reference);
      } catch {
        return undefined;
      }
    }
    let authorization: string | undefined;
    if (secret !== undefined) {
      if (api === "anthropic-messages" && entry.provider.authHeader !== true) {
        headers["x-api-key"] = secret;
        if (!Object.keys(headers).some((name) => name.toLowerCase() === "anthropic-version")) {
          headers["anthropic-version"] = "2023-06-01";
        }
      } else {
        authorization = `Bearer ${secret}`;
      }
    }
    const generationId = createHash("sha256")
      .update(`${entry.provider.id}\0${entry.version.toString(10)}\0${normalizedModelId}\0${entry.provider.baseUrl}\0${api}`)
      .digest("hex");
    return {
      providerId: normalizedProviderId,
      generationId,
      modelId: normalizedModelId,
      api,
      baseUrl: entry.provider.baseUrl,
      ...(authorization === undefined ? {} : { authorization }),
      headers,
      supportsImages
    };
  }

  /** Content-free capability check used by Settings projection. */
  hasInferenceRoute(options: { readonly requireImages?: boolean } = {}): boolean {
    this.#assertInitialized();
    for (const entry of this.#entries.values()) {
      for (const model of entry.provider.models) {
        if (this.resolveInferenceRoute(entry.provider.id, model.id, options) !== undefined) return true;
      }
    }
    return false;
  }

  async upsert(
    input: Omit<ManagedProviderEntry, "version" | "updatedAt" | "nativeCredentialReferenceId"> & { readonly expectedVersion?: bigint },
    options: { readonly stillActive?: () => boolean } = {}
  ): Promise<ProviderDescriptor> {
    this.#assertInitialized();
    validateProviderEntry({ ...input, version: 1n, updatedAt: this.#now() });
    return this.#mutate(async () => {
      if (options.stillActive?.() === false) throw new Error("Provider mutation owner changed.");
      const existing = this.#entries.get(input.provider.id);
      if (input.expectedVersion !== undefined && existing?.version !== input.expectedVersion) {
        throw new Error("Provider catalog entry changed concurrently.");
      }
      const next: ManagedProviderEntry = {
        ...input,
        credentialBindings: { ...input.credentialBindings },
        ...(existing?.nativeCredentialReferenceId === undefined
          ? {}
          : { nativeCredentialReferenceId: existing.nativeCredentialReferenceId }),
        version: (existing?.version ?? 0n) + 1n,
        updatedAt: this.#now()
      };
      this.#entries.set(next.provider.id, next);
      await this.#bumpAndPersist(existing === undefined
        ? () => this.#entries.delete(next.provider.id)
        : () => this.#entries.set(existing.provider.id, existing));
      return this.#descriptor(next);
    });
  }

  canDiscoverProviderModels(providerId: string): boolean {
    this.#assertInitialized();
    const entry = this.#entries.get(nonBlank(providerId, "Provider ID"));
    return entry?.provider.baseUrl !== undefined;
  }

  async discoverProviderModels(
    providerId: string,
    fetchImpl: typeof fetch = fetch
  ): Promise<ProviderModelDiscoveryResult> {
    this.#assertInitialized();
    const normalized = nonBlank(providerId, "Provider ID");
    const captured = this.#entries.get(normalized);
    if (captured === undefined || captured.provider.baseUrl === undefined) {
      throw new ProviderModelDiscoveryError("unsafe_endpoint");
    }
    const spec = this.#modelDiscoverySpec(captured);
    const discovered = await fetchProviderModels(spec, fetchImpl);
    return this.#mutate(async () => {
      const current = this.#entries.get(normalized);
      if (current === undefined || current.version !== captured.version) {
        throw new Error("Provider configuration changed during model catalog refresh.");
      }
      const known = new Set(current.provider.models.map((model) => model.id));
      const additions = discovered.filter((model) => !known.has(model.id));
      if (additions.length === 0) {
        return {
          providerId: normalized,
          addedModelIds: [],
          modelCount: current.provider.models.length
        };
      }
      const next: ManagedProviderEntry = {
        ...current,
        provider: {
          ...current.provider,
          models: [
            ...current.provider.models,
            ...additions.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow ?? 128_000,
              maxTokens: 16_384,
              defaultVisible: false
            }))
          ]
        },
        version: current.version + 1n,
        updatedAt: this.#now()
      };
      validateProviderEntry(next);
      this.#entries.set(normalized, next);
      await this.#bumpAndPersist(() => this.#entries.set(normalized, current));
      return {
        providerId: normalized,
        addedModelIds: additions.map((model) => model.id),
        modelCount: next.provider.models.length
      };
    });
  }

  async delete(providerId: string, options: { readonly stillActive?: () => boolean } = {}): Promise<boolean> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      if (options.stillActive?.() === false) throw new Error("Provider mutation owner changed.");
      const existing = this.#entries.get(providerId);
      if (existing === undefined) return false;
      this.#entries.delete(providerId);
      await this.#bumpAndPersist(() => this.#entries.set(providerId, existing));
      return true;
    });
  }

  async commitCredential(input: {
    readonly providerId: string;
    readonly environmentName?: string;
    readonly credentialUploadTicketId: string;
    readonly credentialReferenceId?: string;
    readonly displayName: string;
    readonly kind: CredentialKind;
    readonly expiresAt?: number;
    readonly connectionId?: string;
  }): Promise<CredentialDescriptor> {
    this.#assertInitialized();
    const entry = this.#require(input.providerId);
    const environmentName = input.environmentName ?? inferPrimaryCredentialEnvironment(entry.provider);
    if (environmentName === undefined) throw new Error("Provider has no credential environment binding.");
    assertEnvironmentName(environmentName);
    const allowed = providerEnvironmentNames(entry.provider);
    if (!allowed.has(environmentName)) throw new Error("Credential environment is not declared by the provider.");
    const credential = await this.#credentials.commitUpload({
      credentialUploadTicketId: input.credentialUploadTicketId,
      ...(input.credentialReferenceId === undefined ? {} : { credentialReferenceId: input.credentialReferenceId }),
      displayName: input.displayName,
      kind: input.kind,
      providerId: input.providerId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId })
    });
    await this.#mutate(async () => {
      const current = this.#require(input.providerId);
      const updated: ManagedProviderEntry = {
        ...current,
        credentialBindings: { ...current.credentialBindings, [environmentName]: credential.credentialReferenceId },
        version: current.version + 1n,
        updatedAt: this.#now()
      };
      this.#entries.set(input.providerId, updated);
      await this.#bumpAndPersist(() => this.#entries.set(input.providerId, current));
    });
    this.#authentication.delete(input.providerId);
    return credential;
  }

  /**
   * Supervisor-only write path for Pi's complete, type-tagged OAuth object.
   * The serialized value is sealed by CredentialManager and never enters the
   * OperationalStore provider catalog.
   */
  async writeNativeCredential(input: {
    readonly providerId: string;
    readonly serializedCredential: string;
    readonly expiresAt?: number;
    readonly expectedCatalogGeneration?: number;
  }): Promise<NativePiAuthPersistResult & { readonly descriptor: CredentialDescriptor }> {
    this.#assertInitialized();
    const parsed = parseNativePiCredential(input.serializedCredential);
    const credentialExpiry = parsed.type === "oauth" ? parsed.expires : undefined;
    if (credentialExpiry !== input.expiresAt) throw new Error("Native Provider credential expiry is inconsistent.");
    return this.#mutate(async () => {
      if (input.expectedCatalogGeneration !== undefined && input.expectedCatalogGeneration !== this.#generation) {
        throw new ProviderAuthGenerationConflictError(input.expectedCatalogGeneration, this.#generation);
      }
      const entry = this.#requireNative(input.providerId);
      if (entry.runtimeProvider === undefined) throw new ProviderAuthUnsupportedError("Pi native Provider auth is unavailable in this runtime.");
      if (parsed.type === "oauth" ? entry.kind !== "oauth" && entry.kind !== "subscription" : entry.kind !== "api_key") {
        throw new ProviderAuthUnsupportedError("The native credential type does not match this Pi Provider.");
      }
      if (input.expiresAt !== undefined && input.expiresAt <= this.#now()) throw new Error("Native Provider credential expiry must be in the future.");
      const reference = entry.credentialReferenceId ?? nativeCredentialReference(input.providerId);
      const existing = this.#credentials.find(reference);
      const kind: CredentialKind = parsed.type === "api_key"
        ? "api_key"
        : entry.kind === "subscription" ? "subscription" : "oauth";
      let credential: CredentialDescriptor;
      if (existing === undefined) {
        const ticket = this.#credentials.createUploadTicket({
          kind,
          providerId: input.providerId
        });
        this.#credentials.upload(ticket.credentialUploadTicketId, input.serializedCredential);
        credential = await this.#credentials.commitUpload({
          credentialUploadTicketId: ticket.credentialUploadTicketId,
          credentialReferenceId: reference,
          displayName: `${entry.displayName} native sign-in`,
          kind,
          providerId: input.providerId,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
        });
      } else {
        if (existing.providerId !== input.providerId || existing.kind !== kind) {
          throw new Error("Native Provider credential reference belongs to a different purpose.");
        }
        credential = await this.#credentials.replaceSecret(reference, input.serializedCredential, {
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          refreshedAt: this.#now()
        });
      }
      const updated: NativeProviderAuthEntry = {
        ...entry,
        credentialReferenceId: reference,
        version: entry.version + 1n,
        updatedAt: this.#now()
      };
      this.#nativeEntries.set(input.providerId, updated);
      try {
        await this.#bumpAndPersistNative(() => this.#nativeEntries.set(input.providerId, entry));
      } catch (error) {
        if (existing === undefined) await this.#credentials.delete(reference).catch(() => undefined);
        throw error;
      }
      this.#authentication.delete(input.providerId);
      return {
        descriptor: credential,
        catalogGeneration: this.#generation,
        credentialReferenceId: credential.credentialReferenceId,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
      };
    });
  }

  /** Returns sealed-vault plaintext only to the in-process Pi CredentialStore. */
  readNativeCredential(providerId: string): { readonly serializedCredential: string; readonly descriptor: CredentialDescriptor } | undefined {
    this.#assertInitialized();
    const normalizedProviderId = nonBlank(providerId, "Provider ID");
    const entry = this.#nativeEntries.get(normalizedProviderId);
    if (entry === undefined) return undefined;
    const reference = entry.credentialReferenceId;
    if (reference === undefined) return undefined;
    const credential = this.#credentials.find(reference);
    if (credential === undefined) return undefined;
    return {
      serializedCredential: this.#credentials.resolveForRefresh(reference),
      descriptor: credential
    };
  }

  async deleteNativeCredential(providerId: string): Promise<boolean> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const entry = this.#requireNative(providerId);
      const reference = entry.credentialReferenceId;
      if (reference === undefined) return false;
      const { credentialReferenceId: _removed, ...withoutCredential } = entry;
      const updated: NativeProviderAuthEntry = {
        ...withoutCredential,
        version: entry.version + 1n,
        updatedAt: this.#now()
      };
      this.#nativeEntries.set(providerId, updated);
      await this.#bumpAndPersistNative(() => this.#nativeEntries.set(providerId, entry));
      await this.#credentials.delete(reference);
      this.#authentication.delete(providerId);
      return true;
    });
  }

  loadNativeAuth(input: {
    readonly providerIds: readonly string[];
    readonly expectedCatalogGeneration: number;
  }): NativePiAuthLoadResult {
    this.#assertInitialized();
    this.#assertCatalogGeneration(input.expectedCatalogGeneration);
    const credentials: Record<string, NativePiCredential> = {};
    const seen = new Set<string>();
    for (const rawProviderId of input.providerIds) {
      const providerId = nonBlank(rawProviderId, "Native Provider allowlist entry");
      if (seen.has(providerId)) throw new Error("Native Provider auth allowlist contains duplicates.");
      seen.add(providerId);
      const entry = this.#requireNative(providerId);
      if (entry.runtimeProvider === undefined) throw new ProviderAuthUnsupportedError("Pi native Provider auth is unavailable in this runtime.");
      if (entry.kind !== "api_key" && entry.kind !== "oauth" && entry.kind !== "subscription") {
        throw new ProviderAuthUnsupportedError("This Pi Provider is not eligible for native credential injection.");
      }
      const stored = this.readNativeCredential(providerId);
      if (stored !== undefined) credentials[providerId] = parseNativePiCredential(stored.serializedCredential);
    }
    this.#assertCatalogGeneration(input.expectedCatalogGeneration);
    return { catalogGeneration: this.#generation, credentials };
  }

  async persistNativeAuth(input: {
    readonly providerId: string;
    readonly credential: unknown;
    readonly expectedCatalogGeneration: number;
    /** In-process lease identity; never persisted or exposed through Connect. */
    readonly expectedAccountId?: string;
  }): Promise<NativePiAuthPersistResult> {
    const credential = validateNativePiCredential(input.credential);
    if (input.expectedAccountId !== undefined) {
      const identity = this.describeNativeAuthLease(input.providerId);
      if (!identity.authenticated || identity.accountId !== input.expectedAccountId) {
        throw new Error("Pi native Provider account identity changed before credential persistence.");
      }
      const current = this.readNativeCredential(input.providerId);
      if (current === undefined) throw new Error("Pi native Provider credential is unavailable.");
      assertLeasedNativeCredentialAccount(parseNativePiCredential(current.serializedCredential), credential);
    }
    const expiresAt = credential.type === "oauth" ? credential.expires : undefined;
    const result = await this.writeNativeCredential({
      providerId: input.providerId,
      serializedCredential: JSON.stringify(credential),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      expectedCatalogGeneration: input.expectedCatalogGeneration
    });
    return {
      catalogGeneration: result.catalogGeneration,
      credentialReferenceId: result.credentialReferenceId,
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt })
    };
  }

  /** Creates an input ticket bound to a single native OAuth flow prompt. */
  createNativeAuthInputTicket(input: {
    readonly flowId: string;
    readonly promptId: string;
    readonly connectionId: string;
    readonly maximumBytes?: number;
  }): {
    readonly credentialUploadTicketId: string;
    readonly expiresAt: number;
    readonly maximumBytes: number;
  } {
    this.#assertInitialized();
    return this.#credentials.createProviderLoginInputTicket(input);
  }

  /** Returns a prompt answer once, directly from the sealed in-memory upload ticket. */
  consumeNativeAuthInput(input: {
    readonly credentialUploadTicketId: string;
    readonly flowId: string;
    readonly promptId: string;
    readonly connectionId: string;
  }): string {
    this.#assertInitialized();
    return this.#credentials.consumeProviderLoginInput(input);
  }

  /** Accepts only pre-redacted, user-safe status text from the supervisor. */
  setNativeAuthenticationState(providerId: string, state: ProviderAuthenticationState, publicError?: string): void {
    this.#assertInitialized();
    this.get(providerId);
    if (state === "authenticated") {
      this.#authentication.delete(providerId);
      return;
    }
    this.#authentication.set(providerId, {
      state,
      ...(publicError === undefined ? {} : { error: nonBlank(publicError, "Provider authentication error") })
    });
  }

  /** Captures the exact disabled managed entry a login is allowed to activate. */
  captureAuthenticatedProviderActivation(providerId: string): bigint | undefined {
    this.#assertInitialized();
    const current = this.#entries.get(nonBlank(providerId, "Provider ID"));
    return current === undefined || current.enabled ? undefined : current.version;
  }

  /** Enables only the unchanged managed entry whose native credential was confirmed. */
  async activateAuthenticatedProvider(providerId: string, expectedVersion?: bigint): Promise<boolean> {
    this.#assertInitialized();
    const normalizedProviderId = nonBlank(providerId, "Provider ID");
    return this.#mutate(async () => {
      const native = this.#requireNative(normalizedProviderId);
      const reference = native.credentialReferenceId;
      if (reference === undefined || this.#credentials.find(reference) === undefined) {
        throw new Error("Native Provider credential was not persisted before activation.");
      }
      const current = this.#entries.get(normalizedProviderId);
      if (current === undefined || current.enabled || expectedVersion === undefined) return false;
      if (current.version !== expectedVersion) {
        throw new Error("Provider configuration changed while authentication was pending.");
      }
      const updated: ManagedProviderEntry = {
        ...current,
        enabled: true,
        version: current.version + 1n,
        updatedAt: this.#now()
      };
      this.#entries.set(normalizedProviderId, updated);
      await this.#bumpAndPersist(() => this.#entries.set(normalizedProviderId, current));
      return true;
    });
  }

  async beginLogin(providerId: string, method: ProviderLoginFlow["method"]): Promise<ProviderLoginFlow> {
    this.#assertInitialized();
    const provider = this.get(providerId);
    if (!provider.supportsLogin) throw new Error("Provider does not support login.");
    const handler = this.#loginHandlers[providerId];
    const native = handler === undefined && this.#nativeAuth?.canHandle(providerId) === true ? this.#nativeAuth : undefined;
    if (handler === undefined && native === undefined) throw new ProviderAuthUnsupportedError("Provider login is not implemented by the active Pi runtime.");
    this.#authentication.set(providerId, { state: "pending" });
    try {
      const flow = handler === undefined ? await native!.beginLogin(providerId, method) : await handler(method);
      if (flow.providerId !== providerId) throw new Error("Provider login handler returned a mismatched provider.");
      return flow;
    } catch (error) {
      this.#authentication.set(providerId, { state: "error", error: "Provider login could not be started." });
      if (error instanceof ProviderAuthUnsupportedError) throw error;
      throw new Error("Provider login could not be started.", { cause: safeError(error) });
    }
  }

  async refreshCredential(providerId: string): Promise<CredentialDescriptor> {
    this.#assertInitialized();
    const entry = this.get(providerId);
    if (!entry.supportsRefresh) throw new Error("Provider does not support credential refresh.");
    const native = this.#nativeAuth?.canHandle(providerId) === true ? this.#nativeAuth : undefined;
    if (native === undefined) throw new ProviderAuthUnsupportedError("Provider refresh is not implemented by the active Pi runtime.");
    this.#authentication.set(providerId, { state: "refreshing" });
    try {
      await native.refreshCredential(providerId);
      this.#authentication.delete(providerId);
      const refreshedReference = this.#requireNative(providerId).credentialReferenceId;
      if (refreshedReference === undefined) throw new Error("Native Provider refresh did not retain a credential.");
      const refreshed = this.#credentials.find(refreshedReference);
      if (refreshed === undefined) throw new Error("Native Provider refresh credential is unavailable.");
      return refreshed;
    } catch (error) {
      this.#authentication.set(providerId, { state: "error", error: "Provider credential refresh failed." });
      if (error instanceof ProviderAuthUnsupportedError) throw error;
      throw new Error("Provider credential refresh failed.", { cause: safeError(error) });
    }
  }

  currentCatalogGeneration(): number {
    return this.generation;
  }

  /** Non-secret, process-local identity used to fence native-auth leases. */
  describeNativeAuthLease(providerId: string): {
    readonly accountId: string;
    readonly authGeneration: string;
    readonly catalogGeneration: number;
    readonly authenticated: boolean;
  } {
    const normalizedProviderId = nonBlank(providerId, "Provider ID");
    const descriptor = this.get(normalizedProviderId);
    const reference = this.#nativeEntries.get(normalizedProviderId)?.credentialReferenceId;
    const stored = reference === undefined ? undefined : this.readNativeCredential(normalizedProviderId);
    if (reference === undefined || stored === undefined || descriptor.authenticationState !== "authenticated") {
      return {
        accountId: "",
        authGeneration: descriptor.version.toString(10),
        catalogGeneration: this.#generation,
        authenticated: false
      };
    }
    const credential = parseNativePiCredential(stored.serializedCredential);
    const stableAccount = credential.type === "oauth" ? nativeOAuthAccountId(credential) : undefined;
    return {
      accountId: createHash("sha256")
        .update(normalizedProviderId, "utf8")
        .update("\u0000", "utf8")
        .update(stableAccount ?? reference, "utf8")
        .digest("hex"),
      authGeneration: descriptor.version.toString(10),
      catalogGeneration: this.#generation,
      authenticated: true
    };
  }

  /** Returns only non-secret fencing identity for the account-usage capability. */
  describeProviderAccountUsage(providerId: string): ProviderAccountUsageCredentialIdentity | undefined {
    this.#assertInitialized();
    const normalizedProviderId = nonBlank(providerId, "Provider ID");
    const native = this.#nativeEntries.get(normalizedProviderId);
    if (native?.accountUsageAvailable !== true || native.kind !== "subscription" || native.runtimeProvider === undefined) return undefined;
    const descriptor = this.get(normalizedProviderId);
    if (descriptor.authenticationState !== "authenticated") return undefined;
    const reference = native.credentialReferenceId;
    if (reference === undefined) return undefined;
    const credential = this.#credentials.find(reference);
    if (credential === undefined || credential.kind !== "subscription" && credential.kind !== "oauth") return undefined;
    return {
      providerId: normalizedProviderId,
      catalogGeneration: this.#generation,
      providerGeneration: descriptor.version,
      authGeneration: `${reference}:${credential.updatedAt}`
    };
  }

  /**
   * Opens the sealed credential only inside the capability owner. Refresh data
   * is never passed to the caller, and a generation change discards the result.
   */
  async useProviderAccountUsageCredential<T>(
    identity: ProviderAccountUsageCredentialIdentity,
    operation: (credential: ProviderAccountUsageCredential) => Promise<T>
  ): Promise<T> {
    const before = this.describeProviderAccountUsage(identity.providerId);
    if (!sameProviderAccountUsageIdentity(before, identity)) throw new Error("Provider account usage credential generation is stale.");
    const stored = this.readNativeCredential(identity.providerId);
    if (stored === undefined) throw new Error("Provider account usage credential is unavailable.");
    const credential = parseNativePiCredential(stored.serializedCredential);
    if (credential.type !== "oauth") throw new Error("Provider account usage requires an OAuth credential.");
    const accountId = credential["accountId"];
    if (typeof accountId !== "string" || accountId.length < 1 || accountId.length > 256
        || /[\u0000-\u001f\u007f]/u.test(accountId)) {
      throw new Error("Provider account usage identity is unavailable.");
    }
    const result = await operation({ accessToken: credential.access, accountId });
    if (!sameProviderAccountUsageIdentity(this.describeProviderAccountUsage(identity.providerId), identity)) {
      throw new Error("Provider account usage credential generation changed during the request.");
    }
    return result;
  }

  async recoverProviderAccountUsageAuthorization(identity: ProviderAccountUsageCredentialIdentity): Promise<void> {
    if (!sameProviderAccountUsageIdentity(this.describeProviderAccountUsage(identity.providerId), identity)) return;
    await this.refreshCredential(identity.providerId);
  }

  async logout(providerId: string): Promise<ProviderDescriptor> {
    this.#assertInitialized();
    const entry = this.get(providerId);
    if (!entry.supportsLogout) throw new Error("Provider does not support logout.");
    const nativeReference = this.#nativeEntries.get(providerId)?.credentialReferenceId;
    if (nativeReference !== undefined && this.#nativeAuth?.canHandle(providerId) === true) {
      try {
        await this.#nativeAuth.logout(providerId);
      } catch (error) {
        // Upstream Pi logout has no remote revoke hook. If its CredentialStore
        // already deleted the local token, local logout is nevertheless final.
        if (this.#nativeEntries.get(providerId)?.credentialReferenceId !== undefined) {
          throw new Error("Provider logout failed.", { cause: safeError(error) });
        }
      }
    } else if (nativeReference !== undefined) {
      await this.deleteNativeCredential(providerId);
    }
    const currentEntry = this.#entries.get(providerId);
    if (currentEntry !== undefined && Object.keys(currentEntry.credentialBindings).length > 0) {
      const references = [...new Set(Object.values(currentEntry.credentialBindings))];
      await this.#mutate(async () => {
        const current = this.#require(providerId);
        const updated: ManagedProviderEntry = {
          ...current,
          credentialBindings: {},
          version: current.version + 1n,
          updatedAt: this.#now()
        };
        this.#entries.set(providerId, updated);
        await this.#bumpAndPersist(() => this.#entries.set(providerId, current));
      });
      for (const reference of references) await this.#credentials.delete(reference);
    }
    this.#authentication.delete(providerId);
    return this.get(providerId);
  }

  async createPiGenerationSnapshot(input: {
    readonly snapshotsRoot: string;
    readonly settings?: PiManagedSettings;
    readonly providerEnabled?: (providerId: string) => boolean;
    readonly modelEnabled?: (providerId: string, modelId: string) => boolean;
  }): Promise<PiProviderGenerationSnapshot> {
    this.#assertInitialized();
    if (!isAbsolute(input.snapshotsRoot) || resolve(input.snapshotsRoot) !== input.snapshotsRoot) {
      throw new Error("Provider snapshot root must be a normalized absolute path.");
    }
    return this.#mutate(async () => {
      const generation = this.#generation;
      const entries = [...this.#entries.values()].flatMap((entry): ManagedProviderEntry[] => {
        if (
          !entry.enabled
          || !this.#providerEnabled(entry.provider.id)
          || input.providerEnabled?.(entry.provider.id) === false
        ) return [];
        const models = entry.provider.models.filter((model) =>
          this.#modelEnabled(entry.provider.id, model.id)
          && input.modelEnabled?.(entry.provider.id, model.id) !== false);
        return models.length === 0 ? [] : [{ ...entry, provider: { ...entry.provider, models } }];
      });
      const environment: Record<string, string> = {};
      for (const entry of entries) {
        for (const [name, reference] of Object.entries(entry.credentialBindings)) {
          const value = this.#credentials.resolve(reference);
          if (environment[name] !== undefined && !constantTimeTextEqual(environment[name] ?? "", value)) {
            throw new Error("Two provider credentials target the same environment name.");
          }
          environment[name] = value;
        }
      }
      try {
        await mkdir(input.snapshotsRoot, { recursive: true, mode: 0o700 });
        const finalPath = join(input.snapshotsRoot, `generation-${generation}`);
        const temporary = join(input.snapshotsRoot, `.generation-${generation}-${randomUUID()}.tmp`);
        try {
          await provisionManagedCatalog(temporary, entries.map((entry) => entry.provider), input.settings ?? {});
          await writeFile(join(temporary, "joko-generation.json"), JSON.stringify({
            format: 1,
            generation,
            providerIds: entries.map((entry) => entry.provider.id).sort(),
            createdAt: this.#now()
          }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
          try {
            await rename(temporary, finalPath);
          } catch (error) {
            if (!(await pathExists(finalPath))) throw error;
            await assertProviderSnapshot(finalPath, generation);
            await rm(temporary, { recursive: true, force: true });
          }
          await assertProviderSnapshot(finalPath, generation);
        } catch (error) {
          await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        const nativeAuthProviderIds = [...this.#nativeEntries.values()]
          .filter((entry) => entry.runtimeProvider !== undefined
            && entry.kind !== "local_keyless"
            && this.#providerEnabled(entry.providerId)
            && input.providerEnabled?.(entry.providerId) !== false)
          .map((entry) => entry.providerId)
          .sort();
        return {
          catalogGeneration: generation,
          agentHome: finalPath,
          providers: entries.map((entry) => entry.provider),
          nativeAuthProviderIds,
          nativeAuthenticatedProviderIds: nativeAuthProviderIds.filter((providerId) =>
            this.get(providerId).authenticationState === "authenticated"
          ),
          environment,
          secretEnvironmentNames: Object.keys(environment).sort()
        };
      } catch (error) {
        throw error;
      }
    });
  }

  #descriptor(entry: ManagedProviderEntry, native = this.#nativeEntries.get(entry.provider.id)): ProviderDescriptor {
    const nativeReference = native?.credentialReferenceId ?? entry.nativeCredentialReferenceId;
    const credentials = [...new Set([
      ...Object.values(entry.credentialBindings),
      ...(nativeReference === undefined ? [] : [nativeReference])
    ])]
      .map((reference) => this.#credentials.find(reference));
    const existing = credentials.filter((value): value is CredentialDescriptor => value !== undefined);
    const expires = existing.map((item) => item.expiresAt).filter((value): value is number => value !== undefined);
    const override = this.#authentication.get(entry.provider.id);
    let authenticationState: ProviderAuthenticationState;
    if (override !== undefined) authenticationState = override.state;
    else if (entry.provider.keyless) authenticationState = "not_required";
    else if (entry.error !== undefined) authenticationState = "error";
    else if (existing.some((item) => !item.configured)) authenticationState = "expired";
    else if ((native !== undefined || entry.kind === "oauth" || entry.kind === "subscription") && (nativeReference === undefined || existing.length === 0)) authenticationState = "signed_out";
    else if (providerEnvironmentNames(entry.provider).size > 0 && existing.length === 0) authenticationState = "signed_out";
    else authenticationState = "authenticated";
    return {
      ...entry,
      ...(native === undefined ? {} : {
        kind: native.kind,
        supportsLogin: native.kind === "api_key" || native.kind === "oauth" || native.kind === "subscription",
        supportsLogout: native.kind === "api_key" || native.kind === "oauth" || native.kind === "subscription",
        supportsRefresh: native.kind === "oauth" || native.kind === "subscription",
        version: native.version > entry.version ? native.version : entry.version,
        updatedAt: Math.max(native.updatedAt, entry.updatedAt)
      }),
      ...(nativeReference === undefined ? {} : { nativeCredentialReferenceId: nativeReference }),
      credentialReferenceIds: existing.map((item) => item.credentialReferenceId).sort(),
      authenticationState,
      supportsModelRefresh: entry.provider.baseUrl !== undefined || native?.modelRefreshAvailable === true,
      loginMethods: entry.supportsLogin
        ? native?.loginMethods ?? nativeProviderLoginMethods(undefined, entry.kind)
        : [],
      capabilities: new Set(native?.accountUsageAvailable === true && native.kind === "subscription"
        ? [PROVIDER_ACCOUNT_USAGE_CAPABILITY]
        : []),
      ...(expires.length === 0 ? {} : { credentialExpiresAt: Math.min(...expires) }),
      ...(override?.error === undefined ? {} : { error: override.error })
    };
  }

  #nativeDescriptor(entry: NativeProviderAuthEntry): ProviderDescriptor {
    if (entry.runtimeProvider === undefined) throw new Error("Pi native Provider metadata is unavailable.");
    return this.#descriptor({
      provider: entry.runtimeProvider,
      displayName: entry.displayName,
      kind: entry.kind,
      credentialBindings: {},
      ...(entry.credentialReferenceId === undefined ? {} : { nativeCredentialReferenceId: entry.credentialReferenceId }),
      enabled: entry.kind === "local_keyless" || entry.credentialReferenceId !== undefined,
      supportsLogin: entry.kind === "api_key" || entry.kind === "oauth" || entry.kind === "subscription",
      supportsLogout: entry.kind === "api_key" || entry.kind === "oauth" || entry.kind === "subscription",
      supportsRefresh: entry.kind === "oauth" || entry.kind === "subscription",
      version: entry.version,
      updatedAt: entry.updatedAt
    }, entry);
  }

  #modelDiscoverySpec(entry: ManagedProviderEntry): ProviderModelDiscoverySpec {
    const headers: Record<string, string> = {};
    for (const [headerName, source] of Object.entries(entry.provider.headers ?? {})) {
      const reference = entry.credentialBindings[source.env];
      if (reference === undefined) throw new ProviderModelDiscoveryError("unauthorized");
      try {
        headers[headerName] = this.#credentials.resolve(reference);
      } catch {
        throw new ProviderModelDiscoveryError("unauthorized");
      }
    }
    let apiKey: string | undefined;
    if (entry.provider.apiKeyEnv !== undefined) {
      const reference = entry.credentialBindings[entry.provider.apiKeyEnv];
      if (reference === undefined) throw new ProviderModelDiscoveryError("unauthorized");
      try {
        apiKey = this.#credentials.resolve(reference);
      } catch {
        throw new ProviderModelDiscoveryError("unauthorized");
      }
    }
    return {
      baseUrl: entry.provider.baseUrl!,
      ...(entry.provider.api === undefined ? {} : { api: entry.provider.api }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(Object.keys(headers).length === 0 ? {} : { headers })
    };
  }

  #require(providerId: string): ManagedProviderEntry {
    const entry = this.#entries.get(nonBlank(providerId, "Provider ID"));
    if (entry === undefined) throw new Error("Provider does not exist.");
    return entry;
  }

  #requireNative(providerId: string): NativeProviderAuthEntry {
    const entry = this.#nativeEntries.get(nonBlank(providerId, "Provider ID"));
    if (entry === undefined) throw new Error("Pi native Provider does not exist.");
    return entry;
  }

  #assertCatalogGeneration(expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new RangeError("Provider auth generation is invalid.");
    if (expected !== this.#generation) throw new ProviderAuthGenerationConflictError(expected, this.#generation);
  }

  async #bumpAndPersist(rollback?: () => void): Promise<void> {
    const previousGeneration = this.#generation;
    this.#generation += 1;
    try {
      this.#store.setSetting("service", this.#scopeId, "provider_catalog", {
        format: 1,
        generation: this.#generation,
        entries: [...this.#entries.values()].map(providerForStorage)
      } satisfies StoredProviderCatalog);
    } catch (error) {
      this.#generation = previousGeneration;
      rollback?.();
      throw error;
    }
  }

  async #bumpAndPersistNative(rollback?: () => void): Promise<void> {
    const previousGeneration = this.#generation;
    this.#generation += 1;
    try {
      this.#store.transaction((store) => {
        store.setSetting("service", this.#scopeId, "provider_catalog", {
          format: 1,
          generation: this.#generation,
          entries: [...this.#entries.values()].map(providerForStorage)
        } satisfies StoredProviderCatalog);
        store.setSetting("service", this.#scopeId, "native_provider_auth_catalog", {
          format: 1,
          entries: [...this.#nativeEntries.values()].map(nativeProviderAuthForStorage)
        } satisfies StoredNativeProviderAuthCatalog);
      });
    } catch (error) {
      this.#generation = previousGeneration;
      rollback?.();
      throw error;
    }
  }

  #mutate<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(callback, callback);
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Provider catalog manager is not initialized.");
  }
}

function descriptor(record: StoredCredential, now: number): CredentialDescriptor {
  return {
    credentialReferenceId: record.credentialReferenceId,
    generation: credentialGeneration(record),
    displayName: record.displayName,
    kind: record.kind,
    ...(record.providerId === undefined ? {} : { providerId: record.providerId }),
    configured: record.expiresAt === undefined || record.expiresAt > now,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.lastRefreshedAt === undefined ? {} : { lastRefreshedAt: record.lastRefreshedAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.expiresAt !== undefined && record.expiresAt <= now ? { error: "Credential has expired." } : {})
  };
}

function credentialGeneration(record: StoredCredential): string {
  return createHash("sha256")
    .update(record.credentialReferenceId)
    .update("\0")
    .update(record.sealed.algorithm)
    .update("\0")
    .update(record.sealed.nonce)
    .update("\0")
    .update(record.sealed.ciphertext)
    .update("\0")
    .update(record.sealed.tag)
    .digest("hex");
}

function validateStoredCredential(value: unknown): StoredCredential {
  if (!isRecord(value)) throw new Error("Credential record is malformed.");
  const reference = normalizeReference(stringProperty(value, "credentialReferenceId"));
  const kind = stringProperty(value, "kind") as CredentialKind;
  validateCredentialKind(kind);
  const sealed = value["sealed"];
  if (!isRecord(sealed) || sealed["algorithm"] !== "aes-256-gcm") throw new Error("Credential ciphertext is malformed.");
  for (const key of ["nonce", "ciphertext", "tag"] as const) if (typeof sealed[key] !== "string") throw new Error("Credential ciphertext is malformed.");
  return {
    credentialReferenceId: reference,
    displayName: nonBlank(stringProperty(value, "displayName"), "Credential display name"),
    kind,
    ...(typeof value["providerId"] === "string" ? { providerId: nonBlank(value["providerId"], "Provider ID") } : {}),
    ...(typeof value["expiresAt"] === "number" ? { expiresAt: safeInteger(value["expiresAt"], "Credential expiry") } : {}),
    ...(typeof value["lastRefreshedAt"] === "number" ? { lastRefreshedAt: safeInteger(value["lastRefreshedAt"], "Credential refresh time") } : {}),
    createdAt: safeInteger(numberProperty(value, "createdAt"), "Credential creation time"),
    updatedAt: safeInteger(numberProperty(value, "updatedAt"), "Credential update time"),
    sealed: sealed as unknown as EncryptedCredential
  };
}

function providerForStorage(entry: ManagedProviderEntry): StoredProviderEntry {
  const {
    provider: sourceProvider,
    credentialBindings: sourceBindings,
    version: sourceVersion,
    ...metadata
  } = entry;
  const { headers: _headers, ...provider } = sourceProvider;
  return {
    ...metadata,
    provider: {
      ...provider,
      ...(sourceProvider.headers === undefined
        ? {}
        : {
          headerEnvironmentReferences: Object.entries(sourceProvider.headers)
            .sort(([left], [right]) => left.localeCompare(right, "en"))
            .map(([headerName, reference]) => ({ headerName, environmentName: reference.env }))
        })
    },
    credentialEnvironmentReferences: Object.entries(sourceBindings)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([environmentName, credentialReferenceId]) => ({ environmentName, credentialReferenceId })),
    version: sourceVersion.toString(10)
  };
}

function providerFromStorage(entry: StoredProviderEntry): ManagedProviderEntry {
  if (!/^\d+$/u.test(entry.version)) throw new Error("Provider version is malformed.");
  const {
    provider: storedProvider,
    credentialEnvironmentReferences,
    version,
    ...metadata
  } = entry;
  const { headerEnvironmentReferences, ...provider } = storedProvider;
  if (headerEnvironmentReferences !== undefined && !Array.isArray(headerEnvironmentReferences)) throw new Error("Provider header references are malformed.");
  if (!Array.isArray(credentialEnvironmentReferences)) throw new Error("Provider credential references are malformed.");
  const headers = headerEnvironmentReferences === undefined
    ? undefined
    : Object.fromEntries(headerEnvironmentReferences.map((item) => [item.headerName, { env: item.environmentName }]));
  const credentialBindings = Object.fromEntries(credentialEnvironmentReferences.map((item) => [item.environmentName, item.credentialReferenceId]));
  return {
    ...metadata,
    provider: { ...provider, ...(headers === undefined ? {} : { headers }) },
    credentialBindings,
    version: BigInt(version)
  };
}

function nativeProviderAuthForStorage(entry: NativeProviderAuthEntry): StoredNativeProviderAuthEntry {
  return {
    providerId: entry.providerId,
    displayName: entry.displayName,
    kind: entry.kind,
    ...(entry.credentialReferenceId === undefined ? {} : { credentialReferenceId: entry.credentialReferenceId }),
    version: entry.version.toString(10),
    updatedAt: entry.updatedAt
  };
}

function nativeProviderAuthFromStorage(entry: StoredNativeProviderAuthEntry): NativeProviderAuthEntry {
  if (!isRecord(entry)) throw new Error("Native Provider auth entry is malformed.");
  const providerId = nonBlank(stringProperty(entry, "providerId"), "Native Provider ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(providerId)) throw new Error("Native Provider ID is invalid.");
  const kind = stringProperty(entry, "kind");
  if (kind !== "api_key" && kind !== "oauth" && kind !== "subscription" && kind !== "local_keyless") {
    throw new Error("Native Provider kind is invalid.");
  }
  const version = stringProperty(entry, "version");
  if (!/^\d+$/u.test(version)) throw new Error("Native Provider auth version is malformed.");
  const credentialReferenceId = typeof entry.credentialReferenceId === "string"
    ? normalizeReference(entry.credentialReferenceId)
    : undefined;
  if (credentialReferenceId !== undefined && kind !== "api_key" && kind !== "oauth" && kind !== "subscription") {
    throw new Error("Only authenticated native Providers may reference a credential.");
  }
  return {
    providerId,
    displayName: nonBlank(stringProperty(entry, "displayName"), "Native Provider display name"),
    kind,
    ...(credentialReferenceId === undefined ? {} : { credentialReferenceId }),
    version: BigInt(version),
    updatedAt: safeInteger(numberProperty(entry, "updatedAt"), "Native Provider auth update time")
  };
}

function parseNativePiCredential(serialized: string): NativePiCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Stored native Provider credential is malformed.");
  }
  return validateNativePiCredential(parsed);
}

function sameProviderAccountUsageIdentity(
  left: ProviderAccountUsageCredentialIdentity | undefined,
  right: ProviderAccountUsageCredentialIdentity
): boolean {
  return left !== undefined
    && left.providerId === right.providerId
    && left.catalogGeneration === right.catalogGeneration
    && left.providerGeneration === right.providerGeneration
    && left.authGeneration === right.authGeneration;
}

function validateNativePiCredential(value: unknown): NativePiCredential {
  if (!isRecord(value)) throw new Error("Native Provider credential is malformed.");
  if (value["type"] === "oauth") {
    if (typeof value["access"] !== "string" || value["access"].length === 0) throw new Error("Native Provider access credential is malformed.");
    if (typeof value["refresh"] !== "string" || value["refresh"].length === 0) throw new Error("Native Provider refresh credential is malformed.");
    if (!Number.isSafeInteger(value["expires"]) || (value["expires"] as number) <= 0) throw new Error("Native Provider credential expiry is malformed.");
  } else if (value["type"] === "api_key") {
    if (value["key"] !== undefined && (typeof value["key"] !== "string" || value["key"].length === 0)) {
      throw new Error("Native Provider API key is malformed.");
    }
    const env = value["env"];
    if (env !== undefined) {
      if (!isRecord(env) || Object.keys(env).length > 64) throw new Error("Native Provider credential environment is malformed.");
      for (const [name, environmentValue] of Object.entries(env)) {
        assertEnvironmentName(name);
        if (typeof environmentValue !== "string" || environmentValue.length === 0 || Buffer.byteLength(environmentValue, "utf8") > 8 * 1024) {
          throw new Error("Native Provider credential environment is malformed.");
        }
      }
    }
  } else {
    throw new Error("Native Provider credential type is unsupported.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Native Provider credential is not serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("Native Provider credential is oversized.");
  return JSON.parse(serialized) as NativePiCredential;
}

function nativeOAuthAccountId(credential: NativePiOAuthCredential): string | undefined {
  const values = [credential["accountId"], credential["account_id"]].filter((value) => value !== undefined);
  if (values.length === 0) return undefined;
  for (const value of values) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("Native Provider OAuth account identity is malformed.");
    }
  }
  if (values.length > 1 && values[0] !== values[1]) throw new Error("Native Provider OAuth account identity is ambiguous.");
  return values[0] as string;
}

function assertLeasedNativeCredentialAccount(current: NativePiCredential, next: NativePiCredential): void {
  if (current.type !== next.type) throw new Error("Pi native Provider credential type changed during a lease.");
  if (current.type !== "oauth" || next.type !== "oauth") return;
  const currentAccount = nativeOAuthAccountId(current);
  const nextAccount = nativeOAuthAccountId(next);
  if (currentAccount !== undefined && nextAccount !== currentAccount) {
    throw new Error("Pi native Provider account identity changed during credential refresh.");
  }
}

function validateProviderEntry(entry: ManagedProviderEntry): void {
  if (!isRecord(entry.provider)) throw new Error("Provider configuration must be an object.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.provider.id)) throw new Error("Provider ID is invalid.");
  nonBlank(entry.displayName, "Provider display name");
  if (!(["managed", "api_key", "oauth", "subscription", "local_keyless", "custom_endpoint"] as const).includes(entry.kind)) {
    throw new Error("Provider kind is invalid.");
  }
  if (entry.provider.baseUrl !== undefined) validateEndpoint(entry.provider.baseUrl);
  const allowed = providerEnvironmentNames(entry.provider);
  for (const [name, reference] of Object.entries(entry.credentialBindings)) {
    assertEnvironmentName(name);
    if (!allowed.has(name)) throw new Error("Provider credential binding targets an undeclared environment name.");
    normalizeReference(reference);
  }
  if (entry.nativeCredentialReferenceId !== undefined) {
    if (entry.kind !== "api_key" && entry.kind !== "oauth" && entry.kind !== "subscription") {
      throw new Error("Only authenticated native Providers may bind a native credential.");
    }
    normalizeReference(entry.nativeCredentialReferenceId);
  }
  if (!Array.isArray(entry.provider.models) || entry.provider.models.length === 0) throw new Error("Provider must declare at least one model.");
  assertProviderContainsNoSecret(entry.provider);
}

function assertProviderContainsNoSecret(value: unknown, path = "$provider", parentKey?: string, seen = new Set<object>()): void {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (/\bsk-[A-Za-z0-9_-]{12,}\b/u.test(value) || /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu.test(value)) {
      throw new Error("Provider configuration contains embedded secret material; use a credential reference.");
    }
    return;
  }
  if (typeof value !== "object") throw new Error(`Provider configuration contains an unsupported value at ${path}.`);
  if (seen.has(value)) throw new Error("Provider configuration contains a cycle.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertProviderContainsNoSecret(item, `${path}[${index}]`, parentKey, seen));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const sensitive = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)$/iu.test(key);
      const headerName = parentKey === "headers";
      const environmentReference = typeof item === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(item);
      if (sensitive && !headerName && !environmentReference) {
        throw new Error("Provider configuration contains an inline secret field; use a credential reference.");
      }
      assertProviderContainsNoSecret(item, `${path}.${key}`, key, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function validateEndpoint(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Provider endpoint is invalid."); }
  if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:") || url.username || url.password || url.hash) {
    throw new Error("Provider endpoint contains an unsafe URL component.");
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:token|secret|key|password|auth|credential)/iu.test(key)) throw new Error("Provider endpoint contains a secret-like query parameter.");
  }
}

function safeEmbeddingBaseUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLocaleLowerCase("en-US");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function providerEnvironmentNames(provider: PiManagedProvider): Set<string> {
  const names = new Set<string>();
  if (provider.apiKeyEnv !== undefined) names.add(provider.apiKeyEnv);
  for (const value of Object.values(provider.headers ?? {})) names.add(value.env);
  return names;
}

function inferPrimaryCredentialEnvironment(provider: PiManagedProvider): string | undefined {
  if (provider.apiKeyEnv !== undefined) return provider.apiKeyEnv;
  const names = [...providerEnvironmentNames(provider)];
  return names.length === 1 ? names[0] : undefined;
}

function primaryBoundReference(entry: ManagedProviderEntry): string | undefined {
  const environment = inferPrimaryCredentialEnvironment(entry.provider);
  return environment === undefined ? undefined : entry.credentialBindings[environment];
}

function validateCredentialKind(kind: CredentialKind): void {
  if (!(["api_key", "oauth", "subscription", "local_keyless", "header_secret", "ssh_private_key"] as const).includes(kind)) {
    throw new Error("Credential kind is invalid.");
  }
}

function normalizeReference(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u.test(normalized)) throw new Error("Credential reference is invalid.");
  return normalized;
}

function nativeCredentialReference(providerId: string): string {
  return `cred_pi_oauth_${createHash("sha256").update(providerId).digest("hex").slice(0, 32)}`;
}

function secretFragments(secret: string): readonly string[] {
  const fragments = new Set<string>();
  if (secret.length > 0) fragments.add(secret);
  try {
    const parsed: unknown = JSON.parse(secret);
    const visit = (value: unknown, key?: string, parentKey?: string): void => {
      if (typeof value === "string") {
        if (value.length >= 8 && key !== undefined && (
          parentKey === "env"
          || /^(?:access|refresh|token|(?:access|refresh|id)[_-]?token|authorization|password|secret|api[_-]?key)$/iu.test(key)
        )) {
          fragments.add(value);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key, parentKey);
        return;
      }
      if (!isRecord(value)) return;
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, key);
    };
    visit(parsed);
  } catch {
    // Ordinary API keys and opaque strings are already covered as a whole.
  }
  return [...fragments].sort((left, right) => right.length - left.length);
}

function assertEnvironmentName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error("Credential environment name is invalid.");
}

function ticketReference(id: string): string { return `ticket:${id}`; }

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\0")) throw new Error(`${label} must not be blank.`);
  return normalized;
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string {
  const property = value[key];
  if (typeof property !== "string") throw new Error("Credential record is malformed.");
  return property;
}

function numberProperty(value: Readonly<Record<string, unknown>>, key: string): number {
  const property = value[key];
  if (typeof property !== "number") throw new Error("Credential record is malformed.");
  return property;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}

async function assertProviderSnapshot(path: string, generation: number): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Provider generation snapshot is not a regular directory.");
  const canonical = await realpath(path);
  if (!samePath(canonical, path)) throw new Error("Provider generation snapshot contains a path alias or junction.");
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(join(path, "joko-generation.json"), "utf8")); }
  catch (error) { throw new Error("Provider generation snapshot manifest is unreadable.", { cause: error }); }
  if (!isRecord(manifest) || manifest["format"] !== 1 || manifest["generation"] !== generation) {
    throw new Error("Provider generation snapshot manifest does not match its generation.");
  }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function safeError(error: unknown): Error {
  return new Error(error instanceof Error ? error.name : "ProviderError");
}
