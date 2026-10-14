import { useEffect, useRef, useState } from "react";
import type { MobileObjective, MobileObjectiveApi, MobileObjectiveInput } from "./mobile-objective";

interface Projection {
  readonly ownerKey?: string;
  readonly loaded: boolean;
  readonly objective?: MobileObjective;
  readonly initial?: MobileObjectiveInput;
  readonly error?: string;
}
export function useMobileObjective(api: MobileObjectiveApi | undefined, enabled: boolean) {
  const [projection, setProjection] = useState<Projection>({ loaded: false });
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const context = useRef({ api, enabled }); context.current = { api, enabled };
  const request = useRef<AbortController | undefined>(undefined), mutation = useRef(false);
  const change = useRef(0);
  const current = (key: string, signal: AbortSignal): boolean => !signal.aborted && context.current.enabled && context.current.api?.ownerKey === key;
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    mutation.current = false; setBusy(false); setProjection({ ownerKey: api?.ownerKey, loaded: false });
    if (!api || !enabled) return () => controller.abort();
    const key = api.ownerKey;
    void (async () => {
      try {
        const [objective, initial] = await Promise.all([api.get(controller.signal), api.restore(controller.signal)]);
        if (!current(key, controller.signal)) return;
        setProjection({ ownerKey: key, loaded: true, objective, initial });
        for await (const value of api.watch(controller.signal)) {
          if (!current(key, controller.signal)) return;
          setProjection(previous => {
            if (previous.objective && value && value.ownerGeneration === previous.objective.ownerGeneration && value.revision < previous.objective.revision) return previous;
            return { ...previous, objective: value };
          });
        }
      } catch (error) {
        if (current(key, controller.signal)) setProjection(previous => ({ ...previous, error: message(error) }));
      }
    })();
    return () => { controller.abort(); if (request.current === controller) request.current = undefined; };
  }, [api?.ownerKey, enabled, retry]);
  const active = projection.ownerKey === api?.ownerKey ? projection : { loaded: false };
  return {
    ...active, busy,
    retry: () => { if (!mutation.current) setRetry(value => value + 1); },
    async mutate(action: "set" | "pause" | "resume" | "clear", input?: MobileObjectiveInput): Promise<boolean> {
      const signal = request.current?.signal, owned = context.current.api;
      if (!signal || !owned || mutation.current || !active.loaded || !current(owned.ownerKey, signal)) return false;
      mutation.current = true; setBusy(true); const turn = ++change.current;
      setProjection(previous => ({ ...previous, error: undefined }));
      try {
        const value = action === "set" ? await owned.set(input!, signal)
          : action === "clear" ? (await owned.clear(active.objective!, signal), undefined)
          : await owned[action](active.objective!, signal);
        if (!current(owned.ownerKey, signal) || turn !== change.current) return false;
        setProjection(previous => ({ ...previous, objective: value, ...(action === "set" ? { initial: undefined } : {}) }));
        return true;
      } catch (error) {
        if (current(owned.ownerKey, signal) && turn === change.current) setProjection(previous => ({ ...previous, error: message(error) }));
        return false;
      } finally {
        if (current(owned.ownerKey, signal) && turn === change.current) { mutation.current = false; setBusy(false); }
      }
    }
  };
}
function message(error: unknown): string { return error instanceof Error ? error.message : "The objective could not be loaded."; }
