import { useEffect } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage, type MobileMessageKey } from "./mobile-messages";
import type {
  MobileUpdateControllerState,
  MobileUpdateManualOutcome
} from "./mobile-update-controller";
import type { MobileUpdateChannel, MobileUpdateRelease } from "./mobile-update";

export interface MobileUpdateSurfaceColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
  readonly brandBackground: string;
}

export interface MobileUpdateActions {
  readonly onChannelChange: (channel: MobileUpdateChannel) => Promise<void>;
  readonly onCheck: () => Promise<void>;
  readonly onReset: () => Promise<void>;
  readonly onDismissPrompt: () => void;
  readonly onOpenUpdate: (target: MobileUpdateRelease) => Promise<void>;
  readonly onRecheckForced: () => Promise<void>;
}

export function MobileUpdateSettingsSection({ colors, locale, state, actions }: {
  readonly colors: MobileUpdateSurfaceColors;
  readonly locale: MobileSupportedLocale;
  readonly state: MobileUpdateControllerState;
  readonly actions: Pick<MobileUpdateActions, "onChannelChange" | "onCheck" | "onReset">;
}) {
  const t = (key: MobileMessageKey): string => mobileMessage(locale, key);
  const source = state.running.isEmergencyLaunch
    ? t("settings.updates.source.emergency")
    : !state.running.isEnabled && !state.authorityAvailable
      ? t("settings.updates.source.disabled")
      : state.running.isEmbeddedLaunch || !state.running.isEnabled
        ? t("settings.updates.source.embedded")
        : t("settings.updates.source.ota");
  const busy = state.manualPhase !== "idle" || state.channelSaving || state.status === "loading";
  const checkLabel = t(state.manualPhase === "checking" ? "settings.updates.checking"
    : state.manualPhase === "downloading" ? "settings.updates.downloading"
      : state.manualPhase === "reloading" ? "settings.updates.restarting" : "settings.updates.check");
  const outcome = state.manualOutcome ? manualOutcomeMessage(state.manualOutcome) : undefined;
  return <View>
    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.updates.title")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.description, { color: colors.muted }]}>{t("settings.updates.description")}</Text>
      <UpdateInformationRow label={t("settings.updates.source")} value={source} colors={colors} />
      <UpdateInformationRow label={t("settings.updates.appVersion")}
        value={state.running.appVersion || t("common.unknown")} colors={colors} />
      <UpdateInformationRow label={t("settings.updates.runtime")}
        value={state.running.runtimeVersion || "—"} colors={colors} />
      <UpdateInformationRow label={t("settings.updates.updateId")}
        value={state.running.updateId?.slice(0, 8) || "—"} colors={colors} />
      <UpdateInformationRow label={t("settings.updates.updatedAt")}
        value={state.running.createdAt ? formatUpdateTime(state.running.createdAt) : "—"} colors={colors} />
    </View>

    <Text style={[styles.subsection, { color: colors.muted }]}>{t("settings.updates.channel")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ChannelChoice channel="stable" selected={state.channel === "stable"} disabled={busy}
        colors={colors} locale={locale} onPress={() => void actions.onChannelChange("stable").catch(() => undefined)} />
      {state.betaEnabled && <ChannelChoice channel="beta" selected={state.channel === "beta"} disabled={busy}
        colors={colors} locale={locale} onPress={() => void actions.onChannelChange("beta").catch(() => undefined)} />}
    </View>

    <View style={styles.actionRow}>
      <UpdateButton label={checkLabel} colors={colors} disabled={busy || state.status !== "ready"}
        onPress={() => void actions.onCheck().catch(() => undefined)} />
      {state.status === "error" && <UpdateButton label={t("settings.updates.reset")} colors={colors}
        disabled={state.channelSaving} onPress={() => void actions.onReset().catch(() => undefined)} />}
    </View>
    {(outcome || state.pendingRestart) && <Text accessibilityLiveRegion="polite"
      style={[styles.notice, { color: colors.ink, backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>
      {t(outcome ?? "settings.updates.pendingRestart")}
    </Text>}
    {!state.authorityAvailable && !outcome && <Text accessibilityLiveRegion="polite"
      style={[styles.notice, { color: colors.ink, backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>
      {t("settings.updates.outcome.unavailable")}
    </Text>}
    {state.status === "error" && <UpdateError text={t("settings.updates.storageError")} colors={colors} />}
    {state.actionError === "configuration" && <UpdateError text={t("settings.updates.configurationError")} colors={colors} />}
    {state.actionError === "channel" && <UpdateError text={t("settings.updates.channelError")} colors={colors} />}
  </View>;
}

export function MobileUpdatePrompt({ colors, locale, state, actions }: {
  readonly colors: MobileUpdateSurfaceColors;
  readonly locale: MobileSupportedLocale;
  readonly state: MobileUpdateControllerState;
  readonly actions: Pick<MobileUpdateActions, "onDismissPrompt" | "onOpenUpdate">;
}) {
  const target = state.prompt;
  useEffect(() => {
    if (!target || state.forced) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      actions.onDismissPrompt();
      return true;
    });
    return () => subscription.remove();
  }, [actions, state.forced, target]);
  if (!target || state.forced) return null;
  const t = (key: MobileMessageKey, variables?: Readonly<Record<string, string | number>>): string =>
    mobileMessage(locale, key, variables);
  return <View accessibilityViewIsModal accessibilityRole="alert"
    style={[styles.overlay, { backgroundColor: "rgba(0,0,0,0.48)" }]}>
    <View style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.ink }]}>{t("updates.prompt.title")}</Text>
      <Text style={[styles.description, { color: colors.muted }]}>
        {t("updates.prompt.description", { version: target.version })}
      </Text>
      {target.releaseNotes && <View style={styles.notes}>
        <Text style={[styles.label, { color: colors.ink }]}>{t("updates.prompt.releaseNotes")}</Text>
        <Text numberOfLines={8} ellipsizeMode="tail"
          style={[styles.description, { color: colors.muted }]}>{target.releaseNotes}</Text>
      </View>}
      {state.actionError === "install" && <UpdateError text={t("settings.updates.installError")} colors={colors} />}
      <View style={styles.actionRow}>
        <UpdateButton label={t("updates.prompt.later")} colors={colors} secondary
          onPress={actions.onDismissPrompt} />
        <UpdateButton label={t("updates.prompt.install")} colors={colors}
          onPress={() => void actions.onOpenUpdate(target).catch(() => undefined)} />
      </View>
    </View>
  </View>;
}

export function MobileForcedUpdateGate({ colors, locale, state, foreground, actions }: {
  readonly colors: MobileUpdateSurfaceColors;
  readonly locale: MobileSupportedLocale;
  readonly state: MobileUpdateControllerState;
  readonly foreground: boolean;
  readonly actions: Pick<MobileUpdateActions, "onOpenUpdate" | "onRecheckForced">;
}) {
  const target = state.forced;
  useEffect(() => {
    if (!target) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [target]);
  useEffect(() => {
    if (!target || !foreground) return;
    const timer = setInterval(() => void actions.onRecheckForced().catch(() => undefined), 30_000);
    return () => clearInterval(timer);
  }, [actions, foreground, target]);
  if (!target) return null;
  const t = (key: MobileMessageKey, variables?: Readonly<Record<string, string | number>>): string =>
    mobileMessage(locale, key, variables);
  return <View accessibilityViewIsModal style={[styles.gate, { backgroundColor: colors.background }]}>
    <View style={[styles.gateCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.brand, { color: colors.accent }]}>Joko</Text>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{t("updates.forced.title")}</Text>
      <Text style={[styles.description, { color: colors.muted }]}>
        {t("updates.forced.description", { version: target.version })}
      </Text>
      {target.releaseNotes && <View style={styles.notes}>
        <Text style={[styles.label, { color: colors.ink }]}>{t("updates.prompt.releaseNotes")}</Text>
        <Text numberOfLines={8} ellipsizeMode="tail"
          style={[styles.description, { color: colors.muted }]}>{target.releaseNotes}</Text>
      </View>}
      {state.forcedCheckFailed && <UpdateError text={t("updates.forced.checkFailed")} colors={colors} />}
      {state.actionError === "install" && <UpdateError text={t("settings.updates.installError")} colors={colors} />}
      <UpdateButton label={t("updates.prompt.install")} colors={colors}
        onPress={() => void actions.onOpenUpdate(target).catch(() => undefined)} />
      <UpdateButton label={t(state.forcedChecking ? "updates.forced.checking" : "updates.forced.checkAgain")}
        colors={colors} secondary disabled={state.forcedChecking}
        onPress={() => void actions.onRecheckForced().catch(() => undefined)} />
    </View>
  </View>;
}

function ChannelChoice({ channel, selected, disabled, colors, locale, onPress }: {
  readonly channel: MobileUpdateChannel;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly colors: MobileUpdateSurfaceColors;
  readonly locale: MobileSupportedLocale;
  readonly onPress: () => void;
}) {
  const label = mobileMessage(locale, channel === "stable"
    ? "settings.updates.channel.stable" : "settings.updates.channel.beta");
  const description = mobileMessage(locale, channel === "stable"
    ? "settings.updates.channel.stableDescription" : "settings.updates.channel.betaDescription");
  return <Pressable accessibilityRole="radio" accessibilityLabel={label}
    accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={[styles.choice, disabled && styles.disabled]}>
    <View style={[styles.radio, { borderColor: selected ? colors.accent : colors.border }]}>
      {selected && <View style={[styles.radioDot, { backgroundColor: colors.accent }]} />}
    </View>
    <View style={styles.fill}>
      <Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{description}</Text>
    </View>
  </Pressable>;
}

function UpdateInformationRow({ label, value, colors }: {
  readonly label: string;
  readonly value: string;
  readonly colors: MobileUpdateSurfaceColors;
}) {
  return <View style={styles.infoRow}>
    <Text style={[styles.infoLabel, { color: colors.muted }]}>{label}</Text>
    <Text selectable style={[styles.infoValue, { color: colors.ink }]}>{value}</Text>
  </View>;
}

function UpdateButton({ label, disabled, secondary, colors, onPress }: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly secondary?: boolean;
  readonly colors: MobileUpdateSurfaceColors;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={[styles.button, { backgroundColor: disabled ? colors.border : secondary ? colors.surface : colors.accent,
      borderColor: secondary ? colors.border : colors.accent }]}>
    <Text style={[styles.buttonText, { color: disabled ? colors.muted : secondary ? colors.ink : "#2b2316" }]}>{label}</Text>
  </Pressable>;
}

function UpdateError({ text, colors }: { readonly text: string; readonly colors: MobileUpdateSurfaceColors }) {
  return <Text accessibilityRole="alert" style={[styles.error, { color: colors.negative }]}>{text}</Text>;
}

function manualOutcomeMessage(outcome: MobileUpdateManualOutcome): MobileMessageKey {
  if (outcome === "up-to-date") return "settings.updates.outcome.upToDate";
  if (outcome === "unavailable") return "settings.updates.outcome.unavailable";
  if (outcome === "update-available") return "settings.updates.outcome.updateAvailable";
  if (outcome === "restart-required" || outcome === "reloading") return "settings.updates.outcome.restartRequired";
  if (outcome === "reload-blocked") return "settings.updates.outcome.reloadBlocked";
  if (outcome === "busy") return "settings.updates.outcome.busy";
  return "settings.updates.outcome.error";
}

function formatUpdateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  section: { marginTop: 24, marginBottom: 8, fontSize: 13, fontWeight: "700", textTransform: "uppercase" },
  subsection: { marginTop: 12, marginBottom: 8, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  description: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  infoRow: { minHeight: 38, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 4 },
  infoLabel: { width: 112, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  infoValue: { flex: 1, fontSize: 14, lineHeight: 20 },
  choice: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  radio: { width: 22, height: 22, borderWidth: 2, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  disabled: { opacity: 0.55 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 12 },
  button: { minHeight: 48, minWidth: 120, borderWidth: 1, borderRadius: 12, paddingHorizontal: 18,
    paddingVertical: 10, alignItems: "center", justifyContent: "center", flexGrow: 1 },
  buttonText: { fontSize: 15, fontWeight: "700", textAlign: "center" },
  notice: { borderWidth: 1, borderRadius: 12, marginTop: 10, padding: 12, fontSize: 14, lineHeight: 20 },
  error: { marginTop: 10, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  overlay: { position: "absolute", inset: 0, zIndex: 50, alignItems: "center", justifyContent: "center", padding: 24 },
  dialog: { width: "100%", maxWidth: 520, borderWidth: 1, borderRadius: 20, padding: 20, gap: 12 },
  gate: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  gateCard: { width: "100%", maxWidth: 540, borderWidth: 1, borderRadius: 22, padding: 24, gap: 14 },
  brand: { fontSize: 18, lineHeight: 22, fontWeight: "800", letterSpacing: 0.5 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "800" },
  notes: { gap: 5, paddingVertical: 4 }
});
