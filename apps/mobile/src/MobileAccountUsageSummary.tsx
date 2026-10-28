import { StyleSheet, Text, View } from "react-native";
import type { ProviderAccountUsageSnapshot } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileAccountUsageStale, mobileAccountUsageWindows, mobileUsageTimestamp } from "./mobile-account-usage";
import { mobileAccountUsageCopy } from "./mobile-account-usage-messages";
import { MobileModelQuotaBar } from "./MobileModelQuotaBar";

export function mobileModelAccountQuotaLabel(snapshot: ProviderAccountUsageSnapshot | undefined, modelId: string, now: number, locale: MobileSupportedLocale, failed = false): string | undefined {
  if (!snapshot) return undefined;
  const rows = mobileAccountUsageWindows(snapshot, modelId, now).filter(row => row.model);
  if (!rows.length) return undefined;
  const copy = mobileAccountUsageCopy(locale);
  const text = rows.map(row => copy.remaining.replace("{percent}", new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(row.remainingPercent))).join(" · ");
  return failed || mobileAccountUsageStale(snapshot, now) ? `${copy.stale} · ${text}` : text;
}

export function MobileAccountUsageSummary({ snapshot, modelId, providerName, loading = false, failed = false, now, colors, locale }: {
  readonly snapshot?: ProviderAccountUsageSnapshot;
  readonly modelId?: string;
  readonly providerName?: string;
  readonly loading?: boolean;
  readonly failed?: boolean;
  readonly now: number;
  readonly colors: { readonly ink: string; readonly muted: string; readonly border: string; readonly negative?: string };
  readonly locale: MobileSupportedLocale;
}) {
  const copy = mobileAccountUsageCopy(locale);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const time = (value: number): string => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(value);
  const windows = snapshot ? mobileAccountUsageWindows(snapshot, modelId, now) : [];
  const observedAt = mobileUsageTimestamp(snapshot?.observedAt);
  const stale = failed || snapshot !== undefined && mobileAccountUsageStale(snapshot, now);
  const extra = snapshot?.extraUsage;
  const credits = snapshot?.credits;
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
    {credits && <Text style={[styles.note, { color: colors.muted }]}>{copy.credits} · {credits.unlimited === true ? copy.unlimited
      : credits.balance !== undefined ? credits.balance.slice(0, 128) : credits.hasCredits === true ? copy.available : credits.hasCredits === false ? copy.none : "—"}</Text>}
    {hasResetCredits && <Text style={[styles.note, { color: colors.muted }]}>{copy.resetCredits.replace("{count}", number.format(resetCredits.availableCount))}
      {expiry === undefined ? "" : ` · ${copy.expiry.replace("{time}", time(expiry))}`}</Text>}
    {!snapshot && <Text style={[styles.note, { color: colors.muted }]}>{loading && !failed ? copy.reading : copy.unavailable}</Text>}
    {snapshot && windows.length === 0 && !extra && !credits && !hasResetCredits
      && <Text style={[styles.note, { color: colors.muted }]}>{copy.unavailable}</Text>}
    {snapshot && <Text style={[styles.note, { color: colors.muted }]}>{stale ? `${copy.stale} · ` : ""}
      {observedAt === undefined ? copy.freshness : copy.observed.replace("{time}", time(observedAt))}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  card: { gap: 6, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth }, title: { fontSize: 14, fontWeight: "700" },
  row: { gap: 2 }, label: { fontSize: 13 }, value: { fontSize: 14, fontWeight: "600" }, note: { fontSize: 12, lineHeight: 17 }
});
