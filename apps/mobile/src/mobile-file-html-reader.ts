import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BlobRef } from "@joko/contracts";
import { bytesToDataUri, normalizeMediaType } from "./workspace-files";
import { awaitMobileMarkdownResourceRead } from "./mobile-markdown-resources";
import {
  applyHtmlResourceUrls, collectHtmlLocalResourceRefs, fetchHtmlResourceUrls, planHtmlResourceFetches,
  HtmlResourceBudgetError, type HtmlResourceFetchTarget
} from "./mobile-file-html-resources";

export interface MobileFileHtmlDescriptor {
  readonly leaseId: string; readonly html: string;
  readonly total: number; readonly failed: number; readonly overLimit: number; readonly overBudget: number;
}
export interface MobileFileHtmlContext {
  readonly baseDirectory?: string;
  assertCurrent(signal?: AbortSignal): void;
  revalidateSource?(signal: AbortSignal): Promise<void>;
  readResource?(target: HtmlResourceFetchTarget, maximumBytes: number, signal: AbortSignal): Promise<{
    readonly blob: BlobRef; readonly bytes: Uint8Array; readonly mediaType: string;
  }>;
}
interface Lease { readonly id: string; readonly context: MobileFileHtmlContext; readonly controller: AbortController }
export class MobileFileHtmlReader {
  #leases = new Map<string, Lease>();
  #active = 0;
  #waiting: { signal: AbortSignal; grant(): void; cancel(): void }[] = [];

  async prepare(id: string, html: string, context: MobileFileHtmlContext, signal: AbortSignal): Promise<MobileFileHtmlDescriptor> {
    context.assertCurrent(signal);
    // Files has one current HTML page. Retire its old presentation while raw canceled work keeps its slot until settlement.
    this.releaseAll();
    const lease: Lease = { id, context, controller: new AbortController() }; this.#leases.set(id, lease);
    const abort = () => lease.controller.abort();
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const deadline = setTimeout(abort, 15_000);
    try {
      const refs = collectHtmlLocalResourceRefs(html, context.baseDirectory ?? "");
      const plan = planHtmlResourceFetches(refs);
      if (!plan.targets.length) return { leaseId: id, html, total: 0, failed: 0, overLimit: plan.skipped, overBudget: 0 };
      if (context.baseDirectory === undefined || !context.readResource || !context.revalidateSource) {
        return { leaseId: id, html, total: plan.targets.length, failed: plan.targets.length, overLimit: plan.skipped, overBudget: 0 };
      }
      await this.#read(lease, (current) => context.revalidateSource!(current));
      const outcome = await fetchHtmlResourceUrls(plan.targets, async (target, limits) => {
        const resource = await this.#read(lease, (current) => context.readResource!(target, limits.maxBytes, current));
        this.#assert(lease);
        if (resource.bytes.byteLength > limits.maxBytes) throw new HtmlResourceBudgetError("The HTML resource exceeded its budget.");
        if (BigInt(resource.bytes.byteLength) !== resource.blob.byteSize
          || !/^[0-9a-f]{64}$/u.test(resource.blob.sha256Hex)
          || bytesToHex(sha256(resource.bytes)) !== resource.blob.sha256Hex
          || normalizeMediaType(resource.mediaType) !== normalizeMediaType(resource.blob.mediaType)) {
          throw new Error("The HTML resource did not return its exact authenticated bytes.");
        }
        return bytesToDataUri(resource.bytes, target.mimeType);
      }, { baseDirectory: context.baseDirectory, isCancelled: () => lease.controller.signal.aborted });
      this.#assert(lease);
      await this.#read(lease, (current) => context.revalidateSource!(current));
      this.#assert(lease);
      return { leaseId: id, html: applyHtmlResourceUrls(html, refs, outcome.urls), total: plan.targets.length,
        failed: outcome.failed, overLimit: plan.skipped, overBudget: outcome.overBudget };
    } catch (error) { this.release(id); throw error; }
    finally { clearTimeout(deadline); signal.removeEventListener("abort", abort); }
  }
  assertCurrent(id: string): void {
    const lease = this.#leases.get(id); if (!lease) throw new Error("The HTML page was released."); this.#assert(lease);
  }
  release(id: string): void { const lease = this.#leases.get(id); lease?.controller.abort(); this.#leases.delete(id); }
  releaseAll(): void { for (const id of this.#leases.keys()) this.release(id); }
  retireStale(): void { for (const lease of this.#leases.values()) { try { this.#assert(lease); } catch { this.release(lease.id); } } }
  #assert(lease: Lease): void {
    lease.controller.signal.throwIfAborted();
    if (this.#leases.get(lease.id) !== lease) throw new Error("The HTML page changed.");
    lease.context.assertCurrent(lease.controller.signal);
  }
  async #read<T>(lease: Lease, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assert(lease); const signal = lease.controller.signal;
    await this.#acquire(signal);
    let raw: Promise<T>;
    try { this.#assert(lease); raw = read(signal); }
    catch (error) { this.#releaseRead(); throw error; }
    void raw.then(() => this.#releaseRead(), () => this.#releaseRead());
    const result = await awaitMobileMarkdownResourceRead(raw, signal);
    this.#assert(lease); return result;
  }
  #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#active < 4 && !this.#waiting.length) { this.#active += 1; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiting = { signal, grant: () => { signal.removeEventListener("abort", waiting.cancel); resolve(); },
        cancel: () => { signal.removeEventListener("abort", waiting.cancel); this.#waiting = this.#waiting.filter((item) => item !== waiting);
          reject(new Error("The HTML resource read was cancelled.")); } };
      this.#waiting.push(waiting); signal.addEventListener("abort", waiting.cancel, { once: true });
    });
  }
  #releaseRead(): void {
    this.#active -= 1;
    while (this.#active < 4 && this.#waiting.length) {
      const waiting = this.#waiting.shift()!;
      if (waiting.signal.aborted) waiting.cancel();
      else { this.#active += 1; waiting.grant(); }
    }
  }
}
