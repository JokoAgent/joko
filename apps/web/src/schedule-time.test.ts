import { describe, expect, it } from "vitest";

import { isValidScheduleTimeZone, scheduleEpochFromLocalDateTime, scheduleLocalDateTimeFromEpoch } from "./schedule-time.js";

describe("schedule IANA wall clocks", () => {
  it("converts one-shot input in the schedule timezone instead of the client timezone", () => {
    const epoch = scheduleEpochFromLocalDateTime("2026-08-24T09:30", "Asia/Shanghai");
    expect(epoch).toBe(Date.UTC(2026, 7, 24, 1, 30));
    expect(scheduleLocalDateTimeFromEpoch(epoch!, "Asia/Shanghai")).toBe("2026-08-24T09:30");
  });

  it("rejects invalid zones, invalid dates, and nonexistent DST wall clocks", () => {
    expect(isValidScheduleTimeZone("Not/A_Zone")).toBe(false);
    expect(scheduleEpochFromLocalDateTime("2026-02-30T09:00", "UTC")).toBeUndefined();
    expect(scheduleEpochFromLocalDateTime("2026-03-08T02:30", "America/New_York")).toBeUndefined();
  });

  it("renders one persisted instant differently for different schedule zones", () => {
    const epoch = Date.UTC(2026, 7, 24, 1, 30);
    expect(scheduleLocalDateTimeFromEpoch(epoch, "UTC")).toBe("2026-08-24T01:30");
    expect(scheduleLocalDateTimeFromEpoch(epoch, "Asia/Shanghai")).toBe("2026-08-24T09:30");
  });
});
