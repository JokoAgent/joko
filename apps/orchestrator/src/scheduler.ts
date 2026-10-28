import { Cron, CronDate } from "croner";

export type ScheduleTiming =
  | { readonly kind: "manual" }
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "interval"; readonly everyMs: number; readonly anchorAt: number }
  | { readonly kind: "cron"; readonly expression: string; readonly timezone: string };

export function nextOccurrence(timing: ScheduleTiming, after: number): number | undefined {
  switch (timing.kind) {
    case "manual":
      return undefined;
    case "once":
      return timing.at > after ? timing.at : undefined;
    case "interval": {
      if (!Number.isFinite(timing.everyMs) || timing.everyMs < 1_000) throw new Error("Schedule interval must be at least one second.");
      if (after < timing.anchorAt) return timing.anchorAt;
      const elapsed = after - timing.anchorAt;
      return timing.anchorAt + (Math.floor(elapsed / timing.everyMs) + 1) * timing.everyMs;
    }
    case "cron": {
      const cron = new Cron(timing.expression, { timezone: timing.timezone });
      const wallClockCron = new Cron(timing.expression, { timezone: "UTC" });
      // Croner otherwise uses the process wall clock as its implicit reference.
      // Durable schedules must advance from the persisted occurrence, including
      // during replay, tests, and recovery of an older missed execution.
      try {
        const repeated = nextRepeatedOccurrence(wallClockCron, timing.timezone, after);
        let cursor = after;
        for (;;) {
          const next = cron.nextRun(new Date(cursor))?.getTime();
          if (repeated !== undefined && (next === undefined || next <= cursor || repeated < next)) return repeated;
          if (next === undefined) return undefined;
          if (!Number.isFinite(next) || next <= cursor) throw new Error("Cron recurrence did not advance beyond the original occurrence.");
          // A DST gap can normalize an absent slot to a different wall time.
          // Check that actual wall time with the same parser, without a DST gap.
          const wallTime = wallClockTime(next, timing.timezone);
          if (wallClockCron.nextRun(new Date(wallTime - 1_000))?.getTime() === wallTime) return next;
          cursor = next;
        }
      } finally { wallClockCron.stop(); cron.stop(); }
    }
  }
}

function wallClockTime(epoch: number, timezone: string): number {
  const wallClock = new CronDate(new Date(epoch), timezone);
  const wallTime = new Date(0);
  wallTime.setUTCFullYear(wallClock.year, wallClock.month, wallClock.day);
  wallTime.setUTCHours(wallClock.hour, wallClock.minute, wallClock.second, 0);
  return wallTime.getTime();
}

function nextRepeatedOccurrence(cron: Cron, timezone: string, after: number): number | undefined {
  // Croner can wrap to the following day before a repeated half-hour starts.
  // Locate the nearby offset decrease, then ask the same parser for a slot in
  // its repeated segment. This preserves seconds and Croner's calendar syntax.
  let left = Math.floor(after / 1_000) - 86_400;
  let right = left + 172_800;
  const offsetAt = (second: number): number => wallClockTime(second * 1_000, timezone) - second * 1_000;
  const beforeOffset = offsetAt(left);
  const afterOffset = offsetAt(right);
  if (afterOffset >= beforeOffset) return undefined;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (offsetAt(middle) === beforeOffset) left = middle;
    else right = middle;
  }
  const transition = right * 1_000;
  const end = transition + beforeOffset - afterOffset;
  const start = Math.max(transition, (Math.floor(after / 1_000) + 1) * 1_000);
  if (start >= end) return undefined;
  const wallTime = cron.nextRun(new Date(wallClockTime(start, timezone) - 1_000))?.getTime();
  if (wallTime === undefined) return undefined;
  const next = wallTime - afterOffset;
  return next >= start && next < end && wallClockTime(next, timezone) === wallTime ? next : undefined;
}
