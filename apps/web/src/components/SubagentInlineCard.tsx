import { useState, type JSX } from "react";
import { AlertCircle, Bot, CheckCircle2, ChevronRight, CircleStop, LoaderCircle, PanelRight, Square } from "lucide-react";

import type { BackgroundTaskView, SubagentRunDetailView, SubagentRunView } from "../model.js";
import { formatCompactUsageTokens } from "./message-usage.js";
import { formatSubagentDuration, projectSubagentInlineCard } from "./subagent-inline-card.js";
import type { Translator } from "./types.js";
import { IconButton, cx } from "./ui.js";

const expansionMemory = new Map<string, boolean>();
const MAXIMUM_REMEMBERED_CARDS = 500;

export function SubagentInlineCard({ task, run, detail, t, onOpen, onStop }: {
  readonly task: BackgroundTaskView;
  readonly run: SubagentRunView;
  readonly detail?: SubagentRunDetailView;
  readonly t: Translator;
  readonly onOpen?: (runId: string) => void;
  readonly onStop?: (runId: string) => Promise<void>;
}): JSX.Element {
  const projection = projectSubagentInlineCard(task, run, detail);
  const [expanded, setExpanded] = useState(() => expansionMemory.get(run.id) ?? false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();
  if (projection === undefined) return <></>;

  const hasDetails = projection.description !== undefined
    || projection.summary !== undefined
    || projection.lastToolName !== undefined
    || projection.childCount !== undefined
    || projection.errorMessage !== undefined;
  const statusLabel = subagentStateLabel(projection.state, t);
  const summaryNeedsCollapse = projection.summary !== undefined
    && (projection.summary.length > 320 || projection.summary.split(/\r?\n/gu).length > 4);
  const meta = [
    t("timeline.subagent"),
    statusLabel,
    ...(projection.totalTokens === undefined ? [] : [t("subagents.tokens", { count: formatCompactUsageTokens(projection.totalTokens) })]),
    ...(projection.toolUses === undefined ? [] : [t("subagents.toolUses", { count: projection.toolUses.toLocaleString() })]),
    ...(projection.durationMs === undefined ? [] : [formatSubagentDuration(projection.durationMs)]),
    ...(projection.costUsd === undefined ? [] : [formatSubagentCost(projection.costUsd)]),
    ...(projection.readOnly === undefined ? [] : [t(projection.readOnly ? "subagents.readOnly" : "subagents.writeEnabled")])
  ];
  const toggle = (): void => {
    if (!hasDetails) return;
    const next = !expanded;
    setExpanded(next);
    rememberExpansion(projection.id, next);
  };
  const stop = (): void => {
    if (onStop === undefined || !projection.canStop || stopping) return;
    setStopping(true);
    setStopError(undefined);
    void onStop(projection.id).catch((error: unknown) => {
      setStopError(error instanceof Error ? error.message : t("timeline.subagentStopFailed"));
    }).finally(() => setStopping(false));
  };

  return <article className={cx("subagent-inline-card", expanded && "is-expanded")} data-subagent-inline-card={projection.id} data-state={projection.state}>
    <div className="subagent-inline-card__row">
      <button
        type="button"
        className="subagent-inline-card__toggle"
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        aria-label={hasDetails ? t(expanded ? "timeline.subagentHideDetails" : "timeline.subagentShowDetails") : projection.title}
        onClick={toggle}
      >
        <span className="subagent-inline-card__avatar"><Bot aria-hidden="true" /></span>
        <span className="subagent-inline-card__body">
          <span className="subagent-inline-card__title">{subagentStatusIcon(projection.state)}<strong>{projection.title}</strong></span>
          <span className="subagent-inline-card__meta">
            {meta.map((part, index) => <span key={`${index}:${part}`}>{part}</span>)}
            {projection.model !== undefined && <span className="subagent-inline-card__model" data-subagent-model>{projection.model}{projection.thinkingLevel === undefined ? "" : ` · ${projection.thinkingLevel}`}</span>}
          </span>
        </span>
        {hasDetails && <ChevronRight className="subagent-inline-card__chevron" aria-hidden="true" />}
      </button>
      {onOpen !== undefined && <IconButton className="subagent-inline-card__action" label={t("timeline.subagentOpen")} onClick={() => onOpen(projection.id)}><PanelRight aria-hidden="true" /></IconButton>}
      {projection.canStop && onStop !== undefined && <IconButton className="subagent-inline-card__action" disabled={stopping} disabledReason={stopping ? t("timeline.subagentStopping") : undefined} label={stopping ? t("timeline.subagentStopping") : t("timeline.subagentStop")} onClick={stop}>{stopping ? <LoaderCircle className="spin-slow" aria-hidden="true" /> : <Square aria-hidden="true" />}</IconButton>}
    </div>
    {expanded && hasDetails && <div className="subagent-inline-card__details">
      {projection.description !== undefined && <p>{projection.description}</p>}
      {projection.summary !== undefined && <>
        <p className={cx("subagent-inline-card__summary", summaryNeedsCollapse && !summaryExpanded && "is-collapsed")} data-subagent-result>{projection.summary}</p>
        {summaryNeedsCollapse && <button type="button" className="subagent-inline-card__result-toggle" aria-expanded={summaryExpanded} onClick={() => setSummaryExpanded((current) => !current)}>{t(summaryExpanded ? "timeline.subagentHideFullResult" : "timeline.subagentShowFullResult")}</button>}
        {projection.summaryTruncated === true && <p className="subagent-inline-card__secondary">{t("subagents.resultTruncated")}</p>}
      </>}
      {projection.lastToolName !== undefined && <p className="subagent-inline-card__secondary" data-subagent-last-tool>{t("subagents.tool")}: {projection.lastToolName}</p>}
      {projection.childCount !== undefined && <p className="subagent-inline-card__secondary" data-subagent-child-count>{t("subagents.children")}: {projection.childCount.toLocaleString()}</p>}
      {projection.errorMessage !== undefined && <p className="subagent-inline-card__summary is-error">{projection.errorMessage}</p>}
    </div>}
    {stopError !== undefined && <p className="subagent-inline-card__error" role="alert"><AlertCircle aria-hidden="true" />{t("timeline.subagentStopFailed")}{stopError === t("timeline.subagentStopFailed") ? "" : ` ${stopError}`}</p>}
  </article>;
}

function formatSubagentCost(costUsd: number): string {
  return costUsd < 0.01 && costUsd > 0 ? "<$0.01" : `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
}

function subagentStatusIcon(state: SubagentRunView["state"]): JSX.Element {
  if (state === "completed") return <CheckCircle2 aria-hidden="true" />;
  if (state === "failed") return <AlertCircle aria-hidden="true" />;
  if (state === "stopped") return <CircleStop aria-hidden="true" />;
  return <LoaderCircle className={state === "running" ? "spin-slow" : undefined} aria-hidden="true" />;
}

function subagentStateLabel(state: SubagentRunView["state"], t: Translator): string {
  if (state === "queued") return t("subagents.stateQueued");
  if (state === "running") return t("subagents.stateRunning");
  if (state === "completed") return t("subagents.stateCompleted");
  if (state === "failed") return t("subagents.stateFailed");
  return t("subagents.stateStopped");
}

function rememberExpansion(id: string, expanded: boolean): void {
  expansionMemory.delete(id);
  expansionMemory.set(id, expanded);
  while (expansionMemory.size > MAXIMUM_REMEMBERED_CARDS) {
    const oldest = expansionMemory.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    expansionMemory.delete(oldest);
  }
}
