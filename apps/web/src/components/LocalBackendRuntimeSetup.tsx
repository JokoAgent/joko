import { useEffect, useRef, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import type { BackendView, LocalBackendRuntimeView } from "../model.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

const ACTIVE_STATES = new Set<LocalBackendRuntimeView["state"]>(["downloading", "extracting", "validating", "activating"]);

export function LocalBackendRuntimeSetup({ backend, controller, t }: {
  readonly backend: BackendView;
  readonly controller: AppController;
  readonly t: Translator;
}): JSX.Element | null {
  const [runtime, setRuntime] = useState<LocalBackendRuntimeView>();
  const [failed, setFailed] = useState(false);
  const [observing, setObserving] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const activeRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setRuntime(undefined);
    setFailed(false);
    setObserving(false);
    void (async () => {
      try {
        const next = await controller.probeLocalBackendRuntime(backend.id, abort.signal);
        if (!abort.signal.aborted) setRuntime(next);
      } catch { if (!abort.signal.aborted) setFailed(true); }
    })();
    return () => { abort.abort(); if (lifetime.current === abort) lifetime.current = undefined; };
  }, [backend.id, backend.instanceGeneration, controller]);

  const busy = runtime !== undefined && ACTIVE_STATES.has(runtime.state);
  useEffect(() => {
    if (!busy || observing) return;
    const signal = lifetime.current?.signal;
    const timer = setInterval(() => {
      void controller.probeLocalBackendRuntime(backend.id, signal).then(async next => {
        if (signal?.aborted) return;
        setRuntime(next);
        if (!ACTIVE_STATES.has(next.state)) await controller.refresh();
      }).catch(() => { if (!signal?.aborted) setFailed(true); });
    }, 2_000);
    return () => clearInterval(timer);
  }, [backend.id, busy, observing, controller]);

  if (runtime === undefined || runtime.state === "not_supported" || (!runtime.canInstall && !runtime.canRepair)) return null;

  const install = async (repair: boolean) => {
    const signal = lifetime.current?.signal;
    if (signal === undefined || signal.aborted || activeRequest.current !== undefined) return;
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    setObserving(true);
    setFailed(false);
    try {
      for await (const next of controller.installLocalBackendRuntime(backend.id, requestId, runtime.instanceGeneration, repair, signal)) {
        if (signal.aborted) return;
        setRuntime(next);
        if (next.state === "failed") setFailed(true);
      }
    } catch { if (!signal.aborted) setFailed(true); }
    finally {
      if (activeRequest.current === requestId) activeRequest.current = undefined;
      if (!signal.aborted) setObserving(false);
    }
  };
  const cancel = async () => {
    const requestId = runtime.requestId ?? activeRequest.current;
    if (requestId === undefined) return;
    try { await controller.cancelLocalBackendRuntimeInstall(backend.id, requestId); }
    catch { setFailed(true); }
  };
  const stateLabels: Record<LocalBackendRuntimeView["state"], Parameters<Translator>[0]> = {
    not_supported: "common.unavailable", not_installed: "settings.localRuntimeMissing", ready: "settings.localRuntimeReady",
    downloading: "settings.localRuntimeDownloading", extracting: "settings.localRuntimeExtracting", validating: "settings.localRuntimeValidating",
    activating: "settings.localRuntimeActivating", complete: "settings.localRuntimeReady", failed: "settings.localRuntimeFailed", cancelled: "settings.localRuntimeCancelled"
  };
  return <div className="setting-row">
    <div><strong>{t("settings.localRuntimeTitle")}</strong><span>{t(stateLabels[runtime.state])} · {runtime.expectedVersion} · {runtime.platform}</span>
      <span>{t(runtime.manualOverride ? "settings.localRuntimeManual" : "settings.localRuntimeNode")}</span>
      {runtime.state === "downloading" && <progress value={runtime.receivedBytes} max={runtime.totalBytes} aria-label={t("settings.localRuntimeDownloading")} />}
      {failed && <span role="alert" className="danger-text">{t("settings.localRuntimeFailed")}</span>}
    </div>
    <div className="backend-setting__actions">
      {busy || observing
        ? <Button disabled={runtime.state === "activating"} onClick={() => { void cancel(); }}>{t("common.cancel")}</Button>
        : <Button onClick={() => { void install(runtime.installedVersion !== undefined); }}>{t(runtime.installedVersion === undefined ? "settings.localRuntimeInstall" : "settings.localRuntimeRepair")}</Button>}
    </div>
  </div>;
}
