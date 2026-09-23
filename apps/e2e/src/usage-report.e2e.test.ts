import { Code } from "@connectrpc/connect";
import { UsageReportGroup } from "@joko/contracts";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, deleteMutation, sessionIdFrom, submit } from "./operations.js";

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
