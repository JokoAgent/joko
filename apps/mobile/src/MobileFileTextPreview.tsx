import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Linking, Platform, Pressable, StyleSheet, Text, View, type TextLayoutEvent } from "react-native";
import { WebView } from "react-native-webview";
import type { MobileFilePreview } from "./workspace-files";
import type { MobileClient } from "./mobile-client";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { buildMobileFileMarkdownHtml, mobileFileMarkdownImagesScript } from "./mobile-file-markdown-html";
import type { MobileMarkdownColors } from "./mobile-markdown-rich-html";
import type { MobileMarkdownResourceDescriptor } from "./mobile-markdown-resources";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";
import richRuntime from "./rich-markdown-runtime.richjs";
import { mobileFileTextSource } from "./mobile-file-text-source";
import { MobileFileHtmlPreview, type MobileFileHtmlClient } from "./MobileFileHtmlPreview";

type TextPreview = Extract<MobileFilePreview, { kind: "text" }>;
type ResourceClient = Pick<MobileClient, "filesMarkdownResourceOwnerKey" | "prepareFilesMarkdownResources" | "assertMarkdownResourcesCurrent" | "releaseMarkdownResources" | "subscribe"> & MobileFileHtmlClient;
interface Props { readonly preview: TextPreview; readonly locale: MobileSupportedLocale; readonly colors: MobileMarkdownColors; readonly client?: ResourceClient;
  readonly actions?: { readonly busy: boolean; quote(text: string): void; copySource(): void; cancel(): void };
  readonly onViewChange?: (view: "rendered" | "source") => void }

export function MobileFileTextPreview(props: Props) {
  const p = props.preview;
  return <FileTextPage key={JSON.stringify([p.sourceLabel, p.fileName, p.revisionKey, p.focusLine, p.focusColumn, p.startByte.toString(), p.text])} {...props} />;
}

function FileTextPage({ preview, locale, colors, client, onViewChange, actions }: Props) {
  const markdown = /\.(?:md|mdx|markdown)$/iu.test(preview.fileName ?? preview.workspaceEntry?.relativePath ?? preview.sourceLabel)
    || /^text\/(?:markdown|x-markdown)(?:;|$)/iu.test(preview.mediaType);
  const html = /\.html?$/iu.test(preview.fileName ?? preview.workspaceEntry?.relativePath ?? preview.sourceLabel) || /^text\/html(?:;|$)/iu.test(preview.mediaType);
  const [view, setView] = useState<"rendered" | "source">(markdown || html ? "rendered" : "source");
  useEffect(() => { onViewChange?.(view); }, [onViewChange, view]);
  const visibleSource = useMemo(() => mobileFileTextSource(preview.text), [preview.text]); const lines = visibleSource.lines;
  const focusIndex = preview.startByte === 0n && preview.focusLine && Number.isSafeInteger(preview.focusLine)
    && preview.focusLine > 0 && preview.focusLine <= lines.length ? preview.focusLine - 1 : undefined;
  const list = useRef<FlatList<string>>(null); const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const alive = useRef(true); const jumped = useRef(false); const retries = useRef(0); const focusY = useRef(0);
  const focus = useCallback(() => { if (alive.current && focusIndex !== undefined) list.current?.scrollToIndex({
    index: focusIndex, animated: false, viewPosition: 0.3, viewOffset: -focusY.current }); }, [focusIndex]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; timers.current.forEach(clearTimeout); }; }, []);
  const onFocusLayout = (event: TextLayoutEvent) => {
    if (focusIndex === undefined || jumped.current) return;
    const text = lines[focusIndex]!; const column = Math.min(text.length, Math.max(0, (preview.focusColumn ?? 1) - 1));
    let cursor = 0;
    for (const line of event.nativeEvent.lines) {
      const start = line.text ? text.indexOf(line.text, cursor) : cursor;
      if (start < 0 || start > column) break;
      focusY.current = line.y; cursor = start + line.text.length;
    }
    jumped.current = true; focus();
  };
  return <View style={styles.fill}>
    {preview.truncated && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "preview.truncated")}</Text>}
    {visibleSource.clipped && (view === "source" || markdown) && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.muted }]}>
      {mobileMessage(locale, "files.preview.lineLimit", { count: 5_000 })}</Text>}
    {preview.focusLine && <Text accessibilityRole={focusIndex === undefined ? "alert" : "text"} style={[styles.notice, { color: colors.muted }]}>
      {mobileMessage(locale, focusIndex === undefined ? "preview.lineOutsideWindow" : "preview.focusLine", { line: preview.focusLine })}</Text>}
    {(markdown || html) && <View style={[styles.toolbar, { borderColor: colors.border }]}>
      {(["rendered", "source"] as const).map((mode) => <Pressable key={mode} accessibilityRole="button"
        accessibilityLabel={mobileMessage(locale, mode === "rendered" ? "files.preview.rendered" : "files.preview.source")} accessibilityState={{ selected: view === mode }} onPress={() => { actions?.cancel(); setView(mode); }}
        style={[styles.mode, { backgroundColor: view === mode ? colors.surface : colors.background }]}>
        <Text style={{ color: view === mode ? colors.ink : colors.muted }}>{mobileMessage(locale, mode === "rendered" ? "files.preview.rendered" : "files.preview.source")}</Text>
      </Pressable>)}
    </View>}
    {view === "source" && actions && <View style={styles.toolbar}>
      <Pressable accessibilityRole="button" disabled={actions.busy || !visibleSource.text} accessibilityState={{ disabled: actions.busy || !visibleSource.text }}
        accessibilityLabel={mobileMessage(locale, preview.truncated || visibleSource.clipped ? "files.preview.copyPreviewSource" : "files.preview.copySource")}
        onPress={actions.copySource} style={styles.mode}>
        <Text style={{ color: actions.busy ? colors.muted : colors.accent }}>{mobileMessage(locale, preview.truncated || visibleSource.clipped ? "files.preview.copyPreviewSource" : "files.preview.copySource")}</Text>
      </Pressable>
    </View>}
    {view === "rendered" && lines.length === 0 && <Text style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "preview.emptyFile")}</Text>}
    {view === "rendered" && html ? <MobileFileHtmlPreview preview={preview} locale={locale} colors={colors} client={client} /> : view === "rendered" ? <FileMarkdownReader preview={preview} text={lines.join("\n")} locale={locale} colors={colors} client={client}
      actions={actions}
      focusLine={focusIndex === undefined ? undefined : preview.focusLine} /> : lines.length === 0 ? <Text style={[styles.notice, { color: colors.muted }]}>
        {mobileMessage(locale, "preview.emptyFile")}</Text> : <FlatList ref={list} data={lines} initialNumToRender={40} maxToRenderPerBatch={40} windowSize={9}
        keyExtractor={(_line, index) => String(index)} style={styles.fill} contentContainerStyle={styles.sourceContent}
        onLayout={() => { if (focusIndex !== undefined && !jumped.current) timers.current.push(setTimeout(focus, 60)); }}
        onScrollToIndexFailed={(info) => {
          if (!alive.current || retries.current >= 2 || info.index !== focusIndex) return;
          retries.current += 1; list.current?.scrollToOffset({ animated: false, offset: info.averageItemLength * info.index });
          timers.current.push(setTimeout(focus, 220));
        }} renderItem={({ item, index }) => <View style={[styles.line, index === focusIndex && { backgroundColor: colors.surface }]}>
          <Text accessible={false} selectable={false} style={[styles.lineNumber, { color: colors.muted, minWidth: String(lines.length).length * 9 + 12 }]}>{index + 1}</Text>
          <Text selectable onTextLayout={index === focusIndex ? onFocusLayout : undefined} style={[styles.text, { color: colors.ink }]}>{item || " "}</Text>
        </View>} />}
  </View>;
}

function FileMarkdownReader({ preview, text, colors, locale, client, focusLine, actions }: Props & { readonly text: string; readonly focusLine?: number }) {
  const [resources, setResources] = useState<MobileMarkdownResourceDescriptor>(); const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState(""); const [readyToken, setReadyToken] = useState<string>(); const webView = useRef<WebView>(null);
  const actionRef = useRef(actions); actionRef.current = actions;
  const current = useRef(preview); current.current = preview;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const work = useRef<{ controller: AbortController; descriptor?: MobileMarkdownResourceDescriptor } | undefined>(undefined);
  const stop = useCallback(() => {
    work.current?.controller.abort(); if (work.current?.descriptor) client?.releaseMarkdownResources(work.current.descriptor.leaseId);
    work.current = undefined; setResources(undefined);
  }, [client]);
  const ownerKey = JSON.stringify([preview.sourceLabel, preview.revisionKey]);
  const lifecycle = useMobilePreviewResourceLifecycle({ ownerKey, releaseRenderer: stop, reportFailure: useCallback(() => setFailed(true), []) });
  const token = lifecycle.rendererToken;
  useEffect(() => () => actionRef.current?.cancel(), [token]);
  const ownsRenderer = (candidate: string) => alive.current && current.current === preview && AppState.currentState === "active" && lifecycle.ownsRenderer(candidate);
  useEffect(() => {
    const owner = client?.filesMarkdownResourceOwnerKey(preview);
    if (!client || !owner || !lifecycle.rendererMounted) return;
    const request = { controller: new AbortController(), descriptor: undefined as MobileMarkdownResourceDescriptor | undefined }; work.current = request;
    const unsubscribe = client.subscribe(() => {
      if (client.filesMarkdownResourceOwnerKey(preview) !== owner) stop();
      else if (request.descriptor?.references.size) { try { client.assertMarkdownResourcesCurrent(request.descriptor.leaseId); } catch { stop(); } }
    });
    void client.prepareFilesMarkdownResources(preview, request.controller.signal).then((result) => {
      if (work.current !== request || request.controller.signal.aborted || current.current !== preview || AppState.currentState !== "active") {
        client.releaseMarkdownResources(result.leaseId); return;
      }
      try { if (result.references.size) client.assertMarkdownResourcesCurrent(result.leaseId); }
      catch { client.releaseMarkdownResources(result.leaseId); return; }
      request.descriptor = result; setResources(result);
    }).catch(() => { if (work.current === request) stop(); });
    return () => { unsubscribe(); stop(); };
  }, [client, lifecycle.rendererGeneration, lifecycle.rendererMounted, preview, stop]);
  const html = useMemo(() => buildMobileFileMarkdownHtml({ text, colors, focusLine, label: preview.title }, richRuntime),
    [colors, focusLine, preview.title, text]);
  useEffect(() => {
    if (alive.current && readyToken === token && lifecycle.ownsRenderer(token)) webView.current?.injectJavaScript(mobileFileMarkdownImagesScript(resources));
  }, [lifecycle.ownsRenderer, readyToken, resources, token]);
  if (failed) return <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "files.preview.renderFailed")}</Text>;
  if (!lifecycle.rendererMounted) return <View style={styles.fill} />;
  return <View style={styles.fill}>{notice && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{notice}</Text>}
    <WebView ref={webView} key={token} source={{ baseUrl: "about:blank", html }} originWhitelist={["*"]} style={[styles.fill, { backgroundColor: colors.background }]}
    scrollEnabled javaScriptEnabled allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
    sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} domStorageEnabled={false} setSupportMultipleWindows={false}
    menuItems={actions && !actions.busy ? [{ key: "joko-file-quote", label: mobileMessage(locale, "files.preview.quoteSelection") }] : undefined}
    onCustomMenuSelection={(event) => {
      if (!actions || actions.busy || readyToken !== token || !ownsRenderer(token) || event.nativeEvent.key !== "joko-file-quote") return;
      const text = event.nativeEvent.selectedText;
      if (typeof text !== "string" || !text.trim()) return;
      if (text.length > 4_000) { setNotice(mobileMessage(locale, "files.preview.quoteTooLarge")); return; }
      setNotice(""); actions.quote(text);
    }}
    onShouldStartLoadWithRequest={(request) => {
      if (!ownsRenderer(token)) return false;
      if (request.url === "about:blank") return true;
      try { const url = new URL(request.url); if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
        void Linking.openURL(request.url).catch(() => { if (ownsRenderer(token)) setNotice(mobileMessage(locale, "markdown.linkFailed")); });
      } } catch { /* Only explicit web links can leave this document. */ }
      return false;
    }} onLoad={() => { if (ownsRenderer(token)) { lifecycle.onRendererReady(token); setReadyToken(token); } }}
    onError={() => { if (ownsRenderer(token)) { actionRef.current?.cancel(); stop(); setFailed(true); } }}
    onContentProcessDidTerminate={() => { if (ownsRenderer(token)) { actionRef.current?.cancel(); lifecycle.onRendererProcessLost(token); } }}
    onRenderProcessGone={() => { if (ownsRenderer(token)) { actionRef.current?.cancel(); lifecycle.onRendererProcessLost(token); } }} />
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, notice: { paddingHorizontal: 16, paddingVertical: 6 }, toolbar: { flexDirection: "row", gap: 6, paddingHorizontal: 16, borderBottomWidth: 1 },
  mode: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 16, marginBottom: 8 },
  sourceContent: { paddingHorizontal: 12, paddingBottom: 36 }, line: { flexDirection: "row", alignItems: "flex-start", minHeight: 20 },
  lineNumber: { fontSize: 12, lineHeight: 20, textAlign: "right", paddingRight: 12, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) },
  text: { flex: 1, fontSize: 13, lineHeight: 20, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) }
});
