import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export function MobilePreviewControlBar({
  accessibilityLabel,
  background,
  border,
  children
}: {
  readonly accessibilityLabel: string;
  readonly background: string;
  readonly border: string;
  readonly children: ReactNode;
}) {
  return <View accessibilityRole="toolbar" accessibilityLabel={accessibilityLabel}
    style={[styles.bar, { backgroundColor: background, borderColor: border }]}>
    {children}
  </View>;
}

export function MobilePreviewControlButton({
  accessibilityLabel,
  disabled,
  ink,
  label,
  onPress,
  selected = false,
  surface
}: {
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly ink: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly selected?: boolean;
  readonly surface: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { backgroundColor: surface },
      (disabled || pressed) && styles.dimmed]}>
    <Text style={[styles.label, { color: ink }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 52,
    borderBottomWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 4,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6
  },
  button: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  label: { fontSize: 14, lineHeight: 18, fontWeight: "700" },
  dimmed: { opacity: 0.48 }
});
