import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type View } from "react-native";

type Measurable = Pick<View, "measureInWindow">;
type Drop = { readonly key: string; readonly after: boolean };
type HeaderBounds = { readonly key: string; readonly view: View; readonly top: number; readonly height: number };

interface Drag {
  readonly sourceKey: string;
  readonly sourceView: View;
  readonly scope: string;
  readonly startY: number;
  y: number;
  bounds: readonly HeaderBounds[];
}

export function useMobileHomeProjectReorder(input: {
  readonly enabled: boolean;
  readonly scope: string;
  readonly visibleKeys: readonly string[];
  readonly viewport: () => Measurable | undefined | null;
  readonly onReorder: (visibleOrder: readonly string[]) => void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const headers = useRef(new Map<string, View>());
  const active = useRef<Drag | undefined>(undefined);
  const [marker, setMarker] = useState<{ readonly sourceKey: string; readonly drop?: Drop }>();
  const cancel = useCallback(() => { active.current = undefined; setMarker(undefined); }, []);
  useEffect(() => { cancel(); }, [cancel, input.enabled, input.scope]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => { if (state !== "active") cancel(); });
    return () => { subscription.remove(); active.current = undefined; };
  }, [cancel]);

  const register = useCallback((key: string, view: View | null): void => {
    if (view) headers.current.set(key, view);
    else {
      headers.current.delete(key);
      if (active.current?.sourceKey === key) cancel();
    }
  }, [cancel]);
  const canAdopt = (drag: Drag): boolean => latest.current.enabled && latest.current.scope === drag.scope
    && AppState.currentState === "active" && headers.current.get(drag.sourceKey) === drag.sourceView;
  const resolveDrop = (drag: Drag): Drop | undefined => {
    if (Math.abs(drag.y - drag.startY) < 8) return undefined;
    const targets = drag.bounds.filter(bound => bound.key !== drag.sourceKey && headers.current.get(bound.key) === bound.view);
    const before = targets.find(bound => drag.y < bound.top + bound.height / 2);
    const last = targets.at(-1);
    return before !== undefined ? { key: before.key, after: false } : last === undefined ? undefined : { key: last.key, after: true };
  };
  const updateMarker = (drag: Drag): void => {
    const drop = resolveDrop(drag);
    setMarker(current => current?.sourceKey === drag.sourceKey && current.drop?.key === drop?.key
      && current.drop?.after === drop?.after ? current : { sourceKey: drag.sourceKey, drop });
  };
  const start = (sourceKey: string, y: number): void => {
    const current = latest.current;
    const viewport = current.viewport();
    const sourceView = headers.current.get(sourceKey);
    if (!current.enabled || active.current || !viewport || !sourceView || !Number.isFinite(y) || !current.visibleKeys.includes(sourceKey)) return;
    const mounted = current.visibleKeys.flatMap(key => {
      const view = headers.current.get(key);
      return view === undefined ? [] : [{ key, view }];
    });
    if (mounted.length < 2) return;
    const drag: Drag = { sourceKey, sourceView, scope: current.scope, startY: y, y, bounds: [] };
    active.current = drag;
    setMarker({ sourceKey });
    viewport.measureInWindow((_x, top, _width, viewportHeight) => {
      if (active.current !== drag || !canAdopt(drag)) return;
      if (!Number.isFinite(top) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) { cancel(); return; }
      const measured: HeaderBounds[] = [];
      let remaining = mounted.length;
      for (const entry of mounted) entry.view.measureInWindow((_x, y, _width, height) => {
        if (active.current !== drag || !canAdopt(drag)) return;
        if (headers.current.get(entry.key) === entry.view && Number.isFinite(y) && Number.isFinite(height)
          && height > 0 && y < top + viewportHeight && y + height > top) measured.push({ ...entry, top: y, height });
        remaining -= 1;
        if (remaining > 0) return;
        if (!measured.some(bound => bound.key === sourceKey)) { cancel(); return; }
        drag.bounds = measured.sort((left, right) => left.top - right.top);
        updateMarker(drag);
      });
    });
  };
  const move = (sourceKey: string, y: number): void => {
    const drag = active.current;
    if (drag?.sourceKey !== sourceKey || !Number.isFinite(y)) return;
    if (!canAdopt(drag)) { cancel(); return; }
    drag.y = y;
    updateMarker(drag);
  };
  const finish = (sourceKey: string, commit: boolean): void => {
    const drag = active.current;
    if (drag?.sourceKey !== sourceKey) return;
    cancel();
    if (!commit || !canAdopt(drag)) return;
    const drop = resolveDrop(drag);
    if (drop) reorder(sourceKey, drop);
  };
  const reorder = (sourceKey: string, drop: Drop): void => {
    const { visibleKeys, onReorder } = latest.current;
    const original = visibleKeys.indexOf(sourceKey);
    const next = visibleKeys.filter(key => key !== sourceKey);
    const target = next.indexOf(drop.key);
    if (original < 0 || target < 0) return;
    const index = target + (drop.after ? 1 : 0);
    if (index === original) return;
    next.splice(index, 0, sourceKey);
    onReorder(next);
  };
  const step = (sourceKey: string, delta: -1 | 1): void => {
    const current = latest.current;
    if (!current.enabled || active.current || AppState.currentState !== "active") return;
    const index = current.visibleKeys.indexOf(sourceKey);
    const target = current.visibleKeys[index + delta];
    if (index >= 0 && target !== undefined) reorder(sourceKey, { key: target, after: delta === 1 });
  };
  return { marker, register, start, move, finish, step };
}
