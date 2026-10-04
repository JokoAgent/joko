import { useMemo, useRef } from "react";
import { Platform, ScrollView, StyleSheet, Text, type TextLayoutEvent } from "react-native";
import type { MobileFilePreview } from "./workspace-files";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobileFileTextPreview({ preview, locale, colors }: {
  readonly preview: Extract<MobileFilePreview, { kind: "text" }>;
  readonly locale: MobileSupportedLocale;
  readonly colors: { readonly ink: string; readonly muted: string; readonly accent: string; readonly negative: string };
}) {
  const scroll = useRef<ScrollView>(null);
  const focusY = useRef<number | undefined>(undefined);
  const focus = useMemo(() => {
    const line = preview.focusLine;
    if (!line || !Number.isSafeInteger(line) || line < 1 || preview.startByte !== 0n) return undefined;
    let start = 0;
    for (let index = 1; index < line; index += 1) {
      const newline = preview.text.indexOf("\n", start);
      if (newline < 0) return undefined;
      start = newline + 1;
    }
    const newline = preview.text.indexOf("\n", start);
    const end = newline < 0 ? preview.text.length : newline;
    const column = Math.max(0, Math.min(end - start, (preview.focusColumn ?? 1) - 1));
    return { start, end, offset: start + column };
  }, [preview]);
  const scrollToFocus = () => {
    if (focusY.current !== undefined) scroll.current?.scrollTo({ y: Math.max(0, focusY.current - 40), animated: false });
  };
  const onTextLayout = (event: TextLayoutEvent) => {
    if (!focus || focusY.current !== undefined) return;
    let cursor = 0;
    let y = 0;
    for (const line of event.nativeEvent.lines) {
      const start = line.text ? preview.text.indexOf(line.text, cursor) : cursor;
      if (start < 0) return;
      if (start > focus.offset) break;
      y = line.y; cursor = start + line.text.length;
    }
    focusY.current = y; scrollToFocus();
  };
  return <ScrollView ref={scroll} style={styles.fill} contentContainerStyle={styles.container} onContentSizeChange={scrollToFocus}>
    {preview.truncated && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{mobileMessage(locale, "preview.truncated")}</Text>}
    {preview.focusLine && <Text accessibilityRole={!focus ? "alert" : "text"} style={{ color: colors.muted }}>
      {mobileMessage(locale, focus ? "preview.focusLine" : "preview.lineOutsideWindow", { line: preview.focusLine })}
    </Text>}
    <Text selectable onTextLayout={onTextLayout} style={[styles.text, { color: colors.ink }]}>
      {focus ? <>{preview.text.slice(0, focus.start)}<Text style={{ textDecorationLine: "underline", textDecorationColor: colors.accent }}>
        {preview.text.slice(focus.start, focus.end)}
      </Text>{preview.text.slice(focus.end)}</> : preview.text || mobileMessage(locale, "preview.emptyFile")}
    </Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, container: { paddingHorizontal: 16, paddingBottom: 36, gap: 8 },
  text: { fontSize: 13, lineHeight: 20, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) }
});
