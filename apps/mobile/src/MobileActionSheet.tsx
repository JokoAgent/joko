import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "./MobileDrawer";
import { DeferredSheetAction, type MobileMessageActionId, type MobileMessageActionItem } from "./task-actions";

export function MobileActionSheet({
  visible,
  items,
  colors,
  onClose,
  onAction
}: {
  readonly visible: boolean;
  readonly items: readonly MobileMessageActionItem[];
  readonly colors: { readonly surface: string; readonly ink: string; readonly muted: string; readonly border: string; readonly negative: string };
  readonly onClose: () => void;
  readonly onAction: (action: MobileMessageActionId) => void;
}) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(false);
  const translateY = useRef(new Animated.Value(360)).current;
  const lifecycle = useRef(new DeferredSheetAction<MobileMessageActionId>()).current;
  const closingGeneration = useRef<number | undefined>(undefined);
  const wasVisible = useRef(false);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  useEffect(() => {
    if (visible && !wasVisible.current) {
      lifecycle.open();
      closingGeneration.current = undefined;
      if (!mounted) {
        translateY.setValue(360);
        setMounted(true);
      }
    }
    wasVisible.current = visible;
  }, [lifecycle, mounted, translateY, visible]);

  useEffect(() => {
    if (!mounted) return;
    translateY.stopAnimation();
    if (visible) {
      Animated.timing(translateY, {
        duration: reducedMotion ? 0 : 180,
        easing: Easing.out(Easing.cubic),
        toValue: 0,
        useNativeDriver: true
      }).start();
      return;
    }
    const generation = closingGeneration.current ?? lifecycle.cancel();
    Animated.timing(translateY, {
      duration: reducedMotion ? 0 : 160,
      easing: Easing.in(Easing.cubic),
      toValue: 360,
      useNativeDriver: true
    }).start(({ finished }) => {
      if (!finished || visible) return;
      setMounted(false);
      const action = lifecycle.closed(generation);
      if (action) onActionRef.current(action);
    });
  }, [lifecycle, mounted, reducedMotion, translateY, visible]);

  useEffect(() => () => translateY.stopAnimation(), [translateY]);

  const cancel = (): void => {
    closingGeneration.current = lifecycle.cancel();
    onClose();
  };
  const select = (action: MobileMessageActionId): void => {
    closingGeneration.current = lifecycle.select(action);
    onClose();
  };

  if (!mounted) return null;
  return <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={cancel}>
    <View style={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel message actions" onPress={cancel} style={styles.backdrop} />
      <Animated.View accessibilityViewIsModal importantForAccessibility="yes"
        style={[styles.area, { paddingBottom: Math.max(12, insets.bottom), transform: [{ translateY }] }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {items.map((item) => <View key={item.id}>
            {item.separatorBefore && <View style={[styles.separator, { backgroundColor: colors.border }]} />}
            <Pressable accessibilityRole="button" accessibilityLabel={item.label} onPress={() => select(item.id)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <Text style={[styles.label, { color: item.destructive ? colors.negative : colors.ink }]}>{item.label}</Text>
            </Pressable>
          </View>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={cancel}
          style={({ pressed }) => [styles.cancel, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
          <Text style={[styles.label, { color: colors.ink }]}>Cancel</Text>
        </Pressable>
      </Animated.View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.38)" },
  area: { gap: 8, paddingHorizontal: 12 },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth },
  row: { minHeight: 54, justifyContent: "center", paddingHorizontal: 18 },
  cancel: { minHeight: 54, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 16, fontWeight: "700" },
  pressed: { opacity: 0.7 }
});
