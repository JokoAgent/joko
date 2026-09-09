import { ChevronRight } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { AppController } from "../controller.js";
import { sessionRouteHash } from "../controller.js";
import type { Locale, UsageHistorySummaryView, UsageReportQueryView, UsageReportView } from "../model.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";
import "./usage-history.css";

type Range = "all" | "30" | "7" | "today" | "custom";
interface Filters { range: Range; from: string; through: string; backendId: string; providerId: string; modelId: string; sessionId: string; group: UsageReportQueryView["group"] }
const defaults: Filters = { range: "30", from: "", through: "", backendId: "", providerId: "", modelId: "", sessionId: "", group: "task" };
interface ReportPage { readonly pageToken: string; readonly value: UsageReportView }

export function UsageHistorySection({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element {
  const owner = `${controller.state.activeProfile?.serverId ?? ""}\u0000${controller.state.activeProfile?.id ?? ""}`;
  return <UsageHistoryContent key={owner} api={controller.getUsageReport} connected={controller.state.connectionState === "connected"}
    locale={controller.state.preferences.locale} t={t} />;
}

export function UsageHistoryContent({ api, connected, locale, t }: {
  readonly api: AppController["getUsageReport"]; readonly connected: boolean; readonly locale: Locale; readonly t: Translator;
}): JSX.Element {
  const [filters, setFilters] = useState<Filters>(defaults);
  const [query, setQuery] = useState<UsageReportQueryView>(() => makeQuery(defaults));
  const [load, setLoad] = useState({ api, pageToken: "", revision: 0 });
  const [result, setResult] = useState<{ query: UsageReportQueryView; api: typeof api; pages: readonly ReportPage[] }>();
  const [error, setError] = useState<{ readonly message?: string }>();
  const [pending, setPending] = useState(false);
  const rangeErrorId = useId();
  const request = useRef<AbortController | undefined>(undefined);
  const summaryRefs = useRef(new Map<string, HTMLElement>());
  const resultScopeRef = useRef<HTMLDivElement>(null);
  const requestFocus = useRef<{ load: object; trigger: HTMLButtonElement; knownKeys?: ReadonlySet<string> } | undefined>(undefined);
  const completedFocus = useRef<{ load: object; api: typeof api; query: UsageReportQueryView; signal: AbortSignal; trigger: HTMLButtonElement; key?: string } | undefined>(undefined);
  const visibleResult = result?.api === api ? result : undefined;
  const lastPage = visibleResult?.pages.at(-1)?.value;
  const report = lastPage === undefined ? undefined : { ...lastPage, entries: visibleResult!.pages.flatMap((page) => page.value.entries) };
  const showingPrevious = visibleResult !== undefined && visibleResult.query !== query;
  const shownQuery = visibleResult?.query ?? query;
  const invalidRange = filters.range === "custom" && filters.from !== "" && filters.through !== "" && filters.from > filters.through;
  const unapplied = JSON.stringify(makeQuery(filters)) !== JSON.stringify(query);
  useLayoutEffect(() => {
    const focus = completedFocus.current;
    if (focus === undefined) return;
    completedFocus.current = undefined;
    if (!connected || focus.signal.aborted || focus.api !== api || focus.query !== query || focus.load !== load) return;
    const summary = focus.key === undefined ? resultScopeRef.current : summaryRefs.current.get(focus.key);
    const ownerDocument = focus.trigger.ownerDocument;
    if (summary?.isConnected !== true || summary.ownerDocument !== ownerDocument || ownerDocument.defaultView?.closed === true) return;
    if (ownerDocument.activeElement !== focus.trigger && (focus.trigger.isConnected || ownerDocument.activeElement !== ownerDocument.body)) return;
    summary.focus();
  }, [api, connected, load, query, result]);
  useEffect(() => { setResult((previous) => previous?.api === api ? previous : undefined); setError(undefined); }, [api]);
  useEffect(() => {
    if (!connected) { setPending(false); return; }
    const abort = new AbortController();
    request.current = abort;
    setPending(true);
    const pageToken = load.api === api ? load.pageToken : "";
    void api({ ...query, ...(pageToken === "" ? {} : { pageToken }) }, abort.signal).then((value) => {
      if (abort.signal.aborted) return;
      const focus = requestFocus.current;
      const firstNewEntry = focus?.load === load ? value.entries.find((entry) => !focus.knownKeys?.has(entry.key)) : undefined;
      if (focus?.load === load && (firstNewEntry !== undefined || focus.knownKeys === undefined) && focus.trigger.ownerDocument.activeElement === focus.trigger) {
        completedFocus.current = { load, api, query, signal: abort.signal, trigger: focus.trigger, ...(firstNewEntry === undefined ? {} : { key: firstNewEntry.key }) };
      }
      if (focus?.load === load) requestFocus.current = undefined;
      setError(undefined);
      setResult((previous) => {
        const pages = pageToken !== "" && previous?.query === query && previous.api === api ? previous.pages : [];
        const replaced = pages.findIndex((page) => page.pageToken === pageToken);
        return { query, api, pages: [...(replaced < 0 ? pages : pages.slice(0, replaced)), { pageToken, value }] };
      });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? { message: cause.message } : {});
    }).finally(() => { if (!abort.signal.aborted) setPending(false); });
    return () => {
      abort.abort();
      if (requestFocus.current?.load === load) requestFocus.current = undefined;
    };
  }, [api, connected, load, query]);
  const apply = (next: Filters): void => {
    if (!connected || next.range === "custom" && next.from !== "" && next.through !== "" && next.from > next.through) return;
    request.current?.abort(); setError(undefined); setLoad({ api, pageToken: "", revision: 0 }); setQuery(makeQuery(next));
  };
  const reload = (): void => { if (connected) { request.current?.abort(); setLoad((value) => ({ api, pageToken: "", revision: value.revision + 1 })); } };
  const retry = (trigger: HTMLButtonElement): void => {
    if (!connected || pending) return;
    const nextLoad = { api, pageToken: load.api === api ? load.pageToken : "", revision: load.revision + 1 };
    requestFocus.current = trigger.ownerDocument.activeElement === trigger ? { load: nextLoad, trigger } : undefined;
    request.current?.abort(); setLoad(nextLoad);
  };
  return <section className="usage-history-section" aria-label={t("usage.title")}>
    <header><div><h2>{t("usage.title")}</h2><p>{t("usage.report.body")}</p></div><Button disabled={!connected || pending} onClick={reload}>{t("usage.refresh")}</Button></header>
    <form className="usage-history-filters" onSubmit={(event) => { event.preventDefault(); apply(filters); }}>
      <label>{t("usage.report.range")}<select value={filters.range} onChange={(event) => setFilters({ ...filters, range: event.target.value as Range })}>
        {(["all", "30", "7", "today", "custom"] as const).map((value) => <option key={value} value={value}>{t(`usage.report.range.${value}`)}</option>)}
      </select></label>
      {filters.range === "custom" && <>
        <label>{t("usage.report.from")}<input type="date" value={filters.from} max={filters.through || undefined} aria-invalid={invalidRange} aria-describedby={invalidRange ? rangeErrorId : undefined} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label>{t("usage.report.through")}<input type="date" value={filters.through} min={filters.from || undefined} aria-invalid={invalidRange} aria-describedby={invalidRange ? rangeErrorId : undefined} onChange={(event) => setFilters({ ...filters, through: event.target.value })} /></label>
      </>}
      {(["backendId", "providerId", "modelId", "sessionId"] as const).map((field) => <label key={field}>{t(`usage.report.${field}`)}
        <input value={filters[field]} maxLength={field === "modelId" || field === "providerId" ? 512 : 256} placeholder={t("usage.report.any")}
          onChange={(event) => setFilters({ ...filters, [field]: event.target.value })} />
      </label>)}
      <label>{t("usage.report.group")}<select value={filters.group} onChange={(event) => setFilters({ ...filters, group: event.target.value as Filters["group"] })}>
        {(["task", "model", "provider", "backend"] as const).map((group) => <option key={group} value={group}>{t(`usage.report.group.${group}`)}</option>)}
      </select></label>
      <div className="usage-history-filters__actions"><Button type="submit" disabled={!connected || invalidRange}>{t("usage.report.apply")}</Button>
        <Button disabled={!connected} onClick={() => { setFilters(defaults); apply(defaults); }}>{t("usage.report.reset")}</Button></div>
      {invalidRange ? <p id={rangeErrorId} className="usage-history-filters__hint" role="alert">{t("usage.report.invalidRange")}</p>
        : unapplied && <p className="usage-history-filters__hint" role="status">{t("usage.report.pendingFilters")}</p>}
    </form>
    {!connected && <p role="status">{t("usage.report.disconnected")}</p>}
    {error !== undefined && <div role="alert"><p>{error.message ?? t("usage.loadFailed")}</p><Button className="usage-history-retry" disabled={!connected} aria-disabled={!connected || pending} onClick={(event) => retry(event.currentTarget)}>{t("common.retry")}</Button></div>}
    <div aria-busy={pending}>
      {pending && <p role="status">{t("common.loading")}</p>}
      {report !== undefined && <>
        {showingPrevious && <p role="status">{t("usage.report.previousResult")}</p>}
        <div ref={resultScopeRef} className="usage-history-scope" tabIndex={-1} role="region" aria-label={t("usage.title")}><strong>{t(`usage.report.group.${shownQuery.group}`)}</strong>
          <span>{shownQuery.fromDay === undefined && shownQuery.throughDay === undefined ? t("usage.report.range.all")
            : `${t("usage.report.from")}: ${shownQuery.fromDay ?? t("usage.report.any")} · ${t("usage.report.through")}: ${shownQuery.throughDay ?? t("usage.report.any")}`}</span>
          {(["backendId", "providerId", "modelId", "sessionId"] as const).filter((field) => shownQuery[field] !== undefined).map((field) => <span key={field}>{t(`usage.report.${field}`)}: {shownQuery[field]}</span>)}
        </div>
        <div className="usage-history-summary"><strong>{t("usage.report.total", { count: report.totalGroups })}</strong><span>{formatNumber(report.summary.usage.totalTokens, locale)} {t("usage.tokens")}</span><span>{formatCost(report.summary, locale, t)}</span></div>
        {report.entries.length === 0 && <p>{t("usage.report.empty")}</p>}
        <div className="usage-history-entries">{report.entries.map((entry) => <details key={entry.key}>
          <summary ref={(node) => { if (node === null) summaryRefs.current.delete(entry.key); else summaryRefs.current.set(entry.key, node); }} tabIndex={0}><ChevronRight className="usage-history-entry__disclosure" aria-hidden="true" /><span><strong>{shownQuery.group === "task" ? entry.title || entry.sessionId : shownQuery.group === "model" ? entry.modelId || t("common.unknown") : shownQuery.group === "provider" ? entry.providerId || t("common.unknown") : entry.backendId}</strong>
            <small>{shownQuery.group === "task" ? entry.sessionId : [entry.backendId, shownQuery.group === "model" ? entry.providerId : ""].filter(Boolean).join(" · ")}</small></span>
            <span>{formatNumber(entry.summary.usage.totalTokens, locale)} {t("usage.tokens")}<small>{formatCost(entry.summary, locale, t)}</small></span>
          </summary>
          <div className="usage-history-entry__detail"><dl>{([
            ["input", entry.summary.usage.inputTokens], ["output", entry.summary.usage.outputTokens],
            ["cacheRead", entry.summary.usage.cacheReadTokens], ["cacheWrite", entry.summary.usage.cacheWriteTokens]
          ] as const).map(([key, value]) => <div key={key}><dt>{t(`context.${key}`)}</dt><dd>{formatNumber(value, locale)}</dd></div>)}</dl>
            <p>{t("usage.report.observed", { time: new Intl.DateTimeFormat(locale === "en-XA" ? "en" : locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(entry.measuredAt) })}</p>
            {entry.sessionId !== "" && (entry.referenceAvailable
              ? <a href={sessionRouteHash({ kind: "session", sessionId: entry.sessionId })}>{t("usage.report.openTask")}</a>
              : <p>{t("usage.report.taskUnavailable")}</p>)}
          </div>
        </details>)}</div>
        {report.nextPageToken !== "" && <Button className="usage-history-more" disabled={!connected || error !== undefined || showingPrevious} aria-disabled={pending || !connected || error !== undefined || showingPrevious} onClick={(event) => {
          if (!connected || pending || error !== undefined || showingPrevious) return;
          const nextLoad = { api, pageToken: report.nextPageToken, revision: load.revision + 1 };
          requestFocus.current = event.currentTarget.ownerDocument.activeElement === event.currentTarget
            ? { load: nextLoad, trigger: event.currentTarget, knownKeys: new Set(report.entries.map((entry) => entry.key)) } : undefined;
          request.current?.abort(); setLoad(nextLoad);
        }}>{t("common.more")}</Button>}
      </>}
    </div>
  </section>;
}

function makeQuery(filters: Filters): UsageReportQueryView {
  const today = new Date().toISOString().slice(0, 10);
  const days = filters.range === "today" ? 1 : Number(filters.range);
  const fromDay = filters.range === "custom" ? filters.from : filters.range === "all" ? ""
    : new Date(Date.parse(`${today}T00:00:00.000Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const throughDay = filters.range === "custom" ? filters.through : filters.range === "all" ? "" : today;
  return { group: filters.group, ...(fromDay === "" ? {} : { fromDay }), ...(throughDay === "" ? {} : { throughDay }),
    ...Object.fromEntries((["backendId", "providerId", "modelId", "sessionId"] as const)
      .filter((key) => filters[key].trim() !== "").map((key) => [key, filters[key].trim()])) };
}

function formatNumber(value: number, locale: Locale): string { return new Intl.NumberFormat(locale === "en-XA" ? "en" : locale).format(value); }
function formatCost(summary: UsageHistorySummaryView, locale: Locale, t: Translator): string {
  if (summary.currencyTotals.length === 0) return t("usage.priceUnavailable");
  return summary.currencyTotals.map((total) => !total.costComplete ? `${total.currencyCode}: ${t("usage.priceUnavailable")}`
    : `${total.estimated ? "≈" : ""}${new Intl.NumberFormat(locale === "en-XA" ? "en" : locale, { style: "currency", currency: total.currencyCode, maximumFractionDigits: 4 }).format(total.usage.costMicros / 1_000_000)}`).join(" + ");
}
