import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnerWorkingStatus as WorkingStatus } from "./mobile-partner-working";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { mobileMessage } from "./mobile-messages";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import { MobilePartnerPresenceRing } from "./MobilePartnerPresenceRing";
import { MobileWorkingStatusText } from "./MobileWorkingStatusText";
import { useMobileReducedMotion } from "./use-mobile-reduced-motion";

const AVATAR_SIZE = 20;
const CYCLE_MS = 1200;
const STAGGER_MS = 200;

function Dot({ index, animate, color }: { readonly index: number; readonly animate: boolean; readonly color: string }) {
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    if (!animate) { opacity.setValue(0.6); return; }
    opacity.setValue(0.25);
    const wave = (toValue: number, duration: number) => Animated.timing(opacity, {
      toValue, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true
    });
    const animation = Animated.sequence([Animated.delay(index * STAGGER_MS),
      Animated.loop(Animated.sequence([wave(1, CYCLE_MS * 0.4), wave(0.25, CYCLE_MS * 0.6)]))]);
    animation.start();
    return () => animation.stop();
  }, [animate, index, opacity]);
  return <Animated.View style={[styles.dot, { backgroundColor: color, opacity }]} />;
}

/** The active turn owns this row; terminal events unmount it without a caption delay. */
export function MobilePartnerWorkingStatus({ status, partner, locale, colors }: {
  readonly status: WorkingStatus;
  readonly partner: MobilePartnerDirectoryProfile;
  readonly locale: MobileSupportedLocale;
  readonly colors: MobilePartnersColors;
}) {
  const reduced = useMobileReducedMotion();
  const label = mobileMessage(locale, `partnerWorking.${status.phase}`);
  return <View style={styles.row} accessibilityLiveRegion="polite" testID="partner.workingStatus">
    <View style={styles.avatar}>
      <MobilePartnerAvatar preset={partner.avatar} partner={partner} colors={colors} size={AVATAR_SIZE} />
      <MobilePartnerPresenceRing active color={colors.accent} size={AVATAR_SIZE} width={1.5} />
    </View>
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      testID="partner.workingDots">
      {[0, 1, 2].map((index) => <Dot key={index} index={index} animate={reduced === false} color={colors.muted} />)}
    </View>
    <MobileWorkingStatusText text={label} style={[styles.text, { color: colors.muted }]} />
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 4, paddingVertical: 4 },
  avatar: { flexShrink: 0, width: AVATAR_SIZE, height: AVATAR_SIZE },
  dots: { flexDirection: "row", alignItems: "center", gap: 3 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  text: { fontSize: 13, lineHeight: 18 }
});
