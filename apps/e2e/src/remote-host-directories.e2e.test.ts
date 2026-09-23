import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { EntityKind, OperationMutationSchema, OperationState, RemoteHostService } from "@joko/contracts";
import { RemoteHostRegistry } from "@joko/orchestrator";
import type { RemoteFileTransportPort, RemoteProcessTransportPort } from "@joko/remote-ssh";
import { expect, it, vi } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import { submit } from "./operations.js";

it("browses and creates a revision-fenced SSH project through the production HTTP and SQLite chain", async () => {
  let createdRemoteDirectory = false;
  const files: RemoteFileTransportPort = {
    realpath: vi.fn(async path => path === "." ? "/home/fixture" : path),
    stat: vi.fn(async () => ({ kind: "directory" as const, size: 0, modifiedAt: 0, mode: 0o755 })),
    list: vi.fn(async path => {
      if (path === "/") return [{ name: "home", kind: "directory" as const }, { name: "srv", kind: "directory" as const }];
      if (path === "/home") return [{ name: "fixture", kind: "directory" as const }];
      if (path === "/home/fixture") return [
        { name: "work", kind: "directory" as const }, { name: "readme.txt", kind: "file" as const }
      ];
      if (path === "/srv" && createdRemoteDirectory) return [{ name: "new-project", kind: "directory" as const }];
      return [];
    }),
    read: async () => new Uint8Array(), write: async () => undefined,
    mkdir: vi.fn(async path => { if (path === "/srv/new-project") createdRemoteDirectory = true; }),
    rename: async () => undefined, remove: async () => undefined
  };
  const processes: RemoteProcessTransportPort = { open: vi.fn(async () => { throw new Error("unused process transport"); }) };
  const capabilities = { commandExecution: true, processStreaming: true, fileTransfer: true, tcpForwarding: false, interactiveTerminal: false };
  const connect = vi.fn(async (request: Parameters<NonNullable<ConstructorParameters<typeof RemoteHostRegistry>[0]["connector"]>["connect"]>[0]) => {
    request.onAuthenticating();
    await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1, 2, 3) });
    return { capabilities, files, processes, close: async () => undefined };
  });
  const fixture = await OrchestratorE2eFixture.start({ createAuxiliaryServices: async store => ({
    remoteHosts: new RemoteHostRegistry({ store, ownerId: "remote-directory-e2e", connector: { capabilities, connect } })
  }) });
  try {
    const targetId = [...fixture.targets.values()][0]!;
    const registry = fixture.application.remoteHosts!;
    const created = registry.create({ targetId, id: "host-one", hostname: "ssh-fixture.invalid", user: "fixture", source: "manual" });
    expect((await registry.connect(targetId, created.id, created.revision)).ok).toBe(true);
    const host = registry.get(targetId, created.id);
    const targetRevision = fixture.application.store.getTarget(targetId)!.revision;
    const paired = await fixture.pair("SSH directory browser");
    const client = (authKey?: string) => createClient(RemoteHostService, createConnectTransport({
      baseUrl: fixture.baseUrl, httpVersion: "1.1",
      interceptors: authKey === undefined ? [] : [next => request => { request.header.set("authorization", `Bearer ${authKey}`); return next(request); }]
    }));
    const request = { targetId, hostId: host.id, expectedTargetRevision: { value: targetRevision },
      expectedHostRevision: { value: host.revision }, path: "" };
    await expect(client().listRemoteHostDirectories(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
    const listing = await client(paired.authKey).listRemoteHostDirectories(request);
    expect(listing).toMatchObject({ targetId, hostId: host.id, path: "/home/fixture", parentPath: "/home",
      directories: [{ name: "work", path: "/home/fixture/work" }] });
    expect(listing.directories).toHaveLength(1);
    expect(files.realpath).toHaveBeenCalledWith(".", expect.any(AbortSignal));
    await expect(client(paired.authKey).listRemoteHostDirectories({ ...request, expectedHostRevision: { value: host.revision - 1n } }))
      .rejects.toMatchObject({ code: Code.Aborted });
    await expect(client(paired.authKey).listRemoteHostDirectories({ ...request, path: "D:/service-node" }))
      .rejects.toMatchObject({ code: Code.InvalidArgument });

    const inspection = await client(paired.authKey).inspectRemoteHostDirectory({
      ...request, path: "/srv/new-project"
    });
    expect(inspection).toMatchObject({
      targetId, hostId: host.id, targetRevision: { value: targetRevision }, hostRevision: { value: host.revision },
      exists: false, path: "/srv/new-project"
    });
    const createRemoteProject = (createIfMissing: boolean) => create(OperationMutationSchema, {
      preconditions: [{
        entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: { value: targetRevision }
      }],
      payload: { case: "createRemoteTarget", value: {
        backendId: fixture.adapter().id,
        displayName: "Remote E2E project",
        hostTargetId: targetId,
        hostId: host.id,
        expectedHostRevision: { value: host.revision },
        workspacePath: "/srv/new-project",
        createIfMissing
      } }
    });
    const refused = await submit(
      paired.clients.operation, paired.connectionId, createRemoteProject(false)
    );
    expect(refused).toMatchObject({
      state: OperationState.FAILED,
      error: { code: "EFFECT_FAILED", message: expect.stringContaining("The SSH project directory does not exist.") }
    });
    expect(createdRemoteDirectory).toBe(false);
    const createdOperation = await submit(
      paired.clients.operation, paired.connectionId, createRemoteProject(true)
    );
    expect(createdOperation.state).toBe(OperationState.SUCCEEDED);
    if (createdOperation.result?.payload.case !== "target") throw new Error("Remote project creation returned no Target.");
    const createdTarget = createdOperation.result.payload.value;
    expect(createdTarget.remoteWorkspace).toMatchObject({
      hostTargetId: targetId, hostId: host.id, workspaceRootDisplay: "/srv/new-project"
    });
    expect(fixture.application.store.getTarget(createdTarget.targetId).descriptor.remoteWorkspace).toEqual({
      hostTargetId: targetId, hostId: host.id, workspaceRoot: "/srv/new-project"
    });
    expect(fixture.application.workspaces.listRegistrations()).toContainEqual(expect.objectContaining({
      id: createdTarget.workspaceId,
      root: "/srv/new-project",
      remote: { targetId: createdTarget.targetId, hostTargetId: targetId, hostId: host.id, workspaceRoot: "/srv/new-project" }
    }));
    expect(files.mkdir).toHaveBeenCalledWith("/srv/new-project", expect.objectContaining({ recursive: true, mode: 0o700 }));
    expect(connect).toHaveBeenCalledOnce();
  } finally {
    await fixture.close();
  }
});
