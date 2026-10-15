import { useEffect, useRef, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import type { BackgroundTaskHistoryView } from "../model.js";
import { taskSourceKey } from "../task-sharing.js";
import { BackgroundTasksPanel } from "./BackgroundTasksPanel.js";
import { SubagentsPanel } from "./SubagentsPanel.js";
import type { RunAction, Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

/** Task-scoped read panels reuse the normal consumers without node management tabs. */
export function TaskSharingTaskTools({ controller, sessionId, t, runAction }: {
  readonly controller: AppController; readonly sessionId: string; readonly t: Translator; readonly runAction: RunAction;
}): JSX.Element {
  const [panel, setPanel] = useState<"background" | "subagents">();
  const [history, setHistory] = useState<readonly BackgroundTaskHistoryView[]>([]), [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string>(), [refresh, setRefresh] = useState(0);
  const current = useRef(controller); current.current = controller;
  const source = JSON.stringify([taskSourceKey(controller.state.taskSource ?? { kind: "own" }),
    String(controller.state.snapshot.generation), String(controller.state.snapshot.sessions.find(item => item.id === sessionId)?.generation)]);
  const backend = controller.state.snapshot.backends.find(item => item.id === controller.state.snapshot.sessions.find(item => item.id === sessionId)?.backendId);
  const background = backend?.capabilities.get("background.tasks")?.supported === true, subagents = backend?.capabilities.get("subagents.list")?.supported === true;
  useEffect(() => {
    if (panel !== "background" || !background) return;
    const abort = new AbortController(); let flight = false, request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (abort.signal.aborted || flight || document.visibilityState === "hidden") return;
      if (timer) clearTimeout(timer); flight = true; request = new AbortController(); setState("loading");
      const signal = AbortSignal.any([abort.signal, request.signal]);
      try { const value = await current.current.listBackgroundTasks(sessionId, signal); if (!signal.aborted) { setHistory(value); setState("ready"); setError(undefined); } }
      catch (cause) { if (!signal.aborted) { setState("error"); setError(cause instanceof Error ? cause.message : undefined); } }
      finally { flight = false; if (!abort.signal.aborted) timer = setTimeout(() => { void read(); }, 2_000); }
    };
    const changed = (): void => { if (document.visibilityState === "hidden") request?.abort(); else void read(); };
    document.addEventListener("visibilitychange", changed); void read();
    return () => { abort.abort(); if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", changed); };
  }, [panel, background, source, sessionId, refresh]);
  return <>
    <div className="settings-actions">{background && <Button onClick={() => setPanel("background")}>{t("background.title")}</Button>}{subagents && <Button onClick={() => setPanel("subagents")}>{t("subagents.title")}</Button>}</div>
    <Modal open={panel !== undefined} title={t(panel === "background" ? "background.title" : "subagents.title")} showClose onClose={() => setPanel(undefined)}>
      {panel === "background" && <BackgroundTasksPanel timeline={controller.state.snapshot.timelineBySession.get(sessionId) ?? []} history={history} historyState={state} historyError={error}
        onRefresh={() => setRefresh(value => value + 1)} canCancel={false} onCancel={async () => { throw new Error("This action requires the task owner."); }}
        onReadOutput={(id, signal) => controller.getBackgroundTaskOutput(sessionId, id, signal)} outputOwner={source} locale={controller.state.effectiveLocale} t={t} />}
      {panel === "subagents" && <SubagentsPanel controller={controller} sessionId={sessionId} locale={controller.state.effectiveLocale} t={t} runAction={runAction} />}
    </Modal>
  </>;
}
