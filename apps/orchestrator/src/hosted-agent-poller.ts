import type { HostedAgentRunPort } from "./hosted-agent-controller.js";
import type { HostedAgentPollCursor, HostedAgentPollRun } from "./hosted-agent-host.js";

export interface HostedAgentTransport {
  poll(cursors: readonly HostedAgentPollCursor[], signal: AbortSignal): Promise<readonly HostedAgentPollRun[]>;
  reply(runId: string, id: string, result: Parameters<HostedAgentRunPort["reply"]>[1], signal: AbortSignal): Promise<void>;
  readArtifact(runId: string, id: string, offset: number, maximum: number, signal: AbortSignal): Promise<{ readonly data: string }>;
}
interface PendingPoll {
  readonly after: number;
  readonly signal: AbortSignal;
  readonly resolve: (value: Awaited<ReturnType<HostedAgentRunPort["poll"]>>) => void;
  readonly reject: (error: Error) => void;
  readonly detach: () => void;
}

/** Source-computer connection owner. Per-task controllers can await their own
 * durable cursor while all tasks use one read-only request to a Provider node.
 * Adding/cancelling a task interrupts only that read, never a native mutation. */
export class HostedAgentPoller {
  readonly #transport: HostedAgentTransport;
  readonly #pending = new Map<string, PendingPoll>();
  readonly #attached = new Set<string>();
  #active?: AbortController;
  #pump?: Promise<void>;
  #closed = false;

  constructor(transport: HostedAgentTransport) { this.#transport = transport; }
  attach(runId: string): HostedAgentRunPort & { detach(): void } {
    if (this.#closed || !runId || runId.length > 512 || this.#attached.has(runId)) throw new Error("Hosted Agent poll ownership is invalid.");
    this.#attached.add(runId);
    const assertAttached = () => { if (this.#closed || !this.#attached.has(runId)) throw new Error("Hosted Agent poll ownership has closed."); };
    return {
      poll: (after, signal) => {
        assertAttached(); signal.throwIfAborted();
        if (!Number.isSafeInteger(after) || after < 0 || this.#pending.has(runId)) throw new Error("Hosted Agent cursor is invalid or already pending.");
        const result = new Promise<Awaited<ReturnType<HostedAgentRunPort["poll"]>>>((resolve, reject) => {
          const abort = () => { const pending = this.#pending.get(runId); if (pending?.signal !== signal) return;
            this.#pending.delete(runId); pending.detach(); reject(new Error("Hosted Agent polling was cancelled.")); this.#active?.abort(); };
          this.#pending.set(runId, { after, signal, resolve, reject, detach: () => signal.removeEventListener("abort", abort) });
          signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
        });
        this.#active?.abort(); this.#start(); return result;
      },
      reply: (id, result, signal) => { assertAttached(); signal.throwIfAborted(); return this.#transport.reply(runId, id, result, signal); },
      readArtifact: (id, offset, maximum, signal) => { assertAttached(); signal.throwIfAborted(); return this.#transport.readArtifact(runId, id, offset, maximum, signal); },
      detach: () => { if (!this.#attached.delete(runId)) return; const pending = this.#pending.get(runId);
        if (pending) { this.#pending.delete(runId); pending.detach(); pending.reject(new Error("Hosted Agent task was detached.")); }
        this.#active?.abort(); }
    };
  }
  async close(): Promise<void> {
    this.#closed = true; this.#active?.abort(); this.#attached.clear();
    for (const pending of this.#pending.values()) { pending.detach(); pending.reject(new Error("Hosted Agent connection has closed.")); }
    this.#pending.clear(); await this.#pump;
  }
  #start(): void {
    if (this.#pump || this.#closed || !this.#pending.size) return;
    this.#pump = this.#consume().finally(() => { this.#pump = undefined; if (this.#pending.size && !this.#closed) this.#start(); });
  }
  async #consume(): Promise<void> {
    while (!this.#closed && this.#pending.size) {
      const pending = new Map(this.#pending), cursors = [...pending].map(([runId, value]) => ({ runId, after: value.after }));
      const active = new AbortController(); this.#active = active;
      try {
        const batches = await this.#transport.poll(cursors, active.signal);
        if (active.signal.aborted || this.#closed) continue;
        const seen = new Set<string>();
        for (const batch of batches) {
          const owner = pending.get(batch.runId);
          if (!owner || seen.has(batch.runId) || !Array.isArray(batch.frames) || !Number.isSafeInteger(batch.cursor) || batch.cursor < owner.after
            || typeof batch.finished !== "boolean") throw new Error("Hosted Agent poll returned an invalid owner or cursor.");
          seen.add(batch.runId); let cursor = owner.after;
          for (const frame of batch.frames) { if (frame.sequence !== ++cursor) throw new Error("Hosted Agent poll returned a cursor gap."); }
          if (cursor !== batch.cursor) throw new Error("Hosted Agent poll returned an invalid final cursor.");
          if (this.#pending.get(batch.runId) !== owner || !batch.frames.length && !batch.finished) continue;
          this.#pending.delete(batch.runId); owner.detach(); owner.resolve(batch);
        }
      } catch (error) {
        if (active.signal.aborted || this.#closed) continue;
        // The caller may reconnect using its unchanged, durably persisted
        // cursors. No call, reply, or native effect is replayed here.
        for (const [id, owner] of pending) if (this.#pending.get(id) === owner) {
          this.#pending.delete(id); owner.detach(); owner.reject(new Error("Hosted Agent event transport is unavailable."));
        }
      } finally { if (this.#active === active) this.#active = undefined; }
    }
  }
}
