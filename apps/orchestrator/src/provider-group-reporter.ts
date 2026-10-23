import { create, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { ProviderGroupStore } from "@joko/store";
import type { ProviderGroupRemoteRouter } from "./provider-group-remote.js";
import type { ProviderGroupLeases } from "./provider-group-leases.js";
import type { ProviderGroupUsage } from "./provider-group-usage.js";
import { toGroupUsage } from "./provider-group-wire.js";

/** Accounting reports are independent of dispatch. Failures retain the local
 * ledger, back off, and never retry or interrupt a native Agent command. */
export class ProviderGroupReporter {
  readonly #lifetime = new AbortController();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #leaseTimer?: ReturnType<typeof setTimeout>; #usageTimer?: ReturnType<typeof setTimeout>;
  #leaseFlight?: Promise<void>; #usageFlight?: Promise<void>; #usageFailures = 0;
  constructor(readonly options: { readonly groups: ProviderGroupStore; readonly remote: ProviderGroupRemoteRouter; readonly leases: ProviderGroupLeases; readonly usage: ProviderGroupUsage;
    readonly now?: () => number }) {
    this.#heartbeat = setInterval(() => { this.leasesChanged(); }, 60_000); this.#heartbeat.unref();
    this.leasesChanged(); this.#scheduleUsage(20_000);
  }
  leasesChanged(): void { if (!this.#lifetime.signal.aborted && !this.#leaseTimer) { this.#leaseTimer = setTimeout(() => { this.#leaseTimer = undefined; void this.#sendLeases().catch(() => this.#scheduleLeasesRetry()); }, 1000); this.#leaseTimer.unref(); } }
  usageChanged(): void { if (!this.#lifetime.signal.aborted) this.#scheduleUsage(5000); }
  async close(): Promise<void> {
    clearInterval(this.#heartbeat); clearTimeout(this.#leaseTimer); clearTimeout(this.#usageTimer);
    // Send the terminal full empty snapshot before closing its captured owner.
    await this.#leaseFlight?.catch(() => {}); await this.#sendLeases(true).catch(() => {});
    this.#lifetime.abort(); await this.#usageFlight?.catch(() => {});
  }
  #owners() { return [...new Map(this.options.groups.remoteSnapshots().flatMap(group => group.ownerNodeId ? [[group.ownerNodeId, { backendId: group.backendId, providerId: group.providerId }] as const] : [])).entries()]; }
  #sendLeases(empty = false): Promise<void> {
    return this.#leaseFlight ??= (async () => {
      for (const [nodeId, group] of this.#owners()) {
        const owner = this.options.remote.capture(group), active = empty ? [] : this.options.leases.active();
        const leases = active.flatMap(lease => { const binding = this.options.groups.binding(lease.sessionId); if (!binding || binding.ownerNodeId !== nodeId) return [];
          const member = this.options.groups.snapshot(binding.group).config?.members.find(member => member.key === binding.memberKey); if (!member) return [];
          return [{ sessionId: lease.sessionId, memberKey: member.key, backendId: member.nativeBackendId, providerId: member.providerId }]; });
        const sequence = this.options.usage.usage.nextSequence("leases:" + nodeId, this.#now());
        await owner.client.reportProviderGroupLeases({ sequence, leases }, { signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5000)]) }); owner.assertCurrent();
      }
    })().finally(() => { this.#leaseFlight = undefined; });
  }
  #scheduleLeasesRetry(): void { if (!this.#lifetime.signal.aborted && !this.#leaseTimer) { this.#leaseTimer = setTimeout(() => { this.#leaseTimer = undefined; void this.#sendLeases().catch(() => this.#scheduleLeasesRetry()); }, 15_000); this.#leaseTimer.unref(); } }
  #scheduleUsage(delay: number): void {
    if (this.#usageTimer || this.#lifetime.signal.aborted) return;
    this.#usageTimer = setTimeout(() => { this.#usageTimer = undefined; void this.#sendUsage().then(() => { this.#usageFailures = 0; }, () => {
      const delay = Math.min(600_000, 30_000 * 2 ** Math.min(5, this.#usageFailures++)); this.#scheduleUsage(delay);
    }); }, delay); this.#usageTimer.unref();
  }
  #sendUsage(): Promise<void> {
    return this.#usageFlight ??= (async () => {
      const sinceDay = "1970-01-01", all = this.options.usage.usage.localRows(sinceDay);
      for (const [nodeId, group] of this.#owners()) {
        const owner = this.options.remote.capture(group), groups = this.options.groups.remoteSnapshots().filter(group => group.ownerNodeId === nodeId);
        const rows = all.filter(row => groups.some(group => group.backendId === row.group.backendId && group.providerId === row.group.providerId)).map(row => {
          const source = this.options.remote.capture(row.group);
          return toGroupUsage({ ...row, group: { backendId: source.nativeBackendId, providerId: row.group.providerId } });
        });
        const sequence = this.options.usage.usage.nextSequence("usage:" + nodeId, this.#now());
        const parts: contract.ProviderGroupUsageRow[][] = [[]]; let bytes = 0;
        for (const row of rows) { const size = toBinary(contract.ProviderGroupUsageRowSchema, row).byteLength + 32; if (size > 512 * 1024) throw new Error("Provider usage row exceeds its transport capacity.");
          if (parts.at(-1)!.length >= 1000 || bytes + size > 512 * 1024) { parts.push([]); bytes = 0; } parts.at(-1)!.push(row); bytes += size; }
        for (let index = 0; index < parts.length; index++) {
          owner.assertCurrent(); const result = await owner.client.reportProviderGroupUsage(create(contract.ReportProviderGroupUsageRequestSchema, { sequence, sinceDay, partIndex: index, partCount: parts.length, rows: parts[index]! }),
            { signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15_000)]) });
          owner.assertCurrent(); if (!result.accepted || result.complete !== (index === parts.length - 1)) throw new Error("Provider usage snapshot was not acknowledged.");
        }
      }
    })().finally(() => { this.#usageFlight = undefined; });
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
}
