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

  it.each([
    [29, 2027, 1, 28], [30, 2027, 1, 28], [31, 2027, 1, 28],
    [29, 2028, 1, 29], [30, 2028, 1, 29], [31, 2028, 1, 29], [31, 2027, 3, 30]
  ])("runs monthly day %i at the end of %i-%i when needed", (day, year, month, actualDay) => {
    expect(nextOccurrence({ kind: "cron", expression: `0 9 ${day} * *`, timezone: "Asia/Shanghai" },
      Date.UTC(year, month, 15))).toBe(Date.UTC(year, month, actualDay, 1));
  });

  it("retains the configured monthly day after a short month and never repeats its current minute", () => {
    for (const day of [30, 31]) {
      const timing = { kind: "cron", expression: `0 9 ${day} * *`, timezone: "UTC" } as const;
      const february = nextOccurrence(timing, Date.UTC(2027, 0, day, 9));
      expect(february).toBe(Date.UTC(2027, 1, 28, 9));
      expect(nextOccurrence(timing, february! + 30_000)).toBe(Date.UTC(2027, 2, day, 9));
    }
  });

  it("keeps the monthly spring-gap occurrence while ordinary daily cron skips the missing wall time", () => {
    const after = Date.UTC(2026, 2, 8, 5, 15);
    expect(nextOccurrence({ kind: "cron", expression: "30 2 8 * *", timezone: "America/New_York" }, after))
      .toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(nextOccurrence({ kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" }, after))
      .toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  it("keeps only the later monthly fall-back occurrence even when its earlier instant is already past", () => {
    const timing = { kind: "cron", expression: "45 1 1 * *", timezone: "America/New_York" } as const;
    for (const after of [Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 1, 6, 31, 30)]) {
      expect(nextOccurrence(timing, after)).toBe(Date.UTC(2026, 10, 1, 6, 45));
    }
    expect(nextOccurrence(timing, Date.UTC(2026, 10, 1, 6, 45))).toBe(Date.UTC(2026, 11, 1, 6, 45));
  });

  it.each([
    ["0 9 30,31 * *", Date.UTC(2027, 2, 30, 9)],
    ["0 9 30-31 * *", Date.UTC(2027, 2, 30, 9)],
    ["0 9 31 3 *", Date.UTC(2027, 2, 31, 9)],
    ["0 9 31 * 1", Date.UTC(2027, 1, 1, 9)],
    ["0 0 9 31 * *", Date.UTC(2027, 2, 31, 9)]
  ] as const)("preserves ordinary cron semantics for %s", (expression, expected) => {
    expect(nextOccurrence({ kind: "cron", expression, timezone: "UTC" }, Date.UTC(2027, 0, 31, 9))).toBe(expected);
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

  it("uses only the later instant for each matching wall time across a fall-back", () => {
    const timing = { kind: "cron", expression: "15,45 1 * * *", timezone: "America/New_York" } as const;
    const first = nextOccurrence(timing, Date.UTC(2026, 10, 1, 4));
    expect(first).toBe(Date.UTC(2026, 10, 1, 6, 15));
    const second = nextOccurrence(timing, first!);
    expect(second).toBe(Date.UTC(2026, 10, 1, 6, 45));
    expect(nextOccurrence(timing, second!)).toBe(Date.UTC(2026, 10, 2, 6, 15));

    // The next matching wall time can be days away from the search cursor.
    expect(nextOccurrence({ kind: "cron", expression: "45 1 5 4 *", timezone: "Australia/Lord_Howe" },
      Date.UTC(2026, 3, 2))).toBe(Date.UTC(2026, 3, 4, 15, 15));
  });
});
