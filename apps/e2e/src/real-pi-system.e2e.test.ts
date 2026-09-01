import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  BackendHealth,
  CompactSessionOutcome,
  CompactionState,
  InstallationState,
  OperationState,
  OwnerSnapshotScopeSchema,
  PiMessageRole,
  RunState,
  SessionSnapshotScopeSchema,
  SessionState,
  SnapshotScopeSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  compactMutation,
  createSessionMutation,
  queueRunIdFrom,
  restartBackendMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  REAL_PI_RESPONSE_TEXT,
  RealPiSystemFixture
} from "./real-pi-fixture.js";

describe("latest npm Pi through production Orchestrator and binary Connect", () => {
  let fixture: RealPiSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("pairs, creates, sends, settles, and projects public plus Pi-native context", { timeout: 60_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ holdProviderResponses: true });
    const paired = await fixture.pair();

    const backends = await paired.clients.backend.listBackends({});
    const pi = backends.backends.find((backend) => backend.backendId === "pi");
    expect(pi).toMatchObject({
      backendId: "pi",
      health: BackendHealth.HEALTHY,
      installationState: InstallationState.INSTALLED
    });
    expect(pi?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/u);

    const ownerScope = create(SnapshotScopeSchema, {
      kind: { case: "owner", value: create(OwnerSnapshotScopeSchema, {}) }
    });
    const owner = await paired.clients.event.getSnapshot({ scope: ownerScope });
    expect(owner.snapshot?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "workspace-real-pi", backendId: "pi" })
    ]));
    expect(owner.snapshot?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: expect.objectContaining({ providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }),
        available: true
      })
    ]));

    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi system turn",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    expect(created.state).toBe(OperationState.SUCCEEDED);
    const sessionId = sessionIdFrom(created);
    const sessionAfterCreate = await paired.clients.session.getSession({ sessionId });
    expect(sessionAfterCreate.session).toMatchObject({
      sessionId,
      backendId: "pi",
      targetId: "workspace-real-pi",
      state: SessionState.IDLE,
      model: {
        model: { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID },
        effortId: "off",
        fastMode: false
      }
    });

    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });
    const beforeDisconnect = await paired.clients.event.getSnapshot({ scope: sessionScope });
    const disconnect = new AbortController();
    const disconnectedIterator = paired.clients.event.streamEvents(
      { scope: sessionScope, afterCursor: beforeDisconnect.snapshot!.resumeCursor },
      { signal: disconnect.signal }
    )[Symbol.asyncIterator]();
    const firstInFlightEvent = disconnectedIterator.next();
    const prompt = "Reply through the real Pi runtime and do not call tools.";
    const enqueued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, prompt)
    );
    expect(enqueued.state).toBe(OperationState.SUCCEEDED);
    const runId = queueRunIdFrom(enqueued);
    await firstInFlightEvent;
    await waitForRealSystem(
      async () => fixture!.providerRequests.length,
      (count) => count === 1,
      "local Provider request before UI disconnect",
      30_000
    );
    disconnect.abort();
    await disconnectedIterator.return?.();

    // This is a distinct Connect transport using the same durable Device
    // authorization. Replacing the UI stream must not transfer or abort the
    // Run that Orchestrator already owns.
    const reconnected = fixture.clients(paired.authKey);
    expect([
      RunState.ACCEPTED,
      RunState.QUEUED,
      RunState.DISPATCHING,
      RunState.RUNNING,
      RunState.WAITING,
      RunState.RETRYING
    ]).toContain((await reconnected.run.getRun({ runId })).run?.state);
    fixture.releaseProviderResponses();
    const settled = await waitForRealSystem(
      () => reconnected.run.getRun({ runId }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "real Pi Run to settle after UI reconnect",
      30_000
    );
    expect(settled.run?.endedAt).toBeDefined();
    expect(fixture.providerRequests).toHaveLength(1);
    expect(fixture.providerRequests[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
      body: { model: REAL_PI_MODEL_ID }
    });
    expect(JSON.stringify(fixture.providerRequests[0]?.body)).toContain(prompt);

    // The Web reducer is not a public workspace package API. This exercises
    // its authoritative input instead: binary protobuf Snapshot/Event shapes
    // from the production Connect endpoint, including the durable timeline.
    const projected = await reconnected.event.getSnapshot({ scope: sessionScope });
    const snapshot = projected.snapshot;
    expect(snapshot?.sessions[0]).toMatchObject({ sessionId, state: SessionState.IDLE });
    expect(snapshot?.sessions[0]?.context).toMatchObject({
      usedTokens: 10n,
      contextWindowTokens: 16_384n,
      cumulativeUsage: {
        inputTokens: 7n,
        outputTokens: 3n,
        totalTokens: 10n
      }
    });
    expect(snapshot?.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId, state: RunState.SUCCEEDED })
    ]));
    const timelineCases = snapshot?.timeline.map((event) => event.payload?.kind.case) ?? [];
    expect(timelineCases).toEqual(expect.arrayContaining([
      "messageCompleted",
      "contextUsageChanged",
      "runDone"
    ]));
    const durablePiSession = snapshot?.pi?.sessions.find((session) => session.productSessionId === sessionId);
    expect(durablePiSession).toMatchObject({
      productSessionId: sessionId,
      messagesComplete: true,
      entriesComplete: true
    });
    expect(durablePiSession?.messages.map((message) => message.role)).toEqual(expect.arrayContaining([
      PiMessageRole.USER,
      PiMessageRole.ASSISTANT
    ]));
    const durablePiText = durablePiSession?.messages.flatMap((message) => message.parts)
      .map((part) => part.content.case === "text" ? part.content.value : "")
      .join("\n") ?? "";
    expect(durablePiText).toContain(prompt);
    expect(durablePiText).toContain(REAL_PI_RESPONSE_TEXT);

    const [nativeState, nativeMessages, nativeEntries, statistics] = await Promise.all([
      reconnected.pi.getPiSessionState({ sessionId }),
      reconnected.pi.listPiMessages({ sessionId }),
      reconnected.pi.listPiEntries({ sessionId }),
      reconnected.session.getSessionStatistics({ sessionId })
    ]);
    expect(nativeState.state).toMatchObject({
      streaming: false,
      messageCount: 2n,
      pendingMessageCount: 0n,
      model: { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }
    });
    const typedMessageText = nativeMessages.messages.flatMap((message) => message.parts)
      .map((part) => part.content.case === "text" ? part.content.value : "")
      .join("\n");
    expect(nativeEntries.entries.length).toBeGreaterThanOrEqual(2);
    expect(nativeEntries.activeLeafId).not.toBe("");
    // The direct latest-Pi get_entries authority must retain any native shape
    // that is not yet recognized instead of dropping it.
    const retainedEntryText = nativeEntries.entries
      .map((entry) => entry.payload.case === "custom" ? entry.payload.value.textPreview : "")
      .join("\n");
    expect(`${typedMessageText}\n${retainedEntryText}`).toContain(prompt);
    expect(`${typedMessageText}\n${retainedEntryText}`).toContain(REAL_PI_RESPONSE_TEXT);
    expect(statistics.statistics).toMatchObject({ sessionId });
    expect(statistics.statistics?.messageCount).toBeGreaterThanOrEqual(2n);
    expect(statistics.statistics?.turnCount).toBeGreaterThanOrEqual(1n);
    expect(statistics.statistics?.usage).toMatchObject({
      inputTokens: 7n,
      outputTokens: 3n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      totalTokens: 10n
    });
    expect(statistics.statistics?.context).toMatchObject({
      usedTokens: 10n,
      contextWindowTokens: 16_384n,
      reservedTokens: 16_374n,
      cumulativeUsage: {
        inputTokens: 7n,
        outputTokens: 3n,
        totalTokens: 10n
      }
    });
  });

  it("restarts the installed Pi runtime and resumes the same native Session context", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start();
    const paired = await fixture.pair("Real Pi runtime restart E2E");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi runtime restart",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    ));
    const firstPrompt = "Retain this exact first turn across the managed runtime restart.";
    const firstRun = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, firstPrompt)
    );
    await waitForRealSystem(
      () => paired.clients.run.getRun({ runId: queueRunIdFrom(firstRun) }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "first real Pi restart turn",
      30_000
    );

    expect(fixture.providerRequests).toHaveLength(1);
    const beforeRestart = await paired.clients.session.getSession({ sessionId });
    const beforeGeneration = beforeRestart.session?.version?.generation;
    if (beforeGeneration === undefined) throw new Error("Real Pi Session had no generation before runtime restart.");

    const restarted = await submit(
      paired.clients.operation,
      paired.connectionId,
      restartBackendMutation("pi")
    );
    if (restarted.state !== OperationState.SUCCEEDED) {
      throw new Error(`Real Pi runtime restart failed at generation ${beforeGeneration}: ${JSON.stringify(restarted.error)}`);
    }
    const resumed = await waitForRealSystem(
      () => paired.clients.session.getSession({ sessionId }),
      (response) => (response.session?.version?.generation ?? 0n) > beforeGeneration
        && response.session?.state === SessionState.IDLE,
      "real Pi Session generation after runtime restart",
      30_000
    );
    expect(resumed.session?.sessionId).toBe(sessionId);
    expect(fixture.providerRequests).toHaveLength(1);

    const secondPrompt = "Confirm that the retained first turn is still native context.";
    const secondRun = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, secondPrompt)
    );
    await waitForRealSystem(
      () => paired.clients.run.getRun({ runId: queueRunIdFrom(secondRun) }),
      (response) => response.run?.state === RunState.SUCCEEDED,
      "second real Pi restart turn",
      30_000
    );

    expect(fixture.providerRequests).toHaveLength(2);
    const resumedProviderBody = JSON.stringify(fixture.providerRequests[1]?.body);
    expect(resumedProviderBody).toContain(firstPrompt);
    expect(resumedProviderBody).toContain(REAL_PI_RESPONSE_TEXT);
    expect(resumedProviderBody).toContain(secondPrompt);
  });

  it("returns typed manual compaction outcomes once across operation replay", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } }
    });
    const paired = await fixture.pair("Real Pi compaction E2E");
    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi compaction",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    const sessionId = sessionIdFrom(created);
    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });

    const noopOperationId = randomUUID();
    const noop = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      noopOperationId
    );
    expect(noop.state).toBe(OperationState.SUCCEEDED);
    expect(noop.result?.payload.case).toBe("compactSession");
    if (noop.result?.payload.case !== "compactSession") throw new Error("Orchestrator returned no typed compaction result.");
    expect(noop.result.payload.value.outcome).toBe(CompactSessionOutcome.NOOP);
    const noopTimeline = await paired.clients.event.getSnapshot({ scope: sessionScope });
    const noopEvents = compactionEvents(noopTimeline.snapshot?.timeline ?? []);
    expect(noopEvents.map((event) => event.state)).toEqual([CompactionState.STARTED, CompactionState.NO_OP]);
    expect(new Set(noopEvents.map((event) => event.compactionId))).toHaveLength(1);

    const replayedNoop = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      noopOperationId
    );
    expect(replayedNoop.result?.payload.case).toBe("compactSession");
    if (replayedNoop.result?.payload.case === "compactSession") {
      expect(replayedNoop.result.payload.value.outcome).toBe(CompactSessionOutcome.NOOP);
    }
    expect(compactionEvents((await paired.clients.event.getSnapshot({ scope: sessionScope })).snapshot?.timeline ?? []))
      .toHaveLength(noopEvents.length);

    for (const prompt of ["Remember the first compaction decision.", "Remember the second compaction decision."]) {
      const queued = await submit(
        paired.clients.operation,
        paired.connectionId,
        sendInputMutation(sessionId, prompt)
      );
      const runId = queueRunIdFrom(queued);
      await waitForRealSystem(
        () => paired.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED,
        "real Pi compaction preparation turn",
        30_000
      );
    }

    const compactOperationId = randomUUID();
    const beforeCompact = await paired.clients.event.getSnapshot({ scope: sessionScope });
    if (beforeCompact.snapshot === undefined) throw new Error("Orchestrator returned no compaction baseline Snapshot.");
    const compactStreamAbort = new AbortController();
    const compactIterator = paired.clients.event.streamEvents(
      { scope: sessionScope, afterCursor: beforeCompact.snapshot.resumeCursor },
      { signal: compactStreamAbort.signal }
    )[Symbol.asyncIterator]();
    const firstCompactEvent = compactIterator.next();
    const compacted = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      compactOperationId
    );
    expect(compacted.state).toBe(OperationState.SUCCEEDED);
    expect(compacted.result?.payload.case).toBe("compactSession");
    if (compacted.result?.payload.case !== "compactSession") throw new Error("Orchestrator returned no typed compaction result.");
    expect(compacted.result.payload.value.outcome).toBe(CompactSessionOutcome.COMPACTED);

    const liveCompactionEvents: { readonly compactionId: string; readonly state: CompactionState }[] = [];
    const compactStreamTimer = setTimeout(() => compactStreamAbort.abort(), 30_000);
    try {
      let next = await firstCompactEvent;
      while (!next.done) {
        const event = next.value.event;
        if (event?.payload?.kind.case === "compactionChanged") {
          liveCompactionEvents.push(event.payload.kind.value);
          if ([CompactionState.COMPLETED, CompactionState.NO_OP, CompactionState.ABORTED, CompactionState.FAILED]
            .includes(event.payload.kind.value.state)) break;
        }
        next = await compactIterator.next();
      }
    } finally {
      clearTimeout(compactStreamTimer);
      compactStreamAbort.abort();
      await compactIterator.return?.();
    }
    expect(liveCompactionEvents.map((event) => event.state)).toEqual([
      CompactionState.STARTED,
      CompactionState.COMPLETED
    ]);
    expect(new Set(liveCompactionEvents.map((event) => event.compactionId))).toHaveLength(1);

    const afterCompact = compactionEvents((await paired.clients.event.getSnapshot({ scope: sessionScope })).snapshot?.timeline ?? []);
    const terminalAfterCompact = afterCompact.filter((event) => [CompactionState.NO_OP, CompactionState.COMPLETED, CompactionState.ABORTED, CompactionState.FAILED].includes(event.state));
    expect(terminalAfterCompact).toEqual([
      expect.objectContaining({ state: CompactionState.COMPLETED })
    ]);
    const nativeEntries = await paired.clients.pi.listPiEntries({ sessionId });
    expect(nativeEntries.entries.some((entry) => entry.payload.case === "compaction")).toBe(true);

    const replayedCompact = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      compactOperationId
    );
    expect(replayedCompact.result?.payload.case).toBe("compactSession");
    if (replayedCompact.result?.payload.case === "compactSession") {
      expect(replayedCompact.result.payload.value.outcome).toBe(CompactSessionOutcome.COMPACTED);
    }
    const eventsAfterReplay = compactionEvents((await paired.clients.event.getSnapshot({ scope: sessionScope })).snapshot?.timeline ?? []);
    expect(eventsAfterReplay).toEqual(afterCompact);
    expect(eventsAfterReplay.filter((event) =>
      [CompactionState.COMPLETED, CompactionState.NO_OP, CompactionState.ABORTED, CompactionState.FAILED].includes(event.state)
    )).toHaveLength(1);
  });

  it("projects installed-Pi threshold compaction through the production chain", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1 } },
      providerUsage: { promptTokens: 10_000, completionTokens: 3 }
    });
    const paired = await fixture.pair("Real Pi threshold compaction E2E");
    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi threshold compaction",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    const sessionId = sessionIdFrom(created);
    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });

    for (const prompt of [
      "Keep this first turn available for automatic compaction.",
      "Trigger the installed Pi threshold compaction path."
    ]) {
      const queued = await submit(
        paired.clients.operation,
        paired.connectionId,
        sendInputMutation(sessionId, prompt)
      );
      const runId = queueRunIdFrom(queued);
      await waitForRealSystem(
        () => paired.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED,
        "real Pi threshold compaction turn",
        30_000
      );
    }
    const snapshot = await waitForRealSystem(
      () => paired.clients.event.getSnapshot({ scope: sessionScope }),
      (response) => compactionEvents(response.snapshot?.timeline ?? [])
        .some((event) => event.state === CompactionState.COMPLETED && event.reason === "threshold"),
      "real Pi threshold compaction projection",
      30_000
    );
    const events = compactionEvents(snapshot.snapshot?.timeline ?? [])
      .filter((event) => event.reason === "threshold");
    const eventsByCompaction = new Map<string, typeof events>();
    for (const event of events) {
      eventsByCompaction.set(event.compactionId, [...(eventsByCompaction.get(event.compactionId) ?? []), event]);
    }
    expect(eventsByCompaction.size).toBeGreaterThanOrEqual(1);
    for (const compaction of eventsByCompaction.values()) {
      expect(compaction.map((event) => event.state)).toEqual([
        CompactionState.STARTED,
        CompactionState.COMPLETED
      ]);
    }
    expect(events.every((event) => event.automatic)).toBe(true);
    expect(fixture.providerRequests.length).toBeGreaterThanOrEqual(2);
    const nativeEntries = await paired.clients.pi.listPiEntries({ sessionId });
    expect(nativeEntries.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ case: "compaction" }) })
    ]));
  });

  it("recovers an installed-Pi context overflow through compaction and one retry", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      piSettings: { compaction: { enabled: true, thresholdPercent: 95, keepRecentTokens: 1 } },
      overflowRequestNumbers: [2]
    });
    const paired = await fixture.pair("Real Pi overflow compaction E2E");
    const created = await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: "pi",
        targetId: "workspace-real-pi",
        displayName: "Real Pi overflow compaction",
        providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID,
        effortId: "off"
      })
    );
    const sessionId = sessionIdFrom(created);
    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 500 })
      }
    });

    for (const prompt of [
      "Establish history before the context overflow.",
      "Recover this turn after one simulated context overflow."
    ]) {
      const queued = await submit(
        paired.clients.operation,
        paired.connectionId,
        sendInputMutation(sessionId, prompt)
      );
      const runId = queueRunIdFrom(queued);
      await waitForRealSystem(
        () => paired.clients.run.getRun({ runId }),
        (response) => response.run?.state === RunState.SUCCEEDED,
        "real Pi overflow recovery turn",
        30_000
      );
    }

    const snapshot = await paired.clients.event.getSnapshot({ scope: sessionScope });
    const events = compactionEvents(snapshot.snapshot?.timeline ?? []);
    // Stock Pi persists the resulting native compaction entry but does not
    // retain its live overflow trigger on disk. The successful Run plus the
    // deterministic Provider sequence proves compact-and-retry; the external
    // Live-trigger execution remains a separate evidence gate.
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: CompactionState.COMPLETED, reason: "native_history" })
    ]));
    expect(fixture.providerRequests).toHaveLength(4);
    const nativeEntries = await paired.clients.pi.listPiEntries({ sessionId });
    expect(nativeEntries.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ case: "compaction" }) })
    ]));
  });
});

function compactionEvents(timeline: readonly {
  readonly payload?: {
    readonly kind: {
      readonly case: string | undefined;
      readonly value?: unknown;
    };
  };
}[]): {
  readonly compactionId: string;
  readonly state: CompactionState;
  readonly automatic: boolean;
  readonly reason: string;
  readonly willRetry?: boolean;
}[] {
  return timeline.flatMap((item) => item.payload?.kind.case === "compactionChanged"
    ? [item.payload.kind.value as {
      readonly compactionId: string;
      readonly state: CompactionState;
      readonly automatic: boolean;
      readonly reason: string;
      readonly willRetry?: boolean;
    }]
    : []);
}

async function waitForRealSystem<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}
