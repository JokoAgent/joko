import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./scheduler.js";

describe("schedule recurrence", () => {
  it("keeps intervals anchored instead of drifting", () => {
    expect(nextOccurrence({ kind: "interval", everyMs: 10_000, anchorAt: 1_000 }, 26_000)).toBe(31_000);
  });

  it("does not repeat one-shot schedules", () => {
    expect(nextOccurrence({ kind: "once", at: 2_000 }, 2_000)).toBeUndefined();
  });

  it("uses an IANA timezone for cron recurrence", () => {
    const next = nextOccurrence({ kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }, Date.UTC(2026, 7, 20, 2));
    expect(next).toBe(Date.UTC(2026, 7, 21, 1));
  });
});
