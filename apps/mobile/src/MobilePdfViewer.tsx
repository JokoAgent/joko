import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from "react";
import { AppState, View, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import pdfJsRuntime from "./pdfjs-runtime.pdfjs";
import { MobilePdfTransferSession, type MobilePdfChunkFileDriver } from "./mobile-pdf-transfer";
import {
  buildMobilePdfViewerCommand,
  buildMobilePdfViewerHtml,
  createMobilePdfViewerLifecycle,
  parseMobilePdfViewerMessage,
  type MobilePdfViewerStatus
} from "./mobile-pdf-viewer";

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
  const lifecycleRef = useRef(createMobilePdfViewerLifecycle());
  const mountedRef = useRef(true);
  const activeRef = useRef(AppState.currentState === "active");
  const statusRef = useRef(onStatusChange);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  statusRef.current = onStatusChange;

  const html = useMemo(() => buildMobilePdfViewerHtml({
    instanceId, locale, title, background, surface, ink, muted, accent, border
  }, pdfJsRuntime), [accent, background, border, ink, instanceId, locale, muted, surface, title]);

  const emitFailure = useCallback((_error: unknown, message = mobileMessage(locale, "preview.pdfError")) => {
    const text = message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 512)
      || mobileMessage(locale, "preview.pdfError");
    statusRef.current?.({ type: "joko-pdf-viewer/status", instanceId, state: "error",
      pageCount: 0, renderedPages: 0, zoomPercent: 100, error: text });
  }, [instanceId, locale]);

  const stopViewer = useCallback(() => {
    const transfer = transferRef.current;
    transferRef.current = undefined;
    void transfer?.abort().catch(() => undefined);
    try { webViewRef.current?.postMessage(buildMobilePdfViewerCommand(instanceId, { command: "dispose" })); } catch {}
    webViewRef.current?.stopLoading();
  }, [instanceId]);

  const startTransfer = useCallback(() => {
    const current = transferRef.current;
    if (current) return;
    let transfer!: MobilePdfTransferSession;
    transfer = new MobilePdfTransferSession({
      instanceId,
      uri,
      fileName,
      byteSize,
      sha256Hex,
      driver: readerDriver,
      send(message) {
        if (!mountedRef.current || !activeRef.current || transferRef.current !== transfer) return;
        webViewRef.current?.postMessage(message);
      }
    });
    transferRef.current = transfer;
    void transfer.start().catch((error) => {
      if (transferRef.current !== transfer) return;
      emitFailure(error);
    });
  }, [byteSize, emitFailure, fileName, instanceId, readerDriver, sha256Hex, uri]);

  useEffect(() => {
    activeRef.current = AppState.currentState === "active";
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      activeRef.current = active;
      if (!active) {
        lifecycleRef.current.onBackground();
        stopViewer();
        return;
      }
      const recovery = lifecycleRef.current.consumeReloadOnActive();
      if (recovery === "reload") setReloadGeneration((value) => value + 1);
      else if (recovery === "failed") emitFailure(undefined, mobileMessage(locale, "preview.pdfFailure"));
    });
    return () => subscription.remove();
  }, [emitFailure, locale, stopViewer]);

  useEffect(() => {
    lifecycleRef.current.reset();
    return stopViewer;
  }, [instanceId, stopViewer, uri]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopViewer();
    };
  }, [stopViewer]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!mountedRef.current || !activeRef.current) return;
    const message = parseMobilePdfViewerMessage(event.nativeEvent.data, instanceId);
    if (!message) return;
    if (message.type === "joko-pdf-viewer/status") {
      statusRef.current?.(message);
      if (message.state === "ready") startTransfer();
      else if (message.state === "error") void transferRef.current?.abort().catch(() => undefined);
      return;
    }
    const transfer = transferRef.current;
    if (!transfer) return;
    void transfer.accept(message).catch((error) => {
      if (transferRef.current !== transfer) return;
      emitFailure(error);
    });
  }, [emitFailure, instanceId, startTransfer]);

  const recoverProcess = useCallback((): boolean => {
    stopViewer();
    const recovery = lifecycleRef.current.onProcessLost(activeRef.current);
    if (recovery === "reload") setReloadGeneration((value) => value + 1);
    else if (recovery === "failed") emitFailure(undefined, mobileMessage(locale, "preview.pdfFailure"));
    return true;
  }, [emitFailure, locale, stopViewer]);

  return <View style={style}>
    <PdfWebView
      key={`${instanceId}:${locale}:${reloadGeneration}`}
      ref={(handle) => { if (handle) webViewRef.current = handle; }}
      accessibilityLabel={mobileMessage(locale, "preview.pdfLabel", { title })}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      incognito
      javaScriptCanOpenWindowsAutomatically={false}
      javaScriptEnabled
      mixedContentMode="never"
      onContentProcessDidTerminate={recoverProcess}
      onMessage={handleMessage}
      onRenderProcessGone={recoverProcess}
      onShouldStartLoadWithRequest={(request: { readonly url: string }) => request.url === "about:blank"
        || request.url === pdfViewerBaseUrl || request.url === `${pdfViewerBaseUrl}/`}
      originWhitelist={["about:blank", pdfViewerBaseUrl]}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      sharedCookiesEnabled={false}
      source={{ html, baseUrl: pdfViewerBaseUrl }}
      style={{ backgroundColor: "transparent", flex: 1 }}
      thirdPartyCookiesEnabled={false}
    />
  </View>;
}
