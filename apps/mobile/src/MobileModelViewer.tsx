import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from "react";
import { StyleSheet, Text, View, type AccessibilityValue, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import modelRuntime from "./model-viewer-runtime.modeljs";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobileModelPreviewLease } from "./mobile-model-preview";
import { MobileModelTransferSession, type MobileModelChunkFileDriver } from "./mobile-model-transfer";
import {
  buildMobileModelViewerCommand,
  buildMobileModelViewerHtml,
  parseMobileModelViewerMessage,
  type MobileModelViewerStatus
} from "./mobile-model-viewer";
import { MobilePreviewControlBar, MobilePreviewControlButton } from "./MobilePreviewControls";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";

interface MobileModelWebViewHandle {
  postMessage(value: string): void;
  stopLoading(): void;
}

const ModelWebView = WebView as unknown as ForwardRefExoticComponent<
  WebViewProps & RefAttributes<MobileModelWebViewHandle>
>;

const modelViewerBaseUrl = "https://joko-model.invalid";

export function MobileModelViewer({
  accent,
  background,
  border,
  ink,
  lease,
  locale,
  muted,
  onStatusChange,
  readerDriver,
  style,
  surface,
  title
}: {
  readonly accent: string;
  readonly background: string;
  readonly border: string;
  readonly ink: string;
  readonly lease: MobileModelPreviewLease;
  readonly locale: MobileSupportedLocale;
  readonly muted: string;
  readonly onStatusChange?: (status: MobileModelViewerStatus) => void;
  readonly readerDriver?: MobileModelChunkFileDriver;
  readonly style?: StyleProp<ViewStyle>;
  readonly surface: string;
  readonly title: string;
}) {
  const instanceId = lease.leaseId;
  const webViewRef = useRef<MobileModelWebViewHandle | null>(null);
  const transferRef = useRef<MobileModelTransferSession | undefined>(undefined);
  const mountedRef = useRef(true);
  const statusRef = useRef(onStatusChange);
  const [viewerStatus, setViewerStatus] = useState<MobileModelViewerStatus>();
  statusRef.current = onStatusChange;

  const html = useMemo(() => buildMobileModelViewerHtml({
    instanceId, locale, title, background, surface, ink, muted, accent, border
  }, modelRuntime), [accent, background, border, ink, instanceId, locale, muted, surface, title]);

  const publishStatus = useCallback((status: MobileModelViewerStatus) => {
    if (!mountedRef.current) return;
    setViewerStatus(status);
    statusRef.current?.(status);
  }, []);

  const emitFailure = useCallback((_error: unknown, message = mobileMessage(locale, "preview.modelError")) => {
    const text = message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 512)
      || mobileMessage(locale, "preview.modelError");
    publishStatus({ type: "joko-model-viewer/status", instanceId,
      state: "error", fileCount: 0, zoomPercent: 100, error: text });
  }, [instanceId, locale, publishStatus]);

  const stopViewer = useCallback(() => {
    const transfer = transferRef.current;
    transferRef.current = undefined;
    void transfer?.abort().catch(() => undefined);
    const handle = webViewRef.current;
    webViewRef.current = null;
    try { handle?.postMessage(buildMobileModelViewerCommand(instanceId, { command: "dispose" })); } catch {}
    handle?.stopLoading();
  }, [instanceId]);

  const attachWebView = useCallback((handle: MobileModelWebViewHandle | null) => {
    if (handle) webViewRef.current = handle;
    else stopViewer();
  }, [stopViewer]);

  const handleResourceFailure = useCallback((failure: "unavailable" | "recovery-exhausted") => {
    emitFailure(undefined, mobileMessage(locale, failure === "unavailable"
      ? "preview.resourcePressureUnavailable" : "preview.modelFailure"));
  }, [emitFailure, locale]);

  const resource = useMobilePreviewResourceLifecycle({
    ownerKey: [instanceId, lease.uri, lease.packageSha256Hex, locale,
      background, surface, ink, muted, accent, border, title].join("\u0000"),
    releaseRenderer: stopViewer,
    reportFailure: handleResourceFailure
  });

  const startTransfer = useCallback((rendererToken: string) => {
    if (transferRef.current || !resource.ownsRenderer(rendererToken)) return;
    let transfer!: MobileModelTransferSession;
    transfer = new MobileModelTransferSession({
      instanceId,
      lease,
      driver: readerDriver,
      send(message) {
        if (!mountedRef.current || !resource.ownsRenderer(rendererToken)
          || transferRef.current !== transfer) return;
        webViewRef.current?.postMessage(message);
      }
    });
    transferRef.current = transfer;
    void transfer.start().catch((error) => {
      if (transferRef.current !== transfer) return;
      emitFailure(error);
    });
  }, [emitFailure, instanceId, lease, readerDriver, resource]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopViewer();
    };
  }, [stopViewer]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const rendererToken = resource.rendererToken;
    if (!mountedRef.current || !resource.ownsRenderer(rendererToken)) return;
    const message = parseMobileModelViewerMessage(event.nativeEvent.data, instanceId);
    if (!message) return;
    if (message.type === "joko-model-viewer/status") {
      publishStatus(message);
      if (message.state === "ready") {
        resource.onRendererReady(rendererToken);
        startTransfer(rendererToken);
      }
      else if (message.state === "error") void transferRef.current?.abort().catch(() => undefined);
      return;
    }
    const transfer = transferRef.current;
    if (!transfer) return;
    void transfer.accept(message).catch((error) => {
      if (transferRef.current !== transfer) return;
      emitFailure(error);
    });
  }, [emitFailure, instanceId, publishStatus, resource, startTransfer]);

  useEffect(() => {
    if (resource.phase !== "suspended" && resource.phase !== "recovering") return;
    publishStatus({ type: "joko-model-viewer/status", instanceId, state: resource.phase,
      fileCount: 0, zoomPercent: 100, error: null });
  }, [instanceId, publishStatus, resource.phase]);

  const sendControl = useCallback((command: "zoom-in" | "zoom-out" | "reset") => {
    if (!resource.ownsRenderer(resource.rendererToken)) return;
    webViewRef.current?.postMessage(buildMobileModelViewerCommand(instanceId, { command }));
  }, [instanceId, resource]);

  const controllable = resource.phase === "active" && viewerStatus?.state === "complete";
  const releasedLabel = mobileMessage(locale, resource.phase === "recovering"
    ? "preview.status.modelRecovering" : "preview.status.modelSuspended");

  return <View style={style}>
    <MobilePreviewControlBar accessibilityLabel={mobileMessage(locale, "preview.modelControls")}
      background={surface} border={border}>
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.modelZoomOut")}
        disabled={!controllable || (viewerStatus?.zoomPercent ?? 100) <= 50} ink={ink} label="−"
        onPress={() => sendControl("zoom-out")} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.modelResetLabel")}
        disabled={!controllable} ink={ink} label={mobileMessage(locale, "preview.modelReset")}
        onPress={() => sendControl("reset")} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.modelZoomIn")}
        disabled={!controllable || (viewerStatus?.zoomPercent ?? 100) >= 300} ink={ink} label="+"
        onPress={() => sendControl("zoom-in")} surface={background} />
    </MobilePreviewControlBar>
    {resource.rendererMounted ? <ModelWebView
      key={`${instanceId}:${resource.rendererGeneration}`}
      ref={attachWebView}
      accessibilityLabel={mobileMessage(locale, "preview.modelLabel", { title })}
      accessibilityState={{ busy: resource.phase === "recovering" || viewerStatus?.state === "loading"
        || viewerStatus?.state === "receiving", disabled: viewerStatus?.state === "error" }}
      accessibilityValue={modelAccessibilityValue(viewerStatus)}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      incognito
      javaScriptCanOpenWindowsAutomatically={false}
      javaScriptEnabled
      mixedContentMode="never"
      onContentProcessDidTerminate={() => resource.onRendererProcessLost(resource.rendererToken)}
      onMessage={handleMessage}
      onRenderProcessGone={() => resource.onRendererProcessLost(resource.rendererToken)}
      onShouldStartLoadWithRequest={(request: { readonly url: string }) => request.url === "about:blank"
        || request.url === modelViewerBaseUrl || request.url === `${modelViewerBaseUrl}/`}
      originWhitelist={["about:blank", modelViewerBaseUrl]}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      sharedCookiesEnabled={false}
      source={{ html, baseUrl: modelViewerBaseUrl }}
      style={{ backgroundColor: "transparent", flex: 1 }}
      thirdPartyCookiesEnabled={false}
    /> : <View accessible accessibilityRole="text" accessibilityLabel={releasedLabel}
      accessibilityState={{ busy: resource.phase === "recovering", disabled: resource.phase !== "recovering" }}
      style={[styles.placeholder, { backgroundColor: background }]}>
      <Text style={[styles.placeholderText, { color: ink }]}>{releasedLabel}</Text>
    </View>}
  </View>;
}

function modelAccessibilityValue(status: MobileModelViewerStatus | undefined): AccessibilityValue | undefined {
  if (!status || status.state !== "complete") return undefined;
  return { min: 50, now: status.zoomPercent, max: 300, text: `${status.zoomPercent}%` };
}

const styles = StyleSheet.create({
  placeholder: { flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderText: { fontSize: 14, lineHeight: 20, textAlign: "center" }
});
