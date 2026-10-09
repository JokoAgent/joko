import { useEffect, useRef, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from "react-native";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import { MobilePartnerEntranceLedger } from "./mobile-partner-entrance";
import { formatMobilePartnerTime } from "./mobile-partner-presentation";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { TimelineRow } from "./timeline";

const entrances = new MobilePartnerEntranceLedger();

export function MobilePartnerConversationRow({ row, ownerKey, preset, timestamp, colors, locale, animate, children }: {
  readonly row: TimelineRow;
  readonly ownerKey: string;
  readonly preset: string;
  readonly timestamp?: number;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly animate: boolean;
  readonly children: ReactNode;
}) {
  const progress = useRef(new Animated.Value(1)).current;
  const user = row.kind === "user";
  const reply = row.kind === "assistant";
  useEffect(() => {
    let current = true; let animation: Animated.CompositeAnimation | undefined;
    const begin = (reduced: boolean): void => {
      if (!current || reduced || !animate || !user && !reply || !entrances.claim(`${ownerKey}\u001f${row.id}`, row.startedAtMs)) return;
      progress.setValue(0);
      animation = Animated.timing(progress, { toValue: 1, duration: 200,
        easing: Easing.bezier(0.16, 1, 0.3, 1), useNativeDriver: true }); animation.start();
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(begin).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduced) => {
      if (reduced) { animation?.stop(); progress.setValue(1); }
    });
    return () => { current = false; animation?.stop(); subscription.remove(); progress.setValue(1); };
  }, [animate, ownerKey, progress, reply, row.id, row.startedAtMs, user]);
  return <View testID="partner.conversation.row">
    {timestamp !== undefined && <Text testID="partner.conversation.time" style={[styles.time, { color: colors.muted }]}>
      {formatMobilePartnerTime(timestamp, locale)}
    </Text>}
    <Animated.View style={{ opacity: progress, transform: [
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [user ? 8 : 6, 0] }) },
      ...(user ? [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] : [])
    ] }}>
      <View style={user ? styles.user : reply ? styles.reply : styles.inset}>
        {reply && <View style={styles.portrait}><MobilePartnerAvatar preset={preset} colors={colors} size={28} /></View>}
        <View style={styles.content}>{children}</View>
      </View>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  time: { textAlign: "center", fontSize: 12, lineHeight: 18, marginTop: 8, marginBottom: 12 },
  reply: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  portrait: { flexShrink: 0, marginTop: 2 }, content: { flex: 1, minWidth: 0 },
  user: { alignSelf: "flex-end", maxWidth: "86%", minWidth: 0 }, inset: { paddingLeft: 38 }
});
