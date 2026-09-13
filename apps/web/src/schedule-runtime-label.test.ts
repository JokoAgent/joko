import { describe, expect, it } from "vitest";

import { scheduleRuntimeLabel } from "./components/SchedulesPage.js";
import type { ScheduleRuntimeStatus } from "./components/scheduler-list.js";
import type { Translator } from "./components/types.js";

const t = ((key) => key) as Translator;

describe("scheduler recovery labels", () => {
  it.each([
    ["stalled", "scheduler.phaseStalled"],
    ["recovering", "scheduler.phaseRecovering"]
  ] as const)("keeps the %s phase explicit", (phase, expected) => {
    const status: ScheduleRuntimeStatus = {
      kind: "run",
      run: {
        scheduleId: "schedule-1",
        source: "automatic",
        executionMode: "agent",
        startedAt: 1,
        phase,
        lastProgressAt: 2
      }
    };
    expect(scheduleRuntimeLabel(status, undefined, t)).toBe(expected);
  });
});
