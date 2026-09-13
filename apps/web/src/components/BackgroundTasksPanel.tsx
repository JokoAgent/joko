import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { ArrowLeft, CheckCircle2, CircleDashed, Clock3, ListTodo, RefreshCcw, Square } from "lucide-react";
import type { BackgroundTaskHistoryView, Locale, TimelineItemView } from "../model.js";
import { backgroundTaskDuration, isActiveBackgroundTask, projectBackgroundTaskGroups, type ProjectedBackgroundTask } from "./background-task-panel.js";
import type { Translator } from "./types.js";
import { Button, Pill, StatusDot, formatRelativeTime } from "./ui.js";

export function BackgroundTasksPanel({ timeline, history, historyState, historyError, onRefresh, canCancel, onCancel, locale, t }: {
  readonly timeline: readonly TimelineItemView[];
  readonly history: readonly BackgroundTaskHistoryView[];
  readonly historyState: "idle" | "loading" | "ready" | "error";
  readonly historyError?: string;
  readonly onRefresh: () => void;
  readonly canCancel: boolean;
  readonly onCancel: (backgroundTaskId: string) => Promise<void>;
  readonly locale: Locale;
  readonly t: Translator;
}): JSX.Element {
  const groups = useMemo(() => projectBackgroundTaskGroups(timeline, history), [history, timeline]);
  const tasks = useMemo(() => [...groups.running, ...groups.finished], [groups]);
  const [selectedId, setSelectedId] = useState<string>();
  const [cancelPendingId, setCancelPendingId] = useState<string>();
  const [cancelError, setCancelError] = useState<string>();
  const selected = tasks.find((task) => task.id === selectedId);

  useEffect(() => {
    if (selectedId !== undefined && selected === undefined) setSelectedId(undefined);
  }, [selected, selectedId]);

  const cancel = async (backgroundTaskId: string): Promise<void> => {
    if (cancelPendingId !== undefined) return;
    setCancelPendingId(backgroundTaskId);
    setCancelError(undefined);
    try {
      await onCancel(backgroundTaskId);
      onRefresh();
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelPendingId(undefined);
    }
  };

  if (selected !== undefined) {
    return <BackgroundTaskDetail
      task={selected}
      canCancel={canCancel}
      cancelling={cancelPendingId === selected.id}
      cancelError={cancelError}
      locale={locale}
      t={t}
      onBack={() => setSelectedId(undefined)}
      onCancel={() => cancel(selected.id)}
    />;
  }

  return <div className="background-task-panel">
    <header className="background-task-panel__heading">
      <div><h2>{t("background.title")}</h2><p>{t("background.subtitle")}</p></div>
      <Pill>{tasks.length}</Pill>
      <Button tone="ghost" disabled={historyState === "loading"} onClick={onRefresh}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button>
    </header>
    {historyState === "loading" && history.length === 0 && <p className="background-task-panel__load-state" role="status">{t("background.loading")}</p>}
    {historyState === "error" && <div className="background-task-panel__load-error" role="alert"><strong>{t("background.historyError")}</strong>{historyError !== undefined && <span>{historyError}</span>}</div>}
    {cancelError !== undefined && <div className="background-task-panel__load-error" role="alert"><strong>{t("background.cancelFailed")}</strong><span>{cancelError}</span></div>}
    {tasks.length === 0 ? <div className="background-task-panel__empty"><ListTodo aria-hidden="true" /><strong>{t("background.empty")}</strong><span>{t("background.emptyHelp")}</span></div> : <>
      <BackgroundTaskGroup title={t("background.running")} tasks={groups.running} canCancel={canCancel} cancelPendingId={cancelPendingId} locale={locale} t={t} onSelect={setSelectedId} onCancel={cancel} />
      <BackgroundTaskGroup title={t("background.finished")} tasks={groups.finished} canCancel={false} cancelPendingId={cancelPendingId} locale={locale} t={t} onSelect={setSelectedId} onCancel={cancel} />
    </>}
  </div>;
}

function BackgroundTaskGroup({ title, tasks, canCancel, cancelPendingId, locale, t, onSelect, onCancel }: {
  readonly title: string;
  readonly tasks: readonly ProjectedBackgroundTask[];
  readonly canCancel: boolean;
  readonly cancelPendingId?: string;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onSelect: (id: string) => void;
  readonly onCancel: (id: string) => Promise<void>;
}): JSX.Element | null {
  if (tasks.length === 0) return null;
  return <section className="background-task-group">
    <header><h3>{title}</h3><span>{tasks.length}</span></header>
    <ul className="background-task-list">
      {tasks.map((task) => <li key={task.id} className="background-task-row"><button type="button" className="background-task-row__select" onClick={() => onSelect(task.id)}>
          <StatusDot state={task.state} label={backgroundTaskStateLabel(task.state, t)} />
          <span className="background-task-row__body"><strong>{task.title}</strong><span>{task.detail ?? backgroundTaskStateLabel(task.state, t)}</span></span>
          <span className="background-task-row__meta"><Pill tone={backgroundTaskTone(task.state)}>{backgroundTaskStateLabel(task.state, t)}</Pill><time dateTime={new Date(task.startedAt ?? task.createdAt).toISOString()}>{formatRelativeTime(task.startedAt ?? task.createdAt, locale)}</time></span>
        </button>{canCancel && isActiveBackgroundTask(task) && <Button
          tone="danger"
          className="background-task-row__stop"
          disabled={cancelPendingId !== undefined}
          aria-label={`${t("common.stop")} ${task.title}`}
          onClick={() => { void onCancel(task.id); }}
        ><Square aria-hidden="true" />{cancelPendingId === task.id ? t("background.stopping") : t("common.stop")}</Button>}</li>)}
    </ul>
  </section>;
}

function BackgroundTaskDetail({ task, canCancel, cancelling, cancelError, locale, t, onBack, onCancel }: {
  readonly task: ProjectedBackgroundTask;
  readonly canCancel: boolean;
  readonly cancelling: boolean;
  readonly cancelError?: string;
  readonly locale: Locale;
  readonly t: Translator;
  readonly onBack: () => void;
  readonly onCancel: () => Promise<void>;
}): JSX.Element {
  const startedAt = task.startedAt ?? task.createdAt;
  const duration = backgroundTaskDuration(task, Date.now());
  const progress = Math.round((task.progressRatio ?? 0) * 100);
  return <div className="background-task-panel background-task-detail">
    <Button tone="ghost" className="background-task-detail__back" onClick={onBack}><ArrowLeft aria-hidden="true" />{t("background.back")}</Button>
    <header className="background-task-detail__heading">
      <span className="background-task-detail__icon">{task.state === "completed" ? <CheckCircle2 aria-hidden="true" /> : task.state === "running" ? <CircleDashed aria-hidden="true" /> : <Clock3 aria-hidden="true" />}</span>
      <div><h2>{task.title}</h2><p>{task.detail ?? backgroundTaskStateLabel(task.state, t)}</p></div>
      <Pill tone={backgroundTaskTone(task.state)}>{backgroundTaskStateLabel(task.state, t)}</Pill>
      {canCancel && isActiveBackgroundTask(task) && <Button tone="danger" disabled={cancelling} onClick={() => { void onCancel(); }}><Square aria-hidden="true" />{cancelling ? t("background.stopping") : t("common.stop")}</Button>}
    </header>
    {(task.state === "running" || task.state === "waiting" || task.state === "queued") && task.progressRatio !== undefined && <div className="background-task-progress" aria-label={t("background.progress", { percent: progress })}><span style={{ width: `${progress}%` }} /></div>}
    <dl className="background-task-metadata">
      <div><dt>{t("background.started")}</dt><dd><time dateTime={new Date(startedAt).toISOString()}>{formatDateTime(startedAt, locale)}</time></dd></div>
      {task.endedAt !== undefined && <div><dt>{t("background.ended")}</dt><dd><time dateTime={new Date(task.endedAt).toISOString()}>{formatDateTime(task.endedAt, locale)}</time></dd></div>}
      {duration !== undefined && <div><dt>{t("background.duration")}</dt><dd>{formatDuration(duration)}</dd></div>}
      <div><dt>{t("background.identifier")}</dt><dd><code>{task.id}</code></dd></div>
      {task.parentTaskId !== undefined && <div><dt>{t("background.parent")}</dt><dd><code>{task.parentTaskId}</code></dd></div>}
      {task.runId !== undefined && <div><dt>{t("background.run")}</dt><dd><code>{task.runId}</code></dd></div>}
    </dl>
    <section className="background-task-activity">
      <header><h3>{t("background.activity")}</h3></header>
      <div><StatusDot state={task.state} label={backgroundTaskStateLabel(task.state, t)} /><span><strong>{backgroundTaskStateLabel(task.state, t)}</strong>{task.detail !== undefined && <small>{task.detail}</small>}</span><time dateTime={new Date(task.endedAt ?? startedAt).toISOString()}>{formatRelativeTime(task.endedAt ?? startedAt, locale)}</time></div>
    </section>
    {cancelError !== undefined && <div className="background-task-error" role="alert"><strong>{t("background.cancelFailed")}</strong><span>{cancelError}</span></div>}
    {task.error !== undefined && <div className="background-task-error" role="alert"><strong>{task.error.code}</strong><span>{task.error.message}</span></div>}
  </div>;
}

function backgroundTaskStateLabel(state: ProjectedBackgroundTask["state"], t: Translator): string {
  if (state === "queued") return t("background.stateQueued");
  if (state === "running") return t("background.stateRunning");
  if (state === "waiting") return t("background.stateWaiting");
  if (state === "completed") return t("background.stateCompleted");
  if (state === "failed") return t("background.stateFailed");
  if (state === "aborted") return t("background.stateAborted");
  return t("background.stateUnknown");
}

function backgroundTaskTone(state: ProjectedBackgroundTask["state"]): "neutral" | "success" | "warning" | "danger" | "accent" {
  if (state === "completed") return "success";
  if (state === "failed") return "danger";
  if (state === "running") return "accent";
  if (state === "waiting") return "warning";
  return "neutral";
}

function formatDateTime(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en-XA" ? "en" : locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
