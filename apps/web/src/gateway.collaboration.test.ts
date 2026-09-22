import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  CollaborationDispatchStatus,
  CollaborationGoalStatus,
  CollaborationInterruptStopOutcome,
  CollaborationSessionRole,
  CollaborationWorkerStatus,
  PermissionMode,
  QueueDeliveryMode,
  QueueItemState,
  QueueSourceKind
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("Collaboration gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses every generated RPC and preserves authority, generation, route, and Queue CAS axes", async () => {
    const requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = [];
    const gateway = connectedGateway(collaborationTransport(collaborationResponse, requests));
    await gateway.connect();
    const signal = new AbortController().signal;

    const goals = await gateway.listCollaborationGoals("lead-session", true, signal);
    expect(goals).toEqual([expect.objectContaining({ id: "goal-one", revision: 4n, sessionGeneration: 9n })]);
    const initial = await gateway.getCollaborationGoal("goal-one", "lead-session", signal);
    expect(initial).toMatchObject({
      goal: { id: "goal-one", status: "active" },
      workers: [{ id: "worker-one", status: "running", route: { permissionMode: "ask" } }],
      queue: [
        { dispatch: { id: "dispatch-one", revision: 11n }, queueItem: { revision: 21n, generation: 3n } },
        { dispatch: { id: "dispatch-two", revision: 12n }, queueItem: { revision: 22n, generation: 3n } }
      ],
      focusedWorkerId: "worker-one"
    });
    const goal = initial.goal;
    const worker = initial.workers[0]!;
    const first = initial.queue[0]!;
    const second = initial.queue[1]!;

    await gateway.createCollaborationGoal("lead-session", 9n, "Durable collaboration", "Exercise every collaboration boundary", 4, signal);
    await gateway.setCollaborationGoalStatus(goal, "completed", signal);
    await gateway.createCollaborationWorker(goal, {
      label: "Worker one",
      role: "Verifier",
      assignment: "Validate the lifecycle",
      targetId: "target-one",
      providerId: "provider-one",
      modelId: "model-one",
      effort: "high",
      fastMode: true,
      permissionMode: "ask",
      planMode: false
    }, signal);
    await gateway.updateCollaborationWorker(goal, worker, {
      label: "Worker updated",
      role: "Reviewer",
      assignment: "Review the lifecycle"
    }, signal);
    await gateway.focusCollaborationWorker(goal, worker, signal);
    await gateway.wakeCollaborationWorker(goal, worker, signal);
    await gateway.stopCollaborationWorker(goal, worker, signal);
    await gateway.releaseCollaborationWorker(goal, worker, signal);
    await gateway.archiveCollaborationWorker(goal, worker, signal);
    await gateway.sendCollaborationWorkerMessage(goal, worker, "First pending instruction", signal);
    await expect(gateway.interruptCollaborationWorker(goal, worker, "First pending instruction", signal))
      .resolves.toMatchObject({ stopOutcome: "unconfirmed" });
    await gateway.editCollaborationDispatch(first.dispatch, first.queueItem!, "Edited queued work", signal);
    await gateway.cancelCollaborationDispatch(first.dispatch, first.queueItem!, signal);
    await gateway.mergeCollaborationDispatches(goal, worker, [first, second], signal);

    const methods = [
      "listCollaborationGoals", "getCollaborationGoal", "createCollaborationGoal",
      "setCollaborationGoalStatus", "createCollaborationWorker", "updateCollaborationWorker",
      "focusCollaborationWorker", "wakeCollaborationWorker", "stopCollaborationWorker",
      "releaseCollaborationWorker", "archiveCollaborationWorker", "sendCollaborationWorkerMessage",
      "interruptCollaborationWorker", "editCollaborationDispatch", "cancelCollaborationDispatch",
      "mergeCollaborationDispatches"
    ];
    expect(requests.filter((entry) => methods.includes(entry.method)).map((entry) => entry.method)).toEqual(methods);
    expect(requests.find((entry) => entry.method === "createCollaborationGoal")?.input).toMatchObject({
      leadSessionId: "lead-session", expectedSessionGeneration: 9n, maximumWorkers: 4
    });
    expect(requests.find((entry) => entry.method === "listCollaborationGoals")?.input).toMatchObject({
      sessionId: "lead-session", includeArchived: true
    });
    expect(requests.find((entry) => entry.method === "getCollaborationGoal")?.input).toMatchObject({
      goalId: "goal-one", viewerSessionId: "lead-session"
    });
    expect(requests.find((entry) => entry.method === "setCollaborationGoalStatus")?.input).toMatchObject({
      goalId: "goal-one", callerLeadSessionId: "lead-session", expectedRevision: { value: 4n },
      status: CollaborationGoalStatus.COMPLETED
    });
    expect(requests.find((entry) => entry.method === "createCollaborationWorker")?.input).toMatchObject({
      goalId: "goal-one", callerLeadSessionId: "lead-session", expectedGoalRevision: { value: 4n },
      targetId: "target-one", providerId: "provider-one", modelId: "model-one", effort: "high",
      fastMode: true, permissionMode: PermissionMode.ASK, planMode: false
    });
    for (const method of ["wakeCollaborationWorker", "releaseCollaborationWorker"]) {
      expect(requests.find((entry) => entry.method === method)?.input).toMatchObject({
        workerId: "worker-one", callerLeadSessionId: "lead-session",
        expectedRevision: { value: 7n }, expectedSessionGeneration: 3n
      });
    }
    for (const method of ["sendCollaborationWorkerMessage", "interruptCollaborationWorker"]) {
      expect(requests.find((entry) => entry.method === method)?.input).toMatchObject({
        goalId: "goal-one", workerId: "worker-one", callerLeadSessionId: "lead-session",
        expectedWorkerRevision: { value: 7n }, expectedSessionGeneration: 3n,
        message: "First pending instruction"
      });
    }
    expect(requests.find((entry) => entry.method === "editCollaborationDispatch")?.input).toMatchObject({
      dispatchId: "dispatch-one", callerLeadSessionId: "lead-session",
      expectedDispatchRevision: { value: 11n }, expectedQueueRevision: { value: 21n },
      message: "Edited queued work"
    });
    expect(requests.find((entry) => entry.method === "mergeCollaborationDispatches")?.input.dispatches).toEqual([
      { dispatchId: "dispatch-one", expectedDispatchRevision: { value: 11n }, expectedQueueRevision: { value: 21n } },
      { dispatchId: "dispatch-two", expectedDispatchRevision: { value: 12n }, expectedQueueRevision: { value: 22n } }
    ]);
    const mutations = requests.filter((entry) => methods.slice(2).includes(entry.method));
    expect(new Set(mutations.map((entry) => entry.input.operationId)).size).toBe(mutations.length);
    expect(mutations.every((entry) => typeof entry.input.operationId === "string" && entry.input.operationId.length > 0)).toBe(true);
    expect(requests.filter((entry) => methods.includes(entry.method)).every((entry) => entry.signal instanceof AbortSignal && !entry.signal.aborted)).toBe(true);
    gateway.disconnect();
  });

  it("fails closed for unknown state, parent cycles, focus drift, and Queue ownership drift", async () => {
    let value = activeTree();
    const gateway = connectedGateway(collaborationTransport((method) => method === "getCollaborationGoal"
      ? { tree: value }
      : collaborationResponse(method)));
    await gateway.connect();

    value = activeTree({ goal: goal({ status: CollaborationGoalStatus.UNSPECIFIED }) });
    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).rejects.toThrow(/unknown collaboration Goal status/iu);

    value = activeTree({
      workers: [
        worker({ workerId: "worker-one", parentWorkerId: "worker-two", focused: false }),
        worker({ workerId: "worker-two", parentWorkerId: "worker-one", sessionId: "worker-session-two", focused: false })
      ],
      queue: [],
      focusedWorkerId: undefined
    });
    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).rejects.toThrow(/inconsistent collaboration Goal tree/iu);

    value = activeTree({ focusedWorkerId: undefined });
    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).rejects.toThrow(/inconsistent collaboration Goal tree/iu);

    value = activeTree({
      queue: [queueEntry(0, {}, { sessionId: "another-worker-session" })]
    });
    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).rejects.toThrow(/inconsistent collaboration Goal tree/iu);

    value = activeTree({
      queue: [queueEntry(0, {}, { version: { revision: revision(21n), generation: 4n } })]
    });
    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).rejects.toThrow(/inconsistent collaboration Goal tree/iu);

    value = activeTree({
      workers: [worker({ runtimeReleased: true })],
      queue: [],
      focusedWorkerId: "worker-one"
    });
    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).rejects.toThrow(/inconsistent collaboration worker/iu);

    value = activeTree({
      queue: [queueEntry(0, {
        status: CollaborationDispatchStatus.MERGED,
        mergedIntoDispatchId: "missing-dispatch"
      }, { state: QueueItemState.CANCELLED })]
    });
    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).rejects.toThrow(/inconsistent collaboration Goal tree/iu);
    gateway.disconnect();
  });

  it("accepts the valid zero generation at every collaboration ownership boundary", async () => {
    const value = activeTree({
      goal: goal({ sessionGeneration: 0n, backendInstanceGeneration: 0n }),
      workers: [worker({ sessionGeneration: 0n, backendInstanceGeneration: 0n })],
      queue: [
        queueEntry(0, {}, { version: { revision: revision(21n), generation: 0n } }),
        queueEntry(1, {}, { version: { revision: revision(22n), generation: 0n } })
      ]
    });
    const gateway = connectedGateway(collaborationTransport((method) => method === "getCollaborationGoal"
      ? { tree: value }
      : collaborationResponse(method)));
    await gateway.connect();

    await expect(gateway.getCollaborationGoal("goal-one", "lead-session")).resolves.toMatchObject({
      goal: { sessionGeneration: 0n, backendInstanceGeneration: 0n },
      workers: [{ sessionGeneration: 0n, backendInstanceGeneration: 0n }],
      queue: [
        { queueItem: { generation: 0n } },
        { queueItem: { generation: 0n } }
      ]
    });
    gateway.disconnect();
  });

  it("projects worker Session access without granting lead ownership", async () => {
    let access = [{
      goal: goal(),
      role: CollaborationSessionRole.WORKER,
      workerId: "worker-one"
    }];
    const gateway = connectedGateway(collaborationTransport((method) => {
      if (method === "listCollaborationGoals") return { access };
      if (method === "getCollaborationGoal") return { tree: activeTree() };
      return collaborationResponse(method);
    }));
    await gateway.connect();

    await expect(gateway.listCollaborationGoals("worker-session", true)).resolves.toMatchObject([
      { id: "goal-one", leadSessionId: "lead-session" }
    ]);
    await expect(gateway.getCollaborationGoal("goal-one", "worker-session")).resolves.toMatchObject({
      goal: { id: "goal-one" },
      workers: [{ id: "worker-one", sessionId: "worker-session" }]
    });

    access = [{ goal: goal(), role: CollaborationSessionRole.WORKER }] as typeof access;
    await expect(gateway.listCollaborationGoals("worker-session", true))
      .rejects.toThrow(/invalid collaboration Session role/iu);
    await expect(gateway.getCollaborationGoal("goal-one", "unrelated-session"))
      .rejects.toThrow(/outside the viewing task/iu);
    gateway.disconnect();
  });

  it("rejects a merge acknowledgement that omits or substitutes a selected dispatch", async () => {
    const gateway = connectedGateway(collaborationTransport((method) => {
      if (method === "mergeCollaborationDispatches") {
        return { tree: activeTree(), dispatches: [dispatch(0), dispatch(0)] };
      }
      return collaborationResponse(method);
    }));
    await gateway.connect();
    const current = await gateway.getCollaborationGoal("goal-one", "lead-session");
    await expect(gateway.mergeCollaborationDispatches(current.goal, current.workers[0]!, current.queue))
      .rejects.toThrow(/incomplete collaboration Queue merge/iu);
    gateway.disconnect();
  });
});

function connectedGateway(transport: Transport) {
  return createOrchestratorGateway(
    { id: "profile", deviceId: "device", name: "Node", origin: "https://service.example", serverId: "node" },
    "fixture-auth",
    {},
    () => transport
  );
}

function collaborationTransport(
  value: (method: string) => object,
  requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = []
): Transport {
  return {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ method: method.localName, input, signal });
      return response(method, create(method.output, value(method.localName)));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function collaborationResponse(method: string): object {
  if (method === "getSnapshot") return { snapshot: {} };
  if (method === "listCollaborationGoals") return {
    access: [{ goal: goal(), role: CollaborationSessionRole.LEAD }]
  };
  if (method === "getCollaborationGoal" || method === "createCollaborationGoal") return { tree: activeTree() };
  if (method === "setCollaborationGoalStatus") {
    return { tree: activeTree({ goal: goal({ status: CollaborationGoalStatus.COMPLETED, completedAt: timestamp(8n) }) }) };
  }
  if (method === "createCollaborationWorker") return { tree: activeTree(), worker: worker() };
  if (method === "updateCollaborationWorker") {
    const updated = worker({ revision: revision(8n), label: "Worker updated", role: "Reviewer", assignment: "Review the lifecycle" });
    return { tree: activeTree({ workers: [updated] }), worker: updated };
  }
  if (method === "focusCollaborationWorker") return { tree: activeTree() };
  if (method === "wakeCollaborationWorker") {
    const awake = worker({ revision: revision(8n), status: CollaborationWorkerStatus.IDLE, focused: true, runtimeReleased: false });
    return { tree: activeTree({ workers: [awake] }), worker: awake };
  }
  if (method === "stopCollaborationWorker") {
    const stopped = worker({ revision: revision(8n), status: CollaborationWorkerStatus.STOPPED, focused: false, runtimeReleased: true });
    return { tree: activeTree({ workers: [stopped], focusedWorkerId: undefined }), worker: stopped };
  }
  if (method === "releaseCollaborationWorker") {
    const released = worker({ revision: revision(8n), status: CollaborationWorkerStatus.IDLE, focused: false, runtimeReleased: true });
    return { tree: activeTree({ workers: [released], focusedWorkerId: undefined }), worker: released };
  }
  if (method === "archiveCollaborationWorker") {
    const archived = worker({ revision: revision(8n), status: CollaborationWorkerStatus.ARCHIVED, focused: false, runtimeReleased: true });
    return { tree: activeTree({ workers: [archived], focusedWorkerId: undefined }), worker: archived };
  }
  if (method === "sendCollaborationWorkerMessage") return { tree: activeTree(), dispatch: dispatch(0) };
  if (method === "interruptCollaborationWorker") {
    return { tree: activeTree(), dispatch: dispatch(0), stopOutcome: CollaborationInterruptStopOutcome.UNCONFIRMED };
  }
  if (method === "editCollaborationDispatch") {
    const edited = dispatch(0, { revision: revision(13n), message: "Edited queued work" });
    return { tree: activeTree({ queue: [queueEntry(0, { revision: revision(13n), message: "Edited queued work" }, { message: "Edited queued work", revision: 23n }), queueEntry(1)] }), dispatch: edited };
  }
  if (method === "cancelCollaborationDispatch") {
    const cancelled = dispatch(0, { revision: revision(13n), status: CollaborationDispatchStatus.CANCELLED });
    return { tree: activeTree({ queue: [queueEntry(0, { revision: revision(13n), status: CollaborationDispatchStatus.CANCELLED }, { state: QueueItemState.CANCELLED, revision: 23n }), queueEntry(1)] }), dispatch: cancelled };
  }
  if (method === "mergeCollaborationDispatches") {
    const survivor = dispatch(0, { revision: revision(13n), message: "First pending instruction\n\nSecond pending instruction" });
    const merged = dispatch(1, { revision: revision(14n), status: CollaborationDispatchStatus.MERGED, mergedIntoDispatchId: "dispatch-one" });
    return {
      tree: activeTree({ queue: [
        queueEntry(0, { revision: revision(13n), message: survivor.message }, { message: survivor.message, revision: 23n }),
        queueEntry(1, { revision: revision(14n), status: CollaborationDispatchStatus.MERGED, mergedIntoDispatchId: "dispatch-one" }, { state: QueueItemState.CANCELLED, revision: 24n })
      ] }),
      dispatches: [survivor, merged]
    };
  }
  throw new Error(`Unexpected RPC ${method}`);
}

function activeTree(overrides: {
  readonly goal?: ReturnType<typeof goal>;
  readonly workers?: readonly ReturnType<typeof worker>[];
  readonly queue?: readonly ReturnType<typeof queueEntry>[];
  readonly focusedWorkerId?: string;
} = {}) {
  const hasFocusedOverride = Object.prototype.hasOwnProperty.call(overrides, "focusedWorkerId");
  return {
    goal: overrides.goal ?? goal(),
    workers: overrides.workers ?? [worker()],
    queue: overrides.queue ?? [queueEntry(0), queueEntry(1)],
    focusedWorkerId: hasFocusedOverride ? overrides.focusedWorkerId : "worker-one"
  };
}

function goal(overrides: Record<string, unknown> = {}) {
  return {
    goalId: "goal-one",
    revision: revision(4n),
    leadId: "lead-one",
    leadSessionId: "lead-session",
    backendId: "backend-one",
    targetId: "target-one",
    sessionGeneration: 9n,
    backendInstanceGeneration: 2n,
    title: "Durable collaboration",
    objective: "Exercise every collaboration boundary",
    maximumWorkers: 4,
    status: CollaborationGoalStatus.ACTIVE,
    createdAt: timestamp(1n),
    updatedAt: timestamp(4n),
    ...overrides
  };
}

function worker(overrides: Record<string, unknown> = {}) {
  return {
    workerId: "worker-one",
    revision: revision(7n),
    goalId: "goal-one",
    sessionId: "worker-session",
    route: {
      backendId: "backend-one",
      targetId: "target-one",
      providerId: "provider-one",
      modelId: "model-one",
      effort: "high",
      fastMode: true,
      permissionMode: PermissionMode.ASK,
      planMode: false
    },
    sessionGeneration: 3n,
    backendInstanceGeneration: 2n,
    label: "Worker one",
    role: "Verifier",
    assignment: "Validate the lifecycle",
    status: CollaborationWorkerStatus.RUNNING,
    focused: true,
    runtimeReleased: false,
    softLimitWarning: false,
    createdAt: timestamp(2n),
    updatedAt: timestamp(4n),
    ...overrides
  };
}

function dispatch(index: number, overrides: Record<string, unknown> = {}) {
  const suffix = index === 0 ? "one" : "two";
  return {
    dispatchId: `dispatch-${suffix}`,
    revision: revision(BigInt(11 + index)),
    goalId: "goal-one",
    workerId: "worker-one",
    callerLeadSessionId: "lead-session",
    operationId: `operation-${suffix}`,
    queueItemId: `queue-${suffix}`,
    message: index === 0 ? "First pending instruction" : "Second pending instruction",
    status: CollaborationDispatchStatus.QUEUED,
    createdAt: timestamp(BigInt(3 + index)),
    updatedAt: timestamp(BigInt(3 + index)),
    ...overrides
  };
}

function queueEntry(index: number, dispatchOverrides: Record<string, unknown> = {}, queueOverrides: Record<string, unknown> = {}) {
  const current = dispatch(index, dispatchOverrides);
  const suffix = index === 0 ? "one" : "two";
  const queueItem = {
    queueItemId: `queue-${suffix}`,
    sessionId: "worker-session",
    targetId: "target-one",
    backendId: "backend-one",
    sourceKind: QueueSourceKind.UI,
    deliveryMode: QueueDeliveryMode.FOLLOW_UP,
    state: QueueItemState.ACCEPTED,
    editLocked: false,
    ordinal: BigInt(index),
    version: { revision: revision(BigInt(21 + index)), generation: 3n },
    input: { parts: [{ content: { case: "text", value: current.message } }] },
    acceptedAt: timestamp(BigInt(3 + index)),
    ...queueOverrides
  };
  if ("message" in queueOverrides || "revision" in queueOverrides) {
    const message = typeof queueOverrides.message === "string" ? queueOverrides.message : current.message;
    const queueRevision = typeof queueOverrides.revision === "bigint" ? queueOverrides.revision : BigInt(21 + index);
    queueItem.input = { parts: [{ content: { case: "text", value: message } }] };
    queueItem.version = { revision: revision(queueRevision), generation: 3n };
    delete (queueItem as any).message;
    delete (queueItem as any).revision;
  }
  return { dispatch: current, queueItem };
}

function revision(value: bigint) { return { value }; }
function timestamp(seconds: bigint) { return { seconds, nanos: 0 }; }
function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
