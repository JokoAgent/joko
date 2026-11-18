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

  it("round-trips both instants in a repeated hour and honours edited wall clocks", () => {
    const zone = "America/New_York";
    const earlier = Date.parse("2027-11-07T05:31:00Z");
    const later = Date.parse("2027-11-07T06:31:00Z");
    const wallClock = "2027-11-07T01:31";
    expect(scheduleLocalDateTimeFromEpoch(earlier, zone)).toBe(wallClock);
    expect(scheduleLocalDateTimeFromEpoch(later, zone)).toBe(wallClock);
    expect(scheduleEpochFromLocalDateTime(wallClock, zone, earlier)).toBe(earlier);
    expect(scheduleEpochFromLocalDateTime(wallClock, zone, later)).toBe(later);
    expect(scheduleEpochFromLocalDateTime(wallClock, zone, later + 15_123)).toBe(later + 15_123);
    expect(scheduleEpochFromLocalDateTime(`${wallClock}:05`, zone, later)).toBe(earlier + 5_000);
    expect(scheduleEpochFromLocalDateTime("2027-11-07T03:00", zone, later)).toBe(Date.parse("2027-11-07T08:00:00Z"));
    expect(scheduleEpochFromLocalDateTime(wallClock, "UTC", later)).toBe(Date.parse("2027-11-07T01:31:00Z"));
    expect(scheduleEpochFromLocalDateTime("2027-03-14T02:30", zone, later)).toBeUndefined();
  });
});
