import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MobileSelectableMessageText, type MobileMessageQuoteAction } from "./MobileSelectableMessageText";
import { MobileMarkdownMessage } from "./MobileMarkdownMessage";
import type { MobileMarkdownColors } from "./mobile-markdown-rich-html";
import { completeMobileCodeFences } from "./mobile-markdown";
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
  readonly formatExpandedCode?: boolean;
  readonly locale: MobileSupportedLocale;
  readonly colors: MobileMarkdownColors;
  readonly quoteAction?: MobileMessageQuoteAction;
}

export function MobileUserMessageContent(props: MobileUserMessageContentProps) {
  return <UserMessageBody key={JSON.stringify([props.ownerKey, props.text, props.automation])} {...props} />;
}

function UserMessageBody({ ownerKey, text, automation, selectable, formatExpandedCode, locale, colors, quoteAction }: MobileUserMessageContentProps) {
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
  const code = useMemo(() => expanded && formatExpandedCode && !automation ? completeMobileCodeFences(text) : [], [text, expanded, automation, formatExpandedCode]);
  const originalText = (start: number, end: number, lines?: number): ReactNode => {
    const body = text.slice(start, end);
    const action = lines === undefined && selectable ? quoteAt(quoteAction, start) : undefined;
    return action !== undefined ? <MobileSelectableMessageText key={start} testID="message.userBody" text={body} ink={colors.ink} lineHeight={22} action={action} />
      : <Text key={start} testID="message.userBody" selectable={selectable} numberOfLines={lines}
        style={[styles.text, { color: colors.ink }]}>{body}</Text>;
  };
  const rendered: ReactNode[] = [];
  let position = 0;
  for (const range of code) {
    if (position < range.start) rendered.push(originalText(position, range.start));
    rendered.push(<MobileMarkdownMessage key={range.start} text={text.slice(range.start, range.end)} colors={colors} locale={locale}
      ownerKey={`${ownerKey}/code/${range.start}`} selectable={selectable}
      codeQuoteAction={range.exactBody ? quoteAt(quoteAction, range.bodyStart) : undefined} />);
    position = range.end;
  }
  return <View style={styles.body}>
    {code.length === 0 ? originalText(0, text.length, collapsible && !expanded ? collapsedLines : undefined)
      : <>{rendered}{position < text.length && originalText(position, text.length)}</>}
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

function quoteAt(action: MobileMessageQuoteAction | undefined, offset: number): MobileMessageQuoteAction | undefined {
  if (action === undefined || offset === 0) return action;
  return { ...action, source: JSON.stringify([action.source, offset]), onQuote: ({ start, end }) =>
    action.onQuote({ start: start + offset, end: end + offset }) };
}

const styles = StyleSheet.create({
  body: { position: "relative", minWidth: 0 },
  text: { fontSize: 15, lineHeight: 22 },
  measure: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 },
  toggle: { fontSize: 13, lineHeight: 20, paddingVertical: 12 }
});
