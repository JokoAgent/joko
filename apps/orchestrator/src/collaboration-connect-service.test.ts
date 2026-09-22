import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { DEFAULT_COLLABORATION_SETTINGS } from "@joko/runtime-governance";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { createCollaborationConnectService } from "./collaboration-connect-service.js";
import { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import { SessionHost } from "./session-host.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("CollaborationService", () => {
  it("authenticates and projects the durable Goal, worker route, status tree, and Queue binding", async () => {
    const fixture = await createFixture();
    const authenticate = vi.fn(() => ({ connectionId: "connection-one" }));
    const service = createCollaborationConnectService(fixture.manager, authenticate);
    const createdGoal = await service.createCollaborationGoal(create(
      contract.CreateCollaborationGoalRequestSchema,
      {
        operationId: "rpc-create-goal",
        leadSessionId: fixture.leadSessionId,
        expectedSessionGeneration: BigInt(fixture.leadGeneration),
        title: "RPC Goal",
        objective: "Exercise the generated public collaboration contract.",
        maximumWorkers: 3
      }
    ), context());
    expect(createdGoal.tree?.goal).toMatchObject({
      title: "RPC Goal",
      status: contract.CollaborationGoalStatus.ACTIVE,
      sessionGeneration: BigInt(fixture.leadGeneration),
      maximumWorkers: 3
    });

    const createdWorker = await service.createCollaborationWorker(create(
      contract.CreateCollaborationWorkerRequestSchema,
      {
        operationId: "rpc-create-worker",
        goalId: createdGoal.tree!.goal!.goalId,
        callerLeadSessionId: fixture.leadSessionId,
        expectedGoalRevision: createdGoal.tree!.goal!.revision,
        label: "RPC Worker",
        role: "implementation",
        assignment: "Implement the contract boundary.",
        targetId: "target-one",
        fastMode: false,
        permissionMode: contract.PermissionMode.ASK,
        planMode: false
      }
    ), context());
    expect(createdWorker.worker).toMatchObject({
      label: "RPC Worker",
      role: "implementation",
      status: expect.not.stringMatching(/^$/u),
      route: {
        backendId: PI_LIKE_PROFILE.id,
        targetId: "target-one",
        permissionMode: contract.PermissionMode.ASK
      },
      runtimeReleased: false
    });
    expect(createdWorker.worker?.sessionId).toEqual(expect.any(String));
    expect(createdWorker.tree?.queue).toHaveLength(1);
    expect(createdWorker.tree!.queue![0]).toMatchObject({
      dispatch: {
        workerId: createdWorker.worker!.workerId,
        message: "Implement the contract boundary.",
        status: contract.CollaborationDispatchStatus.QUEUED
      },
      queueItem: {
        sessionId: createdWorker.worker!.sessionId,
        input: {
          parts: [{ content: { case: "text", value: "Implement the contract boundary." } }]
        }
      }
    });

    const listed = await service.listCollaborationGoals(create(
      contract.ListCollaborationGoalsRequestSchema,
      { sessionId: fixture.leadSessionId }
    ), context());
    expect(listed.access!.map((entry) => entry.goal?.goalId)).toEqual([createdGoal.tree!.goal!.goalId]);
    expect(listed.access![0]).toMatchObject({ role: contract.CollaborationSessionRole.LEAD });
    const fetched = await service.getCollaborationGoal(create(
      contract.GetCollaborationGoalRequestSchema,
      { goalId: createdGoal.tree!.goal!.goalId, viewerSessionId: fixture.leadSessionId }
    ), context());
    expect(fetched.tree!.workers![0]?.workerId).toBe(createdWorker.worker?.workerId);
    const workerAccess = await service.listCollaborationGoals(create(
      contract.ListCollaborationGoalsRequestSchema,
      { sessionId: createdWorker.worker!.sessionId }
    ), context());
    expect(workerAccess.access![0]).toMatchObject({
      role: contract.CollaborationSessionRole.WORKER,
      workerId: createdWorker.worker!.workerId,
      goal: { goalId: createdGoal.tree!.goal!.goalId }
    });
    expect(service.getCollaborationGoal(create(
      contract.GetCollaborationGoalRequestSchema,
      { goalId: createdGoal.tree!.goal!.goalId, viewerSessionId: createdWorker.worker!.sessionId }
    ), context())).toMatchObject({ tree: { goal: { goalId: createdGoal.tree!.goal!.goalId } } });
    expect(() => service.getCollaborationGoal(create(
      contract.GetCollaborationGoalRequestSchema,
      { goalId: createdGoal.tree!.goal!.goalId, viewerSessionId: "unrelated-session" }
    ), context())).toThrow(/does not belong/u);
    expect(authenticate).toHaveBeenCalledTimes(7);
  });

  it("fails closed for unavailable ownership, invalid enums, and the machine hard limit", async () => {
    const unavailable = createCollaborationConnectService(undefined, () => undefined);
    expect(() => unavailable.listCollaborationGoals(
      create(contract.ListCollaborationGoalsRequestSchema, { sessionId: "unavailable-session" }),
      context()
    )).toThrow(expect.objectContaining({ code: Code.Unimplemented }));

    const settings = { ...DEFAULT_COLLABORATION_SETTINGS, workerSoftLimit: 1, workerHardLimit: 1 };
    const fixture = await createFixture(settings);
    const service = createCollaborationConnectService(fixture.manager, () => undefined);
    const goal = await service.createCollaborationGoal(create(
      contract.CreateCollaborationGoalRequestSchema,
      {
        operationId: "rpc-limit-goal",
        leadSessionId: fixture.leadSessionId,
        expectedSessionGeneration: BigInt(fixture.leadGeneration),
        title: "Limited",
        objective: "Respect the hard limit."
      }
    ), context());
    const createWorker = (operationId: string, revisionValue: bigint) =>
      service.createCollaborationWorker(create(contract.CreateCollaborationWorkerRequestSchema, {
        operationId,
        goalId: goal.tree!.goal!.goalId,
        callerLeadSessionId: fixture.leadSessionId,
        expectedGoalRevision: revision(revisionValue),
        label: operationId,
        role: "worker",
        assignment: `Assignment for ${operationId}.`,
        targetId: "target-one",
        permissionMode: contract.PermissionMode.ASK
      }), context());
    const first = await createWorker("rpc-limit-first", goal.tree!.goal!.revision!.value!);
    await expect(createWorker("rpc-limit-second", first.tree!.goal!.revision!.value!))
      .rejects.toMatchObject({ code: Code.ResourceExhausted });
    await expect(service.setCollaborationGoalStatus(create(
      contract.SetCollaborationGoalStatusRequestSchema,
      {
        operationId: "rpc-non-lead-goal-state",
        goalId: goal.tree!.goal!.goalId,
        callerLeadSessionId: "not-the-lead-session",
        expectedRevision: first.tree!.goal!.revision,
        status: contract.CollaborationGoalStatus.STOPPED
      }
    ), context())).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(service.setCollaborationGoalStatus(create(
      contract.SetCollaborationGoalStatusRequestSchema,
      {
        operationId: "rpc-invalid-goal-state",
        goalId: goal.tree!.goal!.goalId,
        callerLeadSessionId: fixture.leadSessionId,
        expectedRevision: first.tree!.goal!.revision,
        status: contract.CollaborationGoalStatus.ACTIVE
      }
    ), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
  });
});

async function createFixture(settings = DEFAULT_COLLABORATION_SETTINGS) {
  const directory = mkdtempSync(join(tmpdir(), "joko-collaboration-connect-"));
  const store = new OperationalStore(join(directory, "operational.db"));
  const artifacts = new ArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [directory]
  });
  await artifacts.initialize();
  const host = new SessionHost(store, artifacts, [new FakeBackendAdapter(PI_LIKE_PROFILE)]);
  await host.initialize();
  await host.registerTarget({
    id: "target-one",
    backendId: PI_LIKE_PROFILE.id,
    displayName: "Collaboration RPC target",
    workspaceRoot: directory,
    managed: true,
    trusted: true
  });
  const connection = store.createConnection({
    id: "connection-one",
    name: "RPC test",
    authKeyDigest: "digest"
  });
  const leadSessionId = (await host.createSession({
    operationId: "rpc-create-lead",
    connection,
    targetId: "target-one",
    title: "RPC lead",
    fastMode: false,
    permissionMode: "ask",
    planMode: false
  })).value.sessionId;
  const leadGeneration = store.getSession(leadSessionId).descriptor.binding.generation;
  const manager = new CollaborationGoalManager({ store, sessionHost: host, readSettings: () => settings });
  await manager.initialize();
  cleanups.push(async () => {
    await manager.close();
    await host.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, leadSessionId, leadGeneration };
}

function context(): HandlerContext {
  return { signal: new AbortController().signal } as HandlerContext;
}

function revision(value: bigint): contract.Revision {
  return create(contract.RevisionSchema, { value, etag: `W/\"rev-${value.toString(10)}\"` });
}
