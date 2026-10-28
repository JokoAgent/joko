export interface HostedAgentPoolMember {
  occupiesSlot(): boolean;
  lastActivityAt(): number;
  isIdle(): boolean;
  release(idleMinutes: number): Promise<boolean>;
}

/** One actual Provider computer, across its native Backend kinds. The native
 * owner makes the final idle decision; a lost close reply still occupies a slot. */
export class HostedAgentConnectionPool {
  readonly #members = new Set<HostedAgentPoolMember>();
  readonly #timer: ReturnType<typeof setInterval>;
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(readonly options: { readonly idleMinutes: () => number; readonly maxRuns: () => number; readonly now?: () => number }) {
    this.#timer = setInterval(() => { void this.trim().catch(() => {}); }, 10_000); this.#timer.unref();
  }
  register(member: HostedAgentPoolMember): () => void {
    if (this.#closed) throw new Error("The native connection pool is closed.");
    this.#members.add(member); return () => this.#members.delete(member);
  }
  occupied(): number { return [...this.#members].filter(member => member.occupiesSlot()).length; }
  beforeOpen(): Promise<void> {
    return this.#serial(async () => {
      const maximum = this.options.maxRuns();
      if (Number.isSafeInteger(maximum) && maximum > 0 && this.occupied() >= maximum) await this.#releaseNext();
    });
  }
  releaseForRetry(): Promise<boolean> { return this.#serial(() => this.#releaseNext()); }
  trim(): Promise<void> {
    return this.#serial(async () => {
      const maximum = this.options.maxRuns(), watermark = Math.ceil(maximum * 0.8);
      if (!Number.isSafeInteger(maximum) || maximum < 1 || watermark >= maximum) return;
      while (this.occupied() >= watermark && await this.#releaseNext()) { /* Each confirmed close frees one native owner. */ }
    });
  }
  close(): void { this.#closed = true; clearInterval(this.#timer); this.#members.clear(); }
  #eligible(member: HostedAgentPoolMember): boolean {
    const minutes = this.options.idleMinutes();
    return !this.#closed && Number.isSafeInteger(minutes) && minutes > 0 && minutes <= 120
      && member.occupiesSlot() && member.isIdle() && (this.options.now ?? Date.now)() - member.lastActivityAt() >= minutes * 60_000;
  }
  async #releaseNext(): Promise<boolean> {
    const members = [...this.#members].filter(member => this.#eligible(member)).sort((a, b) => a.lastActivityAt() - b.lastActivityAt());
    for (const member of members) {
      if (!this.#eligible(member)) continue;
      try { if (await member.release(this.options.idleMinutes())) return true; } catch { /* Preserve occupancy and retry only the original owner. */ }
    }
    return false;
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(action, action); this.#chain = next.catch(() => {}); return next;
  }
}
