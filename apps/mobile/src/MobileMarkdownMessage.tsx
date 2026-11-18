import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMobileMailLink } from "./MobileExtensionMailReader";
import { AppState, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { randomUUID } from "expo-crypto";
import { setStringAsync } from "expo-clipboard";
import { Image as NativeImage } from "expo-image";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { mobileImageGalleryDimensionsMatch } from "./mobile-image-gallery";
import { decodeMobileBase64 } from "./mobile-image-annotation";
import { mobileImageOutput, type MobileImageOutputSource } from "./mobile-image-output";
import { inspectMobileImageOutputBytes } from "./mobile-image-output-format";
import { splitRichAnswer } from "@joko/contracts";
import { MobileRichAnswer } from "./MobileRichAnswer";
import { MobileRichAnswerMedia } from "./MobileRichAnswerMedia";
import type { MobileMarkdownResourceDescriptor } from "./mobile-markdown-resources";
import {
  groupMobileMarkdownSelectableBlocks, mobileMarkdownInlineHasMark, mobileMarkdownInlineImageSize, parseMobileMarkdownIncremental,
  type MobileMarkdownBlock, type MobileMarkdownInline, type MobileMarkdownParseResult
} from "./mobile-markdown";
import { latexToUnicodeApproximation } from "./mobile-markdown-math";
import { mobileCodeHighlight } from "./mobile-code-highlight";
import {
  buildMobileMarkdownRichHtml, MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_BYTES, parseMobileMarkdownDiagramPng,
  parseMobileMarkdownRichStatus, requestMobileMarkdownDiagramPngScript, type MobileMarkdownColors
} from "./mobile-markdown-rich-html";
import richRuntime from "./rich-markdown-runtime.richjs";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";
import { mobileMarkdownResourceKey, type MobileMarkdownResourceReference } from "./mobile-markdown-resources";
import { chatPathLabelReadsAsFileReference, classifyChatPathLinkTarget } from "./mobile-markdown-path-candidate";
import { useMobileMarkdownResources, type MobileMarkdownResourceClient } from "./use-mobile-markdown-resources";
import { MobileSelectableMessageText, type MobileMessageQuoteAction } from "./MobileSelectableMessageText";

interface Props {
  readonly text: string;
  readonly colors: MobileMarkdownColors;
  readonly locale: MobileSupportedLocale;
  readonly ownerKey: string;
  readonly selectable?: boolean;
  readonly quoteAction?: MobileMessageQuoteAction;
  readonly resourceClient?: MobileMarkdownResourceClient;
  readonly resourceOwnerKey?: string;
  readonly messageId?: string;
  readonly answerStateKey?: string;
  readonly onSendRichAnswer?: (text: string, receiptKey: string) => Promise<boolean>;
  readonly streaming?: boolean;
  readonly resourceText?: string;
  readonly onOpenImage?: (leaseId: string, key: string) => void;
  readonly onOpenPath?: (leaseId: string, key: string) => void;
  readonly onAnnotateDiagram?: (image: MobileImageOutputSource) => void;
}

export const MobileMarkdownMessage = memo(function MobileMarkdownMessage(props: Props) {
  const resources = useMobileMarkdownResources({ client: props.resourceClient, ownerKey: props.resourceOwnerKey,
    messageId: props.messageId, text: props.resourceText ?? props.text });
  const parts = useMemo(() => props.answerStateKey === undefined ? [] : splitRichAnswer(props.text), [props.answerStateKey, props.text]);
  if (props.quoteAction !== undefined && !props.streaming && props.selectable !== false) {
    return <MobileSelectableMessageText text={props.text} ink={props.colors.ink} lineHeight={23} action={props.quoteAction} />;
  }
  if (!parts.some(part => part.kind === "rich")) return <MobilePlainMarkdownMessage {...props} preparedResources={resources} />;
  return <View style={styles.document}>{parts.map(part => part.kind === "rich"
    ? <MobileRichAnswer key={part.key} source={part.source} complete={part.complete || !props.streaming}
      stateKey={JSON.stringify([props.answerStateKey, part.key])} colors={props.colors} locale={props.locale}
      onSend={props.onSendRichAnswer}
      renderMedia={node => <MobileRichAnswerMedia key={JSON.stringify([part.key, node.id, node.props["src"]])} node={node} colors={props.colors} locale={props.locale} resources={resources}
        fallback={text => <MobilePlainMarkdownMessage {...props} text={text} preparedResources={resources} />} />}
      renderMarkdown={(text, id) => <MobilePlainMarkdownMessage {...props} key={id} text={text} preparedResources={resources} />} />
    : <MobilePlainMarkdownMessage {...props} key={part.key} text={part.source} preparedResources={resources} />)}</View>;
});

const MobilePlainMarkdownMessage = memo(function MobilePlainMarkdownMessage({ text, colors, locale, ownerKey, selectable = true,
  preparedResources: resources, onOpenImage, onOpenPath, onAnnotateDiagram }: Props & { readonly preparedResources?: MobileMarkdownResourceDescriptor }) {
  const previewMail = useMobileMailLink();
  const previous = useRef<MobileMarkdownParseResult | null>(null);
  const parsed = useMemo(() => parseMobileMarkdownIncremental(text, previous.current), [text]);
  useEffect(() => { previous.current = parsed; }, [parsed]);
  const rendersInlineImage = useCallback((inline: MobileMarkdownInline) => {
    const key = mobileMarkdownResourceKey(inline);
    return inline.type === "image" && !!key && !!resources?.references.get(key)?.image;
  }, [resources]);
  const textSelectable = (values: readonly MobileMarkdownInline[]) => selectable && !values.some(rendersInlineImage);
  const bodyStyle = (values: readonly MobileMarkdownInline[]) => values.some(rendersInlineImage) ? styles.inlineImageBody : styles.body;
  const groups = useMemo(() => groupMobileMarkdownSelectableBlocks(parsed.blocks, {
    maxTextRunBlocks: 48, maxTextRunUtf16Length: 12_000, maxTextRunInlineFragments: 512, rendersInlineImage
  }), [parsed, rendersInlineImage]);
  const [notice, setNotice] = useState("");
  const [copying, setCopying] = useState(false);
  const [expanded, setExpanded] = useState<Extract<MobileMarkdownBlock, { type: "math" | "mermaid" }>>();
  const [viewDiagramSource, setViewDiagramSource] = useState(false);
  const diagramScope = useRef<AbortController | undefined>(undefined);
  const diagramHandoff = useRef<{ readonly ownerKey: string; readonly open: () => void } | undefined>(undefined);
  const hideExpanded = useCallback(() => {
    diagramScope.current?.abort();
    diagramScope.current = undefined;
    setExpanded(undefined);
  }, []);
  const closeExpanded = useCallback(() => { diagramHandoff.current = undefined; hideExpanded(); }, [hideExpanded]);
  const mounted = useRef(true);
  const copyPending = useRef(false);
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  useEffect(() => {
    mounted.current = true;
    closeExpanded();
    setNotice("");
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") closeExpanded();
    });
    return () => { mounted.current = false; diagramHandoff.current = undefined; diagramScope.current?.abort(); subscription.remove(); };
  }, [closeExpanded, ownerKey]);
  const deliverDiagram = useCallback(() => {
    const pending = diagramHandoff.current;
    diagramHandoff.current = undefined;
    if (pending && mounted.current && currentOwner.current === pending.ownerKey && AppState.currentState === "active") pending.open();
  }, []);
  useEffect(() => {
    if (expanded !== undefined || Platform.OS !== "android" || !diagramHandoff.current) return;
    const frame = requestAnimationFrame(deliverDiagram);
    return () => cancelAnimationFrame(frame);
  }, [expanded, deliverDiagram]);
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
    const struck = mobileMarkdownInlineHasMark(inline, "strikethrough");
    const linked = external || actionablePath !== undefined;
    return <Text key={index} accessibilityRole={external || actionablePath ? "link" : undefined}
      onPress={actionablePath ? () => { if (AppState.currentState === "active") actionablePath(); } : external ? () => {
        if (AppState.currentState !== "active") return;
        void (async () => { if (await previewMail?.(inline.url)) return; if (AppState.currentState === "active") await Linking.openURL(inline.url); })().catch(() => {
          if (mounted.current) setNotice(mobileMessage(locale, "markdown.linkFailed"));
        });
      } : undefined}
      style={[
        mobileMarkdownInlineHasMark(inline, "strong") && styles.strong,
        mobileMarkdownInlineHasMark(inline, "emphasis") && styles.emphasis,
        codeReference && [styles.inlineCode, { backgroundColor: colors.background }],
        external && { color: colors.accent },
        linked && { textDecorationLine: struck ? "underline line-through" : "underline" },
        struck && !linked && styles.strike,
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
      {toolbar(value.text, mobileMessage(locale, value.type === "math" ? "markdown.math" : "markdown.diagram"), () => {
        diagramScope.current?.abort();
        diagramScope.current = value.type === "mermaid" ? new AbortController() : undefined;
        setViewDiagramSource(false);
        setExpanded(value);
      })}
      <MobileMarkdownRichBlock kind={value.type} source={value.text} colors={colors} locale={locale} ownerKey={`${ownerKey}/${value.key}`} />
    </View>;
    if (value.type === "table") return <MobileMarkdownTable key={value.key}
      table={value} colors={colors} label={mobileMessage(locale, "markdown.table")} rendersInlineImage={rendersInlineImage}
      renderCell={(cell, header) => <Text selectable={textSelectable(cell)}
        style={[bodyStyle(cell), { color: colors.ink }, header && styles.strong]}>{inlines(cell)}</Text>} />;
    if (value.type === "blockquote") return <View key={value.key} style={[styles.quote, { borderColor: colors.accent }]}>
      <Text selectable={textSelectable(value.inlines)} style={[bodyStyle(value.inlines), { color: colors.muted }]}>{inlines(value.inlines)}</Text>
    </View>;
    return <Text key={value.key} selectable={textSelectable(value.inlines)} style={[bodyStyle(value.inlines), { color: colors.ink },
      value.type === "heading" && { fontWeight: "700", fontSize: Math.max(17, 29 - value.level * 2),
        ...(!value.inlines.some(rendersInlineImage) ? { lineHeight: 34 } : {}) }]}>
      {value.type === "list_item" ? `${value.checked === true ? "☑" : value.checked === false ? "☐" : value.marker} ` : ""}
      {inlines(value.inlines)}</Text>;
  };
  const expandedHeader = (exportImage?: ReactNode) => <View style={styles.toolbar}>
    <Text numberOfLines={1} style={[styles.body, styles.fill, { color: colors.ink }]}>
      {mobileMessage(locale, expanded?.type === "math" ? "markdown.math" : "markdown.diagram")}
    </Text>
    {expanded?.type === "mermaid" && <Pressable accessibilityRole="button" onPress={() => {
      diagramScope.current?.abort();
      diagramScope.current = viewDiagramSource ? new AbortController() : undefined;
      setViewDiagramSource(!viewDiagramSource);
    }} style={styles.action}>
      <Text style={{ color: colors.accent }}>{mobileMessage(locale, viewDiagramSource ? "markdown.diagram" : "markdown.source")}</Text>
    </Pressable>}
    {exportImage}
    <Pressable accessibilityRole="button" onPress={closeExpanded} style={styles.action}>
      <Text style={{ color: colors.accent }}>{mobileMessage(locale, "common.close")}</Text>
    </Pressable>
  </View>;
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
    <Modal visible={expanded !== undefined} animationType="fade"
      supportedOrientations={["portrait", "landscape"]} onRequestClose={closeExpanded} onDismiss={deliverDiagram}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}>
        {expanded?.type === "mermaid" && !viewDiagramSource ? <MobileMarkdownRichBlock kind="mermaid"
          source={expanded.text} colors={colors} locale={locale} ownerKey={`${ownerKey}/expanded/${expanded.key}`} zoomable
          diagramScope={diagramScope.current?.signal} renderHeader={expandedHeader}
          onAnnotateImage={onAnnotateDiagram && ((image) => {
            diagramHandoff.current = { ownerKey, open: () => onAnnotateDiagram(image) };
            hideExpanded();
          })} />
          : expanded && <>
          {expandedHeader()}
          <ScrollView contentContainerStyle={styles.expanded}>
            {expanded.type === "math" && <MobileMarkdownRichBlock kind="math" source={expanded.text} colors={colors}
              locale={locale} ownerKey={`${ownerKey}/expanded/${expanded.key}`} zoomable />}
            {toolbar(expanded.text, mobileMessage(locale, "markdown.source"))}
            <Text selectable style={[styles.code, { color: colors.ink }]}>{expanded.text}</Text>
          </ScrollView>
        </>}
      </SafeAreaView>
    </Modal>
  </View>;
});

const TABLE_CELL_PADDING = 10;
const TABLE_MIN_COLUMN_WIDTH = 96;
const TABLE_MAX_TEXT_WIDTH = 220;
const WIDE_TABLE_GLYPH = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}\uFF00-\uFFEF]/u;

function MobileMarkdownTable({ table, colors, label, rendersInlineImage, renderCell }: {
  readonly table: Extract<MobileMarkdownBlock, { type: "table" }>;
  readonly colors: MobileMarkdownColors;
  readonly label: string;
  readonly rendersInlineImage: (inline: MobileMarkdownInline) => boolean;
  readonly renderCell: (cell: readonly MobileMarkdownInline[], header: boolean) => ReactNode;
}) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const rows = useMemo(() => [table.header, ...table.rows.map((row) => row.cells)], [table]);
  const preferredWidths = useMemo(() => {
    const widths: number[] = [];
    for (const row of rows) {
      row.forEach((cell, column) => {
        const preferred = preferredTableCellWidth(cell, fontScale, rendersInlineImage);
        widths[column] = Math.max(widths[column] ?? TABLE_MIN_COLUMN_WIDTH, preferred);
      });
    }
    return widths;
  }, [rows, fontScale, rendersInlineImage]);
  const minimumWidth = preferredWidths.reduce((total, width) => total + width, 0);
  const extraWidth = Math.max(0, viewportWidth - minimumWidth);
  const extraPerColumn = Math.floor(extraWidth / preferredWidths.length);
  const extraRemainder = extraWidth % preferredWidths.length;
  const widths = preferredWidths.map((width, column) =>
    width + extraPerColumn + (column < extraRemainder ? 1 : 0));
  return <View style={[styles.frame, { borderColor: colors.border }]}>
    <ScrollView horizontal nestedScrollEnabled scrollEnabled={viewportWidth === 0 || minimumWidth > viewportWidth}
      onLayout={(event) => setViewportWidth(Math.floor(event.nativeEvent.layout.width))}>
      <View accessibilityLabel={label}>
        {rows.map((cells, row) => <View key={row}
          style={[styles.tableRow, row === 0 && { backgroundColor: colors.background }]}>
          {cells.map((cell, column) => <View key={column}
            style={[styles.cell, { width: widths[column], borderColor: colors.border }]}>
            {renderCell(cell, row === 0)}
          </View>)}
        </View>)}
      </View>
    </ScrollView>
  </View>;
}

function preferredTableCellWidth(cell: readonly MobileMarkdownInline[], fontScale: number,
  rendersInlineImage: (inline: MobileMarkdownInline) => boolean): number {
  const inset = TABLE_CELL_PADDING * 2 + 1;
  let characters = 0;
  let imageWidth = 0;
  for (const inline of cell) {
    if (inline.type === "image" && rendersInlineImage(inline)) {
      imageWidth = Math.max(imageWidth, mobileMarkdownInlineImageSize(inline).width);
      continue;
    }
    const text = inline.type === "image" ? inline.alt || "Image"
      : inline.type === "math" ? latexToUnicodeApproximation(inline.text) : inline.text;
    for (const char of text) characters += WIDE_TABLE_GLYPH.test(char) ? 2 : 1;
  }
  const textWidth = Math.min(TABLE_MAX_TEXT_WIDTH, Math.ceil(characters * 8 * fontScale) + inset);
  return Math.max(TABLE_MIN_COLUMN_WIDTH, Math.ceil(imageWidth) + inset, textWidth);
}

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
  if (failed) return <Text accessibilityRole={open ? "button" : undefined} accessibilityLabel={label} onPress={open}
    style={{ color: colors.muted, ...(open ? { textDecorationLine: "underline" as const } : {}) }}>{label}</Text>;
  return <Pressable accessibilityRole={open ? "button" : "image"} accessibilityLabel={label} onPress={open}
    disabled={!open} style={size}>
    <NativeImage source={{ uri: image.uri }} accessibilityLabel={label} accessible={false} contentFit="cover" cachePolicy="none"
      style={[size, { borderRadius: 6, backgroundColor: colors.background }]}
      onLoad={(event) => {
        if (alive.current && (!mobileImageGalleryDimensionsMatch(image, event.source.width, event.source.height) || event.source.isAnimated)) setFailed(true);
      }}
      onError={() => { if (alive.current) setFailed(true); }} />
  </Pressable>;
}

interface DiagramPngRequest {
  readonly owner: object;
  readonly id: string;
  readonly abort: AbortController;
  receive?: (raw: string) => void;
}

function MobileMarkdownRichBlock({ kind, source, colors, locale, ownerKey, zoomable = false, diagramScope, renderHeader, onAnnotateImage }: {
  readonly kind: "math" | "mermaid"; readonly source: string; readonly colors: MobileMarkdownColors;
  readonly locale: MobileSupportedLocale; readonly ownerKey: string; readonly zoomable?: boolean;
  readonly diagramScope?: AbortSignal;
  readonly renderHeader?: (exportButton: ReactNode) => ReactNode;
  readonly onAnnotateImage?: (image: MobileImageOutputSource) => void;
}) {
  const [height, setHeight] = useState(kind === "mermaid" ? 220 : 80);
  const [failed, setFailed] = useState(false);
  const [readyToken, setReadyToken] = useState<string>();
  const [imageAction, setImageAction] = useState<"share" | "annotate">();
  const [shareNotice, setShareNotice] = useState<{ readonly owner: object; readonly message: string }>();
  const webView = useRef<WebView>(null);
  const alive = useRef(true);
  const pending = useRef<DiagramPngRequest | undefined>(undefined);
  const fillsViewport = kind === "mermaid" && zoomable;
  const id = useMemo(() => randomUUID(), [colors, kind, source, ownerKey, zoomable]);
  const release = useCallback(() => {
    pending.current?.abort.abort();
    setReadyToken(undefined);
  }, []);
  const failure = useCallback(() => setFailed(true), []);
  const lifecycle = useMobilePreviewResourceLifecycle({ ownerKey: id, releaseRenderer: release, reportFailure: failure });
  const token = lifecycle.rendererToken;
  const owner = useMemo(() => ({ id, token, diagramScope }), [id, token, diagramScope]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const html = useMemo(() => source.length > 100_000 ? undefined
    : buildMobileMarkdownRichHtml({ instanceId: id, kind, source, colors, zoomable }, richRuntime), [colors, id, kind, source, zoomable]);
  useEffect(() => { setFailed(false); }, [id]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; pending.current?.abort.abort(); };
  }, []);
  useEffect(() => () => { if (pending.current?.owner === owner) pending.current.abort.abort(); }, [owner]);

  const canExport = fillsViewport && !!html && !failed && !!diagramScope && !diagramScope.aborted
    && readyToken !== undefined && readyToken === token && lifecycle.rendererMounted;
  const exportDiagram = async (action: "share" | "annotate"): Promise<void> => {
    const view = webView.current;
    if (!canExport || !view || !diagramScope || pending.current || (action === "annotate" && !onAnnotateImage)) return;
    const request = { owner, id: randomUUID(), abort: new AbortController() };
    const signal = request.abort.signal;
    const retire = () => request.abort.abort();
    const assertCurrent = () => {
      signal.throwIfAborted();
      diagramScope.throwIfAborted();
      if (!alive.current || currentOwner.current !== owner || pending.current !== request
        || webView.current !== view || !lifecycle.ownsRenderer(token) || AppState.currentState !== "active") {
        throw new Error("The original diagram is no longer available.");
      }
    };
    pending.current = request;
    diagramScope.addEventListener("abort", retire, { once: true });
    setImageAction(action);
    setShareNotice(undefined);
    let dispatched = false;
    try {
      assertCurrent();
      const base64 = await renderDiagramPng(view, id, request);
      assertCurrent();
      const bytes = decodeMobileBase64(base64, MOBILE_MARKDOWN_DIAGRAM_PNG_MAXIMUM_BYTES);
      const { width, height } = inspectMobileImageOutputBytes(bytes, "image/png");
      const image: MobileImageOutputSource = { leaseId: request.id, fileName: "Joko-diagram.png", mediaType: "image/png",
        byteSize: bytes.byteLength, sha256Hex: bytesToHex(sha256(bytes)), bytes, width, height
      };
      if (action === "annotate") onAnnotateImage?.(image);
      else await mobileImageOutput.perform("share", image, undefined, signal, () => { assertCurrent(); dispatched = true; });
    } catch {
      if (alive.current && currentOwner.current === owner && !signal.aborted && !diagramScope.aborted) {
        setShareNotice({ owner, message: mobileMessage(locale, action === "annotate" ? "image.previewFailed" : dispatched ? "share.unknown" : "share.failed") });
      }
    } finally {
      diagramScope.removeEventListener("abort", retire);
      if (pending.current === request) {
        pending.current = undefined;
        if (alive.current) setImageAction(undefined);
      }
    }
  };

  const fallback = <>
    <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "markdown.sourceFallback")}</Text>
    <Text selectable style={[styles.code, { color: colors.ink }]}>{source}</Text>
  </>;
  const content = html && !failed && lifecycle.rendererMounted
    ? <View style={fillsViewport ? styles.fill : { height: zoomable ? Math.max(320, height) : height }}>
    <WebView ref={webView} key={token} source={{ html }} originWhitelist={["about:blank"]}
      style={[styles.fill, { backgroundColor: colors.surface }]}
      javaScriptEnabled domStorageEnabled={false} cacheEnabled={false} incognito
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never" setSupportMultipleWindows={false} scrollEnabled={zoomable} nestedScrollEnabled
      onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      onMessage={(event) => {
        if (!lifecycle.ownsRenderer(token)) return;
        const raw = event.nativeEvent.data;
        const status = parseMobileMarkdownRichStatus(raw, id);
        if (!status) {
          if (pending.current?.owner === owner) pending.current.receive?.(raw);
          return;
        }
        if (!fillsViewport) setHeight(status.height);
        if (status.state === "error") { release(); setFailed(true); }
        else if (status.state === "ready") {
          if (fillsViewport) setReadyToken(token);
          lifecycle.onRendererReady(token);
        }
      }}
      onError={() => { if (lifecycle.ownsRenderer(token)) { release(); setFailed(true); } }}
      onContentProcessDidTerminate={() => { lifecycle.onRendererProcessLost(token); }}
      onRenderProcessGone={() => { lifecycle.onRendererProcessLost(token); }} />
  </View>
    : fillsViewport ? <ScrollView style={styles.fill} contentContainerStyle={styles.fallback}>{fallback}</ScrollView>
      : <View style={styles.fallback}>{fallback}</View>;
  return <>
    {renderHeader?.(<>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canExport || imageAction !== undefined, busy: imageAction === "share" }}
        disabled={!canExport || imageAction !== undefined} onPress={() => void exportDiagram("share")} style={styles.action}>
        <Text style={{ color: canExport && imageAction === undefined ? colors.accent : colors.muted }}>
          {mobileMessage(locale, imageAction === "share" ? "markdown.exportingImage" : "markdown.exportImage")}
        </Text>
      </Pressable>
      {onAnnotateImage && <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canExport || imageAction !== undefined, busy: imageAction === "annotate" }}
        disabled={!canExport || imageAction !== undefined} onPress={() => void exportDiagram("annotate")} style={styles.action}>
        <Text style={{ color: canExport && imageAction === undefined ? colors.accent : colors.muted }}>{mobileMessage(locale, "image.annotate")}</Text>
      </Pressable>}
    </>)}
    {content}
    {shareNotice?.owner === owner && <Text accessibilityLiveRegion="polite" role="alert"
      style={[styles.fallback, styles.caption, { color: colors.negative }]}>{shareNotice.message}</Text>}
  </>;
}

function renderDiagramPng(view: WebView, instanceId: string, request: DiagramPngRequest): Promise<string> {
  const signal = request.abort.signal;
  return new Promise((resolve, reject) => {
    const finish = (base64?: string) => {
      request.receive = undefined;
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      if (base64 === undefined) reject(new Error("The original diagram image was unavailable."));
      else resolve(base64);
    };
    const cancel = () => finish();
    const timeout = setTimeout(cancel, 10_000);
    request.receive = (raw) => {
      const receipt = parseMobileMarkdownDiagramPng(raw, instanceId, request.id);
      if (receipt !== undefined) finish("base64" in receipt ? receipt.base64 : undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try { view.injectJavaScript(requestMobileMarkdownDiagramPngScript(request.id)); }
    catch { cancel(); }
  });
}

const styles = StyleSheet.create({
  document: { gap: 12 }, fill: { flex: 1 }, body: { fontSize: 15, lineHeight: 23 },
  // A fixed text line height lets Android inline views overflow neighboring text and hit targets.
  inlineImageBody: { fontSize: 15 },
  strong: { fontWeight: "700" }, emphasis: { fontStyle: "italic" }, strike: { textDecorationLine: "line-through" },
  inlineCode: { fontFamily: "monospace", fontSize: 13 }, code: { fontFamily: "monospace", fontSize: 13, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 18 }, frame: { borderWidth: 1, borderRadius: 8, overflow: "hidden" },
  toolbar: { minHeight: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, gap: 8 },
  action: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center", alignItems: "center" },
  codeContent: { padding: 12 }, tableRow: { flexDirection: "row" }, cell: { padding: TABLE_CELL_PADDING, borderRightWidth: 1, borderBottomWidth: 1 },
  quote: { borderLeftWidth: 3, paddingLeft: 12 }, fallback: { padding: 12, gap: 6 }, expanded: { padding: 12, gap: 12 }
});
