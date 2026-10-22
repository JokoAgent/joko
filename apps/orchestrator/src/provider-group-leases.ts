import { randomUUID } from "node:crypto";

export interface ProviderGroupActiveLease { readonly sessionId: string; readonly memberKey: string; readonly backendId: string; readonly providerId: string; }
interface Report { readonly sequence: bigint; readonly expires: number; readonly leases: readonly ProviderGroupActiveLease[]; }
interface Reservation extends ProviderGroupActiveLease { readonly expires: number; readonly token: string; }
/** Soft scheduling load, entirely separate from native-session admission.
 * Selection and reserve are synchronous; no two concurrent picks see a gap. */
export class ProviderGroupLeases {
  readonly #reports = new Map<string, Report>();
  readonly #reservations = new Map<string, Reservation>();
  readonly #active = new Map<string, ProviderGroupActiveLease>();
  constructor(readonly now: () => number = Date.now) {}
  reserve(lease: ProviderGroupActiveLease): { readonly token: string; release(): void } {
    this.#prune(); const token = randomUUID(); this.#reservations.set(token, { ...lease, token, expires: this.now() + 30_000 });
    return { token, release: () => { this.#reservations.delete(token); } };
  }
  started(lease: ProviderGroupActiveLease): void {
    this.#active.set(lease.sessionId, lease);
    for (const [token, row] of this.#reservations) if (row.sessionId === lease.sessionId && row.memberKey === lease.memberKey) this.#reservations.delete(token);
  }
  ended(sessionId: string): void {
    this.#active.delete(sessionId); for (const [token, row] of this.#reservations) if (row.sessionId === sessionId) this.#reservations.delete(token);
  }
  report(controllerId: string, sequence: bigint, leases: readonly ProviderGroupActiveLease[]): boolean {
    if (!controllerId || sequence < 0n || leases.length > 4096 || new Set(leases.map(row => row.sessionId)).size !== leases.length
      || leases.some(row => !row.sessionId || !row.memberKey || !row.backendId || !row.providerId)) throw new Error("Invalid Provider group lease report.");
    const previous = this.#reports.get(controllerId); if (previous && previous.sequence >= sequence) return false;
    this.#reports.set(controllerId, { sequence, expires: this.now() + 150_000, leases: structuredClone(leases) });
    const ownerPrefix = JSON.stringify([controllerId]).slice(0, -1) + ",";
    for (const [token, row] of this.#reservations) if (row.sessionId.startsWith(ownerPrefix) || leases.some(lease => lease.sessionId === row.sessionId && lease.memberKey === row.memberKey)) this.#reservations.delete(token);
    return true;
  }
  count(memberKey: string, actualRunning = 0): number {
    this.#prune(); const seen = new Set<string>();
    for (const row of this.#active.values()) if (row.memberKey === memberKey) seen.add(row.sessionId);
    for (const report of this.#reports.values()) for (const row of report.leases) if (row.memberKey === memberKey) seen.add(row.sessionId);
    for (const row of this.#reservations.values()) if (row.memberKey === memberKey) seen.add(row.sessionId);
    return Math.max(seen.size, Number.isSafeInteger(actualRunning) && actualRunning >= 0 ? actualRunning : 0);
  }
  active(): readonly ProviderGroupActiveLease[] { return [...this.#active.values()]; }
  clear(): void { this.#active.clear(); this.#reports.clear(); this.#reservations.clear(); }
  #prune(): void {
    const now = this.now(); for (const [key, row] of this.#reports) if (row.expires <= now) this.#reports.delete(key);
    for (const [key, row] of this.#reservations) if (row.expires <= now) this.#reservations.delete(key);
  }
}
