import type { PartnerNetworkExecution } from "./gen/joko/v1/partner_network_pb.js";

export function networkFailureSourceBatches(messages: readonly { readonly id: string; readonly deleted?: boolean }[]): readonly string[][] {
  const ids = [...new Set(messages.filter(message => !message.deleted).map(message => message.id).filter(Boolean))];
  return Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100));
}
/** Ephemeral UI state only. A response replaces the complete currently loaded source set. */
export class PartnerNetworkFailureProjection {
  #version = 0;
  #rows: readonly PartnerNetworkExecution[] = [];
  get rows(): readonly PartnerNetworkExecution[] { return this.#rows; }
  clear(): void { this.#version++; this.#rows = []; }
  async refresh(messages: readonly { readonly id: string; readonly deleted?: boolean }[], query: (ids: readonly string[], signal: AbortSignal) => Promise<readonly PartnerNetworkExecution[]>, signal: AbortSignal): Promise<boolean> {
    const version = ++this.#version, batches = networkFailureSourceBatches(messages), ids = new Set(batches.flat());
    this.#rows = this.#rows.filter(job => ids.has(job.sourceMessageId));
    const results = await Promise.all(batches.map(batch => query(batch, signal)));
    if (signal.aborted || version !== this.#version) return false;
    this.#rows = [...new Map(results.flat().filter(job => ids.has(job.sourceMessageId) && ["failed", "unknown"].includes(job.status)).map(job => [`${job.id}:${job.lease}`, job])).values()];
    return true;
  }
}
