import { useEffect, useRef, useState } from "react";
import type { MobilePlainStorageDriver } from "./connection-storage";
import { DEFAULT_MOBILE_HOME_DISPLAY, MOBILE_HOME_ACTIVITY_FILTERS, MOBILE_HOME_TASK_SORTS, type MobileHomeDisplayPreferences } from "./home-navigation";
import type { MobileHomeViewChange, MobileHomeViewState } from "./mobile-task-home-navigation";

type StatusFilter = MobileHomeViewState["statusFilter"];

/** The status belongs to this paired Home source. Search is local to the open view. */
export function useMobileHomeViewPreference(sourceKey: string, storage?: Pick<MobilePlainStorageDriver, "getItem" | "setItem">): {
  readonly view: MobileHomeViewState;
  readonly change: MobileHomeViewChange;
} {
  const [local, setLocal] = useState<{ sourceKey: string; search: string; status: StatusFilter | undefined;
    sort?: MobileHomeViewState["searchSort"]; display?: MobileHomeDisplayPreferences }>();
  const [saved, setSaved] = useState<{ sourceKey: string; status: StatusFilter }>();
  const [savedDisplay, setSavedDisplay] = useState<{ sourceKey: string; value: MobileHomeDisplayPreferences }>();
  const latest = useRef(sourceKey);
  latest.current = sourceKey;
  const writes = useRef<Promise<void>>(Promise.resolve());
  const key = `joko.mobile.home-status.v1.${encodeURIComponent(sourceKey)}`;
  const displayKey = `joko.mobile.home-display.v1.${encodeURIComponent(sourceKey)}`;

  useEffect(() => {
    if (!storage) return;
    let active = true;
    void writes.current.then(() => storage.getItem(key)).then(raw => {
      if (active) setSaved({ sourceKey, status: raw === "archived" || raw === "all" ? raw : "active" });
    }).catch(() => undefined);
    void writes.current.then(() => storage.getItem(displayKey)).then(raw => {
      if (active) setSavedDisplay({ sourceKey, value: readHomeDisplay(raw) });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [displayKey, key, sourceKey, storage]);

  const current = local?.sourceKey === sourceKey ? local : undefined;
  const savedStatus = storage && saved?.sourceKey === sourceKey ? saved.status : undefined;
  const display = current?.display ?? (storage && savedDisplay?.sourceKey === sourceKey ? savedDisplay.value : DEFAULT_MOBILE_HOME_DISPLAY);
  const view: MobileHomeViewState = { search: current?.search ?? "", statusFilter: current?.status ?? savedStatus ?? "active",
    ...(current?.sort === undefined ? {} : { searchSort: current.sort }), display };
  const change: MobileHomeViewChange = (next, chooseStatus = false, chooseDisplay = false) => {
    if (latest.current !== sourceKey) return;
    setLocal(previous => ({ sourceKey, search: next.search, sort: next.searchSort,
      status: chooseStatus ? next.statusFilter : previous?.sourceKey === sourceKey ? previous.status : undefined,
      display: chooseDisplay ? next.display : previous?.sourceKey === sourceKey ? previous.display : undefined }));
    if (storage && chooseStatus) writes.current = writes.current.then(() => storage.setItem(key, next.statusFilter)).catch(() => undefined);
    if (storage && chooseDisplay) writes.current = writes.current.then(() =>
      storage.setItem(displayKey, JSON.stringify(next.display ?? DEFAULT_MOBILE_HOME_DISPLAY))).catch(() => undefined);
  };
  return { view, change };
}

function readHomeDisplay(value: string | null): MobileHomeDisplayPreferences {
  if (value === null) return DEFAULT_MOBILE_HOME_DISPLAY;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return DEFAULT_MOBILE_HOME_DISPLAY; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_MOBILE_HOME_DISPLAY;
  const record = parsed as Record<string, unknown>;
  const projectFilter = record["projectFilter"];
  const backendId = record["backendId"];
  const projectKeys = Array.isArray(projectFilter) ? [...new Set(projectFilter.filter(
    (key): key is string => typeof key === "string" && (key === "dialogue" || key.startsWith("project:") && key.length > "project:".length)
  ))] : [];
  return {
    projectFilter: projectKeys.length > 0 ? projectKeys : "all",
    backendId: typeof backendId === "string" && backendId.length > 0 ? backendId : null,
    lastActivity: MOBILE_HOME_ACTIVITY_FILTERS.find(value => value === record["lastActivity"]) ?? "all",
    sortBy: MOBILE_HOME_TASK_SORTS.find(value => value === record["sortBy"]) ?? "activity"
  };
}
