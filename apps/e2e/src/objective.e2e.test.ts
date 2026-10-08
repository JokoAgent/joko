import { randomUUID } from "node:crypto";

import {
  ObjectiveStatus,
  QueueDispatchState,
  QueueItemState,
  RunState,
  type QueueControl
} from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  pauseQueueMutation,
  resumeQueueMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

describe("Objective HTTP/SQLite product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("survives restart, renews its exact Attempt, ignores client disconnect, and completes two turns", async () => {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 0 }],
      createAdapter: (profile) => new HeldObjectiveAdapter(profile)
    });
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("Objective restart owner");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId() })
    ));
    await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(
        requiredQueueControl(await paired.clients.queue.getQueueControl({ sessionId })),
        "hold Objective before restart"
      )
    );
    const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const set = await paired.clients.objective.setObjective({
      requestId: randomUUID(),
      sessionId,
      text: "Finish the durable two-turn objective.",
      limits: { maximumTurns: 4, noProgressTurnLimit: 3 },
      expectedSessionGeneration: BigInt(generation)
    });
    const initial = set.objective;
    if (initial?.pendingRunId === undefined || initial.pendingQueueItemId === undefined) {
      throw new Error("Objective admission did not expose its pending Run and Queue item.");
    }
    const firstRunId = initial.pendingRunId;
    const firstQueueItemId = initial.pendingQueueItemId;
    expect(initial.status).toBe(ObjectiveStatus.ACTIVE);
    expect(fixture.application.store.getQueueItem(firstQueueItemId).state).toBe("accepted");

    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({
      rootDirectory,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 0 }],
      createAdapter: (profile) => new HeldObjectiveAdapter(profile)
    });
    const restarted = fixture.clients(paired.authKey);
    const recovered = await restarted.objective.getObjective({ sessionId });
    expect(recovered.objective).toMatchObject({
      status: ObjectiveStatus.ACTIVE,
      pendingRunId: firstRunId,
      pendingQueueItemId: firstQueueItemId
    });
    const paused = requiredQueueControl(await restarted.queue.getQueueControl({ sessionId }));
    expect(paused.dispatchState).toBe(QueueDispatchState.PAUSED);
    await submit(restarted.operation, paired.connectionId, resumeQueueMutation(paused));

    const adapter = fixture.adapter() as HeldObjectiveAdapter;
    await waitFor(
      async () => adapter.turns.length,
      (turns) => turns === 1,
      "first Objective turn to reach the Backend"
    );
    await waitFor(
      () => restarted.queue.listQueueItems({ sessionId }),
      (response) => response.queueItems.some((item) =>
        item.queueItemId === firstQueueItemId && item.state === QueueItemState.BACKEND_ACCEPTED),
      "first Objective Queue item Backend acceptance"
    );

    const watchAbort = new AbortController();
    const watcher = restarted.objective.watchObjective(
      { sessionId },
      { signal: watchAbort.signal, timeoutMs: 0 }
    )[Symbol.asyncIterator]();
    expect((await nextWithin(watcher, "initial Objective watch projection")).value.objective?.status)
      .toBe(ObjectiveStatus.ACTIVE);
    const disconnected = watcher.next().then(
      (result) => result.done ? "closed" : "value",
      () => "closed"
    );
    fixture.dropPublicConnections();
    expect(await within(disconnected, "Objective watch disconnect")).toBe("closed");
    watchAbort.abort();

    await adapter.settle(0, "continue", "first durable turn completed");
    await waitFor(
      async () => adapter.turns.length,
      (turns) => turns === 2,
      "second Objective turn after disconnected client"
    );
    await adapter.settle(1, "complete", "durable objective achieved");

    const reconnected = fixture.clients(paired.authKey);
    const completed = await waitFor(
      () => reconnected.objective.getObjective({ sessionId }),
      (response) => response.objective?.status === ObjectiveStatus.COMPLETE,
      "completed Objective after reconnect"
    );
    expect(completed.objective).toMatchObject({
      status: ObjectiveStatus.COMPLETE,
      turnsUsed: 2,
      lastReason: "durable objective achieved"
    });
    expect(completed.objective?.pendingRunId).toBeUndefined();
    expect(completed.objective?.pendingQueueItemId).toBeUndefined();

    const firstRun = await reconnected.run.getRun({ runId: firstRunId });
    expect(firstRun.run?.state).toBe(RunState.SUCCEEDED);
    expect(firstRun.run?.attempts.map((attempt) => attempt.generation)).toEqual([
      BigInt(generation),
      BigInt(generation + 1)
    ]);
    expect(firstRun.run?.attempts.every((attempt) => attempt.endedAt !== undefined)).toBe(true);
    expect(fixture.application.store.getQueueItem(firstQueueItemId).state).toBe("completed");
    const storedObjective = fixture.application.store.getObjective(sessionId);
    expect(storedObjective).toMatchObject({ status: "complete", turnsUsed: 2 });
    expect(storedObjective.pendingRunId).toBeUndefined();
    expect(storedObjective.pendingAttemptId).toBeUndefined();
    expect(storedObjective.pendingQueueItemId).toBeUndefined();
    expect(adapter.turns).toHaveLength(2);
  }, 30_000);
});

class HeldObjectiveAdapter extends InstrumentedFakeAdapter {
  readonly turns: Array<{ readonly input: PromptInput; readonly context: AdapterContext }> = [];

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input);
    this.turns.push({ input, context });
  }

  async settle(index: number, status: "continue" | "complete", reason: string): Promise<void> {
    const turn = this.turns[index];
    if (turn === undefined) throw new Error(`Objective turn ${index + 1} was not captured.`);
    const text = `\`\`\`json\n${JSON.stringify({ goal_status: status, reason })}\n\`\`\``;
    await turn.context.emit({
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text }]
    });
    await turn.context.emit({ type: "done", outcome: "completed" });
  }
}

function requiredQueueControl(response: { readonly queueControl?: QueueControl }): QueueControl {
  if (response.queueControl === undefined) throw new Error("Orchestrator returned no queue control.");
  return response.queueControl;
}

async function nextWithin<T>(iterator: AsyncIterator<T>, label: string): Promise<IteratorResult<T>> {
  return within(iterator.next(), label);
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
