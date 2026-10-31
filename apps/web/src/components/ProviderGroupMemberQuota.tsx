import { useEffect, useId, useState } from "react";
import type { ProviderAccountUsageSnapshot, ProviderAccountUsageWindow, ProviderGroupMember, GetProviderGroupMemberAccountUsageResponse } from "@joko/contracts";
import { ProviderGroupMemberKind } from "@joko/contracts";
import type { ProviderGroupSettingsApi } from "../provider-group-settings.js";
import type { ProviderGroupSettingsTranslator } from "./ProviderGroupSettings.js";
import { Button, Spinner } from "./ui.js";

export function ProviderGroupMemberQuota({ api, group, revision, member, available, t }: {
  readonly api: ProviderGroupSettingsApi; readonly group: { readonly backendId: string; readonly providerId: string };
  readonly revision: bigint; readonly member: ProviderGroupMember; readonly available: boolean; readonly t: ProviderGroupSettingsTranslator;
}) {
  const [open, setOpen] = useState(false), id = useId();
  return <div className="provider-group-settings__quota">
    <Button aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t("settings.providerGroups.accountQuota")}</Button>
    {open && <div id={id} role="region" aria-label={`${t("settings.providerGroups.accountQuota")} ${member.displayName}`}>
      {member.kind === ProviderGroupMemberKind.SHARE ? <p>{t("settings.providerGroups.quotaShared")}</p>
        : !available ? <p>{t("settings.providerGroups.quotaOffline")}</p>
          : <MemberQuotaRead key={`${group.backendId}:${group.providerId}:${revision}:${member.key}`} api={api} group={group} revision={revision} memberKey={member.key} t={t} />}
    </div>}
  </div>;
}
function MemberQuotaRead({ api, group, revision, memberKey, t }: { readonly api: ProviderGroupSettingsApi;
  readonly group: { readonly backendId: string; readonly providerId: string }; readonly revision: bigint; readonly memberKey: string; readonly t: ProviderGroupSettingsTranslator }) {
  const [result, setResult] = useState<GetProviderGroupMemberAccountUsageResponse>(), [failed, setFailed] = useState(false), [read, setRead] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let live = true;
    setResult(undefined); setFailed(false);
    const timer = setTimeout(() => { if (live) { setFailed(true); abort.abort(); } }, 8_000);
    void api.getProviderGroupMemberAccountUsage({ key: group, expectedRevision: revision, memberKey }, abort.signal)
      .then(value => { if (live && !abort.signal.aborted) setResult(value); })
      .catch(() => { if (live && !abort.signal.aborted) setFailed(true); })
      .finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); abort.abort(); };
  }, [api, group.backendId, group.providerId, revision, memberKey, read]);
  if (failed) return <><p role="alert">{t("settings.providerGroups.loadFailed")}</p><Button onClick={() => setRead(value => value + 1)}>{t("settings.providerGroups.refresh")}</Button></>;
  if (!result) return <Spinner label={t("settings.providerGroups.loading")} />;
  if (result.state !== "ready" || !result.accountUsage) return <p>{t(`settings.providerGroups.${result.state === "shared" ? "quotaShared" : result.state === "offline" ? "quotaOffline" : "quotaUnsupported"}`)}</p>;
  return <><AccountQuota usage={result.accountUsage} t={t} /><Button onClick={() => setRead(value => value + 1)}>{t("settings.providerGroups.refresh")}</Button></>;
}
function AccountQuota({ usage, t }: { readonly usage: ProviderAccountUsageSnapshot; readonly t: ProviderGroupSettingsTranslator }) {
  const time = (value: ProviderAccountUsageSnapshot["observedAt"]) => value ? new Date(Number(value.seconds) * 1000 + value.nanos / 1_000_000).toLocaleString() : undefined;
  const window = (label: string, value: ProviderAccountUsageWindow | undefined, key = label) => value && <div key={key}><dt>{label}</dt><dd>{t("settings.providerGroups.remaining", { percent: Math.max(0, Math.min(100, 100 - value.usedPercent)).toFixed(1) })}
    {value.windowMinutes !== undefined && <> · {t("settings.providerGroups.windowMinutes", { minutes: value.windowMinutes })}</>}
    {value.resetAt && <> · {t("settings.providerGroups.resets", { time: time(value.resetAt)! })}</>}{value.severity && <> · {value.severity}</>}</dd></div>;
  const credits = (value: ProviderAccountUsageSnapshot["credits"]) => value?.unlimited ? t("settings.providerGroups.unlimited") : value?.balance
    ?? (value?.hasCredits === true ? t("settings.providerGroups.creditsAvailable") : value?.hasCredits === false ? t("settings.providerGroups.creditsNone") : undefined);
  return <dl>
    {usage.planType && <div><dt>{t("settings.providerGroups.provider")}</dt><dd>{usage.planType}</dd></div>}
    {usage.limitReached && <div><dt>{t("settings.providerGroups.accountQuota")}</dt><dd>{t("settings.providerGroups.quotaExhausted")}</dd></div>}
    {window(t("settings.providerGroups.primaryWindow"), usage.primaryWindow)}{window(t("settings.providerGroups.secondaryWindow"), usage.secondaryWindow)}
    {usage.modelWindows.map((entry, index) => window(entry.displayName, entry.window, `model:${index}`))}
    {usage.buckets.map(bucket => <div key={`bucket:${bucket.id}`}><dt>{bucket.displayName ?? bucket.id}</dt><dd><dl>
      {bucket.planType && <div><dt>{t("settings.providerGroups.provider")}</dt><dd>{bucket.planType}</dd></div>}
      {bucket.limitReached && <div><dt>{t("settings.providerGroups.accountQuota")}</dt><dd>{t("settings.providerGroups.quotaExhausted")}</dd></div>}
      {window(t("settings.providerGroups.primaryWindow"), bucket.primaryWindow)}{window(t("settings.providerGroups.secondaryWindow"), bucket.secondaryWindow)}
      {credits(bucket.credits) !== undefined && <div><dt>{t("settings.providerGroups.credits")}</dt><dd>{credits(bucket.credits)}</dd></div>}
    </dl></dd></div>)}
    {credits(usage.credits) !== undefined && <div><dt>{t("settings.providerGroups.credits")}</dt><dd>{credits(usage.credits)}</dd></div>}
    {usage.extraUsage && <div><dt>{t("settings.providerGroups.extraUsage")}</dt><dd>{!usage.extraUsage.enabled ? t("settings.providerGroups.extraDisabled") : usage.extraUsage.usedPercent === undefined ? "—" : `${usage.extraUsage.usedPercent}%`}
      {usage.extraUsage.usedCredits !== undefined && <> · {usage.extraUsage.usedCredits}{usage.extraUsage.monthlyLimit === undefined ? "" : ` / ${usage.extraUsage.monthlyLimit}`}</>}</dd></div>}
    {usage.resetCredits && <div><dt>{t("settings.providerGroups.resetCredits")}</dt><dd>{usage.resetCredits.availableCount}
      {usage.resetCredits.earliestExpiryAt && <> · {t("settings.providerGroups.resets", { time: time(usage.resetCredits.earliestExpiryAt)! })}</>}</dd></div>}
    {usage.observedAt && <div><dt>{t("settings.providerGroups.observed")}</dt><dd>{time(usage.observedAt)}</dd></div>}
  </dl>;
}
