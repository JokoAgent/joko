import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_COLLABORATION_SETTINGS, WorkerHardLimitError } from "@joko/runtime-governance";
import { OperationalStore, operationBodyHash } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import { SessionHost } from "./session-host.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("CollaborationGoalManager", () => {
  it("creates a durable Goal and worker, then admits the initial assignment through the exact worker Queue", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-create-one",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Ship the release",
      objective: "Complete the release with independently verifiable evidence."
    }).goal;

    const created = await fixture.manager.createWorker(workerInput(goal.id, goal.revision, fixture.leadSessionId, {
      operationId: "worker-create-one",
      label: "Verifier",
      role: "verification",
      assignment: "Run the focused verification and report concrete evidence."
    }));

    expect(created.worker).toMatchObject({
      goalId: goal.id,
      label: "Verifier",
      role: "verification",
      assignment: "Run the focused verification and report concrete evidence.",
      runtimeReleased: false
    });
    expect(created.worker.sessionId).toBeDefined();
    expect(created.worker.sessionGeneration).toBe(1);
    const dispatches = fixture.store.listCollaborationDispatches({ workerId: created.worker.id });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      goalId: goal.id,
      workerId: created.worker.id,
      message: created.worker.assignment,
      status: "queued"
    });
    const queueItem = fixture.store.getQueueItem(dispatches[0]!.queueItemId!);
    expect(queueItem).toMatchObject({
      sessionId: created.worker.sessionId,
      operationId: dispatches[0]!.operationId,
      body: { text: created.worker.assignment }
    });
    expect(fixture.store.getOperation(dispatches[0]!.operationId).status).toBe("completed");

    await vi.waitFor(() => {
      expect(["idle", "completed"]).toContain(fixture.manager.getTree(goal.id).workers[0]!.status);
    });
  });

  it("rejects the hard-limit worker before another native Session is created and restores admitted workers after restart", async () => {
    const settings = {
      ...DEFAULT_COLLABORATION_SETTINGS,
      workerSoftLimit: 1,
      workerHardLimit: 1
    };
    const fixture = await createFixture(settings);
    const goal = fixture.manager.createGoal({
      operationId: "goal-hard-limit",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Bounded work",
      objective: "Never exceed the configured worker capacity."
    }).goal;
    const first = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-hard-limit-first", label: "One", role: "builder", assignment: "Build one." }
    ));
    expect(first.worker.softLimitWarning).toBe(true);
    const sessionCount = fixture.store.listSessions({ includeArchived: true, includeDeleted: true }).length;

    const currentGoal = fixture.manager.getTree(goal.id).goal;
    await expect(fixture.manager.createWorker(workerInput(
      goal.id,
      currentGoal.revision,
      fixture.leadSessionId,
      { operationId: "worker-hard-limit-second", label: "Two", role: "builder", assignment: "Build two." }
    ))).rejects.toBeInstanceOf(WorkerHardLimitError);
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(sessionCount);
    expect(fixture.store.findOperation("worker-hard-limit-second")).toBeUndefined();

    await fixture.manager.close();
    const recovered = new CollaborationGoalManager({
      store: fixture.store,
      sessionHost: fixture.host,
      readSettings: () => settings
    });
    fixture.managers.push(recovered);
    await recovered.initialize();
    const tree = recovered.getTree(goal.id);
    expect(tree.workers).toHaveLength(1);
    expect(tree.workers[0]).toMatchObject({
      id: first.worker.id,
      sessionId: first.worker.sessionId,
      softLimitWarning: true
    });
    await expect(recovered.createWorker(workerInput(
      goal.id,
      tree.goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-hard-limit-after-restart", label: "Three", role: "builder", assignment: "Build three." }
    ))).rejects.toBeInstanceOf(WorkerHardLimitError);
  });

  it("keeps collaboration Queue edits, cancellation, and contiguous merge revision-fenced and atomic", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-queue",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Queue work",
      objective: "Coordinate a deterministic pending work queue."
    }).goal;
    const created = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-queue", label: "Queue owner", role: "builder", assignment: "Finish setup." }
    ));
    const workerSessionId = created.worker.sessionId!;
    await vi.waitFor(() => {
      const initial = fixture.store.listCollaborationDispatches({ workerId: created.worker.id })[0]!;
      expect(["completed", "failed", "cancelled"]).toContain(
        fixture.store.getQueueItem(initial.queueItemId!).state
      );
    });
    fixture.store.setQueuePaused({
      sessionId: workerSessionId,
      paused: true,
      reason: "test deterministic merge",
      traceId: "collaboration-test:pause"
    });

    const send = async (operationId: string, message: string) => {
      const worker = fixture.store.getCollaborationWorker(created.worker.id);
      return (await fixture.manager.sendMessage({
        operationId,
        goalId: goal.id,
        workerId: worker.id,
        callerLeadSessionId: fixture.leadSessionId,
        expectedWorkerRevision: worker.revision,
        expectedSessionGeneration: worker.sessionGeneration!,
        message
      })).dispatch;
    };
    let first = await send("queue-send-one", "one");
    const second = await send("queue-send-two", "two");
    const third = await send("queue-send-three", "three");
    expect([first, second, third].map((dispatch) =>
      fixture.store.getQueueItem(dispatch.queueItemId!).state)).toEqual(["accepted", "accepted", "accepted"]);

    first = fixture.manager.editDispatch({
      operationId: "queue-edit-one",
      dispatchId: first.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedDispatchRevision: first.revision,
      expectedQueueRevision: fixture.store.getQueueItem(first.queueItemId!).revision,
      message: "one edited"
    }).dispatch;
    const merged = fixture.manager.mergeDispatches({
      operationId: "queue-merge-one-two",
      goalId: goal.id,
      workerId: created.worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      dispatches: [first, second].map((dispatch) => ({
        dispatchId: dispatch.id,
        expectedDispatchRevision: dispatch.revision,
        expectedQueueRevision: fixture.store.getQueueItem(dispatch.queueItemId!).revision
      }))
    }).dispatches;
    expect(merged).toEqual([
      expect.objectContaining({ id: first.id, message: "one edited\n\ntwo", status: "queued" }),
      expect.objectContaining({ id: second.id, status: "merged", mergedIntoDispatchId: first.id })
    ]);
    expect(fixture.store.getQueueItem(first.queueItemId!)).toMatchObject({
      state: "accepted",
      body: { text: "one edited\n\ntwo" }
    });
    expect(fixture.store.getQueueItem(second.queueItemId!).state).toBe("cancelled");

    const cancelled = fixture.manager.cancelDispatch({
      operationId: "queue-cancel-three",
      dispatchId: third.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedDispatchRevision: third.revision,
      expectedQueueRevision: fixture.store.getQueueItem(third.queueItemId!).revision
    }).dispatch;
    expect(cancelled.status).toBe("cancelled");
    expect(fixture.store.getQueueItem(third.queueItemId!).state).toBe("cancelled");
  });

  it("persists an interrupt replacement before cancelling older pending collaboration work and replays it exactly", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-interrupt",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Interrupt work",
      objective: "Replace obsolete queued work without losing the replacement."
    }).goal;
    const created = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-interrupt", label: "Interruptible", role: "builder", assignment: "Finish setup." }
    ));
    await vi.waitFor(() => {
      expect(fixture.store.listRuns({ sessionId: created.worker.sessionId!, activeOnly: true })).toHaveLength(0);
    });
    fixture.store.setQueuePaused({
      sessionId: created.worker.sessionId!,
      paused: true,
      reason: "test interrupt ordering",
      traceId: "collaboration-test:interrupt-pause"
    });
    const send = async (operationId: string, message: string) => {
      const worker = fixture.store.getCollaborationWorker(created.worker.id);
      return (await fixture.manager.sendMessage({
        operationId,
        goalId: goal.id,
        workerId: worker.id,
        callerLeadSessionId: fixture.leadSessionId,
        expectedWorkerRevision: worker.revision,
        expectedSessionGeneration: worker.sessionGeneration!,
        message
      })).dispatch;
    };
    const obsoleteOne = await send("interrupt-obsolete-one", "obsolete one");
    const obsoleteTwo = await send("interrupt-obsolete-two", "obsolete two");
    const worker = fixture.store.getCollaborationWorker(created.worker.id);
    const interruptInput = {
      operationId: "interrupt-replacement",
      goalId: goal.id,
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedWorkerRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration!,
      message: "replacement instruction"
    };
    const interrupted = await fixture.manager.interruptWorker(interruptInput);
    expect(interrupted.stopOutcome).toBe("not_running");
    expect(fixture.store.getQueueItem(obsoleteOne.queueItemId!).state).toBe("cancelled");
    expect(fixture.store.getQueueItem(obsoleteTwo.queueItemId!).state).toBe("cancelled");
    expect(fixture.store.getQueueItem(interrupted.dispatch.queueItemId!)).toMatchObject({
      state: "accepted",
      body: { text: "replacement instruction" }
    });
    expect(fixture.store.listQueueItems({
      sessionId: worker.sessionId!,
      states: ["accepted"]
    }).map((item) => item.id)).toEqual([interrupted.dispatch.queueItemId]);

    const replay = await fixture.manager.interruptWorker(interruptInput);
    expect(replay).toMatchObject({
      dispatch: { id: interrupted.dispatch.id },
      stopOutcome: "already_queued"
    });
    await expect(fixture.manager.interruptWorker({
      ...interruptInput,
      message: "different replacement"
    })).rejects.toThrow(/different collaboration input or authority/u);
  });

  it("refreshes runtime generations across release and wake, then stops and archives the durable worker task", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-lifecycle",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Lifecycle work",
      objective: "Exercise worker release, wake, stop, and archive."
    }).goal;
    const created = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-lifecycle", label: "Lifecycle", role: "operator", assignment: "Finish setup." }
    ));
    await vi.waitFor(() => {
      expect(["idle", "completed"]).toContain(
        fixture.store.getCollaborationWorker(created.worker.id).status
      );
      expect(fixture.store.listRuns({ sessionId: created.worker.sessionId!, activeOnly: true })).toHaveLength(0);
    });

    let worker = fixture.store.getCollaborationWorker(created.worker.id);
    const generationBeforeRelease = worker.sessionGeneration!;
    worker = (await fixture.manager.releaseWorker({
      operationId: "worker-release",
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: worker.revision,
      expectedSessionGeneration: generationBeforeRelease
    })).worker;
    expect(worker.runtimeReleased).toBe(true);

    worker = (await fixture.manager.wakeWorker({
      operationId: "worker-wake",
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: worker.revision,
      expectedSessionGeneration: generationBeforeRelease
    })).worker;
    expect(worker.runtimeReleased).toBe(false);
    expect(worker.sessionGeneration).toBeGreaterThan(generationBeforeRelease);
    expect(worker.sessionGeneration).toBe(
      fixture.store.getSession(worker.sessionId!).descriptor.binding.generation
    );

    const sent = await fixture.manager.sendMessage({
      operationId: "worker-after-wake-send",
      goalId: goal.id,
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedWorkerRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration!,
      message: "Confirm the resumed runtime."
    });
    expect(sent.dispatch.queueItemId).toBeDefined();
    await vi.waitFor(() => {
      expect(fixture.store.listRuns({ sessionId: worker.sessionId!, activeOnly: true })).toHaveLength(0);
    });

    worker = fixture.store.getCollaborationWorker(worker.id);
    worker = (await fixture.manager.stopWorker({
      operationId: "worker-stop",
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration
    })).worker;
    expect(worker).toMatchObject({ status: "stopped", runtimeReleased: true });
    worker = fixture.manager.archiveWorker({
      operationId: "worker-archive",
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: worker.revision
    }).worker;
    expect(worker.status).toBe("archived");
    expect(fixture.store.getSession(worker.sessionId!).descriptor.archived).toBe(true);
  });

  it("stops a Goal by durably stopping and archiving every worker before committing the Goal terminal state", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-stop-all-create",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Stop all work",
      objective: "Retire every worker before the Goal reports that it stopped."
    }).goal;
    const first = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "goal-stop-all-first", label: "First", role: "builder", assignment: "Build the first part." }
    ));
    const afterFirst = fixture.manager.getTree(goal.id).goal;
    const second = await fixture.manager.createWorker(workerInput(
      goal.id,
      afterFirst.revision,
      fixture.leadSessionId,
      { operationId: "goal-stop-all-second", label: "Second", role: "verifier", assignment: "Verify the second part." }
    ));
    const current = fixture.manager.getTree(goal.id).goal;
    const input = {
      operationId: "goal-stop-all",
      goalId: goal.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: current.revision,
      status: "stopped" as const
    };

    const stopped = await fixture.manager.setGoalStatus(input);
    expect(stopped.goal.status).toBe("stopped");
    expect(stopped.workers).toEqual([
      expect.objectContaining({ id: first.worker.id, status: "archived", runtimeReleased: true }),
      expect.objectContaining({ id: second.worker.id, status: "archived", runtimeReleased: true })
    ]);
    expect(stopped.workers.map((worker) => fixture.store.getSession(worker.sessionId!).descriptor.archived))
      .toEqual([true, true]);
    expect(fixture.store.getOperation(input.operationId)).toMatchObject({ status: "completed" });

    const replay = await fixture.manager.setGoalStatus(input);
    expect(replay.goal).toMatchObject({ id: goal.id, status: "stopped" });
    expect(replay.workers.every((worker) => worker.status === "archived")).toBe(true);
  });

  it("rejects waking a released worker after its Goal completes without touching the native runtime", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-terminal-wake-create",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Terminal wake",
      objective: "Never revive worker execution after Goal completion."
    }).goal;
    const created = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "goal-terminal-wake-worker", label: "Settled", role: "verifier", assignment: "Finish setup." }
    ));
    await vi.waitFor(() => {
      expect(["completed", "failed"]).toContain(
        fixture.store.getCollaborationWorker(created.worker.id).status
      );
      expect(fixture.store.listRuns({ sessionId: created.worker.sessionId!, activeOnly: true })).toHaveLength(0);
    });
    let worker = fixture.store.getCollaborationWorker(created.worker.id);
    worker = (await fixture.manager.releaseWorker({
      operationId: "goal-terminal-wake-release",
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration!
    })).worker;
    const currentGoal = fixture.manager.getTree(goal.id).goal;
    await fixture.manager.setGoalStatus({
      operationId: "goal-terminal-wake-complete",
      goalId: goal.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: currentGoal.revision,
      status: "completed"
    });
    const resume = vi.spyOn(fixture.host, "resume");

    await expect(fixture.manager.wakeWorker({
      operationId: "goal-terminal-wake-rejected",
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration!
    })).rejects.toThrow(/active collaboration lead/u);
    expect(resume).not.toHaveBeenCalled();
    expect(fixture.store.findOperation("goal-terminal-wake-rejected")).toBeUndefined();
    expect(fixture.store.getCollaborationWorker(worker.id)).toMatchObject({
      status: worker.status,
      runtimeReleased: true
    });
  });

  it("recovers an interrupted worker creation as unknown without replaying the native Session effect", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-create-recovery",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Creation recovery",
      objective: "Never replay a native Session creation whose outcome is unknown."
    }).goal;
    await fixture.manager.close();
    fixture.store.claimDeferredEffectOperation({
      id: "worker-create-recovery",
      kind: "create_collaboration_worker",
      body: { goalId: goal.id }
    });
    const reserved = fixture.store.reserveCollaborationWorker({
      id: "worker:recovery-create",
      goalId: goal.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedGoalRevision: goal.revision,
      createOperationId: "worker-create-recovery",
      backendId: PI_LIKE_PROFILE.id,
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      label: "Uncertain creator",
      role: "builder",
      assignment: "Preserve an uncertain native creation outcome.",
      softLimit: 4,
      hardLimit: 8
    });
    const nativeOperationId = serviceOperationIdForTest(reserved.createOperationId, "session");
    fixture.store.claimDeferredEffectOperation({
      id: nativeOperationId,
      kind: "create_collaboration_worker_session",
      body: { workerId: reserved.id }
    });

    const recovered = new CollaborationGoalManager({
      store: fixture.store,
      sessionHost: fixture.host,
      readSettings: () => DEFAULT_COLLABORATION_SETTINGS
    });
    fixture.managers.push(recovered);
    await recovered.initialize();
    expect(fixture.store.getCollaborationWorker(reserved.id)).toMatchObject({
      status: "dispatch_unknown",
      runtimeReleased: false,
      lastError: { code: "COLLABORATION_WORKER_CREATE_UNKNOWN", retryable: true }
    });
    expect(fixture.store.getCollaborationWorker(reserved.id).sessionId).toBeUndefined();
    expect(fixture.store.getOperation(nativeOperationId).status).toBe("started");
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })
      .filter((session) => session.descriptor.id !== fixture.leadSessionId)).toHaveLength(0);
  });

  it("recovers an interrupted stop with unconfirmed native work as unknown instead of claiming success", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-stop-recovery",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Stop recovery",
      objective: "Do not report a stopped worker while native work may still be running."
    }).goal;
    const created = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-stop-recovery", label: "Stop uncertain", role: "builder", assignment: "Finish setup." }
    ));
    await vi.waitFor(() => expect(fixture.store.listRuns({ sessionId: created.worker.sessionId!, activeOnly: true })).toHaveLength(0));
    await fixture.manager.close();
    await fixture.host.closeIfActive(created.worker.sessionId!);
    fixture.store.createRun({
      id: "run-stop-recovery",
      sessionId: created.worker.sessionId!,
      source: "system",
      state: "running",
      createdAt: Date.now()
    });
    fixture.store.claimDeferredEffectOperation({
      id: "stop-worker-recovery",
      kind: "stop_collaboration_worker",
      body: { workerId: created.worker.id }
    });
    const current = fixture.store.getCollaborationWorker(created.worker.id);
    fixture.store.updateCollaborationWorkerState({
      workerId: current.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: current.revision,
      expectedSessionGeneration: current.sessionGeneration,
      status: "stopping",
      runtimeReleased: false
    });

    const recovered = new CollaborationGoalManager({
      store: fixture.store,
      sessionHost: fixture.host,
      readSettings: () => DEFAULT_COLLABORATION_SETTINGS
    });
    fixture.managers.push(recovered);
    await recovered.initialize();
    expect(fixture.store.getCollaborationWorker(created.worker.id)).toMatchObject({
      status: "dispatch_unknown",
      runtimeReleased: false,
      lastError: { code: "COLLABORATION_WORKER_STOP_UNKNOWN", retryable: true }
    });
    expect(fixture.store.getOperation("stop-worker-recovery").status).toBe("started");
    expect(fixture.store.getRun("run-stop-recovery").descriptor.state).toBe("running");
  });

  it("conservatively restores interrupted wake and release effects as capacity-occupying unknown workers", async () => {
    const settings = {
      ...DEFAULT_COLLABORATION_SETTINGS,
      workerSoftLimit: 2,
      workerHardLimit: 2
    };
    const fixture = await createFixture(settings);
    const goal = fixture.manager.createGoal({
      operationId: "goal-lifecycle-recovery",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Lifecycle recovery",
      objective: "Conservatively account for uncertain runtime wake and release effects."
    }).goal;
    const first = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-wake-recovery", label: "Wake uncertain", role: "builder", assignment: "Finish setup." }
    ));
    const goalAfterFirst = fixture.manager.getTree(goal.id).goal;
    const second = await fixture.manager.createWorker(workerInput(
      goal.id,
      goalAfterFirst.revision,
      fixture.leadSessionId,
      { operationId: "worker-release-recovery", label: "Release uncertain", role: "builder", assignment: "Finish setup." }
    ));
    await vi.waitFor(() => {
      expect(fixture.store.listRuns({ sessionId: first.worker.sessionId!, activeOnly: true })).toHaveLength(0);
      expect(fixture.store.listRuns({ sessionId: second.worker.sessionId!, activeOnly: true })).toHaveLength(0);
    });
    let firstCurrent = fixture.store.getCollaborationWorker(first.worker.id);
    firstCurrent = (await fixture.manager.releaseWorker({
      operationId: "worker-wake-recovery-release-first",
      workerId: firstCurrent.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedRevision: firstCurrent.revision,
      expectedSessionGeneration: firstCurrent.sessionGeneration!
    })).worker;
    expect(firstCurrent.runtimeReleased).toBe(true);
    await fixture.manager.close();
    fixture.store.claimDeferredEffectOperation({
      id: "worker-wake-recovery-started",
      kind: "wake_collaboration_worker",
      body: { workerId: firstCurrent.id }
    });
    fixture.store.claimDeferredEffectOperation({
      id: "worker-release-recovery-started",
      kind: "release_collaboration_worker",
      body: { workerId: second.worker.id }
    });

    const recovered = new CollaborationGoalManager({
      store: fixture.store,
      sessionHost: fixture.host,
      readSettings: () => settings
    });
    fixture.managers.push(recovered);
    await recovered.initialize();
    expect(fixture.store.getCollaborationWorker(first.worker.id)).toMatchObject({
      status: "dispatch_unknown",
      runtimeReleased: false,
      lastError: { code: "COLLABORATION_WORKER_WAKE_UNKNOWN", retryable: true }
    });
    expect(fixture.store.getCollaborationWorker(second.worker.id)).toMatchObject({
      status: "dispatch_unknown",
      runtimeReleased: false,
      lastError: { code: "COLLABORATION_WORKER_RELEASE_UNKNOWN", retryable: true }
    });
    const currentGoal = recovered.getTree(goal.id).goal;
    await expect(recovered.createWorker(workerInput(
      goal.id,
      currentGoal.revision,
      fixture.leadSessionId,
      { operationId: "worker-after-unknown-effects", label: "Blocked", role: "builder", assignment: "Must not over-admit." }
    ))).rejects.toBeInstanceOf(WorkerHardLimitError);
  });

  it("binds a proven completed Queue admission on restart and marks an unproven one unknown", async () => {
    const fixture = await createFixture();
    const goal = fixture.manager.createGoal({
      operationId: "goal-dispatch-recovery",
      leadSessionId: fixture.leadSessionId,
      expectedSessionGeneration: fixture.leadGeneration,
      title: "Dispatch recovery",
      objective: "Recover only Queue admissions with durable completion evidence."
    }).goal;
    const created = await fixture.manager.createWorker(workerInput(
      goal.id,
      goal.revision,
      fixture.leadSessionId,
      { operationId: "worker-dispatch-recovery", label: "Queue recovery", role: "builder", assignment: "Finish setup." }
    ));
    await vi.waitFor(() => expect(fixture.store.listRuns({ sessionId: created.worker.sessionId!, activeOnly: true })).toHaveLength(0));
    fixture.store.setQueuePaused({
      sessionId: created.worker.sessionId!,
      paused: true,
      reason: "recovery fixture",
      traceId: "collaboration:test:dispatch-recovery"
    });
    const worker = fixture.store.getCollaborationWorker(created.worker.id);
    const completedOperation = fixture.store.claimDeferredEffectOperation({
      id: "dispatch-recovery-completed",
      kind: "service_send_input",
      body: { workerId: worker.id, message: "durably admitted" }
    }).operation;
    const proven = fixture.store.createCollaborationDispatch({
      id: "dispatch:recovery-completed",
      goalId: goal.id,
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedWorkerRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration!,
      operationId: completedOperation.id,
      message: "durably admitted"
    });
    const queueItemId = enqueueRecoveryQueueItem(
      fixture.store,
      worker.sessionId!,
      worker.sessionGeneration!,
      completedOperation.id,
      "durably admitted"
    );
    fixture.store.completeDeferredEffectOperation(
      completedOperation.id,
      completedOperation.bodyHash,
      () => ({ queueItemId, runId: "run:dispatch-recovery-completed" })
    );
    const unknownOperation = fixture.store.claimDeferredEffectOperation({
      id: "dispatch-recovery-unknown",
      kind: "service_send_input",
      body: { workerId: worker.id, message: "outcome unknown" }
    }).operation;
    const uncertain = fixture.store.createCollaborationDispatch({
      id: "dispatch:recovery-unknown",
      goalId: goal.id,
      workerId: worker.id,
      callerLeadSessionId: fixture.leadSessionId,
      expectedWorkerRevision: worker.revision,
      expectedSessionGeneration: worker.sessionGeneration!,
      operationId: unknownOperation.id,
      message: "outcome unknown"
    });
    await fixture.manager.close();

    const recovered = new CollaborationGoalManager({
      store: fixture.store,
      sessionHost: fixture.host,
      readSettings: () => DEFAULT_COLLABORATION_SETTINGS
    });
    fixture.managers.push(recovered);
    await recovered.initialize();
    expect(fixture.store.getCollaborationDispatch(proven.id)).toMatchObject({
      status: "queued",
      queueItemId
    });
    expect(fixture.store.getCollaborationDispatch(uncertain.id)).toMatchObject({
      status: "dispatch_unknown"
    });
    expect(fixture.store.getCollaborationDispatch(uncertain.id).queueItemId).toBeUndefined();
    expect(fixture.store.getOperation(unknownOperation.id).status).toBe("started");
  });
});

async function createFixture(settings = DEFAULT_COLLABORATION_SETTINGS) {
  const directory = mkdtempSync(join(tmpdir(), "joko-collaboration-goal-"));
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
    displayName: "Collaboration target",
    workspaceRoot: directory,
    managed: true,
    trusted: true
  });
  const connection = store.createConnection({
    id: "collaboration-test-connection",
    name: "Collaboration test",
    authKeyDigest: "digest"
  });
  const leadSessionId = (await host.createSession({
    operationId: "create-collaboration-lead",
    connection,
    targetId: "target-one",
    title: "Lead",
    fastMode: false,
    permissionMode: "ask",
    planMode: false
  })).value.sessionId;
  const leadGeneration = store.getSession(leadSessionId).descriptor.binding.generation;
  const manager = new CollaborationGoalManager({ store, sessionHost: host, readSettings: () => settings });
  await manager.initialize();
  const managers = [manager];
  cleanups.push(async () => {
    for (const current of [...managers].reverse()) await current.close().catch(() => undefined);
    await host.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, host, manager, managers, leadSessionId, leadGeneration };
}

function workerInput(
  goalId: string,
  expectedGoalRevision: bigint,
  callerLeadSessionId: string,
  input: {
    readonly operationId: string;
    readonly label: string;
    readonly role: string;
    readonly assignment: string;
  }
) {
  return {
    ...input,
    goalId,
    callerLeadSessionId,
    expectedGoalRevision,
    route: {
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask" as const,
      planMode: false
    }
  };
}

function serviceOperationIdForTest(seed: string, kind: string): string {
  return `${kind}:${createHash("sha256").update(seed).digest("hex")}`;
}

function enqueueRecoveryQueueItem(
  store: OperationalStore,
  sessionId: string,
  generation: number,
  operationId: string,
  message: string
): string {
  const suffix = operationId.replace(/[^a-z0-9]+/giu, "-");
  const runId = `run:${suffix}`;
  const attemptId = `attempt:${suffix}`;
  const queueItemId = `queue:${suffix}`;
  store.createRun({ id: runId, sessionId, source: "system", state: "queued", createdAt: Date.now() }, { operationId });
  store.createAttempt({ id: attemptId, runId, ordinal: 1, generation, startedAt: Date.now() });
  const body = {
    text: message,
    images: [] as const,
    files: [] as const,
    mentions: [] as const,
    disposition: "prompt" as const
  };
  store.enqueueQueueItem({
    id: queueItemId,
    sessionId,
    runId,
    attemptId,
    operationId,
    disposition: "prompt",
    body,
    bodyHash: operationBodyHash(body),
    createdAt: Date.now()
  });
  return queueItemId;
}
