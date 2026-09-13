import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { ChevronDown, ChevronUp, RefreshCw, TriangleAlert } from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  Locale,
  ModelUsageHistoryDayView,
  UsageCurrencyTotalView,
  UsageHistoryDayView,
  UsageHistorySummaryView,
  UsageHistoryView
} from "../model.js";
import { readUsageDashboardPreference, setUsageDashboardCollapsed } from "../usage-dashboard-preferences.js";
import type { Translator } from "./types.js";
import { IconButton, cx } from "./ui.js";

const HISTORY_DAYS = 140;
const DAILY_BAR_DAYS = 30;
const REFRESH_INTERVAL_MS = 60_000;
const MODEL_COLORS = 8;

export function HomeUsageDashboard({ controller, ownerId, locale, t }: {
  readonly controller: AppController;
  readonly ownerId: string | undefined;
  readonly locale: Locale;
  readonly t: Translator;
}): JSX.Element | null {
  const ownerPreference = readUsageDashboardPreference(ownerId);
  const [collapsed, setCollapsed] = useState(ownerPreference.collapsed);
  const [history, setHistory] = useState<UsageHistoryView>();
  const [error, setError] = useState<string>();
  const [refreshSequence, setRefreshSequence] = useState(0);
  const requestGeneration = useRef(0);
  const enabled = ownerPreference.enabled;

  useEffect(() => {
    const next = readUsageDashboardPreference(ownerId);
    requestGeneration.current += 1;
    setCollapsed(next.collapsed);
    setHistory(undefined);
    setError(undefined);
  }, [ownerId]);

  useEffect(() => {
    if (collapsed || !enabled) return;
    const controllerAbort = new AbortController();
    const generation = ++requestGeneration.current;
    const load = async (): Promise<void> => {
      try {
        const next = await controller.getUsageHistory(HISTORY_DAYS, "", "", controllerAbort.signal);
        if (controllerAbort.signal.aborted || requestGeneration.current !== generation) return;
        setHistory(next);
        setError(undefined);
      } catch (cause) {
        if (controllerAbort.signal.aborted || requestGeneration.current !== generation) return;
        setError(cause instanceof Error ? cause.message : t("usage.loadFailed"));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      requestGeneration.current += 1;
      controllerAbort.abort();
      window.clearInterval(timer);
    };
  }, [collapsed, controller, enabled, ownerId, refreshSequence, t]);

  if (!enabled) return null;
  const toggleCollapsed = (): void => {
    const next = !collapsed;
    requestGeneration.current += 1;
    setCollapsed(next);
    setUsageDashboardCollapsed(ownerId, next);
  };
  const today = history?.today ?? emptySummary();
  const last30Days = history?.last30Days ?? emptySummary();
  const loading = history === undefined && error === undefined;
  return <section className={cx("home-usage-dashboard", collapsed && "is-collapsed")} aria-labelledby="home-usage-title">
    <header className="home-usage-dashboard__header">
      <button type="button" className="home-usage-dashboard__collapse" aria-expanded={!collapsed} onClick={toggleCollapsed}>
        <span><strong id="home-usage-title">{t("usage.title")}</strong><small>{collapsed && history !== undefined
          ? `${formatSummaryCost(today, locale, t)} · ${formatTokens(today.usage.totalTokens, locale)} ${t("context.tokens")} · ${t("usage.streakDays", { days: history.currentStreakDays })} · ${formatSummaryCost(last30Days, locale, t)}`
          : t("usage.subtitle")}</small></span>
        {collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
      </button>
      {!collapsed && <IconButton label={t("usage.refresh")} disabled={loading} onClick={() => setRefreshSequence((value) => value + 1)}><RefreshCw aria-hidden="true" /></IconButton>}
    </header>
    {!collapsed && <div className="home-usage-dashboard__body" aria-busy={loading}>
      {error !== undefined && <div className="home-usage-dashboard__error" role="alert"><TriangleAlert aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setRefreshSequence((value) => value + 1)}>{t("common.retry")}</button></div>}
      <div className="home-usage-dashboard__stats">
        <UsageStat label={t("usage.todayCost")} value={formatSummaryCost(today, locale, t)} meta={summaryPriceKind(today, t)} loading={loading} anomalous={history?.todayAnomalous === true} />
        <UsageStat label={t("usage.todayTokens")} value={formatTokens(today.usage.totalTokens, locale)} loading={loading} />
        <UsageStat label={t("usage.thirtyDayCost")} value={formatSummaryCost(last30Days, locale, t)} meta={summaryPriceKind(last30Days, t)} loading={loading} />
        <UsageStat label={t("usage.thirtyDayTokens")} value={formatTokens(last30Days.usage.totalTokens, locale)} loading={loading} />
        <UsageStat label={t("usage.streak")} value={t("usage.streakDays", { days: history?.currentStreakDays ?? 0 })} meta={t("usage.longestStreak", { days: history?.longestStreakDays ?? 0 })} loading={loading} />
      </div>
      <div className="home-usage-dashboard__charts">
        <section className="usage-panel usage-heatmap-panel" aria-labelledby="usage-heatmap-title">
          <header><div><h3 id="usage-heatmap-title">{t("usage.heatmap")}</h3><p>{t("usage.heatmapBody")}</p></div><span>{HISTORY_DAYS} {t("usage.days")}</span></header>
          <UsageHeatmap days={history?.days ?? placeholderDays(HISTORY_DAYS)} locale={locale} t={t} loading={loading} />
        </section>
        <section className="usage-panel usage-bars-panel" aria-labelledby="usage-bars-title">
          <header><div><h3 id="usage-bars-title">{t("usage.daily")}</h3><p>{t("usage.dailyBody")}</p></div><span>{DAILY_BAR_DAYS} {t("usage.days")}</span></header>
          <UsageDailyBars days={(history?.days ?? placeholderDays(HISTORY_DAYS)).slice(-DAILY_BAR_DAYS)} modelDaily={history?.modelDaily ?? []} locale={locale} t={t} loading={loading} />
        </section>
      </div>
      <ModelUsageDetails history={history} locale={locale} t={t} loading={loading} />
    </div>}
  </section>;
}

function UsageStat({ label, value, meta, loading, anomalous = false }: {
  readonly label: string;
  readonly value: string;
  readonly meta?: string;
  readonly loading: boolean;
  readonly anomalous?: boolean;
}): JSX.Element {
  return <article className={cx("usage-stat", loading && "is-loading", anomalous && "is-anomalous")}>
    <span>{label}</span><strong>{loading ? "—" : value}</strong>{!loading && meta !== undefined && <small>{meta}</small>}
  </article>;
}

export function UsageHeatmap({ days, locale, t, loading = false }: {
  readonly days: readonly UsageHistoryDayView[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly loading?: boolean;
}): JSX.Element {
  const currency = comparableCurrency(days);
  const metric = (day: UsageHistoryDayView): number => currency === undefined
    ? day.usage.totalTokens
    : comparableCost(day, currency) ?? 0;
  const maximum = Math.max(0, ...days.map(metric));
  return <div className={cx("usage-heatmap", loading && "is-loading")} role="img" aria-label={t("usage.heatmapAria")}>
    {days.map((day, index) => {
      const level = heatLevel(metric(day), maximum);
      const label = `${formatDay(day.day, locale)}: ${formatTokens(day.usage.totalTokens, locale)} ${t("context.tokens")}; ${formatCurrencyTotals(day.currencyTotals, locale, t)}`;
      return <span key={`${day.day}-${index}`} className={`usage-heatmap__cell level-${level}`} title={label} aria-label={label} />;
    })}
  </div>;
}

export function UsageDailyBars({ days, modelDaily, locale, t, loading = false }: {
  readonly days: readonly UsageHistoryDayView[];
  readonly modelDaily: readonly ModelUsageHistoryDayView[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly loading?: boolean;
}): JSX.Element {
  const modelKeys = useMemo(() => rankedModelKeys(modelDaily), [modelDaily]);
  const colorByModel = new Map(modelKeys.map((key, index) => [key, index % MODEL_COLORS]));
  const valuesByDay = new Map<string, ModelUsageHistoryDayView[]>();
  for (const value of modelDaily) valuesByDay.set(value.day, [...(valuesByDay.get(value.day) ?? []), value]);
  const candidateCurrency = comparableCurrency(days);
  const currency = candidateCurrency !== undefined && modelDaily.every((value) =>
    value.usage.totalTokens === 0 || comparableCost(value, candidateCurrency) !== undefined)
    ? candidateCurrency
    : undefined;
  const metric = (value: UsageHistorySummaryView): number => currency === undefined
    ? value.usage.totalTokens
    : comparableCost(value, currency) ?? 0;
  const maximum = Math.max(1, ...days.map(metric));
  return <div className={cx("usage-daily-bars", loading && "is-loading")} role="img" aria-label={t("usage.dailyAria")}>
    {days.map((day) => {
      const values = valuesByDay.get(day.day) ?? [];
      return <span className="usage-daily-bars__day" key={day.day} title={`${formatDay(day.day, locale)}: ${formatTokens(day.usage.totalTokens, locale)} ${t("context.tokens")}`}>
        <span className="usage-daily-bars__stack">
          {values.map((value) => {
            const key = usageModelKey(value.backendId, value.providerId, value.modelId);
            const style = { "--usage-segment-height": `${(metric(value) / maximum) * 100}%` } as CSSProperties;
            return <span key={key} className={`usage-daily-bars__segment color-${colorByModel.get(key) ?? 0}`} style={style} />;
          })}
        </span>
      </span>;
    })}
  </div>;
}

function ModelUsageDetails({ history, locale, t, loading }: {
  readonly history: UsageHistoryView | undefined;
  readonly locale: Locale;
  readonly t: Translator;
  readonly loading: boolean;
}): JSX.Element {
  const models = history?.models ?? [];
  return <section className="usage-panel usage-models" aria-labelledby="usage-models-title">
    <header><div><h3 id="usage-models-title">{t("usage.models")}</h3><p>{t("usage.modelsBody")}</p></div></header>
    <div className={cx("usage-models__list", loading && "is-loading")}>
      {models.map((model, index) => <article key={usageModelKey(model.backendId, model.providerId, model.modelId)}>
        <span className={`usage-models__swatch color-${index % MODEL_COLORS}`} />
        <div>
          <strong>{model.modelId || t("common.unknown")}</strong>
          <small>{`${model.backendId} · ${model.providerId}`}</small>
        </div>
        <dl><div><dt>{t("usage.tokens")}</dt><dd>{formatTokens(model.usage.totalTokens, locale)}</dd></div><div><dt>{t("usage.cost")}</dt><dd>{formatSummaryCost(model, locale, t)}</dd></div></dl>
      </article>)}
      {!loading && models.length === 0 && <p className="usage-models__empty">{t("usage.empty")}</p>}
      {loading && <p className="usage-models__empty">{t("common.loading")}</p>}
    </div>
  </section>;
}

function emptySummary(): UsageHistorySummaryView {
  return { usage: emptyUsage(), currencyTotals: [], costComplete: true, estimated: false };
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costMicros: 0, currencyCode: "" } as const;
}

function placeholderDays(count: number): UsageHistoryDayView[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today.getTime() - (count - index - 1) * 86_400_000);
    return { day: date.toISOString().slice(0, 10), usage: emptyUsage(), currencyTotals: [], costComplete: true, estimated: false };
  });
}

function heatLevel(value: number, maximum: number): number {
  if (value <= 0 || maximum <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((Math.log1p(value) / Math.log1p(maximum)) * 4)));
}

function rankedModelKeys(values: readonly ModelUsageHistoryDayView[]): string[] {
  const totals = new Map<string, number>();
  for (const value of values) {
    const key = usageModelKey(value.backendId, value.providerId, value.modelId);
    totals.set(key, (totals.get(key) ?? 0) + value.usage.totalTokens);
  }
  return [...totals].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([key]) => key);
}

function usageModelKey(backendId: string, providerId: string, modelId: string): string {
  return `${backendId}\u0000${providerId}\u0000${modelId}`;
}

function comparableCurrency(values: readonly UsageHistorySummaryView[]): string | undefined {
  const currencies = new Set<string>();
  for (const value of values) {
    if (value.usage.totalTokens === 0) continue;
    if (!value.costComplete || value.currencyTotals.length !== 1 || !value.currencyTotals[0]!.costComplete) return undefined;
    currencies.add(value.currencyTotals[0]!.currencyCode);
  }
  return currencies.size === 1 ? [...currencies][0] : undefined;
}

function comparableCost(value: UsageHistorySummaryView, currency: string): number | undefined {
  if (!value.costComplete) return undefined;
  const total = value.currencyTotals.find((candidate) => candidate.currencyCode === currency);
  return total?.costComplete === true ? total.usage.costMicros : undefined;
}

function summaryPriceKind(summary: UsageHistorySummaryView, t: Translator): string {
  if (!summary.costComplete) return t("usage.priceUnavailable");
  return summary.estimated ? t("usage.estimated") : t("usage.actual");
}

function formatSummaryCost(summary: UsageHistorySummaryView, locale: Locale, t: Translator): string {
  return formatCurrencyTotals(summary.currencyTotals, locale, t);
}

function formatCurrencyTotals(totals: readonly UsageCurrencyTotalView[], locale: Locale, t: Translator): string {
  const complete = totals.filter((total) => total.costComplete);
  if (complete.length === 0) return t("usage.priceUnavailable");
  const values = complete.map((total) => {
    const prefix = total.estimated ? "≈" : "";
    return `${prefix}${new Intl.NumberFormat(normalizedLocale(locale), {
      style: "currency",
      currency: total.currencyCode,
      maximumFractionDigits: 4
    }).format(total.usage.costMicros / 1_000_000)}`;
  });
  return totals.some((total) => !total.costComplete) ? `${values.join(" + ")} + ?` : values.join(" + ");
}

function formatTokens(value: number, locale: Locale): string {
  return new Intl.NumberFormat(normalizedLocale(locale), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDay(day: string, locale: Locale): string {
  return new Intl.DateTimeFormat(normalizedLocale(locale), { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00.000Z`));
}

function normalizedLocale(locale: Locale): string {
  return locale === "en-XA" ? "en" : locale;
}
