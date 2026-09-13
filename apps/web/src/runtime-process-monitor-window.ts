export const RUNTIME_PROCESS_MONITOR_WINDOW_QUERY = "runtimeProcessMonitor";

export function isRuntimeProcessMonitorWindow(
  location: Pick<Location, "search"> = window.location
): boolean {
  const query = new URLSearchParams(location.search);
  return [...query.keys()].join(",") === RUNTIME_PROCESS_MONITOR_WINDOW_QUERY &&
    query.get(RUNTIME_PROCESS_MONITOR_WINDOW_QUERY) === "1";
}
