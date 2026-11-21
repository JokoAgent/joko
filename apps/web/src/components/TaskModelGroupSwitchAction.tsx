import { useEffect, useRef, useState, type JSX } from "react";
import type { TaskModelGroupSwitch } from "@joko/contracts";
import type { TaskModelGroupsApi } from "../provider-group-settings.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

export function TaskModelGroupSwitchAction({ api, sessionId, generation, runId, retry, t }: {
  readonly api: TaskModelGroupsApi;
  readonly sessionId: string;
  readonly generation: bigint;
  readonly runId: string;
  readonly retry?: (runId: string) => Promise<void>;
  readonly t: Translator;
}): JSX.Element | null {
  const [offer, setOffer] = useState<TaskModelGroupSwitch>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setOffer(undefined);
    setBusy(false);
    setFailed(false);
    void api.switchOffer({ sessionId, sessionGeneration: generation, failedRunId: runId }, controller.signal).then(result => {
      if (!controller.signal.aborted) setOffer(result);
    }).catch(() => undefined);
    return () => { controller.abort(); };
  }, [api, sessionId, generation, runId]);
  if (offer?.selected === undefined || offer.sessionId !== sessionId || offer.sessionGeneration !== generation || offer.failedRunId !== runId
    || api.applySwitch === undefined) return null;
  const apply = api.applySwitch;
  const activate = async () => {
    const signal = request.current?.signal;
    if (signal === undefined || signal.aborted || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await apply(offer, signal);
      if (!signal.aborted) await retry?.(runId);
      if (!signal.aborted) setOffer(undefined);
    } catch {
      if (!signal.aborted) setFailed(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  const model = `${offer.selected.modelName} · ${offer.selected.providerName}`;
  return <>
    <Button tone="ghost" disabled={busy} onClick={() => void activate()}>{t(retry ? "modelGroups.switchAndRetry" : "modelGroups.switch", { model })}</Button>
    {failed && <small role="alert">{t("modelGroups.switchError")}</small>}
  </>;
}
