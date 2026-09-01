import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  LogoutConnectionMutationSchema,
  EntityKind,
  EntityRefSchema,
  OperationMutationSchema,
  OperationPreconditionSchema,
  OperationState,
  RevokeDeviceMutationSchema
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
      sendInputMutation(firstSessionId, "keep this runtime busy")
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
