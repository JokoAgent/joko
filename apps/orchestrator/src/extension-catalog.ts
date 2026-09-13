import { createHash, randomUUID } from "node:crypto";

import type { RuntimeCommand, RuntimeToolDescriptor } from "@joko/core";
import type { OperationalStore } from "@joko/store";

import type { CredentialKind, CredentialManager } from "./credential-manager.js";
import type { McpServerDescriptor, McpServerInput } from "./mcp-router.js";
import type { PiResourceDescriptor } from "./resource-manager.js";

export type ExtensionCatalogSource = "local" | "market";
export type ExtensionInstallState = "available" | "installing" | "installed" | "update_available" | "error";
export type ExtensionSetupState = "not_required" | "required" | "in_progress" | "ready" | "cancelled" | "failed";
export type ExtensionSetupFieldKind = "text" | "secret" | "oauth" | "confirmation";

export interface ExtensionToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly requiresPermission: boolean;
}

export interface ExtensionPermissionDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
  readonly granted: boolean;
}

export interface ExtensionCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly sessionId: string;
}

export interface ExtensionSetupFieldDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: ExtensionSetupFieldKind;
  readonly required: boolean;
  readonly configured: boolean;
  readonly options: readonly string[];
}

export interface ExtensionSetupDescriptor {
  readonly state: ExtensionSetupState;
  readonly attemptId?: string;
  readonly revision: bigint;
  readonly fields: readonly ExtensionSetupFieldDescriptor[];
  readonly error?: string;
}

export interface ExtensionCatalogDescriptor {
  readonly id: string;
  readonly revision: bigint;
  readonly owner:
    | { readonly kind: "resource"; readonly resourceId: string; readonly discoveredRevision: string; readonly resourceVersion: bigint }
    | { readonly kind: "mcp"; readonly serverId: string; readonly serverRevision: bigint };
  readonly source: ExtensionCatalogSource;
  readonly installed: boolean;
  readonly installState: ExtensionInstallState;
  readonly name: string;
  readonly version?: string;
  readonly author?: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sidebarSupported: boolean;
  readonly sidebarVisible: boolean;
  readonly tools: readonly ExtensionToolDescriptor[];
  readonly permissions: readonly ExtensionPermissionDescriptor[];
  readonly commands: readonly ExtensionCommandDescriptor[];
  readonly setup: ExtensionSetupDescriptor;
  readonly useSupported: boolean;
  readonly error?: string;
}

export interface ExtensionCatalogSnapshot {
  readonly revision: bigint;
  readonly entries: readonly ExtensionCatalogDescriptor[];
  readonly recoveredFromCorruption: boolean;
}

export interface ExtensionRuntimeObservation {
  readonly sessionId: string;
  readonly commands?: readonly RuntimeCommand[];
  readonly tools?: readonly RuntimeToolDescriptor[];
}

export interface ExtensionCatalogManagerOptions {
  readonly store: OperationalStore;
  readonly credentials: CredentialManager;
  readonly scopeId?: string;
  readonly now?: () => number;
}

export type ExtensionOwnerBinding =
  | { readonly kind: "resource"; readonly resourceId: string; readonly discoveredRevision: string; readonly resourceVersion: bigint }
  | { readonly kind: "mcp"; readonly serverId: string; readonly serverRevision: bigint };

interface SetupRequirement {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: ExtensionSetupFieldKind;
  readonly required: boolean;
  readonly credentialReferenceId?: string;
  readonly credentialKinds?: readonly CredentialKind[];
  readonly options?: readonly string[];
}

interface ExtensionDefinition {
  readonly id: string;
  readonly bindingKey: string;
  readonly binding: ExtensionOwnerBinding;
  readonly source: ExtensionCatalogSource;
  readonly installed: boolean;
  readonly installState: ExtensionInstallState;
  readonly name: string;
  readonly version?: string;
  readonly author?: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sidebarSupported: boolean;
  readonly tools: readonly ExtensionToolDescriptor[];
  readonly permissions: readonly Omit<ExtensionPermissionDescriptor, "granted">[];
  readonly setupRequirements: readonly SetupRequirement[];
  readonly authorityIdentity: string;
  readonly projectionIdentity: string;
  readonly error?: string;
}

type StoredAttemptState = "in_progress" | "ready" | "cancelled" | "failed";

interface StoredSetupAttempt {
  readonly id: string;
  readonly authorityIdentity: string;
  readonly state: StoredAttemptState;
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly credentialGenerations: Readonly<Record<string, string>>;
  readonly revision: string;
  readonly updatedAt: number;
  readonly error?: string;
}

interface StoredAuthorization {
  readonly authorityIdentity: string;
  readonly values: Readonly<Record<string, string | boolean>>;
  readonly credentialGenerations: Readonly<Record<string, string>>;
  readonly completedAt: number;
}

interface StoredExtensionRecord {
  readonly id: string;
  readonly bindingKey: string;
  readonly authorityIdentity: string;
  readonly projectionIdentity: string;
  readonly sidebarVisible: boolean;
  readonly revision: string;
  readonly updatedAt: number;
  readonly authorization?: StoredAuthorization;
  readonly attempt?: StoredSetupAttempt;
}

interface StoredExtensionCatalog {
  readonly format: 1;
  readonly revision: string;
  readonly records: readonly StoredExtensionRecord[];
}

interface SetupCredentialTicket {
  readonly extensionId: string;
  readonly attemptId: string;
  readonly fieldId: string;
  readonly credentialReferenceId: string;
  readonly kind: CredentialKind;
  readonly connectionId: string;
}

const EXTENSION_SETTING_KEY = "extension_catalog";
const EXTENSION_ID = /^extension_[a-f0-9]{32}$/u;
const DECIMAL_REVISION = /^(?:0|[1-9][0-9]*)$/u;
const FIELD_ID = /^[a-z][a-z0-9._:-]{0,127}$/u;

/**
 * Durable, capability-neutral owner for Extension presentation, setup, and
 * sidebar preferences. Executable bytes and secret material remain with the
 * managed Resource and Credential owners respectively.
 */
export class ExtensionCatalogManager {
  readonly #store: OperationalStore;
  readonly #credentials: CredentialManager;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #records = new Map<string, StoredExtensionRecord>();
  readonly #definitions = new Map<string, ExtensionDefinition>();
  readonly #tickets = new Map<string, SetupCredentialTicket>();
  readonly #managedCredentialReferences = new Set<string>();
  #catalogRevision = 0n;
  #initialized = false;
  #recoveredFromCorruption = false;
  #recoveryPersistencePending = false;

  constructor(options: ExtensionCatalogManagerOptions) {
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
  }

  initialize(): void {
    if (this.#initialized) return;
    const stored = this.#store.findSetting<unknown>("service", this.#scopeId, EXTENSION_SETTING_KEY);
    if (stored !== undefined) {
      try {
        const catalog = validateStoredCatalog(stored.value);
        this.#catalogRevision = BigInt(catalog.revision);
        for (const raw of catalog.records) {
          const record = validateStoredRecord(raw);
          if (this.#records.has(record.id)) throw new Error("Extension catalog contains duplicate IDs.");
          this.#records.set(record.id, record);
        }
      } catch {
        // Catalog state contains no executable bytes or secrets. Reset it and
        // force every current definition through setup authorization again.
        this.#records.clear();
        this.#catalogRevision = 0n;
        this.#recoveredFromCorruption = true;
        this.#recoveryPersistencePending = true;
      }
    }
    this.#initialized = true;
  }

  reconcile(resources: readonly PiResourceDescriptor[], mcpServers: readonly McpServerDescriptor[]): ExtensionCatalogSnapshot {
    this.#assertInitialized();
    const definitions = projectDefinitions(resources, mcpServers);
    const nextDefinitions = new Map(definitions.map((definition) => [definition.id, definition] as const));
    const previousRecords = new Map(this.#records);
    const previousDefinitions = new Map(this.#definitions);
    const previousCatalogRevision = this.#catalogRevision;
    const previousRecoveryPersistencePending = this.#recoveryPersistencePending;
    let changed = this.#recoveryPersistencePending;
    try {
      for (const definition of definitions) {
        const current = this.#records.get(definition.id);
        if (current === undefined || current.bindingKey !== definition.bindingKey) {
          this.#records.set(definition.id, {
            id: definition.id,
            bindingKey: definition.bindingKey,
            authorityIdentity: definition.authorityIdentity,
            projectionIdentity: definition.projectionIdentity,
            sidebarVisible: false,
            revision: "1",
            updatedAt: this.#now()
          });
          changed = true;
          continue;
        }
        const authorityChanged = current.authorityIdentity !== definition.authorityIdentity;
        const projectionChanged = current.projectionIdentity !== definition.projectionIdentity;
        if (!authorityChanged && !projectionChanged) continue;
        this.#records.set(definition.id, {
          ...current,
          authorityIdentity: definition.authorityIdentity,
          projectionIdentity: definition.projectionIdentity,
          revision: increment(current.revision),
          updatedAt: this.#now(),
          ...(authorityChanged ? { authorization: undefined, attempt: undefined } : {})
        });
        changed = true;
      }

      for (const id of this.#records.keys()) {
        if (nextDefinitions.has(id)) continue;
        this.#records.delete(id);
        changed = true;
      }
      this.#definitions.clear();
      for (const [id, definition] of nextDefinitions) this.#definitions.set(id, definition);
      if (changed) {
        this.#catalogRevision += 1n;
        this.#persist();
        this.#recoveryPersistencePending = false;
      }
    } catch (error) {
      this.#records.clear();
      for (const [id, record] of previousRecords) this.#records.set(id, record);
      this.#definitions.clear();
      for (const [id, definition] of previousDefinitions) this.#definitions.set(id, definition);
      this.#catalogRevision = previousCatalogRevision;
      this.#recoveryPersistencePending = previousRecoveryPersistencePending;
      throw error;
    }
    return this.snapshot();
  }

  snapshot(runtime?: ExtensionRuntimeObservation): ExtensionCatalogSnapshot {
    this.#assertInitialized();
    const entries = [...this.#definitions.values()]
      .map((definition) => this.#descriptor(definition, runtime))
      .sort((left, right) => left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en"));
    return {
      revision: this.#catalogRevision,
      entries,
      recoveredFromCorruption: this.#recoveredFromCorruption
    };
  }

  get(extensionId: string, runtime?: ExtensionRuntimeObservation): ExtensionCatalogDescriptor {
    return this.#descriptor(this.#requireDefinition(extensionId), runtime);
  }

  binding(extensionId: string): ExtensionOwnerBinding {
    return this.#requireDefinition(extensionId).binding;
  }

  setSidebarVisible(extensionId: string, visible: boolean, expectedRevision: bigint): ExtensionCatalogDescriptor {
    const definition = this.#requireDefinition(extensionId);
    if (!definition.sidebarSupported) throw new Error("Extension does not advertise a sidebar entry.");
    const current = this.#requireRecord(extensionId, expectedRevision);
    if (current.sidebarVisible === visible) return this.#descriptor(definition);
    this.#replaceRecord({
      ...current,
      sidebarVisible: visible,
      revision: increment(current.revision),
      updatedAt: this.#now()
    });
    return this.#descriptor(definition);
  }

  beginSetup(extensionId: string, expectedRevision: bigint): ExtensionCatalogDescriptor {
    const definition = this.#requireDefinition(extensionId);
    if (definition.setupRequirements.length === 0) throw new Error("Extension does not require setup.");
    const current = this.#requireRecord(extensionId, expectedRevision);
    const credentialGenerations: Record<string, string> = {};
    for (const requirement of definition.setupRequirements) {
      if (requirement.credentialReferenceId === undefined) continue;
      const credential = this.#credentials.find(requirement.credentialReferenceId);
      if (credential !== undefined && requirement.credentialKinds?.includes(credential.kind) === true) {
        credentialGenerations[requirement.id] = credential.generation;
        this.#credentials.reserveManagedSecret({
          credentialReferenceId: requirement.credentialReferenceId,
          kind: credential.kind,
          ...(credential.providerId === undefined ? {} : { providerId: credential.providerId })
        });
        this.#managedCredentialReferences.add(requirement.credentialReferenceId);
      }
    }
    const nextRevision = BigInt(current.attempt?.revision ?? "0") + 1n;
    this.#replaceRecord({
      ...current,
      revision: increment(current.revision),
      updatedAt: this.#now(),
      attempt: {
        id: randomUUID(),
        authorityIdentity: definition.authorityIdentity,
        state: "in_progress",
        values: {},
        credentialGenerations,
        revision: nextRevision.toString(10),
        updatedAt: this.#now()
      }
    });
    return this.#descriptor(definition);
  }

  submitSetupInteraction(input: {
    readonly extensionId: string;
    readonly attemptId: string;
    readonly fieldId: string;
    readonly value: string | boolean;
    readonly expectedRevision: bigint;
  }): ExtensionCatalogDescriptor {
    const definition = this.#requireDefinition(input.extensionId);
    const current = this.#requireRecord(input.extensionId, input.expectedRevision);
    const attempt = requireActiveAttempt(current, input.attemptId, definition.authorityIdentity);
    const requirement = requireSetupRequirement(definition, input.fieldId);
    if (requirement.kind === "secret" || requirement.kind === "oauth") {
      throw new Error("Secret setup fields must use the credential channel.");
    }
    const value = normalizeInteractionValue(requirement, input.value);
    this.#replaceRecord({
      ...current,
      revision: increment(current.revision),
      updatedAt: this.#now(),
      attempt: {
        ...attempt,
        values: { ...attempt.values, [requirement.id]: value },
        revision: increment(attempt.revision),
        updatedAt: this.#now()
      }
    });
    return this.#descriptor(definition);
  }

  beginSetupCredentialUpload(input: {
    readonly extensionId: string;
    readonly attemptId: string;
    readonly fieldId: string;
    readonly kind: CredentialKind;
    readonly connectionId: string;
  }): { readonly credentialUploadTicketId: string; readonly expiresAt: number; readonly maximumBytes: number } {
    const definition = this.#requireDefinition(input.extensionId);
    const current = this.#requireRecord(input.extensionId);
    requireActiveAttempt(current, input.attemptId, definition.authorityIdentity);
    const requirement = requireSetupRequirement(definition, input.fieldId);
    if (requirement.credentialReferenceId === undefined || requirement.credentialKinds?.includes(input.kind) !== true) {
      throw new Error("Setup field does not accept this credential kind.");
    }
    const existing = this.#credentials.find(requirement.credentialReferenceId);
    if (existing !== undefined && existing.kind !== input.kind) {
      throw new Error("Revoke the existing setup credential before changing its kind.");
    }
    this.#credentials.reserveManagedSecret({ credentialReferenceId: requirement.credentialReferenceId, kind: input.kind });
    this.#managedCredentialReferences.add(requirement.credentialReferenceId);
    const ticket = this.#credentials.createUploadTicket({
      kind: input.kind,
      connectionId: nonBlank(input.connectionId, "Connection ID"),
      credentialReferenceId: requirement.credentialReferenceId
    });
    this.#tickets.set(ticket.credentialUploadTicketId, {
      extensionId: definition.id,
      attemptId: input.attemptId,
      fieldId: requirement.id,
      credentialReferenceId: requirement.credentialReferenceId,
      kind: input.kind,
      connectionId: input.connectionId
    });
    return ticket;
  }

  async commitSetupCredential(input: {
    readonly extensionId: string;
    readonly attemptId: string;
    readonly fieldId: string;
    readonly credentialUploadTicketId: string;
    readonly connectionId: string;
    readonly expectedRevision: bigint;
  }): Promise<ExtensionCatalogDescriptor> {
    const definition = this.#requireDefinition(input.extensionId);
    const current = this.#requireRecord(input.extensionId, input.expectedRevision);
    const attempt = requireActiveAttempt(current, input.attemptId, definition.authorityIdentity);
    const requirement = requireSetupRequirement(definition, input.fieldId);
    const ticket = this.#tickets.get(input.credentialUploadTicketId);
    if (ticket === undefined || ticket.extensionId !== definition.id || ticket.attemptId !== attempt.id
      || ticket.fieldId !== requirement.id || ticket.connectionId !== input.connectionId
      || ticket.credentialReferenceId !== requirement.credentialReferenceId) {
      throw new Error("Credential ticket does not belong to this setup field.");
    }
    const credential = await this.#credentials.commitManagedUpload({
      credentialUploadTicketId: input.credentialUploadTicketId,
      credentialReferenceId: ticket.credentialReferenceId,
      displayName: `${definition.name} · ${requirement.label}`,
      kind: ticket.kind,
      connectionId: ticket.connectionId
    });
    this.#tickets.delete(input.credentialUploadTicketId);
    this.#replaceRecord({
      ...current,
      revision: increment(current.revision),
      updatedAt: this.#now(),
      attempt: {
        ...attempt,
        credentialGenerations: { ...attempt.credentialGenerations, [requirement.id]: credential.generation },
        revision: increment(attempt.revision),
        updatedAt: this.#now()
      }
    });
    return this.#descriptor(definition);
  }

  completeSetup(extensionId: string, attemptId: string, expectedRevision: bigint): ExtensionCatalogDescriptor {
    const definition = this.#requireDefinition(extensionId);
    const current = this.#requireRecord(extensionId, expectedRevision);
    const attempt = requireActiveAttempt(current, attemptId, definition.authorityIdentity);
    assertSetupComplete(definition, attempt, this.#credentials);
    const completedAt = this.#now();
    this.#replaceRecord({
      ...current,
      revision: increment(current.revision),
      updatedAt: completedAt,
      authorization: {
        authorityIdentity: definition.authorityIdentity,
        values: { ...attempt.values },
        credentialGenerations: { ...attempt.credentialGenerations },
        completedAt
      },
      attempt: {
        ...attempt,
        state: "ready",
        revision: increment(attempt.revision),
        updatedAt: completedAt,
        error: undefined
      }
    });
    return this.#descriptor(definition);
  }

  failSetup(extensionId: string, attemptId: string, error: string): ExtensionCatalogDescriptor {
    const definition = this.#requireDefinition(extensionId);
    const current = this.#requireRecord(extensionId);
    const attempt = requireCurrentAttempt(current, attemptId, definition.authorityIdentity);
    this.#replaceRecord({
      ...current,
      authorization: undefined,
      revision: increment(current.revision),
      updatedAt: this.#now(),
      attempt: {
        ...attempt,
        state: "failed",
        revision: increment(attempt.revision),
        updatedAt: this.#now(),
        error: boundedText(error, 1_024, "Setup error")
      }
    });
    return this.#descriptor(definition);
  }

  cancelSetup(extensionId: string, attemptId: string, expectedRevision: bigint): ExtensionCatalogDescriptor {
    const definition = this.#requireDefinition(extensionId);
    const current = this.#requireRecord(extensionId, expectedRevision);
    const attempt = requireActiveAttempt(current, attemptId, definition.authorityIdentity);
    this.#replaceRecord({
      ...current,
      authorization: undefined,
      revision: increment(current.revision),
      updatedAt: this.#now(),
      attempt: {
        ...attempt,
        state: "cancelled",
        revision: increment(attempt.revision),
        updatedAt: this.#now()
      }
    });
    return this.#descriptor(definition);
  }

  async revokeSetup(extensionId: string, expectedRevision: bigint): Promise<ExtensionCatalogDescriptor> {
    const definition = this.#requireDefinition(extensionId);
    const current = this.#requireRecord(extensionId, expectedRevision);
    for (const requirement of definition.setupRequirements) {
      const reference = requirement.credentialReferenceId;
      if (reference === undefined) continue;
      const credential = this.#credentials.find(reference);
      if (credential !== undefined) {
        this.#credentials.reserveManagedSecret({
          credentialReferenceId: reference,
          kind: credential.kind,
          ...(credential.providerId === undefined ? {} : { providerId: credential.providerId })
        });
        this.#managedCredentialReferences.add(reference);
      }
      if (credential !== undefined || this.#managedCredentialReferences.has(reference)) {
        const retired = await this.#credentials.retireManagedCredential(reference, credential?.generation);
        if (!retired) throw new Error("Setup credential changed concurrently.");
        this.#managedCredentialReferences.delete(reference);
      }
    }
    this.#replaceRecord({
      ...current,
      authorization: undefined,
      attempt: undefined,
      revision: increment(current.revision),
      updatedAt: this.#now()
    });
    return this.#descriptor(definition);
  }

  #descriptor(definition: ExtensionDefinition, runtime?: ExtensionRuntimeObservation): ExtensionCatalogDescriptor {
    const record = this.#records.get(definition.id);
    if (record === undefined) throw new Error("Extension catalog is not reconciled.");
    const setup = setupDescriptor(definition, record, this.#credentials);
    const resourceId = definition.binding.kind === "resource" ? definition.binding.resourceId : undefined;
    const commands = resourceId !== undefined && runtime !== undefined
      ? (runtime.commands ?? []).filter((command) => command.loaded && command.source === "extension"
          && command.resourceId === resourceId).map((command) => ({
            name: command.name,
            description: command.description,
            sessionId: runtime.sessionId
          }))
      : [];
    const runtimeTools = resourceId !== undefined && runtime !== undefined
      ? (runtime.tools ?? []).filter((tool) => tool.resourceId === resourceId).map((tool) => ({
          name: tool.name,
          description: tool.description,
          requiresPermission: true
        }))
      : [];
    const tools = dedupeTools([...definition.tools, ...runtimeTools]);
    return {
      id: definition.id,
      revision: BigInt(record.revision),
      owner: definition.binding,
      source: definition.source,
      installed: definition.installed,
      installState: definition.installState,
      name: definition.name,
      ...(definition.version === undefined ? {} : { version: definition.version }),
      ...(definition.author === undefined ? {} : { author: definition.author }),
      description: definition.description,
      enabled: definition.enabled,
      sidebarSupported: definition.sidebarSupported,
      sidebarVisible: record.sidebarVisible,
      tools,
      permissions: definition.permissions.map((permission) => ({
        ...permission,
        granted: setup.state === "ready" || setup.state === "not_required"
      })),
      commands,
      setup,
      useSupported: definition.enabled && definition.installed
        && (setup.state === "ready" || setup.state === "not_required")
        && commands.length > 0,
      ...(definition.error === undefined ? {} : { error: definition.error })
    };
  }

  #replaceRecord(next: StoredExtensionRecord): void {
    const previous = this.#records.get(next.id);
    this.#records.set(next.id, next);
    this.#catalogRevision += 1n;
    try {
      this.#persist();
    } catch (error) {
      this.#catalogRevision -= 1n;
      if (previous === undefined) this.#records.delete(next.id);
      else this.#records.set(next.id, previous);
      throw error;
    }
  }

  #persist(): void {
    this.#store.setSetting("service", this.#scopeId, EXTENSION_SETTING_KEY, {
      format: 1,
      revision: this.#catalogRevision.toString(10),
      records: [...this.#records.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredExtensionCatalog);
  }

  #requireDefinition(extensionId: string): ExtensionDefinition {
    if (!EXTENSION_ID.test(extensionId)) throw new Error("Extension ID is invalid.");
    const definition = this.#definitions.get(extensionId);
    if (definition === undefined) throw new Error("Extension not found.");
    return definition;
  }

  #requireRecord(extensionId: string, expectedRevision?: bigint): StoredExtensionRecord {
    const record = this.#records.get(extensionId);
    if (record === undefined) throw new Error("Extension catalog record is missing.");
    if (expectedRevision !== undefined && BigInt(record.revision) !== expectedRevision) {
      throw new Error("Extension changed concurrently.");
    }
    return record;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Extension catalog is not initialized.");
  }
}

function projectDefinitions(
  resources: readonly PiResourceDescriptor[],
  mcpServers: readonly McpServerDescriptor[]
): readonly ExtensionDefinition[] {
  const definitions: ExtensionDefinition[] = [];
  for (const resource of resources) {
    if (resource.state === "removed") continue;
    const extensionDetails = resource.kind === "extension"
      ? resource.resourceDetails.filter((detail) => detail.kind === "extension").slice(0, 1)
      : resource.kind === "package"
        ? resource.resourceDetails.filter((detail) => detail.kind === "extension")
        : [];
    const details = extensionDetails.length === 0 && resource.kind === "extension"
      ? [{
          kind: "extension" as const,
          name: resource.name,
          compatibility: "unknown" as const,
          compatibilityIssues: [] as const,
          detectedApis: [] as const,
          adaptedApis: [] as const,
          unsupportedApis: [] as const
        }]
      : extensionDetails;
    const ordinals = new Map<string, number>();
    for (const detail of details) {
      const ordinal = ordinals.get(detail.name) ?? 0;
      ordinals.set(detail.name, ordinal + 1);
      const bindingKey = `resource\0${resource.id}\0${detail.name}\0${ordinal}`;
      const id = extensionId(bindingKey);
      const installed = ["installed", "loaded", "disabled", "update_available"].includes(resource.state);
      const installState: ExtensionInstallState = resource.state === "installing"
        ? "installing"
        : resource.state === "update_available"
          ? "update_available"
          : resource.state === "error"
            ? "error"
            : installed ? "installed" : "available";
      const permissions = detail.detectedApis.map((api) => ({
        id: `runtime-api:${api}`,
        label: api,
        description: `Uses the ${api} runtime extension capability.`,
        required: true
      }));
      const authorityIdentity = digest({
        bindingKey,
        discoveredRevision: resource.discoveredRevision,
        compatibility: detail.compatibility,
        issues: detail.compatibilityIssues,
        permissions
      });
      definitions.push({
        id,
        bindingKey,
        binding: {
          kind: "resource",
          resourceId: resource.id,
          discoveredRevision: resource.discoveredRevision,
          resourceVersion: resource.versionNumber
        },
        source: resource.sourceKind === "local" ? "local" : "market",
        installed,
        installState,
        name: detail.name || resource.name,
        ...(resource.version === undefined ? {} : { version: resource.version }),
        description: resource.sourceDisplay,
        enabled: resource.enabled,
        sidebarSupported: true,
        tools: [],
        permissions,
        setupRequirements: [],
        authorityIdentity,
        projectionIdentity: digest({
          authorityIdentity,
          resourceVersion: resource.versionNumber.toString(10),
          state: resource.state,
          enabled: resource.enabled,
          error: resource.error
        }),
        ...(resource.error === undefined ? {} : { error: resource.error })
      });
    }
  }
  for (const server of mcpServers) definitions.push(mcpDefinition(server));
  return definitions.sort((left, right) => left.bindingKey.localeCompare(right.bindingKey, "en"));
}

export function extensionMcpInput(descriptor: McpServerDescriptor, enabled: boolean): McpServerInput {
  const base = {
    id: descriptor.id,
    displayName: descriptor.displayName,
    enabled,
    credentialBindings: descriptor.credentialBindings.map(({ configured: _configured, ...binding }) => binding)
  };
  if (descriptor.configuration.case === "stdio") {
    return {
      ...base,
      transport: "stdio",
      command: descriptor.configuration.command,
      args: [...descriptor.configuration.arguments],
      ...(descriptor.configuration.workingDirectory === "" ? {} : { cwd: descriptor.configuration.workingDirectory }),
      environment: { ...descriptor.configuration.environment }
    };
  }
  return {
    ...base,
    transport: descriptor.configuration.case === "sse" ? "sse" : "streamable_http",
    endpoint: descriptor.configuration.endpoint
  };
}

function mcpDefinition(server: McpServerDescriptor): ExtensionDefinition {
  const bindingKey = `mcp\0${server.id}`;
  const tools = server.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    requiresPermission: tool.requiresPermission
  }));
  const credentialRequirements: SetupRequirement[] = server.credentialBindings.map((binding) => ({
    id: setupCredentialFieldId(binding.target, binding.name),
    label: binding.name,
    description: binding.target === "header"
      ? `Secret value for the ${binding.name} request header.`
      : `Secret value for the ${binding.name} process environment variable.`,
    kind: "secret",
    required: true,
    credentialReferenceId: binding.credentialReferenceId,
    credentialKinds: ["header_secret", "api_key", "oauth"]
  }));
  const permissionRequirements: SetupRequirement[] = [{
    id: "permission-confirmation",
    label: "Allow extension tools",
    description: "Confirm that this extension may request tools through the normal task permission policy.",
    kind: "confirmation",
    required: true
  }];
  const permissions: Omit<ExtensionPermissionDescriptor, "granted">[] = [
    ...server.credentialBindings.map((binding) => ({
      id: `credential:${binding.target}:${binding.name}`,
      label: binding.name,
      description: binding.target === "header" ? "Adds a protected request header." : "Adds a protected process environment variable.",
      required: true
    })),
    ...tools.filter((tool) => tool.requiresPermission).map((tool) => ({
      id: `tool:${tool.name}`,
      label: tool.name,
      description: "Tool execution is checked by the active task permission policy.",
      required: true
    }))
  ];
  const authorityIdentity = digest({
    bindingKey,
    transport: server.transport,
    configuration: server.configuration,
    credentialBindings: server.credentialBindings.map((binding) => ({
      target: binding.target,
      name: binding.name,
      credentialReferenceId: binding.credentialReferenceId
    }))
  });
  return {
    id: extensionId(bindingKey),
    bindingKey,
    binding: { kind: "mcp", serverId: server.id, serverRevision: server.version },
    source: server.transport === "stdio" ? "local" : "market",
    installed: true,
    installState: server.state === "error" ? "error" : "installed",
    name: server.displayName,
    description: server.endpointDisplay,
    enabled: server.enabled,
    sidebarSupported: true,
    tools,
    permissions,
    setupRequirements: [...credentialRequirements, ...permissionRequirements],
    authorityIdentity,
    projectionIdentity: digest({
      authorityIdentity,
      serverRevision: server.version.toString(10),
      state: server.state,
      enabled: server.enabled,
      runtimeGeneration: server.runtimeGeneration,
      configured: server.credentialBindings.map((binding) => binding.configured),
      error: server.error
    }),
    ...(server.error === undefined ? {} : { error: server.error })
  };
}

function setupDescriptor(
  definition: ExtensionDefinition,
  record: StoredExtensionRecord,
  credentials: CredentialManager
): ExtensionSetupDescriptor {
  const authorizationValid = validAuthorization(definition, record.authorization, credentials);
  const attempt = record.attempt?.authorityIdentity === definition.authorityIdentity ? record.attempt : undefined;
  const state: ExtensionSetupState = definition.setupRequirements.length === 0
    ? "not_required"
    : authorizationValid
      ? "ready"
      : attempt?.state === "in_progress"
        ? "in_progress"
        : attempt?.state === "cancelled"
          ? "cancelled"
          : attempt?.state === "failed" || attempt?.state === "ready"
            ? "failed"
            : "required";
  return {
    state,
    ...(attempt === undefined ? {} : { attemptId: attempt.id }),
    revision: BigInt(attempt?.revision ?? "0"),
    fields: definition.setupRequirements.map((requirement) => {
      const credential = requirement.credentialReferenceId === undefined
        ? undefined
        : credentials.find(requirement.credentialReferenceId);
      const configured = credential !== undefined
        && requirement.credentialKinds?.includes(credential.kind) === true
        && (attempt?.credentialGenerations[requirement.id] === credential.generation
          || record.authorization?.credentialGenerations[requirement.id] === credential.generation);
      return {
        id: requirement.id,
        label: requirement.label,
        description: requirement.description,
        kind: credential?.kind === "oauth" ? "oauth" : requirement.kind,
        required: requirement.required,
        configured: requirement.credentialReferenceId === undefined
          ? attempt?.values[requirement.id] !== undefined || record.authorization?.values[requirement.id] !== undefined
          : configured,
        options: [...(requirement.options ?? [])]
      };
    }),
    ...(attempt?.error === undefined ? {} : { error: attempt.error })
  };
}

function validAuthorization(
  definition: ExtensionDefinition,
  authorization: StoredAuthorization | undefined,
  credentials: CredentialManager
): boolean {
  if (authorization?.authorityIdentity !== definition.authorityIdentity) return false;
  for (const requirement of definition.setupRequirements) {
    if (!requirement.required) continue;
    if (requirement.credentialReferenceId !== undefined) {
      const current = credentials.find(requirement.credentialReferenceId);
      if (current === undefined || requirement.credentialKinds?.includes(current.kind) !== true
        || authorization.credentialGenerations[requirement.id] !== current.generation) return false;
      continue;
    }
    const value = authorization.values[requirement.id];
    if (requirement.kind === "confirmation" ? value !== true : typeof value !== "string" || value.trim() === "") return false;
  }
  return true;
}

function assertSetupComplete(
  definition: ExtensionDefinition,
  attempt: StoredSetupAttempt,
  credentials: CredentialManager
): void {
  for (const requirement of definition.setupRequirements) {
    if (!requirement.required) continue;
    if (requirement.credentialReferenceId !== undefined) {
      const credential = credentials.find(requirement.credentialReferenceId);
      if (credential === undefined || requirement.credentialKinds?.includes(credential.kind) !== true
        || attempt.credentialGenerations[requirement.id] !== credential.generation) {
        throw new Error(`Setup credential '${requirement.label}' is missing or changed.`);
      }
      continue;
    }
    const value = attempt.values[requirement.id];
    if (requirement.kind === "confirmation" ? value !== true : typeof value !== "string" || value.trim() === "") {
      throw new Error(`Setup field '${requirement.label}' is incomplete.`);
    }
  }
}

function requireSetupRequirement(definition: ExtensionDefinition, fieldId: string): SetupRequirement {
  if (!FIELD_ID.test(fieldId)) throw new Error("Setup field ID is invalid.");
  const requirement = definition.setupRequirements.find((candidate) => candidate.id === fieldId);
  if (requirement === undefined) throw new Error("Setup field not found.");
  return requirement;
}

function requireActiveAttempt(
  record: StoredExtensionRecord,
  attemptId: string,
  authorityIdentity: string
): StoredSetupAttempt {
  const attempt = requireCurrentAttempt(record, attemptId, authorityIdentity);
  if (attempt.state !== "in_progress") throw new Error("Setup attempt is not active.");
  return attempt;
}

function requireCurrentAttempt(
  record: StoredExtensionRecord,
  attemptId: string,
  authorityIdentity: string
): StoredSetupAttempt {
  const attempt = record.attempt;
  if (attempt === undefined || attempt.id !== attemptId || attempt.authorityIdentity !== authorityIdentity) {
    throw new Error("Setup attempt is stale.");
  }
  return attempt;
}

function normalizeInteractionValue(requirement: SetupRequirement, value: string | boolean): string | boolean {
  if (requirement.kind === "confirmation") {
    if (typeof value !== "boolean") throw new Error("Confirmation setup fields require a boolean value.");
    return value;
  }
  if (typeof value !== "string") throw new Error("Text setup fields require a string value.");
  const normalized = boundedText(value, 8_192, "Setup value");
  if (requirement.options !== undefined && !requirement.options.includes(normalized)) {
    throw new Error("Setup value is not one of the available choices.");
  }
  return normalized;
}

function dedupeTools(tools: readonly ExtensionToolDescriptor[]): readonly ExtensionToolDescriptor[] {
  const byName = new Map<string, ExtensionToolDescriptor>();
  for (const tool of tools) if (!byName.has(tool.name)) byName.set(tool.name, tool);
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function setupCredentialFieldId(target: "header" | "environment", name: string): string {
  return `credential:${target}:${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

function extensionId(bindingKey: string): string {
  return `extension_${createHash("sha256").update(bindingKey).digest("hex").slice(0, 32)}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function increment(value: string): string {
  if (!DECIMAL_REVISION.test(value)) throw new Error("Extension revision is invalid.");
  return (BigInt(value) + 1n).toString(10);
}

function boundedText(value: string, maximum: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\0]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function nonBlank(value: string, label: string): string {
  return boundedText(value, 256, label);
}

function validateStoredCatalog(value: unknown): StoredExtensionCatalog {
  if (!plainObject(value) || value.format !== 1 || !DECIMAL_REVISION.test(value.revision as string)
    || !Array.isArray(value.records) || value.records.length > 10_000) {
    throw new Error("Extension catalog has an unsupported format.");
  }
  return value as unknown as StoredExtensionCatalog;
}

function validateStoredRecord(value: unknown): StoredExtensionRecord {
  if (!plainObject(value) || typeof value.id !== "string" || !EXTENSION_ID.test(value.id)
    || typeof value.bindingKey !== "string" || value.bindingKey.length === 0 || value.bindingKey.length > 1_024
    || !sha256(value.authorityIdentity) || !sha256(value.projectionIdentity)
    || typeof value.sidebarVisible !== "boolean" || !DECIMAL_REVISION.test(value.revision as string)
    || !Number.isSafeInteger(value.updatedAt)) throw new Error("Stored Extension record is malformed.");
  const authorization = value.authorization === undefined ? undefined : validateAuthorization(value.authorization);
  const attempt = value.attempt === undefined ? undefined : validateAttempt(value.attempt);
  return {
    id: value.id,
    bindingKey: value.bindingKey,
    authorityIdentity: value.authorityIdentity,
    projectionIdentity: value.projectionIdentity,
    sidebarVisible: value.sidebarVisible,
    revision: value.revision as string,
    updatedAt: value.updatedAt as number,
    ...(authorization === undefined ? {} : { authorization }),
    ...(attempt === undefined ? {} : { attempt })
  };
}

function validateAuthorization(value: unknown): StoredAuthorization {
  if (!plainObject(value) || !sha256(value.authorityIdentity) || !Number.isSafeInteger(value.completedAt)) {
    throw new Error("Stored Extension authorization is malformed.");
  }
  return {
    authorityIdentity: value.authorityIdentity,
    values: validateValues(value.values),
    credentialGenerations: validateCredentialGenerations(value.credentialGenerations),
    completedAt: value.completedAt as number
  };
}

function validateAttempt(value: unknown): StoredSetupAttempt {
  if (!plainObject(value) || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/u.test(value.id)
    || !sha256(value.authorityIdentity) || !["in_progress", "ready", "cancelled", "failed"].includes(value.state as string)
    || !DECIMAL_REVISION.test(value.revision as string) || !Number.isSafeInteger(value.updatedAt)
    || value.error !== undefined && (typeof value.error !== "string" || value.error.length === 0 || value.error.length > 1_024)) {
    throw new Error("Stored Extension setup attempt is malformed.");
  }
  return {
    id: value.id,
    authorityIdentity: value.authorityIdentity,
    state: value.state as StoredAttemptState,
    values: validateValues(value.values),
    credentialGenerations: validateCredentialGenerations(value.credentialGenerations),
    revision: value.revision as string,
    updatedAt: value.updatedAt as number,
    ...(value.error === undefined ? {} : { error: value.error as string })
  };
}

function validateValues(value: unknown): Readonly<Record<string, string | boolean>> {
  if (!plainObject(value) || Object.keys(value).length > 128) throw new Error("Stored Extension setup values are malformed.");
  const result: Record<string, string | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!FIELD_ID.test(key) || !(typeof item === "boolean" || typeof item === "string" && item.length <= 8_192)) {
      throw new Error("Stored Extension setup value is malformed.");
    }
    result[key] = item;
  }
  return result;
}

function validateCredentialGenerations(value: unknown): Readonly<Record<string, string>> {
  if (!plainObject(value) || Object.keys(value).length > 128) throw new Error("Stored Extension credential generations are malformed.");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!FIELD_ID.test(key) || typeof item !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item)) {
      throw new Error("Stored Extension credential generation is malformed.");
    }
    result[key] = item;
  }
  return result;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
