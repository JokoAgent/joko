import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuthorizationError,
  OperationalStore,
  RevisionConflictError,
  StaleGenerationError,
  StoreError,
  operationBodyHash
} from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("OperationalStore collaboration", () => {
  it("persists a fenced Goal tree, follows Session generations, and rejects capacity or lifecycle bypasses", () => {
    const fixture = createFixture();
    const goal = fixture.store.createCollaborationGoal({
      id: "goal-1",
      leadId: "lead-1",
      leadSessionId: "lead-session",
      title: "Ship the product",
      objective: "Complete every applicable acceptance condition.",
      maximumWorkers: 2,
      expectedSessionGeneration: 0,
      createdAt: 10
    });
    claim(fixture.store, "create-worker-1", { goalId: goal.id, label: "Research" });
    const reserved = fixture.store.reserveCollaborationWorker({
      id: "worker-1",
      goalId: goal.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedGoalRevision: goal.revision,
      createOperationId: "create-worker-1",
      backendId: "backend-1",
      targetId: "target-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      label: "Research",
      role: "Researcher",
      assignment: "Inspect the evidence and report concrete gaps.",
      softLimit: 1,
      hardLimit: 2,
      createdAt: 11
    });
    expect(reserved).toMatchObject({
      id: "worker-1",
      status: "provisioning",
      runtimeReleased: false,
      softLimitWarning: true
    });

    claim(fixture.store, "create-worker-over-limit", { goalId: goal.id, label: "Blocked" });
    expect(() => fixture.store.reserveCollaborationWorker({
      id: "worker-over-limit",
      goalId: goal.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedGoalRevision: fixture.store.getCollaborationGoal(goal.id).revision,
      createOperationId: "create-worker-over-limit",
      backendId: "backend-1",
      targetId: "target-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      label: "Blocked",
      role: "Builder",
      assignment: "This reservation must fail before an external effect.",
      softLimit: 1,
      hardLimit: 1,
      createdAt: 12
    })).toThrow(/hard limit/u);
    expect(fixture.store.listCollaborationWorkers({ goalId: goal.id })).toHaveLength(1);

    fixture.store.createSession({
      id: "worker-session-1",
      backendId: "backend-1",
      targetId: "target-1",
      title: "Research",
      binding: { opaqueRef: "native/worker-1.jsonl", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 13,
      updatedAt: 13
    });
    const bound = fixture.store.bindCollaborationWorkerSession({
      workerId: reserved.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedRevision: reserved.revision,
      sessionId: "worker-session-1",
      expectedSessionGeneration: 0,
      expectedBackendInstanceGeneration: 0,
      updatedAt: 14
    });
    expect(bound).toMatchObject({ status: "idle", idleSince: 14, sessionGeneration: 0 });
    expect(() => fixture.store.updateCollaborationWorkerAssignment({
      workerId: bound.id,
      callerLeadSessionId: "worker-session-1",
      expectedRevision: bound.revision,
      assignment: "Unauthorized replacement"
    })).toThrow(AuthorizationError);
    expect(() => fixture.store.updateCollaborationGoalStatus({
      goalId: goal.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedRevision: fixture.store.getCollaborationGoal(goal.id).revision,
      status: "completed"
    })).toThrow(/active workers/u);

    const workerSession = fixture.store.getSession("worker-session-1");
    fixture.store.updateSession("worker-session-1", {
      binding: { ...workerSession.descriptor.binding, generation: 1 }
    }, workerSession.revision, 15);
    const followed = fixture.store.getCollaborationWorker(bound.id);
    expect(followed.sessionGeneration).toBe(1);

    claim(fixture.store, "stale-dispatch", { workerId: followed.id, message: "stale" });
    expect(() => fixture.store.createCollaborationDispatch({
      id: "stale-dispatch",
      goalId: goal.id,
      workerId: followed.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedWorkerRevision: followed.revision,
      expectedSessionGeneration: 0,
      operationId: "stale-dispatch",
      message: "Do not enqueue stale work.",
      createdAt: 16
    })).toThrow(StaleGenerationError);

    fixture.reopen();
    expect(fixture.store.getCollaborationGoal(goal.id)).toMatchObject({
      id: goal.id,
      status: "active"
    });
    const recovered = fixture.store.getCollaborationWorker(bound.id);
    expect(recovered).toMatchObject({
      sessionId: "worker-session-1",
      sessionGeneration: 1,
      status: "idle"
    });

    const stopped = fixture.store.updateCollaborationWorkerState({
      workerId: recovered.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedRevision: recovered.revision,
      expectedSessionGeneration: 1,
      status: "stopped",
      runtimeReleased: true,
      updatedAt: 17
    });
    const archivedWorker = fixture.store.updateCollaborationWorkerState({
      workerId: stopped.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedRevision: stopped.revision,
      status: "archived",
      runtimeReleased: true,
      updatedAt: 18
    });
    expect(archivedWorker.status).toBe("archived");
    const completed = fixture.store.updateCollaborationGoalStatus({
      goalId: goal.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedRevision: fixture.store.getCollaborationGoal(goal.id).revision,
      status: "completed",
      updatedAt: 19
    });
    expect(fixture.store.updateCollaborationGoalStatus({
      goalId: goal.id,
      callerLeadSessionId: goal.leadSessionId,
      expectedRevision: completed.revision,
      status: "archived",
      updatedAt: 20
    })).toMatchObject({ status: "archived", completedAt: 19 });
  });

  it("edits, cancels, and atomically merges only one contiguous worker Queue segment", () => {
    const fixture = createFixture();
    const { goalId, workerId } = seedBoundWorker(fixture.store);
    const first = enqueueDispatch(fixture.store, goalId, workerId, "one", "First task");
    const second = enqueueDispatch(fixture.store, goalId, workerId, "two", "Second task");
    const third = enqueueDispatch(fixture.store, goalId, workerId, "three", "Third task");

    expect(() => fixture.store.mergeCollaborationDispatches({
      goalId,
      workerId,
      callerLeadSessionId: "lead-session",
      dispatches: [mergeCandidate(first), mergeCandidate(third)],
      traceId: "merge:non-contiguous",
      updatedAt: 40
    })).toThrow(/contiguous/u);
    expect(fixture.store.getQueueItem(first.queue.id).body.text).toBe("First task");
    expect(fixture.store.getQueueItem(third.queue.id).state).toBe("accepted");
    const activeWorker = fixture.store.getCollaborationWorker(workerId);
    expect(() => fixture.store.updateCollaborationWorkerState({
      workerId,
      callerLeadSessionId: "lead-session",
      expectedRevision: activeWorker.revision,
      expectedSessionGeneration: activeWorker.sessionGeneration,
      status: "completed",
      runtimeReleased: false,
      updatedAt: 40
    })).toThrow(/active Queue/u);

    const merged = fixture.store.mergeCollaborationDispatches({
      goalId,
      workerId,
      callerLeadSessionId: "lead-session",
      dispatches: [mergeCandidate(first), mergeCandidate(second)],
      traceId: "merge:contiguous",
      updatedAt: 41
    });
    expect(merged).toMatchObject([
      { id: first.dispatch.id, status: "queued", message: "First task\n\nSecond task" },
      { id: second.dispatch.id, status: "merged", mergedIntoDispatchId: first.dispatch.id }
    ]);
    const survivorQueue = fixture.store.getQueueItem(first.queue.id);
    expect(survivorQueue).toMatchObject({ id: first.queue.id, state: "accepted" });
    expect(survivorQueue.body.text).toBe("First task\n\nSecond task");
    expect(fixture.store.getQueueItem(second.queue.id).state).toBe("cancelled");
    expect(fixture.store.getQueueItem(third.queue.id).state).toBe("accepted");

    expect(() => fixture.store.editCollaborationDispatch({
      dispatchId: first.dispatch.id,
      callerLeadSessionId: "lead-session",
      expectedDispatchRevision: fixture.store.getCollaborationDispatch(first.dispatch.id).revision,
      expectedQueueRevision: first.queue.revision,
      message: "Stale edit",
      traceId: "edit:stale"
    })).toThrow(RevisionConflictError);

    const thirdCurrent = fixture.store.getCollaborationDispatch(third.dispatch.id);
    const thirdQueue = fixture.store.getQueueItem(third.queue.id);
    fixture.store.cancelCollaborationDispatch({
      dispatchId: thirdCurrent.id,
      callerLeadSessionId: "lead-session",
      expectedDispatchRevision: thirdCurrent.revision,
      expectedQueueRevision: thirdQueue.revision,
      traceId: "cancel:third",
      updatedAt: 42
    });
    expect(fixture.store.getCollaborationWorker(workerId).status).toBe("queued");

    const survivorDispatch = fixture.store.getCollaborationDispatch(first.dispatch.id);
    const survivorCurrentQueue = fixture.store.getQueueItem(first.queue.id);
    fixture.store.cancelCollaborationDispatch({
      dispatchId: survivorDispatch.id,
      callerLeadSessionId: "lead-session",
      expectedDispatchRevision: survivorDispatch.revision,
      expectedQueueRevision: survivorCurrentQueue.revision,
      traceId: "cancel:survivor",
      updatedAt: 43
    });
    expect(fixture.store.getCollaborationWorker(workerId)).toMatchObject({
      status: "idle",
      idleSince: 43
    });

    const idleWorker = fixture.store.getCollaborationWorker(workerId);
    const stoppedWorker = fixture.store.updateCollaborationWorkerState({
      workerId,
      callerLeadSessionId: "lead-session",
      expectedRevision: idleWorker.revision,
      expectedSessionGeneration: idleWorker.sessionGeneration,
      status: "stopped",
      runtimeReleased: true,
      updatedAt: 44
    });
    const completedGoal = fixture.store.updateCollaborationGoalStatus({
      goalId,
      callerLeadSessionId: "lead-session",
      expectedRevision: fixture.store.getCollaborationGoal(goalId).revision,
      status: "completed",
      updatedAt: 45
    });
    expect(() => fixture.store.updateCollaborationWorkerAssignment({
      workerId,
      callerLeadSessionId: "lead-session",
      expectedRevision: stoppedWorker.revision,
      assignment: "Do not mutate terminal Goal metadata.",
      updatedAt: 46
    })).toThrow(/active/u);
    expect(() => fixture.store.focusCollaborationWorker({
      goalId: completedGoal.id,
      callerLeadSessionId: "lead-session",
      workerId,
      expectedWorkerRevision: stoppedWorker.revision,
      updatedAt: 46
    })).toThrow(/active/u);
    expect(() => fixture.store.editCollaborationDispatch({
      dispatchId: survivorDispatch.id,
      callerLeadSessionId: "lead-session",
      expectedDispatchRevision: fixture.store.getCollaborationDispatch(survivorDispatch.id).revision,
      expectedQueueRevision: fixture.store.getQueueItem(survivorCurrentQueue.id).revision,
      message: "Do not edit terminal Goal work.",
      traceId: "edit:terminal",
      updatedAt: 46
    })).toThrow(/active/u);
  });

  it("counts a failed but unreleased runtime against the machine-global hard limit", () => {
    const fixture = createFixture();
    const { workerId } = seedBoundWorker(fixture.store);
    const current = fixture.store.getCollaborationWorker(workerId);
    fixture.store.updateCollaborationWorkerState({
      workerId,
      callerLeadSessionId: "lead-session",
      expectedRevision: current.revision,
      expectedSessionGeneration: current.sessionGeneration,
      status: "failed",
      runtimeReleased: false,
      updatedAt: 31
    });
    fixture.store.createSession({
      id: "lead-session-two",
      backendId: "backend-1",
      targetId: "target-1",
      title: "Second lead",
      binding: { opaqueRef: "native/lead-two.jsonl", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 32,
      updatedAt: 32
    });
    const nextGoal = fixture.store.createCollaborationGoal({
      id: "goal-after-failure",
      leadSessionId: "lead-session-two",
      title: "Second Goal",
      objective: "Do not over-admit while the failed runtime still occupies capacity.",
      createdAt: 33
    });
    claim(fixture.store, "create-worker-after-failure", { goalId: nextGoal.id });
    expect(() => fixture.store.reserveCollaborationWorker({
      id: "worker-after-failure",
      goalId: nextGoal.id,
      callerLeadSessionId: nextGoal.leadSessionId,
      expectedGoalRevision: nextGoal.revision,
      createOperationId: "create-worker-after-failure",
      backendId: "backend-1",
      targetId: "target-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      label: "Blocked worker",
      role: "Verifier",
      assignment: "This worker must not be admitted.",
      softLimit: 1,
      hardLimit: 1,
      createdAt: 34
    })).toThrow(/hard limit/u);
  });

  it("keeps collaboration lead and worker Session identities mutually exclusive", () => {
    const fixture = createFixture();
    const { goalId } = seedBoundWorker(fixture.store);
    expect(() => fixture.store.createCollaborationGoal({
      id: "nested-worker-goal",
      leadSessionId: "worker-session-queue",
      title: "Nested Goal",
      objective: "A worker must never create a nested collaboration Goal.",
      expectedSessionGeneration: 0,
      createdAt: 24
    })).toThrow(/cannot lead a nested Goal/u);

    fixture.store.createSession({
      id: "second-lead-session",
      backendId: "backend-1",
      targetId: "target-1",
      title: "Second lead",
      binding: { opaqueRef: "native/second-lead.jsonl", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 25,
      updatedAt: 25
    });
    fixture.store.createCollaborationGoal({
      id: "second-lead-goal",
      leadSessionId: "second-lead-session",
      title: "Existing lead Goal",
      objective: "Preserve the Session's durable lead identity.",
      expectedSessionGeneration: 0,
      createdAt: 26
    });
    claim(fixture.store, "create-second-worker", { goalId });
    const reserved = fixture.store.reserveCollaborationWorker({
      id: "second-worker",
      goalId,
      callerLeadSessionId: "lead-session",
      expectedGoalRevision: fixture.store.getCollaborationGoal(goalId).revision,
      createOperationId: "create-second-worker",
      backendId: "backend-1",
      targetId: "target-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      label: "Second worker",
      role: "Verifier",
      assignment: "This reservation must not capture an existing lead Session.",
      softLimit: 4,
      hardLimit: 8,
      createdAt: 27
    });
    expect(() => fixture.store.bindCollaborationWorkerSession({
      workerId: reserved.id,
      callerLeadSessionId: "lead-session",
      expectedRevision: reserved.revision,
      sessionId: "second-lead-session",
      expectedSessionGeneration: 0,
      expectedBackendInstanceGeneration: 0,
      updatedAt: 28
    })).toThrow(/cannot become a worker/u);
  });
});

function createFixture(): {
  readonly filePath: string;
  readonly store: OperationalStore;
  reopen(): void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-collaboration-store-"));
  const filePath = path.join(directory, "operational.sqlite");
  let nextId = 0;
  let store = new OperationalStore(filePath, { idFactory: () => `generated-${++nextId}` });
  store.upsertBackend({
    id: "backend-1",
    adapterKind: "fixture",
    instanceGeneration: 0,
    displayName: "Fixture",
    version: "test",
    health: "healthy",
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-1",
    backendId: "backend-1",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.createSession({
    id: "lead-session",
    backendId: "backend-1",
    targetId: "target-1",
    title: "Lead",
    binding: { opaqueRef: "native/lead.jsonl", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  const fixture = {
    filePath,
    get store() { return store; },
    reopen() {
      store.close();
      store = new OperationalStore(filePath, { idFactory: () => `generated-${++nextId}` });
    }
  };
  cleanups.push(() => {
    try {
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return fixture;
}

function claim(store: OperationalStore, operationId: string, body: unknown): void {
  store.claimDeferredEffectOperation({ id: operationId, kind: "collaboration_test", body });
}

function seedBoundWorker(store: OperationalStore): { readonly goalId: string; readonly workerId: string } {
  const goal = store.createCollaborationGoal({
    id: "goal-queue",
    leadSessionId: "lead-session",
    title: "Queue Goal",
    objective: "Exercise the durable worker Queue.",
    createdAt: 20
  });
  claim(store, "create-worker-queue", { goalId: goal.id });
  const reserved = store.reserveCollaborationWorker({
    id: "worker-queue",
    goalId: goal.id,
    callerLeadSessionId: goal.leadSessionId,
    expectedGoalRevision: goal.revision,
    createOperationId: "create-worker-queue",
    backendId: "backend-1",
    targetId: "target-1",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    label: "Builder",
    role: "Builder",
    assignment: "Process queued work in order.",
    softLimit: 4,
    hardLimit: 8,
    createdAt: 21
  });
  store.createSession({
    id: "worker-session-queue",
    backendId: "backend-1",
    targetId: "target-1",
    title: "Builder",
    binding: { opaqueRef: "native/worker-queue.jsonl", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 22,
    updatedAt: 22
  });
  store.bindCollaborationWorkerSession({
    workerId: reserved.id,
    callerLeadSessionId: goal.leadSessionId,
    expectedRevision: reserved.revision,
    sessionId: "worker-session-queue",
    expectedSessionGeneration: 0,
    expectedBackendInstanceGeneration: 0,
    updatedAt: 23
  });
  return { goalId: goal.id, workerId: reserved.id };
}

function enqueueDispatch(
  store: OperationalStore,
  goalId: string,
  workerId: string,
  suffix: string,
  message: string
) {
  const operationId = `dispatch-${suffix}`;
  claim(store, operationId, { goalId, workerId, message });
  const worker = store.getCollaborationWorker(workerId);
  const dispatch = store.createCollaborationDispatch({
    id: `dispatch-record-${suffix}`,
    goalId,
    workerId,
    callerLeadSessionId: "lead-session",
    expectedWorkerRevision: worker.revision,
    expectedSessionGeneration: worker.sessionGeneration!,
    operationId,
    message,
    createdAt: 30
  });
  const runId = `run-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const queueId = `queue-${suffix}`;
  store.createRun({
    id: runId,
    sessionId: worker.sessionId!,
    source: "system",
    state: "queued",
    createdAt: 30
  }, { operationId });
  store.createAttempt({
    id: attemptId,
    runId,
    ordinal: 1,
    generation: worker.sessionGeneration!,
    startedAt: 30
  });
  const body = {
    text: message,
    images: [] as const,
    files: [] as const,
    mentions: [] as const,
    disposition: "prompt" as const
  };
  const queue = store.enqueueQueueItem({
    id: queueId,
    sessionId: worker.sessionId!,
    runId,
    attemptId,
    operationId,
    disposition: "prompt",
    body,
    bodyHash: operationBodyHash(body),
    createdAt: 30
  });
  const bound = store.bindCollaborationDispatchQueue({
    dispatchId: dispatch.id,
    expectedRevision: dispatch.revision,
    queueItemId: queue.id,
    updatedAt: 30
  });
  return { dispatch: bound, queue: store.getQueueItem(queue.id) };
}

function mergeCandidate(value: ReturnType<typeof enqueueDispatch>) {
  return {
    dispatchId: value.dispatch.id,
    expectedDispatchRevision: value.dispatch.revision,
    expectedQueueRevision: value.queue.revision
  };
}
