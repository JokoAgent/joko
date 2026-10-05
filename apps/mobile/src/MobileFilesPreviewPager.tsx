import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { MobileFilesPreviewPage, MobileFilesPreviewPager as Pager } from "./mobile-files-preview-pager";
import type { MobileMarkdownColors } from "./mobile-markdown-rich-html";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

interface Props {
  readonly pager?: Pager;
  readonly colors: MobileMarkdownColors;
  readonly locale: MobileSupportedLocale;
  readonly disabled: boolean;
  readonly canSwipe: boolean;
  readonly onNavigate?: (pagerId: string, pageKey: string) => void;
  readonly children: ReactNode;
}

export function MobileFilesPreviewPager({ pager, colors, locale, disabled, canSwipe, onNavigate, children }: Props) {
  const viewport = useWindowDimensions();
  const [layout, setLayout] = useState({ windowWidth: viewport.width, width: viewport.width });
  const width = Math.max(1, layout.windowWidth === viewport.width ? layout.width : viewport.width);
  const list = useRef<FlatList<MobileFilesPreviewPage>>(null);
  const frame = { pager, width, disabled, canSwipe, onNavigate };
  const current = useRef<typeof frame | undefined>(frame); current.current = frame;
  useLayoutEffect(() => {
    if (!pager) return;
    const anchor = () => list.current?.scrollToOffset({ offset: pager.index * width, animated: false });
    anchor(); const request = requestAnimationFrame(anchor);
    return () => cancelAnimationFrame(request);
  }, [pager?.id, pager?.index, width]);
  useLayoutEffect(() => { current.current = frame; return () => { current.current = undefined; }; }, []);
  const navigate = (index: number, swipe = false) => {
    if (current.current !== frame || disabled || (swipe && !canSwipe) || !pager || index === pager.index) return;
    const page = pager.pages[index]; if (page) onNavigate?.(pager.id, page.key);
  };
  if (!pager) return <>{children}</>;
  const previous = mobileMessage(locale, "files.preview.previous"); const next = mobileMessage(locale, "files.preview.next");
  return <View style={styles.fill} onLayout={(event) => {
    const value = event.nativeEvent.layout.width;
    if (current.current === frame && Number.isFinite(value) && value > 0) setLayout({ windowWidth: viewport.width, width: value });
  }}>
    <FlatList ref={list} style={styles.fill} horizontal pagingEnabled data={pager.pages}
      keyExtractor={(page) => page.key} initialScrollIndex={pager.index}
      getItemLayout={(_data, index) => ({ length: width, offset: width * index, index })}
      extraData={pager.index} initialNumToRender={1} maxToRenderPerBatch={3} windowSize={3}
      removeClippedSubviews={false} showsHorizontalScrollIndicator={false} scrollEnabled={!disabled && canSwipe && pager.pages.length > 1}
      onMomentumScrollEnd={(event) => {
        if (Math.abs(event.nativeEvent.layoutMeasurement.width - width) > 1) return;
        navigate(Math.round(event.nativeEvent.contentOffset.x / width), true);
      }} renderItem={({ item, index }) => <View style={[styles.fill, { width }]}>
        {index === pager.index ? children : <View style={styles.placeholder}>
          <Text style={{ color: colors.muted }} numberOfLines={1}>{item.title}</Text>
        </View>}
      </View>} />
    <View style={[styles.controls, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={previous} accessibilityState={{ disabled: disabled || pager.index === 0 }}
        disabled={disabled || pager.index === 0} onPress={() => navigate(pager.index - 1)}
        style={[styles.button, (disabled || pager.index === 0) && styles.disabled]}>
        <Text style={{ color: colors.accent }}>{previous}</Text>
      </Pressable>
      <Text accessibilityLiveRegion="polite" style={[styles.count, { color: colors.muted }]}>
        {mobileMessage(locale, "files.preview.page", { current: pager.index + 1, total: pager.pages.length })}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={next} accessibilityState={{ disabled: disabled || pager.index === pager.pages.length - 1 }}
        disabled={disabled || pager.index === pager.pages.length - 1} onPress={() => navigate(pager.index + 1)}
        style={[styles.button, (disabled || pager.index === pager.pages.length - 1) && styles.disabled]}>
        <Text style={{ color: colors.accent }}>{next}</Text>
      </Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  controls: { flexDirection: "row", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  button: { minHeight: 44, minWidth: 80, justifyContent: "center", alignItems: "center", paddingHorizontal: 12 },
  count: { flex: 1, textAlign: "center" }, disabled: { opacity: 0.45 }
});
