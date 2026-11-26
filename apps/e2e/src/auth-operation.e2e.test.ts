import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ConnectionState,
  CreateTargetMutationSchema,
  LogoutConnectionMutationSchema,
  EntityKind,
  EntityRefSchema,
  OperationMutationSchema,
  OperationPreconditionSchema,
  OperationState,
  RevokeDeviceMutationSchema,
  TargetWorkspaceInputSchema,
  WorkspaceKind
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import { RealPiSystemFixture } from "./real-pi-fixture.js";
import {
  createSessionMutation,
  renameMutation,
  restartBackendMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

describe("remote connection auth and durable operations", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("orders, removes and restores a task's PR associations through the paired Session service", async () => {
    const a = "https://github.com/acme/widgets/pull/41";
    const b = "https://gitlab.com/acme/sub/widgets/-/merge_requests/42";
    const c = "https://github.com/acme/widgets/pull/43", d = "https://github.com/acme/widgets/pull/44";
    const racing = "https://github.com/acme/widgets/pull/45", missing = "https://github.com/acme/widgets/pull/46";
    let verify!: () => void, resume!: () => void;
    const verifying = new Promise<void>(resolve => { verify = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    fixture = await OrchestratorE2eFixture.start({ codeHostProviders: [{
      capability: "code-host.pull-request", supports: () => true,
      async getPullRequest(reference) {
        if (reference.webUrl === missing) throw new ConnectError("The fixture pull request is missing.", Code.NotFound);
        if (reference.webUrl === racing) { verify(); await released; }
        return { state: "open", draft: false, title: "Readable review", headBranch: "feature/association", hasConflicts: reference.webUrl === b };
      }
    }] });
    const { clients, connectionId } = await fixture.pair("Manage task pull requests");
    const createTask = async (displayName: string) => sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId: fixture!.adapter().id, targetId: fixture!.targetId(), displayName })));
    const sessionId = await createTask(`Review ${a}`);
    const otherId = await createTask("Separate task");
    const task = await clients.session.getSession({ sessionId });
    const read = (id = sessionId) => clients.session.getSessionCodeHostReferences({ sessionId: id }).then(result => result.references!);
    const urls = (items: { webUrl: string }[]) => items.map(item => item.webUrl);
    const write = (expectedRevision: bigint, orderedUrls: string[], removedUrls: string[], pinnedUrls?: string[]) =>
      clients.session.setSessionCodeHostReferences({ sessionId, expectedRevision: { value: expectedRevision },
        expectedGeneration: task.session!.version!.generation, orderedUrls, removedUrls,
        ...(pinnedUrls === undefined ? {} : { pinnedUrls: { urls: pinnedUrls } }) }).then(result => result.references!);

    const original = await read();
    expect(urls(original.active)).toEqual([a]);
    await expect(write(original.revision!.value, [a, missing], [])).rejects.toMatchObject({ code: Code.NotFound });
    expect(await read()).toEqual(original);
    const added = await write(original.revision!.value, [a, b], []);
    const reordered = await write(added.revision!.value, [b, a], []);
    expect(urls(reordered.active)).toEqual([b, a]);
    await expect(write(original.revision!.value, [a], [])).rejects.toMatchObject({ code: Code.Aborted });
    await expect(write(reordered.revision!.value, ["https://token@github.com/acme/widgets/pull/43"], []))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    const removed = await write(reordered.revision!.value, [b], [a]);
    expect(urls((await read()).active)).toEqual([b]);
    expect(urls(removed.removed)).toEqual([a]);
    const restored = await write(removed.revision!.value, [b, a], []);
    expect(urls((await read()).active)).toEqual([b, a]);
    expect((await clients.session.getSession({ sessionId })).session?.codeHostPullRequests.map(ref => ref.reference?.webUrl)).toEqual([b, a]);
    expect(urls((await read(otherId)).active)).toEqual([]);

    const pinned = await write(restored.revision!.value, [a, b, c, d], [], [b, c, d]);
    expect(urls(pinned.active)).toEqual([b, c, d, a]);
    expect(pinned.pinnedReferenceKeys).toEqual(pinned.active.slice(0, 3).map(reference => reference.referenceKey));
    await expect(write(pinned.revision!.value, [a, b, c, d], [], [a, b, c, d])).rejects.toMatchObject({ code: Code.InvalidArgument });
    const oldClient = await write(pinned.revision!.value, [a, c, b, d], []);
    expect(new Set(oldClient.pinnedReferenceKeys)).toEqual(new Set(pinned.pinnedReferenceKeys));
    const pending = write(oldClient.revision!.value, [a, b, c, d, racing], [], [c, b, d]);
    const rejected = expect(pending).rejects.toMatchObject({ code: Code.Aborted });
    try {
      await verifying;
      const winner = await write(oldClient.revision!.value, [a, b, c, d], [], [a, b, c]);
      expect(urls((await read()).active)).toEqual(urls(winner.active));
    } finally { resume(); }
    await rejected;
    expect(urls((await read()).active)).toEqual([a, b, c, d]);
  });

  it("rejects a second client's mutation fenced by a stale session generation", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const first = await fixture.pair("stale controller");
    const second = await fixture.pair("fresh controller");
    const backendId = fixture.adapter().id;
    const sessionId = sessionIdFrom(await submit(
      first.clients.operation,
      first.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId() })
    ));
    const before = await first.clients.session.getSession({ sessionId });
    const staleGeneration = before.session!.version!.generation;
    await submit(
      second.clients.operation,
      second.connectionId,
      restartBackendMutation(backendId)
    );
    let currentGeneration = staleGeneration;
    for (let index = 0; index < 100 && currentGeneration === staleGeneration; index += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      currentGeneration = (await second.clients.session.getSession({ sessionId })).session!.version!.generation;
    }
    expect(currentGeneration).toBeGreaterThan(staleGeneration);

    const base = renameMutation(sessionId, "stale write must fail");
    const fenced = create(OperationMutationSchema, {
      ...base,
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }),
        expectedGeneration: staleGeneration
      })]
    });
    await expect(submit(first.clients.operation, first.connectionId, fenced)).rejects.toMatchObject({
      code: Code.Aborted
    });
    expect((await second.clients.session.getSession({ sessionId })).session?.displayName).not.toBe("stale write must fail");
  });

  it("requires the captured Target revision and rejects stale edits without changing the target", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const first = await fixture.pair("first target editor");
    const second = await fixture.pair("second target editor");
    const targetId = fixture.targetId();
    const initial = fixture.application.store.getTarget(targetId);
    const edit = (patch: { readonly displayName?: string; readonly pinned?: boolean }, revision?: bigint) => create(OperationMutationSchema, {
      payload: { case: "updateTarget", value: { targetId, ...patch } },
      preconditions: revision === undefined ? [] : [{ entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: { value: revision } }]
    });
    await expect(submit(first.clients.operation, first.connectionId, edit({ displayName: "missing authority" }))).rejects.toMatchObject({ code: Code.InvalidArgument });
    const mutation = edit({ displayName: "second editor", pinned: true }, initial.revision);
    const operationId = randomUUID();
    await submit(second.clients.operation, second.connectionId, mutation, operationId);
    const current = fixture.application.store.getTarget(targetId);
    expect(current.revision).toBeGreaterThan(initial.revision);
    expect(current.descriptor.displayName).toBe("second editor");
    await expect(submit(first.clients.operation, first.connectionId, edit({ displayName: "stale edit", pinned: false }, initial.revision))).rejects.toMatchObject({ code: Code.Aborted });
    await expect(submit(first.clients.operation, first.connectionId, create(OperationMutationSchema, {
      payload: { case: "updateTarget", value: { targetId, location: { kind: { case: "serviceNode", value: {} } } } },
      preconditions: [{ entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: { value: initial.revision } }]
    }))).rejects.toMatchObject({ code: Code.Aborted });
    expect(fixture.application.store.getTarget(targetId)).toEqual(current);
    await submit(second.clients.operation, second.connectionId, mutation, operationId);
    expect(fixture.application.store.getTarget(targetId)).toEqual(current);
    await submit(first.clients.operation, first.connectionId, edit({ displayName: "reviewed current edit" }, current.revision));
    expect(fixture.application.store.getTarget(targetId).descriptor.displayName).toBe("reviewed current edit");
  });

  it("preserves a second project's files and task when deleting a managed project at the same root", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const { clients, connectionId } = await fixture.pair("Shared directory Owner");
    const backendId = fixture.adapter().id;
    const createProject = async (displayName: string, kind: WorkspaceKind, serverPath?: string) => {
      const operation = await submit(clients.operation, connectionId, create(OperationMutationSchema, { payload: {
        case: "createTarget", value: create(CreateTargetMutationSchema, { backendId, displayName, workspace: create(TargetWorkspaceInputSchema, {
          kind, createIfMissing: kind === WorkspaceKind.MANAGED_DIALOGUE, ...(serverPath === undefined ? {} : { serverPath })
        }) })
      } }));
      if (operation.result?.payload.case !== "target") throw new Error("The project was not created.");
      return operation.result.payload.value;
    };
    const managed = await createProject("Managed project", WorkspaceKind.MANAGED_DIALOGUE);
    const root = fixture.application.store.getTarget(managed.targetId).descriptor.workspaceRoot;
    const document = join(root, "shared.txt");
    await writeFile(document, "The other project still uses this file.", "utf8");
    const other = await createProject("Second project", WorkspaceKind.USER_PROJECT, root);
    const task = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({ backendId, targetId: other.targetId })));
    const remove = (deleteManagedWorkspace: boolean) => submit(clients.operation, connectionId, create(OperationMutationSchema, { payload: {
      case: "deleteTarget", value: { targetId: managed.targetId, deleteManagedWorkspace }
    } }));
    await expect(remove(true)).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: expect.stringMatching(/Another project uses this directory/u) });
    expect((await clients.workspace.getWorkspace({ workspaceId: managed.workspaceId })).workspace?.targetId).toBe(managed.targetId);
    expect((await remove(false)).state).toBe(OperationState.SUCCEEDED);
    expect(await readFile(document, "utf8")).toBe("The other project still uses this file.");
    expect((await clients.workspace.getWorkspace({ workspaceId: other.workspaceId })).workspace?.targetId).toBe(other.targetId);
    expect((await clients.session.getSession({ sessionId: task })).session?.targetId).toBe(other.targetId);
  });

  it("settles the original managed project removal across a cold start after its directory moved", async () => {
    let recoveryFixture = await RealPiSystemFixture.start();
    const rootDirectory = recoveryFixture.rootDirectory;
    try {
      const owner = await recoveryFixture.pair("Managed directory recovery owner");
      const { clients, connectionId } = owner;
      const store = recoveryFixture.application.store;
      const created = await submit(clients.operation, connectionId, create(OperationMutationSchema, { payload: {
        case: "createTarget", value: create(CreateTargetMutationSchema, { backendId: "pi", displayName: "Managed recovery project",
          workspace: create(TargetWorkspaceInputSchema, { kind: WorkspaceKind.MANAGED_DIALOGUE, createIfMissing: true }) })
      } }));
      if (created.result?.payload.case !== "target") throw new Error("The managed recovery project was not created.");
      const { targetId, workspaceId } = created.result.payload.value;
      const workspaceRoot = store.getTarget(targetId).descriptor.workspaceRoot;
      await writeFile(join(workspaceRoot, "project.txt"), "Original managed workspace bytes.", "utf8");
      const operationId = randomUUID();
      const mutation = create(OperationMutationSchema, { payload: { case: "deleteTarget", value: { targetId, deleteManagedWorkspace: true } } });
      const complete = vi.spyOn(store, "completeAuthorizedDeferredEffectOperation").mockImplementationOnce(() => {
        throw new Error("Stop after the original move and before the product commit.");
      });
      try { await expect(submit(clients.operation, connectionId, mutation, operationId)).rejects.toThrow(); }
      finally { complete.mockRestore(); }
      expect(store.getOperation(operationId).status).toBe("started");
      const target = store.getTarget(targetId);
      expect(target.metadata).toMatchObject({ state: "deleting", pendingManagedWorkspaceTrash: { operationId, format: 1 } });
      const { trashPath } = (target.metadata as { pendingManagedWorkspaceTrash: { trashPath: string } }).pendingManagedWorkspaceTrash;
      await expect(readFile(join(workspaceRoot, "project.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(trashPath, "project.txt"), "utf8")).toBe("Original managed workspace bytes.");
      await expect(submit(clients.operation, connectionId, mutation)).rejects.toMatchObject({ code: Code.FailedPrecondition });

      await recoveryFixture.close({ removeRoot: false });
      recoveryFixture = await RealPiSystemFixture.start({ rootDirectory });
      const reconnected = recoveryFixture.clients(owner.authKey);
      const receipt = (await reconnected.operation.getOperation({ operationId })).operation;
      expect(receipt, receipt?.error?.message).toMatchObject({ operationId, state: OperationState.SUCCEEDED,
        result: { payload: { case: "target", value: { targetId } } } });
      const metadata = recoveryFixture.application.store.getTarget(targetId).metadata;
      expect(metadata).toMatchObject({ state: "archived", managedWorkspaceTrashPath: trashPath, deletionOperationId: operationId });
      expect(metadata).not.toHaveProperty("pendingManagedWorkspaceTrash");
      await expect(reconnected.workspace.getWorkspace({ workspaceId })).rejects.toMatchObject({ code: Code.NotFound });
      expect((await submit(reconnected.operation, connectionId, mutation, operationId)).state).toBe(OperationState.SUCCEEDED);
      expect(await readFile(join(trashPath, "project.txt"), "utf8")).toBe("Original managed workspace bytes.");
    } finally {
      try { await recoveryFixture.close({ removeRoot: false }); }
      finally { await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 }); }
    }
  });

  it("revalidates an unavailable project directory through authenticated Connect and creates the task after retry", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair("project recovery owner");
    const backendId = fixture.adapter().id;
    const projectDirectory = join(fixture.rootDirectory, "recoverable-project");
    const unavailableDirectory = join(fixture.rootDirectory, "recoverable-project-unavailable");
    await mkdir(projectDirectory);

    const created = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "createTarget",
        value: create(CreateTargetMutationSchema, {
          backendId,
          displayName: "Recoverable project",
          workspace: create(TargetWorkspaceInputSchema, {
            kind: WorkspaceKind.USER_PROJECT,
            serverPath: projectDirectory,
            createIfMissing: false
          })
        })
      }
    }));
    if (created.result?.payload.case !== "target") throw new Error("Target creation returned no Target.");
    const target = created.result.payload.value;
    const revision = target.version?.revision?.value;
    if (revision === undefined) throw new Error("Created Target returned no revision.");

    fixture.application.workspaces.unregister(target.workspaceId);
    await rename(projectDirectory, unavailableDirectory);
    await expect(paired.clients.target.prepareTargetWorkspace({
      targetId: target.targetId,
      expectedTargetRevision: { value: revision }
    })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: "The project directory is unavailable on this service node. Restore the directory, then retry."
    });

    await rename(unavailableDirectory, projectDirectory);
    const prepared = await paired.clients.target.prepareTargetWorkspace({
      targetId: target.targetId,
      expectedTargetRevision: { value: revision }
    });
    expect(prepared.workspace).toMatchObject({
      workspaceId: target.workspaceId,
      targetId: target.targetId,
      serverPathDisplay: projectDirectory,
      version: { revision: { value: revision } }
    });

    await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: target.targetId }),
        expectedRevision: { value: revision }
      })],
      payload: { case: "updateTarget", value: { targetId: target.targetId, displayName: "Recovered project" } }
    }));
    const updatedTarget = (await paired.clients.target.getTarget({ targetId: target.targetId })).target;
    const updatedRevision = updatedTarget?.version?.revision?.value;
    if (updatedRevision === undefined) throw new Error("Updated Target returned no revision.");
    const creationAt = (expectedRevision: bigint) => {
      const base = createSessionMutation({ backendId, targetId: target.targetId, displayName: "Recovered task" });
      return create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: target.targetId }),
          expectedRevision: { value: expectedRevision }
        })],
        payload: base.payload
      });
    };
    await expect(submit(
      paired.clients.operation,
      paired.connectionId,
      creationAt(revision)
    )).rejects.toMatchObject({ code: Code.Aborted });
    expect((await paired.clients.session.listSessions({ targetId: target.targetId })).sessions).toHaveLength(0);

    await paired.clients.target.prepareTargetWorkspace({
      targetId: target.targetId,
      expectedTargetRevision: { value: updatedRevision }
    });
    const session = await submit(
      paired.clients.operation,
      paired.connectionId,
      creationAt(updatedRevision)
    );
    expect(session.state).toBe(OperationState.SUCCEEDED);
    expect(sessionIdFrom(session)).not.toBe("");
  });

  it("browses only the authenticated service-node directory before creating a project binding", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair("service directory owner");
    const parent = join(fixture.rootDirectory, "browse-projects");
    const chosen = join(parent, "chosen");
    await mkdir(chosen, { recursive: true });
    await expect(fixture.anonymous.target.listProjectDirectories({ path: parent })).rejects.toMatchObject({ code: Code.Unauthenticated });
    const listing = await paired.clients.target.listProjectDirectories({ path: parent });
    expect(listing.path).toBe(parent);
    expect(listing.directories).toMatchObject([{ name: "chosen", path: chosen }]);
    expect((await paired.clients.target.listProjectDirectories({ path: chosen })).parentPath).toBe(parent);
    await expect(paired.clients.target.listProjectDirectories({ path: join(parent, "missing") })).rejects.toMatchObject({ code: Code.NotFound });

    const created = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: { case: "createTarget", value: create(CreateTargetMutationSchema, {
        backendId: fixture.adapter().id, displayName: "Chosen project",
        workspace: create(TargetWorkspaceInputSchema, {
          kind: WorkspaceKind.USER_PROJECT, serverPath: listing.directories[0]!.path, createIfMissing: false
        })
      }) }
    }));
    if (created.result?.payload.case !== "target") throw new Error("Project creation returned no Target.");
    expect(fixture.application.store.getTarget(created.result.payload.value.targetId).descriptor.workspaceRoot).toBe(chosen);
  });

  it("preflights every task before a Backend-wide restart changes any runtime generation", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair("atomic Backend restart");
    const backendId = fixture.adapter().id;
    const firstSessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId() })
    ));
    const secondSessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(), displayName: "Idle peer" })
    ));
    fixture.adapter().injectFault(firstSessionId, "hang");
    await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(firstSessionId, BigInt(fixture!.application.store.getSession(firstSessionId).descriptor.binding.generation), "keep this runtime busy")
    );
    const [firstBefore, secondBefore] = await Promise.all([
      paired.clients.session.getSession({ sessionId: firstSessionId }),
      paired.clients.session.getSession({ sessionId: secondSessionId })
    ]);
    const failed = await submit(
      paired.clients.operation,
      paired.connectionId,
      restartBackendMutation(backendId)
    );
    expect(failed.state).toBe(OperationState.FAILED);
    const [firstAfter, secondAfter] = await Promise.all([
      paired.clients.session.getSession({ sessionId: firstSessionId }),
      paired.clients.session.getSession({ sessionId: secondSessionId })
    ]);
    expect(firstAfter.session?.version?.generation).toBe(firstBefore.session?.version?.generation);
    expect(secondAfter.session?.version?.generation).toBe(secondBefore.session?.version?.generation);
  });

  it("pairs over Connect, authenticates every protected RPC, and makes revoke exact", async () => {
    fixture = await OrchestratorE2eFixture.start();

    await expect(fixture.anonymous.connection.listConnections({})).rejects.toMatchObject({
      code: Code.Unauthenticated
    });

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "single-use" });
    expect(challenge.challenge?.humanCode).toBe("");
    const humanCode = fixture.pairingCode(challenge.challenge!.challengeId);
    expect(humanCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    const first = await fixture.anonymous.connection.completePairing({
      challengeId: challenge.challenge!.challengeId,
      humanCode,
      deviceDisplayName: "single-use"
    });
    expect(first.result?.authKey).toHaveLength(43);
    await expect(fixture.anonymous.connection.completePairing({
      challengeId: challenge.challenge!.challengeId,
      humanCode,
      deviceDisplayName: "replay"
    })).rejects.toBeInstanceOf(ConnectError);

    const owner = { connectionId: first.result!.connection!.connectionId, clients: fixture.clients(first.result!.authKey) };
    const victim = await fixture.pair("victim");
    const peer = await fixture.pair("peer controller");
    const listed = await owner.clients.connection.listConnections({});
    expect(new Set(listed.connections.map((item) => item.connectionId))).toEqual(
      new Set([owner.connectionId, victim.connectionId, peer.connectionId])
    );

    const revoke = (deviceId: string) => create(OperationMutationSchema, {
      payload: {
        case: "revokeDevice",
        value: create(RevokeDeviceMutationSchema, { deviceId, reason: "e2e race" })
      }
    });
    const races = await Promise.allSettled([
      submit(owner.clients.operation, owner.connectionId, revoke(victim.deviceId), randomUUID()),
      submit(peer.clients.operation, peer.connectionId, revoke(victim.deviceId), randomUUID())
    ]);
    expect(races.some((result) => result.status === "fulfilled")).toBe(true);
    await expect(victim.clients.backend.listBackends({})).rejects.toMatchObject({ code: Code.Unauthenticated });

    const devices = await owner.clients.connection.listDevices({ revoked: true });
    expect(devices.devices.filter((item) => item.deviceId === victim.deviceId)).toHaveLength(1);

    const logout = create(OperationMutationSchema, {
      payload: {
        case: "logoutConnection",
        value: create(LogoutConnectionMutationSchema, { connectionId: owner.connectionId })
      }
    });
    const logoutId = randomUUID();
    // Self-revocation can retire the HTTP response after the durable commit.
    const loggedOut = await submit(owner.clients.operation, owner.connectionId, logout, logoutId).catch((error: unknown) => {
      expect(error).toMatchObject({ code: Code.Aborted });
      return undefined;
    });
    if (loggedOut) expect(loggedOut.state).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.store.getOperation(logoutId).status).toBe("completed");
    expect((await peer.clients.connection.getConnection({ connectionId: owner.connectionId })).connection?.state).toBe(ConnectionState.REVOKED);
    await expect(owner.clients.connection.listConnections({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it("replays the same operation ID and rejects reuse with a different body", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair();
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const operationId = randomUUID();
    const mutation = createSessionMutation({ backendId, targetId, displayName: "Idempotent task" });
    mutation.preconditions.push(create(OperationPreconditionSchema, { entity: { kind: EntityKind.TARGET, id: targetId },
      expectedRevision: { value: fixture.application.store.getTarget(targetId).revision } }));

    const first = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
    const replay = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
    expect(replay.operationId).toBe(first.operationId);
    expect(sessionIdFrom(replay)).toBe(sessionIdFrom(first));
    expect(replay.requestSha256Hex).toBe(first.requestSha256Hex);
    expect((await paired.clients.session.listSessions({ targetId })).sessions).toHaveLength(1);

    await expect(submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId, targetId, displayName: "Conflicting task body" }),
      operationId
    )).rejects.toSatisfy((error: unknown) => {
      return error instanceof ConnectError && /conflict|different body|already/i.test(error.rawMessage);
    });

    const fetched = await paired.clients.operation.getOperation({ operationId });
    expect(fetched.operation?.mutation).toEqual(mutation);
    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory });
    const reconnected = fixture.clients(paired.authKey);
    const observer = await fixture.pair("operation observer");
    const cold = (await reconnected.operation.getOperation({ operationId })).operation;
    const listed = (await observer.clients.operation.listOperations({})).operations.find(item => item.operationId === operationId);
    const watched = [];
    for await (const update of reconnected.operation.watchOperation({ operationId })) watched.push(update.operation);
    expect(watched).toHaveLength(1);
    for (const receipt of [cold, listed, watched[0], await submit(reconnected.operation, paired.connectionId, mutation, operationId)]) {
      expect(receipt).toMatchObject({ operationId, connectionId: paired.connectionId, state: OperationState.SUCCEEDED,
        requestSha256Hex: first.requestSha256Hex, mutation });
      expect(sessionIdFrom(receipt!)).toBe(sessionIdFrom(first));
    }
    await expect(submit(observer.clients.operation, observer.connectionId, mutation, operationId)).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(submit(reconnected.operation, paired.connectionId, createSessionMutation({ backendId, targetId }), operationId))
      .rejects.toMatchObject({ code: Code.AlreadyExists });
    expect((await reconnected.session.listSessions({ targetId })).sessions).toHaveLength(1);
  });
});
