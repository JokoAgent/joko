import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  CollaborationDispatchStatus,
  CollaborationGoalStatus,
  CollaborationSettingsPatchSchema,
  CollaborationWorkerStatus,
  OperationMutationSchema,
  OperationState,
  PermissionMode,
  QueueItemState,
  UpdateCollaborationSettingsMutationSchema,
  type CollaborationGoalTree,
  type CollaborationQueueEntry,
  type CollaborationWorker
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionMutation, pauseQueueMutation, resumeQueueMutation, sessionIdFrom, submit } from "./operations.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  RealPiSystemFixture
} from "./real-pi-fixture.js";
import { waitFor } from "./fixture.js";

describe("Collaboration Goal production chain", () => {
  let fixture: RealPiSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("persists limits, routed workers, contiguous Queue CAS, release/wake, completion, stop, archive, and restart recovery", { timeout: 180_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      keepRoot: true,
      enableInternalServer: true,
      providerResponder: ({ requestNumber }) => ({
        kind: "text",
        text: `COLLABORATION_E2E_SETTLED_${requestNumber}`
      })
    });
    const rootDirectory = fixture.rootDirectory;
    const port = Number(new URL(fixture.baseUrl).port);
    const internalPort = fixture.application.config.internalPort;
    const paired = await fixture.pair("Collaboration lifecycle E2E");

    const settings = await submit(
      paired.clients.operation,
      paired.connectionId,
      create(OperationMutationSchema, {
        payload: {
          case: "updateCollaborationSettings",
          value: create(UpdateCollaborationSettingsMutationSchema, {
            patch: create(CollaborationSettingsPatchSchema, {
              workerSoftLimit: 1,
              workerHardLimit: 2
            })
          })
        }
      }),
      "collaboration-e2e-settings"
    );
    expect(settings.state).toBe(OperationState.SUCCEEDED);

    const leadOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Collaboration E2E lead",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off",
        permissionMode: PermissionMode.AUTO
      }),
      "collaboration-e2e-lead"
    );
    const leadSessionId = sessionIdFrom(leadOperation);
    const leadGeneration = BigInt(fixture.application.store.getSession(leadSessionId).descriptor.binding.generation);
    const createdGoal = await paired.clients.collaboration.createCollaborationGoal({
      operationId: "collaboration-e2e-goal-one",
      leadSessionId,
      expectedSessionGeneration: leadGeneration,
      title: "Durable collaboration E2E",
      objective: "Exercise every public collaboration lifecycle boundary.",
      maximumWorkers: 4
    });
    const goalId = required(createdGoal.tree?.goal?.goalId, "Goal ID");

    let tree = required(createdGoal.tree, "created Goal tree");
    const first = await createWorker(paired, tree, "worker-one", "Builder", "Build and report the first durable result.");
    tree = required(first.tree, "first worker tree");
    expect(first.worker).toMatchObject({
      softLimitWarning: true,
      route: {
        backendId: "pi",
        targetId: "workspace-real-pi",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effort: "off",
        permissionMode: PermissionMode.AUTO
      }
    });
    const second = await createWorker(paired, tree, "worker-two", "Verifier", "Verify the second durable result.");
    tree = required(second.tree, "second worker tree");
    const sessionCountBeforeHardLimit = fixture.application.store.listSessions({ includeArchived: true }).length;
    await expect(createWorker(paired, tree, "worker-three", "Blocked", "This worker must never reach an external effect."))
      .rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(fixture.application.store.listSessions({ includeArchived: true })).toHaveLength(sessionCountBeforeHardLimit);

    const firstWorkerId = required(first.worker?.workerId, "first worker ID");
    const firstWorkerSessionId = required(first.worker?.sessionId, "first worker Session");
    const secondWorkerId = required(second.worker?.workerId, "second worker ID");
    await expect(paired.clients.collaboration.createCollaborationGoal({
      operationId: "collaboration-e2e-nested-goal",
      leadSessionId: firstWorkerSessionId,
      expectedSessionGeneration: first.worker!.sessionGeneration!,
      title: "Nested Goal",
      objective: "A worker cannot create a nested Goal."
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(paired.clients.collaboration.getCollaborationGoal({
      goalId,
      viewerSessionId: "unrelated-session"
    })).rejects.toMatchObject({ code: Code.Unauthenticated });

    tree = required((await waitFor(
      () => paired.clients.collaboration.getCollaborationGoal({ goalId, viewerSessionId: leadSessionId }),
      (value) => value.tree?.workers.length === 2 && value.tree.workers.every((worker) =>
        worker.status === CollaborationWorkerStatus.COMPLETED),
      "both real Pi collaboration workers to settle",
      60_000
    )).tree, "settled Goal tree");

    const firstSettled = worker(tree, firstWorkerId);
    await expect(paired.clients.collaboration.sendCollaborationWorkerMessage({
      operationId: "collaboration-e2e-stale-send",
      goalId,
      workerId: firstWorkerId,
      callerLeadSessionId: leadSessionId,
      expectedWorkerRevision: { value: 1n },
      expectedSessionGeneration: firstSettled.sessionGeneration!,
      message: "This stale request must fail before Queue admission."
    })).rejects.toMatchObject({ code: Code.Aborted });

    const activeControl = required(
      (await paired.clients.queue.getQueueControl({ sessionId: firstWorkerSessionId })).queueControl,
      "worker Queue control"
    );
    await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(activeControl, "Hold collaboration messages for atomic merge"),
      "collaboration-e2e-pause"
    );

    const sentOne = await sendWorkerMessage(paired, tree, firstWorkerId, "Queue message one", "collaboration-e2e-send-one");
    tree = required(sentOne.tree, "first queued tree");
    const sentTwo = await sendWorkerMessage(paired, tree, firstWorkerId, "Queue message two", "collaboration-e2e-send-two");
    tree = required(sentTwo.tree, "second queued tree");
    const sentThree = await sendWorkerMessage(paired, tree, firstWorkerId, "Queue message three", "collaboration-e2e-send-three");
    tree = required(sentThree.tree, "third queued tree");
    const firstDispatchId = required(sentOne.dispatch?.dispatchId, "first dispatch ID");
    const secondDispatchId = required(sentTwo.dispatch?.dispatchId, "second dispatch ID");
    const thirdDispatchId = required(sentThree.dispatch?.dispatchId, "third dispatch ID");

    await expect(paired.clients.collaboration.mergeCollaborationDispatches({
      operationId: "collaboration-e2e-noncontiguous-merge",
      goalId,
      workerId: firstWorkerId,
      callerLeadSessionId: leadSessionId,
      dispatches: [candidate(queueEntry(tree, firstDispatchId)), candidate(queueEntry(tree, thirdDispatchId))]
    })).rejects.toMatchObject({ code: Code.InvalidArgument });

    const firstEntry = queueEntry(tree, firstDispatchId);
    const edited = await paired.clients.collaboration.editCollaborationDispatch({
      operationId: "collaboration-e2e-edit",
      dispatchId: firstDispatchId,
      callerLeadSessionId: leadSessionId,
      expectedDispatchRevision: firstEntry.dispatch!.revision,
      expectedQueueRevision: firstEntry.queueItem!.version!.revision,
      message: "Queue message one, edited"
    });
    tree = required(edited.tree, "edited Queue tree");
    const merged = await paired.clients.collaboration.mergeCollaborationDispatches({
      operationId: "collaboration-e2e-merge",
      goalId,
      workerId: firstWorkerId,
      callerLeadSessionId: leadSessionId,
      dispatches: [candidate(queueEntry(tree, firstDispatchId)), candidate(queueEntry(tree, secondDispatchId))]
    });
    tree = required(merged.tree, "merged Queue tree");
    expect(merged.dispatches).toEqual([
      expect.objectContaining({
        dispatchId: firstDispatchId,
        status: CollaborationDispatchStatus.QUEUED,
        message: "Queue message one, edited\n\nQueue message two"
      }),
      expect.objectContaining({
        dispatchId: secondDispatchId,
        status: CollaborationDispatchStatus.MERGED,
        mergedIntoDispatchId: firstDispatchId
      })
    ]);
    const thirdEntry = queueEntry(tree, thirdDispatchId);
    const cancelled = await paired.clients.collaboration.cancelCollaborationDispatch({
      operationId: "collaboration-e2e-cancel",
      dispatchId: thirdDispatchId,
      callerLeadSessionId: leadSessionId,
      expectedDispatchRevision: thirdEntry.dispatch!.revision,
      expectedQueueRevision: thirdEntry.queueItem!.version!.revision
    });
    tree = required(cancelled.tree, "cancelled Queue tree");
    expect(queueEntry(tree, firstDispatchId).queueItem).toMatchObject({ state: QueueItemState.ACCEPTED });
    expect(queueEntry(tree, secondDispatchId).queueItem).toMatchObject({ state: QueueItemState.CANCELLED });
    expect(queueEntry(tree, thirdDispatchId).queueItem).toMatchObject({ state: QueueItemState.CANCELLED });

    const authKey = paired.authKey;
    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await RealPiSystemFixture.start({
      rootDirectory,
      port,
      internalPort,
      enableInternalServer: true,
      providerResponder: ({ requestNumber }) => ({
        kind: "text",
        text: `COLLABORATION_E2E_RESTARTED_${requestNumber}`
      })
    });
    const restarted = fixture.clients(authKey);
    tree = required((await restarted.collaboration.getCollaborationGoal({
      goalId,
      viewerSessionId: leadSessionId
    })).tree, "restarted Goal tree");
    expect(tree.workers).toHaveLength(2);
    expect(tree.queue.filter((entry) => [firstDispatchId, secondDispatchId, thirdDispatchId]
      .includes(entry.dispatch?.dispatchId ?? ""))).toHaveLength(3);
    expect(queueEntry(tree, firstDispatchId).queueItem).toMatchObject({ state: QueueItemState.ACCEPTED });
    expect(fixture.application.store.listSessions({ includeArchived: true })).toHaveLength(sessionCountBeforeHardLimit);

    const pausedControl = required(
      (await restarted.queue.getQueueControl({ sessionId: firstWorkerSessionId })).queueControl,
      "restarted worker Queue control"
    );
    await submit(
      restarted.operation,
      paired.connectionId,
      resumeQueueMutation(pausedControl),
      "collaboration-e2e-resume"
    );
    tree = required((await waitFor(
      () => restarted.collaboration.getCollaborationGoal({ goalId, viewerSessionId: leadSessionId }),
      (value) => queueState(value.tree, firstDispatchId) === QueueItemState.COMPLETED
        && [CollaborationWorkerStatus.IDLE, CollaborationWorkerStatus.COMPLETED]
          .includes(worker(value.tree!, firstWorkerId).status),
      "the merged collaboration Queue survivor to complete after restart",
      60_000
    )).tree, "post-restart completed tree");

    let currentFirst = worker(tree, firstWorkerId);
    const released = await restarted.collaboration.releaseCollaborationWorker({
      operationId: "collaboration-e2e-release",
      workerId: firstWorkerId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: currentFirst.revision,
      expectedSessionGeneration: currentFirst.sessionGeneration!
    });
    expect(released.worker).toMatchObject({ runtimeReleased: true });
    currentFirst = required(released.worker, "released worker");
    const woken = await restarted.collaboration.wakeCollaborationWorker({
      operationId: "collaboration-e2e-wake",
      workerId: firstWorkerId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: currentFirst.revision,
      expectedSessionGeneration: currentFirst.sessionGeneration!
    });
    expect(woken.worker).toMatchObject({ runtimeReleased: false });
    tree = required(woken.tree, "woken worker tree");

    const focusedSecond = worker(tree, secondWorkerId);
    tree = required((await restarted.collaboration.focusCollaborationWorker({
      operationId: "collaboration-e2e-focus",
      goalId,
      callerLeadSessionId: leadSessionId,
      workerId: secondWorkerId,
      expectedWorkerRevision: focusedSecond.revision
    })).tree, "focused tree");
    expect(tree.focusedWorkerId).toBe(secondWorkerId);

    const stoppedSecond = await restarted.collaboration.stopCollaborationWorker({
      operationId: "collaboration-e2e-stop-worker",
      workerId: secondWorkerId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: worker(tree, secondWorkerId).revision,
      expectedSessionGeneration: worker(tree, secondWorkerId).sessionGeneration
    });
    const archivedSecond = await restarted.collaboration.archiveCollaborationWorker({
      operationId: "collaboration-e2e-archive-worker",
      workerId: secondWorkerId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: stoppedSecond.worker!.revision
    });
    expect(archivedSecond.worker).toMatchObject({
      status: CollaborationWorkerStatus.ARCHIVED,
      runtimeReleased: true
    });
    tree = required(archivedSecond.tree, "tree after worker archive");

    const finalMessage = await sendWorkerMessage(
      { ...paired, clients: restarted },
      tree,
      firstWorkerId,
      "Final completion message",
      "collaboration-e2e-final-send"
    );
    tree = required((await waitFor(
      () => restarted.collaboration.getCollaborationGoal({ goalId, viewerSessionId: leadSessionId }),
      (value) => value.tree !== undefined && worker(value.tree, firstWorkerId).status === CollaborationWorkerStatus.COMPLETED,
      "the woken worker to complete its final message",
      60_000
    )).tree, "final settled tree");
    expect(finalMessage.dispatch?.queueItemId).toBeTruthy();

    const completedGoal = await restarted.collaboration.setCollaborationGoalStatus({
      operationId: "collaboration-e2e-complete-goal",
      goalId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: tree.goal!.revision,
      status: CollaborationGoalStatus.COMPLETED
    });
    expect(completedGoal.tree?.goal?.status).toBe(CollaborationGoalStatus.COMPLETED);
    const archivedGoal = await restarted.collaboration.setCollaborationGoalStatus({
      operationId: "collaboration-e2e-archive-goal",
      goalId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: completedGoal.tree!.goal!.revision,
      status: CollaborationGoalStatus.ARCHIVED
    });
    expect(archivedGoal.tree?.workers.every((candidate) =>
      candidate.status === CollaborationWorkerStatus.ARCHIVED && candidate.runtimeReleased)).toBe(true);

    const nextGoal = await restarted.collaboration.createCollaborationGoal({
      operationId: "collaboration-e2e-goal-two",
      leadSessionId,
      expectedSessionGeneration: leadGeneration,
      title: "Stop lifecycle Goal",
      objective: "Prove Goal stop retires every worker before committing terminal state."
    });
    const nextWorker = await createWorker(
      { ...paired, clients: restarted },
      required(nextGoal.tree, "second Goal tree"),
      "stop-worker",
      "Stop verifier",
      "Remain active until the Goal is stopped."
    );
    const stoppedGoal = await restarted.collaboration.setCollaborationGoalStatus({
      operationId: "collaboration-e2e-stop-goal",
      goalId: nextGoal.tree!.goal!.goalId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: nextWorker.tree!.goal!.revision,
      status: CollaborationGoalStatus.STOPPED
    });
    expect(stoppedGoal.tree?.goal?.status).toBe(CollaborationGoalStatus.STOPPED);
    expect(stoppedGoal.tree?.workers).toEqual([
      expect.objectContaining({ status: CollaborationWorkerStatus.ARCHIVED, runtimeReleased: true })
    ]);
    const finalArchive = await restarted.collaboration.setCollaborationGoalStatus({
      operationId: "collaboration-e2e-final-archive",
      goalId: stoppedGoal.tree!.goal!.goalId,
      callerLeadSessionId: leadSessionId,
      expectedRevision: stoppedGoal.tree!.goal!.revision,
      status: CollaborationGoalStatus.ARCHIVED
    });
    expect(finalArchive.tree?.goal?.status).toBe(CollaborationGoalStatus.ARCHIVED);
  });
});

type Paired = Awaited<ReturnType<RealPiSystemFixture["pair"]>>;

async function createWorker(
  paired: Paired,
  tree: CollaborationGoalTree,
  label: string,
  role: string,
  assignment: string
) {
  return paired.clients.collaboration.createCollaborationWorker({
    operationId: `collaboration-e2e-create-${label}-${randomUUID()}`,
    goalId: tree.goal!.goalId,
    callerLeadSessionId: tree.goal!.leadSessionId,
    expectedGoalRevision: tree.goal!.revision,
    label,
    role,
    assignment,
    targetId: "workspace-real-pi",
    providerId: REAL_PI_PROVIDER_ID,
    modelId: REAL_PI_MODEL_ID,
    effort: "off",
    fastMode: false,
    permissionMode: PermissionMode.AUTO,
    planMode: false
  });
}

async function sendWorkerMessage(
  paired: Paired,
  tree: CollaborationGoalTree,
  workerId: string,
  message: string,
  operationId: string
) {
  const current = worker(tree, workerId);
  return paired.clients.collaboration.sendCollaborationWorkerMessage({
    operationId,
    goalId: tree.goal!.goalId,
    workerId,
    callerLeadSessionId: tree.goal!.leadSessionId,
    expectedWorkerRevision: current.revision,
    expectedSessionGeneration: current.sessionGeneration!,
    message
  });
}

function worker(tree: CollaborationGoalTree, workerId: string): CollaborationWorker {
  return required(tree.workers.find((candidate) => candidate.workerId === workerId), `worker ${workerId}`);
}

function queueEntry(tree: CollaborationGoalTree, dispatchId: string): CollaborationQueueEntry {
  return required(
    tree.queue.find((candidate) => candidate.dispatch?.dispatchId === dispatchId),
    `Queue entry ${dispatchId}`
  );
}

function candidate(entry: CollaborationQueueEntry) {
  return {
    dispatchId: entry.dispatch!.dispatchId,
    expectedDispatchRevision: entry.dispatch!.revision,
    expectedQueueRevision: entry.queueItem!.version!.revision
  };
}

function queueState(tree: CollaborationGoalTree | undefined, dispatchId: string): QueueItemState | undefined {
  return tree === undefined ? undefined : queueEntry(tree, dispatchId).queueItem?.state;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === "") throw new Error(`Missing ${label}.`);
  return value;
}
