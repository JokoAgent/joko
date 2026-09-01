import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidStateTransitionError,
  NotFoundError,
  OperationalStore,
  RevisionConflictError,
  StoreError,
  type CreateRemoteHostInput,
  type UpdateRemoteHostStatusInput
} from "./index.js";

const cleanups: Array<() => void> = [];
const FINGERPRINT_A = `SHA256:${"A".repeat(43)}`;
const FINGERPRINT_B = `SHA256:${"B".repeat(43)}`;

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("owner-scoped Remote Host persistence", () => {
  it("isolates identical host aliases by owner and target", () => {
    const fixture = createFixture();
    const first = createHost(fixture.store, {
      ownerId: "owner-a",
      targetId: "target-a",
      id: "shared",
      credentialReferenceId: "agent:key-a"
    });
    createHost(fixture.store, {
      ownerId: "owner-b",
      targetId: "target-a",
      id: "shared",
      hostname: "owner-b.example.test"
    });
    createHost(fixture.store, {
      ownerId: "owner-a",
      targetId: "target-b",
      id: "shared",
      hostname: "target-b.example.test"
    });

    expect(first).toMatchObject({
      ownerId: "owner-a",
      targetId: "target-a",
      id: "shared",
      hostname: "host.example.test",
      port: 22,
      user: "maker",
      source: "manual",
      credentialReferenceId: "agent:key-a",
      status: { state: "disconnected" }
    });
    expect(first).not.toHaveProperty("credentialValue");
    expect(fixture.store.listRemoteHosts("owner-a")).toHaveLength(2);
    expect(fixture.store.listRemoteHosts("owner-a", "target-a").map((host) => host.id)).toEqual(["shared"]);
    expect(fixture.store.listRemoteHosts("owner-b", "target-a")).toHaveLength(1);
    expect(fixture.store.findRemoteHost("owner-c", "target-a", "shared")).toBeUndefined();
    expect(fixture.store.findRemoteHost("owner-a", "target-b", "shared")?.hostname)
      .toBe("target-b.example.test");
    expect(() => fixture.store.getRemoteHost("owner-b", "target-b", "shared"))
      .toThrow(NotFoundError);
    expect(() => createHost(fixture.store, { targetId: "missing-target" })).toThrow(NotFoundError);
    expect(() => createHost(fixture.store, { id: "*.example.test" })).toThrow(StoreError);
    expect(() => createHost(fixture.store, { credentialReferenceId: "../private-key" })).toThrow(StoreError);
  });

  it("applies revision checks and protects active or pinned routing metadata", () => {
    const fixture = createFixture();
    const created = createHost(fixture.store, { credentialReferenceId: "agent:key-old" });
    const updated = fixture.store.updateRemoteHost({
      ownerId: created.ownerId,
      targetId: created.targetId,
      id: created.id,
      expectedRevision: created.revision,
      user: "builder",
      source: "ssh_config",
      credentialReferenceId: null
    });
    expect(updated.user).toBe("builder");
    expect(updated.source).toBe("ssh_config");
    expect(updated).not.toHaveProperty("credentialReferenceId");
    expect(updated.revision).toBeGreaterThan(created.revision);

    expect(() => fixture.store.updateRemoteHost({
      ownerId: created.ownerId,
      targetId: created.targetId,
      id: created.id,
      expectedRevision: created.revision,
      user: "stale"
    })).toThrow(RevisionConflictError);

    const pinned = fixture.store.pinRemoteHostTrust({
      ownerId: updated.ownerId,
      targetId: updated.targetId,
      id: updated.id,
      expectedRevision: updated.revision,
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT_A
    });
    expect(() => fixture.store.updateRemoteHost({
      ownerId: pinned.ownerId,
      targetId: pinned.targetId,
      id: pinned.id,
      expectedRevision: pinned.revision,
      hostname: "replacement.example.test"
    })).toThrow(/Clear the Remote Host trust pin/u);

    const cleared = fixture.store.clearRemoteHostTrust({
      ownerId: pinned.ownerId,
      targetId: pinned.targetId,
      id: pinned.id,
      expectedRevision: pinned.revision
    });
    const moved = fixture.store.updateRemoteHost({
      ownerId: cleared.ownerId,
      targetId: cleared.targetId,
      id: cleared.id,
      expectedRevision: cleared.revision,
      hostname: "replacement.example.test",
      port: 2202
    });
    const connecting = fixture.store.updateRemoteHostStatus({
      ownerId: moved.ownerId,
      targetId: moved.targetId,
      id: moved.id,
      expectedRevision: moved.revision,
      state: "connecting"
    });
    expect(() => fixture.store.updateRemoteHost({
      ownerId: connecting.ownerId,
      targetId: connecting.targetId,
      id: connecting.id,
      expectedRevision: connecting.revision,
      credentialReferenceId: "agent:key-new"
    })).toThrow(/active Remote Host/u);
  });

  it("persists only bounded lifecycle failures with derived retryability", () => {
    const fixture = createFixture();
    let host = createHost(fixture.store);
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "connecting",
      changedAt: 10_000
    });
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "authenticating",
      changedAt: 10_001
    });
    const rawFailure = "RAW_FAILURE_MUST_NOT_PERSIST";
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "failed",
      failureCode: "authentication_failed",
      changedAt: 10_002,
      rawError: rawFailure
    } as UpdateRemoteHostStatusInput & { readonly rawError: string });
    expect(host.status).toEqual({
      state: "failed",
      changedAt: 10_002,
      failure: { code: "authentication_failed", retryable: false }
    });
    expect(jsonText(host)).not.toContain(rawFailure);
    expect(() => fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "ready",
      changedAt: 10_003
    })).toThrow(InvalidStateTransitionError);

    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "connecting",
      changedAt: 10_003
    });
    expect(() => fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "failed",
      failureCode: "connection_timeout",
      changedAt: 10_002
    })).toThrow(/cannot move backwards/u);
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "failed",
      failureCode: "connection_timeout",
      changedAt: 10_004
    });
    expect(host.status.failure).toEqual({ code: "connection_timeout", retryable: true });
  });

  it("pins trust with compare-and-set semantics and requires an inactive explicit reset", () => {
    const fixture = createFixture();
    const created = createHost(fixture.store);
    let host = fixture.store.pinRemoteHostTrust({
      ownerId: created.ownerId,
      targetId: created.targetId,
      id: created.id,
      expectedRevision: created.revision,
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT_A,
      pinnedAt: 20_000
    });
    expect(host.trust).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT_A,
      pinnedAt: 20_000
    });
    const idempotent = fixture.store.pinRemoteHostTrust({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT_A
    });
    expect(idempotent.revision).toBe(host.revision);
    expect(() => fixture.store.pinRemoteHostTrust({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT_B
    })).toThrow(/different trust pin/u);
    expect(() => fixture.store.pinRemoteHostTrust({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: created.revision,
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT_A
    })).toThrow(RevisionConflictError);

    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "connecting",
      changedAt: 20_001
    });
    expect(() => fixture.store.clearRemoteHostTrust({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision
    })).toThrow(/active Remote Host/u);
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "disconnected",
      changedAt: 20_002
    });
    host = fixture.store.clearRemoteHostTrust({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      clearedAt: 20_003
    });
    expect(host).not.toHaveProperty("trust");
  });

  it("hydrates scoped trust and last-known status snapshots after restart", () => {
    const fixture = createFixture();
    let primary = createHost(fixture.store, { ownerId: "owner-a", targetId: "target-a", id: "build" });
    primary = fixture.store.pinRemoteHostTrust({
      ownerId: primary.ownerId,
      targetId: primary.targetId,
      id: primary.id,
      expectedRevision: primary.revision,
      algorithm: "ssh-ed25519",
      fingerprint: FINGERPRINT_A,
      pinnedAt: 30_000
    });
    primary = fixture.store.updateRemoteHostStatus({
      ownerId: primary.ownerId,
      targetId: primary.targetId,
      id: primary.id,
      expectedRevision: primary.revision,
      state: "connecting",
      changedAt: 30_001
    });
    primary = fixture.store.updateRemoteHostStatus({
      ownerId: primary.ownerId,
      targetId: primary.targetId,
      id: primary.id,
      expectedRevision: primary.revision,
      state: "authenticating",
      changedAt: 30_002
    });
    primary = fixture.store.updateRemoteHostStatus({
      ownerId: primary.ownerId,
      targetId: primary.targetId,
      id: primary.id,
      expectedRevision: primary.revision,
      state: "ready",
      changedAt: 30_003
    });
    createHost(fixture.store, { ownerId: "owner-b", targetId: "target-a", id: "build" });
    createHost(fixture.store, { ownerId: "owner-a", targetId: "target-b", id: "other" });

    const restarted = fixture.reopen();
    expect(restarted.hydrateRemoteHosts("owner-a", "target-a")).toEqual([primary]);
    expect(restarted.hydrateRemoteHosts("owner-b", "target-a")).toHaveLength(1);
    expect(restarted.hydrateRemoteHosts("owner-a", "target-b").map((host) => host.id)).toEqual(["other"]);
  });

  it("persists explicit authentication metadata and freezes Remote workspace bindings per Session", () => {
    const fixture = createFixture();
    const host = createHost(fixture.store, {
      id: "build",
      authenticationMode: "private_key",
      credentialReferenceId: "credential:ssh-build"
    });
    expect(host.authenticationMode).toBe("private_key");
    expect(createHost(fixture.store, {
      id: "agent-host",
      authenticationMode: "system_agent"
    })).not.toHaveProperty("credentialReferenceId");
    expect(() => createHost(fixture.store, {
      id: "bad-agent",
      authenticationMode: "system_agent",
      credentialReferenceId: "credential:not-allowed"
    })).toThrow(/cannot persist a credential reference/u);
    expect(() => createHost(fixture.store, {
      id: "bad-key",
      authenticationMode: "private_key"
    })).toThrow(/requires a credential reference/u);

    const target = fixture.store.upsertTarget({
      id: "target-a",
      backendId: "pi",
      displayName: "target-a",
      workspaceRoot: "D:/workspace/target-a",
      managed: false,
      trusted: true,
      remoteWorkspace: { hostId: host.id, workspaceRoot: "/srv/project" }
    });
    expect(target.descriptor.remoteWorkspace).toEqual({
      hostId: "build",
      workspaceRoot: "/srv/project"
    });
    expect(() => fixture.store.createSession(sessionDescriptor({
      id: "mismatched-session",
      remoteWorkspace: { hostId: host.id, workspaceRoot: "/srv/other" }
    }))).toThrow(/must match its target/u);

    const session = fixture.store.createSession(sessionDescriptor({
      id: "remote-session",
      remoteWorkspace: { hostId: host.id, workspaceRoot: "/srv/project" }
    }));
    fixture.store.upsertTarget({
      ...target.descriptor,
      remoteWorkspace: { hostId: host.id, workspaceRoot: "/srv/next" }
    });
    expect(fixture.store.getSession(session.descriptor.id).descriptor.remoteWorkspace).toEqual({
      hostId: "build",
      workspaceRoot: "/srv/project"
    });
    expect(() => fixture.store.deleteRemoteHost({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision
    })).toThrow(/bound remote host/u);

    const restarted = fixture.reopen();
    expect(restarted.getTarget("target-a").descriptor.remoteWorkspace).toEqual({
      hostId: "build",
      workspaceRoot: "/srv/next"
    });
    expect(restarted.getSession("remote-session").descriptor.remoteWorkspace).toEqual({
      hostId: "build",
      workspaceRoot: "/srv/project"
    });
  });

  it("protects active hosts and referenced targets from deletion in both API and schema", () => {
    const fixture = createFixture();
    let host = createHost(fixture.store);
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "connecting"
    });
    expect(() => fixture.store.deleteRemoteHost({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision
    })).toThrow(/active Remote Host/u);

    fixture.close();
    const database = new DatabaseSync(fixture.filePath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      expect(() => database.prepare(`
        DELETE FROM remote_hosts WHERE owner_id = ? AND target_id = ? AND host_id = ?
      `).run(host.ownerId, host.targetId, host.id)).toThrow(/active remote host/u);
      expect(() => database.prepare("DELETE FROM targets WHERE id = ?").run(host.targetId))
        .toThrow(/FOREIGN KEY constraint failed/u);
    } finally {
      database.close();
    }

    const restarted = fixture.reopen();
    host = restarted.getRemoteHost(host.ownerId, host.targetId, host.id);
    host = restarted.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "disconnected"
    });
    const deleted = restarted.deleteRemoteHost({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision
    });
    expect(deleted.id).toBe(host.id);
    expect(restarted.findRemoteHost(host.ownerId, host.targetId, host.id)).toBeUndefined();
  });

  it("has no durable path for credential values, raw errors, commands, or key material", () => {
    const fixture = createFixture();
    const credentialValue = "CREDENTIAL_VALUE_MUST_NOT_PERSIST";
    const rawError = "RAW_CONNECTOR_ERROR_MUST_NOT_PERSIST";
    const rawCommand = "RAW_COMMAND_MUST_NOT_PERSIST";
    let host = fixture.store.createRemoteHost({
      ownerId: "owner-a",
      targetId: "target-a",
      id: "redaction",
      hostname: "redaction.example.test",
      user: "maker",
      source: "manual",
      credentialReferenceId: "agent:redaction",
      credentialValue,
      rawCommand
    } as CreateRemoteHostInput & {
      readonly credentialValue: string;
      readonly rawCommand: string;
    });
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "connecting"
    });
    host = fixture.store.updateRemoteHostStatus({
      ownerId: host.ownerId,
      targetId: host.targetId,
      id: host.id,
      expectedRevision: host.revision,
      state: "failed",
      failureCode: "connector_protocol",
      rawError
    } as UpdateRemoteHostStatusInput & { readonly rawError: string });
    expect(host.credentialReferenceId).toBe("agent:redaction");
    expect(host.status.failure).toEqual({ code: "connector_protocol", retryable: false });
    expect(jsonText(host)).not.toContain(credentialValue);
    expect(jsonText(host)).not.toContain(rawError);
    expect(jsonText(host)).not.toContain(rawCommand);

    fixture.close();
    for (const fileName of readdirSync(fixture.directory)) {
      const bytes = readFileSync(path.join(fixture.directory, fileName));
      expect(bytes.includes(Buffer.from(credentialValue))).toBe(false);
      expect(bytes.includes(Buffer.from(rawError))).toBe(false);
      expect(bytes.includes(Buffer.from(rawCommand))).toBe(false);
    }

    const database = new DatabaseSync(fixture.filePath);
    try {
      const columns = (database.prepare("PRAGMA table_info(remote_hosts)").all() as Array<Record<string, unknown>>)
        .map((row) => String(row["name"]));
      expect(columns).toEqual([
        "owner_id", "target_id", "host_id", "hostname", "port", "username", "source",
        "credential_reference_id", "trust_algorithm", "trust_fingerprint", "trust_pinned_at",
        "status", "status_changed_at", "failure_code", "failure_retryable",
        "created_at", "updated_at", "revision", "authentication_mode"
      ]);
      expect(columns.some((column) => /credential_value|raw|command|private|secret|key_material/iu.test(column)))
        .toBe(false);
      expect(() => database.prepare(`
        UPDATE remote_hosts
        SET status = 'failed', failure_code = 'authentication_failed', failure_retryable = 1
        WHERE owner_id = 'owner-a' AND target_id = 'target-a' AND host_id = 'redaction'
      `).run()).toThrow(/CHECK constraint failed/u);
      expect(() => database.prepare(`
        UPDATE remote_hosts
        SET trust_algorithm = 'ssh-ed25519', trust_fingerprint = NULL, trust_pinned_at = NULL
        WHERE owner_id = 'owner-a' AND target_id = 'target-a' AND host_id = 'redaction'
      `).run()).toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });
});

function createHost(
  store: OperationalStore,
  overrides: Partial<CreateRemoteHostInput> = {}
) {
  return store.createRemoteHost({
    ownerId: "owner-a",
    targetId: "target-a",
    id: "host-a",
    hostname: "host.example.test",
    port: 22,
    user: "maker",
    source: "manual",
    ...overrides
  });
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

function sessionDescriptor(overrides: {
  readonly id: string;
  readonly remoteWorkspace?: { readonly hostId: string; readonly workspaceRoot: string };
}) {
  return {
    id: overrides.id,
    backendId: "pi",
    targetId: "target-a",
    title: overrides.id,
    binding: { opaqueRef: `native:${overrides.id}`, generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask" as const,
    planMode: false,
    fastMode: false,
    ...(overrides.remoteWorkspace === undefined ? {} : { remoteWorkspace: overrides.remoteWorkspace }),
    createdAt: 40_000,
    updatedAt: 40_000
  };
}

function createFixture(): {
  readonly directory: string;
  readonly filePath: string;
  readonly store: OperationalStore;
  close(): void;
  reopen(): OperationalStore;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-remote-host-store-"));
  const filePath = path.join(directory, "operational.sqlite");
  let clock = 1_000;
  const open = () => new OperationalStore(filePath, { now: () => ++clock });
  let store = open();
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "not_required",
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
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    filePath,
    get store() { return store; },
    close() {
      store.close();
    },
    reopen() {
      store.close();
      store = open();
      return store;
    }
  };
}
