import { describe, expect, it } from "vitest";
import {
  isRuntimeProcessMonitorWindow,
  RUNTIME_PROCESS_MONITOR_WINDOW_QUERY
} from "./runtime-process-monitor-window.js";

describe("runtime process monitor window identity", () => {
  it("accepts only the exact standalone monitor query", () => {
    expect(RUNTIME_PROCESS_MONITOR_WINDOW_QUERY).toBe("runtimeProcessMonitor");
    expect(isRuntimeProcessMonitorWindow({ search: "?runtimeProcessMonitor=1" } as Location)).toBe(true);
    expect(isRuntimeProcessMonitorWindow({ search: "?runtimeProcessMonitor=0" } as Location)).toBe(false);
    expect(isRuntimeProcessMonitorWindow({ search: "?runtimeProcessMonitor=1&profile=secret" } as Location)).toBe(false);
    expect(isRuntimeProcessMonitorWindow({ search: "" } as Location)).toBe(false);
  });
});
