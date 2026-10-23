import { expect, it } from "vitest";
import { selectProviderGroupMember, type ProviderGroupCandidate, type ProviderGroupStrategy } from "./provider-group-scheduler.js";

const now = 1_700_000_000_000;
const member = (id: string, patch: Partial<ProviderGroupCandidate> = {}): ProviderGroupCandidate => ({ id, available: true, paused: false, running: 0, capacity: 4, weight: 1, ...patch });
const strategies: ProviderGroupStrategy[] = ["least_busy", "round_robin", "ordered", "weighted"];

it("uses expiring weekly quota before five-hour quota and low usage for every strategy", () => {
  const candidates = [member("unknown"), member("low", { usagePercent: 1 }), member("five-hour", { usagePercent: 20, fiveHourResetAt: now + 10_000 }),
    member("weekly", { usagePercent: 90, weeklyResetAt: now + 4 * 60 * 60_000 })];
  for (const strategy of strategies) expect(selectProviderGroupMember(candidates, strategy, { now, random: () => 0 })).toBe("weekly");
});

it("handles reset boundaries, similar reset times and the five percentage-point usage band", () => {
  const candidates = [member("expired", { usagePercent: 80, weeklyResetAt: now }), member("later", { usagePercent: 6, weeklyResetAt: now + 61 * 60_000 }),
    member("first", { usagePercent: 2, weeklyResetAt: now + 60 * 60_000 }), member("next-tier", { usagePercent: 0, fiveHourResetAt: now + 5_000 })];
  expect(selectProviderGroupMember(candidates, "ordered", { now })).toBe("later");
  expect(selectProviderGroupMember([member("outside", { usagePercent: 7.01 }), member("lowest", { usagePercent: 2 })], "ordered", { now })).toBe("lowest");
  expect(selectProviderGroupMember([member("at-edge", { usagePercent: 7 }), member("lowest", { usagePercent: 2 })], "ordered", { now })).toBe("at-edge");
  expect(selectProviderGroupMember([member("unknown"), member("known", { usagePercent: 99 })], "ordered", { now })).toBe("known");
});

it("keeps the original member order for rotation and applies weights only after quota selection", () => {
  const candidates = [member("a", { weight: 1 }), member("excluded"), member("b", { weight: 3 })];
  expect(selectProviderGroupMember(candidates, "round_robin", { now, lastPicked: "excluded", exclude: new Set(["excluded"]) })).toBe("b");
  expect(selectProviderGroupMember(candidates, "round_robin", { now, lastPicked: "b", exclude: new Set(["excluded"]) })).toBe("a");
  expect(selectProviderGroupMember([candidates[0]!, candidates[2]!], "weighted", { now, random: () => 0.25 })).toBe("b");
});

it("uses an eligible occupied member instead of rejecting saturation, while preserving pause and exclusion", () => {
  const candidates = [member("paused", { paused: true }), member("offline", { available: false }), member("excluded"),
    member("busy", { running: 8, capacity: 4 }), member("less-busy", { running: 4, capacity: 1 })];
  expect(selectProviderGroupMember(candidates, "ordered", { now, exclude: new Set(["excluded"]) })).toBe("less-busy");
  expect(selectProviderGroupMember(candidates.slice(0, 3), "least_busy", { now, exclude: new Set(["excluded"]) })).toBeUndefined();
});
