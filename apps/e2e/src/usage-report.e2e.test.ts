import { Code } from "@connectrpc/connect";
import { ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import { RunState, UsageReportGroup } from "@joko/contracts";
import { expect, it } from "vitest";
import { ControlledClaudeRuntime } from "./controlled-claude-runtime.js";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, deleteMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

it("reports all four Claude Code token counts from the settled run and its actual model", async () => {
  const runtime = new ControlledClaudeRuntime();
  const backendId = "claude-usage", modelId = "claude-remote-fixture";
  const fixture = await OrchestratorE2eFixture.start({ serverId: "orchestrator", profiles: [], backendFactories: [{
    instanceId: backendId, adapterKind: "claude-agent-sdk-stdio", displayName: "Controlled Claude usage",
    create: ({ generation }) => new ClaudeCodeAdapter({ id: backendId, instanceGeneration: generation, runtime, environment: {} })
  }] });
  try {
    const { clients, connectionId } = await fixture.pair("Usage history");
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const runId = queueRunIdFrom(await submit(clients.operation, connectionId, sendInputMutation(sessionId, BigInt(generation), "Measure this reply")));
    await waitFor(() => clients.run.getRun({ runId }), ({ run }) => run?.state === RunState.RUNNING, "Claude input admission");
    runtime.queries[0]!.complete("Measured reply", {
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      modelUsage: { [modelId]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 0 } }
    });
    const { run } = await waitFor(() => clients.run.getRun({ runId }), ({ run }) => run?.state === RunState.SUCCEEDED, "Claude usage settlement");
    const counts = { inputTokens: 10n, outputTokens: 5n, cacheReadTokens: 1000n, cacheWriteTokens: 200n, totalTokens: 1215n };
    expect(run?.usage?.usage).toMatchObject(counts);
    const report = await clients.backend.getUsageReport({ group: UsageReportGroup.MODEL, backendId, sessionId });
    expect(report.summary?.usage).toMatchObject(counts);
    expect(report.entries).toMatchObject([{ modelId, summary: { usage: counts } }]);
  } finally { await fixture.close(); }
});

it("keeps authenticated history pages stable through unrelated client activity and retires changed usage", async () => {
  const fixture = await OrchestratorE2eFixture.start();
  try {
    const first = await fixture.pair("Usage history");
    const second = await fixture.pair("Second window");
    const [backendId, targetId] = [...fixture.targets][0]!;
    const sessionId = sessionIdFrom(await submit(first.clients.operation, first.connectionId, createSessionMutation({ backendId, targetId })));
    const session = fixture.application.store.getSession(sessionId);
    for (let index = 0; index < 2; index++) fixture.application.store.recordUsageObservation({
      ownerId: "orchestrator-e2e", sessionId, sourceId: `run:${index}`, generation: session.descriptor.binding.generation,
      backendId, providerId: "historical-provider", modelId: `historical-model-${index}`,
      measuredAt: Date.UTC(2025, 0, index + 1), inputTokens: 10 + index, outputTokens: 0,
      totalTokens: 10 + index, cacheReadTokens: 0, cacheWriteTokens: 0, currencyCode: "USD"
    });
    const query = { group: UsageReportGroup.MODEL, providerId: "historical-provider", page: { pageSize: 1 } };
    await expect(fixture.anonymous.backend.getUsageReport(query)).rejects.toMatchObject({ code: Code.Unauthenticated });
    const page = await first.clients.backend.getUsageReport(query);
    expect(page.page?.totalSize).toBe(2n);
    expect(page.summary?.usage?.totalTokens).toBe(21n);
    expect(page.summary?.costComplete).toBe(false);
    expect(page.entries[0]?.modelId).toBe("historical-model-1");
    const next = await first.clients.backend.getUsageReport({ ...query, page: { ...query.page, pageToken: page.page!.nextPageToken } });
    expect(next.entries[0]?.modelId).toBe("historical-model-0");
    for (const group of [UsageReportGroup.TASK, UsageReportGroup.PROVIDER, UsageReportGroup.BACKEND]) {
      const grouped = await first.clients.backend.getUsageReport({ group, sessionId, backendId,
        providerId: "historical-provider", fromDay: "2025-01-01", throughDay: "2025-01-02" });
      expect(grouped.page?.totalSize).toBe(1n);
      expect(grouped.summary?.usage?.totalTokens).toBe(21n);
      expect(grouped.entries[0]?.summary?.usage?.totalTokens).toBe(21n);
    }
    await submit(second.clients.operation, second.connectionId, createSessionMutation({ backendId, targetId }));
    expect((await first.clients.backend.getUsageReport({ ...query, page: { ...query.page, pageToken: page.page!.nextPageToken } })).entries[0]?.modelId).toBe("historical-model-0");
    fixture.application.store.recordUsageObservation({
      ownerId: "orchestrator-e2e", sessionId, sourceId: "run:later", generation: session.descriptor.binding.generation,
      backendId, providerId: "historical-provider", modelId: "historical-model-0", measuredAt: Date.UTC(2025, 0, 3),
      inputTokens: 1, outputTokens: 0, totalTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, currencyCode: "USD"
    });
    await expect(first.clients.backend.getUsageReport({ ...query, page: { ...query.page, pageToken: page.page!.nextPageToken } }))
      .rejects.toMatchObject({ code: Code.Aborted });
    expect((await first.clients.backend.getUsageReport(query)).summary?.usage?.totalTokens).toBe(22n);
    await expect(first.clients.backend.getUsageReport({ ...query, fromDay: "2026-02-30" })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(first.clients.backend.getUsageReport({ ...query, page: { pageSize: 101 } })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await submit(first.clients.operation, first.connectionId, deleteMutation(sessionId));
    const retained = await second.clients.backend.getUsageReport({ group: UsageReportGroup.TASK, sessionId });
    expect(retained.entries[0]).toMatchObject({ sessionId, referenceAvailable: false, title: "" });
    expect(retained.summary?.usage?.totalTokens).toBe(22n);
  } finally { await fixture.close(); }
});
