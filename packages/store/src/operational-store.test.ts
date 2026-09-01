import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  JokoError,
  type BackendDescriptor,
  type SubagentRunDetail,
  type SubagentTranscriptEntry
} from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActiveWriterError,
  AuthorizationError,
  InvalidStateTransitionError,
  OperationalStore,
  OperationConflictError,
  OperationInProgressError,
  OperationPreviouslyFailedError,
  RevisionConflictError,
  SCHEMA_BASELINE_ID,
  SCHEMA_VERSION,
  StaleGenerationError,
  StoreError
} from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("OperationalStore", () => {
  it("atomically installs a verified maintenance copy and preserves the prior database as the latest backup", async () => {
    const fixture = createFixture();
    const expectedRevision = fixture.store.health().revision;
    const workingPath = `${fixture.store.filePath}.history-maintenance.work`;
    await expect(fixture.store.createHistoryMaintenanceCopy({ workingPath, expectedRevision })).resolves.toBe(true);

    const working = new DatabaseSync(workingPath);
    working.prepare("UPDATE product_sessions SET title = ? WHERE id = ?").run("Compacted session", "session-1");
    working.close();

    const installed = fixture.store.installHistoryMaintenanceCopy({
      workingPath,
      expectedRevision,
      backupEnabled: true
    });
    expect(installed).toEqual({
      backupCreated: true,
      backupPath: `${fixture.store.filePath}.history-backup`
    });
    expect(fixture.store.getSession("session-1").descriptor.title).toBe("Compacted session");
    expect(fixture.store.health()).toMatchObject({ foreignKeys: true });

    const backup = new DatabaseSync(`${fixture.store.filePath}.history-backup`, { readOnly: true });
    expect(backup.prepare("SELECT title FROM product_sessions WHERE id = ?").get("session-1"))
      .toMatchObject({ title: "Session" });
    backup.close();
  });

  it("rejects a maintenance replacement after a concurrent durable write", async () => {
    const fixture = createFixture();
    const expectedRevision = fixture.store.health().revision;
    const workingPath = `${fixture.store.filePath}.history-maintenance.work`;
    await expect(fixture.store.createHistoryMaintenanceCopy({ workingPath, expectedRevision })).resolves.toBe(true);
    const session = fixture.store.getSession("session-1");
    fixture.store.updateSession("session-1", { title: "Concurrent title" }, session.revision);

    expect(() => fixture.store.installHistoryMaintenanceCopy({
      workingPath,
      expectedRevision,
      backupEnabled: false
    })).toThrow(/changed while the history maintenance copy/u);
    expect(fixture.store.getSession("session-1").descriptor.title).toBe("Concurrent title");
  });

  it("finishes an interrupted verified swap on startup and retains the rollback database as backup", async () => {
    const fixture = createFixture();
    const filePath = fixture.store.filePath;
    const expectedRevision = fixture.store.health().revision;
    const workingPath = `${filePath}.history-maintenance.work`;
    await expect(fixture.store.createHistoryMaintenanceCopy({ workingPath, expectedRevision })).resolves.toBe(true);
    const working = new DatabaseSync(workingPath);
    working.prepare("UPDATE product_sessions SET title = ? WHERE id = ?").run("Recovered replacement", "session-1");
    working.close();
    fixture.store.close();

    renameSync(filePath, `${filePath}.history-maintenance.rollback`);
    renameSync(workingPath, filePath);
    writeFileSync(`${filePath}.history-maintenance.json`, `${JSON.stringify({
      version: 1,
      backupEnabled: true,
      preparedAt: Date.now()
    })}\n`, "utf8");

    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.getSession("session-1").descriptor.title).toBe("Recovered replacement");
    expect(existsSync(`${filePath}.history-maintenance.json`)).toBe(false);
    expect(existsSync(`${filePath}.history-maintenance.rollback`)).toBe(false);
    expect(existsSync(`${filePath}.history-backup`)).toBe(true);
    const backup = new DatabaseSync(`${filePath}.history-backup`, { readOnly: true });
    expect(backup.prepare("SELECT title FROM product_sessions WHERE id = ?").get("session-1"))
      .toMatchObject({ title: "Session" });
    backup.close();
  });

  it("persists one fenced Objective across restart and follows the Session generation", () => {
    const fixture = createFixture();
    const created = fixture.store.putObjective({
      sessionId: "session-1",
      text: "  Finish every durable stage.  ",
      tokenBudget: 12_345,
      maximumTurns: 25,
      noProgressTurnLimit: 3,
      expectedSessionGeneration: 0,
      updatedAt: 10
    });

    expect(created).toMatchObject({
      sessionId: "session-1",
      text: "Finish every durable stage.",
      status: "active",
      tokenBudget: 12_345,
      maximumTurns: 25,
      noProgressTurnLimit: 3,
      turnsUsed: 0,
      tokensUsed: 0,
      noProgressTurns: 0,
      dispatchRejections: 0,
      ownerGeneration: 1,
      sessionGeneration: 0,
      startedAt: 10,
      updatedAt: 10
    });

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.getObjective("session-1")).toEqual(created);

    const session = reopened.getSession("session-1");
    reopened.updateSession("session-1", {
      binding: { ...session.descriptor.binding, generation: 1 }
    }, session.revision, 11);
    expect(reopened.getObjective("session-1")).toMatchObject({
      ownerGeneration: 1,
      sessionGeneration: 1,
      updatedAt: 11
    });
    expect(() => reopened.putObjective({
      sessionId: "session-1",
      text: "Stale replacement",
      expectedSessionGeneration: 0
    })).toThrow(StaleGenerationError);
  });

  it("fences Objective mutations by revision and owner generation", () => {
    const { store } = createFixture();
    const created = store.putObjective({
      sessionId: "session-1",
      text: "First objective",
      updatedAt: 10
    });

    expect(() => store.updateObjective({
      sessionId: created.sessionId,
      expectedRevision: created.revision - 1n,
      expectedOwnerGeneration: created.ownerGeneration,
      status: "paused"
    })).toThrow(RevisionConflictError);

    const paused = store.updateObjective({
      sessionId: created.sessionId,
      expectedRevision: created.revision,
      expectedOwnerGeneration: created.ownerGeneration,
      status: "paused",
      lastReason: "User requested a pause.",
      turnsUsed: 4,
      tokensUsed: 900,
      noProgressTurns: 2,
      advanceOwnerGeneration: true,
      updatedAt: 11
    });
    expect(paused).toMatchObject({
      status: "paused",
      lastReason: "User requested a pause.",
      turnsUsed: 4,
      tokensUsed: 900,
      noProgressTurns: 2,
      ownerGeneration: 2
    });
    expect(() => store.updateObjective({
      sessionId: paused.sessionId,
      expectedRevision: paused.revision,
      expectedOwnerGeneration: created.ownerGeneration,
      status: "active"
    })).toThrow(StaleGenerationError);

    const replacement = store.putObjective({
      sessionId: paused.sessionId,
      text: "Replacement objective",
      maximumTurns: 5,
      updatedAt: 12
    });
    expect(replacement).toMatchObject({
      text: "Replacement objective",
      status: "active",
      maximumTurns: 5,
      turnsUsed: 0,
      tokensUsed: 0,
      noProgressTurns: 0,
      dispatchRejections: 0,
      ownerGeneration: 3,
      startedAt: 12
    });
    expect(replacement.lastReason).toBeUndefined();

    expect(() => store.clearObjective({
      sessionId: replacement.sessionId,
      expectedRevision: paused.revision,
      expectedOwnerGeneration: replacement.ownerGeneration
    })).toThrow(RevisionConflictError);
    expect(store.clearObjective({
      sessionId: replacement.sessionId,
      expectedRevision: replacement.revision,
      expectedOwnerGeneration: replacement.ownerGeneration
    })).toEqual(replacement);
    expect(store.findObjective(replacement.sessionId)).toBeUndefined();
  });

  it("persists one isolated workspace binding per Session and updates only its lifecycle state", () => {
    const { store } = createFixture();
    const source = store.getSession("session-1").descriptor;
    const worktree = {
      leaseId: "lease-isolated-1",
      workspaceId: "workspace-isolated-1",
      path: "D:/managed/worktrees/slot-1",
      repositoryRoot: "D:/projects/example",
      branch: "joko/ephemeral/0123456789ab-01234567",
      sourceRef: "refs/heads/main",
      sourceCommit: "a".repeat(40),
      sourceStrategy: "current_branch" as const,
      sourceRefreshed: false,
      state: "active" as const,
      acquiredAt: 3,
      updatedAt: 3
    };
    const created = store.createSession({
      ...source,
      id: "session-isolated",
      binding: { opaqueRef: "native/isolated.jsonl", generation: 0 },
      worktree,
      createdAt: 3,
      updatedAt: 3
    });

    expect(created.descriptor.worktree).toEqual(worktree);
    expect(store.listSessions({ includeArchived: true }).find((item) => item.descriptor.id === created.descriptor.id)
      ?.descriptor.worktree).toEqual(worktree);
    expect(store.findSessionWorktree(created.descriptor.id)).toEqual(worktree);
    expect(store.updateSessionWorktreeState(created.descriptor.id, "preserved", 4)).toEqual({
      ...worktree,
      state: "preserved",
      updatedAt: 4
    });
    expect(store.getSession(created.descriptor.id).descriptor.worktree?.state).toBe("preserved");

    expect(() => store.createSession({
      ...source,
      id: "session-isolated-duplicate-workspace",
      binding: { opaqueRef: "native/isolated-duplicate.jsonl", generation: 0 },
      worktree: { ...worktree, leaseId: "lease-isolated-2" },
      createdAt: 5,
      updatedAt: 5
    })).toThrow();
  });

  it("round-trips the private Session append prompt and rejects oversized values", () => {
    const { store } = createFixture();
    const source = store.getSession("session-1").descriptor;
    const prompt = "Prefer terse explanations and preserve repository conventions.";
    const stored = store.createSession({
      ...source,
      id: "session-personalized",
      title: "Personalized",
      binding: { opaqueRef: "native/personalized.jsonl", generation: 0 },
      appendSystemPrompt: prompt,
      createdAt: 3,
      updatedAt: 3
    });

    expect(stored.descriptor.appendSystemPrompt).toBe(prompt);
    expect(store.getSession(stored.descriptor.id).descriptor.appendSystemPrompt).toBe(prompt);
    expect(() => store.createSession({
      ...source,
      id: "session-prompt-too-long",
      binding: { opaqueRef: "native/too-long.jsonl", generation: 0 },
      appendSystemPrompt: "x".repeat(8_001)
    })).toThrow(StoreError);
    expect(() => store.createSession({
      ...source,
      id: "session-prompt-nul",
      binding: { opaqueRef: "native/nul.jsonl", generation: 0 },
      appendSystemPrompt: "valid prefix\0invalid suffix"
    })).toThrow(StoreError);
  });

  it("persists a capability-neutral derivation origin and resolves its visible message anchor after restart", () => {
    const fixture = createFixture();
    fixture.store.appendEvent({
      id: "source-message-event",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 0,
      traceId: "derivation:source",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "Durable source" }]
      }
    });
    const source = fixture.store.getSession("session-1").descriptor;
    fixture.store.createSession({
      ...source,
      id: "session-derived",
      title: "Derived",
      binding: { opaqueRef: "native/derived.jsonl", generation: 0 },
      derivationOrigin: {
        kind: "fork",
        sourceSessionId: source.id,
        sourceMessageId: "source-message-event",
        sourceEventId: "source-message-event"
      },
      createdAt: 3,
      updatedAt: 3
    });

    expect(fixture.store.findVisibleSessionMessageOrigin({
      sessionId: source.id,
      eventId: "source-message-event"
    })).toEqual({ messageId: "source-message-event", eventId: "source-message-event" });

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.getSession("session-derived").descriptor.derivationOrigin).toEqual({
      kind: "fork",
      sourceSessionId: "session-1",
      sourceMessageId: "source-message-event",
      sourceEventId: "source-message-event"
    });
    expect(reopened.findVisibleSessionMessageOrigin({
      sessionId: "session-1",
      eventId: "source-message-event"
    })).toEqual({ messageId: "source-message-event", eventId: "source-message-event" });
  });

  it("persists Scheduler task ownership and clears it when the Schedule incarnation is deleted", () => {
    const { store, prompt } = createFixture();
    const scheduleInput = {
      id: "schedule-origin",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh" as const,
      name: "Nightly",
      kind: "manual" as const,
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: { permissionMode: "ask" as const },
      overlapPolicy: "queue" as const,
      misfirePolicy: "run_once" as const
    };
    const schedule = store.upsertSchedule(scheduleInput);
    const source = store.getSession("session-1").descriptor;
    const scheduled = store.createSession({
      ...source,
      id: "session-scheduled",
      title: "Nightly",
      binding: { opaqueRef: "native/scheduled.jsonl", generation: 0 },
      automationOrigin: {
        kind: "scheduler",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "run-origin"
      },
      createdAt: 3,
      updatedAt: 3
    });
    expect(store.getSession(scheduled.descriptor.id).descriptor.automationOrigin).toEqual({
      kind: "scheduler",
      scheduleId: "schedule-origin",
      scheduleName: "Nightly",
      runId: "run-origin"
    });

    store.deleteSchedule(schedule.id, schedule.revision);
    expect(store.getSession(scheduled.descriptor.id).descriptor.automationOrigin).toBeUndefined();
    expect(store.listEvents({ sessionId: scheduled.descriptor.id }).at(-1)?.payload).toEqual({ type: "session_changed" });

    store.upsertSchedule(scheduleInput);
    expect(store.getSession(scheduled.descriptor.id).descriptor.automationOrigin).toBeUndefined();
  });

  it("does not expose a service-owned continuation as a visible message origin", () => {
    const { store } = createFixture();
    store.appendEvent({
      id: "internal-continuation-origin",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 0,
      traceId: "recovery:internal-origin",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "Continue" }],
        automaticContinuation: { recoveryId: "recovery-origin" }
      }
    });

    expect(store.findVisibleSessionMessageOrigin({
      sessionId: "session-1",
      eventId: "internal-continuation-origin"
    })).toBeUndefined();
  });

  it("builds Schedule deletion ownership only from automation origin, never a history primary task", () => {
    const { store, prompt } = createFixture();
    const schedule = store.upsertSchedule({
      id: "schedule-delete-owner",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh",
      name: "Owned generated tasks",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: { permissionMode: "ask" },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const source = store.getSession("session-1").descriptor;
    const generated = store.createSession({
      ...source,
      id: "session-generated-owner",
      title: "Generated",
      binding: { opaqueRef: "native/generated-owner.jsonl", generation: 0 },
      automationOrigin: {
        kind: "scheduler",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "generated-owner-run"
      },
      createdAt: 4,
      updatedAt: 4
    });
    // A script may report a pre-existing user task as its primary result. The
    // history link remains navigation metadata and never becomes ownership.
    store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: "script-primary-existing",
      sessionId: "session-1",
      firedAt: 5,
      finishedAt: 6,
      status: "success",
      detail: { costAttribution: "zero" }
    });
    store.runOperation(
      { id: "queued-before-delete", kind: "test_enqueue", body: { sessionId: generated.descriptor.id } },
      (target) => {
        target.createRun({
          id: "run-before-delete",
          sessionId: generated.descriptor.id,
          source: "user",
          state: "queued",
          createdAt: 6
        });
        target.createAttempt({
          id: "attempt-before-delete",
          runId: "run-before-delete",
          ordinal: 1,
          generation: generated.descriptor.binding.generation,
          startedAt: 6
        });
        target.enqueueQueueItem({
          id: "queue-before-delete",
          sessionId: generated.descriptor.id,
          runId: "run-before-delete",
          attemptId: "attempt-before-delete",
          operationId: "queued-before-delete",
          disposition: "prompt",
          body: { text: "do not dispatch", images: [], files: [], mentions: [], disposition: "prompt" },
          createdAt: 6
        });
        return { accepted: true };
      }
    );

    const manifest = store.prepareScheduleDeletionCleanup({
      operationId: "delete-owner-operation",
      scheduleId: schedule.id,
      disposition: "delete",
      occurrenceRunIds: ["inflight-owner-run"],
      at: 7
    });

    expect(manifest.generatedSessionIds).toEqual([generated.descriptor.id]);
    expect(manifest.generatedSessionIds).not.toContain("session-1");
    expect(manifest.occurrenceRunIds).toEqual(["inflight-owner-run"]);
    expect(manifest.inflightCount).toBe(1);
    expect(store.getQueueItem("queue-before-delete").state).toBe("cancelled");
    expect(store.getRun("run-before-delete").descriptor.state).toBe("aborted");
    expect(store.claimNextQueueItem({
      sessionId: generated.descriptor.id,
      backendInstanceGeneration: 0
    })).toBeUndefined();
    expect(() => store.createRun({
      id: "run-during-delete",
      sessionId: generated.descriptor.id,
      source: "user",
      state: "queued",
      createdAt: 8
    })).toThrow(/deletion is in progress/u);
    expect(() => store.upsertSchedule({
      ...schedule,
      name: "Concurrent update",
      expectedRevision: store.getSchedule(schedule.id).revision,
      now: 8
    })).toThrow(/deletion is in progress/u);
    expect(() => store.deleteSchedule(schedule.id, store.getSchedule(schedule.id).revision))
      .toThrow(/deletion is in progress/u);

    const pending = store.finalizeScheduleDeletionCleanup({
      operationId: manifest.operationId,
      completedSessionIds: [],
      failures: [{ sessionId: generated.descriptor.id, message: "workspace release failed" }],
      at: 9
    });
    expect(pending.state).toBe("pending");
    expect(store.findSchedule(schedule.id)).toBeDefined();
    expect(store.getSession(generated.descriptor.id).descriptor.automationOrigin?.scheduleId).toBe(schedule.id);

    const completed = store.finalizeScheduleDeletionCleanup({
      operationId: manifest.operationId,
      completedSessionIds: manifest.generatedSessionIds,
      failures: [],
      at: 10
    });
    expect(completed.state).toBe("completed");
    expect(store.findSchedule(schedule.id)).toBeUndefined();
    expect(store.getSession("session-1").descriptor.deletedAt).toBeUndefined();
    expect(store.getSession(generated.descriptor.id).descriptor.deletedAt).toBe(10);
  });

  it("rejects an ordinary lifecycle manifest after destructive Schedule cleanup owns the task", () => {
    const { store, prompt } = createFixture();
    const schedule = store.upsertSchedule({
      id: "schedule-lifecycle-owner-first",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh",
      name: "Schedule owns cleanup",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: {},
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const generated = store.createSession({
      ...store.getSession("session-1").descriptor,
      id: "session-schedule-lifecycle-owner-first",
      binding: { opaqueRef: "native/schedule-owner-first.jsonl", generation: 0 },
      automationOrigin: {
        kind: "scheduler",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "schedule-owner-first-run"
      },
      createdAt: 5,
      updatedAt: 5
    });
    const manifest = store.prepareScheduleDeletionCleanup({
      operationId: "schedule-owner-first-operation",
      scheduleId: schedule.id,
      disposition: "archive",
      at: 6
    });

    expect(() => store.prepareSessionLifecycleCleanup({
      operationId: "ordinary-owner-second-operation",
      sessionId: generated.descriptor.id,
      disposition: "delete",
      at: 7
    })).toThrow(OperationInProgressError);
    expect(store.findPendingSessionLifecycleCleanup(generated.descriptor.id)).toBeUndefined();
    expect(store.getScheduleDeletionCleanup(manifest.operationId).state).toBe("pending");
  });

  it("rejects destructive Schedule cleanup after an ordinary lifecycle manifest while keep remains independent", () => {
    const { store, prompt } = createFixture();
    const schedule = store.upsertSchedule({
      id: "ordinary-lifecycle-owner-first",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh",
      name: "Ordinary lifecycle owns cleanup",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: {},
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const generated = store.createSession({
      ...store.getSession("session-1").descriptor,
      id: "session-ordinary-lifecycle-owner-first",
      binding: { opaqueRef: "native/ordinary-owner-first.jsonl", generation: 0 },
      automationOrigin: {
        kind: "scheduler",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "ordinary-owner-first-run"
      },
      createdAt: 5,
      updatedAt: 5
    });
    store.prepareSessionLifecycleCleanup({
      operationId: "ordinary-owner-first-operation",
      sessionId: generated.descriptor.id,
      disposition: "archive",
      at: 6
    });

    expect(() => store.prepareScheduleDeletionCleanup({
      operationId: "schedule-owner-second-operation",
      scheduleId: schedule.id,
      disposition: "delete",
      at: 7
    })).toThrow(OperationInProgressError);
    expect(store.findScheduleDeletionCleanup("schedule-owner-second-operation")).toBeUndefined();

    const keep = store.prepareScheduleDeletionCleanup({
      operationId: "schedule-keep-independent-operation",
      scheduleId: schedule.id,
      disposition: "keep",
      at: 8
    });
    expect(keep).toMatchObject({ state: "pending", disposition: "keep" });
    expect(store.findPendingScheduleDeletionCleanupForSession(generated.descriptor.id)).toBeUndefined();
  });

  it("repairs a failed claimed deletion operation from its authorized durable manifest", () => {
    const { store, prompt } = createFixture();
    const schedule = store.upsertSchedule({
      id: "schedule-delete-recovery",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh",
      name: "Recover deletion",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: {},
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const connection = store.createConnection({
      id: "schedule-delete-recovery-connection",
      name: "Recovery client",
      authKeyDigest: "schedule-delete-recovery-digest"
    });
    const generated = store.createSession({
      ...store.getSession("session-1").descriptor,
      id: "session-keep-during-delete",
      title: "Kept generated task",
      binding: { opaqueRef: "native/kept-generated.jsonl", generation: 0 },
      automationOrigin: {
        kind: "scheduler",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "kept-generated-origin"
      },
      createdAt: 9,
      updatedAt: 9
    });
    const body = { scheduleId: schedule.id, generatedSessionDisposition: "keep" };
    const claim = store.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      { id: "schedule-delete-recovery-operation", kind: "deleteSchedule", body }
    );
    expect(claim.claimed).toBe(true);
    const manifest = store.prepareScheduleDeletionCleanup({
      operationId: claim.operation.id,
      scheduleId: schedule.id,
      disposition: "keep",
      at: 10
    });
    const admitted = store.runOperation(
      { id: "send-kept-generated", kind: "test_enqueue", body: { sessionId: generated.descriptor.id } },
      (target) => {
        target.createRun({
          id: "run-kept-generated",
          sessionId: generated.descriptor.id,
          source: "user",
          state: "queued",
          createdAt: 10
        });
        target.createAttempt({
          id: "attempt-kept-generated",
          runId: "run-kept-generated",
          ordinal: 1,
          generation: generated.descriptor.binding.generation,
          startedAt: 10
        });
        target.enqueueQueueItem({
          id: "queue-kept-generated",
          sessionId: generated.descriptor.id,
          runId: "run-kept-generated",
          attemptId: "attempt-kept-generated",
          operationId: "send-kept-generated",
          disposition: "prompt",
          body: { text: "keep remains usable", images: [], files: [], mentions: [], disposition: "prompt" },
          createdAt: 10
        });
        return { accepted: true };
      }
    );
    expect(admitted.value).toEqual({ accepted: true });
    expect(store.claimNextQueueItem({
      sessionId: generated.descriptor.id,
      backendInstanceGeneration: 0
    })?.id).toBe("queue-kept-generated");
    store.failEffectOperation(claim.operation.id, claim.operation.bodyHash, new Error("temporary cleanup failure"));
    expect(store.getOperation(claim.operation.id).status).toBe("failed");

    const response = {
      accepted: true,
      resultCase: "scheduleDeletion",
      scheduleDeletion: {
        scheduleId: schedule.id,
        disposition: "keep",
        generatedSessionIds: [],
        completedSessionIds: [],
        failures: [],
        inflightCount: 0
      }
    };
    expect(store.finalizeScheduleDeletionCleanup({
      operationId: manifest.operationId,
      completedSessionIds: [],
      failures: [],
      recoveredOperationResponse: response,
      at: 11
    }).state).toBe("completed");
    expect(store.getOperation(claim.operation.id)).toMatchObject({
      status: "completed",
      response
    });
  });

  it("keeps a claimed task lifecycle operation recoverable and fenced across restart", () => {
    const fixture = createFixture();
    const connection = fixture.store.createConnection({
      id: "session-lifecycle-recovery-connection",
      name: "Lifecycle recovery client",
      authKeyDigest: "session-lifecycle-recovery-digest"
    });
    const body = {
      sessionId: "session-1",
      deleteNativeSession: true,
      deleteArtifacts: true
    };
    const claim = fixture.store.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      { id: "session-lifecycle-recovery-operation", kind: "deleteSession", body }
    );
    expect(claim.claimed).toBe(true);
    const pending = fixture.store.prepareSessionLifecycleCleanup({
      operationId: claim.operation.id,
      sessionId: "session-1",
      disposition: "delete",
      deleteNativeSession: true,
      deleteArtifacts: true,
      releaseWorktree: true,
      cleanupGitSafety: true,
      at: 10
    });

    expect(pending).toMatchObject({
      state: "pending",
      closeCompleted: false,
      nativeCompleted: false,
      worktreeCompleted: false,
      gitSafetyCompleted: false
    });
    expect(fixture.store.getRun("run-1").descriptor.state).toBe("aborted");
    expect(() => fixture.store.createRun({
      id: "run-during-session-delete",
      sessionId: "session-1",
      source: "user",
      state: "queued",
      createdAt: 11
    })).toThrow(/lifecycle transition is in progress/u);

    fixture.store.advanceSessionLifecycleCleanup({
      operationId: claim.operation.id,
      phase: "close",
      at: 12
    });
    fixture.store.advanceSessionLifecycleCleanup({
      operationId: claim.operation.id,
      phase: "native",
      at: 13
    });
    fixture.store.recordSessionLifecycleCleanupFailure({
      operationId: claim.operation.id,
      message: "workspace release was interrupted",
      at: 14
    });

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.recoverStartup("recover-session-lifecycle").recoveredEffectOperationIds).not.toContain(
      claim.operation.id
    );
    expect(reopened.getOperation(claim.operation.id).status).toBe("started");
    expect(reopened.findPendingSessionLifecycleCleanup("session-1")).toMatchObject({
      operationId: claim.operation.id,
      closeCompleted: true,
      nativeCompleted: true,
      worktreeCompleted: false,
      gitSafetyCompleted: false,
      failure: "workspace release was interrupted"
    });
    expect(() => reopened.createRun({
      id: "run-after-session-delete-restart",
      sessionId: "session-1",
      source: "user",
      state: "queued",
      createdAt: 15
    })).toThrow(/lifecycle transition is in progress/u);

    reopened.advanceSessionLifecycleCleanup({
      operationId: claim.operation.id,
      phase: "worktree",
      at: 16
    });
    reopened.advanceSessionLifecycleCleanup({
      operationId: claim.operation.id,
      phase: "git_safety",
      at: 17
    });
    const response = { accepted: true, resultCase: "session", entityId: "session-1" };
    const completed = reopened.finalizeSessionLifecycleCleanup({
      operationId: claim.operation.id,
      recoveredOperationResponse: response,
      at: 18
    });
    expect(completed.state).toBe("completed");
    expect(completed.failure).toBeUndefined();
    expect(reopened.getSession("session-1").descriptor).toMatchObject({ archived: true, deletedAt: 18 });
    expect(reopened.getOperation(claim.operation.id)).toMatchObject({ status: "completed", response });
  });

  it("advances repeated done attention so a stale acknowledgement cannot clear the newer completion", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    const appendDone = (traceId: string) => store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId,
      payload: { type: "done", outcome: "completed" }
    });

    const firstSource = appendDone("done:first");
    const first = store.getSessionAttention(route.id);
    expect(first).toMatchObject({ kind: "done", unread: true, attentionCursor: firstSource.globalCursor });

    const secondSource = appendDone("done:second");
    const second = store.getSessionAttention(route.id);
    expect(second).toMatchObject({ kind: "done", unread: true, attentionCursor: secondSource.globalCursor });
    expect(second.attentionCursor).toBeGreaterThan(first.attentionCursor);

    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: first.attentionCursor,
      generation: first.attentionGeneration,
      intent: "viewed",
      traceId: "ack:stale"
    })).toThrow(RevisionConflictError);
    expect(store.getSessionAttention(route.id)).toMatchObject({
      unread: true,
      attentionCursor: second.attentionCursor
    });
    const changed = store.listEvents({ sessionId: route.id, limit: 10_000 })
      .findLast((event) => event.payload.type === "session_attention");
    expect(changed?.emittedAt).toBe(second.updatedAt);
  });

  it("advances repeated awaiting attention so the first viewer receipt cannot clear the second", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.createRun({ id: "run-waiting-first", sessionId: route.id, source: "user", state: "waiting", createdAt: 1_000 });
    const first = store.getSessionAttention(route.id);
    store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: first.attentionCursor,
      generation: first.attentionGeneration,
      intent: "viewed",
      traceId: "ack:waiting-first"
    });

    store.createRun({ id: "run-waiting-second", sessionId: route.id, source: "user", state: "waiting", createdAt: 2_000 });
    const second = store.getSessionAttention(route.id);
    expect(second).toMatchObject({ kind: "awaiting", unread: true });
    expect(second.attentionCursor).toBeGreaterThan(first.attentionCursor);
    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: first.attentionCursor,
      generation: first.attentionGeneration,
      intent: "viewed",
      traceId: "ack:waiting-stale"
    })).toThrow(RevisionConflictError);
    expect(store.getSessionAttention(route.id)).toEqual(second);
  });

  it.each([
    { label: "unread", acknowledgeBeforeProgress: false },
    { label: "already-read", acknowledgeBeforeProgress: true }
  ])("advances $label lifecycle clears and rejects late older attention", ({ acknowledgeBeforeProgress }) => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    const doneSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "done:before-progress",
      payload: { type: "done", outcome: "completed" }
    });
    const done = store.getSessionAttention(route.id);
    if (acknowledgeBeforeProgress) {
      store.acknowledgeSessionAttention({
        sessionId: route.id,
        throughCursor: done.attentionCursor,
        generation: done.attentionGeneration,
        intent: "viewed",
        traceId: "ack:before-progress"
      });
    }
    const lateSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "late:durable-source",
      payload: { type: "status", key: "late-source" }
    });
    store.createRun({
      id: `run-progress-${acknowledgeBeforeProgress ? "read" : "unread"}`,
      sessionId: route.id,
      source: "user",
      state: "running",
      createdAt: Date.now()
    });
    const cleared = store.getSessionAttention(route.id);
    expect(cleared.unread).toBe(false);
    expect(cleared.attentionCursor).toBeGreaterThan(lateSource.globalCursor);
    expect(cleared.readThroughCursor).toBe(cleared.attentionCursor);
    expect(cleared.attentionGeneration).toBe(route.binding.generation);
    expect(cleared.readThroughGeneration).toBe(route.binding.generation);

    const eventCount = store.listEvents({ sessionId: route.id, limit: 10_000 }).length;
    const afterLateRecord = store.recordSessionAttention({
      sessionId: route.id,
      kind: "error",
      sourceCursor: lateSource.globalCursor,
      traceId: "late:attention"
    });
    expect(afterLateRecord).toEqual(cleared);
    expect(store.listEvents({ sessionId: route.id, limit: 10_000 })).toHaveLength(eventCount);
    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: doneSource.globalCursor,
      generation: route.binding.generation,
      intent: "viewed",
      traceId: "ack:old-after-progress"
    })).toThrow(RevisionConflictError);
  });

  it("rejects an old durable attention source after a native binding reset", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    const oldSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "attention:old-durable-source",
      payload: { type: "status", key: "old-durable-source" }
    });

    store.runOperation(
      { id: "operation:attention-reset", kind: "reset", body: { sessionId: route.id } },
      (transaction) => {
        transaction.commitSessionReset({
          sessionId: route.id,
          sourceBinding: route.binding,
          binding: {
            opaqueRef: "native/reset-attention.jsonl",
            nativeSessionId: "native-reset-attention",
            generation: route.binding.generation + 1
          },
          operationId: "operation:attention-reset",
          traceId: "attention:reset"
        });
        return { reset: true };
      }
    );

    expect(store.findSessionAttention(route.id)).toBeUndefined();
    expect(() => store.recordSessionAttention({
      sessionId: route.id,
      kind: "done",
      sourceCursor: oldSource.globalCursor,
      traceId: "attention:late-old-generation"
    })).toThrow(StaleGenerationError);
    expect(store.findSessionAttention(route.id)).toBeUndefined();
  });

  it("advances an acknowledged awaiting fence when its interaction settles", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "interaction:open-attention",
      payload: {
        id: "interaction-attention",
        kind: "question",
        title: "Choose",
        prompt: "Continue?",
        fields: [{
          id: "answer",
          label: "Choose",
          required: true,
          kind: "single",
          choices: [{ id: "yes", label: "Yes" }]
        }]
      }
    });
    const awaiting = store.getSessionAttention(route.id);
    const acknowledged = store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: awaiting.attentionCursor,
      generation: awaiting.attentionGeneration,
      intent: "viewed",
      traceId: "interaction:ack-awaiting"
    });
    expect(acknowledged).toMatchObject({ kind: "awaiting", unread: false });
    const lateSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "interaction:late-source",
      payload: { type: "status", key: "late-awaiting-source" }
    });

    store.resolveInteraction(
      "interaction-attention",
      route.binding.generation,
      { option: "yes" },
      "interaction:resolve-attention"
    );
    const cleared = store.getSessionAttention(route.id);
    expect(cleared).toMatchObject({ kind: "awaiting", unread: false });
    expect(cleared.attentionCursor).toBeGreaterThan(lateSource.globalCursor);
    expect(store.recordSessionAttention({
      sessionId: route.id,
      kind: "awaiting",
      sourceCursor: lateSource.globalCursor,
      traceId: "interaction:late-record"
    })).toEqual(cleared);
  });

  it.each([
    { outcome: "completed" as const, expectedKind: "awaiting" as const, clearsOnResolve: true },
    { outcome: "failed" as const, expectedKind: "error" as const, clearsOnResolve: false }
  ])("keeps interaction precedence across a $outcome terminal", ({ outcome, expectedKind, clearsOnResolve }) => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: `interaction:${outcome}:open`,
      payload: {
        id: `interaction-${outcome}`,
        kind: "question",
        title: "Choose",
        prompt: "Continue?",
        fields: [{
          id: "answer",
          label: "Choose",
          required: true,
          kind: "single",
          choices: [{ id: "yes", label: "Yes" }]
        }]
      }
    });
    store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: `interaction:${outcome}:terminal`,
      payload: { type: "done", outcome }
    });
    const terminalAttention = store.getSessionAttention(route.id);
    expect(terminalAttention).toMatchObject({ kind: expectedKind, unread: true });

    store.resolveInteraction(
      `interaction-${outcome}`,
      route.binding.generation,
      { option: "yes" },
      `interaction:${outcome}:resolve`
    );
    const settled = store.getSessionAttention(route.id);
    expect(settled.kind).toBe(expectedKind);
    expect(settled.unread).toBe(!clearsOnResolve);
    if (clearsOnResolve) expect(settled.attentionCursor).toBeGreaterThan(terminalAttention.attentionCursor);
    else {
      expect(settled.subjectCursor).toBe(terminalAttention.subjectCursor);
      expect(settled.attentionCursor).toBeGreaterThan(terminalAttention.attentionCursor);
    }
  });

  it("keeps unread error dominant over a newer interaction and reveals awaiting only after exact explicit acknowledgement", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    const errorSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:before-interaction",
      payload: { type: "error", error: publicTestError("terminal", "Failed"), terminal: true }
    });
    const beforeOpen = store.getSessionAttention(route.id);
    expect(beforeOpen.subjectCursor).toBe(errorSource.globalCursor);

    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:interaction-open",
      payload: questionInteraction("interaction-after-error")
    });
    const afterOpen = store.getSessionAttention(route.id);
    expect(afterOpen).toMatchObject({ kind: "error", unread: true, subjectCursor: errorSource.globalCursor });
    expect(afterOpen.attentionCursor).toBeGreaterThan(beforeOpen.attentionCursor);
    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: beforeOpen.attentionCursor,
      generation: beforeOpen.attentionGeneration,
      intent: "explicit",
      traceId: "error:stale-before-interaction"
    })).toThrow(RevisionConflictError);

    const awaiting = store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: afterOpen.attentionCursor,
      generation: afterOpen.attentionGeneration,
      intent: "explicit",
      traceId: "error:explicit-with-interaction"
    });
    const opening = store.listEvents({ sessionId: route.id, limit: 10_000 })
      .find((event) => event.payload.type === "interaction_opened" && event.payload.interaction.id === "interaction-after-error");
    expect(awaiting).toMatchObject({
      kind: "awaiting",
      unread: true,
      subjectCursor: opening?.globalCursor,
      readThroughCursor: afterOpen.attentionCursor
    });
    expect(awaiting.attentionCursor).toBeGreaterThan(afterOpen.attentionCursor);
  });

  it("keeps an acknowledged awaiting interaction read across a normal terminal fence", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "awaiting:open-before-terminal",
      payload: questionInteraction("interaction-read-before-terminal")
    });
    const awaiting = store.getSessionAttention(route.id);
    const read = store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: awaiting.attentionCursor,
      generation: awaiting.attentionGeneration,
      intent: "viewed",
      traceId: "awaiting:viewer-read"
    });
    const terminal = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "awaiting:normal-terminal",
      payload: { type: "done", outcome: "completed" }
    });
    const afterTerminal = store.getSessionAttention(route.id);
    expect(afterTerminal).toMatchObject({
      kind: "awaiting",
      unread: false,
      subjectCursor: read.subjectCursor,
      attentionCursor: terminal.globalCursor,
      readThroughCursor: terminal.globalCursor
    });
  });

  it("rebases awaiting subject to the latest interaction that remains open", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "awaiting:first-open",
      createdAt: 1_000,
      payload: questionInteraction("interaction-z-first")
    });
    const firstSource = store.getSessionAttention(route.id).subjectCursor;
    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "awaiting:second-open",
      createdAt: 1_000,
      payload: questionInteraction("interaction-a-second")
    });
    expect(store.getSessionAttention(route.id).subjectCursor).toBeGreaterThan(firstSource);

    store.resolveInteraction(
      "interaction-a-second",
      route.binding.generation,
      { option: "yes" },
      "awaiting:second-resolve"
    );
    const rebased = store.getSessionAttention(route.id);
    expect(rebased).toMatchObject({ kind: "awaiting", unread: true, subjectCursor: firstSource });
    expect(rebased.attentionCursor).toBeGreaterThan(rebased.subjectCursor);
  });

  it("treats awaiting as a pending rising edge across multiple open interactions", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "awaiting-edge:a-open",
      payload: questionInteraction("interaction-edge-a")
    });
    const first = store.getSessionAttention(route.id);
    const firstRead = store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: first.attentionCursor,
      generation: first.attentionGeneration,
      intent: "viewed",
      traceId: "awaiting-edge:a-read"
    });
    expect(firstRead).toMatchObject({ kind: "awaiting", unread: false });

    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "awaiting-edge:b-open",
      payload: questionInteraction("interaction-edge-b")
    });
    const secondRead = store.getSessionAttention(route.id);
    expect(secondRead).toMatchObject({ kind: "awaiting", unread: false });
    expect(secondRead.subjectCursor).toBeGreaterThan(firstRead.subjectCursor);
    expect(secondRead.readThroughCursor).toBe(secondRead.attentionCursor);

    store.resolveInteraction(
      "interaction-edge-b",
      route.binding.generation,
      { option: "yes" },
      "awaiting-edge:b-resolve"
    );
    const rebasedRead = store.getSessionAttention(route.id);
    expect(rebasedRead).toMatchObject({
      kind: "awaiting",
      unread: false,
      subjectCursor: first.subjectCursor,
      readThroughCursor: rebasedRead.attentionCursor
    });

    store.resolveInteraction(
      "interaction-edge-a",
      route.binding.generation,
      { option: "yes" },
      "awaiting-edge:a-resolve"
    );
    expect(store.getSessionAttention(route.id)).toMatchObject({ kind: "awaiting", unread: false });

    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "awaiting-edge:c-open",
      payload: questionInteraction("interaction-edge-c")
    });
    expect(store.getSessionAttention(route.id)).toMatchObject({ kind: "awaiting", unread: true });
  });

  it("keeps a resolved error subject durable when explicit acknowledgement has no open interaction", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    const errorSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:resolved-interaction:error",
      payload: { type: "error", error: publicTestError("terminal", "Failed"), terminal: true }
    });
    store.openInteraction({
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:resolved-interaction:open",
      payload: questionInteraction("interaction-resolved-before-error-ack")
    });
    const opened = store.getSessionAttention(route.id);
    const lateSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:resolved-interaction:late-source",
      payload: { type: "status", key: "late-before-resolve" }
    });
    store.resolveInteraction(
      "interaction-resolved-before-error-ack",
      route.binding.generation,
      { option: "yes" },
      "error:resolved-interaction:resolve"
    );
    const current = store.getSessionAttention(route.id);
    expect(current.attentionCursor).toBeGreaterThan(opened.attentionCursor);
    expect(current.attentionCursor).toBeGreaterThan(lateSource.globalCursor);
    const read = store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: current.attentionCursor,
      generation: current.attentionGeneration,
      intent: "explicit",
      traceId: "error:resolved-interaction:explicit"
    });
    expect(read).toMatchObject({
      kind: "error",
      unread: false,
      subjectCursor: errorSource.globalCursor,
      readThroughCursor: current.attentionCursor
    });
    expect(store.recordSessionAttention({
      sessionId: route.id,
      kind: "done",
      sourceCursor: lateSource.globalCursor,
      traceId: "error:resolved-interaction:late-record"
    })).toEqual(read);
  });

  it("never lets a viewer acknowledgement consume error attention", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:terminal",
      payload: { type: "error", error: publicTestError("terminal", "Failed"), terminal: true }
    });
    const error = store.getSessionAttention(route.id);
    expect(error).toMatchObject({ kind: "error", unread: true });
    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: error.attentionCursor,
      generation: error.attentionGeneration,
      intent: "viewed",
      traceId: "error:viewer-ack"
    })).toThrow(InvalidStateTransitionError);
    expect(store.getSessionAttention(route.id)).toEqual(error);

    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: error.attentionCursor,
      generation: error.attentionGeneration + 1,
      intent: "explicit",
      traceId: "error:explicit-stale-generation"
    })).toThrow(StaleGenerationError);

    store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:newer-terminal",
      payload: { type: "error", error: publicTestError("new-terminal", "Failed again"), terminal: true }
    });
    const newer = store.getSessionAttention(route.id);
    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: error.attentionCursor,
      generation: error.attentionGeneration,
      intent: "explicit",
      traceId: "error:explicit-stale-cursor"
    })).toThrow(RevisionConflictError);
    expect(store.getSessionAttention(route.id)).toEqual(newer);

    expect(store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: newer.attentionCursor,
      generation: newer.attentionGeneration,
      intent: "explicit",
      traceId: "error:explicit-current"
    })).toMatchObject({ kind: "error", unread: false });
  });

  it("keeps the terminal error payload as subject while same-run failed lifecycle advances the fence", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.createRun({
      id: "run-error-sequence",
      sessionId: route.id,
      source: "user",
      state: "running",
      createdAt: 5_000
    });
    const errorSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      runId: "run-error-sequence",
      generation: route.binding.generation,
      traceId: "error-sequence:payload",
      payload: { type: "error", error: publicTestError("terminal", "Failed"), terminal: true }
    });
    store.updateRunState({ runId: "run-error-sequence", state: "failed", traceId: "error-sequence:run-failed" });
    const doneSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      runId: "run-error-sequence",
      generation: route.binding.generation,
      traceId: "error-sequence:done-failed",
      payload: { type: "done", outcome: "failed" }
    });

    expect(store.getSessionAttention(route.id)).toMatchObject({
      kind: "error",
      unread: true,
      subjectCursor: errorSource.globalCursor,
      attentionCursor: doneSource.globalCursor
    });
  });

  it("does not resurrect an acknowledged error from late same-run failure facts but alerts for a new run", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.createRun({
      id: "run-error-read",
      sessionId: route.id,
      source: "user",
      state: "running",
      createdAt: 6_000
    });
    const errorSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      runId: "run-error-read",
      generation: route.binding.generation,
      traceId: "error-read:payload",
      payload: { type: "error", error: publicTestError("terminal", "Failed"), terminal: true }
    });
    const unread = store.getSessionAttention(route.id);
    store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: unread.attentionCursor,
      generation: unread.attentionGeneration,
      intent: "explicit",
      traceId: "error-read:ack"
    });
    store.updateRunState({ runId: "run-error-read", state: "failed", traceId: "error-read:run-failed" });
    const doneSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      runId: "run-error-read",
      generation: route.binding.generation,
      traceId: "error-read:done-failed",
      payload: { type: "done", outcome: "failed" }
    });
    expect(store.getSessionAttention(route.id)).toMatchObject({
      kind: "error",
      unread: false,
      subjectCursor: errorSource.globalCursor,
      attentionCursor: doneSource.globalCursor,
      readThroughCursor: doneSource.globalCursor
    });

    store.createRun({
      id: "run-error-new",
      sessionId: route.id,
      source: "user",
      state: "running",
      createdAt: 7_000
    });
    const newerErrorSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      runId: "run-error-new",
      generation: route.binding.generation,
      traceId: "error-read:new-run-payload",
      payload: { type: "error", error: publicTestError("terminal-new", "Failed again"), terminal: true }
    });
    expect(store.getSessionAttention(route.id)).toMatchObject({
      kind: "error",
      unread: true,
      subjectCursor: newerErrorSource.globalCursor,
      attentionCursor: newerErrorSource.globalCursor
    });
  });

  it("does not resurrect an acknowledged completion from a late same-run terminal state", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.createRun({
      id: "run-done-read",
      sessionId: route.id,
      source: "user",
      state: "running",
      createdAt: 8_000
    });
    const doneSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      runId: "run-done-read",
      generation: route.binding.generation,
      traceId: "done-read:done",
      payload: { type: "done", outcome: "completed" }
    });
    const unread = store.getSessionAttention(route.id);
    store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: unread.attentionCursor,
      generation: unread.attentionGeneration,
      intent: "viewed",
      traceId: "done-read:ack"
    });
    store.updateRunState({ runId: "run-done-read", state: "completed", traceId: "done-read:late-state" });
    const sameRun = store.getSessionAttention(route.id);
    expect(sameRun).toMatchObject({
      kind: "done",
      unread: false,
      subjectCursor: doneSource.globalCursor,
      readThroughCursor: sameRun.attentionCursor
    });

    store.createRun({
      id: "run-done-new",
      sessionId: route.id,
      source: "user",
      state: "running",
      createdAt: 9_000
    });
    const newDoneSource = store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      runId: "run-done-new",
      generation: route.binding.generation,
      traceId: "done-read:new-run",
      payload: { type: "done", outcome: "completed" }
    });
    expect(store.getSessionAttention(route.id)).toMatchObject({
      kind: "done",
      unread: true,
      subjectCursor: newDoneSource.globalCursor,
      attentionCursor: newDoneSource.globalCursor
    });
  });

  it("keeps retry preparation red and clears error only when the run is truly running", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "error:before-retry",
      payload: { type: "error", error: publicTestError("retryable", "Failed"), terminal: true }
    });
    const failed = store.getSessionAttention(route.id);
    store.createRun({
      id: "run-retry-attention",
      sessionId: route.id,
      source: "user",
      state: "waiting",
      createdAt: 5_000
    });
    const preparing = store.getSessionAttention(route.id);
    expect(preparing).toMatchObject({ kind: "error", unread: true, subjectCursor: failed.subjectCursor });
    expect(preparing.attentionCursor).toBeGreaterThan(failed.attentionCursor);

    store.updateRunState({
      runId: "run-retry-attention",
      state: "running",
      startedAt: 5_100,
      traceId: "retry:running"
    });
    const running = store.getSessionAttention(route.id);
    expect(running).toMatchObject({ kind: "error", unread: false });
    expect(running.attentionCursor).toBeGreaterThan(preparing.attentionCursor);
    expect(running.readThroughCursor).toBe(running.attentionCursor);
  });

  it("clears existing attention at the new generation reset boundary", () => {
    const { store } = createFixture();
    const route = store.getSession("session-1").descriptor;
    store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: "done:before-reset",
      payload: { type: "done", outcome: "completed" }
    });
    const before = store.getSessionAttention(route.id);

    let resetCursor = 0n;
    store.runOperation(
      { id: "operation:reset-existing-attention", kind: "reset", body: { sessionId: route.id } },
      (transaction) => {
        const reset = transaction.commitSessionReset({
          sessionId: route.id,
          sourceBinding: route.binding,
          binding: {
            opaqueRef: "native/reset-existing-attention.jsonl",
            nativeSessionId: "native-reset-existing-attention",
            generation: route.binding.generation + 1
          },
          operationId: "operation:reset-existing-attention",
          traceId: "attention:reset-existing"
        });
        resetCursor = reset.event.globalCursor;
        return { reset: true };
      }
    );

    expect(store.getSessionAttention(route.id)).toMatchObject({
      unread: false,
      attentionCursor: resetCursor,
      attentionGeneration: route.binding.generation + 1,
      readThroughCursor: resetCursor,
      readThroughGeneration: route.binding.generation + 1
    });
    expect(() => store.acknowledgeSessionAttention({
      sessionId: route.id,
      throughCursor: before.attentionCursor,
      generation: before.attentionGeneration,
      intent: "viewed",
      traceId: "attention:stale-after-reset"
    })).toThrow(StaleGenerationError);
  });

  it("fails closed when another process-level writer owns the database", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "joko-store-owner-"));
    const filePath = path.join(directory, "operational.sqlite");
    const first = new OperationalStore(filePath);
    cleanups.push(() => {
      try {
        first.close();
      } catch {
        // The assertion closes the original owner before proving handoff.
      }
      rmSync(directory, { recursive: true, force: true });
    });

    expect(() => new OperationalStore(filePath)).toThrow(ActiveWriterError);

    first.close();
    const successor = new OperationalStore(filePath);
    expect(successor.health().journalMode).toBe("wal");
    successor.close();
  });

  it("initializes one current schema marker, survives restart, and rejects an unmarked nonempty database", () => {
    expect(SCHEMA_VERSION).toBe(1);
    const directory = mkdtempSync(path.join(tmpdir(), "joko-store-schema-"));
    const filePath = path.join(directory, "operational.sqlite");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    const first = new OperationalStore(filePath);
    expect(first.health().schemaVersion).toBe(SCHEMA_VERSION);
    first.close();

    const inspect = new DatabaseSync(filePath);
    expect(inspect.prepare("SELECT singleton, version, baseline_id FROM schema_version").all()).toEqual([
      expect.objectContaining({
        singleton: 1,
        version: SCHEMA_VERSION,
        baseline_id: SCHEMA_BASELINE_ID
      })
    ]);
    expect(inspect.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger')").get())
      .toMatchObject({ count: expect.any(Number) });
    const reviewColumns = inspect.prepare("PRAGMA table_info(review_runs)").all() as Array<Record<string, unknown>>;
    expect(reviewColumns.find((column) => column["name"] === "freshness")).toMatchObject({
      notnull: 1,
      dflt_value: null
    });
    expect(reviewColumns.find((column) => column["name"] === "freshness_checked_at")).toMatchObject({
      notnull: 1,
      dflt_value: null
    });
    const backendColumns = inspect.prepare("PRAGMA table_info(backends)").all() as Array<Record<string, unknown>>;
    expect(backendColumns.map((column) => column["name"])).toEqual(expect.arrayContaining([
      "adapter_kind",
      "instance_generation",
      "installation_state",
      "authentication_state",
      "error_json"
    ]));
    expect(backendColumns.map((column) => column["name"])).not.toEqual(expect.arrayContaining([
      "installed",
      "authenticated"
    ]));
    const backendGenerationColumns = inspect.prepare(
      "PRAGMA table_info(backend_instance_generations)"
    ).all() as Array<Record<string, unknown>>;
    expect(backendGenerationColumns.map((column) => column["name"])).toEqual(expect.arrayContaining([
      "backend_id",
      "adapter_kind",
      "high_water_generation",
      "current_generation"
    ]));
    const attemptColumns = inspect.prepare("PRAGMA table_info(attempts)").all() as Array<Record<string, unknown>>;
    const queueColumns = inspect.prepare("PRAGMA table_info(queue_items)").all() as Array<Record<string, unknown>>;
    expect(attemptColumns.map((column) => column["name"])).toContain("backend_instance_generation");
    expect(queueColumns.map((column) => column["name"])).toContain("backend_instance_generation");
    inspect.close();

    const reopened = new OperationalStore(filePath);
    reopened.close();

    const unsupported = new DatabaseSync(filePath);
    unsupported.exec("ALTER TABLE schema_version RENAME TO unsupported_schema_version; PRAGMA user_version = 0;");
    unsupported.close();
    expect(() => new OperationalStore(filePath)).toThrow(/schema is unsupported/u);
  });

  it("rejects a same-version schema marker missing its required identity field", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "joko-store-unsupported-v1-"));
    const filePath = path.join(directory, "operational.sqlite");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const unsupported = new DatabaseSync(filePath);
    unsupported.exec(`
      CREATE TABLE schema_version (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL,
        initialized_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_version(singleton, version, initialized_at) VALUES (1, 1, 0);
      PRAGMA user_version = 1;
    `);
    unsupported.close();

    expect(() => new OperationalStore(filePath)).toThrow(/schema is unsupported/u);
  });

  it("rejects a tampered schema catalog even when the v1 marker and fingerprint are unchanged", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "joko-store-tampered-v1-"));
    const filePath = path.join(directory, "operational.sqlite");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    const original = new OperationalStore(filePath);
    original.close();
    const tampered = new DatabaseSync(filePath);
    tampered.exec("ALTER TABLE backends ADD COLUMN injected_development_shape TEXT;");
    expect(tampered.prepare(
      "SELECT version, baseline_id FROM schema_version WHERE singleton = 1"
    ).get()).toMatchObject({ version: SCHEMA_VERSION, baseline_id: SCHEMA_BASELINE_ID });
    tampered.close();

    expect(() => new OperationalStore(filePath)).toThrow(/schema is unsupported/u);
  });

  it("rejects an extra schema object that only impersonates the optional vector-index prefix", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "joko-store-vector-prefix-v1-"));
    const filePath = path.join(directory, "operational.sqlite");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

    const original = new OperationalStore(filePath);
    original.close();
    const tampered = new DatabaseSync(filePath);
    tampered.exec("CREATE TABLE message_search_vectors_injected(value TEXT);");
    tampered.close();

    expect(() => new OperationalStore(filePath)).toThrow(/schema is unsupported/u);
  });

  it("fences stale binding generations and duplicate live native owners", () => {
    const { store } = createFixture();
    const initial = store.getSession("session-1");
    const current = store.updateSession("session-1", {
      binding: {
        opaqueRef: "native/rebound-session.jsonl",
        nativeSessionId: "native-owner-one",
        generation: initial.descriptor.binding.generation + 1
      }
    }, initial.revision);

    expect(() => store.updateSession("session-1", {
      binding: { ...initial.descriptor.binding }
    }, current.revision)).toThrow(StaleGenerationError);
    expect(() => store.updateSession("session-1", {
      binding: {
        opaqueRef: "native/changed-without-generation.jsonl",
        nativeSessionId: "native-owner-two",
        generation: current.descriptor.binding.generation
      }
    }, current.revision)).toThrow(StoreError);

    expect(() => store.createSession({
      ...current.descriptor,
      id: "session-duplicate-native-owner",
      title: "Duplicate native owner",
      binding: {
        ...current.descriptor.binding,
        // The live-binding index is intentionally case-insensitive because
        // Windows paths refer to the same native session across casing.
        opaqueRef: current.descriptor.binding.opaqueRef.toUpperCase()
      },
      createdAt: current.descriptor.createdAt + 1,
      updatedAt: current.descriptor.updatedAt + 1
    })).toThrow();
    expect(store.findLiveSessionByNativeBinding(
      current.descriptor.backendId,
      current.descriptor.binding.opaqueRef
    )?.descriptor.id).toBe("session-1");
  });

  it("distinguishes an omitted effort patch from an explicit effort clear", () => {
    const { store } = createFixture();
    const selected = store.updateSession("session-1", { effort: "medium" });
    expect(selected.descriptor.effort).toBe("medium");

    const unchanged = store.updateSession("session-1", { title: "Renamed" }, selected.revision);
    expect(unchanged.descriptor.effort).toBe("medium");

    const cleared = store.updateSession("session-1", { effort: null }, unchanged.revision);
    expect(cleared.descriptor.effort).toBeUndefined();
  });

  it("replays the same operation body without invoking the mutation twice", () => {
    const store = createStore();
    let invocations = 0;
    const input = { id: "operation-1", kind: "test", body: { alpha: 1, beta: [2, 3] } };

    const first = store.runOperation(input, () => {
      invocations += 1;
      return { accepted: true };
    });
    const replay = store.runOperation(
      { ...input, body: { beta: [2, 3], alpha: 1 } },
      () => {
        invocations += 1;
        return { accepted: false };
      }
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual({ accepted: true });
    expect(store.getOperation("operation-1").body).toEqual({ alpha: 1, beta: [2, 3] });
    expect(store.listOperations({ status: "completed" }).map((operation) => operation.id)).toEqual(["operation-1"]);
    expect(invocations).toBe(1);
  });

  it("rejects reuse of an operation ID with a different canonical body", () => {
    const store = createStore();
    store.runOperation({ id: "operation-1", kind: "test", body: { value: 1 } }, () => "ok");

    expect(() => store.runOperation(
      { id: "operation-1", kind: "test", body: { value: 2 } },
      () => "not-called"
    )).toThrow(OperationConflictError);
  });

  it("durably claims an authorized external effect and completes it only after acknowledgement", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-effect",
      name: "Effect client",
      authKeyDigest: "effect-digest"
    });
    let commits = 0;
    const input = { id: "operation-effect", kind: "archive", body: { targetId: "target-1", archived: true } };
    const claim = store.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input,
      (transaction) => {
        commits += 1;
        transaction.setSetting("service", "global", "effect-commit", { committed: true });
        return { archived: true };
      }
    );

    expect(claim).toMatchObject({ claimed: true, replayed: false, value: { archived: true } });
    expect(claim.operation).toMatchObject({
      status: "started",
      completionMode: "external_effect",
      body: { targetId: "target-1", archived: true }
    });
    expect(store.getSetting("service", "global", "effect-commit")?.value).toEqual({ committed: true });
    expect(() => store.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input,
      () => {
        commits += 1;
        return { archived: false };
      }
    )).toThrow(OperationInProgressError);

    const completed = store.completeEffectOperation<{ readonly archived: boolean }>(
      claim.operation.id,
      claim.operation.bodyHash
    );
    expect(completed).toMatchObject({ replayed: false, value: { archived: true } });
    expect(completed.operation.status).toBe("completed");
    const replay = store.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      { ...input, body: { archived: true, targetId: "target-1" } },
      () => {
        commits += 1;
        return { archived: false };
      }
    );
    expect(replay).toMatchObject({ claimed: false, replayed: true, value: { archived: true } });
    expect(commits).toBe(1);
    expect(() => store.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      { ...input, body: { targetId: "target-1", archived: false } },
      () => ({ archived: false })
    )).toThrow(OperationConflictError);
  });

  it("persists a typed effect failure tombstone and replays that authoritative failure", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-effect-failure",
      name: "Effect client",
      authKeyDigest: "effect-failure-digest"
    });
    const input = { id: "operation-effect-failure", kind: "delete", body: { id: "target-1" } };
    const claim = store.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input,
      () => ({ deleted: true })
    );
    const failed = store.failEffectOperation(
      claim.operation.id,
      claim.operation.bodyHash,
      new Error("provider rejected sk-abcdefghijklmnop")
    );

    expect(failed).toMatchObject({
      status: "failed",
      completionMode: "external_effect",
      error: {
        code: "EFFECT_FAILED",
        message: "provider rejected [REDACTED]",
        phase: "effect",
        retryable: false,
        stateMayHaveChanged: true
      }
    });
    expect(() => store.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input,
      () => ({ deleted: false })
    )).toThrow(OperationPreviouslyFailedError);
  });

  it("preserves an already-sanitized public effect error instead of flattening its recovery contract", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-public-effect-failure",
      name: "Public effect client",
      authKeyDigest: "public-effect-failure-digest"
    });
    const claim = store.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      { id: "operation-public-effect-failure", kind: "compact", body: { sessionId: "session-1" } }
    );

    const failed = store.failEffectOperation(claim.operation.id, claim.operation.bodyHash, new JokoError({
      code: "COMPACTION_IN_PROGRESS",
      message: "Session is compacting sk-abcdefghijklmnop",
      phase: "compaction",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Wait, then retry with token=sk-abcdefghijklmnop."
    }));

    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "COMPACTION_IN_PROGRESS",
        message: "Session is compacting [REDACTED]",
        phase: "compaction",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Wait, then retry with token=[REDACTED]."
      }
    });
  });

  it("defers product mutation and response until an acknowledged effect is finalized", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-deferred-effect",
      name: "Deferred effect client",
      authKeyDigest: "deferred-effect-digest"
    });
    const input = {
      id: "operation-deferred-effect",
      kind: "rename",
      body: { sessionId: "session-1", title: "After" }
    };
    let validations = 0;
    let commits = 0;
    const claim = store.claimAuthorizedDeferredEffectOperation<{ readonly title: string }>(
      connection.id,
      connection.authKeyDigest,
      input,
      () => {
        validations += 1;
      }
    );

    expect(claim).toMatchObject({ claimed: true, replayed: false });
    expect(claim.operation).toMatchObject({
      status: "started",
      completionMode: "external_effect",
      body: input.body
    });
    expect("response" in claim.operation).toBe(false);
    expect(store.findSetting("service", "global", "deferred-effect")).toBeUndefined();
    expect(() => store.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input
    )).toThrow(OperationInProgressError);

    const completed = store.completeAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      claim.operation.id,
      claim.operation.bodyHash,
      (transaction) => {
        commits += 1;
        transaction.setSetting("service", "global", "deferred-effect", { title: "After" });
        return { title: "After" };
      }
    );
    expect(completed).toMatchObject({ replayed: false, value: { title: "After" } });
    expect(completed.operation.status).toBe("completed");
    expect(store.getSetting("service", "global", "deferred-effect")?.value).toEqual({ title: "After" });

    const replay = store.claimAuthorizedDeferredEffectOperation<{ readonly title: string }>(
      connection.id,
      connection.authKeyDigest,
      { ...input, body: { title: "After", sessionId: "session-1" } }
    );
    expect(replay).toMatchObject({ claimed: false, replayed: true, value: { title: "After" } });
    expect(validations).toBe(1);
    expect(commits).toBe(1);
  });

  it("rolls back a failed deferred finalizer and leaves the claim available for a failure tombstone", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-deferred-fence",
      name: "Deferred fence client",
      authKeyDigest: "deferred-fence-digest"
    });
    const claim = store.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      { id: "operation-deferred-fence", kind: "fenced", body: { expected: 1 } }
    );

    expect(() => store.completeAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      claim.operation.id,
      claim.operation.bodyHash,
      (transaction) => {
        transaction.setSetting("service", "global", "must-rollback", { changed: true });
        throw new RevisionConflictError("Fence", "one", 1n, 2n);
      }
    )).toThrow(RevisionConflictError);
    expect(store.findSetting("service", "global", "must-rollback")).toBeUndefined();
    expect(store.getOperation(claim.operation.id)).toMatchObject({ status: "started" });

    store.failEffectOperation(claim.operation.id, claim.operation.bodyHash, new Error("final fence changed"));
    expect(store.getOperation(claim.operation.id)).toMatchObject({
      status: "failed",
      error: { code: "EFFECT_FAILED", stateMayHaveChanged: true }
    });
  });

  it("tombstones an unacknowledged effect claim after restart instead of replaying it", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-effect-crash",
      name: "Effect client",
      authKeyDigest: "effect-crash-digest"
    });
    const input = { id: "operation-effect-crash", kind: "external", body: { exact: ["body", 1] } };
    store.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input,
      (transaction) => {
        transaction.setSetting("service", "global", "crash-commit", { durable: true });
        return { accepted: true };
      }
    );
    const filePath = store.filePath;
    store.close();
    const reopened = new OperationalStore(filePath);
    cleanups.push(() => reopened.close());

    const recovery = reopened.recoverStartup("recover-effect");
    expect(recovery.recoveredEffectOperationIds).toEqual(["operation-effect-crash"]);
    expect(reopened.getSetting("service", "global", "crash-commit")?.value).toEqual({ durable: true });
    expect(reopened.getOperation("operation-effect-crash")).toMatchObject({
      status: "failed",
      error: {
        code: "EFFECT_OUTCOME_UNKNOWN",
        stateMayHaveChanged: true,
        retryable: false
      }
    });
    expect(() => reopened.claimAuthorizedEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input,
      () => ({ accepted: false })
    )).toThrow(OperationPreviouslyFailedError);
    expect(reopened.recoverStartup("recover-effect-again").recoveredEffectOperationIds).toEqual([]);
  });

  it("tombstones a deferred claim after restart without ever applying its product mutation", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-deferred-crash",
      name: "Deferred crash client",
      authKeyDigest: "deferred-crash-digest"
    });
    const input = { id: "operation-deferred-crash", kind: "native_create", body: { exact: true } };
    store.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input
    );
    expect(store.findSetting("service", "global", "never-committed")).toBeUndefined();
    const filePath = store.filePath;
    store.close();
    const reopened = new OperationalStore(filePath);
    cleanups.push(() => reopened.close());

    expect(reopened.recoverStartup("recover-deferred").recoveredEffectOperationIds)
      .toEqual(["operation-deferred-crash"]);
    expect(reopened.findSetting("service", "global", "never-committed")).toBeUndefined();
    expect(reopened.getOperation(input.id)).toMatchObject({
      status: "failed",
      error: { code: "EFFECT_OUTCOME_UNKNOWN", stateMayHaveChanged: true, retryable: false }
    });
    expect(() => reopened.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      input
    )).toThrow(OperationPreviouslyFailedError);
  });

  it("recovers the dispatch crash window as dispatch_unknown without replay", () => {
    const fixture = createFixture();
    fixture.store.createAttempt({
      id: "attempt-1",
      runId: "run-1",
      ordinal: 1,
      generation: 0,
      startedAt: 3
    });
    fixture.store.runOperation(
      { id: "operation-queue", kind: "prompt", body: fixture.prompt },
      (store) => {
        store.enqueueQueueItem({
          id: "queue-1",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          operationId: "operation-queue",
          disposition: "prompt",
          body: fixture.prompt
        });
        return { queueItemId: "queue-1" };
      }
    );
    expect(fixture.store.claimNextQueueItem({
      sessionId: "session-1",
      backendInstanceGeneration: 0,
      traceId: "dispatch"
    })?.state).toBe("dispatching");
    expect(fixture.store.getAttempt("attempt-1").descriptor.backendInstanceGeneration).toBe(0);
    fixture.store.updateRunState({
      runId: "run-1",
      state: "running",
      activeAttemptId: "attempt-1",
      traceId: "running"
    });
    fixture.store.updateQueueState({
      queueItemId: "queue-1",
      state: "backend_accepted",
      attemptId: "attempt-1",
      traceId: "accepted"
    });
    fixture.store.updateRunState({
      runId: "run-1",
      state: "waiting",
      activeAttemptId: "attempt-1",
      traceId: "waiting"
    });

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    const recovery = reopened.recoverStartup("recover");

    expect(recovery.recoveredQueueItemIds).toEqual(["queue-1"]);
    expect(reopened.getQueueItem("queue-1").state).toBe("dispatch_unknown");
    expect(reopened.getRun("run-1").descriptor.state).toBe("dispatch_unknown");
    expect(reopened.getAttempt("attempt-1").descriptor).toMatchObject({
      endedAt: expect.any(Number),
      error: { code: "dispatch_unknown_after_restart" }
    });
    expect(recovery.events.map((event) => event.payload.type)).toEqual(["queue_update", "run_state"]);
    expect(reopened.recoverStartup("recover-again").recoveredQueueItemIds).toEqual([]);
  });

  it("recovers when the process stops immediately after the atomic Backend instance claim", () => {
    const fixture = createFixture();
    fixture.store.createAttempt({
      id: "attempt-claim-crash",
      runId: "run-1",
      ordinal: 1,
      generation: 0,
      startedAt: 2
    });
    fixture.store.runOperation(
      { id: "operation-claim-crash", kind: "prompt", body: fixture.prompt },
      (store) => {
        store.enqueueQueueItem({
          id: "queue-claim-crash",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-claim-crash",
          operationId: "operation-claim-crash",
          disposition: "prompt",
          body: fixture.prompt
        });
        return { accepted: true };
      }
    );

    expect(fixture.store.claimNextQueueItem({
      sessionId: "session-1",
      backendInstanceGeneration: 0,
      traceId: "claim-crash"
    })).toMatchObject({
      state: "dispatching",
      attemptId: "attempt-claim-crash",
      backendInstanceGeneration: 0
    });
    expect(fixture.store.getAttempt("attempt-claim-crash").descriptor.backendInstanceGeneration).toBe(0);

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.recoverStartup("recover-claim-crash").recoveredQueueItemIds)
      .toEqual(["queue-claim-crash"]);
    expect(reopened.getQueueItem("queue-claim-crash")).toMatchObject({
      state: "dispatch_unknown",
      attemptId: "attempt-claim-crash",
      backendInstanceGeneration: 0
    });
    expect(reopened.getAttempt("attempt-claim-crash").descriptor).toMatchObject({
      backendInstanceGeneration: 0,
      endedAt: expect.any(Number)
    });
  });

  it("persists queue edits, ordering, cancellation, and dispatch pause controls", () => {
    const fixture = createFixture();
    const enqueue = (ordinal: number) => {
      const runId = `queue-control-run-${ordinal}`;
      const operationId = `queue-control-operation-${ordinal}`;
      fixture.store.createRun({
        id: runId,
        sessionId: "session-1",
        source: "user",
        state: "queued",
        createdAt: 10 + ordinal
      });
      const attemptId = `queue-control-attempt-${ordinal}`;
      fixture.store.createAttempt({
        id: attemptId,
        runId,
        ordinal: 1,
        generation: 0,
        startedAt: 15 + ordinal
      });
      fixture.store.runOperation({ id: operationId, kind: "prompt", body: { ordinal } }, (store) => {
        store.enqueueQueueItem({
          id: `queue-control-${ordinal}`,
          sessionId: "session-1",
          runId,
          attemptId,
          operationId,
          disposition: "prompt",
          body: { ...fixture.prompt, text: `Prompt ${ordinal}` },
          createdAt: 20 + ordinal
        });
        return { accepted: true };
      });
    };
    enqueue(1);
    enqueue(2);
    enqueue(3);

    const paused = fixture.store.setQueuePaused({
      sessionId: "session-1",
      paused: true,
      reason: "Owner review",
      traceId: "queue:pause",
      at: 100
    });
    expect(paused).toMatchObject({ paused: true, pauseReason: "Owner review", pausedAt: 100 });
    expect(fixture.store.claimNextQueueItem({
      sessionId: "session-1",
      backendInstanceGeneration: 0
    })).toBeUndefined();
    expect(fixture.store.listEvents({ sessionId: "session-1" }).at(-1)?.payload).toMatchObject({
      type: "queue_control",
      paused: true,
      reason: "Owner review"
    });

    fixture.store.editQueueItem({
      queueItemId: "queue-control-2",
      body: { ...fixture.prompt, text: "Edited", disposition: "follow_up" },
      traceId: "queue:edit"
    });
    fixture.store.reorderQueueItem({
      queueItemId: "queue-control-2",
      placement: { edge: "first" },
      traceId: "queue:reorder"
    });
    expect(fixture.store.listQueueItems({ sessionId: "session-1", states: ["accepted"] }).map((item) => [
      item.id,
      item.position,
      item.body.text,
      item.disposition
    ])).toEqual([
      ["queue-control-2", 0, "Edited", "follow_up"],
      ["queue-control-1", 1, "Prompt 1", "prompt"],
      ["queue-control-3", 2, "Prompt 3", "prompt"]
    ]);

    const cancelled = fixture.store.cancelQueueItem({
      queueItemId: "queue-control-2",
      traceId: "queue:cancel",
      at: 110
    });
    expect(cancelled.state).toBe("cancelled");
    expect(fixture.store.getRun(cancelled.runId).descriptor.state).toBe("aborted");
    expect(() => fixture.store.editQueueItem({
      queueItemId: cancelled.id,
      body: { ...fixture.prompt, text: "Too late" },
      traceId: "queue:late-edit"
    })).toThrow(/transition/u);

    fixture.store.setQueuePaused({ sessionId: "session-1", paused: false, traceId: "queue:resume", at: 120 });
    expect(fixture.store.getQueueControl("session-1").paused).toBe(false);
    expect(fixture.store.claimNextQueueItem({
      sessionId: "session-1",
      backendInstanceGeneration: 0
    })?.id).toBe("queue-control-1");
  });

  it("fences dispatch and conflicting mutations while queue interaction locks are active", () => {
    const fixture = createFixture();
    const owner = fixture.store.createConnection({
      id: "queue-lock-owner",
      name: "Queue lock owner",
      authKeyDigest: "queue-lock-owner-digest"
    });
    const other = fixture.store.createConnection({
      id: "queue-lock-other",
      name: "Other queue client",
      authKeyDigest: "queue-lock-other-digest"
    });
    fixture.store.createAttempt({ id: "queue-lock-attempt", runId: "run-1", ordinal: 1, generation: 0, startedAt: 2 });
    fixture.store.runOperation({ id: "queue-lock-operation", kind: "prompt", body: fixture.prompt }, (store) => {
      store.enqueueQueueItem({
        id: "queue-lock-item",
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "queue-lock-attempt",
        operationId: "queue-lock-operation",
        disposition: "prompt",
        body: fixture.prompt,
        createdAt: 3
      });
      return { accepted: true };
    });
    fixture.store.createAttempt({ id: "queue-lock-tail-attempt", runId: "run-1", ordinal: 2, generation: 0, startedAt: 3 });
    fixture.store.runOperation({ id: "queue-lock-tail-operation", kind: "prompt", body: fixture.prompt }, (store) => {
      store.enqueueQueueItem({
        id: "queue-lock-tail-item",
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "queue-lock-tail-attempt",
        operationId: "queue-lock-tail-operation",
        disposition: "prompt",
        body: { ...fixture.prompt, text: "Queue tail" },
        createdAt: 4
      });
      return { accepted: true };
    });

    const lockNow = Date.now();
    const editToken = "queue-edit-lock-token-0001";
    fixture.store.setQueueItemEditLock({
      queueItemId: "queue-lock-item",
      connectionId: owner.id,
      lockToken: editToken,
      locked: true,
      ttlMs: 5_000,
      at: lockNow
    });
    expect(fixture.store.getQueueItem("queue-lock-item").editLocked).toBe(true);
    expect(fixture.store.claimNextQueueItem({ sessionId: "session-1", backendInstanceGeneration: 0, at: lockNow + 1 }))
      .toBeUndefined();
    expect(() => fixture.store.setQueueItemEditLock({
      queueItemId: "queue-lock-item",
      connectionId: other.id,
      lockToken: "queue-edit-lock-token-0002",
      locked: true,
      ttlMs: 5_000,
      at: lockNow + 2
    })).toThrow(/already being edited/u);
    expect(() => fixture.store.editQueueItem({
      queueItemId: "queue-lock-item",
      body: { ...fixture.prompt, text: "Conflicting edit" },
      traceId: "queue:lock:conflict",
      at: lockNow + 3
    })).toThrow(/another interaction/u);
    expect(() => fixture.store.cancelQueueItem({
      queueItemId: "queue-lock-item",
      connectionId: other.id,
      traceId: "queue:lock:cancel-conflict",
      at: lockNow + 3
    })).toThrow(/another interaction/u);
    expect(fixture.store.editQueueItem({
      queueItemId: "queue-lock-item",
      body: { ...fixture.prompt, text: "Authorized edit" },
      connectionId: owner.id,
      lockToken: editToken,
      traceId: "queue:lock:edit",
      at: lockNow + 4
    }).body.text).toBe("Authorized edit");
    expect(fixture.store.reorderQueueItem({
      queueItemId: "queue-lock-item",
      placement: { edge: "first" },
      connectionId: owner.id,
      editLockToken: editToken,
      traceId: "queue:lock:authorized-steer",
      at: lockNow + 4
    }).id).toBe("queue-lock-item");
    const interactionDuringEditToken = "queue-interaction-token-edit";
    fixture.store.setQueueInteractionLock({
      sessionId: "session-1",
      connectionId: owner.id,
      lockToken: interactionDuringEditToken,
      locked: true,
      ttlMs: 5_000,
      at: lockNow + 4
    });
    expect(() => fixture.store.reorderQueueItem({
      queueItemId: "queue-lock-item",
      placement: { edge: "first" },
      connectionId: owner.id,
      lockToken: interactionDuringEditToken,
      traceId: "queue:lock:reorder-editing-item",
      at: lockNow + 4
    })).toThrow(/another interaction/u);
    fixture.store.setQueueInteractionLock({
      sessionId: "session-1",
      connectionId: owner.id,
      lockToken: interactionDuringEditToken,
      locked: false,
      at: lockNow + 4
    });
    fixture.store.setQueueItemEditLock({
      queueItemId: "queue-lock-item",
      connectionId: owner.id,
      lockToken: editToken,
      locked: false,
      at: lockNow + 5
    });
    expect(fixture.store.getQueueItem("queue-lock-item").editLocked).toBe(false);

    const interactionToken = "queue-interaction-token-0001";
    fixture.store.setQueueInteractionLock({
      sessionId: "session-1",
      connectionId: owner.id,
      lockToken: interactionToken,
      locked: true,
      ttlMs: 5_000,
      at: lockNow + 100
    });
    expect(fixture.store.getQueueControl("session-1").interactionLocked).toBe(true);
    expect(() => fixture.store.setQueueItemEditLock({
      queueItemId: "queue-lock-tail-item",
      connectionId: other.id,
      lockToken: "queue-edit-lock-token-0003",
      locked: true,
      ttlMs: 5_000,
      at: lockNow + 101
    })).toThrow(/being reordered/u);
    expect(fixture.store.claimNextQueueItem({ sessionId: "session-1", backendInstanceGeneration: 0, at: lockNow + 101 }))
      .toBeUndefined();
    expect(() => fixture.store.reorderQueueItem({
      queueItemId: "queue-lock-item",
      placement: { edge: "first" },
      traceId: "queue:lock:reorder-conflict",
      at: lockNow + 102
    })).toThrow(/another interaction/u);
    expect(() => fixture.store.editQueueItem({
      queueItemId: "queue-lock-item",
      body: { ...fixture.prompt, text: "Edit during reorder" },
      traceId: "queue:lock:edit-during-reorder",
      at: lockNow + 102
    })).toThrow(/another interaction/u);
    expect(() => fixture.store.cancelQueueItem({
      queueItemId: "queue-lock-item",
      connectionId: other.id,
      traceId: "queue:lock:cancel-during-reorder",
      at: lockNow + 102
    })).toThrow(/another interaction/u);
    expect(fixture.store.reorderQueueItem({
      queueItemId: "queue-lock-item",
      placement: { edge: "first" },
      connectionId: owner.id,
      lockToken: interactionToken,
      traceId: "queue:lock:reorder",
      at: lockNow + 103
    }).id).toBe("queue-lock-item");
    expect(fixture.store.expireQueueLocks({ sessionId: "session-1", at: lockNow + 5_200 }))
      .toEqual({ interactionLockExpired: true, queueItemIds: [] });
    expect(fixture.store.getQueueControl("session-1").interactionLocked).toBe(false);
    expect(fixture.store.claimNextQueueItem({ sessionId: "session-1", backendInstanceGeneration: 0, at: lockNow + 5_200 })?.id)
      .toBe("queue-lock-item");
  });

  it("atomically binds a queue claim and renewed Attempt to the current Backend instance generation", () => {
    const fixture = createFixture();
    fixture.store.createAttempt({
      id: "attempt-before-instance-claim",
      runId: "run-1",
      ordinal: 1,
      generation: 0,
      startedAt: 2
    });
    fixture.store.runOperation(
      { id: "operation-instance-claim", kind: "prompt", body: fixture.prompt },
      (store) => {
        store.enqueueQueueItem({
          id: "queue-instance-claim",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-before-instance-claim",
          operationId: "operation-instance-claim",
          disposition: "prompt",
          body: fixture.prompt
        });
        return { accepted: true };
      }
    );
    const backend = fixture.store.getBackend("pi").descriptor;
    const reservation = fixture.store.reserveBackendInstanceGeneration({
      backendId: backend.id,
      adapterKind: backend.adapterKind
    });
    expect(fixture.store.publishBackendInstanceDescriptor({
      descriptor: { ...backend, instanceGeneration: reservation.generation },
      ...(reservation.expectedCurrentGeneration === undefined
        ? {}
        : { expectedCurrentGeneration: reservation.expectedCurrentGeneration })
    }).status).toBe("published");

    expect(fixture.store.claimNextQueueItem({
      sessionId: "session-1",
      backendInstanceGeneration: 0
    })).toBeUndefined();
    const unclaimed = fixture.store.getQueueItem("queue-instance-claim");
    expect(unclaimed.state).toBe("accepted");
    expect(unclaimed).not.toHaveProperty("backendInstanceGeneration");
    expect(fixture.store.getAttempt("attempt-before-instance-claim").descriptor)
      .not.toHaveProperty("backendInstanceGeneration");

    const claimed = fixture.store.claimNextQueueItem({
      sessionId: "session-1",
      backendInstanceGeneration: 1,
      traceId: "instance-claim"
    });
    expect(claimed).toMatchObject({
      state: "dispatching",
      backendInstanceGeneration: 1
    });
    expect(fixture.store.getAttempt("attempt-before-instance-claim").descriptor)
      .toMatchObject({ backendInstanceGeneration: 1 });

    const session = fixture.store.getSession("session-1");
    fixture.store.updateSession("session-1", {
      binding: {
        ...session.descriptor.binding,
        generation: session.descriptor.binding.generation + 1
      }
    }, session.revision);
    const renewed = fixture.store.renewQueueAttemptGeneration({
      queueItemId: "queue-instance-claim",
      attemptId: "attempt-instance-1",
      generation: 1,
      at: 3
    });
    expect(renewed.attemptId).toBe("attempt-instance-1");
    expect(fixture.store.getAttempt("attempt-instance-1").descriptor).toMatchObject({
      generation: 1,
      backendInstanceGeneration: 1
    });
    expect(fixture.store.updateQueueState({
      queueItemId: "queue-instance-claim",
      state: "backend_accepted",
      attemptId: "attempt-instance-1",
      traceId: "instance-claim:accepted"
    })).toMatchObject({ state: "backend_accepted", backendInstanceGeneration: 1 });

    fixture.store.createAttempt({
      id: "attempt-instance-impostor",
      runId: "run-1",
      ordinal: 3,
      generation: 1,
      backendInstanceGeneration: 1,
      startedAt: 4
    });
    expect(() => fixture.store.updateQueueState({
      queueItemId: "queue-instance-claim",
      state: "failed",
      attemptId: "attempt-instance-impostor",
      traceId: "instance-claim:wrong-owner"
    })).toThrow(/cannot replace its exact Attempt owner/u);
    expect(fixture.store.getQueueItem("queue-instance-claim")).toMatchObject({
      state: "backend_accepted",
      attemptId: "attempt-instance-1",
      backendInstanceGeneration: 1
    });

    const resumed = fixture.store.getSession("session-1");
    fixture.store.updateSession("session-1", {
      binding: { ...resumed.descriptor.binding, generation: 2 }
    }, resumed.revision);
    fixture.store.createAttempt({
      id: "attempt-instance-projection",
      runId: "run-1",
      ordinal: 4,
      generation: 2,
      backendInstanceGeneration: 1,
      startedAt: 5
    });
    expect(fixture.store.updateQueueState({
      queueItemId: "queue-instance-claim",
      state: "failed",
      attemptId: "attempt-instance-1",
      projectionAttemptId: "attempt-instance-projection",
      traceId: "instance-claim:recovered-projection"
    })).toMatchObject({
      state: "failed",
      attemptId: "attempt-instance-1",
      backendInstanceGeneration: 1
    });
    expect(fixture.store.listEvents({ sessionId: "session-1", limit: 100 })
      .filter((event) => event.payload.type === "queue_update").at(-1)).toMatchObject({
      attemptId: "attempt-instance-projection",
      generation: 2,
      payload: { type: "queue_update" }
    });
  });

  it.each(["running", "waiting", "retrying"] as const)(
    "recovers an orphaned %s run and active attempt even without a queue transition",
    (state) => {
      const fixture = createFixture();
      fixture.store.createAttempt({
        id: `attempt-${state}`,
        runId: "run-1",
        ordinal: 1,
        generation: 0,
        startedAt: 3
      });
      fixture.store.updateRunState({
        runId: "run-1",
        state: state === "waiting" || state === "retrying" ? "running" : state,
        activeAttemptId: `attempt-${state}`,
        traceId: `state:${state}:running`
      });
      if (state !== "running") fixture.store.updateRunState({
        runId: "run-1",
        state,
        activeAttemptId: `attempt-${state}`,
        traceId: `state:${state}`
      });

      const recovery = fixture.store.recoverStartup(`recover-${state}`);
      expect(recovery.recoveredQueueItemIds).toEqual([]);
      expect(recovery.affectedRunIds).toEqual(["run-1"]);
      expect(fixture.store.getRun("run-1").descriptor).toMatchObject({
        state: "dispatch_unknown",
        error: { code: "dispatch_unknown_after_restart" }
      });
      expect(fixture.store.getAttempt(`attempt-${state}`).descriptor).toMatchObject({
        endedAt: expect.any(Number),
        error: { code: "dispatch_unknown_after_restart" }
      });
    }
  );

  it("persists inline rendering metadata on accepted inputs and user events", () => {
    const fixture = createFixture();
    fixture.store.createAttempt({
      id: "quote-attempt",
      runId: "run-1",
      ordinal: 1,
      generation: 0,
      startedAt: 2
    });
    fixture.store.runOperation({ id: "quote-operation", kind: "prompt", body: {} }, (transaction) => {
      transaction.enqueueQueueItem({
        id: "quote-queue-item",
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "quote-attempt",
        operationId: "quote-operation",
        disposition: "prompt",
        body: {
          ...fixture.prompt,
          text: "> <!-- joko-selection-quote -->\n> selected",
          quotesEncoded: true,
          pastedTextRanges: [{ start: 34, end: 42, display: "Pasted text (1 line)" }]
        },
        createdAt: 3
      });
      transaction.appendEvent({
        id: "quote-user-event",
        backendId: "pi",
        targetId: "target-1",
        sessionId: "session-1",
        runId: "run-1",
        generation: 0,
        traceId: "quote:event",
        payload: {
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "text", text: "> <!-- joko-selection-quote -->\n> selected" }],
          quotesEncoded: true,
          pastedTextRanges: [{ start: 34, end: 42, display: "Pasted text (1 line)" }]
        }
      });
      return { accepted: true };
    });

    expect(fixture.store.getQueueItem("quote-queue-item").body.quotesEncoded).toBe(true);
    expect(fixture.store.getQueueItem("quote-queue-item").body.pastedTextRanges)
      .toEqual([{ start: 34, end: 42, display: "Pasted text (1 line)" }]);
    expect(fixture.store.listEvents({ sessionId: "session-1" }).find((event) => event.id === "quote-user-event")?.payload)
      .toMatchObject({
        type: "message_complete",
        role: "user",
        quotesEncoded: true,
        pastedTextRanges: [{ start: 34, end: 42, display: "Pasted text (1 line)" }]
      });
  });

  it("publishes only committed events and returns a cursor-consistent snapshot", () => {
    const { store } = createFixture();
    const published: bigint[] = [];
    store.subscribe((event) => {
      published.push(event.globalCursor);
    });

    store.transaction((transaction) => {
      transaction.appendEvent({
        id: "event-committed",
        backendId: "pi",
        targetId: "target-1",
        sessionId: "session-1",
        generation: 0,
        traceId: "committed",
        payload: { type: "status", key: "credential", text: "sk-abcdefghijklmnop" }
      });
      expect(transaction.listEvents().some((event) => event.id === "event-committed")).toBe(true);
      expect(published).toEqual([]);
    });
    expect(published).toHaveLength(1);

    expect(() => store.transaction((transaction) => {
      transaction.appendEvent({
        id: "event-rolled-back",
        backendId: "pi",
        targetId: "target-1",
        sessionId: "session-1",
        generation: 0,
        traceId: "rolled-back",
        payload: { type: "status", key: "rollback" }
      });
      throw new Error("rollback");
    })).toThrow("rollback");

    const events = store.listEvents();
    expect(events.some((event) => event.id === "event-rolled-back")).toBe(false);
    expect(published).toHaveLength(1);
    const committed = events.find((event) => event.id === "event-committed");
    expect(committed?.payload).toEqual({
      type: "status",
      key: "credential",
      text: "[REDACTED]"
    });
    const snapshot = store.getSessionSnapshot("session-1");
    expect(snapshot.globalCursor).toBe(events.at(-1)?.globalCursor);
    expect(snapshot.eventSequence).toBe(events.at(-1)?.sequence);
    expect(snapshot.revision).toBeGreaterThanOrEqual(committed?.revision ?? 0n);
    expect(store.listEvents({ afterCursor: committed?.globalCursor })).toEqual([]);
  });

  it("supports bounded multi-task descending event history with cursor and time fences", () => {
    const { store } = createFixture();
    const source = store.getSession("session-1").descriptor;
    store.createSession({
      ...source,
      id: "session-history-2",
      title: "History two",
      binding: { opaqueRef: "native/history-two.jsonl", generation: 0 },
      createdAt: 2,
      updatedAt: 2
    });
    const first = store.appendEvent({
      id: "history-first",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 0,
      emittedAt: 100,
      traceId: "history:first",
      payload: { type: "status", key: "first" }
    });
    const second = store.appendEvent({
      id: "history-second",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-history-2",
      generation: 0,
      emittedAt: 200,
      traceId: "history:second",
      payload: { type: "status", key: "second" }
    });
    const third = store.appendEvent({
      id: "history-third",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 0,
      emittedAt: 300,
      traceId: "history:third",
      payload: { type: "status", key: "third" }
    });

    expect(store.listEvents({
      sessionIds: ["session-1", "session-history-2"],
      targetId: "target-1",
      emittedFrom: 150,
      emittedBefore: 301,
      order: "desc"
    }).map((event) => event.id)).toEqual([third.id, second.id]);
    expect(store.listEvents({
      sessionIds: ["session-1", "session-history-2"],
      beforeCursor: third.globalCursor,
      order: "desc",
      limit: 1
    }).map((event) => event.id)).toEqual([second.id]);
    expect(store.listEvents({
      sessionIds: ["session-1", "session-history-2"],
      afterCursor: first.globalCursor,
      limit: 1
    }).map((event) => event.id)).toEqual([second.id]);
    expect(store.listEvents({ sessionIds: [] })).toEqual([]);
    expect(() => store.listEvents({
      sessionId: "session-1",
      sessionIds: ["session-history-2"]
    })).toThrow("cannot combine one Session ID with a Session ID list");
    expect(() => store.listEvents({
      afterCursor: first.globalCursor,
      beforeCursor: third.globalCursor
    })).toThrow("cannot page after and before a cursor at the same time");
  });

  it("uses optimistic revisions and active-state checks to fence revoke races", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-1",
      name: "Desktop",
      authKeyDigest: "digest-value"
    });
    const revoked = store.revokeConnection(connection.id, connection.revision);
    expect(revoked.state).toBe("revoked");
    expect(() => store.revokeConnection(connection.id, connection.revision)).toThrow(RevisionConflictError);
    expect(() => store.runAuthorizedOperation(
      "connection-1",
      "digest-value",
      { id: "operation-after-revoke", kind: "mutation", body: { value: 1 } },
      () => "forbidden"
    )).toThrow(AuthorizationError);
  });

  it("persists one device with multiple independently revocable connections", () => {
    const store = createStore();
    const first = store.createConnection({
      id: "connection-device-a",
      deviceId: "device-shared",
      device: {
        name: "Shared desktop",
        kind: "desktop",
        platform: "windows",
        appVersion: "1.2.3"
      },
      name: "Desktop primary",
      authKeyDigest: "digest-device-a"
    });
    const second = store.createConnection({
      id: "connection-device-b",
      deviceId: "device-shared",
      name: "Desktop secondary",
      authKeyDigest: "digest-device-b"
    });

    expect(first.deviceId).toBe("device-shared");
    expect(second.deviceId).toBe("device-shared");
    expect(store.getDevice("device-shared")).toMatchObject({
      name: "Shared desktop",
      kind: "desktop",
      state: "active"
    });
    expect(store.listDeviceConnections("device-shared").map((item) => item.id)).toEqual([
      "connection-device-a",
      "connection-device-b"
    ]);

    store.revokeConnection(first.id);
    expect(() => store.authorizeConnection(first.id, first.authKeyDigest)).toThrow(AuthorizationError);
    expect(store.authorizeConnection(second.id, second.authKeyDigest).id).toBe(second.id);

    const result = store.revokeDevice("device-shared");
    expect(result.device.state).toBe("revoked");
    expect(result.connections.map((item) => item.state)).toEqual(["revoked", "revoked"]);
    expect(() => store.authorizeConnection(second.id, second.authKeyDigest)).toThrow(AuthorizationError);
  });

  it("persists fenced bidirectional device-control consent independently of pairing", () => {
    const store = createStore();
    store.createConnection({
      id: "connection-controller",
      deviceId: "device-controller",
      device: { name: "Desk controller", kind: "desktop" },
      name: "Controller",
      authKeyDigest: "controller-digest"
    });
    store.createConnection({
      id: "connection-target",
      deviceId: "device-target",
      device: { name: "Workstation", kind: "desktop" },
      name: "Target",
      authKeyDigest: "target-digest"
    });

    const target = store.getDevice("device-target");
    expect(target.remoteControlEnabled).toBe(false);
    const enabled = store.setDeviceRemoteControlEnabled(target.id, true, target.revision);
    expect(enabled.remoteControlEnabled).toBe(true);
    expect(() => store.setDeviceRemoteControlEnabled(target.id, false, target.revision))
      .toThrow(RevisionConflictError);

    const defaultRelation = store.getDeviceControlRelation("device-controller", "device-target");
    expect(defaultRelation).toMatchObject({ outboundEnabled: true, inboundAllowed: true, revision: 0n });
    const outboundDisabled = store.setDeviceControlRelation({
      controllerDeviceId: "device-controller",
      targetDeviceId: "device-target",
      outboundEnabled: false,
      expectedRevision: 0n,
      updatedAt: 123
    });
    expect(outboundDisabled).toMatchObject({ outboundEnabled: false, inboundAllowed: true, updatedAt: 123 });
    const inboundDenied = store.setDeviceControlRelation({
      controllerDeviceId: "device-controller",
      targetDeviceId: "device-target",
      inboundAllowed: false,
      expectedRevision: outboundDisabled.revision,
      updatedAt: 456
    });
    expect(inboundDenied).toMatchObject({ outboundEnabled: false, inboundAllowed: false, updatedAt: 456 });
    expect(store.listDeviceControlRelations("device-target")).toEqual([inboundDenied]);
    expect(() => store.setDeviceControlRelation({
      controllerDeviceId: "device-controller",
      targetDeviceId: "device-target",
      outboundEnabled: true,
      expectedRevision: outboundDisabled.revision
    })).toThrow(RevisionConflictError);

    const renamed = store.renameDevice("device-target", "Renamed workstation", enabled.revision);
    expect(renamed.name).toBe("Renamed workstation");
  });

  it("validates active device and digest before touching connection activity", () => {
    const store = createStore();
    const connection = store.createConnection({
      id: "connection-no-touch",
      name: "No touch",
      authKeyDigest: "correct-digest"
    });

    expect(() => store.authorizeConnection(connection.id, "wrong-digest", { touch: true, seenAt: 123 }))
      .toThrow(AuthorizationError);
    expect(store.getConnection(connection.id).lastSeenAt).toBeUndefined();
    expect(store.getDevice(connection.deviceId).lastSeenAt).toBeUndefined();

    const touched = store.authorizeConnection(connection.id, connection.authKeyDigest, { touch: true, seenAt: 456 });
    expect(touched.lastSeenAt).toBe(456);
    expect(store.getDevice(connection.deviceId).lastSeenAt).toBe(456);
    const revision = touched.revision;
    store.authorizeConnection(connection.id, connection.authKeyDigest);
    expect(store.getConnection(connection.id).revision).toBe(revision);
  });

  it("consumes pairing codes once and binds the resulting connection atomically", () => {
    const store = createStore();
    store.createPairing({
      id: "pairing-1",
      codeDigest: "pairing-code-digest",
      label: "Desktop",
      expiresAt: Date.now() + 60_000
    });
    const connection = store.consumePairing({
      pairingId: "pairing-1",
      codeDigest: "pairing-code-digest",
      connectionId: "connection-1",
      connectionName: "Desktop",
      authKeyDigest: "connection-key-digest"
    });

    expect(connection.state).toBe("active");
    expect(store.getPairing("pairing-1").consumedConnectionId).toBe("connection-1");
    expect(() => store.consumePairing({
      pairingId: "pairing-1",
      codeDigest: "pairing-code-digest",
      connectionId: "connection-2",
      connectionName: "Other",
      authKeyDigest: "other-key-digest"
    })).toThrow("already consumed");
  });

  it("prunes expired challenges and consumed pairings beyond their audit-retention cutoff", () => {
    const store = createStore();
    for (const [id, createdAt, expiresAt] of [
      ["consumed-old", 1, 200],
      ["consumed-recent", 2, 200],
      ["expired-unused", 3, 80],
      ["active-unused", 4, 120]
    ] as const) {
      store.createPairing({ id, codeDigest: `digest-${id}`, createdAt, expiresAt });
    }
    store.consumePairing({
      pairingId: "consumed-old",
      codeDigest: "digest-consumed-old",
      connectionId: "connection-consumed-old",
      connectionName: "Old",
      authKeyDigest: "auth-consumed-old",
      consumedAt: 40
    });
    store.consumePairing({
      pairingId: "consumed-recent",
      codeDigest: "digest-consumed-recent",
      connectionId: "connection-consumed-recent",
      connectionName: "Recent",
      authKeyDigest: "auth-consumed-recent",
      consumedAt: 50
    });

    expect(store.prunePairings({ expiredBefore: 100, consumedBefore: 45 })).toBe(2);
    expect(store.listPairings().map((pairing) => pairing.id).sort()).toEqual([
      "active-unused",
      "consumed-recent"
    ]);
    expect(store.prunePairings({ expiredBefore: 100, consumedBefore: 45 })).toBe(0);
    expect(() => store.prunePairings({ expiredBefore: 100, consumedBefore: Number.NaN })).toThrow(RangeError);
  });

  it("records a redacted failure tombstone for deterministic operation retries", () => {
    const store = createStore();
    expect(() => store.runOperation(
      { id: "operation-failed", kind: "test", body: { value: 1 } },
      () => {
        throw new Error("provider rejected sk-abcdefghijklmnop");
      }
    )).toThrow("provider rejected");

    expect(store.getOperation("operation-failed").error).toMatchObject({
      name: "Error",
      message: "provider rejected [REDACTED]"
    });
    expect(() => store.runOperation(
      { id: "operation-failed", kind: "test", body: { value: 1 } },
      () => "not-called"
    )).toThrow(OperationPreviouslyFailedError);
  });

  it("persists interactions, schedules, leases, artifacts, settings, and diagnostics", () => {
    const { store, prompt } = createFixture();
    const now = Date.now();
    store.openInteraction({
      sessionId: "session-1",
      runId: "run-1",
      generation: 0,
      traceId: "interaction-open",
      payload: {
        id: "interaction-1",
        kind: "question",
        title: "Choose",
        prompt: "Continue?",
        fields: [{
          id: "answer",
          label: "Choose",
          required: true,
          kind: "single",
          choices: [
            { id: "yes", label: "yes" },
            { id: "no", label: "no" }
          ]
        }]
      }
    });
    expect(store.resolveInteraction(
      "interaction-1", 0, { option: "yes" }, "interaction-resolve"
    ).status).toBe("resolved");

    const schedule = store.upsertSchedule({
      id: "schedule-1",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "bound",
      sessionId: "session-1",
      name: "Daily",
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "Asia/Shanghai",
      enabled: true,
      prompt,
      executionSnapshot: { permissionMode: "ask" },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      nextRunAt: now,
      expectedRevision: 0n
    });
    expect(schedule).toMatchObject({
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    expect(store.listDueSchedules(now)).toHaveLength(1);
    expect(store.recordScheduleRun(schedule.id, "run-1", "started")).toMatchObject({
      status: "started",
      sessionId: "session-1"
    });

    const firstLease = store.acquireToolLease({
      id: "lease-1",
      toolId: "browser",
      sessionId: "session-1",
      runId: "run-1",
      generation: 0,
      expiresAt: now + 60_000
    });
    const secondLease = store.acquireToolLease({
      id: "lease-2",
      toolId: "browser",
      sessionId: "session-1",
      runId: "run-1",
      generation: 0,
      expiresAt: now + 60_000
    });
    expect(secondLease.fencingToken).toBe(firstLease.fencingToken + 1n);
    expect(store.getToolLease("lease-1").state).toBe("revoked");
    expect(store.assertToolLease("lease-2", secondLease.fencingToken).id).toBe("lease-2");

    const artifact = store.putArtifact({
      id: "artifact-1",
      sha256: "a".repeat(64),
      byteLength: 12,
      mimeType: "text/plain",
      storageKey: "sha256/aa/" + "a".repeat(64),
      sessionId: "session-1",
      runId: "run-1",
      metadata: { authorization: "Bearer abcdefghijklmnop" },
      purpose: "output",
      traceId: "artifact"
    });
    expect(artifact.metadata).toEqual({ authorization: "[REDACTED]" });

    expect(store.setSetting("session", "session-1", "provider", {
      apiKey: "sk-abcdefghijklmnop",
      model: "test"
    }).value).toEqual({ apiKey: "[REDACTED]", model: "test" });
    expect(store.appendDiagnostic({
      severity: "error",
      component: "adapter-pi",
      code: "provider_error",
      message: "Bearer abcdefghijklmnop failed",
      details: { password: "do-not-store" }
    })).toMatchObject({
      message: "Bearer [REDACTED] failed",
      details: { password: "[REDACTED]" }
    });
  });

  it("joins a persisted pre-session schedule occurrence to the eventual product Run", () => {
    const { store, prompt } = createFixture();
    const firedAt = 10_000;
    const schedule = store.upsertSchedule({
      id: "schedule-pre-session-join",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh",
      name: "Pre-session join",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: { permissionMode: "ask" },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      now: firedAt
    });
    const beforeAdmission = store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: "run-schedule-join",
      firedAt,
      status: "preflight_passed",
      detail: { preRunHook: { status: "passed", decision: "run" } }
    });
    expect(beforeAdmission).toMatchObject({
      runId: "run-schedule-join",
      status: "preflight_passed",
      detail: { preRunHook: { status: "passed", decision: "run" } }
    });
    expect(beforeAdmission).not.toHaveProperty("sessionId");

    store.createRun({
      id: "run-schedule-join",
      sessionId: "session-1",
      source: "schedule",
      state: "queued",
      createdAt: firedAt
    });
    const admitted = store.recordScheduleRun(
      schedule.id,
      "run-schedule-join",
      "queued",
      undefined,
      firedAt
    );
    expect(admitted.id).toBe(beforeAdmission.id);
    expect(admitted).toMatchObject({
      sessionId: "session-1",
      status: "queued",
      detail: { preRunHook: { status: "passed", decision: "run" } }
    });

    store.updateRunState({
      runId: "run-schedule-join",
      state: "running",
      startedAt: firedAt + 100,
      traceId: "schedule-join:running"
    });
    const scheduledSession = store.getSession("session-1").descriptor;
    store.appendEvent({
      backendId: scheduledSession.backendId,
      targetId: scheduledSession.targetId,
      sessionId: "session-1",
      runId: "run-schedule-join",
      generation: scheduledSession.binding.generation,
      emittedAt: firedAt + 400,
      traceId: "schedule-join:native-done",
      payload: { type: "done", outcome: "completed" }
    });
    expect(store.findSessionAttention("session-1")).toBeUndefined();
    store.updateRunState({
      runId: "run-schedule-join",
      state: "completed",
      endedAt: firedAt + 500,
      suppressTerminalAttention: true,
      markScheduleRunRead: true,
      traceId: "schedule-join:completed"
    });
    expect(store.listScheduleRuns(schedule.id)).toEqual([
      expect.objectContaining({
        id: beforeAdmission.id,
        sessionId: "session-1",
        status: "success",
        finishedAt: firedAt + 500,
        detail: { preRunHook: { status: "passed", decision: "run" }, readAt: firedAt + 500 },
        readAt: firedAt + 500
      })
    ]);
  });

  it("pages and reorders an accepted queue beyond the former ten-thousand-item boundary", () => {
    const fixture = createFixture();
    const filePath = fixture.store.filePath;
    fixture.store.close();
    const database = new DatabaseSync(filePath);
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      database.exec(`
        WITH RECURSIVE sequence(value) AS (
          VALUES(0)
          UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
        )
        INSERT INTO operations(
          id, kind, body_hash, completion_mode, status, body_json,
          created_at, updated_at, revision
        )
        SELECT
          'bulk-operation-' || value, 'prompt', 'sha256:bulk', 'transactional', 'completed', '{}',
          1000 + value, 1000 + value, 1
        FROM sequence;

        WITH RECURSIVE sequence(value) AS (
          VALUES(0)
          UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
        )
        INSERT INTO runs(
          id, session_id, source, state, created_at, revision
        )
        SELECT 'bulk-run-' || value, 'session-1', 'user', 'queued', 1000 + value, 1
        FROM sequence;

        WITH RECURSIVE sequence(value) AS (
          VALUES(0)
          UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
        )
        INSERT INTO queue_items(
          id, session_id, run_id, operation_id, disposition, state,
          body_hash, body_json, position, created_at, updated_at, revision
        )
        SELECT
          'bulk-queue-' || value, 'session-1', 'bulk-run-' || value, 'bulk-operation-' || value,
          'prompt', 'accepted', 'sha256:bulk',
          '{"text":"bulk","images":[],"files":[],"mentions":[],"disposition":"prompt"}',
          value, 1000 + value, 1000 + value, 1
        FROM sequence;
      `);
    } finally {
      database.close();
    }
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);

    expect(reopened.countQueueItems({ sessionId: "session-1", states: ["accepted"] })).toBe(10_001);
    expect(reopened.listQueueItems({
      sessionId: "session-1",
      states: ["accepted"],
      limit: 2,
      offset: 9_999
    }).map((item) => item.id)).toEqual(["bulk-queue-9999", "bulk-queue-10000"]);
    expect(reopened.findQueueItemByRunId("session-1", "bulk-run-10000")?.id).toBe("bulk-queue-10000");

    reopened.reorderQueueItem({
      queueItemId: "bulk-queue-10000",
      placement: { beforeQueueItemId: "bulk-queue-0" },
      traceId: "bulk:reorder",
      at: 20_000
    });
    expect(reopened.listQueueItems({
      sessionId: "session-1",
      states: ["accepted"],
      limit: 2
    }).map((item) => [item.id, item.position])).toEqual([
      ["bulk-queue-10000", 0],
      ["bulk-queue-0", 1]
    ]);
  });

  it("finds a workspace-diff projection after the first 100000 Events", { timeout: 20_000 }, () => {
    const fixture = createFixture();
    const filePath = fixture.store.filePath;
    fixture.store.close();
    const database = new DatabaseSync(filePath);
    try {
      const counter = database.prepare(
        "SELECT last_sequence FROM session_event_counters WHERE session_id = 'session-1'"
      ).get() as { readonly last_sequence: number };
      const baseSequence = Number(counter.last_sequence);
      database.exec(`
        WITH digits(value) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ), numbers(value) AS (
          SELECT ones.value + tens.value * 10 + hundreds.value * 100 +
            thousands.value * 1000 + ten_thousands.value * 10000 + 1
          FROM digits AS ones
          CROSS JOIN digits AS tens
          CROSS JOIN digits AS hundreds
          CROSS JOIN digits AS thousands
          CROSS JOIN digits AS ten_thousands
        )
        INSERT INTO events(
          id, revision, session_sequence, emitted_at, backend_id, target_id,
          session_id, generation, trace_id, payload_json
        )
        SELECT
          'workspace-filler-' || value,
          1,
          ${baseSequence} + value,
          1000 + value,
          'pi',
          'target-1',
          'session-1',
          0,
          'workspace-filler:' || value,
          '{"payload":{"type":"status","key":"test.workspace_filler","text":""}}'
        FROM numbers
        WHERE value <= 100000;

        INSERT INTO events(
          id, revision, session_sequence, emitted_at, backend_id, target_id,
          session_id, generation, trace_id, payload_json
        ) VALUES (
          'workspace-diff-tail', 1, ${baseSequence + 100_001}, 200000,
          'pi', 'target-1', 'session-1', 0, 'workspace-diff:tail',
          '{"payload":{"type":"workspace_diff","changeSetId":"change-tail","summary":"tail"}}'
        );

        UPDATE session_event_counters
        SET last_sequence = ${baseSequence + 100_001}
        WHERE session_id = 'session-1';
      `);
    } finally {
      database.close();
    }
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);

    expect(reopened.listEvents({ sessionId: "session-1", limit: 100_000 })
      .some((event) => event.id === "workspace-diff-tail")).toBe(false);
    expect(reopened.hasVisibleWorkspaceDiff("session-1", "change-tail")).toBe(true);
  });

  it("applies public-list filters consistently to exact counts and offset pages", () => {
    const { store } = createFixture();
    store.runOperation({
      id: "operation-filtered-page",
      kind: "filtered",
      body: { nested: { sessionId: "session-1", targetId: "target-1" } },
      createdAt: 10
    }, () => ({ accepted: true, sessionId: "session-1", targetId: "target-1" }));
    store.createRun({
      id: "run-filtered-page",
      sessionId: "session-1",
      source: "system",
      state: "completed",
      createdAt: 11,
      startedAt: 12,
      endedAt: 17
    });

    expect(store.countOperations({ sessionId: "session-1", targetId: "target-1", status: "completed" })).toBe(1);
    expect(store.listOperations({
      sessionId: "session-1",
      targetId: "target-1",
      status: "completed",
      limit: 1,
      offset: 0
    }).map((item) => item.id)).toEqual(["operation-filtered-page"]);
    expect(store.countRuns({ targetId: "target-1", states: ["completed"] })).toBe(1);
    expect(store.listRuns({ targetId: "target-1", limit: 1, offset: 1 }).map((item) => item.descriptor.id))
      .toEqual(["run-1"]);
    expect(store.sumRunActiveDuration({ sessionId: "session-1" })).toBe(5);
    expect(store.countQueueItems({ targetId: "target-1", states: ["accepted"] })).toBe(0);
    expect(store.countReviewRuns({ sourceSessionId: "session-1", state: "running" })).toBe(0);
    expect(store.listReviewRuns({ sourceSessionId: "session-1", limit: 1, offset: 1 })).toEqual([]);
    expect(store.countScheduleRuns("schedule-missing")).toBe(0);
    expect(store.listScheduleRuns("schedule-missing", 1, 1)).toEqual([]);
    expect(store.countInteractions({
      sessionId: "session-1",
      runId: "run-1",
      kinds: ["question"],
      statuses: ["dismissed"],
      excludeDismissalReason: "expired"
    })).toBe(0);
    expect(store.countArtifacts({ sessionId: "session-1", runId: "run-1", kind: "image" })).toBe(0);
    expect(store.listArtifacts({ kind: "file", limit: 1, offset: 1 })).toEqual([]);
  });

  it("preserves preflight detail and redacts terminal schedule failure detail", () => {
    const { store, prompt } = createFixture();
    const firedAt = 20_000;
    const schedule = store.upsertSchedule({
      id: "schedule-terminal-failure",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "bound",
      sessionId: "session-1",
      name: "Terminal failure",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: { permissionMode: "ask" },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      now: firedAt
    });
    store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: "run-schedule-failure",
      firedAt,
      status: "preflight_passed",
      detail: { preRunHook: { status: "passed", decision: "run" } }
    });
    store.createRun({
      id: "run-schedule-failure",
      sessionId: "session-1",
      source: "schedule",
      state: "queued",
      createdAt: firedAt
    });
    store.recordScheduleRun(schedule.id, "run-schedule-failure", "queued", undefined, firedAt);

    store.updateRunState({
      runId: "run-schedule-failure",
      state: "failed",
      endedAt: firedAt + 250,
      error: publicTestError("provider_error", "provider rejected sk-abcdefghijklmnop"),
      traceId: "schedule-failure:failed"
    });
    expect(store.listScheduleRuns(schedule.id)[0]).toMatchObject({
      status: "failed",
      finishedAt: firedAt + 250,
      detail: {
        preRunHook: { status: "passed", decision: "run" },
        error: {
          code: "provider_error",
          message: "provider rejected [REDACTED]"
        }
      }
    });
  });

  it("persists Schedule run read state, preserves it across detail updates, and deletes only terminal history", () => {
    const { store, prompt } = createFixture();
    const schedule = store.upsertSchedule({
      id: "schedule-history-actions",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh",
      name: "History actions",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: { permissionMode: "ask" },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      now: 30_000
    });
    const failed = store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: "run-history-failed",
      firedAt: 30_000,
      finishedAt: 30_500,
      status: "failed",
      detail: { reason: "blocked" }
    });
    expect(failed.readAt).toBeUndefined();

    const read = store.markScheduleRunRead(schedule.id, failed.id, 31_000);
    expect(read).toMatchObject({ readAt: 31_000, detail: { reason: "blocked", readAt: 31_000 } });
    expect(store.markScheduleRunRead(schedule.id, failed.id, 32_000)).toEqual(read);
    expect(store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: failed.runId,
      firedAt: failed.firedAt,
      finishedAt: 30_500,
      status: "failed",
      detail: { reason: "updated" }
    })).toMatchObject({ readAt: 31_000, detail: { reason: "updated", readAt: 31_000 } });

    const skipped = store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: "run-history-skipped",
      firedAt: 32_000,
      finishedAt: 32_100,
      status: "skipped",
      detail: { costAttribution: "zero" }
    });
    expect(skipped.readAt).toBe(32_100);

    const running = store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: "run-history-running",
      firedAt: 33_000,
      status: "running"
    });
    expect(() => store.markScheduleRunRead(schedule.id, running.id, 33_100)).toThrow(/terminal/u);
    expect(() => store.deleteScheduleRun(schedule.id, running.id)).toThrow(/terminal/u);

    const aborted = store.recordScheduleOccurrence({
      scheduleId: schedule.id,
      runId: "run-history-aborted",
      firedAt: 34_000,
      finishedAt: 34_100,
      status: "aborted"
    });
    expect(store.markScheduleRunsRead(schedule.id, 35_000)).toBe(1);
    expect(store.getScheduleRun(aborted.id).readAt).toBe(35_000);
    expect(store.markScheduleRunsRead(schedule.id, 36_000)).toBe(0);

    const other = store.upsertSchedule({ ...schedule, id: "schedule-history-actions-other", now: 36_000 });
    const otherFailed = store.recordScheduleOccurrence({
      scheduleId: other.id,
      runId: "run-history-other-failed",
      firedAt: 36_000,
      finishedAt: 36_100,
      status: "failed"
    });
    expect(store.markAllScheduleRunsRead(37_000)).toBe(1);
    expect(store.getScheduleRun(otherFailed.id).readAt).toBe(37_000);

    expect(store.deleteScheduleRun(schedule.id, failed.id)).toMatchObject({ runId: failed.runId });
    expect(store.listScheduleRuns(schedule.id).map((run) => run.runId)).toEqual([
      aborted.runId,
      running.runId,
      skipped.runId
    ]);
  });

  it("persists an interval anchor across scheduler-style updates and process restart", () => {
    const fixture = createFixture();
    const anchorAt = 1_234;
    const schedule = fixture.store.upsertSchedule({
      id: "schedule-interval-anchor",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "bound",
      sessionId: "session-1",
      name: "Anchored interval",
      kind: "interval",
      expression: "10000",
      anchorAt,
      timezone: "UTC",
      enabled: true,
      prompt: fixture.prompt,
      executionSnapshot: { permissionMode: "ask" },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      nextRunAt: 11_234,
      now: 9_000
    });

    const advanced = fixture.store.upsertSchedule({
      id: schedule.id,
      backendId: schedule.backendId,
      targetId: schedule.targetId,
      sessionMode: schedule.sessionMode,
      ...(schedule.sessionId === undefined ? {} : { sessionId: schedule.sessionId }),
      name: schedule.name,
      kind: schedule.kind,
      ...(schedule.expression === undefined ? {} : { expression: schedule.expression }),
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      prompt: schedule.prompt,
      executionSnapshot: schedule.executionSnapshot,
      overlapPolicy: schedule.overlapPolicy,
      misfirePolicy: schedule.misfirePolicy,
      nextRunAt: 21_234,
      lastRunAt: 11_234,
      expectedRevision: schedule.revision,
      now: 12_000
    });
    expect(advanced).toMatchObject({ anchorAt, nextRunAt: 21_234, lastRunAt: 11_234 });

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.getSchedule(schedule.id)).toMatchObject({ anchorAt, nextRunAt: 21_234 });
  });

  it("requires only bound schedules to carry a Session binding", () => {
    const { store, prompt } = createFixture();
    expect(() => store.upsertSchedule({
      id: "schedule-unbound",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "bound",
      name: "Unbound",
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: {},
      overlapPolicy: "skip",
      misfirePolicy: "skip",
      nextRunAt: 10_000
    })).toThrow(/require a Session binding/u);

    const fresh = store.upsertSchedule({
      id: "schedule-fresh",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "fresh",
      name: "Fresh",
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: {},
      overlapPolicy: "skip",
      misfirePolicy: "skip",
      nextRunAt: 10_000
    });
    expect(fresh.sessionMode).toBe("fresh");
    expect(fresh.sessionId).toBeUndefined();
  });

  it("atomically binds the first generated task for a persistent schedule", () => {
    const { store, prompt } = createFixture();
    const schedule = store.upsertSchedule({
      id: "schedule-persistent",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "persistent",
      name: "Persistent",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt,
      executionSnapshot: {},
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });

    expect(store.bindPersistentScheduleSession(
      schedule.id,
      "session-1",
      schedule.revision,
      20_000
    )).toMatchObject({ sessionMode: "persistent", sessionId: "session-1", updatedAt: 20_000 });
    expect(() => store.bindPersistentScheduleSession(
      schedule.id,
      "session-1",
      schedule.revision,
      21_000
    )).toThrow(RevisionConflictError);
  });

  it("allows independent artifact records to share one content-addressed storage key", () => {
    const store = createStore();
    const storageKey = "sha256/aa/" + "a".repeat(64);
    store.putArtifact({
      id: "artifact-shared-one",
      sha256: "a".repeat(64),
      byteLength: 12,
      mimeType: "text/plain",
      fileName: "one.txt",
      storageKey,
      metadata: { expiresAt: 10 }
    });
    store.putArtifact({
      id: "artifact-shared-two",
      sha256: "a".repeat(64),
      byteLength: 12,
      mimeType: "text/plain",
      fileName: "two.txt",
      storageKey,
      metadata: { owner: "permanent" }
    });

    expect(store.listArtifacts().filter((artifact) => artifact.storageKey === storageKey)).toHaveLength(2);
    store.deleteArtifact("artifact-shared-one", 20);
    expect(store.listArtifacts().filter((artifact) => artifact.storageKey === storageKey).map((artifact) => artifact.blob.id))
      .toEqual(["artifact-shared-two"]);
  });

  it("round-trips Backend Provider and tool catalogs without losing typed metadata", () => {
    const store = createStore();
    const backend = store.upsertBackend({
      id: "tool-backend",
      adapterKind: "tool-runtime",
      instanceGeneration: 7,
      displayName: "Tool Backend",
      version: "test-latest",
      health: "healthy",
      installationState: "update_available",
      authenticationState: "refreshing",
      error: {
        code: "BACKEND_REFRESH_PENDING",
        message: "Account state is refreshing.",
        phase: "authentication",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Wait for the refresh to finish."
      },
      capabilities: new Map(),
      providers: [{
        providerId: "provider-one",
        displayName: "Provider One",
        api: "openai-responses",
        authenticationState: "signed_out",
        loginMethods: ["api_key", "oauth_browser"],
        supportsLogin: true,
        supportsLogout: false,
        supportsRefresh: true,
        supportsModelRefresh: true
      }],
      models: [],
      tools: [{
        toolId: "shell",
        name: "shell",
        displayName: "Shell",
        description: "Run an authorized shell command.",
        inputSchema: {
          fields: [{
            fieldPath: "command",
            title: "Command",
            description: "Command line.",
            type: "string",
            required: true,
            secret: false,
            enumValues: [],
            constraints: { minimumLength: 1, maximumLength: 32_768 }
          }],
          allowsAdditionalFields: false
        },
        requiresPermission: true,
        streamingUpdates: true,
        enabled: true
      }],
      diagnostics: []
    });

    expect(backend.descriptor.tools).toEqual([expect.objectContaining({
      toolId: "shell",
      inputSchema: expect.objectContaining({
        fields: [expect.objectContaining({ fieldPath: "command", constraints: { minimumLength: 1, maximumLength: 32_768 } })]
      })
    })]);
    expect(backend.descriptor).toMatchObject({
      adapterKind: "tool-runtime",
      instanceGeneration: 7,
      installationState: "update_available",
      authenticationState: "refreshing",
      providers: [expect.objectContaining({
        providerId: "provider-one",
        loginMethods: ["api_key", "oauth_browser"]
      })],
      error: { code: "BACKEND_REFRESH_PENDING" }
    });
    expect(() => store.upsertBackend({
      ...backend.descriptor,
      instanceGeneration: 6
    })).toThrow(/generation cannot move backwards/u);
    expect(() => store.upsertBackend({
      ...backend.descriptor,
      instanceGeneration: 8
    })).toThrow(/reserved expected-current publication/u);
    expect(() => store.upsertBackend({
      ...backend.descriptor,
      adapterKind: "replacement-kind",
      instanceGeneration: 8
    })).toThrow(/kind is immutable/u);
    expect(() => store.upsertBackend({
      ...backend.descriptor,
      instanceGeneration: Number.NaN
    })).toThrow(/non-negative safe integer/u);
    expect(() => store.upsertBackend({
      ...backend.descriptor,
      adapterKind: " tool-runtime"
    })).toThrow(/non-empty normalized string/u);
  });

  it("reserves non-reusable per-Backend generations and publishes only the latest expected-current winner", () => {
    const store = createStore();
    const first = store.reserveBackendInstanceGeneration({
      backendId: "durable-backend",
      adapterKind: "fixture-runtime"
    }, 10);
    expect(first).toMatchObject({
      generation: 1,
      highWaterGeneration: 1
    });
    expect(first.currentGeneration).toBeUndefined();
    expect(first.expectedCurrentGeneration).toBeUndefined();

    const initial = store.publishBackendInstanceDescriptor({
      descriptor: backendAuthorityDescriptor("durable-backend", "fixture-runtime", 1)
    }, 11);
    expect(initial).toMatchObject({
      status: "published",
      backend: { descriptor: { instanceGeneration: 1 } },
      authority: { currentGeneration: 1, highWaterGeneration: 1 }
    });

    const superseded = store.reserveBackendInstanceGeneration({
      backendId: "durable-backend",
      adapterKind: "fixture-runtime"
    }, 12);
    const latest = store.reserveBackendInstanceGeneration({
      backendId: "durable-backend",
      adapterKind: "fixture-runtime"
    }, 13);
    expect(superseded).toMatchObject({ generation: 2, expectedCurrentGeneration: 1 });
    expect(latest).toMatchObject({ generation: 3, expectedCurrentGeneration: 1 });

    const revisionBeforeStalePublish = store.health().revision;
    expect(store.publishBackendInstanceDescriptor({
      descriptor: backendAuthorityDescriptor("durable-backend", "fixture-runtime", 2),
      expectedCurrentGeneration: 1
    }, 14)).toMatchObject({
      status: "stale",
      current: { descriptor: { instanceGeneration: 1 } },
      authority: { highWaterGeneration: 3, currentGeneration: 1 }
    });
    expect(store.health().revision).toBe(revisionBeforeStalePublish);
    expect(store.publishBackendInstanceDescriptor({
      descriptor: backendAuthorityDescriptor("durable-backend", "fixture-runtime", 3),
      expectedCurrentGeneration: 1
    }, 15)).toMatchObject({
      status: "published",
      backend: { descriptor: { instanceGeneration: 3 } },
      authority: { highWaterGeneration: 3, currentGeneration: 3 }
    });

    const refreshed = store.refreshBackendInstanceDescriptor({
      ...backendAuthorityDescriptor("durable-backend", "fixture-runtime", 3),
      health: "degraded"
    }, 3, 16);
    expect(refreshed).toMatchObject({
      status: "published",
      backend: { descriptor: { instanceGeneration: 3, health: "degraded" } },
      authority: { highWaterGeneration: 3, currentGeneration: 3 }
    });
    expect(store.refreshBackendInstanceDescriptor(
      backendAuthorityDescriptor("durable-backend", "fixture-runtime", 1),
      1,
      17
    )).toMatchObject({
      status: "stale",
      current: { descriptor: { instanceGeneration: 3, health: "degraded" } }
    });
  });

  it("keeps Adapter kind immutable and fails closed at generation exhaustion", () => {
    const store = createStore();
    expect(store.reserveBackendInstanceGeneration({
      backendId: "kind-fenced",
      adapterKind: "first-kind"
    })).toMatchObject({ generation: 1 });
    expect(() => store.reserveBackendInstanceGeneration({
      backendId: "kind-fenced",
      adapterKind: "second-kind"
    })).toThrow(/kind is immutable/u);
    expect(store.getBackendInstanceGenerationAuthority("kind-fenced").highWaterGeneration).toBe(1);

    store.upsertBackend(backendAuthorityDescriptor(
      "exhausted-backend",
      "fixture-runtime",
      Number.MAX_SAFE_INTEGER
    ));
    expect(() => store.reserveBackendInstanceGeneration({
      backendId: "exhausted-backend",
      adapterKind: "fixture-runtime"
    })).toThrow(/generation is exhausted/u);
    expect(store.getBackendInstanceGenerationAuthority("exhausted-backend")).toMatchObject({
      highWaterGeneration: Number.MAX_SAFE_INTEGER,
      currentGeneration: Number.MAX_SAFE_INTEGER
    });
  });

  it("distinguishes recoverable queued input from interruptible dispatch and run activity", () => {
    const fixture = createFixture();
    expect(fixture.store.inspectDurableRuntimeActivity(10_000)).toEqual({
      run: false,
      queueDispatch: false,
      interaction: false,
      toolLease: false,
      backgroundTask: false,
      review: false,
      operation: false
    });

    fixture.store.createAttempt({
      id: "activity-attempt",
      runId: "run-1",
      ordinal: 1,
      generation: 0,
      startedAt: 3
    });
    fixture.store.runOperation(
      { id: "activity-queue-operation", kind: "prompt", body: fixture.prompt },
      (store) => {
        store.enqueueQueueItem({
          id: "activity-queue",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "activity-attempt",
          operationId: "activity-queue-operation",
          disposition: "prompt",
          body: fixture.prompt
        });
        return { accepted: true };
      }
    );
    expect(fixture.store.inspectDurableRuntimeActivity(10_000).queueDispatch).toBe(false);

    expect(fixture.store.claimNextQueueItem({
      sessionId: "session-1",
      backendInstanceGeneration: 0,
      traceId: "activity:dispatch"
    })?.id).toBe("activity-queue");
    expect(fixture.store.inspectDurableRuntimeActivity(10_000).queueDispatch).toBe(true);
    expect(fixture.store.getAttempt("activity-attempt").descriptor.backendInstanceGeneration).toBe(0);
    fixture.store.updateRunState({
      runId: "run-1",
      state: "running",
      activeAttemptId: "activity-attempt",
      traceId: "activity:running"
    });
    expect(fixture.store.inspectDurableRuntimeActivity(10_000).run).toBe(true);

    fixture.store.updateQueueState({
      queueItemId: "activity-queue",
      state: "backend_accepted",
      attemptId: "activity-attempt",
      traceId: "activity:accepted"
    });
    fixture.store.updateQueueState({
      queueItemId: "activity-queue",
      state: "completed",
      attemptId: "activity-attempt",
      traceId: "activity:queue-complete"
    });
    fixture.store.updateRunState({
      runId: "run-1",
      state: "completed",
      activeAttemptId: "activity-attempt",
      traceId: "activity:run-complete"
    });
    expect(fixture.store.inspectDurableRuntimeActivity(10_000)).toMatchObject({
      run: false,
      queueDispatch: false
    });
  });

  it("reconstructs latest background activity across restart and clears it on a terminal observation", () => {
    const fixture = createFixture();
    const route = fixture.store.getSession("session-1").descriptor;
    const append = (state: "running" | "completed") => fixture.store.appendEvent({
      backendId: route.backendId,
      targetId: route.targetId,
      sessionId: route.id,
      generation: route.binding.generation,
      traceId: `activity:background:${state}`,
      payload: {
        type: "background_task",
        taskId: "same-native-task",
        title: "Background worker",
        state
      }
    });

    append("running");
    expect(fixture.store.inspectDurableRuntimeActivity().backgroundTask).toBe(true);
    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.inspectDurableRuntimeActivity().backgroundTask).toBe(true);

    append("completed");
    expect(reopened.inspectDurableRuntimeActivity().backgroundTask).toBe(false);
  });

  it("keeps delegated-run detail and transcript paging durable, scoped, and snapshot-stable", () => {
    const fixture = createFixture();
    const active = delegatedRun("delegated-active", "running", 10);
    const terminal = {
      ...delegatedRun("delegated-terminal", "completed", 20),
      updatedAt: 40,
      endedAt: 40,
      returnedResult: "finished result"
    } satisfies SubagentRunDetail;
    appendDelegatedRun(fixture.store, active);
    appendDelegatedRun(fixture.store, terminal);

    const first = fixture.store.listSubagentRuns({ sessionId: "session-1", limit: 1 });
    expect(first.runs.map((run) => run.id)).toEqual(["delegated-terminal"]);
    expect(first.totalSize).toBe(2);
    expect(first.nextPageToken).toBeTypeOf("string");
    expect(fixture.store.getSessionSubagentRun("session-1", "provider-delegated-active")?.run.id)
      .toBe("delegated-active");

    appendDelegatedRun(fixture.store, delegatedRun("delegated-later", "running", 30));
    const second = fixture.store.listSubagentRuns({
      sessionId: "session-1",
      pageToken: first.nextPageToken!,
      limit: 1
    });
    expect(second.runs.map((run) => run.id)).toEqual(["delegated-active"]);
    expect(second.totalSize).toBe(2);

    appendDelegatedTranscript(fixture.store, "delegated-active", {
      id: "entry-1",
      sequence: 1,
      role: "tool",
      content: "started",
      occurredAt: 11,
      childId: "child-delegated-active",
      childTitle: "Worker",
      toolName: "read",
      toolCallId: "call-1",
      toolPhase: "start",
      toolInputJson: "{\"path\":\"safe.txt\"}",
      isError: false
    });
    appendDelegatedTranscript(fixture.store, "delegated-active", {
      id: "entry-2",
      sequence: 2,
      role: "parent",
      content: "focus on validation",
      occurredAt: 12,
      isError: false,
      controlAction: "steer"
    });
    const transcriptFirst = fixture.store.listSubagentTranscript({
      sessionId: "session-1",
      subagentRunId: "provider-delegated-active",
      limit: 1
    });
    expect(transcriptFirst.entries.map((entry) => entry.id)).toEqual(["entry-1"]);
    expect(transcriptFirst.nextPageToken).toBeTypeOf("string");
    const transcriptSecond = fixture.store.listSubagentTranscript({
      sessionId: "session-1",
      subagentRunId: "delegated-active",
      pageToken: transcriptFirst.nextPageToken!,
      limit: 1
    });
    expect(transcriptSecond.entries.map((entry) => entry.id)).toEqual(["entry-2"]);
    expect(transcriptSecond.totalSize).toBe(2);

    appendDelegatedTranscript(fixture.store, "delegated-active", {
      id: "entry-3",
      sequence: 3,
      role: "system",
      content: "resumed",
      occurredAt: 13,
      isError: false,
      controlAction: "resume",
      systemEvent: { kind: "runtime_resumed", params: { source: "control" } }
    });
    const tail = fixture.store.listSubagentTranscript({
      sessionId: "session-1",
      subagentRunId: "delegated-active",
      pageToken: transcriptSecond.tailPageToken
    });
    expect(tail.entries.map((entry) => entry.id)).toEqual(["entry-3"]);
    expect(fixture.store.listSubagentTranscript({
      sessionId: "session-1",
      subagentRunId: "delegated-active",
      childId: "native-child-delegated-active"
    }).entries.map((entry) => entry.id)).toEqual(["entry-1"]);

    expect(() => appendDelegatedTranscript(fixture.store, "delegated-active", {
      id: "entry-unknown-child",
      sequence: 4,
      role: "subagent",
      content: "not owned",
      occurredAt: 14,
      childId: "different-child",
      isError: false
    })).toThrow(StoreError);
    expect(() => appendDelegatedTranscript(fixture.store, "delegated-active", {
      id: "entry-3",
      sequence: 4,
      role: "subagent",
      content: "duplicate identity",
      occurredAt: 14,
      isError: false
    })).toThrow(StoreError);
    expect(() => appendDelegatedRun(fixture.store, {
      ...delegatedRun("delegated-hidden-activity", "running", 50),
      capabilities: {
        ...delegatedRun("delegated-hidden-activity", "running", 50).capabilities,
        viewActivity: false
      }
    })).toThrow(StoreError);
    expect(() => appendDelegatedRun(fixture.store, {
      ...delegatedRun("delegated-hidden-result", "running", 60),
      capabilities: {
        ...delegatedRun("delegated-hidden-result", "running", 60).capabilities,
        viewReturnedResult: false
      }
    })).toThrow(StoreError);

    const beforeReset = fixture.store.getSession("session-1").descriptor;
    fixture.store.runOperation(
      { id: "operation:delegated-reset", kind: "reset", body: { sessionId: beforeReset.id } },
      (transaction) => {
        transaction.commitSessionReset({
          sessionId: beforeReset.id,
          sourceBinding: beforeReset.binding,
          binding: {
            opaqueRef: "native/delegated-reset.jsonl",
            nativeSessionId: "native-delegated-reset",
            generation: beforeReset.binding.generation + 1
          },
          operationId: "operation:delegated-reset",
          traceId: "delegated:reset"
        });
        return { reset: true };
      }
    );
    expect(fixture.store.listSubagentRuns({ sessionId: "session-1" }).runs).toEqual([]);
    expect(fixture.store.getSessionSubagentRun("session-1", "delegated-active")).toBeUndefined();
    expect(() => fixture.store.listSubagentRuns({
      sessionId: "session-1",
      pageToken: first.nextPageToken!
    })).toThrow(StoreError);
    expect(() => fixture.store.listSubagentTranscript({
      sessionId: "session-1",
      subagentRunId: "delegated-active",
      pageToken: transcriptSecond.tailPageToken
    })).toThrow();

    fixture.store.createRun({
      id: "run-post-reset",
      sessionId: "session-1",
      source: "user",
      state: "running",
      createdAt: 99
    });
    appendDelegatedRun(fixture.store, {
      ...delegatedRun("delegated-active", "running", 100),
      parentRunId: "run-post-reset"
    });
    appendDelegatedTranscript(fixture.store, "delegated-active", {
      id: "entry-1",
      sequence: 1,
      role: "subagent",
      content: "new generation",
      occurredAt: 101,
      isError: false
    });
    appendDelegatedTranscript(fixture.store, "delegated-active", {
      id: "entry-2",
      sequence: 2,
      role: "tool",
      content: "Bearer abcdefghijklmnop was rejected",
      occurredAt: 102,
      toolName: "read",
      toolCallId: "call-post-reset",
      toolPhase: "end",
      toolInputJson: "{\"token\":\"sk-abcdefghijklmnop\"}",
      isError: true
    });

    const filePath = fixture.store.filePath;
    fixture.store.close();
    const reopened = new OperationalStore(filePath);
    fixture.replaceStore(reopened);
    expect(reopened.getSessionSubagentRun("session-1", "delegated-active")?.run.returnedResult)
      .toBe("returned result");
    const reopenedTranscript = reopened.listSubagentTranscript({
      sessionId: "session-1",
      subagentRunId: "delegated-active"
    }).entries;
    expect(reopenedTranscript).toHaveLength(2);
    expect(reopenedTranscript[0]).toMatchObject({ id: "entry-1", content: "new generation" });
    expect(reopenedTranscript[1]?.content).toContain("[REDACTED]");
    expect(reopenedTranscript[1]?.content).not.toContain("abcdefghijklmnop");
    expect(reopenedTranscript[1]?.toolInputJson).toContain("[REDACTED]");
  });
});

function delegatedRun(id: string, state: SubagentRunDetail["state"], startedAt: number): SubagentRunDetail {
  const terminal = state === "completed" || state === "failed" || state === "stopped";
  return {
    id,
    sessionId: "session-1",
    parentRunId: "run-1",
    parentTaskId: "session-1",
    logicalAgentId: `logical-${id}`,
    identityAliases: [`alias-${id}`],
    providerRunIds: [`provider-${id}`],
    state,
    title: "Delegated worker",
    description: "Checks one bounded assignment",
    assignment: "Inspect the assigned surface",
    summary: "Working",
    route: { providerId: "provider", modelId: "model", thinkingLevel: "high" },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 18,
      toolUses: 1,
      durationMs: 250,
      costUsd: 0.01
    },
    capabilities: {
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: true,
      stop: !terminal,
      steer: !terminal,
      followUp: !terminal,
      resume: terminal,
      parentContext: "snapshot"
    },
    startedAt,
    updatedAt: terminal ? startedAt + 5 : startedAt,
    ...(terminal ? { endedAt: startedAt + 5 } : {}),
    activity: [{
      sequence: 1,
      kind: "started",
      state: "running",
      summary: "Started",
      occurredAt: startedAt
    }],
    children: [{
      id: `child-${id}`,
      identityAliases: [`native-child-${id}`],
      role: "worker",
      title: "Worker",
      assignment: "Inspect",
      state,
      route: { modelId: "child-model", thinkingLevel: "medium" },
      usage: { totalTokens: 18, toolUses: 1, durationMs: 250 },
      awaitingApproval: false,
      ...(terminal ? { result: "child result", startedAt, endedAt: startedAt + 5 } : { startedAt }),
      resultTruncated: false
    }],
    returnedResult: "returned result",
    returnedResultTruncated: false
  };
}

function appendDelegatedRun(store: OperationalStore, run: SubagentRunDetail): void {
  const session = store.getSession(run.sessionId).descriptor;
  store.appendEvent({
    backendId: session.backendId,
    targetId: session.targetId,
    sessionId: session.id,
    runId: run.parentRunId,
    generation: session.binding.generation,
    traceId: `delegated:${run.id}:${run.updatedAt}`,
    payload: { type: "subagent_run", run }
  });
}

function appendDelegatedTranscript(
  store: OperationalStore,
  subagentRunId: string,
  entry: SubagentTranscriptEntry
): void {
  const session = store.getSession("session-1").descriptor;
  const projection = store.getSessionSubagentRun(session.id, subagentRunId);
  if (projection === undefined) throw new Error("Delegated run is missing.");
  store.appendEvent({
    backendId: session.backendId,
    targetId: session.targetId,
    sessionId: session.id,
    ...(projection.run.parentRunId === undefined ? {} : { runId: projection.run.parentRunId }),
    generation: session.binding.generation,
    traceId: `delegated:${subagentRunId}:transcript:${entry.sequence}`,
    payload: { type: "subagent_transcript", subagentRunId, entry }
  });
}

function backendAuthorityDescriptor(
  id: string,
  adapterKind: string,
  instanceGeneration: number
): BackendDescriptor {
  return {
    id,
    adapterKind,
    instanceGeneration,
    displayName: id,
    version: "test",
    health: "healthy",
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  };
}

function createFixture(): {
  store: OperationalStore;
  replaceStore: (replacement: OperationalStore) => void;
  prompt: {
    readonly text: string;
    readonly images: readonly [];
    readonly files: readonly [];
    readonly mentions: readonly [];
    readonly disposition: "prompt";
  };
} {
  let store = createStore();
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "latest-installed",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-1",
    backendId: "pi",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.createSession({
    id: "session-1",
    backendId: "pi",
    targetId: "target-1",
    title: "Session",
    binding: { opaqueRef: "native/session.jsonl", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  store.createRun({
    id: "run-1",
    sessionId: "session-1",
    source: "user",
    state: "queued",
    createdAt: 2
  });
  return {
    get store() { return store; },
    replaceStore(replacement: OperationalStore) {
      store = replacement;
      cleanups.push(() => replacement.close());
    },
    prompt: { text: "Hello", images: [], files: [], mentions: [], disposition: "prompt" }
  };
}

function createStore(): OperationalStore {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-store-"));
  let store: OperationalStore | undefined;
  let nextId = 0;
  store = new OperationalStore(path.join(directory, "operational.sqlite"), {
    idFactory: () => `generated-${++nextId}`
  });
  cleanups.push(() => {
    try {
      store?.close();
    } catch {
      // A test may close the original store before reopening the same file.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function publicTestError(code: string, message: string) {
  return {
    code,
    message,
    phase: "stream" as const,
    retryable: true,
    stateMayHaveChanged: false,
    recovery: "Retry after inspecting the task."
  };
}

function questionInteraction(id: string) {
  return {
    id,
    kind: "question" as const,
    title: "Choose",
    prompt: "Continue?",
    fields: [{
      id: "answer",
      label: "Choose",
      kind: "single" as const,
      required: true,
      choices: [{ id: "yes", label: "Yes" }]
    }]
  };
}
