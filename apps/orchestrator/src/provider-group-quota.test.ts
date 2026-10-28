import type { ProviderAccountUsageSnapshot } from "@joko/core";
import { expect, it } from "vitest";
import { providerGroupQuota, providerGroupRebalanceTarget } from "./provider-group-quota.js";
const now = 1_700_000_000_000, hour = 3_600_000, week = 7 * 24 * hour;
const snapshot = (used = 50, resetAt = now + week): ProviderAccountUsageSnapshot => ({ providerId: "anthropic", observedAt: now,
  primaryWindow: { usedPercent: 10, windowMinutes: 300, resetAt: now + hour }, secondaryWindow: { usedPercent: used, windowMinutes: 10_080, resetAt } });
const quota = (value: ProviderAccountUsageSnapshot) => providerGroupQuota(value, "anthropic", "claude-sonnet", now);

it("ranks quota by time remaining and uses the slowest applicable long/model window", () => {
  expect(quota(snapshot())).toMatchObject({ usagePercent: 50, urgency: 0.5, pacingWindow: { windowMs: week, resetAt: now + week } });
  expect(quota(snapshot(90, now + hour)).urgency).toBeCloseTo(16.8);
  const scoped = quota({ ...snapshot(10, now + hour), modelWindows: [{ modelId: "claude-sonnet", displayName: "Sonnet", window: {
    usedPercent: 75, windowMinutes: 10_080, resetAt: now + week } }] });
  expect(scoped).toMatchObject({ usagePercent: 75, urgency: 0.25 });
  expect(quota({ ...snapshot(), modelWindows: [{ modelId: "claude-opus", displayName: "Opus", window: { usedPercent: 100, resetAt: now + week } }] }).limited).toBe(false);
});
it("avoids an 85-percent short window until its final hour and treats expired/stale data as unknown", () => {
  const input = snapshot();
  expect(quota({ ...input, primaryWindow: { usedPercent: 85, windowMinutes: 300, resetAt: now + hour + 1 } }).fiveHourTight).toBe(true);
  expect(quota({ ...input, primaryWindow: { usedPercent: 99, windowMinutes: 300, resetAt: now + hour } }).fiveHourTight).toBe(false);
  expect(quota({ ...input, primaryWindow: { usedPercent: 90, windowMinutes: 300 } }).fiveHourTight).toBe(true);
  expect(quota({ ...input, observedAt: now - 600_001 })).toEqual({ limited: false });
  expect(quota(snapshot(100, now))).toMatchObject({ limited: false });
  expect(quota(snapshot(100, now)).urgency).toBeUndefined();
  expect(quota({ ...snapshot(100, now), primaryWindow: { usedPercent: 100, windowMinutes: 300, resetAt: now }, limitReached: true }).limited).toBe(false);
  expect(quota({ ...snapshot(), secondaryWindow: { usedPercent: 10, windowMinutes: 10_080 } }).urgency).toBeUndefined();
  expect(quota({ ...snapshot(), secondaryWindow: { usedPercent: 0, windowMinutes: 10_080 } }).urgency).toBe(1);
});
it("requires fifteen percentage points of gain without pulling work away from quota that expires sooner", () => {
  const current = quota(snapshot(70)), target = quota(snapshot(55)), small = quota(snapshot(56));
  expect(providerGroupRebalanceTarget(current, [{ key: "small", quota: small }], now)).toBeUndefined();
  expect(providerGroupRebalanceTarget(current, [{ key: "target", quota: target }], now)).toBe("target");
  expect(providerGroupRebalanceTarget(quota(snapshot(90, now + hour)), [{ key: "new", quota: quota(snapshot(0)) }], now)).toBeUndefined();
  expect(providerGroupRebalanceTarget(current, [{ key: "tight", quota: { ...target, fiveHourTight: true } }], now)).toBeUndefined();
});
it("never borrows an unrelated native bucket's remaining quota or exhausted state", () => {
  const input = { ...snapshot(), buckets: [{ id: "other-model", primaryWindow: { usedPercent: 100, windowMinutes: 300, resetAt: now + hour } },
    { id: "claude-sonnet", secondaryWindow: { usedPercent: 25, windowMinutes: 10_080, resetAt: now + week } }] };
  expect(quota(input)).toMatchObject({ limited: false, urgency: 0.75 });
  expect(quota({ ...input, buckets: input.buckets.slice(0, 1) })).toEqual({ limited: false });
});
