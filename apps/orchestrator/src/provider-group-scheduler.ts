export type ProviderGroupStrategy = "least_busy" | "round_robin" | "ordered" | "weighted";

export interface ProviderGroupCandidate {
  readonly id: string;
  readonly available: boolean;
  readonly paused: boolean;
  readonly running: number;
  readonly capacity: number;
  readonly weight: number;
  readonly usagePercent?: number | null;
  /** Only a not-yet-exhausted quota window supplies a future reset time. */
  readonly weeklyResetAt?: number | null;
  readonly fiveHourResetAt?: number | null;
}

const WEEKLY_EXPIRING_MS = 5 * 60 * 60_000;
const FIVE_HOUR_EXPIRING_MS = 60 * 60_000;
const SAME_RESET_MS = 10 * 60_000;
const SIMILAR_USAGE_PERCENT = 5;

/** Quota order applies to every strategy. Capacity distributes work but does
 * not itself reject a task when all eligible members are occupied. */
export function selectProviderGroupMember(
  members: readonly ProviderGroupCandidate[],
  strategy: ProviderGroupStrategy,
  options: { readonly exclude?: ReadonlySet<string>; readonly lastPicked?: string;
    readonly random?: () => number; readonly now: number }
): string | undefined {
  const eligible = members.filter(member => member.available && !member.paused && !options.exclude?.has(member.id));
  if (!eligible.length) return;
  const open = eligible.filter(member => member.running < member.capacity);
  if (!open.length) return leastBusy(byQuota(eligible, options.now)).id;
  const candidates = byQuota(open, options.now);
  switch (strategy) {
    case "ordered": return candidates[0]!.id;
    case "round_robin": {
      const lastIndex = options.lastPicked ? members.findIndex(member => member.id === options.lastPicked) : -1;
      return (candidates.find(member => members.indexOf(member) > lastIndex) ?? candidates[0])!.id;
    }
    case "weighted": {
      const total = candidates.reduce((sum, member) => sum + Math.max(1, member.weight), 0);
      let point = (options.random ?? Math.random)() * total;
      for (const member of candidates) {
        point -= Math.max(1, member.weight);
        if (point < 0) return member.id;
      }
      return candidates.at(-1)!.id;
    }
    case "least_busy": return leastBusy(candidates).id;
  }
}

function byQuota(candidates: readonly ProviderGroupCandidate[], now: number): readonly ProviderGroupCandidate[] {
  const known = candidates.filter(member => typeof member.usagePercent === "number" && Number.isFinite(member.usagePercent));
  if (!known.length) return candidates;
  const pool = expiringFirst(known, now) ?? known;
  const lowest = Math.min(...pool.map(member => member.usagePercent!));
  return pool.filter(member => member.usagePercent! <= lowest + SIMILAR_USAGE_PERCENT);
}

function expiringFirst(candidates: readonly ProviderGroupCandidate[], now: number): readonly ProviderGroupCandidate[] | undefined {
  for (const [window, within] of [["weeklyResetAt", WEEKLY_EXPIRING_MS], ["fiveHourResetAt", FIVE_HOUR_EXPIRING_MS]] as const) {
    const soon = candidates.filter(member => { const reset = member[window]; return typeof reset === "number" && reset > now && reset - now <= within; });
    if (!soon.length) continue;
    const earliest = Math.min(...soon.map(member => member[window]!));
    return soon.filter(member => member[window]! - earliest <= SAME_RESET_MS);
  }
}

function leastBusy(candidates: readonly ProviderGroupCandidate[]): ProviderGroupCandidate {
  return candidates.reduce((best, member) => member.running < best.running ? member : best);
}
