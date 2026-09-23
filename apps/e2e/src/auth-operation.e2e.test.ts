import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
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
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
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
      payload: { case: "updateTarget", value: { targetId, workspaceLocationUpdate: { case: "serviceNodeWorkspace", value: true } } },
      preconditions: [{ entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: { value: initial.revision } }]
    }))).rejects.toMatchObject({ code: Code.Aborted });
    expect(fixture.application.store.getTarget(targetId)).toEqual(current);
    await submit(second.clients.operation, second.connectionId, mutation, operationId);
    expect(fixture.application.store.getTarget(targetId)).toEqual(current);
    await submit(first.clients.operation, first.connectionId, edit({ displayName: "reviewed current edit" }, current.revision));
    expect(fixture.application.store.getTarget(targetId).descriptor.displayName).toBe("reviewed current edit");
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
    const loggedOut = await submit(owner.clients.operation, owner.connectionId, logout);
    expect(loggedOut.state).toBe(OperationState.SUCCEEDED);
    await expect(owner.clients.connection.listConnections({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it("replays the same operation ID and rejects reuse with a different body", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair();
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const operationId = randomUUID();
    const mutation = createSessionMutation({ backendId, targetId, displayName: "Idempotent task" });

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
    expect(fetched.operation?.mutation?.payload.case).toBe("createSession");
    expect(fetched.operation?.state).toBe(OperationState.SUCCEEDED);
  });
});
