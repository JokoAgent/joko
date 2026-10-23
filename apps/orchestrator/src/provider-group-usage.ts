import type { RunUsageSummary } from "@joko/core";
import { groupKey, ProviderGroupStore, ProviderGroupUsageStore, type ProviderGroupUsageAttribution, type ProviderGroupUsageRow } from "@joko/store";
export interface ProviderGroupRunAttribution {
  readonly sessionId: string; readonly backendId: string; readonly providerId: string; readonly modelId: string; readonly agentKind: string;
  readonly nodeId: string; readonly nodeName: string; readonly partyId: string; readonly partyName: string;
}
export interface ProviderGroupUsageReport {
  readonly sequence: bigint; readonly sinceDay: string; readonly rows: readonly ProviderGroupUsageRow[];
}
export class ProviderGroupUsage {
  constructor(readonly groups: ProviderGroupStore, readonly usage: ProviderGroupUsageStore, readonly now: () => number = Date.now) {}
  capture(runId: string, input: ProviderGroupRunAttribution): void {
    const binding = this.groups.binding(input.sessionId), rows: ProviderGroupUsageAttribution[] = [];
    if (binding && binding.backendId === input.backendId && binding.providerId === input.providerId) {
      rows.push({ ...withoutSession(input), group: binding.group, memberKey: binding.memberKey });
    } else {
      // Ordinary local use is part of the owner's usage, even when that task
      // was opened before grouping. Remote private usage is never inferred.
      for (const group of this.groups.list()) for (const member of group.config?.members ?? []) if (member.kind === "local" && member.backendId === input.backendId && member.providerId === input.providerId) {
        rows.push({ ...withoutSession(input), group: { backendId: group.backendId, providerId: group.providerId }, memberKey: member.key });
      }
    }
    this.usage.capture(runId, rows);
  }
  finish(runId: string, summary: RunUsageSummary, at = this.now()): boolean { return this.usage.finish(runId, summary, at); }
  receive(sourceId: string, report: ProviderGroupUsageReport, assertAuthorized: (row: ProviderGroupUsageRow) => void): boolean {
    report.rows.forEach(assertAuthorized); return this.usage.replaceReported(sourceId, report.sequence, report.sinceDay, report.rows);
  }
  report(channel: string, sinceDay: string): ProviderGroupUsageReport {
    return { sequence: this.usage.nextSequence(channel, this.now()), sinceDay, rows: this.usage.localRows(sinceDay) };
  }
}
export function providerGroupUsageTotals(rows: readonly ProviderGroupUsageRow[]): readonly ProviderGroupUsageRow[] {
  const totals = new Map<string, ProviderGroupUsageRow>();
  for (const row of rows) {
    const key = JSON.stringify([groupKey(row.group), row.memberKey, row.partyId, row.nodeId, row.modelId, row.currencyCode]), previous = totals.get(key);
    if (!previous) { totals.set(key, row); continue; }
    const sum = (a: number, b: number) => { const value = a + b; if (!Number.isSafeInteger(value)) throw new Error("Provider group usage total exceeds exact integer capacity."); return value; };
    totals.set(key, { ...row, turns: sum(previous.turns, row.turns), inputTokens: sum(previous.inputTokens, row.inputTokens), outputTokens: sum(previous.outputTokens, row.outputTokens),
      cacheReadTokens: sum(previous.cacheReadTokens, row.cacheReadTokens), cacheWriteTokens: sum(previous.cacheWriteTokens, row.cacheWriteTokens), totalTokens: sum(previous.totalTokens, row.totalTokens),
      costMicros: sum(previous.costMicros, row.costMicros), estimated: previous.estimated || row.estimated, costComplete: previous.costComplete && row.costComplete,
      tokensComplete: previous.tokensComplete && row.tokensComplete, lastAt: Math.max(previous.lastAt, row.lastAt) });
  }
  return [...totals.values()];
}
function withoutSession(input: ProviderGroupRunAttribution): Omit<ProviderGroupRunAttribution, "sessionId"> {
  return { backendId: input.backendId, providerId: input.providerId, modelId: input.modelId, agentKind: input.agentKind,
    nodeId: input.nodeId, nodeName: input.nodeName, partyId: input.partyId, partyName: input.partyName };
}
