import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import type { WorktreeRecycleRecordView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Spinner } from "./ui.js";

export function WorktreeRecycleSettings({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element {
  const owner = JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin]);
  return <WorktreeRecycleOwned key={owner} controller={controller} t={t} />;
}

function WorktreeRecycleOwned({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element {
  const [rows, setRows] = useState<readonly WorktreeRecycleRecordView[]>(), [error, setError] = useState<"load" | "action">();
  const [busy, setBusy] = useState(false);
  const connected = controller.state.ready && controller.state.connectionState === "connected";
  const scope = useRef<AbortController | undefined>(undefined), loading = useRef(false), refreshQueued = useRef(false), controlBusy = useRef(false);
  const port = useRef(controller); port.current = controller;
  const refresh = useCallback(async (): Promise<void> => {
    const signal = scope.current?.signal;
    if (signal === undefined || signal.aborted) return;
    if (loading.current) { refreshQueued.current = true; return; }
    loading.current = true;
    try { const result = await port.current.listWorktreeRecycleStatus(signal); if (!signal.aborted) { setRows(result); setError(undefined); } }
    catch { if (!signal.aborted) setError("load"); }
    finally { loading.current = false; if (refreshQueued.current) { refreshQueued.current = false; void refresh(); } }
  }, []);
  useLayoutEffect(() => {
    const next = new AbortController(); scope.current = next;
    setRows(undefined); setError(undefined); setBusy(false);
    if (connected) void refresh();
    else next.abort();
    return () => { next.abort(); if (scope.current === next) scope.current = undefined; refreshQueued.current = false; };
  }, [connected, refresh]);
  useEffect(() => { const onFocus = (): void => { void refresh(); }; window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus); }, [refresh]);
  const control = async (row: WorktreeRecycleRecordView, action: "retry" | "keep"): Promise<void> => {
    const signal = scope.current?.signal;
    if (signal === undefined || signal.aborted || controlBusy.current) return;
    controlBusy.current = true; setBusy(true); setError(undefined);
    try {
      const result = await port.current.controlWorktreeRecycle({ id: row.id, generation: row.generation }, action, signal);
      if (signal.aborted) return;
      setRows((current) => current?.flatMap((record) => record.id !== row.id ? [record] : result === undefined ? [] : [result]));
      await refresh();
    } catch { if (!signal.aborted) setError("action"); }
    finally { controlBusy.current = false; if (!signal.aborted) setBusy(false); }
  };
  return <section className="settings-card worktree-recycle" aria-labelledby="worktree-recycle-title">
    <div className="setting-row"><div><h3 id="worktree-recycle-title">{t("worktreeRecycle.title")}</h3><p>{t("worktreeRecycle.body")}</p></div><Button disabled={!connected || busy} onClick={() => { void refresh(); }}>{t("common.refresh")}</Button></div>
    {!connected ? <p role="status">{t("help.connect")}</p> : error === "load" ? <p role="alert">{t("worktreeRecycle.loadFailed")}</p> : rows === undefined ? <p role="status"><Spinner />{t("common.loading")}</p>
      : rows.length === 0 ? <p>{t("worktreeRecycle.empty")}</p> : <ul className="worktree-recycle-list">{rows.map((row) => <li className="setting-row" key={`${row.id}:${row.generation}`}>
        <div><strong>{row.displayName || row.sessionId}</strong><p className="worktree-recycle-path">{row.pathDisplay}</p><p>{t(`worktreeRecycle.state.${row.state}`)} · {t(`worktreeRecycle.reason.${row.reason}`)}</p>
          {row.failures > 0 && <small>{t("worktreeRecycle.failures", { count: row.failures })}</small>}</div>
        <div className="worktree-recycle-actions"><Button disabled={busy} onClick={() => { void control(row, "retry"); }}>{t("worktreeRecycle.retry")}</Button><Button disabled={busy || row.state === "kept"} onClick={() => { void control(row, "keep"); }}>{t("worktreeRecycle.keep")}</Button></div>
      </li>)}</ul>}
    {error === "action" && <p role="alert">{t("worktreeRecycle.actionFailed")}</p>}
  </section>;
}
