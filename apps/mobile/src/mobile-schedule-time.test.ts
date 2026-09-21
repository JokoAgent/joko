import { describe, expect, it } from "vitest";
import {
  isValidMobileScheduleTimeZone,
  mobileScheduleEpochFromLocalDateTime,
  mobileScheduleLocalDateTimeFromEpoch
} from "./mobile-schedule-time";

describe("mobile Automation schedule time", () => {
  it("round-trips exact local wall-clock values in an IANA time zone", () => {
    const epoch = mobileScheduleEpochFromLocalDateTime("2026-09-21T14:35", "Asia/Shanghai");
    expect(epoch).toBe(Date.UTC(2026, 8, 21, 6, 35));
    expect(mobileScheduleLocalDateTimeFromEpoch(epoch!, "Asia/Shanghai")).toBe("2026-09-21T14:35");
  });

  it("rejects invalid zones, invalid calendar dates and DST gaps", () => {
    expect(isValidMobileScheduleTimeZone(" UTC")).toBe(false);
    expect(isValidMobileScheduleTimeZone("Not/AZone")).toBe(false);
    expect(mobileScheduleEpochFromLocalDateTime("2026-02-30T10:00", "UTC")).toBeUndefined();
    expect(mobileScheduleEpochFromLocalDateTime("2026-03-08T02:30", "America/New_York")).toBeUndefined();
    expect(mobileScheduleLocalDateTimeFromEpoch(Number.NaN, "UTC")).toBe("");
  });
});
