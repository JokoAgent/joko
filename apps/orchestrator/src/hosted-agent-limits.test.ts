import { expect, it } from "vitest";
import { DEFAULT_HOSTED_AGENT_LIMITS, HostedAgentSessionSlots, validateHostedAgentLimits } from "./hosted-agent-limits.js";

it("applies the device's default to every hosted native session and enforces the global limit across devices", () => {
  expect(DEFAULT_HOSTED_AGENT_LIMITS).toEqual({ perDevice: 16, total: 64 });
  const slots = new HostedAgentSessionSlots(), owners = Array.from({ length: 16 }, () => slots.reserve("source-a"));
  expect(() => slots.reserve("source-a")).toThrow(expect.objectContaining({ scope: "device" }));
  const others = ["source-b", "source-c", "source-d"].flatMap(device => Array.from({ length: 16 }, () => slots.reserve(device)));
  expect(slots.usage("source-a")).toEqual({ device: 16, total: 64, limits: DEFAULT_HOSTED_AGENT_LIMITS });
  expect(() => slots.reserve("source-e")).toThrow(expect.objectContaining({ scope: "total" }));
  owners[0]!.release(); owners[0]!.release();
  const child = slots.reserve("source-a"); expect(slots.usage("source-a").total).toBe(64);
  for (const slot of [...owners, ...others, child]) slot.release();
  expect(slots.usage("source-a").total).toBe(0);
});

it("leaves existing native sessions alive when limits drop and admits another only after sufficient real closures", () => {
  let limits = { perDevice: 4, total: 8 };
  const slots = new HostedAgentSessionSlots(() => limits), current = Array.from({ length: 4 }, () => slots.reserve("source"));
  limits = { perDevice: 2, total: 2 };
  expect(slots.usage("source").device).toBe(4);
  expect(() => slots.reserve("source")).toThrow();
  current[0]!.release(); current[1]!.release(); expect(() => slots.reserve("source")).toThrow();
  current[2]!.release(); const next = slots.reserve("source"); expect(slots.usage("source").device).toBe(2);
  current[3]!.release(); next.release();
});

it("validates the reference bounds without silently clamping an invalid persisted policy", () => {
  expect(validateHostedAgentLimits({ perDevice: 1, total: 1000 })).toEqual({ perDevice: 1, total: 1000 });
  for (const limits of [{ perDevice: 0, total: 64 }, { perDevice: 2, total: 1 }, { perDevice: 1, total: 1001 }, { perDevice: 1.5, total: 64 }]) {
    expect(() => validateHostedAgentLimits(limits)).toThrow();
  }
});
