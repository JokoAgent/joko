import { StyleSheet, Text, View } from "react-native";
import { mobileOfflineAgeLabel } from "./mobile-offline-cache";

export interface MobileOfflineNoticeProps {
  readonly cachedAt: number;
  readonly now?: number;
  readonly colors: {
    readonly surface: string;
    readonly border: string;
    readonly muted: string;
    readonly negative: string;
  };
}

export function MobileOfflineNotice({ cachedAt, now = Date.now(), colors }: MobileOfflineNoticeProps) {
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite"
    style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={[styles.dot, { backgroundColor: colors.negative }]} />
    <Text style={[styles.text, { color: colors.muted }]}>
      {mobileOfflineAgeLabel(cachedAt, now)} · this task is read-only until Joko reconnects
    </Text>
  </View>;
}

const styles = StyleSheet.create({
  notice: {
    borderWidth: 1,
    borderRadius: 12,
    marginHorizontal: 12,
    marginTop: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { flex: 1, fontSize: 12, lineHeight: 17 }
});
