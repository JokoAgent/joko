/** Ephemeral native presentation memory; no conversation content is retained. */
export class MobilePartnerEntranceLedger {
  readonly #played = new Set<string>();
  claim(key: string, timestamp: number | undefined, now = Date.now()): boolean {
    if (timestamp === undefined || !Number.isFinite(timestamp) || now < timestamp || now - timestamp >= 15_000 || this.#played.has(key)) return false;
    this.#played.add(key);
    if (this.#played.size > 200) this.#played.delete(this.#played.values().next().value!);
    return true;
  }
}
