import { expect, it, vi } from "vitest";
import type { AuxiliaryTextRouting, AuxiliaryTextRunOptions } from "./auxiliary-text-routing.js";
import { partnerPackageOpening } from "./partner-package-opening.js";

const native = { packageId: "engineering", packageVersion: "0.1.0", packageHash: "a".repeat(64), description: "Engineering", avatarPreset: "orbit" as const, locale: "en",
  opening: { welcome: "Hello. What should we review?", capabilities: ["Code", "Evidence", "Delivery"], starterOptions: ["Review code", "Check evidence", "Plan delivery"] } };
it("uses only the auxiliary chain under one four-second deadline and validates authored starter cardinality", async () => {
  const run = vi.fn(async (_plan: unknown, options: AuxiliaryTextRunOptions) => {
    expect(options.timeoutMs).toBe(4_000); expect(options.signal).toBeDefined(); expect(options.stillCurrent?.()).toBe(true);
    expect(options.validate('{"greeting":"Ready","options":["one"]}')).toBeUndefined();
    const text = options.validate(JSON.stringify({ greeting: "Hello. Where should we start?", options: native.opening.starterOptions }))!;
    return { status: "ok" as const, text };
  });
  const auxiliary = { capture: () => ({}), run } as unknown as AuxiliaryTextRouting;
  expect(await partnerPackageOpening(native, auxiliary, () => true)).toContain("• Plan delivery");
  expect(run).toHaveBeenCalledTimes(1);
});
it("keeps the full authored opening when auxiliary inference is unavailable", async () => {
  const auxiliary = { capture: () => ({}), run: async () => ({ status: "unavailable" }) } as unknown as AuxiliaryTextRouting;
  expect(await partnerPackageOpening(native, auxiliary, () => true)).toBe("Hello. What should we review?\n\n• Review code\n\n• Check evidence\n\n• Plan delivery");
});
