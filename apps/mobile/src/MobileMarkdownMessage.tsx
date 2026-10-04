import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { randomUUID } from "expo-crypto";
import { setStringAsync } from "expo-clipboard";
import { Image as NativeImage } from "expo-image";
import {
  groupMobileMarkdownSelectableBlocks, mobileMarkdownInlineImageSize, parseMobileMarkdownIncremental,
  type MobileMarkdownBlock, type MobileMarkdownInline, type MobileMarkdownParseResult
} from "./mobile-markdown";
import { latexToUnicodeApproximation } from "./mobile-markdown-math";
import { mobileCodeHighlight } from "./mobile-code-highlight";
import {
  buildMobileMarkdownRichHtml, parseMobileMarkdownRichStatus, type MobileMarkdownColors
} from "./mobile-markdown-rich-html";
import richRuntime from "./rich-markdown-runtime.richjs";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";
import { mobileMarkdownResourceKey, type MobileMarkdownResourceReference } from "./mobile-markdown-resources";
import { chatPathLabelReadsAsFileReference, classifyChatPathLinkTarget } from "./mobile-markdown-path-candidate";
import { useMobileMarkdownResources, type MobileMarkdownResourceClient } from "./use-mobile-markdown-resources";

interface Props {
  readonly text: string;
  readonly colors: MobileMarkdownColors;
  readonly locale: MobileSupportedLocale;
  readonly ownerKey: string;
  readonly selectable?: boolean;
  readonly resourceClient?: MobileMarkdownResourceClient;
  readonly resourceOwnerKey?: string;
  readonly messageId?: string;
  readonly onOpenImage?: (leaseId: string, key: string) => void;
  readonly onOpenPath?: (leaseId: string, key: string) => void;
}

export const MobileMarkdownMessage = memo(function MobileMarkdownMessage({ text, colors, locale, ownerKey, selectable = true,
  resourceClient, resourceOwnerKey, messageId, onOpenImage, onOpenPath }: Props) {
  const resources = useMobileMarkdownResources({ client: resourceClient, ownerKey: resourceOwnerKey, messageId, text });
  const previous = useRef<MobileMarkdownParseResult | null>(null);
  const parsed = useMemo(() => parseMobileMarkdownIncremental(text, previous.current), [text]);
  useEffect(() => { previous.current = parsed; }, [parsed]);
  const groups = useMemo(() => groupMobileMarkdownSelectableBlocks(parsed.blocks, {
    maxTextRunBlocks: 48, maxTextRunUtf16Length: 12_000, maxTextRunInlineFragments: 512
  }), [parsed]);
  const [notice, setNotice] = useState("");
  const [copying, setCopying] = useState(false);
  const [expanded, setExpanded] = useState<Extract<MobileMarkdownBlock, { type: "math" | "mermaid" }>>();
  const mounted = useRef(true);
  const copyPending = useRef(false);
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  useEffect(() => {
    mounted.current = true;
    setExpanded(undefined);
    setNotice("");
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") setExpanded(undefined);
    });
    return () => { mounted.current = false; subscription.remove(); };
  }, [ownerKey]);
  const copy = async (source: string): Promise<void> => {
    if (copyPending.current || AppState.currentState !== "active") return;
    const owner = ownerKey;
    copyPending.current = true;
    setCopying(true);
    try {
      await setStringAsync(source);
      if (mounted.current && currentOwner.current === owner) setNotice(mobileMessage(locale, "markdown.copied"));
    } catch {
      if (mounted.current && currentOwner.current === owner) setNotice(mobileMessage(locale, "markdown.copyFailed"));
    } finally {
      copyPending.current = false;
      if (mounted.current) setCopying(false);
    }
  };
  const inlines = (values: readonly MobileMarkdownInline[]) => values.map((inline, index) => {
    const key = mobileMarkdownResourceKey(inline);
    const reference = key ? resources?.references.get(key) : undefined;
    const openPath = reference && key && resources && onOpenPath ? () => onOpenPath(resources.leaseId, key) : undefined;
    if (inline.type === "image" && reference?.image && key && resources) return <MobileMarkdownImageSpan
      key={resources.leaseId + "/" + index} inline={inline} reference={reference} colors={colors}
      label={inline.alt || mobileMessage(locale, "markdown.image")}
      onOpen={onOpenImage ? () => onOpenImage(resources.leaseId, key) : undefined} />;
    const value = inline.type === "image" ? inline.alt || mobileMessage(locale, "markdown.image")
      : inline.type === "math" ? latexToUnicodeApproximation(inline.text) : inline.text;
    const external = inline.type === "link" && /^(?:https?:\/\/|joko:\/\/(?:task|session|project)\/)/iu.test(inline.url);
    const actionablePath = inline.type !== "image" ? openPath : undefined;
    const pathCandidate = inline.type === "link" && actionablePath ? classifyChatPathLinkTarget(inline.url) : undefined;
    const codeReference = inline.type === "code" || inline.type === "link" && !inline.bare && pathCandidate
      && chatPathLabelReadsAsFileReference(inline.text, pathCandidate, inline.url);
    return <Text key={index} accessibilityRole={external || actionablePath ? "link" : undefined}
      onPress={actionablePath ? () => { if (AppState.currentState === "active") actionablePath(); } : external ? () => {
        if (AppState.currentState !== "active") return;
        void Linking.openURL(inline.url).catch(() => {
          if (mounted.current) setNotice(mobileMessage(locale, "markdown.linkFailed"));
        });
      } : undefined}
      style={[
        inline.type === "strong" && styles.strong,
        inline.type === "emphasis" && styles.emphasis,
        inline.type === "strikethrough" && styles.strike,
        codeReference && [styles.inlineCode, { backgroundColor: colors.background }],
        external && { color: colors.accent, textDecorationLine: "underline" },
        actionablePath && { textDecorationLine: "underline" },
        inline.type === "image" && { color: colors.muted }
      ]}>{value}</Text>;
  });
  const toolbar = (source: string, kind: string, onExpand?: () => void) => <View style={styles.toolbar}>
    <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{kind}</Text>
    {onExpand && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "markdown.expand")}
      onPress={onExpand} style={styles.action}><Text style={{ color: colors.accent }}>{mobileMessage(locale, "markdown.expand")}</Text></Pressable>}
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "markdown.copySource")}
      accessibilityState={{ disabled: copying }} disabled={copying} onPress={() => void copy(source)} style={styles.action}>
      <Text style={{ color: colors.accent }}>{mobileMessage(locale, copying ? "markdown.copying" : "markdown.copySource")}</Text>
    </Pressable>
  </View>;
  const block = (value: MobileMarkdownBlock) => {
    if (value.type === "code") {
      const runs = mobileCodeHighlight(value.text, value.language);
      return <View key={value.key} style={[styles.frame, { borderColor: colors.border, backgroundColor: colors.background }]}>
        {toolbar(value.text, value.language ?? mobileMessage(locale, "markdown.code"))}
        <ScrollView horizontal nestedScrollEnabled contentContainerStyle={styles.codeContent}>
          <Text selectable={selectable} style={[styles.code, { color: colors.ink }]}>
            {runs.map((run, index) => <Text key={index} style={run.kind ? {
              color: /comment|meta/u.test(run.kind) ? colors.muted : /keyword|number|literal/u.test(run.kind) ? colors.accent : colors.ink,
              ...(/keyword/u.test(run.kind) ? { fontWeight: "600" as const } : {})
            } : undefined}>{run.text}</Text>)}
          </Text>
        </ScrollView>
      </View>;
    }
    if (value.type === "math" || value.type === "mermaid") return <View key={value.key}
      style={[styles.frame, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {toolbar(value.text, mobileMessage(locale, value.type === "math" ? "markdown.math" : "markdown.diagram"), () => setExpanded(value))}
      <MobileMarkdownRichBlock kind={value.type} source={value.text} colors={colors} locale={locale} ownerKey={`${ownerKey}/${value.key}`} />
    </View>;
    if (value.type === "table") return <View key={value.key} style={[styles.frame, { borderColor: colors.border }]}>
      <ScrollView horizontal nestedScrollEnabled>
        <View accessibilityLabel={mobileMessage(locale, "markdown.table")}>
          {[value.header, ...value.rows.map((row) => row.cells)].map((cells, rowIndex) => <View key={rowIndex}
            style={[styles.tableRow, rowIndex === 0 && { backgroundColor: colors.background }]}>
            {cells.map((cell, cellIndex) => <View key={cellIndex}
              style={[styles.cell, { borderColor: colors.border }]}>
              <Text selectable={selectable} style={[styles.body, { color: colors.ink }, rowIndex === 0 && styles.strong]}>{inlines(cell)}</Text>
            </View>)}
          </View>)}
        </View>
      </ScrollView>
    </View>;
    if (value.type === "blockquote") return <View key={value.key} style={[styles.quote, { borderColor: colors.accent }]}>
      <Text selectable={selectable} style={[styles.body, { color: colors.muted }]}>{inlines(value.inlines)}</Text>
    </View>;
    return <Text key={value.key} selectable={selectable} style={[styles.body, { color: colors.ink }]}>{inlines(value.inlines)}</Text>;
  };
  return <View style={styles.document}>
    {groups.map((group) => group.type === "single" ? block(group.block) : <Text key={group.key}
      selectable={selectable} style={[styles.body, { color: colors.ink }]}>
      {group.blocks.map((value, index) => <Text key={value.key}>
        {index > 0 && !value.textRunContinuation ? "\n\n" : ""}
        <Text style={value.type === "heading" ? {
          fontWeight: "700", fontSize: Math.max(17, 29 - value.level * 2), lineHeight: 34
        } : undefined}>
          {value.type === "list_item" && !value.textRunContinuation
            ? `${value.checked === true ? "☑" : value.checked === false ? "☐" : value.marker} ` : ""}
          {inlines(value.inlines)}
        </Text>
      </Text>)}
    </Text>)}
    {notice && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: colors.muted }]}>{notice}</Text>}
    <Modal visible={expanded !== undefined} animationType="fade" onRequestClose={() => setExpanded(undefined)}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}>
        <View style={styles.toolbar}>
          <Text style={[styles.body, styles.fill, { color: colors.ink }]}>{mobileMessage(locale, expanded?.type === "math" ? "markdown.math" : "markdown.diagram")}</Text>
          <Pressable accessibilityRole="button" onPress={() => setExpanded(undefined)} style={styles.action}>
            <Text style={{ color: colors.accent }}>{mobileMessage(locale, "common.close")}</Text>
          </Pressable>
        </View>
        {expanded && <ScrollView contentContainerStyle={styles.expanded}>
          <MobileMarkdownRichBlock kind={expanded.type} source={expanded.text} colors={colors} locale={locale}
            ownerKey={`${ownerKey}/expanded/${expanded.key}`} zoomable />
          {toolbar(expanded.text, mobileMessage(locale, "markdown.source"))}
          <Text selectable style={[styles.code, { color: colors.ink }]}>{expanded.text}</Text>
        </ScrollView>}
      </SafeAreaView>
    </Modal>
  </View>;
});

function MobileMarkdownImageSpan({ inline, reference, colors, label, onOpen }: {
  readonly inline: Extract<MobileMarkdownInline, { type: "image" }>;
  readonly reference: MobileMarkdownResourceReference;
  readonly colors: MobileMarkdownColors;
  readonly label: string;
  readonly onOpen?: () => void;
}) {
  const image = reference.image!;
  const size = mobileMarkdownInlineImageSize(inline);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const open = onOpen ? () => { if (alive.current && AppState.currentState === "active") onOpen(); } : undefined;
  return <Text accessibilityRole={open ? "button" : undefined} accessibilityLabel={label} onPress={open}>
    {failed ? <Text style={{ color: colors.muted, ...(open ? { textDecorationLine: "underline" as const } : {}) }}>{label}</Text>
      : <View style={size}><NativeImage source={{ uri: image.uri }} accessibilityLabel={label} contentFit="cover" cachePolicy="none"
        style={[size, { borderRadius: 6, backgroundColor: colors.background }]}
        onLoad={(event) => {
          if (alive.current && (event.source.width !== image.width || event.source.height !== image.height || event.source.isAnimated)) setFailed(true);
        }}
        onError={() => { if (alive.current) setFailed(true); }} /></View>}
  </Text>;
}

function MobileMarkdownRichBlock({ kind, source, colors, locale, ownerKey, zoomable = false }: {
  readonly kind: "math" | "mermaid"; readonly source: string; readonly colors: MobileMarkdownColors;
  readonly locale: MobileSupportedLocale; readonly ownerKey: string; readonly zoomable?: boolean;
}) {
  const [height, setHeight] = useState(kind === "mermaid" ? 220 : 80);
  const [failed, setFailed] = useState(false);
  const id = useMemo(() => randomUUID(), [colors, kind, source, ownerKey, zoomable]);
  const release = useCallback(() => undefined, []);
  const failure = useCallback(() => setFailed(true), []);
  const lifecycle = useMobilePreviewResourceLifecycle({ ownerKey: id, releaseRenderer: release, reportFailure: failure });
  const token = lifecycle.rendererToken;
  const html = useMemo(() => source.length > 100_000 ? undefined
    : buildMobileMarkdownRichHtml({ instanceId: id, kind, source, colors, zoomable }, richRuntime), [colors, id, kind, source, zoomable]);
  useEffect(() => { setFailed(false); }, [id]);
  if (!html || failed || !lifecycle.rendererMounted) return <View style={styles.fallback}>
    <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "markdown.sourceFallback")}</Text>
    <Text selectable style={[styles.code, { color: colors.ink }]}>{source}</Text>
  </View>;
  return <WebView key={token} source={{ html }} originWhitelist={["about:blank"]}
    style={{ height: zoomable ? Math.max(320, height) : height, backgroundColor: colors.surface }}
    javaScriptEnabled domStorageEnabled={false} cacheEnabled={false} incognito
    allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
    mixedContentMode="never" setSupportMultipleWindows={false} scrollEnabled={zoomable} nestedScrollEnabled
    onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
    onMessage={(event) => {
      if (!lifecycle.ownsRenderer(token)) return;
      const status = parseMobileMarkdownRichStatus(event.nativeEvent.data, id);
      if (!status) return;
      setHeight(status.height);
      if (status.state === "error") setFailed(true);
      else if (status.state === "ready") lifecycle.onRendererReady(token);
    }}
    onError={() => { if (lifecycle.ownsRenderer(token)) setFailed(true); }}
    onContentProcessDidTerminate={() => { lifecycle.onRendererProcessLost(token); }}
    onRenderProcessGone={() => { lifecycle.onRendererProcessLost(token); }} />;
}

const styles = StyleSheet.create({
  document: { gap: 12 }, fill: { flex: 1 }, body: { fontSize: 15, lineHeight: 23 },
  strong: { fontWeight: "700" }, emphasis: { fontStyle: "italic" }, strike: { textDecorationLine: "line-through" },
  inlineCode: { fontFamily: "monospace", fontSize: 13 }, code: { fontFamily: "monospace", fontSize: 13, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 18 }, frame: { borderWidth: 1, borderRadius: 8, overflow: "hidden" },
  toolbar: { minHeight: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, gap: 8 },
  action: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center", alignItems: "center" },
  codeContent: { padding: 12 }, tableRow: { flexDirection: "row" }, cell: { width: 180, padding: 10, borderRightWidth: 1, borderBottomWidth: 1 },
  quote: { borderLeftWidth: 3, paddingLeft: 12 }, fallback: { padding: 12, gap: 6 }, expanded: { padding: 12, gap: 12 }
});
