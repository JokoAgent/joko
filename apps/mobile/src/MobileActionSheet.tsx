import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "./MobileDrawer";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { DeferredSheetAction } from "./task-actions";

export interface MobileSheetActionItem<Action extends string> {
  readonly id: Action;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
  readonly swatch?: { readonly color: string; readonly selected: boolean };
}

export function MobileActionSheet<Action extends string>({
  visible,
  items,
  colors,
  locale,
  onClose,
  onAction,
  cancelAccessibilityLabel,
  maximumContentHeight,
  header
}: {
  readonly visible: boolean;
  readonly items: readonly MobileSheetActionItem<Action>[];
  readonly colors: { readonly surface: string; readonly ink: string; readonly muted: string; readonly border: string; readonly negative: string };
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onAction: (action: Action) => void;
  readonly cancelAccessibilityLabel?: string;
  readonly maximumContentHeight?: number;
  readonly header?: import("react").ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(false);
  const translateY = useRef(new Animated.Value(360)).current;
  const lifecycle = useRef(new DeferredSheetAction<Action>()).current;
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
  const select = (action: Action): void => {
    if (items.find((item) => item.id === action)?.disabled) return;
    closingGeneration.current = lifecycle.select(action);
    onClose();
  };

  if (!mounted) return null;
  const firstSwatch = items.findIndex(item => item.swatch !== undefined);
  const rows = items.map((item, index) => item.swatch !== undefined ? index === firstSwatch ? <View key={item.id} style={styles.swatches}>
    {items.filter(item => item.swatch !== undefined).map(item => <Pressable key={item.id} accessibilityRole="checkbox"
      accessibilityLabel={item.label} accessibilityState={{ checked: item.swatch!.selected, disabled: item.disabled === true }}
      disabled={item.disabled} onPress={() => select(item.id)} style={[styles.swatchButton, item.disabled && styles.disabled]}>
      <View style={[styles.swatch, { backgroundColor: item.swatch!.color, borderColor: colors.border }]}>
        <Text style={{ color: colors.ink }}>{item.swatch!.selected ? "✓" : ""}</Text>
      </View>
    </Pressable>)}
  </View> : null : <View key={item.id}>
    {item.separatorBefore && <View style={[styles.separator, { backgroundColor: colors.border }]} />}
    <Pressable accessibilityRole="button" accessibilityLabel={item.label}
      accessibilityState={{ disabled: item.disabled === true }} disabled={item.disabled}
      onPress={() => select(item.id)}
      style={({ pressed }) => [styles.row, item.disabled && styles.disabled, pressed && !item.disabled && styles.pressed]}>
      <Text style={[styles.label, { color: item.disabled ? colors.muted : item.destructive ? colors.negative : colors.ink }]}>{item.label}</Text>
    </Pressable>
  </View>);
  return <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={cancel}>
    <View style={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel={cancelAccessibilityLabel ?? mobileMessage(locale, "actions.cancelMessage")} onPress={cancel} style={styles.backdrop} />
      <Animated.View accessibilityViewIsModal importantForAccessibility="yes"
        style={[styles.area, { paddingBottom: Math.max(12, insets.bottom), transform: [{ translateY }] }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {maximumContentHeight === undefined ? <>{header}{rows}</>
            : <ScrollView style={{ maxHeight: maximumContentHeight }} bounces={false}>{header}{rows}</ScrollView>}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.cancel")} onPress={cancel}
          style={({ pressed }) => [styles.cancel, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
          <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "common.cancel")}</Text>
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
  swatches: { flexDirection: "row", justifyContent: "space-evenly", paddingHorizontal: 8 },
  swatchButton: { minWidth: 36, minHeight: 44, alignItems: "center", justifyContent: "center" },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  cancel: { minHeight: 54, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.48 },
  pressed: { opacity: 0.7 }
});
