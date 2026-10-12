import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet } from "react-native";
import { useMobileReducedMotion } from "./use-mobile-reduced-motion";

/** A public working indication. Unknown motion preferences keep the ring still. */
export function MobilePartnerPresenceRing({ active, color, size = 44, width = 2 }: {
  readonly active: boolean; readonly color: string; readonly size?: number; readonly width?: number;
}) {
  const opacity = useRef(new Animated.Value(0.8)).current;
  const reduced = useMobileReducedMotion();
  useEffect(() => {
    opacity.setValue(0.8);
    if (!active || reduced !== false) return;
    opacity.setValue(0.3);
    const breathe = (toValue: number) => Animated.timing(opacity, {
      toValue, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true
    });
    const animation = Animated.loop(Animated.sequence([breathe(1), breathe(0.3)])); animation.start();
    return () => animation.stop();
  }, [active, opacity, reduced]);
  return active ? <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    testID="partnerDirectory.presenceRing" style={[styles.ring, { borderColor: color, opacity,
      borderWidth: width, borderRadius: (size + 8) / 2 }]} /> : null;
}

const styles = StyleSheet.create({ ring: { position: "absolute", top: -4, right: -4, bottom: -4, left: -4,
  borderWidth: 2 } });
