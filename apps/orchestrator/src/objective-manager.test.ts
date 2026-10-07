import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PublicError, PromptInput, UsageSnapshot } from "@joko/core";
import { OperationalStore, type OperationExecution } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObjectiveManager } from "./objective-manager.js";
import { providerRateLimitSettingKey } from "./provider-rate-limit.js";
import type { EnqueueResult, SessionHost } from "./session-host.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("ObjectiveManager", () => {
  it("cancels and clears an accepted Objective Queue owner when paused", async () => {
    const fixture = createFixture();
    const started = await fixture.manager.set(setInput("set-accepted", fixture));
    const oldQueueId = started.pendingQueueItemId!;

    const paused = await fixture.manager.pause({
      operationId: "pause-accepted",
      sessionId: fixture.sessionId,
      expectedRevision: started.revision,
      expectedOwnerGeneration: started.ownerGeneration
    });

    expect(fixture.store.getQueueItem(oldQueueId).state).toBe("cancelled");
    const oldRun = fixture.store.getRun(started.pendingRunId!).descriptor;
    expect(oldRun.state).toBe("aborted");
    expect(fixture.store.getAttempt(oldRun.activeAttemptId ?? fixture.host.admissions[0]!.attemptId).descriptor.endedAt)
      .toEqual(expect.any(Number));
    expect(paused).toMatchObject({ status: "paused" });
    expect(paused.pendingRunId).toBeUndefined();
  });

  it("settles an old dispatch-unknown owner, activates its replacement, and dispatches exactly once", async () => {
    const fixture = createFixture();
    const first = await fixture.manager.set(setInput("set-old-owner", fixture));
    const old = fixture.host.admissions[0]!;
    makeDispatchUnknown(fixture.store, old);

    const replacement = await fixture.manager.set({
      ...setInput("replace-unknown-owner", fixture),
      text: "Replacement objective"
    });
    expect(replacement).toMatchObject({ status: "dispatch_unknown", pendingRunId: old.runId });
    expect(fixture.host.admissions).toHaveLength(1);

    settleRun(fixture.store, old, "completed", verdict("continue", "old owner settled"));
    await fixture.manager.onRunSettled({ sessionId: fixture.sessionId, runId: old.runId, outcome: "completed" });

    const current = fixture.store.getObjective(fixture.sessionId);
    expect(current).toMatchObject({ status: "active", text: "Replacement objective" });
    expect(current.pendingRunId).not.toBe(old.runId);
    expect(fixture.host.admissions).toHaveLength(2);
    expect(first.ownerGeneration).toBeLessThan(current.ownerGeneration);
    expect(fixture.store.listEvents({ sessionId: fixture.sessionId }).some((event) =>
      event.payload.type === "objective_lifecycle" && event.payload.action === "replaced"
      && event.payload.objectiveText === "Replacement objective")).toBe(true);
  });

  it("uses a new incarnation after clear so the old turn cannot replay or settle the rebuilt Objective", async () => {
    const fixture = createFixture();
    await fixture.manager.set(setInput("set-before-clear", fixture));
    const oldPending = fixture.host.admissions[0]!;
    makeDispatchUnknown(fixture.store, oldPending);
    await fixture.manager.onRunSettled({
      sessionId: fixture.sessionId,
      runId: oldPending.runId,
      outcome: "failed"
    });
    const oldObjective = fixture.store.getObjective(fixture.sessionId);

    await fixture.manager.clear({
      operationId: "clear-old-incarnation",
      sessionId: fixture.sessionId,
      expectedRevision: oldObjective.revision,
      expectedOwnerGeneration: oldObjective.ownerGeneration
    });
    const rebuilt = await fixture.manager.set(setInput("set-after-clear", fixture));
    const newPending = fixture.host.admissions[1]!;

    expect(rebuilt.ownerGeneration).toBeGreaterThan(oldObjective.ownerGeneration);
    expect(newPending.runId).not.toBe(oldPending.runId);
    expect(rebuilt.pendingRunId).toBe(newPending.runId);
    expect(fixture.host.admissions).toHaveLength(2);

    settleRun(fixture.store, oldPending, "completed", verdict("continue", "late cleared incarnation"));
    await fixture.manager.onRunSettled({
      sessionId: fixture.sessionId,
      runId: oldPending.runId,
      outcome: "completed"
    });
    expect(fixture.store.getObjective(fixture.sessionId)).toMatchObject({
      ownerGeneration: rebuilt.ownerGeneration,
      pendingRunId: newPending.runId,
      status: "active"
    });
    expect(fixture.host.admissions).toHaveLength(2);
  });

  it("recomputes lowered and raised budgets in the same CAS and resumes only when allowed", async () => {
    const fixture = createFixture();
    let objective = fixture.store.putObjective({ sessionId: fixture.sessionId, text: "Budget objective" });
    objective = fixture.store.updateObjective({
      sessionId: fixture.sessionId,
      expectedRevision: objective.revision,
      expectedOwnerGeneration: objective.ownerGeneration,
      turnsUsed: 2
    });

    objective = await fixture.manager.update({
      operationId: "lower-budget",
      sessionId: fixture.sessionId,
      expectedRevision: objective.revision,
      expectedOwnerGeneration: objective.ownerGeneration,
      maximumTurns: 2
    });
    expect(objective.status).toBe("budget_limited");
    expect(fixture.host.admissions).toHaveLength(0);

    objective = await fixture.manager.update({
      operationId: "raise-budget",
      sessionId: fixture.sessionId,
      expectedRevision: objective.revision,
      expectedOwnerGeneration: objective.ownerGeneration,
      maximumTurns: 3
    });
    expect(objective.status).toBe("active");
    expect(fixture.host.admissions).toHaveLength(1);
  });

  it("recovers an eligible dormant active Objective during initialization without a client watch", async () => {
    const fixture = createFixture();
    fixture.store.putObjective({ sessionId: fixture.sessionId, text: "Always-on objective" });

    await fixture.manager.initialize();

    expect(fixture.host.active).toBe(false);
    expect(fixture.host.admissions).toHaveLength(1);
    expect(fixture.store.getObjective(fixture.sessionId).pendingRunId).toBe(fixture.host.admissions[0]!.runId);
  });

  it("fails closed when a pending attempt belongs to an older Session generation", async () => {
    const fixture = createFixture();
    const objective = await fixture.manager.set(setInput("generation-start", fixture));
    const session = fixture.store.getSession(fixture.sessionId);
    fixture.store.updateSession(fixture.sessionId, {
      binding: { opaqueRef: "native-two", generation: 2 }
    }, session.revision);

    await fixture.manager.onRunSettled({
      sessionId: fixture.sessionId,
      runId: objective.pendingRunId!,
      outcome: "failed"
    });

    expect(fixture.store.getObjective(fixture.sessionId)).toMatchObject({
      status: "dispatch_unknown",
      sessionGeneration: 2,
      pendingRunId: objective.pendingRunId
    });
    expect(fixture.host.admissions).toHaveLength(1);
  });

  it("re-arms a reset timer beyond the platform maximum delay", async () => {
    vi.useFakeTimers();
    const now = new Date("2030-01-01T00:00:00.000Z").getTime();
    vi.setSystemTime(now);
    const fixture = createFixture();
    let objective = fixture.store.putObjective({ sessionId: fixture.sessionId, text: "Long reset objective" });
    const resetAt = now + 2_147_483_647 + 10_000;
    objective = fixture.store.updateObjective({
      sessionId: fixture.sessionId,
      expectedRevision: objective.revision,
      expectedOwnerGeneration: objective.ownerGeneration,
      status: "usage_limited",
      usageResetAt: resetAt
    });
    await fixture.manager.initialize();

    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(fixture.store.getObjective(fixture.sessionId)).toMatchObject({ status: "usage_limited", usageResetAt: resetAt });
    expect(fixture.host.admissions).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.store.getObjective(fixture.sessionId).status).toBe("active");
    expect(fixture.host.admissions).toHaveLength(1);
  });

  it("pauses atomically on ordinary user admission and lets a text edit recover a paused owner", async () => {
    const fixture = createFixture();
    const started = await fixture.manager.set(setInput("user-pause-start", fixture));
    const userResult = admitUserInput(fixture.store, fixture.sessionId, "ordinary-user-input");
    fixture.store.transaction((store) => fixture.manager.onUserInputAdmitted(store, userResult));

    let current = fixture.store.getObjective(fixture.sessionId);
    expect(current).toMatchObject({ status: "paused", lastReason: expect.stringContaining("user sent") });
    expect(current.pendingRunId).toBeUndefined();
    expect(fixture.store.getQueueItem(started.pendingQueueItemId!).state).toBe("cancelled");

    current = await fixture.manager.update({
      operationId: "edit-paused-owner",
      sessionId: fixture.sessionId,
      expectedRevision: current.revision,
      expectedOwnerGeneration: current.ownerGeneration,
      text: "Revised objective after user input"
    });
    expect(current).toMatchObject({ status: "active", text: "Revised objective after user input", noProgressTurns: 0 });
    expect(fixture.host.admissions).toHaveLength(2);
  });

  it("retires a dispatch-unknown owner on ordinary user input and never resumes it after late settlement", async () => {
    const fixture = createFixture();
    await fixture.manager.set(setInput("dispatch-unknown-user-pause", fixture));
    const pending = fixture.host.admissions[0]!;
    makeDispatchUnknown(fixture.store, pending);
    await fixture.manager.onRunSettled({ sessionId: fixture.sessionId, runId: pending.runId, outcome: "failed" });
    expect(fixture.store.getObjective(fixture.sessionId).status).toBe("dispatch_unknown");

    const userResult = admitUserInput(fixture.store, fixture.sessionId, "after-dispatch-unknown");
    fixture.store.transaction((store) => fixture.manager.onUserInputAdmitted(store, userResult));
    let current = fixture.store.getObjective(fixture.sessionId);
    expect(current).toMatchObject({ status: "paused", pendingRunId: pending.runId });

    settleRun(fixture.store, pending, "completed", verdict("continue", "late old owner result"));
    await fixture.manager.onRunSettled({ sessionId: fixture.sessionId, runId: pending.runId, outcome: "completed" });
    current = fixture.store.getObjective(fixture.sessionId);
    expect(current).toMatchObject({ status: "paused" });
    expect(current.pendingRunId).toBeUndefined();
    expect(fixture.host.admissions).toHaveLength(1);
  });

  it("honors a durable provider limit before dispatch and schedules the known reset", async () => {
    const now = 1_900_000_000_000;
    const fixture = createFixture({ now: () => now });
    fixture.store.setSetting("service", "orchestrator", providerRateLimitSettingKey("backend-one", "provider-one"), {
      limited: true,
      observedAt: now,
      resetsAt: now + 60_000
    });
    fixture.store.putObjective({ sessionId: fixture.sessionId, text: "Rate-limited objective" });

    await fixture.manager.initialize();

    expect(fixture.host.admissions).toHaveLength(0);
    expect(fixture.store.getObjective(fixture.sessionId)).toMatchObject({
      status: "usage_limited",
      usageResetAt: now + 60_000
    });
  });

  it("persists consecutive overloads across manager restart and blocks at the bounded threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const fixture = createFixture();
    await fixture.manager.set(setInput("overload-start", fixture));
    let pending = fixture.host.admissions.at(-1)!;
    failRun(fixture.store, pending, overloadError());
    await fixture.manager.onRunSettled({ sessionId: fixture.sessionId, runId: pending.runId, outcome: "failed" });
    expect(fixture.store.getObjective(fixture.sessionId).dispatchRejections).toBe(1);

    await fixture.manager.close();
    const recovered = new ObjectiveManager({ store: fixture.store, sessionHost: fixture.host });
    fixture.managers.push(recovered);
    await recovered.initialize();

    for (const expectedFailureCount of [2, 3]) {
      await vi.advanceTimersByTimeAsync(60_000);
      pending = fixture.host.admissions.at(-1)!;
      failRun(fixture.store, pending, overloadError());
      await recovered.onRunSettled({ sessionId: fixture.sessionId, runId: pending.runId, outcome: "failed" });
      const current = fixture.store.getObjective(fixture.sessionId);
      if (expectedFailureCount < 3) expect(current.dispatchRejections).toBe(expectedFailureCount);
      else expect(current).toMatchObject({ status: "blocked", dispatchRejections: 0 });
    }
  });

  it("prefers per-message token usage, ignores unsafe refinement, and persists lifecycle evidence", async () => {
    const fixture = createFixture();
    const initial = await fixture.manager.set(setInput("lifecycle-start", fixture));
    const pending = fixture.host.admissions[0]!;
    makeRunning(fixture.store, pending);
    const unsafeRefinement = `bad\u0000${"x".repeat(32_001)}`;
    appendAssistant(fixture.store, pending.runId, verdict("complete", "z".repeat(3_000), unsafeRefinement), usage(11));
    fixture.store.appendEvent({
      backendId: "backend-one",
      targetId: "target-one",
      sessionId: fixture.sessionId,
      runId: pending.runId,
      generation: 1,
      traceId: "objective-test:cumulative-usage",
      payload: { type: "usage", usage: usage(999) }
    });
    finishRunning(fixture.store, pending, "completed");

    await fixture.manager.onRunSettled({ sessionId: fixture.sessionId, runId: pending.runId, outcome: "completed" });

    const complete = fixture.store.getObjective(fixture.sessionId);
    expect(complete).toMatchObject({ status: "complete", text: initial.text, tokensUsed: 11 });
    expect(complete.lastReason?.length).toBe(2_048);
    const lifecycle = fixture.store.listEvents({ sessionId: fixture.sessionId })
      .flatMap((event) => event.payload.type === "objective_lifecycle" ? [event.payload] : []);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "started", objectiveText: initial.text, ownerGeneration: initial.ownerGeneration }),
      expect.objectContaining({ action: "completed", turnsUsed: 1, tokensUsed: 11 })
    ]));
  });
});

interface FixtureOptions { readonly now?: () => number }

function createFixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "joko-objective-"));
  const store = new OperationalStore(join(directory, "operational.db"));
  store.upsertBackend({
    id: "backend-one",
    displayName: "Backend",
    version: "test",
    adapterKind: "fixture",
    instanceGeneration: 1,
    installationState: "installed",
    authenticationState: "not_required",
    health: "healthy",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-one",
    backendId: "backend-one",
    displayName: "Target",
    workspaceRoot: directory,
    managed: false,
    trusted: true
  });
  const sessionId = "session-one";
  store.createSession({
    id: sessionId,
    backendId: "backend-one",
    targetId: "target-one",
    title: "Objective task",
    binding: { opaqueRef: "native-one", generation: 1 },
    providerId: "provider-one",
    modelId: "model-one",
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: options.now?.() ?? Date.now(),
    updatedAt: options.now?.() ?? Date.now()
  });
  const host = new FakeObjectiveHost(store);
  const manager = new ObjectiveManager({ store, sessionHost: host, ...(options.now === undefined ? {} : { now: options.now }) });
  const managers = [manager];
  cleanups.push(async () => {
    for (const current of [...managers].reverse()) await current.close().catch(() => undefined);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, host, manager, managers, sessionId };
}

class FakeObjectiveHost {
  readonly admissions: EnqueueResult[] = [];
  readonly drains: string[] = [];
  readonly aborted: string[] = [];
  active = false;
  readonly #store: OperationalStore;

  constructor(store: OperationalStore) { this.#store = store; }

  enqueueServiceInput(
    input: Parameters<SessionHost["enqueueServiceInput"]>[0]
  ): OperationExecution<EnqueueResult> {
    const suffix = input.operationId.replace(/[^a-z0-9]/giu, "-");
    const result = this.#store.runOperation(
      { id: input.operationId, kind: "objective_test_input", body: { sessionId: input.sessionId } },
      (store) => {
        const value = {
          sessionId: input.sessionId,
          runId: `run-${suffix}`,
          attemptId: `attempt-${suffix}`,
          queueItemId: `queue-${suffix}`
        };
        store.createRun({ id: value.runId, sessionId: input.sessionId, source: input.source, state: "queued", createdAt: Date.now() }, { operationId: input.operationId });
        store.createAttempt({ id: value.attemptId, runId: value.runId, ordinal: 1, generation: 1, startedAt: Date.now() });
        store.enqueueQueueItem({
          id: value.queueItemId,
          sessionId: input.sessionId,
          runId: value.runId,
          attemptId: value.attemptId,
          operationId: input.operationId,
          disposition: input.prompt.disposition,
          body: input.prompt,
          createdAt: Date.now()
        });
        input.onAdmitted?.(store, value);
        return value;
      }
    );
    if (!result.replayed) this.admissions.push(result.value);
    return result;
  }

  requestQueueDrain(sessionId: string): void { this.drains.push(sessionId); }
  async abort(_sessionId: string, runId: string): Promise<void> { this.aborted.push(runId); }
  isSessionActive(_sessionId: string): boolean { return this.active; }
}

function setInput(operationId: string, fixture: ReturnType<typeof createFixture>) {
  return { operationId, sessionId: fixture.sessionId, text: "Finish the full objective" };
}

function admitUserInput(_store: OperationalStore, sessionId: string, suffix: string): EnqueueResult {
  return {
    sessionId,
    runId: `run-${suffix}`,
    attemptId: `attempt-${suffix}`,
    queueItemId: `queue-${suffix}`
  };
}

function makeRunning(store: OperationalStore, pending: EnqueueResult): void {
  store.claimNextQueueItem({ sessionId: pending.sessionId, backendInstanceGeneration: 1, traceId: `claim:${pending.runId}` });
  store.updateRunState({ runId: pending.runId, state: "running", activeAttemptId: pending.attemptId, traceId: `running:${pending.runId}` });
  store.updateQueueState({ queueItemId: pending.queueItemId, state: "backend_accepted", attemptId: pending.attemptId, traceId: `accepted:${pending.runId}` });
}

function makeDispatchUnknown(store: OperationalStore, pending: EnqueueResult): void {
  makeRunning(store, pending);
  const error = { ...overloadError(), code: "DISPATCH_UNKNOWN", stateMayHaveChanged: true };
  store.updateQueueState({ queueItemId: pending.queueItemId, state: "dispatch_unknown", attemptId: pending.attemptId, error, traceId: `unknown:${pending.runId}` });
  store.updateRunState({ runId: pending.runId, state: "dispatch_unknown", activeAttemptId: pending.attemptId, error, traceId: `unknown-run:${pending.runId}` });
}

function settleRun(store: OperationalStore, pending: EnqueueResult, outcome: "completed", text: string): void {
  appendAssistant(store, pending.runId, text, usage(1));
  store.updateQueueState({ queueItemId: pending.queueItemId, state: "completed", attemptId: pending.attemptId, traceId: `complete:${pending.runId}` });
  store.updateRunState({ runId: pending.runId, state: outcome, activeAttemptId: pending.attemptId, traceId: `complete-run:${pending.runId}` });
  store.finishAttempt(pending.attemptId);
}

function finishRunning(store: OperationalStore, pending: EnqueueResult, outcome: "completed"): void {
  store.updateQueueState({ queueItemId: pending.queueItemId, state: "completed", attemptId: pending.attemptId, traceId: `complete:${pending.runId}` });
  store.updateRunState({ runId: pending.runId, state: outcome, activeAttemptId: pending.attemptId, traceId: `complete-run:${pending.runId}` });
  store.finishAttempt(pending.attemptId);
}

function failRun(store: OperationalStore, pending: EnqueueResult, error: PublicError): void {
  makeRunning(store, pending);
  store.updateQueueState({ queueItemId: pending.queueItemId, state: "failed", attemptId: pending.attemptId, error, traceId: `fail:${pending.runId}` });
  store.updateRunState({ runId: pending.runId, state: "failed", activeAttemptId: pending.attemptId, error, traceId: `fail-run:${pending.runId}` });
  store.finishAttempt(pending.attemptId, error);
}

function appendAssistant(store: OperationalStore, runId: string, text: string, messageUsage: UsageSnapshot): void {
  store.appendEvent({
    backendId: "backend-one",
    targetId: "target-one",
    sessionId: "session-one",
    runId,
    generation: 1,
    traceId: `assistant:${runId}`,
    payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }], usage: messageUsage }
  });
}

function usage(totalTokens: number): UsageSnapshot {
  return { inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens, cost: 0 };
}

function verdict(status: "complete" | "continue" | "blocked", reason: string, refinedObjective?: string): string {
  return `\`\`\`json\n${JSON.stringify({ goal_status: status, reason, ...(refinedObjective === undefined ? {} : { refined_objective: refinedObjective }) })}\n\`\`\``;
}

function overloadError(): PublicError {
  return {
    code: "UPSTREAM_OVERLOAD",
    message: "Provider capacity is temporarily unavailable.",
    phase: "stream",
    retryable: true,
    stateMayHaveChanged: false,
    recovery: "Retry later."
  };
}
