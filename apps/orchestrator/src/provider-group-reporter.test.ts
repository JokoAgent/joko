import type { ReportProviderGroupUsageRequest } from "@joko/contracts";
import type { ProviderGroupKey, ProviderGroupUsageRow } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderGroupLeases } from "./provider-group-leases.js";
import { ProviderGroupReporter } from "./provider-group-reporter.js";

function reporting(nodes: string[]) {
  vi.useFakeTimers();
  const groups = nodes.map(node => ({ ownerNodeId: node, backendId: node, providerId: "group" }));
  const clients = new Map(nodes.map(node => [node, {
    reportProviderGroupLeases: vi.fn(async () => ({})),
    reportProviderGroupUsage: vi.fn(async (_request: ReportProviderGroupUsageRequest) => ({ accepted: true, complete: true }))
  }]));
  let sequence = 0n;
  const sample: ProviderGroupUsageRow = { group: groups.at(-1)!, memberKey: "member", nodeId: "worker", nodeName: "Worker",
    partyId: "worker", partyName: "Worker", agentKind: "pi", backendId: "pi", providerId: "api", modelId: "model",
    day: "2026-11-27", turns: 1, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10,
    costMicros: 0, currencyCode: "USD", estimated: false, costComplete: true, tokensComplete: true, lastAt: 1 };
  const localRows = vi.fn(() => [sample]);
  const reporter = new ProviderGroupReporter({
    leases: new ProviderGroupLeases(), groups: { remoteSnapshots: () => groups },
    usage: { usage: { nextSequence: () => ++sequence, localRows } },
    remote: { capture: (group: ProviderGroupKey) => ({ nativeBackendId: "pi", client: clients.get(group.backendId)!, assertCurrent() {} }) }
  } as unknown as ConstructorParameters<typeof ProviderGroupReporter>[0]);
  return { reporter, clients, localRows, sample };
}

afterEach(() => vi.useRealTimers());

it("delivers leases and usage to the healthy owner while the first stays offline", async () => {
  const { reporter, clients } = reporting(["offline", "healthy"]);
  const first = clients.get("offline")!, healthy = clients.get("healthy")!;
  first.reportProviderGroupLeases.mockRejectedValue(new Error("offline"));
  first.reportProviderGroupUsage.mockRejectedValue(new Error("offline"));
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.reportProviderGroupLeases.mock.calls.length).toBeGreaterThan(1);
    expect(first.reportProviderGroupUsage.mock.calls.length).toBeGreaterThan(1);
    expect(healthy.reportProviderGroupLeases).toHaveBeenCalled();
    expect(healthy.reportProviderGroupUsage.mock.calls[0]?.[0].rows[0]?.totalTokens).toBe(10n);
  } finally { await reporter.close(); }
});

it("takes a fresh usage snapshot after a notification during a slow success", async () => {
  const { reporter, clients, localRows, sample } = reporting(["owner"]);
  const send = clients.get("owner")!.reportProviderGroupUsage;
  let acknowledge!: () => void;
  send.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { acknowledge = resolve; });
    return { accepted: true, complete: true };
  });
  try {
    await vi.advanceTimersByTimeAsync(20_000);
    localRows.mockReturnValue([{ ...sample, turns: 2, inputTokens: 20, totalTokens: 20 }]);
    reporter.usageChanged();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    acknowledge();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send.mock.calls.map(([request]) => request.rows[0]?.totalTokens)).toEqual([10n, 20n]);
  } finally { acknowledge?.(); await reporter.close(); }
});
