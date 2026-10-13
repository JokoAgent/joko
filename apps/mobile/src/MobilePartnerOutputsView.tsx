import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobilePartnerProfileSnapshot, MobilePartnerProfileTransport } from "./mobile-partner-profile";
import type { MobilePartnerTaskOutput, MobilePartnerTaskOutputs } from "./mobile-partner-task-outputs";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobilePartnerOutputsView({ snapshot, transport, online, foreground, colors, locale, onOpen }: {
  readonly snapshot: MobilePartnerProfileSnapshot;
  readonly transport: MobilePartnerProfileTransport;
  readonly online: boolean;
  readonly foreground: boolean;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly onOpen: (row: MobilePartnerTaskOutput) => void;
}) {
  const scope = `${transport.ownerKey}\u001f${snapshot.partner.partnerId}\u001f${snapshot.partner.canonicalSessionId}`;
  const context = useRef({ snapshot, transport }); context.current = { snapshot, transport };
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ readonly scope?: string; readonly phase: "loading" | "ready" | "error";
    readonly catalog?: MobilePartnerTaskOutputs }>({ phase: "loading" });
  useEffect(() => {
    if (!online || !foreground) return;
    const request = new AbortController(), current = context.current;
    setState(previous => ({ scope, phase: "loading", catalog: previous.scope === scope ? previous.catalog : undefined }));
    void current.transport.listOutputs!(current.snapshot, request.signal).then(catalog => {
      if (request.signal.aborted) return;
      if (catalog.partnerId !== current.snapshot.partner.partnerId) throw new Error("Output owner changed.");
      setState({ scope, phase: "ready", catalog });
    }).catch(() => { if (!request.signal.aborted) setState(previous => ({ ...previous, scope, phase: "error" })); });
    return () => request.abort();
  }, [scope, online, foreground, attempt]);
  const catalog = state.scope === scope ? state.catalog : undefined;
  const phase = state.scope === scope ? state.phase : "loading";
  const rows = catalog?.rows.filter(row => row.readiness !== "ready" || row.files.length > 0) ?? [];
  const active = online && foreground;
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(locale, key);
  const action = (label: string, press: () => void, disabled: boolean) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={press}
    style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  return <View testID="partnerProfile.outputs" style={styles.content}>
    {!online && <Text style={[styles.note, { color: colors.muted }]}>{t("partnerOutputs.offline")}</Text>}
    {active && phase === "loading" && <View style={styles.loading}><ActivityIndicator color={colors.accent} />
      <Text accessibilityLiveRegion="polite" style={[styles.note, { color: colors.muted }]}>{t("partnerOutputs.loading")}</Text></View>}
    {phase === "error" && <View accessibilityRole="alert" style={styles.content}>
      <Text style={[styles.note, { color: colors.negative }]}>{t("partnerOutputs.failed")}</Text>
      {action(t("common.retry"), () => setAttempt(value => value + 1), !active)}
    </View>}
    {rows.map(row => <View key={`${row.kind}:${row.id}`} style={[styles.row, { borderColor: colors.border }]}>
      <Text selectable style={[styles.title, { color: colors.ink }]}>{row.title}</Text>
      {row.files.map(file => <View key={`${file.status}:${file.path}`} style={styles.file}>
        <Text selectable style={[styles.body, { color: colors.ink }]}>{file.path}</Text>
        <Text style={[styles.note, { color: colors.muted }]}>{t(`partnerOutputs.${file.status}`)}</Text>
      </View>)}
      {row.readiness !== "ready" && <Text accessibilityLiveRegion="polite" style={[styles.note, { color: colors.muted }]}>
        {t(row.readiness === "pending" ? "partnerOutputs.pending" : "partnerOutputs.unavailable")}</Text>}
      {row.truncated && <Text style={[styles.note, { color: colors.muted }]}>{t("partnerOutputs.filesTruncated")}</Text>}
      {row.sessionId && row.readiness === "ready" && row.files.length > 0 && action(t("partnerOutputs.openSource"), () => onOpen(row), !active || phase !== "ready")}
    </View>)}
    {active && phase === "ready" && rows.length === 0 && <Text style={[styles.note, { color: colors.muted }]}>{t("partnerOutputs.empty")}</Text>}
    {catalog?.truncated && <Text style={[styles.note, { color: colors.muted }]}>{t("partnerOutputs.rowsTruncated")}</Text>}
    {phase === "ready" && action(t("partnerOutputs.refresh"), () => setAttempt(value => value + 1), !active)}
  </View>;
}

const styles = StyleSheet.create({
  content: { gap: 12 }, row: { gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  file: { gap: 3 }, title: { fontSize: 16, lineHeight: 23, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 22 }, note: { fontSize: 14, lineHeight: 20 },
  loading: { flexDirection: "row", gap: 10, alignItems: "center" },
  action: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderRadius: 12,
    alignItems: "center", justifyContent: "center" }, disabled: { opacity: 0.45 }
});
