/** A Provider computer may offer one handoff after a member fails. The offer
 * travels only on its authenticated native stream and grants no model, task,
 * filesystem, Device, or owner authority. It is never persisted as a message. */
export class ProviderGroupGuestSwitch {
  readonly #offered = new Map<string, { readonly backendId: string; readonly generation: number; readonly value: string; readonly at: number }>();
  readonly #armed = new Map<string, { readonly backendId: string; readonly value: string; readonly at: number }>();
  readonly #seen = new Set<string>();
  readonly #newRound = new Set<string>();
  constructor(readonly now: () => number = Date.now) {}
  offer(sessionId: string, backendId: string, generation: number, value: string): void {
    if (!sessionId || !backendId || !Number.isSafeInteger(generation) || generation < 1 || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid Provider group switch offer.");
    this.#offered.set(sessionId, { backendId, generation, value, at: this.now() });
    this.#seen.delete(sessionId); this.#seen.add(sessionId);
    while (this.#seen.size > 512) { const oldest = this.#seen.values().next().value!; this.#seen.delete(oldest); this.#newRound.delete(oldest); this.#offered.delete(oldest); this.#armed.delete(oldest); }
  }
  has(sessionId: string, backendId: string, generation: number): boolean {
    const value = this.#offered.get(sessionId);
    return value !== undefined && value.backendId === backendId && value.generation === generation && this.now() - value.at <= 120_000;
  }
  claim(sessionId: string, backendId: string, generation: number): boolean {
    if (!this.has(sessionId, backendId, generation)) { this.#offered.delete(sessionId); return false; }
    const value = this.#offered.get(sessionId)!; this.#offered.delete(sessionId); this.#armed.set(sessionId, { backendId, value: value.value, at: this.now() }); return true;
  }
  takeForOpen(sessionId: string, backendId: string): string | undefined {
    const value = this.#armed.get(sessionId); this.#armed.delete(sessionId);
    return value?.backendId === backendId && this.now() - value.at <= 600_000 ? value.value : undefined;
  }
  release(sessionId: string): void { this.#armed.delete(sessionId); }
  drop(sessionId: string): void { this.#offered.delete(sessionId); this.#armed.delete(sessionId); if (this.#seen.has(sessionId)) this.#newRound.add(sessionId); }
  takeNewRound(sessionId: string): boolean { return this.#newRound.delete(sessionId); }
  clear(): void { this.#offered.clear(); this.#armed.clear(); this.#seen.clear(); this.#newRound.clear(); }
}
