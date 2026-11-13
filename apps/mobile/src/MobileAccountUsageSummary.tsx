import { StyleSheet, Text, View } from "react-native";
import { ModelSourceKind, type ProviderAccountUsageSnapshot } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileModelRoute } from "./mobile-runtime-controls";
import { mobileAccountUsageStale, mobileAccountUsageWindows, mobileCodexWeeklyUsageWindow, mobileExactModelUsageWindows, mobileUsageTimestamp } from "./mobile-account-usage";
import { mobileAccountUsageCopy } from "./mobile-account-usage-messages";
import { MobileModelQuotaBar } from "./MobileModelQuotaBar";
import { MobileAccountResets } from "./MobileAccountResets";

const quotaTimeUnits = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000], ["second", 1000]] as const;

export function mobileModelAccountQuota(snapshot: ProviderAccountUsageSnapshot | undefined,
  route: Pick<MobileModelRoute, "modelId" | "providerId" | "source">, now: number, locale: MobileSupportedLocale, failed: boolean) {
  if (!snapshot || snapshot.providerId !== route.providerId) return undefined;
  const weekly = route.source?.kind === ModelSourceKind.LOCAL && route.source.nativeAdapterKind === "codex"
    ? mobileCodexWeeklyUsageWindow(snapshot, route.modelId, now) : undefined;
  const windows = weekly ? [weekly] : mobileExactModelUsageWindows(snapshot, route.modelId, now);
  if (!windows.length) return undefined;
  const copy = mobileAccountUsageCopy(locale);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const parts = windows.map(row => copy.remaining.replace("{percent}", number.format(row.remainingPercent)));
  if (weekly?.resetAt !== undefined && weekly.minutes !== undefined) {
    const remaining = Math.min(weekly.resetAt - now, weekly.minutes * 60_000);
    const [unit, millis] = quotaTimeUnits.find(([, size]) => remaining >= size) ?? quotaTimeUnits[3];
    const time = `${number.format(Math.ceil(remaining / millis))}${copy.resetUnits[unit]}`;
    parts.push(copy.resetIn.replace("{time}", time));
  }
  if (failed || mobileAccountUsageStale(snapshot, now)) parts.unshift(copy.stale);
  return { label: parts.join(" · "), windows, weekly: weekly !== undefined };
}

export function MobileModelAccountQuota({ quota, colors, showLabel = true }: {
  readonly quota: ReturnType<typeof mobileModelAccountQuota>;
  readonly colors: { readonly muted: string; readonly border: string };
  readonly showLabel?: boolean;
}) {
  if (!quota) return null;
  return <>
    {showLabel && <Text style={[styles.modelQuota, { color: colors.muted }]}>{quota.label}</Text>}
    {quota.windows.map(row => <MobileModelQuotaBar key={row.id} remaining={row.remainingPercent} label={quota.label} colors={colors} />)}
  </>;
}

export function MobileAccountUsageSummary({ snapshot, modelId, modelScope, providerName, loading = false, failed = false, now, colors, locale, reset }: {
  readonly snapshot?: ProviderAccountUsageSnapshot;
  readonly modelId?: string;
  readonly modelScope?: "claude-family";
  readonly providerName?: string;
  readonly loading?: boolean;
  readonly failed?: boolean;
  readonly now: number;
  readonly colors: { readonly ink: string; readonly muted: string; readonly border: string; readonly negative?: string };
  readonly locale: MobileSupportedLocale;
  readonly reset?: { readonly api: import("@joko/contracts").ProviderAccountResetApi; readonly backendId: string; readonly providerId: string };
}) {
  const copy = mobileAccountUsageCopy(locale);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const time = (value: number): string => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(value);
  const windows = snapshot ? mobileAccountUsageWindows(snapshot, modelId, now, modelScope) : [];
  const observedAt = mobileUsageTimestamp(snapshot?.observedAt);
  const stale = failed || snapshot !== undefined && mobileAccountUsageStale(snapshot, now);
  const extra = snapshot?.extraUsage;
  const credits = snapshot?.credits;
  const creditBalance = credits?.balance?.slice(0, 128);
  const creditsDepleted = credits?.unlimited !== true && credits?.hasCredits === false;
  const creditStatus = credits?.unlimited === true ? copy.unlimited : creditsDepleted ? copy.none
    : credits?.hasCredits === true && creditBalance === undefined ? copy.available : undefined;
  const resetCredits = snapshot?.resetCredits;
  const expiry = mobileUsageTimestamp(resetCredits?.earliestExpiryAt);
  const hasResetCredits = resetCredits && Number.isInteger(resetCredits.availableCount) && resetCredits.availableCount >= 0
    && (expiry === undefined || expiry > now);
  const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  return <View accessibilityLabel={copy.title} style={[styles.card, { borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.ink }]}>{copy.title}{providerName ? ` · ${providerName}` : ""}</Text>
    {snapshot?.planType && <Text style={[styles.note, { color: colors.muted }]}>{copy.plan.replace("{plan}", snapshot.planType.slice(0, 512))}</Text>}
    {windows.map(row => <View key={row.id} style={styles.row}>
      <Text style={[styles.label, { color: colors.ink }]}>{[row.label,
        row.minutes === undefined ? row.id.endsWith("secondary") ? copy.secondary : copy.primary
          : copy.minutes.replace("{minutes}", number.format(row.minutes))].filter(Boolean).join(" · ")}</Text>
      <Text style={[styles.value, { color: row.remainingPercent === 0 ? colors.negative ?? colors.ink : colors.ink }]}>
        {copy.remaining.replace("{percent}", number.format(row.remainingPercent))}
      </Text>
      <MobileModelQuotaBar remaining={row.remainingPercent} label={copy.remaining.replace("{percent}", number.format(row.remainingPercent))} colors={colors} />
      {row.resetAt !== undefined && <Text style={[styles.note, { color: colors.muted }]}>{copy.reset.replace("{time}", time(row.resetAt))}</Text>}
    </View>)}
    {snapshot?.limitReached === true && <Text style={[styles.note, { color: colors.negative ?? colors.ink }]}>{copy.exhausted}</Text>}
    {extra && <View style={styles.row}>
      <Text style={[styles.label, { color: colors.ink }]}>{copy.extra} · {extra.enabled ? copy.enabled : copy.disabled}</Text>
      {known(extra.usedPercent) && extra.usedPercent <= 100 && <Text style={[styles.value, { color: colors.ink }]}>{copy.remaining.replace("{percent}", number.format(100 - extra.usedPercent))}</Text>}
      {known(extra.usedCredits) && known(extra.monthlyLimit) && <Text style={[styles.note, { color: colors.muted }]}>
        {copy.reportedCredits.replace("{used}", number.format(extra.usedCredits)).replace("{limit}", number.format(extra.monthlyLimit))}
      </Text>}
    </View>}
    {credits && <Text style={[styles.note, { color: creditsDepleted ? colors.negative ?? colors.ink : colors.muted }]}>
      {copy.credits} · {[creditBalance, creditStatus].filter(Boolean).join(" · ") || "—"}
    </Text>}
    {hasResetCredits && !reset && <Text style={[styles.note, { color: colors.muted }]}>{copy.resetCredits.replace("{count}", number.format(resetCredits.availableCount))}
      {expiry === undefined ? "" : ` · ${copy.expiry.replace("{time}", time(expiry))}`}</Text>}
    {!snapshot && <Text style={[styles.note, { color: colors.muted }]}>{loading && !failed ? copy.reading : copy.unavailable}</Text>}
    {snapshot && windows.length === 0 && !extra && !credits && !hasResetCredits
      && <Text style={[styles.note, { color: colors.muted }]}>{copy.unavailable}</Text>}
    {snapshot && <Text style={[styles.note, { color: colors.muted }]}>{stale ? `${copy.stale} · ` : ""}
      {observedAt === undefined ? copy.freshness : copy.observed.replace("{time}", time(observedAt))}</Text>}
    {reset && <MobileAccountResets {...reset} colors={colors} locale={locale} />}
  </View>;
}

const styles = StyleSheet.create({
  card: { gap: 6, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth }, title: { fontSize: 14, fontWeight: "700" },
  row: { gap: 2 }, label: { fontSize: 13 }, value: { fontSize: 14, fontWeight: "600" }, note: { fontSize: 12, lineHeight: 17 },
  modelQuota: { fontSize: 13, lineHeight: 18 }
});
