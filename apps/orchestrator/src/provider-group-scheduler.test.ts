import { expect, it } from "vitest";
import { ProviderGroupLeases } from "./provider-group-leases.js";
import { selectProviderGroupMember, type ProviderGroupCandidate, type ProviderGroupStrategy } from "./provider-group-scheduler.js";

const now = 1_700_000_000_000;
const member = (id: string, patch: Partial<ProviderGroupCandidate> = {}): ProviderGroupCandidate => ({ id, available: true, paused: false, running: 0, capacity: 4, weight: 1, ...patch });
const strategies: ProviderGroupStrategy[] = ["least_busy", "round_robin", "ordered", "weighted"];

it("keeps the new member at capacity when an older assignment reports the same session", () => {
  const leases = new ProviderGroupLeases(() => now);
  const previous = { sessionId: "controller/task", memberKey: "a", backendId: "pi", providerId: "first" };
  const next = { ...previous, memberKey: "b", providerId: "second" };
  leases.report("controller", 1n, [previous]);
  leases.reserve(next);
  const pick = () => selectProviderGroupMember([member("b", { capacity: 1, running: leases.count("b") })], "ordered", { now });
  expect(pick()).toBeUndefined();
  leases.report("controller", 2n, [previous]);
  expect(pick()).toBeUndefined();
  leases.report("controller", 3n, [next]);
  expect(leases.count("b")).toBe(1);
  leases.report("controller", 4n, []);
  expect(pick()).toBe("b");
});

it("uses the highest credible remaining-quota pace for every strategy", () => {
  const candidates = [member("unknown"), member("fresh", { urgency: 1 }), member("nearly-full", { urgency: 12, fiveHourTight: true }),
    member("expiring", { urgency: 4 })];
  for (const strategy of strategies) expect(selectProviderGroupMember(candidates, strategy, { now, random: () => 0 })).toBe("expiring");
});

it("uses the ten-percent urgency band and avoids tight short windows only when another account can accept", () => {
  expect(selectProviderGroupMember([member("outside", { urgency: 1.79 }), member("highest", { urgency: 2 })], "ordered", { now })).toBe("highest");
  expect(selectProviderGroupMember([member("at-edge", { urgency: 1.8 }), member("highest", { urgency: 2 })], "ordered", { now })).toBe("at-edge");
  expect(selectProviderGroupMember([member("unknown"), member("known", { urgency: 0.01 })], "ordered", { now })).toBe("known");
  expect(selectProviderGroupMember([member("tight", { urgency: 5, fiveHourTight: true }), member("unknown")], "ordered", { now })).toBe("unknown");
  expect(selectProviderGroupMember([member("tight", { urgency: 5, fiveHourTight: true })], "ordered", { now })).toBe("tight");
  expect(selectProviderGroupMember([member("invalid", { urgency: Number.NaN }), member("unobserved")], "ordered", { now })).toBe("invalid");
});

it("keeps the original member order for rotation and applies weights only after quota selection", () => {
  const candidates = [member("a", { weight: 1 }), member("excluded"), member("b", { weight: 3 })];
  expect(selectProviderGroupMember(candidates, "round_robin", { now, lastPicked: "excluded", exclude: new Set(["excluded"]) })).toBe("b");
  expect(selectProviderGroupMember(candidates, "round_robin", { now, lastPicked: "b", exclude: new Set(["excluded"]) })).toBe("a");
  expect(selectProviderGroupMember([candidates[0]!, candidates[2]!], "weighted", { now, random: () => 0.25 })).toBe("b");
});

it("withholds saturated members after checking availability, pause and exclusion", () => {
  const candidates = [member("paused", { paused: true }), member("offline", { available: false }), member("excluded"),
    member("busy", { running: 8, capacity: 4 }), member("less-busy", { running: 4, capacity: 1 })];
  for (const strategy of strategies) expect(selectProviderGroupMember(candidates, strategy, { now, exclude: new Set(["excluded"]) })).toBeUndefined();
  expect(selectProviderGroupMember(candidates.slice(0, 3), "least_busy", { now, exclude: new Set(["excluded"]) })).toBeUndefined();
});
