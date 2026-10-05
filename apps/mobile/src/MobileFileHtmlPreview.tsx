import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { MobileClient } from "./mobile-client";
import type { MobileFilePreview } from "./workspace-files";
import { workspaceParentPath } from "./workspace-files";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileMarkdownColors } from "./mobile-markdown-rich-html";
import { mobileMessage } from "./mobile-messages";
import { allowMobileHtmlNavigation, mobileFileHtmlComplete, withHtmlPreviewCsp } from "./mobile-file-html";
import { collectHtmlLocalResourceRefs, planHtmlResourceFetches } from "./mobile-file-html-resources";
import type { MobileFileHtmlDescriptor } from "./mobile-file-html-reader";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";

export type MobileFileHtmlClient = Pick<MobileClient, "filesHtmlResourceOwnerKey" | "prepareFilesHtmlResources" | "assertFilesHtmlResourcesCurrent" | "releaseFilesHtmlResources" | "subscribe">;
interface Props {
  readonly preview: Extract<MobileFilePreview, { kind: "text" }>;
  readonly client?: MobileFileHtmlClient; readonly colors: MobileMarkdownColors; readonly locale: MobileSupportedLocale;
}
export function MobileFileHtmlPreview({ preview, client, colors, locale }: Props) {
  const complete = mobileFileHtmlComplete(preview);
  const plan = useMemo(() => planHtmlResourceFetches(collectHtmlLocalResourceRefs(preview.text,
    preview.workspaceEntry ? workspaceParentPath(preview.workspaceEntry.relativePath) : "")), [preview]);
  const [prepared, setPrepared] = useState<MobileFileHtmlDescriptor>(); const [failed, setFailed] = useState(false);
  const alive = useRef(true); const current = useRef(preview); current.current = preview;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const work = useRef<{ controller: AbortController; descriptor?: MobileFileHtmlDescriptor } | undefined>(undefined);
  const stop = useCallback(() => {
    work.current?.controller.abort(); if (work.current?.descriptor) client?.releaseFilesHtmlResources(work.current.descriptor.leaseId);
    work.current = undefined; setPrepared(undefined);
  }, [client]);
  const lifecycle = useMobilePreviewResourceLifecycle({ ownerKey: JSON.stringify([preview.sourceLabel, preview.revisionKey]),
    releaseRenderer: stop, reportFailure: useCallback(() => setFailed(true), []) });
  const token = lifecycle.rendererToken;
  const ownsRenderer = () => alive.current && current.current === preview && AppState.currentState === "active"
    && lifecycle.ownsRenderer(token) && (!client || !!client.filesHtmlResourceOwnerKey(preview));
  useEffect(() => {
    if (!complete || !client || !lifecycle.rendererMounted) return;
    const owner = client.filesHtmlResourceOwnerKey(preview);
    if (!owner) { setFailed(true); return; }
    const request = { controller: new AbortController(), descriptor: undefined as MobileFileHtmlDescriptor | undefined }; work.current = request;
    const unsubscribe = client.subscribe(() => {
      if (client.filesHtmlResourceOwnerKey(preview) !== owner) { stop(); if (alive.current) setFailed(true); }
      else if (request.descriptor) { try { client.assertFilesHtmlResourcesCurrent(request.descriptor.leaseId); }
        catch { stop(); if (alive.current) setFailed(true); } }
    });
    void client.prepareFilesHtmlResources(preview, request.controller.signal).then((result) => {
      if (work.current !== request || request.controller.signal.aborted || current.current !== preview || AppState.currentState !== "active") {
        client.releaseFilesHtmlResources(result.leaseId); return;
      }
      try { client.assertFilesHtmlResourcesCurrent(result.leaseId); } catch { client.releaseFilesHtmlResources(result.leaseId); stop(); setFailed(true); return; }
      request.descriptor = result; setPrepared(result);
    }).catch(() => { if (work.current === request) { stop(); if (alive.current) setFailed(true); } });
    return () => { unsubscribe(); stop(); };
  }, [client, complete, lifecycle.rendererGeneration, lifecycle.rendererMounted, preview, stop]);
  const rawHtml = !plan.targets.length ? preview.text : prepared?.html ?? (!client ? preview.text : undefined);
  const html = useMemo(() => rawHtml === undefined ? undefined : withHtmlPreviewCsp(rawHtml), [rawHtml]);
  const documentState = useRef({ html, token, settled: false });
  if (documentState.current.html !== html || documentState.current.token !== token) documentState.current = { html, token, settled: false };
  if (!complete) return <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "files.preview.htmlCompleteRequired")}</Text>;
  if (failed) return <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{mobileMessage(locale, "files.preview.renderFailed")}</Text>;
  if (!lifecycle.rendererMounted) return <View style={styles.fill} />;
  if (html === undefined) return <Text accessibilityRole="progressbar" style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "files.preview.htmlResourcesLoading")}</Text>;
  const failedCount = prepared?.failed ?? (!client ? plan.targets.length : 0);
  const skippedCount = (prepared?.overLimit ?? plan.skipped) + (prepared?.overBudget ?? 0);
  return <View style={styles.fill}>
    {failedCount > 0 && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "files.preview.htmlResourcesFailed", { count: failedCount })}</Text>}
    {skippedCount > 0 && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.muted }]}>{mobileMessage(locale, "files.preview.htmlResourcesLimit", { count: skippedCount })}</Text>}
    <WebView key={token} source={{ baseUrl: "about:blank", html }} originWhitelist={["*"]} style={[styles.fill, { backgroundColor: colors.background }]}
      scrollEnabled javaScriptEnabled javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} mediaCapturePermissionGrantType="deny"
      sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} domStorageEnabled={false} incognito cacheEnabled={false}
      onShouldStartLoadWithRequest={(request) => ownsRenderer() && allowMobileHtmlNavigation(request.url ?? "", documentState.current.settled)}
      onLoadEnd={() => { if (ownsRenderer()) { documentState.current.settled = true; lifecycle.onRendererReady(token); } }}
      onError={() => { if (ownsRenderer()) { stop(); setFailed(true); } }}
      onContentProcessDidTerminate={() => { if (ownsRenderer()) lifecycle.onRendererProcessLost(token); }}
      onRenderProcessGone={() => { if (ownsRenderer()) lifecycle.onRendererProcessLost(token); }} />
  </View>;
}
const styles = StyleSheet.create({ fill: { flex: 1 }, notice: { paddingHorizontal: 16, paddingVertical: 6 } });
