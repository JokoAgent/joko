import { useEffect, useRef, useState } from "react";
import type { MobilePlainStorageDriver } from "./connection-storage";
import type { MobileHomeViewChange, MobileHomeViewState } from "./mobile-task-home-navigation";

type StatusFilter = MobileHomeViewState["statusFilter"];

/** The status belongs to this paired Home source. Search is local to the open view. */
export function useMobileHomeViewPreference(sourceKey: string, storage?: Pick<MobilePlainStorageDriver, "getItem" | "setItem">): {
  readonly view: MobileHomeViewState;
  readonly change: MobileHomeViewChange;
} {
  const [local, setLocal] = useState<{ sourceKey: string; search: string; status: StatusFilter | undefined; sort?: MobileHomeViewState["searchSort"] }>();
  const [saved, setSaved] = useState<{ sourceKey: string; status: StatusFilter }>();
  const latest = useRef(sourceKey);
  latest.current = sourceKey;
  const writes = useRef<Promise<void>>(Promise.resolve());
  const key = `joko.mobile.home-status.v1.${encodeURIComponent(sourceKey)}`;

  useEffect(() => {
    if (!storage) return;
    let active = true;
    void writes.current.then(() => storage.getItem(key)).then(raw => {
      if (active) setSaved({ sourceKey, status: raw === "archived" || raw === "all" ? raw : "active" });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [key, sourceKey, storage]);

  const current = local?.sourceKey === sourceKey ? local : undefined;
  const savedStatus = storage && saved?.sourceKey === sourceKey ? saved.status : undefined;
  const view: MobileHomeViewState = { search: current?.search ?? "", statusFilter: current?.status ?? savedStatus ?? "active",
    ...(current?.sort === undefined ? {} : { searchSort: current.sort }) };
  const change: MobileHomeViewChange = (next, chooseStatus = false) => {
    if (latest.current !== sourceKey) return;
    setLocal(previous => ({ sourceKey, search: next.search, sort: next.searchSort,
      status: chooseStatus ? next.statusFilter : previous?.sourceKey === sourceKey ? previous.status : undefined }));
    if (storage && chooseStatus) writes.current = writes.current.then(() => storage.setItem(key, next.statusFilter)).catch(() => undefined);
  };
  return { view, change };
}
