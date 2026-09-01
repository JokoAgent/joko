import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  AgentAuthConnectorFailure,
  RemoteSshError
} from "@joko/remote-ssh";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toProtoRevision } from "./proto-mapper.js";
import { createRemoteHostConnectService } from "./remote-host-connect-service.js";
import {
  RemoteHostRegistry,
  type ResolvedAgentAuthConnectorPort
} from "./remote-host-registry.js";

const EPHEMERAL_SECRET = "EPHEMERAL_REMOTE_HOST_SECRET";
const PRIVATE_CONNECTOR_TEXT = "PRIVATE_CONNECTOR_TEXT_MUST_NOT_ESCAPE";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("RemoteHostService", () => {
  it("authenticates an owner-private, target-scoped CRUD catalog and paginates canonical projections", async () => {
    const fixture = createFixture();
    const authenticate = vi.fn(() => ({ connectionId: "connection-a" }));
    const service = createRemoteHostConnectService(fixture.registry, authenticate, undefined, fixture.now);
    const callContext = context();

    const first = await service.createRemoteHost(create(contract.CreateRemoteHostRequestSchema, {
      requestId: "request-alpha",
      targetId: "target-a",
      hostId: "alpha",
      hostname: "alpha.example.test",
      user: "maker",
      authenticationMode: contract.RemoteHostAuthenticationMode.PRIVATE_KEY,
      credentialReferenceId: "agent:alpha"
    }), callContext);
    await service.createRemoteHost(create(contract.CreateRemoteHostRequestSchema, {
      requestId: "request-beta",
      targetId: "target-a",
      hostId: "beta",
      hostname: "beta.example.test",
      port: 2202,
      user: "builder",
      authenticationMode: contract.RemoteHostAuthenticationMode.SYSTEM_AGENT
    }), callContext);
    await service.createRemoteHost(create(contract.CreateRemoteHostRequestSchema, {
      requestId: "request-other-target",
      targetId: "target-b",
      hostId: "alpha",
      hostname: "other-target.example.test",
      user: "other",
      authenticationMode: contract.RemoteHostAuthenticationMode.SYSTEM_AGENT
    }), callContext);
    fixture.store.createRemoteHost({
      ownerId: "owner-b",
      targetId: "target-a",
      id: "alpha",
      hostname: "other-owner.example.test",
      user: "other",
      source: "manual"
    });

    expect(first.host).toMatchObject({
      targetId: "target-a",
      hostId: "alpha",
      hostname: "alpha.example.test",
      port: 22,
      credentialReferenceId: "agent:alpha",
      source: contract.RemoteHostSource.MANUAL,
      status: { state: contract.RemoteHostStatus.DISCONNECTED }
    });
    const firstPage = await service.listRemoteHosts(create(contract.ListRemoteHostsRequestSchema, {
      targetId: "target-a",
      page: create(contract.PageRequestSchema, { pageSize: 1 })
    }), callContext);
    expect((firstPage.hosts ?? []).map((host) => host.hostId)).toEqual(["alpha"]);
    expect(firstPage.page).toMatchObject({ totalSize: 2n });
    expect(firstPage.page?.nextPageToken).not.toBe("");
    const secondPage = await service.listRemoteHosts(create(contract.ListRemoteHostsRequestSchema, {
      targetId: "target-a",
      page: create(contract.PageRequestSchema, {
        pageSize: 1,
        pageToken: firstPage.page?.nextPageToken
      })
    }), callContext);
    expect((secondPage.hosts ?? []).map((host) => host.hostId)).toEqual(["beta"]);
    expect(secondPage.page?.nextPageToken).toBe("");

    const authoritative = await service.getRemoteHost(create(contract.GetRemoteHostRequestSchema, {
      targetId: "target-a",
      hostId: "alpha"
    }), callContext);
    expect(authoritative.host?.hostname).toBe("alpha.example.test");
    const projection = safeJson(authoritative);
    expect(projection).not.toContain("owner-a");
    expect(projection).not.toContain("owner-b");
    expect(projection).not.toContain(EPHEMERAL_SECRET);

    const updated = await service.updateRemoteHost(create(contract.UpdateRemoteHostRequestSchema, {
      targetId: "target-a",
      hostId: "alpha",
      hostname: "alpha.example.test",
      port: 2222,
      user: "deployer",
      authenticationMode: contract.RemoteHostAuthenticationMode.SYSTEM_AGENT,
      expectedRevision: first.host?.revision
    }), callContext);
    expect(updated.host).toMatchObject({ user: "deployer", port: 2222 });
    expect(updated.host?.credentialReferenceId).toBeUndefined();

    const deleted = await service.deleteRemoteHost(create(contract.DeleteRemoteHostRequestSchema, {
      targetId: "target-a",
      hostId: "alpha",
      expectedRevision: updated.host?.revision
    }), callContext);
    expect(deleted.host?.hostId).toBe("alpha");
    await expect(service.getRemoteHost(create(contract.GetRemoteHostRequestSchema, {
      targetId: "target-a",
      hostId: "alpha"
    }), callContext)).rejects.toSatisfy(connectCode(Code.NotFound));
    expect(authenticate.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("fences revision before credential resolution and returns only bounded connection failures", async () => {
    const credentialViews: Uint8Array[] = [];
    let calls = 0;
    const connector: ResolvedAgentAuthConnectorPort = {
      capabilities: {
        commandExecution: false,
        processStreaming: false,
        fileTransfer: false,
        tcpForwarding: false
      },
      async connect(request) {
        if (request.authentication.kind !== "private_key") throw new Error("unexpected authentication mode");
        credentialViews.push(request.authentication.privateKey);
        request.onAuthenticating();
        if (calls++ > 0) {
          const failure = new AgentAuthConnectorFailure("AUTHENTICATION_FAILED");
          failure.message = PRIVATE_CONNECTOR_TEXT;
          throw failure;
        }
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1, 3, 5, 7) });
        return { close: async () => undefined };
      }
    };
    const resolve = vi.fn(() => EPHEMERAL_SECRET);
    const fixture = createFixture({ connector, resolve });
    const service = createRemoteHostConnectService(
      fixture.registry,
      () => ({ connectionId: "connection-a" }),
      undefined,
      fixture.now
    );
    const created = await service.createRemoteHost(create(contract.CreateRemoteHostRequestSchema, {
      requestId: "request-connect",
      targetId: "target-a",
      hostId: "connectable",
      hostname: "connectable.example.test",
      user: "maker",
      authenticationMode: contract.RemoteHostAuthenticationMode.PRIVATE_KEY,
      credentialReferenceId: "agent:connectable"
    }), context());
    const current = fixture.registry.update({
      targetId: "target-a",
      id: "connectable",
      expectedRevision: created.host?.revision?.value ?? 0n,
      user: "deployer"
    });

    await expect(service.testRemoteHostConnection(create(contract.TestRemoteHostConnectionRequestSchema, {
      targetId: "target-a",
      hostId: "connectable",
      expectedRevision: created.host?.revision
    }), context())).rejects.toSatisfy(connectCode(Code.Aborted));
    expect(resolve).not.toHaveBeenCalled();

    const succeeded = await service.testRemoteHostConnection(create(contract.TestRemoteHostConnectionRequestSchema, {
      targetId: "target-a",
      hostId: "connectable",
      expectedRevision: toProtoRevision(current.revision)
    }), context());
    expect(succeeded.result).toMatchObject({
      outcome: contract.RemoteHostConnectionTestOutcome.SUCCEEDED,
      host: {
        status: { state: contract.RemoteHostStatus.READY },
        trust: { algorithm: "ssh-ed25519", sha256Fingerprint: expect.stringMatching(/^SHA256:/u) }
      }
    });
    expect(safeJson(succeeded)).not.toContain(EPHEMERAL_SECRET);

    const failed = await service.testRemoteHostConnection(create(contract.TestRemoteHostConnectionRequestSchema, {
      targetId: "target-a",
      hostId: "connectable",
      expectedRevision: succeeded.result?.host?.revision
    }), context());
    expect(failed.result).toMatchObject({
      outcome: contract.RemoteHostConnectionTestOutcome.FAILED,
      host: {
        status: {
          state: contract.RemoteHostStatus.FAILED,
          failure: {
            code: contract.RemoteHostFailureCode.AUTHENTICATION_FAILED,
            retryable: false
          }
        }
      }
    });
    expect(safeJson(failed)).not.toContain(EPHEMERAL_SECRET);
    expect(safeJson(failed)).not.toContain(PRIVATE_CONNECTOR_TEXT);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(credentialViews).toHaveLength(2);
    expect(credentialViews.every((value) => [...value].every((byte) => byte === 0))).toBe(true);
  });

  it("streams an initial snapshot and ordered target-local changes until authorization is revoked", async () => {
    const fixture = createFixture();
    let revoke = (): void => undefined;
    const service = createRemoteHostConnectService(
      fixture.registry,
      () => ({ connectionId: "connection-watch" }),
      (_connectionId, listener) => {
        revoke = listener;
        return () => { revoke = (): void => undefined; };
      },
      fixture.now
    );
    const controller = new AbortController();
    const stream = service.watchRemoteHosts(create(contract.WatchRemoteHostsRequestSchema, {
      targetId: "target-a"
    }), context(controller.signal));
    const iterator = stream[Symbol.asyncIterator]();
    const initial = await iterator.next();
    expect(initial.value).toMatchObject({
      sequence: 1n,
      update: { case: "snapshot", value: { hosts: [] } }
    });

    fixture.registry.create({
      targetId: "target-b",
      id: "ignored",
      hostname: "ignored.example.test",
      user: "maker",
      source: "manual"
    });
    fixture.registry.create({
      targetId: "target-a",
      id: "observed",
      hostname: "observed.example.test",
      user: "maker",
      source: "manual"
    });
    const changed = await iterator.next();
    expect(changed.value).toMatchObject({
      sequence: 2n,
      update: {
        case: "change",
        value: {
          kind: contract.RemoteHostChangeKind.UPSERTED,
          host: { targetId: "target-a", hostId: "observed" }
        }
      }
    });
    revoke();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("advertises connector absence independently and fails closed when the service is unavailable", async () => {
    const fixture = createFixture();
    const service = createRemoteHostConnectService(
      fixture.registry,
      () => ({ connectionId: "connection-a" }),
      undefined,
      fixture.now
    );
    const capabilities = await service.getRemoteHostCapabilities(
      create(contract.GetRemoteHostCapabilitiesRequestSchema, { targetId: "target-a" }),
      context()
    );
    expect(capabilities.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: contract.RemoteHostCapabilityKind.CATALOG,
        support: contract.CapabilitySupport.SUPPORTED
      }),
      expect.objectContaining({
        kind: contract.RemoteHostCapabilityKind.CONNECTION_TEST,
        support: contract.CapabilitySupport.UPSTREAM_MISSING
      })
    ]));

    const unavailable = createRemoteHostConnectService(
      undefined,
      () => ({ connectionId: "connection-a" }),
      undefined,
      fixture.now
    );
    const unsupported = await unavailable.getRemoteHostCapabilities(
      create(contract.GetRemoteHostCapabilitiesRequestSchema, { targetId: "target-a" }),
      context()
    );
    expect((unsupported.capabilities ?? [])
      .every((item) => item.support === contract.CapabilitySupport.NOT_IMPLEMENTED))
      .toBe(true);
    await expect(unavailable.listRemoteHosts(create(contract.ListRemoteHostsRequestSchema, {
      targetId: "target-a"
    }), context())).rejects.toSatisfy(connectCode(Code.Unimplemented));

    const unauthenticated = createRemoteHostConnectService(
      fixture.registry,
      () => { throw new ConnectError("Authentication required.", Code.Unauthenticated); }
    );
    await expect(unauthenticated.listRemoteHosts(create(contract.ListRemoteHostsRequestSchema, {
      targetId: "target-a"
    }), context())).rejects.toSatisfy(connectCode(Code.Unauthenticated));
  });

  it("maps service-owned SSH config failures without exposing filesystem or connector text", async () => {
    const fixture = createFixture();
    vi.spyOn(fixture.registry, "refresh").mockRejectedValue(new RemoteSshError(
      "CONFIG_IO",
      PRIVATE_CONNECTOR_TEXT,
      false
    ));
    const service = createRemoteHostConnectService(
      fixture.registry,
      () => ({ connectionId: "connection-a" }),
      undefined,
      fixture.now
    );
    let failure: unknown;
    try {
      await service.refreshRemoteHostCatalog(create(contract.RefreshRemoteHostCatalogRequestSchema, {
        targetId: "target-a",
        requestId: "refresh-config"
      }), context());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).code).toBe(Code.Unavailable);
    expect((failure as ConnectError).message).not.toContain(PRIVATE_CONNECTOR_TEXT);
  });
});

interface Fixture {
  readonly store: OperationalStore;
  readonly registry: RemoteHostRegistry;
  readonly now: () => number;
}

function createFixture(options: {
  readonly connector?: ResolvedAgentAuthConnectorPort;
  readonly resolve?: (credentialReferenceId: string) => string;
} = {}): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-remote-host-rpc-"));
  let clock = 10_000;
  const now = () => ++clock;
  const store = new OperationalStore(path.join(directory, "operational.sqlite"), { now });
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
  const registry = new RemoteHostRegistry({
    store,
    ownerId: "owner-a",
    now,
    ...(options.resolve === undefined ? {} : { credentials: { resolve: options.resolve } }),
    ...(options.connector === undefined ? {} : { connector: options.connector })
  });
  cleanups.push(async () => {
    await registry.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, registry, now };
}

function context(signal = new AbortController().signal): HandlerContext {
  return { signal } as HandlerContext;
}

function connectCode(code: Code): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ConnectError && error.code === code;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}
