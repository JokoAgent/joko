import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileMessage } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export function MobileConversationShareBar({ count, allSelected, busy, locale, colors, onCancel, onToggleAll, onShare, screenshotTriggered }: {
  readonly count: number; readonly allSelected: boolean; readonly busy: boolean; readonly locale: MobileSupportedLocale;
  readonly colors: { readonly surface: string; readonly ink: string; readonly muted: string; readonly border: string; readonly accent: string };
  readonly onCancel: () => void; readonly onToggleAll: () => void; readonly onShare: () => void;
  readonly screenshotTriggered?: boolean;
}) {
  return <View style={[styles.bar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    {screenshotTriggered && <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{mobileMessage(locale, "share.screenshotHint")}</Text>}
    <View style={styles.top}>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.ink }}>{mobileMessage(locale, "share.selected", { count })}</Text>
      <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8} style={styles.button}>
        <Text style={{ color: colors.accent }}>{mobileMessage(locale, "common.cancel")}</Text>
      </Pressable>
    </View>
    <View style={styles.top}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: allSelected, disabled: busy }} disabled={busy}
        onPress={onToggleAll} style={styles.button}>
        <Text style={{ color: busy ? colors.muted : colors.accent }}>{mobileMessage(locale, allSelected ? "share.restoreSelection" : "share.selectAll")}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || count === 0, busy }} disabled={busy || count === 0}
        onPress={onShare} style={styles.button}>
        <Text style={{ color: busy || count === 0 ? colors.muted : colors.accent }}>{mobileMessage(locale, busy ? "share.preparing" : "share.shareImage")}</Text>
      </Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({ bar: { padding: 12, borderTopWidth: 1, gap: 4 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, button: { minHeight: 40, justifyContent: "center", paddingHorizontal: 8 } });
