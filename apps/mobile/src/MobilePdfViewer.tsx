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
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import pdfJsRuntime from "./pdfjs-runtime.pdfjs";
import { MobilePdfTransferSession, type MobilePdfChunkFileDriver } from "./mobile-pdf-transfer";
import {
  buildMobilePdfViewerCommand,
  buildMobilePdfViewerHtml,
  parseMobilePdfViewerMessage,
  type MobilePdfViewerStatus
} from "./mobile-pdf-viewer";
import { MobilePreviewControlBar, MobilePreviewControlButton } from "./MobilePreviewControls";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";

interface MobilePdfWebViewHandle {
  postMessage(value: string): void;
  stopLoading(): void;
}

const PdfWebView = WebView as unknown as ForwardRefExoticComponent<
  WebViewProps & RefAttributes<MobilePdfWebViewHandle>
>;

const pdfViewerBaseUrl = "https://joko-pdf.invalid";

export function MobilePdfViewer({
  accent,
  background,
  border,
  byteSize,
  fileName,
  ink,
  instanceId,
  locale,
  muted,
  onStatusChange,
  readerDriver,
  sha256Hex,
  style,
  surface,
  title,
  uri
}: {
  readonly accent: string;
  readonly background: string;
  readonly border: string;
  readonly byteSize: number;
  readonly fileName: string;
  readonly ink: string;
  readonly instanceId: string;
  readonly locale: MobileSupportedLocale;
  readonly muted: string;
  readonly onStatusChange?: (status: MobilePdfViewerStatus) => void;
  readonly readerDriver?: MobilePdfChunkFileDriver;
  readonly sha256Hex: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly surface: string;
  readonly title: string;
  readonly uri: string;
}) {
  const webViewRef = useRef<MobilePdfWebViewHandle | null>(null);
  const transferRef = useRef<MobilePdfTransferSession | undefined>(undefined);
  const mountedRef = useRef(true);
  const statusRef = useRef(onStatusChange);
  const [viewerStatus, setViewerStatus] = useState<MobilePdfViewerStatus>();
  statusRef.current = onStatusChange;

  const html = useMemo(() => buildMobilePdfViewerHtml({
    instanceId, locale, title, background, surface, ink, muted, accent, border
  }, pdfJsRuntime), [accent, background, border, ink, instanceId, locale, muted, surface, title]);

  const publishStatus = useCallback((status: MobilePdfViewerStatus) => {
    if (!mountedRef.current) return;
    setViewerStatus(status);
    statusRef.current?.(status);
  }, []);

  const emitFailure = useCallback((_error: unknown, message = mobileMessage(locale, "preview.pdfError")) => {
    const text = message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 512)
      || mobileMessage(locale, "preview.pdfError");
    publishStatus({ type: "joko-pdf-viewer/status", instanceId, state: "error",
      pageCount: 0, currentPage: 0, renderedPages: 0, zoomPercent: 100, error: text });
  }, [instanceId, locale, publishStatus]);

  const stopViewer = useCallback(() => {
    const transfer = transferRef.current;
    transferRef.current = undefined;
    void transfer?.abort().catch(() => undefined);
    const handle = webViewRef.current;
    webViewRef.current = null;
    try { handle?.postMessage(buildMobilePdfViewerCommand(instanceId, { command: "dispose" })); } catch {}
    handle?.stopLoading();
  }, [instanceId]);

  const attachWebView = useCallback((handle: MobilePdfWebViewHandle | null) => {
    if (handle) webViewRef.current = handle;
    else stopViewer();
  }, [stopViewer]);

  const handleResourceFailure = useCallback((failure: "unavailable" | "recovery-exhausted") => {
    emitFailure(undefined, mobileMessage(locale, failure === "unavailable"
      ? "preview.resourcePressureUnavailable" : "preview.pdfFailure"));
  }, [emitFailure, locale]);

  const resource = useMobilePreviewResourceLifecycle({
    ownerKey: [instanceId, uri, fileName, byteSize, sha256Hex, locale,
      background, surface, ink, muted, accent, border, title].join("\u0000"),
    releaseRenderer: stopViewer,
    reportFailure: handleResourceFailure
  });

  const startTransfer = useCallback((rendererToken: string) => {
    if (transferRef.current || !resource.ownsRenderer(rendererToken)) return;
    let transfer!: MobilePdfTransferSession;
    transfer = new MobilePdfTransferSession({
      instanceId,
      uri,
      fileName,
      byteSize,
      sha256Hex,
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
  }, [byteSize, emitFailure, fileName, instanceId, readerDriver, resource, sha256Hex, uri]);

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
    const message = parseMobilePdfViewerMessage(event.nativeEvent.data, instanceId);
    if (!message) return;
    if (message.type === "joko-pdf-viewer/status") {
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
    publishStatus({ type: "joko-pdf-viewer/status", instanceId, state: resource.phase,
      pageCount: 0, currentPage: 0, renderedPages: 0, zoomPercent: 100, error: null });
  }, [instanceId, publishStatus, resource.phase]);

  const sendControl = useCallback((command: "fit" | "zoom-in" | "zoom-out" | "page-previous" | "page-next") => {
    if (!resource.ownsRenderer(resource.rendererToken)) return;
    webViewRef.current?.postMessage(buildMobilePdfViewerCommand(instanceId, { command }));
  }, [instanceId, resource]);

  const controllable = resource.phase === "active" && (viewerStatus?.pageCount ?? 0) > 0
    && viewerStatus?.state !== "error";
  const releasedLabel = mobileMessage(locale, resource.phase === "recovering"
    ? "preview.status.pdfRecovering" : "preview.status.pdfSuspended");

  return <View style={style}>
    <MobilePreviewControlBar accessibilityLabel={mobileMessage(locale, "preview.pdfControls")}
      background={surface} border={border}>
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.pdfPrevious")}
        disabled={!controllable || (viewerStatus?.currentPage ?? 0) <= 1} ink={ink} label="‹"
        onPress={() => sendControl("page-previous")} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.pdfNext")}
        disabled={!controllable || (viewerStatus?.currentPage ?? 0) >= (viewerStatus?.pageCount ?? 0)} ink={ink} label="›"
        onPress={() => sendControl("page-next")} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.pdfFitLabel")}
        disabled={!controllable} ink={ink} label={mobileMessage(locale, "preview.pdfFit")}
        onPress={() => sendControl("fit")} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.pdfZoomOut")}
        disabled={!controllable || (viewerStatus?.zoomPercent ?? 100) <= 50} ink={ink} label="−"
        onPress={() => sendControl("zoom-out")} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.pdfZoomIn")}
        disabled={!controllable || (viewerStatus?.zoomPercent ?? 100) >= 300} ink={ink} label="+"
        onPress={() => sendControl("zoom-in")} surface={background} />
    </MobilePreviewControlBar>
    {resource.rendererMounted ? <PdfWebView
      key={`${instanceId}:${resource.rendererGeneration}`}
      ref={attachWebView}
      accessibilityLabel={mobileMessage(locale, "preview.pdfLabel", { title })}
      accessibilityState={{ busy: resource.phase === "recovering"
        || viewerStatus?.state === "receiving" || viewerStatus?.state === "rendering",
        disabled: viewerStatus?.state === "error" }}
      accessibilityValue={pdfAccessibilityValue(viewerStatus)}
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
        || request.url === pdfViewerBaseUrl || request.url === `${pdfViewerBaseUrl}/`}
      originWhitelist={["about:blank", pdfViewerBaseUrl]}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      sharedCookiesEnabled={false}
      source={{ html, baseUrl: pdfViewerBaseUrl }}
      style={{ backgroundColor: "transparent", flex: 1 }}
      thirdPartyCookiesEnabled={false}
    /> : <View accessible accessibilityRole="text" accessibilityLabel={releasedLabel}
      accessibilityState={{ busy: resource.phase === "recovering", disabled: resource.phase !== "recovering" }}
      style={[styles.placeholder, { backgroundColor: background }]}>
      <Text style={[styles.placeholderText, { color: ink }]}>{releasedLabel}</Text>
    </View>}
  </View>;
}

function pdfAccessibilityValue(status: MobilePdfViewerStatus | undefined): AccessibilityValue | undefined {
  if (!status || status.pageCount < 1 || status.currentPage < 1) return undefined;
  return { min: 1, now: status.currentPage, max: status.pageCount,
    text: `${status.currentPage}/${status.pageCount} · ${status.zoomPercent}%` };
}

const styles = StyleSheet.create({
  placeholder: { flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderText: { fontSize: 14, lineHeight: 20, textAlign: "center" }
});
