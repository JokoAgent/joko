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

  it("keeps hourly cron occurrences strictly in the future across Lord Howe's half-hour DST transitions", () => {
    for (const [after, expected] of [
      [Date.UTC(2026, 3, 4, 14, 0, 21), Date.UTC(2026, 3, 4, 15, 30)],
      [Date.UTC(2026, 9, 3, 15, 29), Date.UTC(2026, 9, 3, 16)]
    ]) {
      const next = nextOccurrence({ kind: "cron", expression: "0 * * * *", timezone: "Australia/Lord_Howe" }, after!);
      expect(next).toBe(expected);
      expect(next).toBeGreaterThan(after!);
    }
  });

  it("keeps the next legal wall-clock slot through a repeated half-hour", () => {
    for (const [expression, after, expected] of [
      ["23 1 * * *", Date.UTC(2026, 3, 4, 14, 23, 13), Date.UTC(2026, 3, 5, 14, 53)],
      ["0,45 1 * * *", Date.UTC(2026, 3, 4, 14, 50, 30), Date.UTC(2026, 3, 4, 15, 15)],
      ["45 1 * * *", Date.UTC(2026, 3, 4, 14, 50, 30), Date.UTC(2026, 3, 4, 15, 15)],
      ["45 1 * * *", Date.UTC(2026, 3, 4, 15, 0, 30), Date.UTC(2026, 3, 4, 15, 15)],
      ["20 45 1 * * *", Date.UTC(2026, 3, 4, 14, 50, 30), Date.UTC(2026, 3, 4, 15, 15, 20)]
    ] as const) {
      const next = nextOccurrence({ kind: "cron", expression, timezone: "Australia/Lord_Howe" }, after);
      expect(next, expression).toBe(expected);
      expect(next, expression).toBeGreaterThan(after);
    }
  });

  it("advances through an ordinary repeated hour without replaying a past minute", () => {
    const after = Date.UTC(2026, 10, 1, 6, 31, 30);
    for (const [expression, expected] of [
      ["45 1 * * *", Date.UTC(2026, 10, 1, 6, 45)],
      ["10 1 * * *", Date.UTC(2026, 10, 2, 6, 10)]
    ] as const) {
      expect(nextOccurrence({ kind: "cron", expression, timezone: "America/New_York" }, after)).toBe(expected);
    }
  });
});
