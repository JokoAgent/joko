import { randomUUID } from "node:crypto";

export interface ProviderGroupActiveLease { readonly sessionId: string; readonly memberKey: string; readonly backendId: string; readonly providerId: string; }
interface Report { readonly sequence: bigint; readonly expires: number; readonly leases: readonly ProviderGroupActiveLease[]; }
interface Reservation extends ProviderGroupActiveLease { readonly expires: number; readonly token: string; }
const rememberedControllers = 256;

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
    if (!controllerId || sequence < 0n || leases.length > 4096) throw new Error("Invalid Provider group lease report.");
    const reportedSessions = new Map(leases.map(row => [row.sessionId, row]));
    if (reportedSessions.size !== leases.length
      || leases.some(row => !row.sessionId || !row.memberKey || !row.backendId || !row.providerId)) throw new Error("Invalid Provider group lease report.");
    const previous = this.#reports.get(controllerId); if (previous && previous.sequence >= sequence) return false;
    const report = { sequence, expires: this.now() + 150_000, leases: structuredClone(leases) };
    this.#reports.delete(controllerId);
    this.#reports.set(controllerId, report);
    if (this.#reports.size > rememberedControllers) this.#prune();
    // The RPC scopes session IDs to the reporting controller. A snapshot can
    // have been captured before an outstanding pick on that same controller.
    for (const [token, row] of this.#reservations) {
      const current = reportedSessions.get(row.sessionId);
      if (current?.memberKey === row.memberKey && current.backendId === row.backendId && current.providerId === row.providerId) {
        this.#reservations.delete(token);
      }
    }
    return true;
  }
  count(memberKey: string, actualRunning = 0): number {
    this.#prune(); const seen = new Set<string>();
    for (const row of this.#active.values()) if (row.memberKey === memberKey) seen.add(row.sessionId);
    for (const report of this.#reports.values()) for (const row of report.leases) if (row.memberKey === memberKey) seen.add(row.sessionId);
    const running = Math.max(seen.size, Number.isSafeInteger(actualRunning) && actualRunning >= 0 ? actualRunning : 0);
    const reported = seen.size;
    for (const row of this.#reservations.values()) if (row.memberKey === memberKey) seen.add(row.sessionId);
    return running + (seen.size - reported);
  }
  active(): readonly ProviderGroupActiveLease[] { return [...this.#active.values()]; }
  clear(): void { this.#active.clear(); this.#reports.clear(); this.#reservations.clear(); }
  #prune(): void {
    const now = this.now();
    for (const [key, report] of this.#reports) {
      if (report.expires >= now) continue;
      // Expiry releases load. Keep recent controllers' sequence numbers so a
      // delayed snapshot cannot claim a slot again. Only evict expired reports.
      if (this.#reports.size > rememberedControllers) this.#reports.delete(key);
      else if (report.leases.length) this.#reports.set(key, { ...report, leases: [] });
    }
    for (const [key, row] of this.#reservations) if (row.expires <= now) this.#reservations.delete(key);
  }
}
