import type { JSX, KeyboardEvent, MouseEvent } from "react";
import { Check, ExternalLink, RotateCw, Trash2 } from "lucide-react";

import type { ScheduleRunHistoryView, ScheduleRunMoneyView } from "../model.js";
import type { Translator } from "./types.js";
import { IconButton, StatusDot, formatDateTime } from "./ui.js";

const INTERACTIVE_SELECTOR = "button, a, input, select, textarea, [role='button'], [role='menu'], [role='menuitem']";

export function scheduleHistoryCardShouldMarkRead(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) === null;
}

export function isTerminalScheduleHistoryRun(run: ScheduleRunHistoryView): boolean {
  return run.state !== "running";
}

export function isUnreadScheduleHistoryRun(run: ScheduleRunHistoryView): boolean {
  return run.readAt === undefined && (
    run.state === "completed"
    || run.state === "failed"
    || run.state === "aborted"
    || run.state === "interrupted"
  );
}

export function canRestartScheduleHistoryRun(run: ScheduleRunHistoryView): boolean {
  return run.sessionId.length === 0 && (run.state === "aborted" || run.state === "interrupted");
}

export function ScheduleRunHistoryCard({ run, sessionAvailable, locale, t, pending = false, onMarkRead, onOpenTask, onRestart, onDelete }: {
  readonly run: ScheduleRunHistoryView;
  readonly sessionAvailable: boolean;
  readonly locale: string;
  readonly t: Translator;
  readonly pending?: boolean;
  readonly onMarkRead: (run: ScheduleRunHistoryView) => void;
  readonly onOpenTask: (run: ScheduleRunHistoryView) => void;
  readonly onRestart: (run: ScheduleRunHistoryView) => void;
  readonly onDelete: (run: ScheduleRunHistoryView) => void;
}): JSX.Element {
  const terminal = isTerminalScheduleHistoryRun(run);
  const unread = isUnreadScheduleHistoryRun(run);
  const restartable = canRestartScheduleHistoryRun(run);
  const markRead = (): void => { if (unread) onMarkRead(run); };
  const handleClick = (event: MouseEvent<HTMLElement>): void => {
    if (unread && scheduleHistoryCardShouldMarkRead(event.target)) markRead();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!unread || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    markRead();
  };
  const durationMs = run.durationMs ?? (run.finishedAt === undefined ? undefined : Math.max(0, run.finishedAt - run.triggeredAt));
  const cost = scheduleHistoryCostText(run, locale, t);
  return <article
    className={`schedule-history-card${unread ? " is-unread" : ""}`}
    tabIndex={unread ? 0 : undefined}
    title={unread ? t("scheduler.markRunRead") : undefined}
    onClick={handleClick}
    onKeyDown={handleKeyDown}
  >
    <header className="schedule-history-card__header">
      <span className="schedule-history-card__status">
        <StatusDot state={run.state} label={scheduleRunStateLabel(run.state, t)} />
        {unread && <span className="schedule-history-card__unread" aria-label={t("scheduler.unreadRun")} />}
      </span>
      <span><strong>{scheduleRunStateLabel(run.state, t)}</strong><small>{formatDateTime(run.triggeredAt || run.scheduledAt, locale)}</small></span>
      <div className="schedule-history-card__actions">
        {unread && <IconButton disabled={pending} label={t("scheduler.markRunRead")} onClick={markRead}><Check aria-hidden="true" /></IconButton>}
        {run.sessionId.length > 0 && sessionAvailable && <IconButton label={t("scheduler.openRunTask")} onClick={() => onOpenTask(run)}><ExternalLink aria-hidden="true" /></IconButton>}
        {restartable && <IconButton disabled={pending} label={t("scheduler.restartRun")} onClick={() => onRestart(run)}><RotateCw aria-hidden="true" /></IconButton>}
        {terminal && <IconButton disabled={pending} label={t("scheduler.deleteRun")} onClick={() => onDelete(run)}><Trash2 aria-hidden="true" /></IconButton>}
      </div>
    </header>
    <div className="schedule-history-card__meta">
      <span>{run.runId || run.id}</span>
      {durationMs !== undefined && <span>{t("scheduler.runDuration", { duration: formatScheduleDuration(durationMs) })}</span>}
      {cost !== undefined && <span>{cost}</span>}
      {run.sessionId.length > 0 && !sessionAvailable && <span>{t("scheduler.runTaskUnavailable")}</span>}
    </div>
    {run.resultText !== undefined && <p className="schedule-history-card__result">{run.resultText}</p>}
    {run.error !== undefined && <p className="danger-text">{run.error}</p>}
    {run.preRun !== undefined && <details className="schedule-history-card__pre-run">
      <summary>{t("scheduler.preRunResult")}</summary>
      <dl>
        <div><dt>{t("common.status")}</dt><dd>{run.preRun.status}</dd></div>
        <div><dt>{t("scheduler.preRunDecision")}</dt><dd>{run.preRun.decision}</dd></div>
        {run.preRun.exitCode !== undefined && <div><dt>{t("scheduler.preRunExitCode")}</dt><dd>{run.preRun.exitCode}</dd></div>}
        <div><dt>{t("scheduler.duration")}</dt><dd>{formatScheduleDuration(run.preRun.durationMs)}</dd></div>
      </dl>
      {run.preRun.stdout !== undefined && <pre>{run.preRun.stdout}{run.preRun.stdoutTruncated ? `\n${t("common.truncated")}` : ""}</pre>}
      {run.preRun.stderr !== undefined && <pre>{run.preRun.stderr}{run.preRun.stderrTruncated ? `\n${t("common.truncated")}` : ""}</pre>}
      {run.preRun.spawnError !== undefined && <p className="danger-text">{run.preRun.spawnError}</p>}
      {run.preRun.error !== undefined && <p className="danger-text">{run.preRun.error}</p>}
    </details>}
  </article>;
}

function scheduleHistoryCostText(run: ScheduleRunHistoryView, locale: string, t: Translator): string | undefined {
  if (run.state === "running") return undefined;
  const parts: string[] = [];
  if (run.cost !== undefined) parts.push(t("scheduler.runCost", { cost: formatScheduleMoney(run.cost, locale) }));
  if (run.estimatedValue !== undefined) parts.push(t("scheduler.runValue", { value: formatScheduleMoney(run.estimatedValue, locale) }));
  if (parts.length > 0) return parts.join(" · ");
  if (run.costAttribution === "zero" || run.zeroCost) return t("scheduler.zeroTokens");
  if (run.costAttribution === "unavailable") return t("scheduler.costUnavailable");
  return undefined;
}

function formatScheduleMoney(value: ScheduleRunMoneyView, locale: string): string {
  const formatted = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    maximumFractionDigits: 4
  }).format(value.amount);
  return value.approximate ? `≈${formatted}` : formatted;
}

function formatScheduleDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function scheduleRunStateLabel(state: ScheduleRunHistoryView["state"], t: Translator): string {
  if (state === "completed") return t("scheduler.runCompleted");
  if (state === "failed") return t("scheduler.runFailed");
  if (state === "skipped") return t("scheduler.runSkipped");
  if (state === "interrupted") return t("scheduler.runInterrupted");
  if (state === "aborted") return t("scheduler.runAborted");
  return t("scheduler.runRunning");
}
