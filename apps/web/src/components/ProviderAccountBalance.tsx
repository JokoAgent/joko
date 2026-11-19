import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ProviderAccountBalanceResult, ProviderAccountUsageWindow } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ProviderRuntimeView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Spinner } from "./ui.js";

const BALANCE_POLL_INTERVAL_MS = 60_000;

export function ProviderAccountBalance({ controller, runtime, t }: { readonly controller: AppController; readonly runtime: ProviderRuntimeView; readonly t: Translator }) {
  const [open, setOpen] = useState(false), id = useId();
  if (!runtime.capabilities.has("provider.account_balance") || !controller.readProviderAccountBalance) return null;
  const { activeProfile, connectionGeneration } = controller.state;
  const ownerKey = JSON.stringify([activeProfile?.id, activeProfile?.serverId, activeProfile?.origin, connectionGeneration,
    runtime.backendId, runtime.id, runtime.accountBalanceRevision]);
  return <div className="provider-account-balance"><Button aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t("balance.title")}</Button>
    {open && <div id={id} role="region" aria-label={t("balance.title")}><BalanceRead key={ownerKey} controller={controller} runtime={runtime} t={t} /></div>}
  </div>;
}
function BalanceRead({ controller, runtime, t }: { readonly controller: AppController; readonly runtime: ProviderRuntimeView; readonly t: Translator }) {
  const [result, setResult] = useState<ProviderAccountBalanceResult>();
  const [request, setRequest] = useState({ force: false });
  const [failed, setFailed] = useState(false), [loading, setLoading] = useState(false);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useLayoutEffect(() => {
    const abort = new AbortController();
    let nextRead: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      setLoading(false);
      nextRead = setTimeout(() => setRequest({ force: false }), BALANCE_POLL_INTERVAL_MS);
    };
    setLoading(true);
    const deadline = setTimeout(() => {
      abort.abort();
      setFailed(true);
      finish();
    }, 12_000);
    void controllerRef.current.readProviderAccountBalance!(runtime.backendId, runtime.id, request.force, abort.signal)
      .then(value => {
        if (abort.signal.aborted) return;
        setResult(value);
        setFailed(false);
      })
      .catch(() => { if (!abort.signal.aborted) setFailed(true); })
      .finally(() => {
        clearTimeout(deadline);
        if (!abort.signal.aborted) finish();
      });
    return () => { clearTimeout(deadline); clearTimeout(nextRead); abort.abort(); };
  }, [request, runtime.backendId, runtime.id]);
  const snapshot = result?.snapshot, error = result?.error;
  const knownErrors = new Set(["no-credentials", "auth", "rate-limited", "network", "server", "invalid-response", "throttled"]);
  const time = (value: ProviderAccountBalanceResult["observedAt"]) => value ? new Date(Number(value.seconds) * 1000 + value.nanos / 1_000_000).toLocaleString(controller.state.effectiveLocale) : "—";
  const window = (label: string, value: ProviderAccountUsageWindow | undefined) => value && <div><dt>{label}</dt><dd>{t("settings.providerGroups.remaining", { percent: Math.max(0, Math.min(100, 100 - value.usedPercent)).toFixed(1) })}{value.resetAt && <> · {time(value.resetAt)}</>}</dd></div>;
  return <>
    {loading && <Spinner label={t("settings.providerGroups.loading")} />}
    {(failed || error) && <p role="alert">{t(`balance.error.${error && knownErrors.has(error) ? error as "auth" : "network"}`)}</p>}
    {result?.status === "unsupported" && <p>{t("balance.unsupported")}</p>}
    {(result?.stale || failed && snapshot !== undefined) && <p>{t("balance.stale")}</p>}
    {result?.retryAt && <p>{t("balance.retryAt", { time: time(result.retryAt) })}</p>}
    {snapshot?.case === "deepseek" && <>
      {!snapshot.value.isAvailable && <p>{t("balance.unavailable")}</p>}
      <dl>{snapshot.value.balances.map((line, index) => <div key={`${line.currency}:${index}`}><dt>{line.currency}</dt><dd>{t("balance.total", { amount: line.totalBalance })}</dd><dd>{t("balance.granted", { amount: line.grantedBalance })}</dd><dd>{t("balance.toppedUp", { amount: line.toppedUpBalance })}</dd></div>)}</dl>
    </>}
    {snapshot?.case === "zhipu" && <>
      {snapshot.value.noPlan ? <p>{t("balance.noPlan")}</p> : <dl>
        {snapshot.value.level && <div><dt>{t("settings.providerGroups.provider")}</dt><dd>{snapshot.value.level}</dd></div>}
        {window(t("balance.fiveHour"), snapshot.value.fiveHour)}{window(t("balance.weekly"), snapshot.value.weekly)}
      </dl>}
    </>}
    {result?.observedAt && <p>{t("balance.observed", { time: time(result.observedAt) })}</p>}
    {result?.dashboardUrl && trustedDashboard(result.dashboardUrl) && <a href={result.dashboardUrl} target="_blank" rel="noopener noreferrer">{t("balance.dashboard")}</a>}
    <Button disabled={loading} onClick={() => setRequest({ force: true })}>{t("settings.providerGroups.refresh")}</Button>
  </>;
}
function trustedDashboard(value: string): boolean { return ["https://platform.deepseek.com/usage", "https://www.bigmodel.cn/coding-plan/personal/usage", "https://z.ai/manage-apikey/coding-plan/personal/my-plan"].includes(value); }
