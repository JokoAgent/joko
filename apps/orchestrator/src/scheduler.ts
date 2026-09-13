import { Cron } from "croner";

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
      // Croner otherwise uses the process wall clock as its implicit reference.
      // Durable schedules must advance from the persisted occurrence, including
      // during replay, tests, and recovery of an older missed execution.
      const next = cron.nextRun(new Date(after));
      cron.stop();
      return next?.getTime();
    }
  }
}
