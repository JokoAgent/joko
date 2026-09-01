import { readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentAuthConnectorFailure,
  RemoteSshError,
  sshHostKeyFingerprint,
  type AgentAuthConnection,
  type RemoteSshConfigHost,
  type SshConfigFilePort
} from "@joko/remote-ssh";
import {
  NotFoundError,
  OperationalStore,
  RevisionConflictError,
  StoreError,
  type CreateRemoteHostInput,
  type RemoteHostRecord,
  type RemoteHostStatus
} from "@joko/store";

import {
  RemoteHostRegistry,
  type RemoteHostCredentialResolverPort,
  type RemoteHostCreate,
  type RemoteHostRegistryChange,
  type ResolvedAgentAuthConnectorPort,
  type ResolvedAgentAuthConnectorRequest
} from "./remote-host-registry.js";

const cleanups: Array<() => Promise<void> | void> = [];
const CREDENTIAL_VALUE = "EPHEMERAL_CREDENTIAL_VALUE_MUST_NOT_PERSIST";
const RAW_CONNECTOR_ERROR = "RAW_CONNECTOR_ERROR_MUST_NOT_PERSIST";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("RemoteHostRegistry owner-private catalog", () => {
  it("fixes the owner scope and isolates target CRUD, subscriptions, and revisions", () => {
    const fixture = createFixture();
    const registry = fixture.registry();
    const targetAChanges: RemoteHostRegistryChange[] = [];
    const targetBChanges: RemoteHostRegistryChange[] = [];
    registry.subscribe("target-a", (change) => targetAChanges.push(change));
    registry.subscribe("target-b", (change) => targetBChanges.push(change));

    const createdA = registry.create({
      targetId: "target-a",
      id: "shared",
      hostname: "host-a.example.test",
      user: "maker",
      source: "manual",
      credentialReferenceId: "agent:host-a",
      ownerId: "owner-b"
    } as RemoteHostCreate & { readonly ownerId: string });
    const createdB = registry.create({
      targetId: "target-b",
      id: "shared",
      hostname: "host-b.example.test",
      port: 2202,
      user: "builder",
      source: "ssh_config"
    });
    fixture.store.createRemoteHost(hostInput({
      ownerId: "owner-b",
      targetId: "target-a",
      id: "shared",
      hostname: "other-owner.example.test"
    }));

    expect(createdA.ownerId).toBe("owner-a");
    expect(registry.list("target-a")).toEqual([createdA]);
    expect(registry.list("target-b")).toEqual([createdB]);
    expect(registry.get("target-a", "shared").hostname).toBe("host-a.example.test");
    expect(registry.get("target-b", "shared").hostname).toBe("host-b.example.test");
    expect(() => registry.get("target-a", "missing")).toThrow(NotFoundError);
    expect(fixture.store.getRemoteHost("owner-b", "target-a", "shared").hostname)
      .toBe("other-owner.example.test");

    const updated = registry.update({
      targetId: createdA.targetId,
      id: createdA.id,
      expectedRevision: createdA.revision,
      user: "deployer"
    });
    expect(updated.user).toBe("deployer");
    expect(updated.revision).toBeGreaterThan(createdA.revision);
    expect(() => registry.update({
      targetId: createdA.targetId,
      id: createdA.id,
      expectedRevision: createdA.revision,
      user: "stale-writer"
    })).toThrow(RevisionConflictError);

    const deleted = registry.delete({
      targetId: updated.targetId,
      id: updated.id,
      expectedRevision: updated.revision
    });
    expect(deleted.id).toBe("shared");
    expect(() => registry.get("target-a", "shared")).toThrow(NotFoundError);
    expect(targetAChanges.map((change) => change.kind)).toEqual(["upserted", "upserted", "deleted"]);
    expect(targetAChanges.every((change) => change.host.targetId === "target-a")).toBe(true);
    expect(targetBChanges.map((change) => change.host.targetId)).toEqual(["target-b"]);
  });

  it("refreshes the exact target from the service-owned SSH config without overwriting manual hosts", async () => {
    const fixture = createFixture();
    const catalog = configPort([
      configHost({ id: "manual", hostname: "ignored.example.test" }),
      configHost({ id: "changed", hostname: "new.example.test", port: 2202, user: "deployer" }),
      configHost({ id: "added", hostname: "added.example.test" })
    ]);
    const registry = fixture.registry({
      sshConfig: catalog,
      defaultSshUser: "default-user"
    });
    const manual = registry.create(hostCreate({ id: "manual", hostname: "manual.example.test" }));
    let changed = registry.create(hostCreate({
      id: "changed",
      hostname: "old.example.test",
      source: "ssh_config",
      credentialReferenceId: "agent:changed"
    }));
    changed = fixture.store.pinRemoteHostTrust({
      ownerId: changed.ownerId,
      targetId: changed.targetId,
      id: changed.id,
      expectedRevision: changed.revision,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      pinnedAt: changed.createdAt
    });
    const removed = registry.create(hostCreate({ id: "removed", source: "ssh_config" }));
    const otherTarget = registry.create(hostCreate({
      targetId: "target-b",
      id: "other-target",
      source: "ssh_config"
    }));
    fixture.store.createRemoteHost(hostInput({
      ownerId: "owner-b",
      id: "other-owner",
      source: "ssh_config"
    }));
    const changes: RemoteHostRegistryChange[] = [];
    registry.subscribe("target-a", (change) => changes.push(change));

    const refreshed = await registry.refresh("target-a");

    expect(catalog.importHosts).toHaveBeenCalledWith({
      ownerId: "owner-a",
      targetId: "target-a",
      defaultUser: "default-user"
    });
    expect(refreshed.map((host) => host.id)).toEqual(["added", "changed", "manual"]);
    expect(registry.get("target-a", manual.id)).toEqual(manual);
    const refreshedChanged = registry.get("target-a", changed.id);
    expect(refreshedChanged).toMatchObject({
      hostname: "new.example.test",
      port: 2202,
      user: "deployer",
      source: "ssh_config",
      credentialReferenceId: "agent:changed"
    });
    expect(refreshedChanged.trust).toBeUndefined();
    expect(() => registry.get("target-a", removed.id)).toThrow(NotFoundError);
    expect(registry.get("target-b", otherTarget.id)).toEqual(otherTarget);
    expect(fixture.store.getRemoteHost("owner-b", "target-a", "other-owner").id).toBe("other-owner");
    expect(changes.map((change) => [change.kind, change.host.id])).toEqual([
      ["deleted", "removed"],
      ["upserted", "changed"],
      ["upserted", "changed"],
      ["upserted", "added"]
    ]);
  });

  it("fails config refresh before mutation for duplicate, wrong-scope, or active routing changes", async () => {
    const fixture = createFixture();
    const importHosts = vi.fn<() => Promise<readonly RemoteSshConfigHost[]>>();
    const catalog = configPort([], importHosts);
    const registry = fixture.registry({ sshConfig: catalog, defaultSshUser: "maker" });
    const stable = registry.create(hostCreate({ id: "stable", source: "ssh_config" }));

    importHosts.mockResolvedValueOnce([
      configHost({ id: "duplicate" }),
      configHost({ id: "duplicate", hostname: "second.example.test" })
    ]);
    await expect(registry.refresh("target-a")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(registry.list("target-a")).toEqual([stable]);

    importHosts.mockResolvedValueOnce([
      configHost({ ownerId: "owner-b", id: "wrong-owner" })
    ]);
    await expect(registry.refresh("target-a")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(registry.list("target-a")).toEqual([stable]);

    let active = fixture.store.updateRemoteHostStatus({
      ownerId: stable.ownerId,
      targetId: stable.targetId,
      id: stable.id,
      expectedRevision: stable.revision,
      state: "connecting"
    });
    active = fixture.store.updateRemoteHostStatus({
      ownerId: active.ownerId,
      targetId: active.targetId,
      id: active.id,
      expectedRevision: active.revision,
      state: "authenticating"
    });
    active = fixture.store.updateRemoteHostStatus({
      ownerId: active.ownerId,
      targetId: active.targetId,
      id: active.id,
      expectedRevision: active.revision,
      state: "ready"
    });
    importHosts.mockResolvedValueOnce([
      configHost({ id: active.id, hostname: "changed-while-active.example.test" }),
      configHost({ id: "must-not-be-created" })
    ]);
    await expect(registry.refresh("target-a")).rejects.toBeInstanceOf(StoreError);
    expect(registry.get("target-a", active.id)).toEqual(active);
    expect(() => registry.get("target-a", "must-not-be-created")).toThrow(NotFoundError);
  });
});

describe("RemoteHostRegistry credential and lifecycle boundary", () => {
  it("resolves credentials only for a CAS-valid connection and zeroes the bytes when connect settles", async () => {
    const fixture = createFixture();
    const resolve = vi.fn((_referenceId: string) => CREDENTIAL_VALUE);
    let credentialSeenWhileConnecting = "";
    const close = vi.fn(async () => undefined);
    const connector = recordingConnector(async (request) => {
      if (request.authentication.kind !== "private_key") throw new Error("unexpected authentication mode");
      credentialSeenWhileConnecting = Buffer.from(request.authentication.privateKey).toString("utf8");
      request.onAuthenticating();
      await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1, 2, 3) });
      return { close };
    });
    const registry = fixture.registry({ credentials: { resolve }, connector });
    const created = registry.create(hostCreate({ credentialReferenceId: "agent:runtime-a" }));
    const updated = registry.update({
      targetId: created.targetId,
      id: created.id,
      expectedRevision: created.revision,
      user: "deployer"
    });

    registry.list(created.targetId);
    registry.get(created.targetId, created.id);
    expect(resolve).not.toHaveBeenCalled();
    expect(connector.callCount).toBe(0);
    await expect(registry.connect(created.targetId, created.id, created.revision))
      .rejects.toBeInstanceOf(RevisionConflictError);
    expect(resolve).not.toHaveBeenCalled();
    expect(connector.callCount).toBe(0);

    const outcome = await registry.connect(updated.targetId, updated.id, updated.revision);
    expect(outcome).toMatchObject({ ok: true, host: { status: { state: "ready" } } });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith("agent:runtime-a");
    expect(credentialSeenWhileConnecting).toBe(CREDENTIAL_VALUE);
    expect(connector.credentialViews).toHaveLength(1);
    expect([...connector.credentialViews[0]!].every((byte) => byte === 0)).toBe(true);
    expect(safeJson(outcome)).not.toContain(CREDENTIAL_VALUE);
    expect(safeJson(registry.list(updated.targetId))).not.toContain(CREDENTIAL_VALUE);
    expect(safeJson(fixture.store.getRemoteHost("owner-a", updated.targetId, updated.id)))
      .not.toContain(CREDENTIAL_VALUE);

    const disconnected = await registry.disconnect(
      outcome.host.targetId,
      outcome.host.id,
      outcome.host.revision
    );
    expect(disconnected.status.state).toBe("disconnected");
    expect(close).toHaveBeenCalledOnce();
    await registry.close();
    expect(resolve).toHaveBeenCalledOnce();
    fixture.store.close();
    expectDirectoryNotToContain(fixture.directory, CREDENTIAL_VALUE);
  });

  it("publishes all five states, never retries authentication failure, and persists no raw error", async () => {
    const fixture = createFixture();
    const resolve = vi.fn(() => "short-lived-auth");
    const successfulClose = vi.fn(async () => undefined);
    const connector = recordingConnector(async (request, call) => {
      request.onAuthenticating();
      if (call === 0) {
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(7, 8, 9) });
        return { close: successfulClose };
      }
      const failure = new AgentAuthConnectorFailure("AUTHENTICATION_FAILED");
      failure.message = RAW_CONNECTOR_ERROR;
      throw failure;
    });
    const registry = fixture.registry({ credentials: { resolve }, connector });
    const created = registry.create(hostCreate({ credentialReferenceId: "agent:lifecycle" }));
    const states: RemoteHostStatus[] = [created.status.state];
    registry.subscribe(created.targetId, (change) => {
      if (change.kind === "upserted" && change.host.id === created.id) {
        states.push(change.host.status.state);
      }
    });

    const connected = await registry.connect(created.targetId, created.id, created.revision);
    expect(connected.ok).toBe(true);
    const failed = await registry.test(
      connected.host.targetId,
      connected.host.id,
      connected.host.revision
    );
    expect(failed).toMatchObject({
      ok: false,
      host: { status: { state: "failed" } },
      failure: { code: "authentication_failed", retryable: false }
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(connector.callCount).toBe(2);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(successfulClose).toHaveBeenCalledOnce();
    expect(connector.credentialViews.every((view) => [...view].every((byte) => byte === 0))).toBe(true);
    expect(collapseAdjacent(states)).toEqual([
      "disconnected",
      "connecting",
      "authenticating",
      "ready",
      "disconnected",
      "connecting",
      "authenticating",
      "failed"
    ]);
    expect(safeJson(failed)).not.toContain(RAW_CONNECTOR_ERROR);
    expect(safeJson(fixture.store.getRemoteHost("owner-a", created.targetId, created.id)))
      .not.toContain(RAW_CONNECTOR_ERROR);

    await registry.close();
    fixture.store.close();
    expectDirectoryNotToContain(fixture.directory, RAW_CONNECTOR_ERROR);
  });
});

describe("RemoteHostRegistry host trust", () => {
  it("pins on first use, matches the same key, and fails closed on a changed key without replacing the pin", async () => {
    const fixture = createFixture();
    const firstKey = Uint8Array.of(10, 20, 30, 40);
    const changedKey = Uint8Array.of(40, 30, 20, 10);
    const keys = [firstKey, firstKey, changedKey] as const;
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const connector = recordingConnector(async (request, call) => {
      request.onAuthenticating();
      await request.verifyHostKey({ algorithm: "ssh-ed25519", key: keys[call]! });
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { close };
    });
    const registry = fixture.registry({
      credentials: { resolve: () => "temporary-auth" },
      connector
    });
    const created = registry.create(hostCreate({ credentialReferenceId: "agent:trust" }));

    const first = await registry.test(created.targetId, created.id, created.revision);
    expect(first).toMatchObject({ ok: true, host: { status: { state: "ready" } } });
    expect(first.host.trust).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: sshHostKeyFingerprint(firstKey),
      pinnedAt: expect.any(Number)
    });
    const originalTrust = first.host.trust;

    const matched = await registry.test(first.host.targetId, first.host.id, first.host.revision);
    expect(matched.ok).toBe(true);
    expect(matched.host.trust).toEqual(originalTrust);

    const changed = await registry.test(matched.host.targetId, matched.host.id, matched.host.revision);
    expect(changed).toMatchObject({
      ok: false,
      failure: { code: "host_key_changed", retryable: false },
      host: { status: { state: "failed" } }
    });
    expect(changed.host.trust).toEqual(originalTrust);
    expect(fixture.store.getRemoteHost("owner-a", created.targetId, created.id).trust)
      .toEqual(originalTrust);
    expect(connector.callCount).toBe(3);
    expect(closes).toHaveLength(2);
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  });

  it("allows one DB-backed first-use pin and fails a concurrent first-use connection closed", async () => {
    const fixture = createFixture();
    let arrivals = 0;
    let release = (): void => undefined;
    const rendezvous = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const key = Uint8Array.of(22, 44, 66, 88);
    const connector = recordingConnector(async (request) => {
      request.onAuthenticating();
      arrivals += 1;
      if (arrivals === 2) release();
      await rendezvous;
      await request.verifyHostKey({ algorithm: "ssh-ed25519", key });
      return { close: vi.fn(async () => undefined) };
    });
    const registryA = fixture.registry({
      credentials: { resolve: () => "temporary-auth-a" },
      connector
    });
    const created = registryA.create(hostCreate({ credentialReferenceId: "agent:concurrent" }));
    const pendingA = registryA.test(created.targetId, created.id, created.revision);

    const registryB = fixture.registry({
      credentials: { resolve: () => "temporary-auth-b" },
      connector
    });
    const current = registryB.get(created.targetId, created.id);
    const pendingB = registryB.test(current.targetId, current.id, current.revision);
    const outcomes = await Promise.all([pendingA, pendingB]);

    expect(connector.callCount).toBe(2);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      expect.objectContaining({ failure: { code: "host_key_conflict", retryable: false } })
    ]);
    expect(fixture.store.getRemoteHost("owner-a", created.targetId, created.id).trust).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: sshHostKeyFingerprint(key),
      pinnedAt: expect.any(Number)
    });
  });
});

describe("RemoteHostRegistry unavailable boundaries", () => {
  it("uses the system agent without credential resolution and fails closed when required capabilities are absent", async () => {
    const fixture = createFixture();
    const resolve = vi.fn(() => "unused-auth");
    const key = Buffer.from("system-agent-host-key");
    let calls = 0;
    const connector: ResolvedAgentAuthConnectorPort = {
      capabilities: {
        commandExecution: false,
        processStreaming: false,
        fileTransfer: false,
        tcpForwarding: false
      },
      async connect(request) {
        calls += 1;
        expect(request.authentication).toEqual({ kind: "system_agent" });
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key });
        return { close: vi.fn(async () => undefined) };
      }
    };
    const configured = fixture.registry({ credentials: { resolve }, connector });
    const systemAgent = configured.create(hostCreate({
      id: "system-agent",
      authenticationMode: "system_agent"
    }));

    const connected = await configured.test(
      systemAgent.targetId,
      systemAgent.id,
      systemAgent.revision
    );
    expect(connected).toMatchObject({ ok: true, host: { status: { state: "ready" } } });
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toBe(1);

    const unresolvedKey = configured.create(hostCreate({
      id: "unresolved-private-key",
      authenticationMode: "private_key",
      credentialReferenceId: "agent:missing"
    }));
    const noCredentialRegistry = fixture.registry({ connector });
    const unresolved = await noCredentialRegistry.test(
      unresolvedKey.targetId,
      unresolvedKey.id,
      unresolvedKey.revision
    );
    expect(unresolved).toMatchObject({
      ok: false,
      failure: { code: "authentication_failed", retryable: false },
      host: { status: { state: "failed" } }
    });
    expect(calls).toBe(1);

    const unavailableHost = configured.create(hostCreate({
      id: "connector-unavailable",
      authenticationMode: "private_key",
      credentialReferenceId: "agent:unavailable"
    }));
    const unavailableRegistry = fixture.registry();
    expect(unavailableRegistry.capabilities()).toEqual({
      catalog: true,
      connectionTest: false,
      connectionLifecycle: false,
      commandExecution: false,
      processStreaming: false,
      fileTransfer: false,
      tcpForwarding: false
    });
    const unavailable = await unavailableRegistry.connect(
      unavailableHost.targetId,
      unavailableHost.id,
      unavailableHost.revision
    );
    expect(unavailable).toMatchObject({
      ok: false,
      failure: { code: "connector_unavailable", retryable: true },
      host: { status: { state: "failed" } }
    });
  });
});

describe("RemoteHostRegistry restart and shutdown", () => {
  it("reconciles owner-scoped leftover connecting, authenticating, and ready snapshots to disconnected", () => {
    const fixture = createFixture();
    const seeded = [
      seedStatus(fixture.store, "connecting", "connecting"),
      seedStatus(fixture.store, "authenticating", "authenticating"),
      seedStatus(fixture.store, "ready", "ready")
    ];
    const otherOwner = seedStatus(fixture.store, "other-ready", "ready", "owner-b");
    const registry = fixture.registry({ ownerId: "owner-a" });

    for (const before of seeded) {
      const after = registry.get(before.targetId, before.id);
      expect(after.status.state).toBe("disconnected");
      expect(after.revision).toBeGreaterThan(before.revision);
    }
    expect(fixture.store.getRemoteHost("owner-b", otherOwner.targetId, otherOwner.id).status.state)
      .toBe("ready");
  });

  it("closes explicit and registry-wide connections and rejects use after shutdown", async () => {
    const fixture = createFixture();
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const connector = recordingConnector(async (request, call) => {
      request.onAuthenticating();
      await request.verifyHostKey({
        algorithm: "ssh-ed25519",
        key: Uint8Array.of(90 + call, 80 + call, 70 + call)
      });
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { close };
    });
    const registry = fixture.registry({
      credentials: { resolve: () => "shutdown-auth" },
      connector
    });
    const first = registry.create(hostCreate({ id: "first", credentialReferenceId: "agent:first" }));
    const second = registry.create(hostCreate({ id: "second", credentialReferenceId: "agent:second" }));
    const connectedFirst = await registry.connect(first.targetId, first.id, first.revision);
    const connectedSecond = await registry.connect(second.targetId, second.id, second.revision);

    const disconnected = await registry.disconnect(
      connectedFirst.host.targetId,
      connectedFirst.host.id,
      connectedFirst.host.revision
    );
    expect(disconnected.status.state).toBe("disconnected");
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(connectedSecond.host.status.state).toBe("ready");

    await registry.close();
    await registry.close();
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(closes[1]).toHaveBeenCalledOnce();
    expect(fixture.store.getRemoteHost("owner-a", second.targetId, second.id).status.state)
      .toBe("disconnected");
    expect(() => registry.list("target-a")).toThrow(StoreError);
    await expect(registry.connect(second.targetId, second.id, connectedSecond.host.revision))
      .rejects.toBeInstanceOf(StoreError);
  });
});

interface RecordingConnector extends ResolvedAgentAuthConnectorPort {
  readonly credentialViews: Uint8Array[];
  readonly safeCalls: Array<{
    readonly hostname: string;
    readonly port: number;
    readonly user: string;
  }>;
  readonly callCount: number;
}

function recordingConnector(
  behavior: (request: ResolvedAgentAuthConnectorRequest, call: number) => Promise<AgentAuthConnection>
): RecordingConnector {
  const credentialViews: Uint8Array[] = [];
  const safeCalls: RecordingConnector["safeCalls"] = [];
  return {
    capabilities: {
      commandExecution: false,
      processStreaming: false,
      fileTransfer: false,
      tcpForwarding: false
    },
    credentialViews,
    safeCalls,
    get callCount() { return safeCalls.length; },
    async connect(request) {
      const call = safeCalls.length;
      if (request.authentication.kind !== "private_key") throw new Error("unexpected authentication mode");
      credentialViews.push(request.authentication.privateKey);
      safeCalls.push({ hostname: request.hostname, port: request.port, user: request.user });
      return behavior(request, call);
    }
  };
}

function hostCreate(overrides: Partial<RemoteHostCreate> = {}): RemoteHostCreate {
  return {
    targetId: "target-a",
    id: "host-a",
    hostname: "host.example.test",
    port: 22,
    user: "maker",
    source: "manual",
    ...overrides
  };
}

function hostInput(overrides: Partial<CreateRemoteHostInput> = {}): CreateRemoteHostInput {
  return {
    ownerId: "owner-a",
    ...hostCreate(),
    ...overrides
  };
}

function seedStatus(
  store: OperationalStore,
  id: string,
  status: "connecting" | "authenticating" | "ready",
  ownerId = "owner-a"
): RemoteHostRecord {
  let host = store.createRemoteHost(hostInput({ ownerId, id }));
  host = store.updateRemoteHostStatus({
    ownerId: host.ownerId,
    targetId: host.targetId,
    id: host.id,
    expectedRevision: host.revision,
    state: "connecting"
  });
  if (status === "connecting") return host;
  host = store.updateRemoteHostStatus({
    ownerId: host.ownerId,
    targetId: host.targetId,
    id: host.id,
    expectedRevision: host.revision,
    state: "authenticating"
  });
  if (status === "authenticating") return host;
  return store.updateRemoteHostStatus({
    ownerId: host.ownerId,
    targetId: host.targetId,
    id: host.id,
    expectedRevision: host.revision,
    state: "ready"
  });
}

function collapseAdjacent(values: readonly RemoteHostStatus[]): RemoteHostStatus[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

function expectDirectoryNotToContain(directory: string, value: string): void {
  const needle = Buffer.from(value);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    expect(readFileSync(path.join(directory, entry.name)).includes(needle)).toBe(false);
  }
}

interface Fixture {
  readonly directory: string;
  readonly store: OperationalStore;
  registry(options?: {
    readonly ownerId?: string;
    readonly credentials?: RemoteHostCredentialResolverPort;
    readonly connector?: ResolvedAgentAuthConnectorPort;
    readonly sshConfig?: SshConfigFilePort;
    readonly defaultSshUser?: string;
    readonly now?: () => number;
  }): RemoteHostRegistry;
}

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-remote-host-registry-"));
  const filePath = path.join(directory, "operational.sqlite");
  let clock = 1_000;
  const now = () => ++clock;
  const store = new OperationalStore(filePath, { now });
  const registries: RemoteHostRegistry[] = [];
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const id of ["target-a", "target-b"]) {
    store.upsertTarget({
      id,
      backendId: "pi",
      displayName: id,
      workspaceRoot: `D:/workspace/${id}`,
      managed: false,
      trusted: true
    });
  }
  cleanups.push(async () => {
    for (const registry of registries) await registry.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    registry(options = {}) {
      const registry = new RemoteHostRegistry({
        store,
        ownerId: options.ownerId ?? "owner-a",
        now: options.now ?? now,
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        ...(options.connector === undefined ? {} : { connector: options.connector }),
        ...(options.sshConfig === undefined ? {} : { sshConfig: options.sshConfig }),
        ...(options.defaultSshUser === undefined ? {} : { defaultSshUser: options.defaultSshUser })
      });
      registries.push(registry);
      return registry;
    }
  };
}

function configHost(overrides: Partial<RemoteSshConfigHost> = {}): RemoteSshConfigHost {
  return {
    ownerId: "owner-a",
    targetId: "target-a",
    id: "imported",
    hostname: "imported.example.test",
    port: 22,
    user: "maker",
    source: "ssh_config",
    ...overrides
  };
}

function configPort(
  hosts: readonly RemoteSshConfigHost[],
  importHosts = vi.fn(async () => hosts)
): SshConfigFilePort & { readonly importHosts: typeof importHosts } {
  return {
    read: vi.fn(async () => { throw new RemoteSshError("CONFIG_IO", "unused", false); }),
    importHosts,
    upsert: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  };
}
