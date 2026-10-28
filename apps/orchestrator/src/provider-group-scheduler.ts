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
  readonly urgency?: number | null;
  readonly fiveHourTight?: boolean;
}

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

function byQuota(candidates: readonly ProviderGroupCandidate[], _now: number): readonly ProviderGroupCandidate[] {
  const roomy = candidates.filter(member => !member.fiveHourTight), pool = roomy.length ? roomy : candidates;
  const known = pool.filter(member => typeof member.urgency === "number" && Number.isFinite(member.urgency) && member.urgency >= 0);
  if (!known.length) return pool;
  const highest = Math.max(...known.map(member => member.urgency!));
  return known.filter(member => member.urgency! >= highest * 0.9);
}

function leastBusy(candidates: readonly ProviderGroupCandidate[]): ProviderGroupCandidate {
  return candidates.reduce((best, member) => member.running < best.running ? member : best);
}
