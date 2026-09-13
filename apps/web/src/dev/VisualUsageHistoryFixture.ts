import type { AppController } from "../controller.js";
import type { UsageHistorySummaryView, UsageReportEntryView, UsageReportView, UsageTokensView } from "../model.js";

/** Fixed, content-free records for the production history surface; never reads a service or account. */
export class VisualUsageHistoryFixture {
  #failed = false;
  constructor(private readonly state: "ready" | "empty" | "error" = "ready") {}

  getUsageReport: AppController["getUsageReport"] = async (query, signal) => {
    await Promise.resolve();
    signal.throwIfAborted();
    if (this.state === "error" && !this.#failed) { this.#failed = true; throw new Error("The usage report is temporarily unavailable. Your filters are kept."); }
    const groups = new Map<string, UsageReportEntryView>();
    for (const record of this.state === "empty" ? [] : records) {
      const day = new Date(record.measuredAt).toISOString().slice(0, 10);
      if (query.fromDay !== undefined && day < query.fromDay || query.throughDay !== undefined && day > query.throughDay) continue;
      if ((["backendId", "providerId", "modelId", "sessionId"] as const).some((field) => query[field] !== undefined && query[field] !== record[field])) continue;
      const identity = query.group === "task" ? [record.sessionId]
        : query.group === "backend" ? [record.backendId]
        : query.group === "provider" ? [record.backendId, record.providerId] : [record.backendId, record.providerId, record.modelId];
      const key = JSON.stringify([query.group, ...identity]);
      const prior = groups.get(key);
      groups.set(key, { ...record, key, ...(query.group === "task" ? {} : { sessionId: "", referenceAvailable: false }),
        summary: prior === undefined ? record.summary : combine([prior.summary, record.summary]) });
    }
    const entries = [...groups.values()];
    const offset = query.pageToken === undefined ? 0 : Number(query.pageToken);
    if (!Number.isInteger(offset) || offset < 0 || offset > entries.length) throw new Error("The report page is unavailable. Refresh this report.");
    return { entries: entries.slice(offset, offset + 3), summary: combine(entries.map((entry) => entry.summary)),
      nextPageToken: offset + 3 < entries.length ? String(offset + 3) : "", totalGroups: entries.length } satisfies UsageReportView;
  };
}

function usage(multiplier: number, currencyCode: string): UsageTokensView {
  return { inputTokens: 12_000 * multiplier, outputTokens: 1_600 * multiplier, cacheReadTokens: 8_000 * multiplier,
    cacheWriteTokens: 2_000 * multiplier, totalTokens: 23_600 * multiplier, costMicros: 48_500 * multiplier, currencyCode };
}
function combine(summaries: readonly UsageHistorySummaryView[]): UsageHistorySummaryView {
  const total = { ...usage(0, "") };
  const currencies = new Map<string, UsageHistorySummaryView["currencyTotals"][number]>();
  for (const summary of summaries) {
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) total[key] += summary.usage[key];
    for (const currency of summary.currencyTotals) {
      const prior = currencies.get(currency.currencyCode);
      const summed = { ...currency.usage };
      if (prior !== undefined) for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costMicros"] as const) summed[key] += prior.usage[key];
      currencies.set(currency.currencyCode, { ...currency, usage: summed, costComplete: currency.costComplete && (prior?.costComplete ?? true), estimated: currency.estimated || (prior?.estimated ?? false) });
    }
  }
  const singleCurrency = currencies.size === 1 ? [...currencies.values()][0] : undefined;
  total.currencyCode = singleCurrency?.currencyCode ?? "";
  total.costMicros = singleCurrency?.usage.costMicros ?? 0;
  return { usage: total, currencyTotals: [...currencies.values()], costComplete: singleCurrency !== undefined && summaries.every((summary) => summary.costComplete), estimated: summaries.some((summary) => summary.estimated) };
}

const records: readonly UsageReportEntryView[] = [
  "Review workspace permissions", "Draft the deployment notes", "Compare two model responses", "Investigate a removed task", "Check the next release"
].map((title, index) => {
  const tokens = usage(index + 1, index === 2 ? "CNY" : "USD");
  const costComplete = index !== 3;
  const estimated = index === 1;
  return { key: String(index), title: index === 3 ? "" : title, sessionId: index === 3 ? "removed-task" : `session-${index + 1}`,
    backendId: index > 2 ? "remote-worker" : "local-worker", providerId: index === 2 ? "local-source" : "cloud-source",
    modelId: index % 2 === 0 ? "reasoning-medium" : "fast-small", referenceAvailable: index !== 3,
    measuredAt: Date.UTC(2026, 8, 9, 4, index * 7), summary: { usage: tokens, costComplete, estimated,
      currencyTotals: [{ currencyCode: tokens.currencyCode, usage: tokens, costComplete, estimated }] } };
});
