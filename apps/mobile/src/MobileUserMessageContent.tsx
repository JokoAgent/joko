import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import {
  AUTOMATION_USER_MESSAGE_COLLAPSED_LINES,
  AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  LONG_USER_MESSAGE_COLLAPSED_LINES,
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedVisualLineThreshold,
  resolveUserMessageCollapse
} from "./mobile-user-message-collapse";

export interface MobileUserMessageContentProps {
  readonly ownerKey: string;
  readonly text: string;
  readonly automation: boolean;
  readonly selectable: boolean;
  readonly locale: MobileSupportedLocale;
  readonly colors: { readonly ink: string; readonly muted: string };
}

export function MobileUserMessageContent(props: MobileUserMessageContentProps) {
  return <UserMessageBody key={JSON.stringify([props.ownerKey, props.text, props.automation])} {...props} />;
}

function UserMessageBody({ text, automation, selectable, locale, colors }: MobileUserMessageContentProps) {
  const threshold = automation ? AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD : LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD;
  const collapsedLines = automation ? AUTOMATION_USER_MESSAGE_COLLAPSED_LINES : LONG_USER_MESSAGE_COLLAPSED_LINES;
  const measure = mayExceedVisualLineThreshold(text, threshold);
  const [measuredLines, setMeasuredLines] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [latched, setLatched] = useState(false);
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const resolved = measure && resolveUserMessageCollapse(text, measuredLines, threshold);
  useEffect(() => { if (resolved) setLatched(true); }, [resolved]);
  // Once adopted, a smaller layout cannot oscillate the bubble between expanded and collapsed.
  const collapsible = measure && (latched || resolved);
  return <View style={styles.body}>
    <Text testID="message.userBody" selectable={selectable} numberOfLines={collapsible && !expanded ? collapsedLines : undefined}
      style={[styles.text, { color: colors.ink }]}>{text}</Text>
    {measure && <View pointerEvents="none" accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" style={styles.measure}>
      <Text testID="message.userMeasure" numberOfLines={threshold + 1}
        onTextLayout={(event) => { if (current.current) setMeasuredLines(event.nativeEvent.lines.length); }}
        style={[styles.text, { color: colors.ink }]}>{text}</Text>
    </View>}
    {collapsible && <Text testID="message.userCollapse" accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={mobileMessage(locale, expanded ? "task.collapseMessage" : "task.expandMessage")}
      onPress={() => { if (current.current) setExpanded(value => !value); }} suppressHighlighting
      style={[styles.toggle, { color: colors.muted }]}>{mobileMessage(locale, expanded ? "task.collapse" : "task.expand")}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  body: { position: "relative", minWidth: 0 },
  text: { fontSize: 15, lineHeight: 22 },
  measure: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 },
  toggle: { fontSize: 13, lineHeight: 20, paddingVertical: 12 }
});
