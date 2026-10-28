import { useEffect, useMemo, useState, type JSX } from "react";
import { PermissionMode, encodeModelSpeed, decodeModelSpeed, type ExtensionTaskPreferences, type ExtensionTaskRoute, type ExtensionBackgroundTask } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl } from "./ui.js";
import { ModelSpeedControl } from "./ModelSpeedControl.js";
import "./extension-network.css";

const routeKey = (route: Pick<ExtensionTaskRoute, "backendId" | "providerId" | "modelId">) => JSON.stringify([route.backendId, route.providerId, route.modelId]);
export function ExtensionTasksSection({ controller, extension, disabled, t }: {
  readonly controller: AppController; readonly extension: ExtensionCatalogEntryView; readonly disabled: boolean; readonly t: Translator;
}): JSX.Element | null {
  const [state, setState] = useState<ExtensionTaskPreferences>(), [background, setBackground] = useState<ExtensionBackgroundTask[]>([]);
  const [model, setModel] = useState<ExtensionTaskRoute>(), [targetId, setTargetId] = useState<string>(), [permission, setPermission] = useState(PermissionMode.ASK);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [refresh, setRefresh] = useState(0);
  const lifetime = useMemo(() => ({ abort: new AbortController(), busy: false }), [controller, extension.id]);
  useEffect(() => { if (lifetime.abort.signal.aborted) lifetime.abort = new AbortController(); return () => lifetime.abort.abort(); }, [lifetime]);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime.abort.signal]), api = controller.extensionTaskApi?.();
    if (!api) return;
    void api.getPreferences({ extensionId: extension.id }, { signal }).then(result => {
      if (signal.aborted || !result.preferences) return;
      setState(result.preferences); setModel(result.preferences.model); setTargetId(result.preferences.targetId); setPermission(result.preferences.permissionMode);
    }).catch(() => { if (!signal.aborted) setState(undefined); });
    void api.listBackgroundTasks({ extensionId: extension.id }, { signal }).then(result => { if (!signal.aborted) setBackground(result.tasks); })
      .catch(() => { if (!signal.aborted) setError(true); });
    return () => abort.abort();
  }, [controller, extension.id, extension.revision, refresh, lifetime]);
  const selected = state?.extensionId === extension.id ? state : undefined;
  const declared = extension.permissions.some(item => item.id === "runtime-hidden-tasks");
  if (!selected?.showPreferences && !declared && !background.length && !selected?.writeRequests.length) return null;
  const chosen = selected?.models.find(item => item.route && model && routeKey(item.route) === routeKey(model));
  const run = async (work: () => Promise<void>) => {
    if (disabled || lifetime.busy) return; lifetime.busy = true; setBusy(true); setError(false);
    try { await work(); lifetime.abort.signal.throwIfAborted(); } catch { if (!lifetime.abort.signal.aborted) setError(true); }
    finally { lifetime.busy = false; if (!lifetime.abort.signal.aborted) setBusy(false); }
  };
  return <section className="extension-network" aria-label={t("extensions.tasks.title")}>
    {selected?.showPreferences && <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const api = controller.extensionTaskApi?.(); if (!api) throw new Error("Connection unavailable.");
      const result = await api.updatePreferences({ extensionId: extension.id, expectedRevision: selected.revision, model, targetId, permissionMode: permission }, { signal: lifetime.abort.signal });
      lifetime.abort.signal.throwIfAborted(); setState(result.preferences);
    }); }}>
      <h3>{t("extensions.tasks.title")}</h3>
      <label><span>{t("extensions.tasks.model")}</span><select value={model ? routeKey(model) : ""} disabled={disabled || busy} onChange={event => {
        setModel(selected.models.find(item => item.route && routeKey(item.route) === event.target.value)?.route);
      }}><option value="">{t("extensions.tasks.followDefault")}</option>{selected.models.map(item => item.route && <option key={routeKey(item.route)} value={routeKey(item.route)}>{item.name} · {item.route.backendId} · {item.route.providerId}</option>)}</select></label>
      {model && <><label><span>{t("extensions.tasks.effort")}</span><select disabled={disabled || busy || !chosen?.efforts.length} value={model.effort ?? ""} onChange={event => setModel({ ...model, effort: event.target.value || undefined })}>
        <option value="">{t("extensions.tasks.followDefault")}</option>{chosen?.efforts.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <ModelSpeedControl value={decodeModelSpeed(model)} supportsFast={chosen?.supportsFastMode === true} supportsUltrafast={chosen?.supportsUltrafastMode}
          disabled={disabled || busy} t={t} onChange={speed => setModel({ ...model, ...encodeModelSpeed(speed) })} /></>}
      {selected.tasksAvailable && <><label><span>{t("extensions.tasks.directory")}</span><select value={targetId ?? ""} disabled={disabled || busy} onChange={event => setTargetId(event.target.value || undefined)}>
        <option value="">{t("extensions.tasks.privateDirectory")}</option>{selected.directories.filter(item => !model || item.backendId === model.backendId).map(item => <option key={item.targetId} value={item.targetId}>{item.name}</option>)}</select></label>
        <label><span>{t("extensions.tasks.permission")}</span><select value={permission} disabled={disabled || busy} onChange={event => setPermission(Number(event.target.value))}>
          <option value={PermissionMode.ASK}>{t("extensions.tasks.ask")}</option><option value={PermissionMode.ACCEPT_EDITS}>{t("extensions.tasks.acceptEdits")}</option><option value={PermissionMode.AUTO}>{t("extensions.tasks.auto")}</option></select></label></>}
      <Button type="submit" disabled={disabled || busy}>{t("common.save")}</Button>
    </form>}
    {!!selected?.writeRequests.length && <section aria-label={t("extensions.tasks.retryPermission")}><h3>{t("extensions.tasks.retryPermission")}</h3>
      {selected.writeRequests.map(request => <div className="extension-network__row" key={request.taskId}><strong>{request.title}</strong>
        <Button disabled={disabled || busy} onClick={() => { void run(async () => {
          const api = controller.extensionTaskApi?.(); if (!api) throw new Error("Connection unavailable.");
          const result = await api.retryWriteAccess({ extensionId: extension.id, taskId: request.taskId }, { signal: lifetime.abort.signal });
          lifetime.abort.signal.throwIfAborted(); setState(result.preferences); if (!result.granted) setError(true);
        }); }}>{t("extensions.tasks.retryPermission")}</Button></div>)}
    </section>}
    {(declared || background.length > 0) && <section aria-label={t("extensions.tasks.background")}><h3>{t("extensions.tasks.background")}</h3>
      <p>{t("extensions.tasks.disclosure")}</p><Button disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t("common.refresh")}</Button>
      {!background.length && <p>{t("extensions.tasks.empty")}</p>}
      {background.map(task => <div className="extension-network__row" key={task.taskId}><strong>{task.title}</strong><div className="extension-network__actions">
        <Button onClick={() => controller.navigate({ kind: "session", sessionId: task.taskId })}>{t("extensions.tasks.open")}</Button>
        <Button disabled={disabled || busy} onClick={() => { void run(async () => { const api = controller.extensionTaskApi?.(); if (!api) throw new Error("Connection unavailable."); await api.revealTask({ extensionId: extension.id, taskId: task.taskId }, { signal: lifetime.abort.signal }); lifetime.abort.signal.throwIfAborted(); await controller.refresh(); setRefresh(value => value + 1); }); }}>{t("extensions.tasks.reveal")}</Button>
      </div></div>)}
    </section>}
    {error && <p role="alert">{t("extensions.tasks.failed")}</p>}
  </section>;
}
