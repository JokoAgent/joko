import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { partnerLearningMessage, partnerLearningRows, type PartnerLearningFeedbackView, type PartnerLearningSettingsDestination } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

const memoryIconPaths = [
  "M12 18V5",
  "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4",
  "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5",
  "M17.997 5.125a4 4 0 0 1 2.526 5.77",
  "M18 18a4 4 0 0 0 2-7.464",
  "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
  "M6 18a4 4 0 0 1-2-7.464",
  "M6.003 5.125a4 4 0 0 0-2.526 5.77"
] as const;
const skillIconPaths = [
  "M12 5v16",
  "M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"
] as const;

export function MobilePartnerLearningFooter({ feedback, locale, color, disabled, onOpen }: {
  readonly feedback?: PartnerLearningFeedbackView;
  readonly locale: MobileSupportedLocale;
  readonly color: string;
  readonly disabled: boolean;
  readonly onOpen: (destination: PartnerLearningSettingsDestination) => void;
}) {
  const rows = partnerLearningRows(feedback);
  if (rows.length === 0) return null;
  return <View testID="message.learningFooter">{rows.map(row => <Pressable key={row.kind} accessibilityRole="button"
    accessibilityLabel={partnerLearningMessage(locale, row)} accessibilityState={{ disabled }} disabled={disabled}
    onPress={() => onOpen(row.destination)} style={[styles.row, disabled && styles.disabled]}>
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">
      {(row.kind === "memory" ? memoryIconPaths : skillIconPaths).map(path => <Path key={path} d={path} />)}
    </Svg>
    <Text style={[styles.text, { color }]}>{partnerLearningMessage(locale, row)}</Text>
  </Pressable>)}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, maxWidth: "86%" },
  icon: { flexShrink: 0 },
  text: { flexShrink: 1, fontSize: 12, lineHeight: 17, textDecorationLine: "underline" },
  disabled: { opacity: 0.5 }
});
