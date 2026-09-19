import { Animated, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Session } from "@joko/contracts";
import { resolveSwipeRelease, shouldClaimHorizontalSwipe, type SwipeRowRegistry } from "./home-navigation";
import { useReducedMotion } from "./MobileDrawer";

export interface SwipeableSessionRowProps {
  readonly session: Session;
  readonly registry: SwipeRowRegistry;
  readonly colors: { readonly surface: string; readonly ink: string; readonly accent: string; readonly negative: string };
  readonly onTogglePin: (session: Session) => void;
  readonly onArchive: (session: Session) => void;
  readonly onShowOptions: (session: Session) => void;
  readonly children: ReactNode;
}

const PIN_OFFSET = 92;
const OPTIONS_OFFSET = -164;

export function SwipeableSessionRow({
  session,
  registry,
  colors,
  onTogglePin,
  onArchive,
  onShowOptions,
  children
}: SwipeableSessionRowProps) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const translateX = useRef(new Animated.Value(0)).current;
  const rowKey = session.sessionId;

  const animateTo = (value: number, onComplete?: () => void): void => {
    translateX.stopAnimation();
    if (reducedMotion) {
      translateX.setValue(value);
      onComplete?.();
      return;
    }
    Animated.spring(translateX, {
      damping: 24,
      mass: 0.7,
      stiffness: 260,
      toValue: value,
      useNativeDriver: true
    }).start(({ finished }) => { if (finished) onComplete?.(); });
  };
  const close = (): void => animateTo(0, () => registry.onRowClose(rowKey));

  useEffect(() => () => {
    translateX.stopAnimation();
    registry.onRowClose(rowKey);
  }, [registry, rowKey, translateX]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => shouldClaimHorizontalSwipe(gesture.dx, gesture.dy),
    onPanResponderGrant: () => registry.onRowOpen(rowKey, close),
    onPanResponderMove: (_event, gesture) => translateX.setValue(Math.max(-width, Math.min(width, gesture.dx))),
    onPanResponderRelease: (_event, gesture) => {
      switch (resolveSwipeRelease(gesture.dx, width)) {
        case "pin":
          animateTo(0, () => { registry.onRowClose(rowKey); onTogglePin(session); });
          break;
        case "archive":
          animateTo(0, () => { registry.onRowClose(rowKey); onArchive(session); });
          break;
        case "reveal-pin":
          animateTo(PIN_OFFSET);
          break;
        case "reveal-options":
          animateTo(OPTIONS_OFFSET);
          break;
        default:
          close();
      }
    },
    onPanResponderTerminate: close
  }), [onArchive, onTogglePin, reducedMotion, registry, rowKey, session, translateX, width]);

  return <View style={styles.shell}>
    <View style={styles.leftActions}>
      <Pressable accessibilityRole="button" accessibilityLabel={session.pinned ? "Unpin task" : "Pin task"}
        onPress={() => animateTo(0, () => { registry.onRowClose(rowKey); onTogglePin(session); })}
        style={[styles.roundAction, { backgroundColor: colors.accent }]}>
        <Text style={[styles.actionText, styles.darkText]}>{session.pinned ? "Unpin" : "Pin"}</Text>
      </Pressable>
    </View>
    <View style={styles.rightActions}>
      <Pressable accessibilityRole="button" accessibilityLabel="Task options"
        onPress={() => animateTo(0, () => { registry.onRowClose(rowKey); onShowOptions(session); })}
        style={[styles.roundAction, { backgroundColor: colors.surface }]}>
        <Text style={[styles.actionText, { color: colors.ink }]}>More</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={session.archived ? "Restore task" : "Archive task"}
        onPress={() => animateTo(0, () => { registry.onRowClose(rowKey); onArchive(session); })}
        style={[styles.roundAction, { backgroundColor: colors.negative }]}>
        <Text style={[styles.actionText, styles.lightText]}>{session.archived ? "Restore" : "Archive"}</Text>
      </Pressable>
    </View>
    <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
      {children}
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  shell: { position: "relative", overflow: "hidden" },
  leftActions: { ...StyleSheet.absoluteFill, alignItems: "flex-start", justifyContent: "center", paddingLeft: 12 },
  rightActions: { ...StyleSheet.absoluteFill, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingRight: 12 },
  roundAction: { width: 70, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 12, fontWeight: "700" },
  darkText: { color: "#2b2316" },
  lightText: { color: "#fff" }
});
