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
import modelRuntime from "./model-viewer-runtime.modeljs";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobileModelPreviewLease } from "./mobile-model-preview";
import { MobileModelTransferSession, type MobileModelChunkFileDriver } from "./mobile-model-transfer";
import {
  buildMobileModelViewerCommand,
  buildMobileModelViewerHtml,
  createMobileModelViewerLifecycle,
  parseMobileModelViewerMessage,
  type MobileModelViewerStatus
} from "./mobile-model-viewer";

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
  const lifecycleRef = useRef(createMobileModelViewerLifecycle());
  const mountedRef = useRef(true);
  const activeRef = useRef(AppState.currentState === "active");
  const statusRef = useRef(onStatusChange);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  statusRef.current = onStatusChange;

  const html = useMemo(() => buildMobileModelViewerHtml({
    instanceId, locale, title, background, surface, ink, muted, accent, border
  }, modelRuntime), [accent, background, border, ink, instanceId, locale, muted, surface, title]);

  const emitFailure = useCallback((_error: unknown, message = mobileMessage(locale, "preview.modelError")) => {
    const text = message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 512)
      || mobileMessage(locale, "preview.modelError");
    statusRef.current?.({ type: "joko-model-viewer/status", instanceId,
      state: "error", fileCount: 0, error: text });
  }, [instanceId, locale]);

  const stopViewer = useCallback(() => {
    const transfer = transferRef.current;
    transferRef.current = undefined;
    void transfer?.abort().catch(() => undefined);
    try { webViewRef.current?.postMessage(buildMobileModelViewerCommand(instanceId, { command: "dispose" })); } catch {}
    webViewRef.current?.stopLoading();
  }, [instanceId]);

  const startTransfer = useCallback(() => {
    if (transferRef.current) return;
    let transfer!: MobileModelTransferSession;
    transfer = new MobileModelTransferSession({
      instanceId,
      lease,
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
  }, [emitFailure, instanceId, lease, readerDriver]);

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
      else if (recovery === "failed") {
        emitFailure(undefined, mobileMessage(locale, "preview.modelFailure"));
      }
    });
    return () => subscription.remove();
  }, [emitFailure, locale, stopViewer]);

  useEffect(() => {
    lifecycleRef.current.reset();
    return stopViewer;
  }, [instanceId, lease.uri, stopViewer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopViewer();
    };
  }, [stopViewer]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!mountedRef.current || !activeRef.current) return;
    const message = parseMobileModelViewerMessage(event.nativeEvent.data, instanceId);
    if (!message) return;
    if (message.type === "joko-model-viewer/status") {
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
    else if (recovery === "failed") {
      emitFailure(undefined, mobileMessage(locale, "preview.modelFailure"));
    }
    return true;
  }, [emitFailure, locale, stopViewer]);

  return <View style={style}>
    <ModelWebView
      key={`${instanceId}:${locale}:${reloadGeneration}`}
      ref={(handle) => { if (handle) webViewRef.current = handle; }}
      accessibilityLabel={mobileMessage(locale, "preview.modelLabel", { title })}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      incognito
      javaScriptCanOpenWindowsAutomatically={false}
      javaScriptEnabled
      mixedContentMode="never"
      onContentProcessDidTerminate={recoverProcess}
      onLoadEnd={() => lifecycleRef.current.onLoadEnd()}
      onLoadStart={() => lifecycleRef.current.onLoadStart()}
      onMessage={handleMessage}
      onRenderProcessGone={recoverProcess}
      onShouldStartLoadWithRequest={(request: { readonly url: string }) => request.url === "about:blank"
        || request.url === modelViewerBaseUrl || request.url === `${modelViewerBaseUrl}/`}
      originWhitelist={["about:blank", modelViewerBaseUrl]}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      sharedCookiesEnabled={false}
      source={{ html, baseUrl: modelViewerBaseUrl }}
      style={{ backgroundColor: "transparent", flex: 1 }}
      thirdPartyCookiesEnabled={false}
    />
  </View>;
}
