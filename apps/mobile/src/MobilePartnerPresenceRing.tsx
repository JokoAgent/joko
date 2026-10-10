import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet } from "react-native";

/** A public working indication. Unknown motion preferences keep the ring still. */
export function MobilePartnerPresenceRing({ active, color }: { readonly active: boolean; readonly color: string }) {
  const opacity = useRef(new Animated.Value(0.8)).current;
  useEffect(() => {
    let current = true;
    let animation: Animated.CompositeAnimation | undefined;
    const update = (reduced: boolean): void => {
      animation?.stop(); opacity.setValue(0.8);
      if (!current || !active || reduced) return;
      opacity.setValue(0.3);
      const breathe = (toValue: number) => Animated.timing(opacity, {
        toValue, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true
      });
      animation = Animated.loop(Animated.sequence([breathe(1), breathe(0.3)])); animation.start();
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(update).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", update);
    return () => { current = false; animation?.stop(); subscription.remove(); };
  }, [active, opacity]);
  return active ? <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    testID="partnerDirectory.presenceRing" style={[styles.ring, { borderColor: color, opacity }]} /> : null;
}

const styles = StyleSheet.create({ ring: { position: "absolute", top: -4, right: -4, bottom: -4, left: -4,
  borderWidth: 2, borderRadius: 26 } });
