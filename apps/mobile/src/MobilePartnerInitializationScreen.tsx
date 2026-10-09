import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnerInitializationTransport } from "./mobile-partner-initialization";

interface InitializationState {
  readonly binding?: string;
  readonly partner?: MobilePartnerDirectoryProfile;
  readonly loading: boolean;
  readonly error?: "read" | "retry" | "open";
}

export function MobilePartnerInitializationScreen({ partnerId, transport, colors, locale, onBack, onOpenTask }: {
  readonly partnerId: string;
  readonly transport?: MobilePartnerInitializationTransport;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly onBack: () => void;
  readonly onOpenTask: (sessionId: string) => void;
}) {
  const binding = transport ? `${transport.ownerKey}\u001f${partnerId}` : undefined;
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const transportRef = useRef(transport); transportRef.current = transport;
  const requestRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const flightRef = useRef(false);
  const attemptedOpenRef = useRef(false);
  const [state, setState] = useState<InitializationState>({ binding, loading: true });
  const [busy, setBusy] = useState(false);
  const current = binding !== undefined && state.binding === binding;
  const partner = current ? state.partner : undefined;
  const error = current ? state.error : undefined;

  const run = (kind: "read" | "retry" | "open"): void => {
    const active = transportRef.current; const expected = bindingRef.current;
    if (!active || !expected || flightRef.current || kind !== "read" && !partner) return;
    if (kind === "retry" && (partner?.initializationState !== "error" || error)) return;
    const controller = new AbortController(); requestRef.current = controller;
    const generation = ++generationRef.current;
    const valid = (): boolean => !controller.signal.aborted && bindingRef.current === expected
      && generationRef.current === generation;
    flightRef.current = true;
    setBusy(true);
    if (kind === "open") attemptedOpenRef.current = true;
    else attemptedOpenRef.current = false;
    if (kind === "read") setState((previous) => ({ binding: expected,
      ...(previous.binding === expected && previous.partner ? { partner: previous.partner } : {}), loading: true }));
    else setState((previous) => ({ ...previous, error: undefined }));
    const work = kind === "open" ? active.open(partner!, controller.signal).then((result) => {
      if (valid()) onOpenTask(result.sessionId);
    }) : (kind === "retry" ? active.retry(partner!, controller.signal) : active.load(partnerId, controller.signal)).then((next) => {
      if (!valid()) return;
      if (next.partnerId !== partnerId || next.lifecycle !== "active") throw new Error("Initialization profile mismatch.");
      setState({ binding: expected, partner: next, loading: false });
    });
    void work.catch(() => {
      if (valid()) setState((previous) => ({ ...previous, binding: expected, loading: false, error: kind }));
    }).finally(() => {
      if (valid()) { flightRef.current = false; setBusy(false); }
    });
  };

  useEffect(() => {
    bindingRef.current = binding;
    flightRef.current = false; attemptedOpenRef.current = false;
    setBusy(false); setState({ binding, loading: true }); run("read");
    return () => { generationRef.current += 1; requestRef.current?.abort(); };
  }, [binding]);
  useEffect(() => {
    if (!current || !partner || busy || state.loading || error) return;
    if (partner.initializationState === "ready") { if (!attemptedOpenRef.current) run("open"); return; }
    if (partner.initializationState !== "pending") return;
    const timer = setTimeout(() => run("read"), 2_500);
    return () => clearTimeout(timer);
  }, [binding, state, busy]);

  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  return <View style={[styles.screen, { backgroundColor: colors.background }]} testID="partnerInitialization.screen">
    <View style={styles.header}>
      {action(mobileMessage(locale, "common.back"), onBack)}
      <Text accessibilityRole="header" style={[styles.title, styles.grow, { color: colors.ink }]}>
        {mobileMessage(locale, "partnerInitialization.title")}
      </Text>
      {action(mobileMessage(locale, "common.refresh"), () => run("read"), !binding || busy || current && state.loading)}
    </View>
    <View style={styles.center}>
      {!binding ? <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "partnerInitialization.offline")}</Text>
        : !partner ? <>
          {error ? <><Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>
            {mobileMessage(locale, "partnerInitialization.readFailed")}</Text>
            {action(mobileMessage(locale, "common.retry"), () => run("read"))}</>
            : <><ActivityIndicator color={colors.muted} /><Text style={[styles.body, { color: colors.muted }]}>
              {mobileMessage(locale, "partnerInitialization.loading")}</Text></>}
        </> : <>
          <MobilePartnerAvatar preset={partner.avatar} colors={colors} />
          <Text style={[styles.title, styles.centered, { color: colors.ink }]}>{mobileMessage(locale,
            "partnerInitialization.waiting", { name: partner.displayName })}</Text>
          <Text style={[styles.body, styles.centered, { color: colors.muted }]}>{mobileMessage(locale,
            partner.initializationState === "error" ? "partnerInitialization.failed" : "partnerInitialization.background")}</Text>
          {partner.initializationState === "error" ? <>
            {partner.initializationErrorCode && <Text style={[styles.body, styles.centered, { color: colors.muted }]}>
              {mobileMessage(locale, `partnerInitialization.reason.${partner.initializationErrorCode}`)}</Text>}
            {action(mobileMessage(locale, "partnerInitialization.retry"), () => run("retry"), busy || state.loading || !!error)}
          </> : <View accessibilityLiveRegion="polite" style={styles.stage}>
            {(!error || state.loading) && <ActivityIndicator color={colors.muted} />}
            <Text style={[styles.body, { color: colors.ink }]}>{mobileMessage(locale,
              `partnerInitialization.stage.${partner.invitationStage === "failed" ? "home" : partner.invitationStage}`)}</Text>
          </View>}
          {busy && partner.initializationState === "error" && <ActivityIndicator color={colors.muted} />}
          {error && <View accessibilityRole="alert" style={styles.notice}>
            <Text style={[styles.body, styles.centered, { color: colors.negative }]}>{mobileMessage(locale,
              error === "retry" ? "partnerInitialization.retryFailed" : error === "open"
                ? "partnerInitialization.openFailed" : "partnerInitialization.readFailed")}</Text>
            {action(mobileMessage(locale, "common.refresh"), () => run("read"), busy || state.loading)}
          </View>}
        </>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingTop: 12 }, grow: { flex: 1, minWidth: 0 },
  header: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 },
  title: { fontSize: 20, lineHeight: 28, fontWeight: "600" }, body: { fontSize: 15, lineHeight: 22 },
  center: { flex: 1, gap: 18, alignItems: "center", justifyContent: "center", padding: 24 },
  centered: { textAlign: "center" }, stage: { flexDirection: "row", alignItems: "center", gap: 10 },
  notice: { alignItems: "center", gap: 14 }, action: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" }, disabled: { opacity: 0.45 }
});
