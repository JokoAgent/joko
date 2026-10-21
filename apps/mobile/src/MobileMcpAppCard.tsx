import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { McpAppCard } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileMcpAppView, MobileMcpAppState } from "./mobile-mcp-app-view";
import { MobileMcpAppSlot, useMobileMcpAppViews } from "./MobileMcpAppViews";
import { mobileMcpAppMessages } from "./mobile-mcp-app-messages";

export function MobileMcpAppCard({ card, colors, locale, enabled, readOnly }: { readonly card: McpAppCard;
  readonly colors: MobileInteractionSheetColors & { readonly dark: boolean }; readonly locale: MobileSupportedLocale; readonly enabled: boolean; readonly readOnly: boolean }) {
  const host = useMobileMcpAppViews(), copy = mobileMcpAppMessages(locale);
  const [attempt, retry] = useState(0), [view, setView] = useState<MobileMcpAppView>();
  const [state, setState] = useState<MobileMcpAppState>({ loading: true, height: 320, failed: false });
  const width = useRef(1), current = useRef({ colors, locale }); current.current = { colors, locale };
  const context = () => ({ platform: "mobile", theme: current.current.colors.dark ? "dark" : "light", locale: current.current.locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, deviceCapabilities: { touch: true, hover: false }, containerDimensions: { width: width.current, maxHeight: 1200 },
    styles: { variables: { "--color-background-primary": current.current.colors.surface, "--color-text-primary": current.current.colors.ink,
      "--color-text-secondary": current.current.colors.muted, "--color-border-primary": current.current.colors.border, "--font-sans": "system-ui, sans-serif" } } });
  useEffect(() => {
    setView(undefined);
    if (!enabled || readOnly || !host?.foreground) return;
    const opened = host.open(card.sessionId, card.cardId, context());
    if (!opened) { setState({ loading: false, height: 320, failed: true }); return; }
    opened.setWidth(width.current); setView(opened); const unsubscribe = opened.subscribe(setState);
    return () => { unsubscribe(); void opened.close(); };
  }, [host?.open, host?.foreground, host?.ownerKey, card.sessionId, card.cardId, attempt, enabled, readOnly]);
  useEffect(() => { void view?.context(context()).catch(() => view.fail()); }, [view, colors, locale]);
  const interactive = enabled && !readOnly && view && !state.failed;
  return <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <View style={styles.header}><Text style={[styles.title, { color: colors.ink }]}>{card.title || copy.app}</Text>
      {interactive && state.loading && <ActivityIndicator size="small" color={colors.muted} />}
      {state.failed && enabled && !readOnly && <Pressable accessibilityRole="button" onPress={() => retry(value => value + 1)} style={styles.retry}><Text style={{ color: colors.accent }}>{copy.retry}</Text></Pressable>}
    </View>
    {!interactive && <><Text style={[styles.caption, { color: colors.muted }]}>{readOnly ? copy.readOnly : state.failed ? copy.failed : copy.unavailable}</Text>
      {!!card.text && <Text selectable style={[styles.history, { color: colors.ink }]}>{card.text}</Text>}</>}
    {interactive && <View style={{ height: state.height }} onLayout={event => { width.current = event.nativeEvent.layout.width; view.setWidth(width.current); void view.context(context()).catch(() => view.fail()); }}>
      {MobileMcpAppSlot && host?.foreground && <MobileMcpAppSlot surfaceId={view.id} style={styles.fill} />}
    </View>}
  </View>;
}
const styles = StyleSheet.create({ card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden", marginVertical: 12 },
  header: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  title: { flex: 1, fontSize: 13, fontWeight: "500" }, retry: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  caption: { fontSize: 12, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 16 }, history: { fontSize: 14, lineHeight: 21, paddingHorizontal: 16, paddingBottom: 16 }, fill: { flex: 1 } });
