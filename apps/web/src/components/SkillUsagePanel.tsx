import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Activity, AlertTriangle, BarChart3, RefreshCcw, TrendingUp } from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  BackendView,
  ResourceUsageReportView,
  ResourceUsageSourceView,
  ResourceUsageVersionBreakdownView
} from "../model.js";
import type { Translator } from "./types.js";
import { Button, Pill, formatRelativeTime } from "./ui.js";

type ReportState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly report: ResourceUsageReportView };

export function SkillUsagePanel({ controller, resourceId, backends, locale, t }: {
  readonly controller: AppController;
  readonly resourceId: string;
  readonly backends: readonly BackendView[];
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element {
  const timeZone = useMemo(localTimeZone, []);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [state, setState] = useState<ReportState>({ kind: "loading" });

  useEffect(() => {
    const abort = new AbortController();
    setState({ kind: "loading" });
    void controller.getSkillResourceUsageReport(resourceId, timeZone, abort.signal).then((report) => {
      if (!abort.signal.aborted) setState({ kind: "ready", report });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) {
        setState({
          kind: "error",
          message: error instanceof Error && error.message.trim() !== "" ? error.message : t("skills.usage.error")
        });
      }
    });
    return () => abort.abort();
  }, [controller, resourceId, timeZone, refreshSequence, t]);

  return <section className="skill-usage" aria-labelledby={`skill-usage-${resourceId}`}>
    <header className="skill-usage__header">
      <div><p className="eyebrow">{t("skills.usage.eyebrow")}</p><h3 id={`skill-usage-${resourceId}`}>{t("skills.usage.title")}</h3><p>{t("skills.usage.body")}</p></div>
      <Button disabled={state.kind === "loading"} onClick={() => setRefreshSequence((value) => value + 1)}>
        <RefreshCcw aria-hidden="true" />{t("common.refresh")}
      </Button>
    </header>
    {state.kind === "loading" && <div className="skill-usage__state" role="status"><RefreshCcw className="spin" aria-hidden="true" /><span>{t("skills.usage.loading")}</span></div>}
    {state.kind === "error" && <div className="skill-usage__state is-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{state.message}</span><Button onClick={() => setRefreshSequence((value) => value + 1)}>{t("common.retry")}</Button></div>}
    {state.kind === "ready" && <SkillUsageReport report={state.report} backends={backends} locale={locale} t={t} onRetry={() => setRefreshSequence((value) => value + 1)} />}
  </section>;
}

function SkillUsageReport({ report, backends, locale, t, onRetry }: {
  readonly report: ResourceUsageReportView;
  readonly backends: readonly BackendView[];
  readonly locale: string;
  readonly t: Translator;
  readonly onRetry: () => void;
}): JSX.Element {
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const failures = report.totals.toolErrors + report.totals.commandFailures;
  const maximum = Math.max(1, ...report.days.map((day) => day.metrics.samples));
  return <div className="skill-usage__report">
    {!report.projection.complete && <div className="skill-usage__degraded" role="status">
      <AlertTriangle aria-hidden="true" />
      <span><strong>{t("skills.usage.degradedTitle")}</strong><small>{t("skills.usage.degradedBody", { count: report.projection.pendingStreamCount })}</small></span>
      <Button onClick={onRetry}>{t("common.retry")}</Button>
    </div>}
    <dl className="skill-usage__summary">
      <UsageMetric icon={<Activity />} label={t("skills.usage.samples")} value={number.format(report.totals.samples)} />
      <UsageMetric icon={<TrendingUp />} label={t("skills.usage.strongActive")} value={number.format(report.totals.strongActive)} />
      <UsageMetric icon={<BarChart3 />} label={t("skills.usage.passive")} value={number.format(report.totals.passiveExposures)} />
      <UsageMetric icon={<AlertTriangle />} label={t("skills.usage.failures")} value={number.format(failures)} danger={failures > 0} />
    </dl>
    <p className="skill-usage__latest">
      <span>{t("skills.usage.latest")}</span>
      <strong>{report.totals.latestUsedAt === undefined ? t("skills.usage.never") : formatRelativeTime(report.totals.latestUsedAt, locale)}</strong>
      <small>{t("skills.usage.window", { from: report.fromDay, through: report.throughDay, zone: report.timeZone })}</small>
    </p>
    <section className="skill-usage__trend">
      <header><h4>{t("skills.usage.trend")}</h4><span>{t("skills.usage.trendTotal", { count: number.format(report.totals.samples) })}</span></header>
      <div className="skill-usage__bars" role="img" aria-label={t("skills.usage.trendAria", { count: number.format(report.totals.samples) })}>
        {report.days.map((day) => <span key={day.localDay} title={`${day.localDay}: ${number.format(day.metrics.samples)}`}><i style={{ height: `${Math.max(day.metrics.samples === 0 ? 0 : 7, day.metrics.samples / maximum * 100)}%` }} /></span>)}
      </div>
      <footer><span>{report.fromDay}</span><span>{report.throughDay}</span></footer>
    </section>
    <div className="skill-usage__breakdowns">
      <UsageBreakdown
        title={t("skills.usage.sources")}
        empty={t("skills.usage.noSources")}
        rows={report.sources.map((entry) => ({ key: entry.source, label: sourceLabel(entry.source, t), samples: entry.metrics.samples }))}
        number={number}
      />
      <UsageBreakdown
        title={t("skills.usage.agents")}
        empty={t("skills.usage.noAgents")}
        rows={report.agents.map((entry) => ({ key: entry.backendId, label: backendName(entry.backendId, backends), samples: entry.metrics.samples }))}
        number={number}
      />
    </div>
    <VersionComparison comparison={report.comparison} number={number} t={t} />
  </div>;
}

function UsageMetric({ icon, label, value, danger = false }: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly value: string;
  readonly danger?: boolean;
}): JSX.Element {
  return <div className={danger ? "is-danger" : undefined}><dt>{icon}<span>{label}</span></dt><dd>{value}</dd></div>;
}

function UsageBreakdown({ title, empty, rows, number }: {
  readonly title: string;
  readonly empty: string;
  readonly rows: readonly { readonly key: string; readonly label: string; readonly samples: number }[];
  readonly number: Intl.NumberFormat;
}): JSX.Element {
  const maximum = Math.max(1, ...rows.map((row) => row.samples));
  return <section><h4>{title}</h4>{rows.length === 0 ? <p>{empty}</p> : <ol>{rows.map((row) => <li key={row.key}>
    <span><strong>{row.label}</strong><small>{number.format(row.samples)}</small></span>
    <i><b style={{ width: `${row.samples / maximum * 100}%` }} /></i>
  </li>)}</ol>}</section>;
}

function VersionComparison({ comparison, number, t }: {
  readonly comparison: ResourceUsageReportView["comparison"];
  readonly number: Intl.NumberFormat;
  readonly t: Translator;
}): JSX.Element {
  const current = comparison.current;
  const previous = comparison.previous;
  return <section className="skill-usage__comparison">
    <header><div><h4>{t("skills.usage.comparison")}</h4><p>{t("skills.usage.comparisonBody")}</p></div><Pill tone={comparison.available ? "success" : "neutral"}>{comparison.available ? t("skills.usage.comparisonReady") : t("skills.usage.comparisonWaiting")}</Pill></header>
    {comparison.available && current !== undefined && previous !== undefined
      ? <div className="skill-usage__version-grid">
          <VersionMetric title={t("skills.usage.currentVersion")} version={current} number={number} t={t} />
          <VersionMetric title={t("skills.usage.previousVersion")} version={previous} number={number} t={t} />
          <div className="skill-usage__delta"><span>{t("skills.usage.sampleChange")}</span><strong>{signedNumber(current.metrics.samples - previous.metrics.samples, number)}</strong></div>
        </div>
      : <p className="skill-usage__comparison-note">{comparisonUnavailableReason(comparison, t)}</p>}
  </section>;
}

function VersionMetric({ title, version, number, t }: {
  readonly title: string;
  readonly version: ResourceUsageVersionBreakdownView;
  readonly number: Intl.NumberFormat;
  readonly t: Translator;
}): JSX.Element {
  return <div><span>{title}</span><strong>{versionLabel(version)}</strong><small>{t("skills.usage.versionSamples", { count: number.format(version.metrics.samples) })}</small></div>;
}

function comparisonUnavailableReason(comparison: ResourceUsageReportView["comparison"], t: Translator): string {
  switch (comparison.unavailableReason) {
    case "noCurrentVersion": return t("skills.usage.unavailable.noCurrent");
    case "noPreviousVersion": return t("skills.usage.unavailable.noPrevious");
    case "currentSamples": return t("skills.usage.unavailable.currentSamples", { count: comparison.minimumSamples });
    case "previousSamples": return t("skills.usage.unavailable.previousSamples", { count: comparison.minimumSamples });
    case undefined: return t("skills.usage.unavailable.noCurrent");
  }
}

function sourceLabel(source: ResourceUsageSourceView, t: Translator): string {
  return t(`skills.usage.source.${source}`);
}

function versionLabel(value: ResourceUsageVersionBreakdownView): string {
  return value.identity.version === undefined
    ? `r${value.identity.resourceRevision.toString(10)}`
    : `v${value.identity.version}`;
}

function signedNumber(value: number, number: Intl.NumberFormat): string {
  return value > 0 ? `+${number.format(value)}` : number.format(value);
}

function backendName(id: string, backends: readonly BackendView[]): string {
  return backends.find((backend) => backend.id === id)?.name ?? id;
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
