import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { partnerResumeMessages, type PartnerResumeEditor } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export function MobilePartnerResumeSheet({ editor, colors, locale, onClose, onChanged, onBusyChange }: {
  readonly editor: PartnerResumeEditor; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale;
  readonly onClose: () => void; readonly onChanged: () => void; readonly onBusyChange?: (busy: boolean) => void;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const current = useRef({ onChanged, onBusyChange }); current.current = { onChanged, onBusyChange };
  const notified = useRef<bigint | undefined>(undefined); const m = partnerResumeMessages(locale);
  useEffect(() => {
    if (AppState.currentState === "active") editor.activate(); else editor.suspend();
    const listener = AppState.addEventListener("change", value => {
      setForeground(value === "active"); if (value === "active") editor.activate(); else editor.suspend();
    });
    return () => { listener.remove(); editor.dispose(); current.current.onBusyChange?.(false); };
  }, [editor]);
  useEffect(() => { current.current.onBusyChange?.(foreground && editor.busy); }, [foreground, state.phase]);
  useEffect(() => { if (foreground && state.phase === "completed" && state.profile && notified.current !== state.profile.revision) {
    notified.current = state.profile.revision; current.current.onChanged();
  } }, [foreground, state]);
  const close = () => { if (!foreground || !editor.busy) onClose(); };
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{label}</Text></Pressable>;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={close}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <View style={styles.header}>{action(m.close, close, foreground && editor.busy)}<Text accessibilityRole="header"
        style={[styles.title, { color: colors.ink }]}>{m.title.replace("{name}", foreground ? state.profile?.displayName ?? editor.initial.displayName : "")}</Text></View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.body, { color: colors.muted }]}>{m.body}</Text>
        {foreground && editor.busy && <ActivityIndicator color={colors.accent} />}
        <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.ink }]}>{state.phase === "loading" ? m.loading
          : state.phase === "resuming" ? m.working : state.phase === "completed" ? m.completed : state.phase === "suspended" ? m.suspended
            : state.profile?.pauseCleanupPending ? m.cleanup : state.profile?.lifecycle === "paused" ? m.paused : ""}</Text>
        {state.error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>{m[state.error]}</Text>}
        {state.phase !== "completed" && <View style={styles.content}>
          {action(m.refresh, () => void editor.refresh(), !foreground || editor.busy)}
          {action(m.action, () => void editor.resume(), !foreground || !editor.available)}
        </View>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({ screen: { flex: 1 }, header: { minHeight: 60, paddingHorizontal: 16,
  flexDirection: "row", alignItems: "center", gap: 12 }, title: { flex: 1, fontSize: 18, lineHeight: 26, fontWeight: "600" },
  content: { gap: 12, padding: 16 }, body: { fontSize: 15, lineHeight: 22 }, action: { minHeight: 44,
    paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.45 } });
