import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export function MobileModelSpeedControl({ value, supportsFast, supportsUltrafast, disabled = false, colors, locale, onChange }: {
  readonly value: boolean | "ultrafast";
  readonly supportsFast: boolean;
  readonly supportsUltrafast?: boolean;
  readonly disabled?: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onChange: (value: boolean | "ultrafast") => void;
}) {
  const zh = locale === "zh-CN";
  const choices: readonly { readonly value: boolean | "ultrafast"; readonly label: string; readonly enabled: boolean }[] = [
    { value: false, label: zh ? "标准" : "Standard", enabled: true },
    { value: true, label: zh ? "快速" : "Fast", enabled: supportsFast },
    { value: "ultrafast", label: zh ? "极速" : "Ultrafast", enabled: supportsUltrafast === true }
  ];
  if (supportsUltrafast || value === "ultrafast") return <View style={styles.stack}>
    <Text style={{ color: colors.ink }}>{zh ? "速度" : "Speed"}</Text>
    <View style={styles.choices}>{choices.filter(choice => choice.enabled || choice.value === value).map(choice => <Pressable key={String(choice.value)}
      accessibilityRole="radio" accessibilityLabel={choice.label} accessibilityState={{ checked: choice.value === value, disabled: disabled || !choice.enabled }}
      disabled={disabled || !choice.enabled} onPress={() => onChange(choice.value)}
      style={[styles.choice, { borderColor: choice.value === value ? colors.accent : colors.border, opacity: choice.enabled ? 1 : 0.5 }]}>
      <Text style={{ color: choice.value === value ? colors.accent : colors.ink }}>{choice.label}</Text>
    </Pressable>)}</View>
  </View>;
  return <View style={styles.row}><Text style={{ color: colors.ink }}>{zh ? "快速" : "Fast"}</Text>
    <Switch accessibilityLabel={zh ? "快速模式" : "Fast mode"} disabled={disabled || !supportsFast && value === false} value={value === true}
      onValueChange={onChange} trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface} />
  </View>;
}

const styles = StyleSheet.create({ stack: { gap: 8 }, choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { minHeight: 44, minWidth: 72, padding: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 8 },
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 } });
