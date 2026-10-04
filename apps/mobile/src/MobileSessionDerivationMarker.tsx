import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileSessionOriginControls } from "./mobile-session-origin";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobileSessionDerivationMarker({ controls, busy, colors, locale, onOpen }: {
  readonly controls?: MobileSessionOriginControls; readonly busy: boolean;
  readonly colors: { readonly muted: string; readonly border: string; readonly accent: string };
  readonly locale: MobileSupportedLocale;
  readonly onOpen: (authorityKey: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const key = controls?.authorityKey;
  const current = useRef({ key, busy, foreground }); current.current = { key, busy, foreground };
  useEffect(() => {
    request.current?.abort(); setOpening(false); setFailed(false);
  }, [key]);
  useEffect(() => { if (busy) { request.current?.abort(); setOpening(false); } }, [busy]);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", (state) => {
      current.current.foreground = state === "active";
      setForeground(state === "active");
      if (state !== "active") { request.current?.abort(); setOpening(false); }
    });
    return () => { mounted.current = false; request.current?.abort(); listener.remove(); };
  }, []);
  if (!controls) return null;
  const label = mobileMessage(locale, `origin.${controls.kind}`);
  const available = controls.canOpen && key !== undefined && foreground;
  const open = async (): Promise<void> => {
    if (!available || busy || request.current && !request.current.signal.aborted) return;
    const controller = new AbortController(); request.current = controller; setOpening(true); setFailed(false);
    try {
      const opened = await onOpen(key!, controller.signal);
      if (!controller.signal.aborted && mounted.current && current.current.key === key && current.current.foreground) setFailed(!opened);
    } catch {
      if (!controller.signal.aborted && mounted.current && current.current.key === key && current.current.foreground) setFailed(true);
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        if (mounted.current && current.current.key === key && current.current.foreground) setOpening(false);
      }
    }
  };
  return <View style={styles.container}>
    <View style={styles.row}>
      <View style={[styles.line, { backgroundColor: colors.border }]} />
      {available ? <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "origin.open")}
        accessibilityHint={label} accessibilityState={{ disabled: busy || opening, busy: opening }} disabled={busy || opening}
        onPress={() => void open()} style={[styles.button, (busy || opening) && styles.disabled]}>
        <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
        <Text style={[styles.label, { color: colors.accent }]}>{mobileMessage(locale, opening ? "origin.opening" : "origin.open")}</Text>
      </Pressable> : <View style={styles.button}>
        <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
        <Text style={[styles.label, { color: colors.muted }]}>{mobileMessage(locale, "origin.unavailable")}</Text>
      </View>}
      <View style={[styles.line, { backgroundColor: colors.border }]} />
    </View>
    {failed && <Text accessibilityLiveRegion="polite" style={[styles.label, { color: colors.muted }]}>{mobileMessage(locale, "origin.failed")}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 4, paddingVertical: 8 }, row: { flexDirection: "row", alignItems: "center", gap: 12 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  button: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, justifyContent: "center", alignItems: "center", gap: 3 },
  label: { fontSize: 12, lineHeight: 18, fontWeight: "500", textAlign: "center" }, disabled: { opacity: 0.5 }
});
