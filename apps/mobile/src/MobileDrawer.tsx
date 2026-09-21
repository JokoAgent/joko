import {
  AccessibilityInfo, Animated, Easing, Keyboard, Modal, PanResponder, Pressable, StyleSheet, View, findNodeHandle,
  type StyleProp, type ViewStyle
} from "react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { shouldClaimHorizontalSwipe, shouldCloseDrawer } from "./home-navigation";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export interface MobileDrawerProps {
  readonly visible: boolean;
  readonly width: number;
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onClosed?: () => void;
  readonly onMountedChange?: (mounted: boolean) => void;
  readonly initialFocusRef?: RefObject<View | null>;
  readonly children: ReactNode;
  readonly panelStyle?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function MobileDrawer({
  visible,
  width,
  backgroundColor,
  borderColor,
  locale,
  onClose,
  onClosed,
  onMountedChange,
  initialFocusRef,
  children,
  panelStyle,
  testID
}: MobileDrawerProps) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);
  const translateX = useRef(new Animated.Value(-width)).current;
  const onClosedRef = useRef(onClosed);
  const onMountedChangeRef = useRef(onMountedChange);
  onClosedRef.current = onClosed;
  onMountedChangeRef.current = onMountedChange;
  mountedRef.current = mounted;

  useEffect(() => {
    if (!visible || mounted) return;
    translateX.setValue(-width);
    setMounted(true);
    onMountedChangeRef.current?.(true);
  }, [mounted, translateX, visible, width]);

  useEffect(() => {
    if (!mounted) return;
    translateX.stopAnimation();
    if (visible) {
      Keyboard.dismiss();
      Animated.timing(translateX, {
        duration: reducedMotion ? 0 : 180,
        easing: Easing.out(Easing.cubic),
        toValue: 0,
        useNativeDriver: true
      }).start(({ finished }) => {
        if (!finished || !visible) return;
        const node = initialFocusRef?.current ? findNodeHandle(initialFocusRef.current) : null;
        if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
      });
      return;
    }
    Animated.timing(translateX, {
      duration: reducedMotion ? 0 : 160,
      easing: Easing.in(Easing.cubic),
      toValue: -width,
      useNativeDriver: true
    }).start(({ finished }) => {
      if (!finished || visible) return;
      setMounted(false);
      onMountedChangeRef.current?.(false);
      onClosedRef.current?.();
    });
  }, [initialFocusRef, mounted, reducedMotion, translateX, visible, width]);

  useEffect(() => () => {
    translateX.stopAnimation();
    if (mountedRef.current) onMountedChangeRef.current?.(false);
  }, [translateX]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.dx < 0 && shouldClaimHorizontalSwipe(gesture.dx, gesture.dy),
    onPanResponderMove: (_event, gesture) => translateX.setValue(Math.max(-width, Math.min(0, gesture.dx))),
    onPanResponderRelease: (_event, gesture) => {
      if (shouldCloseDrawer(gesture.dx, gesture.vx, width)) onClose();
      else Animated.timing(translateX, {
        duration: reducedMotion ? 0 : 140,
        easing: Easing.out(Easing.cubic),
        toValue: 0,
        useNativeDriver: true
      }).start();
    },
    onPanResponderTerminate: () => Animated.timing(translateX, {
      duration: reducedMotion ? 0 : 140,
      toValue: 0,
      useNativeDriver: true
    }).start()
  }), [onClose, reducedMotion, translateX, width]);

  if (!mounted) return null;
  return <Modal transparent visible onRequestClose={onClose} statusBarTranslucent animationType="none">
    <View style={styles.root} testID={testID}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.closeDrawer")}
        onPress={onClose} style={styles.backdrop} />
      <Animated.View
        accessibilityViewIsModal
        importantForAccessibility="yes"
        {...panResponder.panHandlers}
        style={[styles.panel, { width, backgroundColor, borderColor, transform: [{ translateX }] }, panelStyle]}
      >
        {children}
      </Animated.View>
    </View>
  </Modal>;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (current) setReduced(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { current = false; subscription.remove(); };
  }, []);
  return reduced;
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.38)" },
  panel: { height: "100%", borderRightWidth: 1, shadowColor: "#000", shadowOpacity: 0.2,
    shadowRadius: 18, shadowOffset: { width: 5, height: 0 }, elevation: 18 }
});
