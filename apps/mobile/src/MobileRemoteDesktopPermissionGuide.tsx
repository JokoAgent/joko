import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";

export interface MobileRemoteDesktopPermissionGuideProps {
  readonly title: string;
  readonly intro: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly guideLabel?: string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onGuide: () => void;
  readonly reconnectLabel: string;
  readonly onReconnect: () => void;
  readonly notice?: string;
  readonly colors: MobileRemoteDesktopColors;
}

export function MobileRemoteDesktopPermissionGuide(props: MobileRemoteDesktopPermissionGuideProps) {
  const disabled = props.disabled || props.pending;
  return <ScrollView testID="remoteDesktop.permissionGuide" keyboardShouldPersistTaps="handled"
    style={styles.viewport} contentContainerStyle={[styles.panel, { backgroundColor: props.colors.surface }]}>
    <Text accessibilityRole="header" style={[styles.title, { color: props.colors.ink }]}>{props.title}</Text>
    <Text style={[styles.caption, { color: props.colors.muted }]}>{props.intro}</Text>
    <View style={[styles.group, { borderColor: props.colors.border, backgroundColor: props.colors.background }]}>
      {props.rows.map(row => <View key={row.label} style={styles.row}>
        <Text style={[styles.text, { color: props.colors.ink }]}>{row.label}</Text>
        <Text style={[styles.caption, { color: props.colors.muted }]}>{row.value}</Text>
      </View>)}
    </View>
    {props.guideLabel && <Pressable accessibilityRole="button" accessibilityLabel={props.guideLabel}
      accessibilityState={{ disabled, busy: props.pending }} disabled={disabled} onPress={props.onGuide}
      style={({ pressed }) => [styles.button, { borderColor: props.colors.accent, backgroundColor: `${props.colors.accent}22` },
        disabled && styles.disabled, pressed && styles.pressed]}>
      <Text style={[styles.text, styles.action, { color: props.colors.ink }]}>{props.guideLabel}</Text>
    </Pressable>}
    <Pressable accessibilityRole="button" accessibilityLabel={props.reconnectLabel} accessibilityState={{ disabled }}
      disabled={disabled} onPress={props.onReconnect} style={({ pressed }) => [styles.button,
        { borderColor: props.guideLabel ? props.colors.border : props.colors.accent,
          backgroundColor: props.guideLabel ? props.colors.background : `${props.colors.accent}22` }, disabled && styles.disabled, pressed && styles.pressed]}>
      <Text style={[styles.text, styles.action, { color: props.colors.ink }]}>{props.reconnectLabel}</Text>
    </Pressable>
    {props.notice && <Text accessibilityRole="alert" style={[styles.caption, { color: props.colors.muted }]}>{props.notice}</Text>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  viewport: { width: "100%", maxWidth: 520, maxHeight: "100%", flexGrow: 0 },
  panel: { padding: 16, gap: 16 }, title: { fontSize: 22, lineHeight: 28, fontWeight: "600" },
  text: { fontSize: 15, lineHeight: 21, flexShrink: 1 }, caption: { fontSize: 13, lineHeight: 19, flexShrink: 1 },
  group: { padding: 12, gap: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14 },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 },
  button: { minHeight: 44, padding: 12, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: StyleSheet.hairlineWidth },
  action: { textAlign: "center" }, disabled: { opacity: .5 }, pressed: { opacity: .65 }
});
