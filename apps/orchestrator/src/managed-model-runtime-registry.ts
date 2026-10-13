import { LocalRuntimeError } from "@joko/local-model-runtime";
import type { ManagedModelRuntimePort } from "./managed-model-runtime-port.js";

export class ManagedModelRuntimeRegistry {
  readonly #entries = new Map<string, ManagedModelRuntimePort>();
  #closed = false;
  #closing = false;
  constructor(entries: readonly ManagedModelRuntimePort[]) {
    for (const entry of entries) {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(entry.runtimeId) || this.#entries.has(entry.runtimeId)) {
        throw new Error("A managed runtime requires a unique exact public identity.");
      }
      this.#entries.set(entry.runtimeId, entry);
    }
  }
  list(): readonly ManagedModelRuntimePort[] { this.#assertOpen(); return [...this.#entries.values()]; }
  get(runtimeId: string): ManagedModelRuntimePort | undefined { this.#assertOpen(); return this.#entries.get(runtimeId); }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    const results = await Promise.allSettled([...this.#entries.values()].map(entry => entry.close()));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "A managed runtime has not confirmed shutdown.");
    this.#closed = true;
  }
  #assertOpen(): void { if (this.#closed || this.#closing) throw new LocalRuntimeError("OWNER_CHANGED", "The managed runtime registry is retired."); }
}
