import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, parseProviderAccountResetSettings, providerAccountResetChinese, providerAccountResetEnglish,
  ProviderAccountResetAvailability, ProviderAccountResetOutcome, type ProviderAccountResetApi, type ProviderAccountResetOffer,
  type ProviderAccountResetSettingsValue, type ProviderAccountResetState } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileUsageTimestamp } from "./mobile-account-usage";

export function MobileAccountResets(props: { readonly api: ProviderAccountResetApi; readonly backendId: string; readonly providerId: string;
  readonly locale: MobileSupportedLocale; readonly colors: { readonly ink: string; readonly muted: string; readonly border: string } }) {
  return <ResetControls key={`${props.api.ownerKey}:${props.backendId}:${props.providerId}`} {...props} />;
}
function ResetControls({ api, backendId, providerId, locale, colors }: Parameters<typeof MobileAccountResets>[0]) {
  const [state, setState] = useState<ProviderAccountResetState>(), [read, setRead] = useState(0), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [actionFailed, setActionFailed] = useState(false), [invalid, setInvalid] = useState(false);
  const [outcome, setOutcome] = useState<ProviderAccountResetOutcome>(), [days, setDays] = useState("3");
  const [settings, setSettings] = useState<ProviderAccountResetSettingsValue>(DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS);
  const currentApi = useRef(api); currentApi.current = api;
  const currentState = useRef(state); currentState.current = state;
  const lifetime = useRef(new AbortController());
  const confirming = useRef(false);
  const copy = locale === "zh-CN" ? providerAccountResetChinese : providerAccountResetEnglish;
  const t = (key: keyof typeof copy, values: Record<string, string | number> = {}) => {
    let text: string = copy[key]; for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value)); return text;
  };
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => owner.abort(); }, []);
  useEffect(() => {
    const abort = new AbortController(); let live = true; setLoading(true); setFailed(false); const timer = setTimeout(() => abort.abort(), 30_000);
    void currentApi.current.read(backendId, providerId, abort.signal).then(value => { if (live) setState(value); })
      .catch(() => { if (live) setFailed(true); }).finally(() => { clearTimeout(timer); if (live) setLoading(false); });
    return () => { live = false; clearTimeout(timer); abort.abort(); };
  }, [backendId, providerId, read]);
  useEffect(() => {
    const value = state?.automaticSettings; if (!value) return;
    setSettings({ enabled: value.enabled, lowQuota: value.lowQuota, minimumDays: value.minimumDays, expiring: value.expiring, expiryMinutes: value.expiryMinutes });
    setDays(String(value.minimumDays)); setInvalid(false); setOutcome(undefined);
  }, [state?.accountKey, state?.settingsRevision?.value]);
  const update = (patch: Partial<ProviderAccountResetSettingsValue>) => setSettings(value => {
    const next = { ...value, ...patch }; return !next.lowQuota && !next.expiring ? { ...next, enabled: false } : next;
  });
  const action = async (offer?: ProviderAccountResetOffer, restore = false) => {
    if (!state || busy || lifetime.current.signal.aborted) return;
    let value: ProviderAccountResetSettingsValue | null = null;
    if (!offer && !restore) {
      try { if (!/^\d{1,3}$/u.test(days)) throw new Error(); value = parseProviderAccountResetSettings({ ...settings, minimumDays: Number(days) }); }
      catch { setInvalid(true); return; }
    }
    const account = state.accountKey, current = () => !lifetime.current.signal.aborted && currentState.current?.accountKey === account;
    setBusy(true); setActionFailed(false); setInvalid(false);
    try {
      if (offer) { const receipt = await currentApi.current.consume(state, offer, lifetime.current.signal); if (current()) setOutcome(receipt.outcome); }
      else await currentApi.current.save(state, value, lifetime.current.signal);
      if (current()) setRead(count => count + 1);
    } catch { if (current()) { setActionFailed(true); if (offer) setRead(count => count + 1); } }
    finally { if (current()) setBusy(false); }
  };
  const ready = state?.availability === ProviderAccountResetAvailability.AVAILABLE, disabled = busy || loading || failed || !ready;
  const note = (text: string, alert = false) => <Text accessibilityRole={alert ? "alert" : undefined} style={{ color: colors.muted }}>{text}</Text>;
  const time = (value: Parameters<typeof mobileUsageTimestamp>[0]) => { const at = mobileUsageTimestamp(value); return at === undefined ? "—" : new Date(at).toLocaleString(locale); };
  const button = (label: string, onPress: () => void, blocked = disabled) => <Pressable accessibilityRole="button" accessibilityState={{ disabled: blocked }} disabled={blocked}
    onPress={onPress} style={[styles.button, { borderColor: colors.border, opacity: blocked ? 0.5 : 1 }]}><Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const offerButton = (offer: ProviderAccountResetOffer) => button(t(offer.retryOnly ? "accountReset.retry" : "accountReset.use"), () => {
    if (!state || confirming.current || lifetime.current.signal.aborted) return;
    const accountKey = state.accountKey; confirming.current = true;
    Alert.alert(t(offer.retryOnly ? "accountReset.confirmRetry" : "accountReset.confirm"),
      t(offer.retryOnly ? "accountReset.confirmRetryBody" : "accountReset.confirmBody", { account: state.accountLabel,
        credit: state.credits.find(credit => credit.offer?.offerId === offer.offerId)?.title || t("accountReset.credit"), expiry: time(offer.expiresAt) }),
      [{ text: t("accountReset.cancel"), style: "cancel", onPress: () => { confirming.current = false; } },
        { text: t(offer.retryOnly ? "accountReset.retry" : "accountReset.use"), onPress: () => {
          confirming.current = false; const current = currentState.current;
          if (!lifetime.current.signal.aborted && current?.accountKey === accountKey
            && [current.defaultOffer, ...current.credits.map(credit => credit.offer)].some(value => value?.offerId === offer.offerId)) void action(offer);
        } }], { cancelable: true, onDismiss: () => { confirming.current = false; } });
  });
  const toggle = (key: "enabled" | "lowQuota" | "expiring", label: string) => <View style={styles.toggle}><Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
    <Switch accessibilityLabel={label} value={settings[key]} disabled={disabled || key === "enabled" && !settings.lowQuota && !settings.expiring} onValueChange={value => update({ [key]: value })} /></View>;
  const outcomes = { [ProviderAccountResetOutcome.RESET]: "accountReset.outcome.reset", [ProviderAccountResetOutcome.NOTHING_TO_RESET]: "accountReset.outcome.nothingToReset",
    [ProviderAccountResetOutcome.NO_CREDIT]: "accountReset.outcome.noCredit", [ProviderAccountResetOutcome.ALREADY_REDEEMED]: "accountReset.outcome.alreadyRedeemed" } as const;
  return <View style={[styles.card, { borderColor: colors.border }]} accessibilityLabel={t("accountReset.title")}>
    <Text style={[styles.title, { color: colors.ink }]}>{t("accountReset.title")}</Text>{loading && note(t("accountReset.reading"))}
    {(failed || actionFailed) && note(t("accountReset.failed"), true)}{invalid && note(t("accountReset.invalid"), true)}
    {outcome !== undefined && outcome !== ProviderAccountResetOutcome.UNSPECIFIED && note(t(outcomes[outcome]))}
    {state && !ready && note(t(state.availability === ProviderAccountResetAvailability.UNSUPPORTED ? "accountReset.unsupported" : "accountReset.unavailable"))}
    {ready && state && <>
      {note(t("accountReset.account", { account: state.accountLabel }))}{note(state.availableCount === undefined ? t("accountReset.unknownCount") : t("accountReset.count", { count: state.availableCount }))}
      {state.defaultOffer?.retryOnly && note(t("accountReset.pending"))}
      {state.defaultOffer && (!state.detailsAvailable || state.defaultOffer.retryOnly) && offerButton(state.defaultOffer)}
      {state.credits.map((credit, index) => <View key={credit.offer?.offerId ?? index} style={styles.credit}>
        <Text style={{ color: colors.ink }}>{credit.title || t("accountReset.credit")}</Text>{note(t("accountReset.granted", { time: time(credit.grantedAt) }))}
        {credit.expiresAt && note(t("accountReset.expires", { time: time(credit.expiresAt) }))}{credit.offer && offerButton(credit.offer)}
      </View>)}
      <Text style={[styles.title, { color: colors.ink }]}>{t("accountReset.automatic")}</Text>{note(t("accountReset.help"))}
      {toggle("enabled", t("accountReset.enabled"))}{toggle("lowQuota", t("accountReset.lowQuota"))}
      <Text style={{ color: colors.ink }}>{t("accountReset.minimumDays")}</Text><TextInput accessibilityLabel={t("accountReset.minimumDays")} value={days}
        editable={!disabled} keyboardType="number-pad" maxLength={3} onChangeText={setDays} style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
      {toggle("expiring", t("accountReset.expiring"))}<Text style={{ color: colors.ink }}>{t("accountReset.expiryMinutes")}</Text>
      <View style={styles.options}>{[30, 60, 360, 1440].map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`${t("accountReset.expiryMinutes")}: ${value}`}
        accessibilityState={{ selected: settings.expiryMinutes === value, disabled }} disabled={disabled} onPress={() => update({ expiryMinutes: value })}
        style={[styles.button, { borderColor: colors.border, borderWidth: settings.expiryMinutes === value ? 2 : 1 }]}><Text style={{ color: colors.ink }}>{new Intl.NumberFormat(locale).format(value)}</Text></Pressable>)}</View>
      {button(t("accountReset.save"), () => { void action(); })}{button(t("accountReset.defaults"), () => { void action(undefined, true); })}
      {state.customized && note(t("accountReset.customized"))}{state.lastAutomaticUse && note(t("accountReset.lastUsed", { time: time(state.lastAutomaticUse) }))}
    </>}
    {button(t("accountReset.refresh"), () => setRead(value => value + 1), busy || loading)}
  </View>;
}
const styles = StyleSheet.create({ card: { gap: 10, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth }, title: { fontSize: 14, fontWeight: "700" },
  credit: { gap: 6 }, button: { minHeight: 44, padding: 10, borderWidth: 1, borderRadius: 8, justifyContent: "center" },
  toggle: { flexDirection: "row", alignItems: "center", gap: 10 }, label: { flex: 1 }, input: { minHeight: 44, borderWidth: 1, borderRadius: 8, padding: 10 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 } });
