import {
  AgentAuthConnectorFailure,
  RemoteSshConnectionController,
  RemoteSshError,
  TofuSshHostKeyVerifier,
  sshHostKeyPinId,
  type AgentAuthConnection,
  type AgentAuthConnectorPort,
  type AgentAuthConnectorRequest,
  type ResolvedAgentAuthConnectorPort,
  type RemoteSshErrorCode,
  type RemoteSshExecutionOptions,
  type RemoteSshExecutionResult,
  type RemoteSshConfigHost,
  type RemoteSshSnapshot,
  type RemoteSshTransportLease,
  type SshConfigFilePort,
  type SshHostKeyPinRequest,
  type SshHostKeyPinStorePort
} from "@joko/remote-ssh";
import {
  NotFoundError,
  RevisionConflictError,
  StoreError,
  type ClearRemoteHostTrustInput,
  type CreateRemoteHostInput,
  type DeleteRemoteHostInput,
  type OperationalStore,
  type RemoteHostFailureCode,
  type RemoteHostRecord,
  type RemoteHostStatus,
  type UpdateRemoteHostInput
} from "@joko/store";

const MAXIMUM_RUNTIME_CREDENTIAL_BYTES = 1024 * 1024;

export interface RemoteHostCredentialResolverPort {
  resolve(credentialReferenceId: string): string;
}

export type { ResolvedAgentAuthConnectorPort, ResolvedAgentAuthConnectorRequest } from "@joko/remote-ssh";

export interface RemoteHostRegistryOptions {
  readonly store: OperationalStore;
  readonly ownerId: string;
  readonly credentials?: RemoteHostCredentialResolverPort;
  readonly connector?: ResolvedAgentAuthConnectorPort;
  /** Optional service-owned OpenSSH catalog. No request may select its path. */
  readonly sshConfig?: SshConfigFilePort;
  readonly defaultSshUser?: string;
  readonly now?: () => number;
}

export type RemoteHostCreate = Omit<CreateRemoteHostInput, "ownerId">;
export type RemoteHostUpdate = Omit<UpdateRemoteHostInput, "ownerId">;
export type RemoteHostDelete = Omit<DeleteRemoteHostInput, "ownerId">;
export type RemoteHostTrustReset = Omit<ClearRemoteHostTrustInput, "ownerId">;

export interface RemoteHostConnectionOutcome {
  readonly ok: boolean;
  readonly host: RemoteHostRecord;
  readonly failure?: {
    readonly code: RemoteHostFailureCode;
    readonly retryable: boolean;
  };
}

export interface RemoteHostCommandOutcome {
  readonly host: RemoteHostRecord;
  readonly result: RemoteSshExecutionResult;
}

export type RemoteHostRegistryChange =
  | { readonly kind: "upserted"; readonly host: RemoteHostRecord }
  | { readonly kind: "deleted"; readonly host: RemoteHostRecord };

export type RemoteHostRegistryListener = (change: RemoteHostRegistryChange) => void;

interface ManagedController {
  readonly controller: RemoteSshConnectionController;
  readonly scope: { readonly ownerId: string; readonly targetId: string };
  readonly unsubscribe: () => void;
}

/**
 * Owner-private Remote Host authority. This class never accepts an owner ID
 * from a public request; its scope is fixed by the authenticated Orchestrator node.
 */
export class RemoteHostRegistry {
  readonly #store: OperationalStore;
  readonly #ownerId: string;
  readonly #now: () => number;
  readonly #connector: AgentAuthConnectorPort;
  readonly #connectionTestSupported: boolean;
  readonly #commandExecutionSupported: boolean;
  readonly #processStreamingSupported: boolean;
  readonly #fileTransferSupported: boolean;
  readonly #tcpForwardingSupported: boolean;
  readonly #sshConfig: SshConfigFilePort | undefined;
  readonly #defaultSshUser: string | undefined;
  readonly #controllers = new Map<string, ManagedController>();
  readonly #listeners = new Map<string, Set<RemoteHostRegistryListener>>();
  readonly #refreshes = new Map<string, Promise<RemoteHostRecord[]>>();
  #closed = false;

  constructor(options: RemoteHostRegistryOptions) {
    this.#store = options.store;
    this.#ownerId = boundedIdentity(options.ownerId, "owner ID", 256);
    this.#now = options.now ?? Date.now;
    this.#connectionTestSupported = options.connector !== undefined;
    this.#commandExecutionSupported = this.#connectionTestSupported &&
      options.connector?.capabilities.commandExecution === true;
    this.#processStreamingSupported = this.#connectionTestSupported &&
      options.connector?.capabilities.processStreaming === true;
    this.#fileTransferSupported = this.#connectionTestSupported &&
      options.connector?.capabilities.fileTransfer === true;
    this.#tcpForwardingSupported = this.#connectionTestSupported &&
      options.connector?.capabilities.tcpForwarding === true;
    this.#sshConfig = options.sshConfig;
    this.#defaultSshUser = options.sshConfig === undefined
      ? undefined
      : boundedIdentity(options.defaultSshUser ?? "", "default SSH user", 256);
    this.#connector = this.#connectionTestSupported
      ? new RuntimeCredentialAgentAuthConnector(options.credentials, options.connector!)
      : new UnavailableAgentAuthConnector();
    this.reconcileStartup();
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  capabilities(): Readonly<{
    catalog: true;
    connectionTest: boolean;
    connectionLifecycle: boolean;
    commandExecution: boolean;
    processStreaming: boolean;
    fileTransfer: boolean;
    tcpForwarding: boolean;
  }> {
    return Object.freeze({
      catalog: true,
      connectionTest: this.#connectionTestSupported,
      connectionLifecycle: this.#connectionTestSupported,
      commandExecution: this.#commandExecutionSupported,
      processStreaming: this.#processStreamingSupported,
      fileTransfer: this.#fileTransferSupported,
      tcpForwarding: this.#tcpForwardingSupported
    });
  }

  list(targetId: string): RemoteHostRecord[] {
    this.assertOpen();
    return this.#store.listRemoteHosts(this.#ownerId, targetId);
  }

  get(targetId: string, id: string): RemoteHostRecord {
    this.assertOpen();
    return this.#store.getRemoteHost(this.#ownerId, targetId, id);
  }

  async refresh(targetId: string): Promise<RemoteHostRecord[]> {
    this.assertOpen();
    const target = boundedIdentity(targetId, "target ID", 256);
    // Validate the exact target before touching the service-owned file port.
    this.#store.getTarget(target);
    if (this.#sshConfig === undefined || this.#defaultSshUser === undefined) {
      return this.list(target);
    }
    const previous = this.#refreshes.get(target);
    const operation = (previous ?? Promise.resolve([]))
      .catch(() => [])
      .then(async () => {
        this.assertOpen();
        const imported = await this.#sshConfig!.importHosts({
          ownerId: this.#ownerId,
          targetId: target,
          defaultUser: this.#defaultSshUser!
        });
        this.assertOpen();
        return this.reconcileSshConfig(target, imported);
      });
    this.#refreshes.set(target, operation);
    try {
      return await operation;
    } finally {
      if (this.#refreshes.get(target) === operation) this.#refreshes.delete(target);
    }
  }

  create(input: RemoteHostCreate): RemoteHostRecord {
    this.assertOpen();
    const host = this.#store.createRemoteHost({ ...input, ownerId: this.#ownerId });
    this.publish({ kind: "upserted", host });
    return host;
  }

  update(input: RemoteHostUpdate): RemoteHostRecord {
    this.assertOpen();
    const host = this.#store.updateRemoteHost({ ...input, ownerId: this.#ownerId });
    this.retireController(host.targetId, host.id);
    this.publish({ kind: "upserted", host });
    return host;
  }

  clearTrust(input: RemoteHostTrustReset): RemoteHostRecord {
    this.assertOpen();
    const host = this.#store.clearRemoteHostTrust({ ...input, ownerId: this.#ownerId });
    this.publish({ kind: "upserted", host });
    return host;
  }

  delete(input: RemoteHostDelete): RemoteHostRecord {
    this.assertOpen();
    const host = this.#store.deleteRemoteHost({ ...input, ownerId: this.#ownerId });
    this.retireController(host.targetId, host.id);
    this.publish({ kind: "deleted", host });
    return host;
  }

  subscribe(targetId: string, listener: RemoteHostRegistryListener): () => void {
    this.assertOpen();
    const target = boundedIdentity(targetId, "target ID", 256);
    this.#store.getTarget(target);
    let listeners = this.#listeners.get(target);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(target, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(target);
    };
  }

  async connect(
    targetId: string,
    id: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<RemoteHostConnectionOutcome> {
    return this.runConnectionTest(targetId, id, expectedRevision, false, signal);
  }

  async test(
    targetId: string,
    id: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<RemoteHostConnectionOutcome> {
    return this.runConnectionTest(targetId, id, expectedRevision, true, signal);
  }

  async execute(
    targetId: string,
    id: string,
    options: RemoteSshExecutionOptions
  ): Promise<RemoteHostCommandOutcome> {
    this.assertOpen();
    if (!this.#commandExecutionSupported) {
      throw new RemoteSshError(
        "EXECUTION_UNAVAILABLE",
        "Remote Host command execution is unavailable.",
        false
      );
    }
    const current = this.get(targetId, id);
    if (authenticationIsIncomplete(current)) {
      throw new RemoteSshError(
        "AUTHENTICATION_FAILED",
        "Remote Host authentication is not configured.",
        false
      );
    }
    const connected = await this.connect(targetId, id, current.revision, options.signal);
    if (!connected.ok) throw connectionOutcomeError(connected);
    const managed = this.#controllers.get(controllerKey(targetId, id));
    if (managed === undefined) {
      throw new RemoteSshError("EXECUTION_UNAVAILABLE", "Remote Host command execution is unavailable.", false);
    }
    const result = await managed.controller.execute(managed.scope, options);
    return Object.freeze({ host: this.get(targetId, id), result });
  }

  /** Returns a non-owning authenticated transport view for capability-neutral consumers. */
  async transports(
    targetId: string,
    id: string,
    signal?: AbortSignal
  ): Promise<{ readonly host: RemoteHostRecord; readonly lease: RemoteSshTransportLease }> {
    this.assertOpen();
    const current = this.get(targetId, id);
    if (authenticationIsIncomplete(current)) {
      throw new RemoteSshError("AUTHENTICATION_FAILED", "Remote Host authentication is not configured.", false);
    }
    const connected = await this.connect(targetId, id, current.revision, signal);
    if (!connected.ok) throw connectionOutcomeError(connected);
    const managed = this.#controllers.get(controllerKey(targetId, id));
    if (managed === undefined) {
      throw new RemoteSshError("CONNECTION_FAILED", "The SSH connection is not ready.", true);
    }
    return Object.freeze({
      host: this.get(targetId, id),
      lease: managed.controller.transports(managed.scope)
    });
  }

  async disconnect(targetId: string, id: string, expectedRevision: bigint): Promise<RemoteHostRecord> {
    this.assertOpen();
    const current = this.get(targetId, id);
    assertRevision(current, expectedRevision);
    const managed = this.#controllers.get(controllerKey(targetId, id));
    if (managed !== undefined) {
      await managed.controller.disconnect(scopeOf(current));
      return this.get(targetId, id);
    }
    if (current.status.state === "disconnected") return current;
    const host = this.persistStatus(current, "disconnected", this.#now());
    this.publish({ kind: "upserted", host });
    return host;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const controllers = [...this.#controllers.values()];
    for (const managed of controllers) {
      try {
        await managed.controller.disconnect(managed.scope);
      } catch {
        // Closing a connector cannot disclose its error or prevent other hosts from closing.
      }
      managed.unsubscribe();
    }
    this.#controllers.clear();
    this.#listeners.clear();
    this.#closed = true;
  }

  private reconcileStartup(): void {
    for (const host of this.#store.listRemoteHosts(this.#ownerId)) {
      if (!isActiveStatus(host.status.state)) continue;
      this.#store.updateRemoteHostStatus({
        ownerId: host.ownerId,
        targetId: host.targetId,
        id: host.id,
        expectedRevision: host.revision,
        state: "disconnected",
        changedAt: Math.max(host.status.changedAt, this.#now())
      });
    }
  }

  private reconcileSshConfig(
    targetId: string,
    imported: readonly RemoteSshConfigHost[]
  ): RemoteHostRecord[] {
    const accepted = validateImportedCatalog(imported, this.#ownerId, targetId);
    const existing = this.list(targetId);
    const currentById = new Map(existing.map((host) => [host.id, host]));
    const importedById = new Map(accepted.map((host) => [host.id, host]));

    // Preflight the complete source snapshot before the first durable write.
    // Concurrent writers remain fenced by each Store revision CAS.
    for (const host of accepted) {
      const current = currentById.get(host.id);
      if (current === undefined || current.source === "manual") continue;
      if (isActiveStatus(current.status.state) && routingChanged(current, host)) {
        throw new StoreError("An active Remote Host cannot be changed by SSH config refresh.");
      }
    }
    for (const current of existing) {
      if (
        current.source === "ssh_config" && !importedById.has(current.id) &&
        isActiveStatus(current.status.state)
      ) {
        throw new StoreError("An active Remote Host cannot be removed by SSH config refresh.");
      }
    }

    for (const current of existing) {
      if (current.source !== "ssh_config" || importedById.has(current.id)) continue;
      const deleted = this.#store.deleteRemoteHost({
        ownerId: current.ownerId,
        targetId: current.targetId,
        id: current.id,
        expectedRevision: current.revision
      });
      this.retireController(current.targetId, current.id);
      this.publish({ kind: "deleted", host: deleted });
    }

    for (const importedHost of accepted) {
      let current = currentById.get(importedHost.id);
      if (current?.source === "manual") continue;
      if (current === undefined) {
        const created = this.#store.createRemoteHost({
          ownerId: this.#ownerId,
          targetId,
          id: importedHost.id,
          hostname: importedHost.hostname,
          port: importedHost.port,
          user: importedHost.user,
          source: "ssh_config",
          createdAt: this.#now()
        });
        this.publish({ kind: "upserted", host: created });
        continue;
      }
      if (!routingChanged(current, importedHost)) continue;
      this.retireController(current.targetId, current.id);
      if (
        current.trust !== undefined &&
        (current.hostname !== importedHost.hostname || current.port !== importedHost.port)
      ) {
        current = this.#store.clearRemoteHostTrust({
          ownerId: current.ownerId,
          targetId: current.targetId,
          id: current.id,
          expectedRevision: current.revision,
          clearedAt: Math.max(current.updatedAt, this.#now())
        });
        this.publish({ kind: "upserted", host: current });
      }
      const updated = this.#store.updateRemoteHost({
        ownerId: current.ownerId,
        targetId: current.targetId,
        id: current.id,
        expectedRevision: current.revision,
        hostname: importedHost.hostname,
        port: importedHost.port,
        user: importedHost.user,
        source: "ssh_config",
        updatedAt: Math.max(current.updatedAt, this.#now())
      });
      this.publish({ kind: "upserted", host: updated });
    }
    return this.list(targetId);
  }

  private async runConnectionTest(
    targetId: string,
    id: string,
    expectedRevision: bigint,
    fresh: boolean,
    signal?: AbortSignal
  ): Promise<RemoteHostConnectionOutcome> {
    this.assertOpen();
    let host = this.get(targetId, id);
    assertRevision(host, expectedRevision);
    if (authenticationIsIncomplete(host)) {
      host = this.persistMissingCredentialFailure(host);
      return Object.freeze({ ok: false, host, failure: host.status.failure! });
    }
    const managed = this.controllerFor(host);
    if (fresh && host.status.state === "ready") {
      await managed.controller.disconnect(scopeOf(host));
      host = this.get(targetId, id);
    }
    const result = await managed.controller.test(scopeOf(host), { ...(signal === undefined ? {} : { signal }) });
    this.persistSnapshot(result.snapshot);
    const authoritative = this.get(targetId, id);
    return Object.freeze({
      ok: result.ok,
      host: authoritative,
      ...(authoritative.status.failure === undefined ? {} : { failure: authoritative.status.failure })
    });
  }

  private controllerFor(host: RemoteHostRecord): ManagedController {
    const key = controllerKey(host.targetId, host.id);
    const existing = this.#controllers.get(key);
    if (existing !== undefined) return existing;
    if (authenticationIsIncomplete(host)) throw new StoreError("Remote Host authentication is incomplete.");
    const pinStore = new OperationalHostKeyPinStore({
      store: this.#store,
      ownerId: this.#ownerId,
      targetId: host.targetId,
      hostId: host.id,
      initialTrust: host.trust,
      now: this.#now,
      onChange: (changed) => this.publish({ kind: "upserted", host: changed })
    });
    const controller = new RemoteSshConnectionController({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      hostname: host.hostname,
      port: host.port,
      user: host.user,
      ...(host.credentialReferenceId === undefined
        ? {}
        : { credentialRef: { id: host.credentialReferenceId } })
    }, {
      connector: this.#connector,
      hostKeyVerifier: new TofuSshHostKeyVerifier(pinStore),
      now: this.#now
    });
    const unsubscribe = controller.onStatus(scopeOf(host), (snapshot) => {
      this.persistSnapshot(snapshot);
    });
    const managed = { controller, scope: scopeOf(host), unsubscribe };
    this.#controllers.set(key, managed);
    return managed;
  }

  private persistSnapshot(snapshot: RemoteSshSnapshot): RemoteHostRecord {
    let current = this.get(snapshot.host.targetId, snapshot.host.id);
    const changedAt = Math.max(current.status.changedAt, snapshot.statusChangedAt);
    const route = statusCatchUpRoute(current.status.state, snapshot.status);
    for (const state of route) {
      current = this.persistStatus(
        current,
        state,
        changedAt,
        state === "failed" ? storedFailureCode(snapshot.error?.code) : undefined
      );
      this.publish({ kind: "upserted", host: current });
    }
    if (route.length === 0 && snapshot.status === "failed") {
      const code = storedFailureCode(snapshot.error?.code);
      if (current.status.failure?.code !== code) {
        current = this.persistStatus(current, "failed", changedAt, code);
        this.publish({ kind: "upserted", host: current });
      }
    }
    return current;
  }

  private persistMissingCredentialFailure(host: RemoteHostRecord): RemoteHostRecord {
    let current = host;
    if (current.status.state === "ready" || current.status.state === "authenticating") {
      current = this.persistStatus(current, "disconnected", this.#now());
      this.publish({ kind: "upserted", host: current });
    }
    if (current.status.state !== "connecting") {
      current = this.persistStatus(current, "connecting", this.#now());
      this.publish({ kind: "upserted", host: current });
    }
    current = this.persistStatus(current, "failed", this.#now(), "authentication_failed");
    this.publish({ kind: "upserted", host: current });
    return current;
  }

  private persistStatus(
    current: RemoteHostRecord,
    state: RemoteHostStatus,
    changedAt: number,
    failureCode?: RemoteHostFailureCode
  ): RemoteHostRecord {
    const timestamp = Math.max(current.status.changedAt, changedAt);
    return state === "failed"
      ? this.#store.updateRemoteHostStatus({
          ownerId: current.ownerId,
          targetId: current.targetId,
          id: current.id,
          expectedRevision: current.revision,
          state,
          failureCode: failureCode ?? "connector_protocol",
          changedAt: timestamp
        })
      : this.#store.updateRemoteHostStatus({
          ownerId: current.ownerId,
          targetId: current.targetId,
          id: current.id,
          expectedRevision: current.revision,
          state,
          changedAt: timestamp
        });
  }

  private retireController(targetId: string, id: string): void {
    const key = controllerKey(targetId, id);
    const managed = this.#controllers.get(key);
    managed?.unsubscribe();
    this.#controllers.delete(key);
  }

  private publish(change: RemoteHostRegistryChange): void {
    const listeners = this.#listeners.get(change.host.targetId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // Presentation listeners cannot change the host authority.
      }
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw new StoreError("Remote Host registry is closed.");
  }
}

class RuntimeCredentialAgentAuthConnector implements AgentAuthConnectorPort {
  readonly #credentials: RemoteHostCredentialResolverPort | undefined;
  readonly #connector: ResolvedAgentAuthConnectorPort;

  constructor(credentials: RemoteHostCredentialResolverPort | undefined, connector: ResolvedAgentAuthConnectorPort) {
    this.#credentials = credentials;
    this.#connector = connector;
  }

  async connect(request: AgentAuthConnectorRequest): Promise<AgentAuthConnection> {
    if (request.credentialRef === undefined) {
      const { credentialRef: _credentialReference, ...safeRequest } = request;
      return this.#connector.connect({
        ...safeRequest,
        authentication: { kind: "system_agent" }
      });
    }
    let credential: Buffer;
    try {
      const value = this.#credentials?.resolve(request.credentialRef.id);
      if (value === undefined) throw new Error("credential resolver unavailable");
      credential = Buffer.from(value, "utf8");
      if (credential.byteLength === 0 || credential.byteLength > MAXIMUM_RUNTIME_CREDENTIAL_BYTES) {
        credential.fill(0);
        throw new Error("credential size");
      }
    } catch {
      throw new AgentAuthConnectorFailure("AUTHENTICATION_FAILED");
    }
    const { credentialRef: _credentialReference, ...safeRequest } = request;
    try {
      return await this.#connector.connect({
        ...safeRequest,
        authentication: { kind: "private_key", privateKey: credential }
      });
    } finally {
      credential.fill(0);
    }
  }
}

class UnavailableAgentAuthConnector implements AgentAuthConnectorPort {
  async connect(_request: AgentAuthConnectorRequest): Promise<AgentAuthConnection> {
    throw new AgentAuthConnectorFailure("CONNECTOR_UNAVAILABLE");
  }
}

interface OperationalHostKeyPinStoreOptions {
  readonly store: OperationalStore;
  readonly ownerId: string;
  readonly targetId: string;
  readonly hostId: string;
  readonly initialTrust: RemoteHostRecord["trust"];
  readonly now: () => number;
  readonly onChange: (host: RemoteHostRecord) => void;
}

class OperationalHostKeyPinStore implements SshHostKeyPinStorePort {
  readonly #options: OperationalHostKeyPinStoreOptions;
  #acceptedPin: { readonly algorithm: string; readonly fingerprint: string } | undefined;

  constructor(options: OperationalHostKeyPinStoreOptions) {
    this.#options = options;
  }

  async compareAndPin(request: SshHostKeyPinRequest): Promise<"matched" | "pinned"> {
    const separator = request.id.lastIndexOf("|");
    const algorithm = separator < 1 ? "" : request.id.slice(separator + 1);
    let current: RemoteHostRecord;
    try {
      current = this.#options.store.getRemoteHost(
        this.#options.ownerId,
        this.#options.targetId,
        this.#options.hostId
      );
    } catch (error) {
      throw hostKeyStoreFailure(error);
    }
    let expectedId: string;
    try {
      expectedId = sshHostKeyPinId(current.hostname, current.port, algorithm);
    } catch {
      throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key pin is invalid.", false);
    }
    if (request.id !== expectedId) {
      throw new RemoteSshError("HOST_KEY_INVALID", "The SSH host key pin is invalid.", false);
    }
    if (current.trust !== undefined) {
      if (current.trust.algorithm === algorithm && current.trust.fingerprint === request.fingerprint) {
        const initiallyTrusted = this.#options.initialTrust?.algorithm === algorithm &&
          this.#options.initialTrust.fingerprint === request.fingerprint;
        const pinnedByThisConnection = this.#acceptedPin?.algorithm === algorithm &&
          this.#acceptedPin.fingerprint === request.fingerprint;
        if (!initiallyTrusted && !pinnedByThisConnection) {
          throw new RemoteSshError(
            "HOST_KEY_CONFLICT",
            "Concurrent host key trust could not be established safely.",
            false
          );
        }
        return "matched";
      }
      throw new RemoteSshError("HOST_KEY_CHANGED", "The remote host key changed. Connection was refused.", false);
    }
    try {
      const pinned = this.#options.store.pinRemoteHostTrust({
        ownerId: current.ownerId,
        targetId: current.targetId,
        id: current.id,
        expectedRevision: current.revision,
        algorithm,
        fingerprint: request.fingerprint,
        pinnedAt: Math.max(current.createdAt, this.#options.now())
      });
      this.#acceptedPin = Object.freeze({ algorithm, fingerprint: request.fingerprint });
      this.#options.onChange(pinned);
      return "pinned";
    } catch (error) {
      throw hostKeyStoreFailure(error);
    }
  }
}

function hostKeyStoreFailure(error: unknown): RemoteSshError {
  if (error instanceof RevisionConflictError) {
    return new RemoteSshError("HOST_KEY_CONFLICT", "Concurrent host key trust could not be established safely.", false);
  }
  if (error instanceof NotFoundError) {
    return new RemoteSshError("HOST_KEY_STORE_MISSING", "The trusted host key store is missing.", false);
  }
  if (error instanceof StoreError) {
    return new RemoteSshError("HOST_KEY_STORE_WRITE_FAILED", "The trusted host key store could not be written safely.", false);
  }
  return new RemoteSshError("HOST_KEY_STORE_UNREADABLE", "The trusted host key store could not be read.", false);
}

function storedFailureCode(code: RemoteSshErrorCode | undefined): RemoteHostFailureCode {
  switch (code) {
    case "ABORTED": return "aborted";
    case "AUTHENTICATION_FAILED": return "authentication_failed";
    case "CONNECTION_FAILED": return "connection_failed";
    case "CONNECTION_TIMEOUT": return "connection_timeout";
    case "CONNECTOR_PROTOCOL": return "connector_protocol";
    case "CONNECTOR_UNAVAILABLE": return "connector_unavailable";
    case "HOST_KEY_CHANGED": return "host_key_changed";
    case "HOST_KEY_CONFLICT": return "host_key_conflict";
    case "HOST_KEY_INVALID": return "host_key_invalid";
    case "HOST_KEY_MISSING": return "host_key_missing";
    case "HOST_KEY_STORE_CORRUPT": return "host_key_store_corrupt";
    case "HOST_KEY_STORE_MISSING": return "host_key_store_missing";
    case "HOST_KEY_STORE_UNREADABLE": return "host_key_store_unreadable";
    case "HOST_KEY_STORE_WRITE_FAILED": return "host_key_store_write_failed";
    default: return "connector_protocol";
  }
}

function connectionOutcomeError(outcome: RemoteHostConnectionOutcome): RemoteSshError {
  const code = remoteFailureCode(outcome.failure?.code ?? "connector_protocol");
  return new RemoteSshError(code, "Remote Host could not establish a safe connection.", false);
}

function remoteFailureCode(code: RemoteHostFailureCode): RemoteSshErrorCode {
  switch (code) {
    case "aborted": return "ABORTED";
    case "authentication_failed": return "AUTHENTICATION_FAILED";
    case "connection_failed": return "CONNECTION_FAILED";
    case "connection_timeout": return "CONNECTION_TIMEOUT";
    case "connector_protocol": return "CONNECTOR_PROTOCOL";
    case "connector_unavailable": return "CONNECTOR_UNAVAILABLE";
    case "host_key_changed": return "HOST_KEY_CHANGED";
    case "host_key_conflict": return "HOST_KEY_CONFLICT";
    case "host_key_invalid": return "HOST_KEY_INVALID";
    case "host_key_missing": return "HOST_KEY_MISSING";
    case "host_key_store_corrupt": return "HOST_KEY_STORE_CORRUPT";
    case "host_key_store_missing": return "HOST_KEY_STORE_MISSING";
    case "host_key_store_unreadable": return "HOST_KEY_STORE_UNREADABLE";
    case "host_key_store_write_failed": return "HOST_KEY_STORE_WRITE_FAILED";
  }
}

function statusCatchUpRoute(from: RemoteHostStatus, to: RemoteHostStatus): RemoteHostStatus[] {
  if (from === to) return [];
  if (to === "disconnected") return ["disconnected"];
  if (to === "connecting") return from === "ready" || from === "authenticating"
    ? ["disconnected", "connecting"]
    : ["connecting"];
  if (to === "authenticating") {
    if (from === "disconnected" || from === "failed") return ["connecting", "authenticating"];
    if (from === "ready") return ["disconnected", "connecting", "authenticating"];
    return ["authenticating"];
  }
  if (to === "ready") {
    if (from === "disconnected" || from === "failed") return ["connecting", "authenticating", "ready"];
    if (from === "connecting") return ["authenticating", "ready"];
    return ["ready"];
  }
  if (from === "disconnected") return ["connecting", "failed"];
  return ["failed"];
}

function controllerKey(targetId: string, id: string): string {
  return `${targetId.length}:${targetId}${id}`;
}

function scopeOf(host: RemoteHostRecord): { readonly ownerId: string; readonly targetId: string } {
  return { ownerId: host.ownerId, targetId: host.targetId };
}

function validateImportedCatalog(
  imported: readonly RemoteSshConfigHost[],
  ownerId: string,
  targetId: string
): readonly RemoteSshConfigHost[] {
  if (!Array.isArray(imported)) {
    throw new RemoteSshError("CONFIG_INVALID", "The SSH config catalog is invalid.", false);
  }
  const ids = new Set<string>();
  const accepted: RemoteSshConfigHost[] = [];
  for (const candidate of imported) {
    if (candidate === null || typeof candidate !== "object") {
      throw new RemoteSshError("CONFIG_INVALID", "The SSH config catalog is invalid.", false);
    }
    if (candidate.ownerId !== ownerId || candidate.targetId !== targetId || candidate.source !== "ssh_config") {
      throw new RemoteSshError("CONFIG_INVALID", "The SSH config catalog scope is invalid.", false);
    }
    const id = importedAlias(candidate.id);
    if (ids.has(id)) {
      throw new RemoteSshError("CONFIG_INVALID", "The SSH config contains a duplicate concrete Host alias.", false);
    }
    ids.add(id);
    const hostname = importedHostname(candidate.hostname);
    const user = importedUser(candidate.user);
    if (!Number.isSafeInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535) {
      throw new RemoteSshError("CONFIG_INVALID", "The SSH config contains an invalid port.", false);
    }
    accepted.push(Object.freeze({ ownerId, targetId, id, hostname, port: candidate.port, user, source: "ssh_config" }));
  }
  return Object.freeze(accepted);
}

function importedAlias(value: string): string {
  const accepted = importedIdentity(value, "Host alias", 256);
  if (accepted.startsWith("!") || /[*?\s'"\\#]/u.test(accepted)) {
    throw new RemoteSshError("CONFIG_INVALID", "The SSH config contains an invalid concrete Host alias.", false);
  }
  return accepted;
}

function importedHostname(value: string): string {
  const accepted = importedIdentity(value, "hostname", 1_024);
  if (/[\s\/@'"\\#]/u.test(accepted)) {
    throw new RemoteSshError("CONFIG_INVALID", "The SSH config contains an invalid hostname.", false);
  }
  return accepted;
}

function importedUser(value: string): string {
  const accepted = importedIdentity(value, "user", 256);
  if (/[\s@'"\\#]/u.test(accepted)) {
    throw new RemoteSshError("CONFIG_INVALID", "The SSH config contains an invalid user.", false);
  }
  return accepted;
}

function importedIdentity(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value === "" || value !== value.trim() || value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RemoteSshError("CONFIG_INVALID", `The SSH config contains an invalid ${label}.`, false);
  }
  return value;
}

function routingChanged(current: RemoteHostRecord, imported: RemoteSshConfigHost): boolean {
  return current.hostname !== imported.hostname || current.port !== imported.port || current.user !== imported.user;
}

function boundedIdentity(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value === "" || value !== value.trim() ||
    value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new StoreError(`Remote Host ${label} is invalid.`);
  return value;
}

function isActiveStatus(status: RemoteHostStatus): boolean {
  return status === "connecting" || status === "authenticating" || status === "ready";
}

function authenticationIsIncomplete(host: RemoteHostRecord): boolean {
  return host.authenticationMode === "private_key" && host.credentialReferenceId === undefined;
}

function assertRevision(host: RemoteHostRecord, expectedRevision: bigint): void {
  if (host.revision !== expectedRevision) {
    throw new RevisionConflictError("Remote Host", host.id, expectedRevision, host.revision);
  }
}
