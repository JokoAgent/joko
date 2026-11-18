import { capabilityNames } from "@joko/contracts";
import { useId, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import type { Locale, ProviderRuntimeView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Spinner, formatRelativeTime } from "./ui.js";

export function TaskProviderAccountUsage({ controller, runtime, modelId, t }: {
  readonly controller: AppController;
  readonly runtime: ProviderRuntimeView;
  readonly modelId: string;
  readonly t: Translator;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState(0);
  const [readState, setReadState] = useState<"loading" | "ready" | "failed">("loading");
  const regionId = useId();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useLayoutEffect(() => {
    const abort = new AbortController();
    setReadState("loading");
    const deadline = setTimeout(() => { abort.abort(); setReadState("failed"); }, 12_000);
    void controllerRef.current.refreshProviderAccountUsage(runtime.backendId, runtime.id, abort.signal).then(
      () => { if (!abort.signal.aborted) setReadState("ready"); },
      () => { if (!abort.signal.aborted) setReadState("failed"); }
    ).finally(() => clearTimeout(deadline));
    return () => { abort.abort(); clearTimeout(deadline); };
  }, [runtime.backendId, runtime.id, read]);

  const title = t("settings.accountUsage");
  const locale = controller.state.effectiveLocale;
  const usage = runtime.accountUsage;
  const quotaWindow = usage?.modelWindows?.find(entry => entry.modelId === modelId)?.window
    ?? usage?.primaryWindow ?? usage?.secondaryWindow;
  const remaining = quotaWindow !== undefined && Number.isFinite(quotaWindow.usedPercent)
    && (quotaWindow.resetAt === undefined || quotaWindow.resetAt > Date.now())
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.max(0, Math.min(100, 100 - quotaWindow.usedPercent)))
    : undefined;
  const summary = readState === "failed" ? undefined : usage?.limitReached === true ? t("settings.accountLimitReached")
    : remaining === undefined ? undefined : t("settings.providerGroups.remaining", { percent: remaining });
  return <div className="composer-account-usage">
    <Button tone="ghost" aria-label={summary === undefined ? title : `${title} · ${summary}`} aria-expanded={open} aria-controls={regionId} onClick={() => setOpen(value => !value)}>
      {summary ?? title}
    </Button>
    {open && <div id={regionId} role="region" aria-label={title}>
      {readState === "loading" && <Spinner label={t("settings.providerGroups.loading")} />}
      {readState === "failed" || readState === "ready" && usage === undefined
        ? <p role="status">{t("composer.accountUsageUnavailable")}</p>
        : <ProviderAccountUsageDetails runtime={runtime} locale={locale} t={t} />}
      <Button disabled={readState === "loading"} onClick={() => setRead(value => value + 1)}>{t("settings.providerGroups.refresh")}</Button>
    </div>}
  </div>;
}

export function ProviderAccountUsageDetails({ runtime, locale, t }: {
  readonly runtime: ProviderRuntimeView;
  readonly locale: Locale;
  readonly t: Translator;
}): JSX.Element | null {
  const usage = runtime.accountUsage;
  if (!runtime.capabilities.has(capabilityNames.providerAccountUsage) || usage === undefined) return null;
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const buckets = usage.buckets ?? [];
  const windowRows = (buckets.length === 0 ? [
    { key: "primary", label: t("settings.accountUsagePrimary"), window: usage.primaryWindow },
    { key: "secondary", label: t("settings.accountUsageSecondary"), window: usage.secondaryWindow }
  ] : buckets.flatMap((bucket) => [
    { key: `bucket:${bucket.id}:primary`, label: `${bucket.displayName ?? bucket.id} · ${t("settings.accountUsagePrimary")}`, window: bucket.primaryWindow },
    { key: `bucket:${bucket.id}:secondary`, label: `${bucket.displayName ?? bucket.id} · ${t("settings.accountUsageSecondary")}`, window: bucket.secondaryWindow }
  ])).concat((usage.modelWindows ?? []).map((entry, index) => ({
    key: `model:${index}`, label: entry.displayName, window: entry.window
  }))).filter((row) => row.window !== undefined);
  const formatCredits = (credits: typeof usage.credits) => {
    const balance = credits?.balance === undefined ? undefined : t("settings.accountCreditsBalance", { balance: credits.balance });
    const depleted = credits?.unlimited !== true && credits?.hasCredits === false;
    const status = credits?.unlimited === true ? t("settings.accountCreditsUnlimited")
      : depleted ? t("settings.accountCreditsNone")
        : credits?.hasCredits === true && balance === undefined ? t("settings.accountCreditsAvailable") : undefined;
    return { text: [balance, status].filter(Boolean).join(" · "), depleted };
  };
  const creditLabel = formatCredits(usage.credits);
  const observedAt = usage.credits?.observedAt ?? usage.observedAt;
  return <div className="provider-account-usage" role="list" aria-label={t("settings.accountUsage")}>
    {(usage.planType !== undefined || usage.limitReached === true) && <span role="listitem">{[
      usage.planType === undefined ? undefined : t("settings.accountPlan", { plan: usage.planType }),
      usage.limitReached === true ? t("settings.accountLimitReached") : undefined
    ].filter(Boolean).join(" · ")}</span>}
    {windowRows.map((row) => <span role="listitem" key={row.key}>{[
      row.label,
      t("settings.accountUsagePercent", { percent: percent.format(row.window!.usedPercent) }),
      row.window!.windowMinutes === undefined
        ? undefined
        : t("settings.accountUsageWindowMinutes", { minutes: new Intl.NumberFormat(locale).format(row.window!.windowMinutes) }),
      row.window!.resetAt === undefined
        ? undefined
        : t("settings.accountUsageReset", { time: formatRelativeTime(row.window!.resetAt, locale) }),
      row.window!.severity
    ].filter(Boolean).join(" · ")}</span>)}
    {buckets.map((bucket) => {
      const bucketCredits = formatCredits(bucket.credits);
      return <span role="listitem" key={`bucket:${bucket.id}:details`} className={bucketCredits.depleted ? "danger-text" : undefined}>{[
        bucket.displayName ?? bucket.id,
        bucket.planType === undefined ? undefined : t("settings.accountPlan", { plan: bucket.planType }),
        bucket.limitReached === true ? t("settings.accountLimitReached") : undefined,
        bucketCredits.text
      ].filter(Boolean).join(" · ")}</span>;
    })}
    {creditLabel.text && <span role="listitem" className={creditLabel.depleted ? "danger-text" : undefined}>{creditLabel.text}</span>}
    {usage.resetCredits !== undefined && <span role="listitem">{[
      t("settings.accountResetCredits", { count: new Intl.NumberFormat(locale).format(usage.resetCredits.availableCount) }),
      usage.resetCredits.earliestExpiryAt === undefined ? undefined : t("settings.accountResetCreditExpiry", { time: formatRelativeTime(usage.resetCredits.earliestExpiryAt, locale) })
    ].filter(Boolean).join(" · ")}</span>}
    {usage.extraUsage !== undefined && <span role="listitem">{[
      t(usage.extraUsage.enabled ? "settings.accountExtraUsageEnabled" : "settings.accountExtraUsageDisabled"),
      usage.extraUsage.usedPercent === undefined ? undefined : t("settings.accountUsagePercent", { percent: percent.format(usage.extraUsage.usedPercent) }),
      usage.extraUsage.usedCredits === undefined ? undefined : t("settings.accountExtraUsageUsed", { credits: new Intl.NumberFormat(locale).format(usage.extraUsage.usedCredits) }),
      usage.extraUsage.monthlyLimit === undefined ? undefined : t("settings.accountExtraUsageLimit", { credits: new Intl.NumberFormat(locale).format(usage.extraUsage.monthlyLimit) })
    ].filter(Boolean).join(" · ")}</span>}
    {observedAt !== undefined && <span role="listitem">{t("settings.accountUsageObserved", { time: formatRelativeTime(observedAt, locale) })}</span>}
  </div>;
}
