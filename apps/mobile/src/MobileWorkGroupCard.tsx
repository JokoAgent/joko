import { memo, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { useMobileExpandedBlock } from "./mobile-expanded-block-memory";
import { mobileThinkingMessage } from "./mobile-thinking-messages";

export interface MobileWorkGroupCardProps {
  readonly blockKey: string;
  readonly ownerKey: string;
  readonly streaming: boolean;
  readonly enabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly children: ReactNode;
}

export const MobileWorkGroupCard = memo(function MobileWorkGroupCard({ blockKey, ownerKey, streaming, enabled,
  colors, locale, children }: MobileWorkGroupCardProps) {
  const [expanded, toggle] = useMobileExpandedBlock(ownerKey, blockKey);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  const interactive = enabled && foreground;
  const active = streaming && interactive;
  return <View style={[styles.group, { borderColor: colors.border }]}>
    <Pressable accessibilityRole="button"
      accessibilityLabel={mobileThinkingMessage(locale, expanded ? "collapseWork" : "expandWork")}
      accessibilityState={{ expanded, disabled: !interactive }} disabled={!interactive} onPress={() => { if (interactive) toggle(); }}
      style={styles.toggle}>
      {active && <ActivityIndicator size="small" color={colors.muted} accessibilityLabel={mobileThinkingMessage(locale, "workActive")} />}
      <Text numberOfLines={1} style={[styles.title, { color: colors.muted }]}>
        {mobileThinkingMessage(locale, active ? "workActive" : "workTitle")}
      </Text>
      <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.chevron, { color: colors.muted }]}>{expanded ? "⌃" : "⌄"}</Text>
    </Pressable>
    {expanded && <View style={styles.children}>{children}</View>}
  </View>;
});

const styles = StyleSheet.create({
  group: { minWidth: 0, marginVertical: 4, borderLeftWidth: 1 },
  toggle: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20 },
  chevron: { width: 16, fontSize: 16, textAlign: "center" },
  children: { paddingLeft: 12 }
});
