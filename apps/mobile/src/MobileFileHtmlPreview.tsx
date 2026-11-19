import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import type { WebViewNavigation } from "react-native-webview/lib/WebViewTypes";
import type { MobileClient } from "./mobile-client";
import type { MobileFilePreview } from "./workspace-files";
import { workspaceParentPath } from "./workspace-files";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileMarkdownColors } from "./mobile-markdown-rich-html";
import { mobileMessage } from "./mobile-messages";
import { allowMobileHtmlNavigation, allowMobileHtmlWebsiteNavigation, isMobileHtmlDocumentPath, mobileFileHtmlComplete,
  mobileHtmlWebsiteAddress, resolveMobileHtmlDocumentLink, withHtmlPreviewCsp, type MobileHtmlDocumentLocation } from "./mobile-file-html";
import { collectHtmlLocalResourceRefs, planHtmlResourceFetches } from "./mobile-file-html-resources";
import type { MobileFileHtmlDescriptor } from "./mobile-file-html-reader";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";

export type MobileFileHtmlClient = Pick<MobileClient, "filesHtmlResourceOwnerKey" | "prepareFilesHtmlResources" | "assertFilesHtmlResourcesCurrent" | "releaseFilesHtmlResources" | "subscribe">;
interface Props {
  readonly preview: Extract<MobileFilePreview, { kind: "text" }>;
  readonly client?: MobileFileHtmlClient; readonly colors: MobileMarkdownColors; readonly locale: MobileSupportedLocale;
  readonly workspaceNavigation?: boolean; readonly actionsDisabled?: boolean;
}
const MAXIMUM_HISTORY = 64;

export function MobileFileHtmlPreview({ preview, client, colors, locale, workspaceNavigation, actionsDisabled }: Props) {
  const complete = mobileFileHtmlComplete(preview);
  const sourcePath = workspaceNavigation && client && complete && preview.workspaceEntry
    && isMobileHtmlDocumentPath(preview.workspaceEntry.relativePath, preview.workspaceEntry.relativePath)
    ? preview.workspaceEntry.relativePath : undefined;
  const [history, setHistory] = useState<{ entries: readonly MobileHtmlDocumentLocation[]; index: number }>(() => ({
    entries: sourcePath ? [{ path: sourcePath, fragment: "" }] : [], index: 0
  }));
  const location = history.entries[history.index];
  const [reload, setReload] = useState(0);
  const [website, setWebsite] = useState<string>();
  const currentWebsite = useRef(website); currentWebsite.current = website;
  const plan = useMemo(() => planHtmlResourceFetches(collectHtmlLocalResourceRefs(preview.text,
    preview.workspaceEntry ? workspaceParentPath(preview.workspaceEntry.relativePath) : "")), [preview]);
  const [loaded, setLoaded] = useState<{ token: string; descriptor: MobileFileHtmlDescriptor }>();
  const [failed, setFailed] = useState(false);
  const alive = useRef(true); const current = useRef(preview); current.current = preview;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const work = useRef<{ controller: AbortController; descriptor?: MobileFileHtmlDescriptor } | undefined>(undefined);
  const stop = useCallback(() => {
    work.current?.controller.abort(); if (work.current?.descriptor) client?.releaseFilesHtmlResources(work.current.descriptor.leaseId);
    work.current = undefined; setLoaded(undefined);
  }, [client]);
  const lifecycle = useMobilePreviewResourceLifecycle({ ownerKey: JSON.stringify([preview.sourceLabel, preview.revisionKey, history.index, location, reload, website !== undefined]),
    releaseRenderer: stop, reportFailure: useCallback(() => setFailed(true), []) });
  const token = lifecycle.rendererToken;
  const prepared = loaded?.token === token ? loaded.descriptor : undefined;
  const ownsPreview = () => alive.current && current.current === preview && AppState.currentState === "active"
    && (!client || !!client.filesHtmlResourceOwnerKey(preview));
  const ownsRenderer = () => ownsPreview() && lifecycle.ownsRenderer(token) && (!location || !!prepared && work.current?.descriptor === prepared);
  useEffect(() => {
    if (website || !complete || !client || !lifecycle.rendererMounted) return;
    const owner = client.filesHtmlResourceOwnerKey(preview);
    if (!owner) { setFailed(true); return; }
    const request = { controller: new AbortController(), descriptor: undefined as MobileFileHtmlDescriptor | undefined }; work.current = request;
    const unsubscribe = client.subscribe(() => {
      if (client.filesHtmlResourceOwnerKey(preview) !== owner) { stop(); if (alive.current) setFailed(true); }
      else if (request.descriptor) { try { client.assertFilesHtmlResourcesCurrent(request.descriptor.leaseId); }
        catch { stop(); if (alive.current) setFailed(true); } }
    });
    void client.prepareFilesHtmlResources(preview, request.controller.signal, location?.path).then((result) => {
      if (work.current !== request || request.controller.signal.aborted || current.current !== preview || AppState.currentState !== "active") {
        client.releaseFilesHtmlResources(result.leaseId); return;
      }
      try { client.assertFilesHtmlResourcesCurrent(result.leaseId); } catch { client.releaseFilesHtmlResources(result.leaseId); stop(); setFailed(true); return; }
      request.descriptor = result; setLoaded({ token, descriptor: result });
    }).catch(() => { if (work.current === request) { stop(); if (alive.current) setFailed(true); } });
    return () => { unsubscribe(); stop(); };
  }, [client, complete, lifecycle.rendererMounted, location?.path, preview, stop, token, website]);
  useEffect(() => {
    if (!website || !client) return;
    return client.subscribe(() => {
      if (!client.filesHtmlResourceOwnerKey(preview)) setWebsite(undefined);
    });
  }, [client, preview, website]);
  const rawHtml = location ? prepared?.html : !plan.targets.length ? preview.text : prepared?.html ?? (!client ? preview.text : undefined);
  const html = useMemo(() => rawHtml === undefined ? undefined : withHtmlPreviewCsp(rawHtml,
    location && prepared ? { token: prepared.leaseId, fragment: location.fragment } : undefined), [rawHtml, location, prepared]);
  const documentState = useRef({ html, token, settled: false });
  if (documentState.current.html !== html || documentState.current.token !== token) documentState.current = { html, token, settled: false };
  const selectHistory = (index: number) => {
    if (actionsDisabled || !ownsPreview() || !history.entries[index]) return;
    stop(); setFailed(false); setHistory({ ...history, index });
  };
  const openDocument = (data: string) => {
    if (actionsDisabled || !sourcePath || !location || !prepared || !ownsRenderer() || data.length > 16_384) return;
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!Array.isArray(message) || message.length !== 2 || message[0] !== prepared.leaseId || typeof message[1] !== "string") return;
    const next = resolveMobileHtmlDocumentLink(sourcePath, location.path, message[1]);
    if (!next || next.path === location.path && next.fragment === location.fragment) return;
    const entries = [...history.entries.slice(0, history.index + 1), next].slice(-MAXIMUM_HISTORY);
    stop(); setFailed(false); setHistory({ entries, index: entries.length - 1 });
  };
  if (!complete) return <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "files.preview.htmlCompleteRequired")}</Text>;
  if (website && lifecycle.rendererMounted && ownsPreview()) {
    return <MobileHtmlWebsitePreview startUrl={website} colors={colors} locale={locale}
      ownsSurface={() => currentWebsite.current === website && ownsPreview() && lifecycle.ownsRenderer(token)}
      onReady={() => lifecycle.onRendererReady(token)} onReturn={() => {
        currentWebsite.current = undefined; setFailed(false); setWebsite(undefined);
      }} />;
  }
  const failedCount = prepared?.failed ?? (!client ? plan.targets.length : 0);
  const skippedCount = (prepared?.overLimit ?? (location ? 0 : plan.skipped)) + (prepared?.overBudget ?? 0);
  return <View style={styles.fill}>
    {location && <MobileHtmlBrowserControls address={location.path + location.fragment} colors={colors} locale={locale}
      disabled={actionsDisabled || lifecycle.phase === "suspended"}
      onBack={history.index > 0 ? () => selectHistory(history.index - 1) : undefined}
      onForward={history.index + 1 < history.entries.length ? () => selectHistory(history.index + 1) : undefined}
      onReload={() => {
        if (!ownsPreview()) return;
        stop(); setFailed(false); setReload((value) => value + 1);
      }}
      onNavigate={(input) => {
        if (!ownsPreview()) return false;
        if (input.trim() === location.path + location.fragment) return true;
        const url = mobileHtmlWebsiteAddress(input);
        if (!url) return false;
        stop(); setFailed(false); setWebsite(url); return true;
      }} />}
    {failed ? <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "files.preview.renderFailed")}</Text>
      : !lifecycle.rendererMounted ? <View style={styles.fill} />
      : html === undefined ? <Text accessibilityRole="progressbar" style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "files.preview.htmlResourcesLoading")}</Text>
      : <>
    {failedCount > 0 && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "files.preview.htmlResourcesFailed", { count: failedCount })}</Text>}
    {skippedCount > 0 && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "files.preview.htmlResourcesLimit", { count: skippedCount })}</Text>}
    <WebView key={token} source={{ baseUrl: "about:blank", html }} originWhitelist={["*"]} style={[styles.fill, { backgroundColor: colors.background }]}
      scrollEnabled javaScriptEnabled javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} mediaCapturePermissionGrantType="deny"
      sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} domStorageEnabled={false} incognito cacheEnabled={false}
      onShouldStartLoadWithRequest={(request) => ownsRenderer() && allowMobileHtmlNavigation(request.url ?? "", documentState.current.settled)}
      {...(location ? { onMessage: (event: { nativeEvent: { data: string } }) => openDocument(event.nativeEvent.data) } : {})}
      onLoadEnd={() => { if (ownsRenderer()) { documentState.current.settled = true; lifecycle.onRendererReady(token); } }}
      onError={() => { if (ownsRenderer()) { stop(); setFailed(true); } }}
      onContentProcessDidTerminate={() => { if (ownsRenderer()) lifecycle.onRendererProcessLost(token); }}
      onRenderProcessGone={() => { if (ownsRenderer()) lifecycle.onRendererProcessLost(token); }} />
    </>}
  </View>;
}

type BrowserColors = { readonly colors: MobileMarkdownColors; readonly locale: MobileSupportedLocale };

function MobileHtmlWebsitePreview({ startUrl, colors, locale, ownsSurface, onReady, onReturn }: BrowserColors & {
  readonly startUrl: string; ownsSurface(): boolean; onReady(): void; onReturn(): void;
}) {
  const web = useRef<WebView>(null);
  const [source, setSource] = useState({ uri: startUrl });
  const [navigation, setNavigation] = useState<WebViewNavigation>();
  const [failed, setFailed] = useState(false);
  const pending = useRef<{ uri: string; previousUrl: string } | undefined>(undefined);
  const address = navigation?.url ?? source.uri;
  const reloadPage = () => {
    if (!ownsSurface()) return;
    if (failed) { setNavigation(undefined); setSource({ uri: address }); }
    else web.current?.reload();
    setFailed(false);
  };
  const fail = () => { if (ownsSurface()) setFailed(true); };
  return <View style={styles.fill}>
    <MobileHtmlBrowserControls address={address} colors={colors} locale={locale}
      onBack={() => { if (ownsSurface()) { if (navigation?.canGoBack && !failed) web.current?.goBack(); else onReturn(); } }}
      onForward={navigation?.canGoForward && !failed ? () => { if (ownsSurface()) web.current?.goForward(); } : undefined}
      onReload={reloadPage} onNavigate={(input) => {
        const uri = mobileHtmlWebsiteAddress(input);
        if (!uri || !ownsSurface()) return false;
        if (uri === address) reloadPage();
        else {
          pending.current = { uri, previousUrl: address };
          setFailed(false); setNavigation(undefined); setSource({ uri });
        }
        return true;
      }} />
    {failed ? <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "files.preview.websiteFailed")}</Text>
    : <WebView ref={web} source={source} incognito originWhitelist={["*"]} style={[styles.fill, { backgroundColor: colors.background }]}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} cacheEnabled={false} mediaCapturePermissionGrantType="deny"
      javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={({ url }) => ownsSurface() && allowMobileHtmlWebsiteNavigation(url)}
      onNavigationStateChange={(state) => {
        if (!ownsSurface() || !allowMobileHtmlWebsiteNavigation(state.url)) return;
        if (pending.current && state.url !== pending.current.uri && state.url === pending.current.previousUrl) return;
        pending.current = undefined;
        setNavigation(state);
        setSource((current) => current.uri === state.url ? current : { uri: state.url });
      }}
      onLoadEnd={() => { if (ownsSurface()) onReady(); }}
      onError={fail} onContentProcessDidTerminate={fail} onRenderProcessGone={fail} />}
  </View>;
}

function MobileHtmlBrowserControls({ address, colors, locale, disabled, onBack, onForward, onReload, onNavigate }: BrowserColors & {
  readonly address: string; readonly disabled?: boolean;
  onBack?(): void; onForward?(): void; onReload(): void; onNavigate(address: string): boolean;
}) {
  const input = useRef<TextInput>(null);
  const [text, setText] = useState(address);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(address); setInvalid(false); }, [address]);
  const submit = () => {
    if (disabled) return;
    if (onNavigate(text)) { setInvalid(false); input.current?.blur(); }
    else setInvalid(true);
  };
  const button = (label: string, action?: () => void) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || !action }}
    disabled={disabled || !action} onPress={action} style={styles.button}>
    <Text style={{ color: disabled || !action ? colors.muted : colors.accent }}>{label}</Text>
  </Pressable>;
  return <View style={[styles.controls, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.row}>
      {button(mobileMessage(locale, "files.preview.browserBack"), onBack)}
      {button(mobileMessage(locale, "files.preview.browserForward"), onForward)}
      {button(mobileMessage(locale, "common.refresh"), onReload)}
    </View>
    <View style={styles.row}>
      <TextInput ref={input} value={text} onChangeText={(value) => { setText(value); setInvalid(false); }}
        accessibilityLabel={mobileMessage(locale, "files.preview.browserAddress")} editable={!disabled}
        keyboardType="url" returnKeyType="go" maxLength={4096} autoCorrect={false} autoCapitalize="none" onSubmitEditing={submit}
        style={[styles.address, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
      {button(mobileMessage(locale, "common.open"), submit)}
    </View>
    {invalid && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "files.preview.browserInvalidAddress")}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, notice: { paddingHorizontal: 16, paddingVertical: 6 },
  controls: { paddingHorizontal: 10, paddingBottom: 6, borderBottomWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  address: { flex: 1, minHeight: 44, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10 },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }
});
