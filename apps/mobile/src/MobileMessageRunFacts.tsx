import { StyleSheet, Text, View } from "react-native";
import type { TimelineRow } from "./timeline";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessageRunFacts } from "./mobile-message-run-facts";

export function MobileMessageRunFacts({ row, locale, colors }: { readonly row: TimelineRow;
  readonly locale: MobileSupportedLocale; readonly colors: { readonly muted: string } }) {
  const facts = mobileMessageRunFacts(row, locale);
  if (!facts.modelNotice && !facts.usageLabel) return null;
  return <View style={styles.facts}>
    {facts.modelNotice && <Text testID="message.modelSubstitution" style={[styles.text, { color: colors.muted }]}>{facts.modelNotice}</Text>}
    {facts.usageLabel && <Text testID="message.usage" accessibilityLabel={facts.usageDescription}
      style={[styles.text, { color: colors.muted }]}>{facts.usageLabel}</Text>}
  </View>;
}
const styles = StyleSheet.create({ facts: { gap: 4, marginTop: 4 }, text: { fontSize: 13, lineHeight: 20 } });
