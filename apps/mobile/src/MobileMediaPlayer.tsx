import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from "react";
import { AppState, View, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import {
  buildMobileMediaPlayerCommand,
  buildMobileMediaPlayerHtml,
  createMobileMediaPlayerLifecycle,
  parseMobileMediaPlayerStatus,
  type MobileMediaPlayerStatus
} from "./mobile-media-player";
import type { MobileMediaPreviewKind } from "./mobile-media-preview";

interface MobileMediaWebViewHandle {
  postMessage(value: string): void;
  stopLoading(): void;
}

const MediaWebView = WebView as unknown as ForwardRefExoticComponent<
  WebViewProps & RefAttributes<MobileMediaWebViewHandle>
>;

export function MobileMediaPlayer({
  background,
  ink,
  instanceId,
  kind,
  mediaType,
  onStatusChange,
  style,
  surface,
  title,
  uri
}: {
  readonly background: string;
  readonly ink: string;
  readonly instanceId: string;
  readonly kind: MobileMediaPreviewKind;
  readonly mediaType: string;
  readonly onStatusChange?: (status: MobileMediaPlayerStatus) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly surface: string;
  readonly title: string;
  readonly uri: string;
}) {
  const baseUrl = uri.slice(0, uri.lastIndexOf("/") + 1);
  const webViewRef = useRef<MobileMediaWebViewHandle | null>(null);
  const lifecycleRef = useRef(createMobileMediaPlayerLifecycle());
  const mountedRef = useRef(true);
  const activeRef = useRef(AppState.currentState === "active");
  const statusRef = useRef(onStatusChange);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  statusRef.current = onStatusChange;

  const emitProcessFailure = useCallback(() => {
    statusRef.current?.({
      type: "joko-media-player/status",
      instanceId,
      state: "error",
      currentTime: null,
      duration: null,
      error: "The media preview process stopped repeatedly. Close the preview and try again."
    });
  }, [instanceId]);

  const pausePlayback = useCallback(() => {
    webViewRef.current?.postMessage(buildMobileMediaPlayerCommand(instanceId, "pause"));
  }, [instanceId]);

  const stopPlaybackAndLoading = useCallback(() => {
    pausePlayback();
    webViewRef.current?.stopLoading();
  }, [pausePlayback]);

  useEffect(() => {
    activeRef.current = AppState.currentState === "active";
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      activeRef.current = active;
      if (!active) {
        lifecycleRef.current.onBackground();
        stopPlaybackAndLoading();
        return;
      }
      const recovery = lifecycleRef.current.consumeReloadOnActive();
      if (recovery === "reload") setReloadGeneration((value) => value + 1);
      else if (recovery === "failed") emitProcessFailure();
    });
    return () => subscription.remove();
  }, [emitProcessFailure, stopPlaybackAndLoading]);

  useEffect(() => {
    lifecycleRef.current.reset();
    return stopPlaybackAndLoading;
  }, [instanceId, stopPlaybackAndLoading, uri]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPlaybackAndLoading();
    };
  }, [stopPlaybackAndLoading]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!mountedRef.current) return;
    const status = parseMobileMediaPlayerStatus(event.nativeEvent.data, instanceId);
    if (status) statusRef.current?.(status);
  }, [instanceId]);

  const recoverProcess = useCallback((): boolean => {
    stopPlaybackAndLoading();
    const recovery = lifecycleRef.current.onProcessLost(activeRef.current);
    if (recovery === "reload") setReloadGeneration((value) => value + 1);
    else if (recovery === "failed") emitProcessFailure();
    return true;
  }, [emitProcessFailure, stopPlaybackAndLoading]);

  return <View style={style}>
    <MediaWebView
      key={`${instanceId}:${reloadGeneration}`}
      ref={(handle) => { if (handle) webViewRef.current = handle; }}
      accessibilityLabel={`${kind === "video" ? "Video" : "Audio"} player for ${title}`}
      allowFileAccess
      allowFileAccessFromFileURLs={false}
      allowingReadAccessToURL={baseUrl}
      allowUniversalAccessFromFileURLs={false}
      allowsInlineMediaPlayback
      domStorageEnabled={false}
      incognito
      javaScriptCanOpenWindowsAutomatically={false}
      javaScriptEnabled
      mediaPlaybackRequiresUserAction={false}
      mixedContentMode="never"
      onContentProcessDidTerminate={recoverProcess}
      onLoadEnd={() => lifecycleRef.current.onLoadEnd()}
      onLoadStart={() => lifecycleRef.current.onLoadStart()}
      onMessage={handleMessage}
      onRenderProcessGone={recoverProcess}
      onShouldStartLoadWithRequest={(request: { readonly url: string }) => request.url === "about:blank"
        || request.url === baseUrl || request.url === uri}
      originWhitelist={["about:blank", "file://*"]}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      sharedCookiesEnabled={false}
      source={{
        html: buildMobileMediaPlayerHtml({
          instanceId,
          kind,
          mediaType,
          title,
          uri,
          background,
          surface,
          ink
        }),
        baseUrl
      }}
      style={{ backgroundColor: "transparent", flex: 1 }}
      thirdPartyCookiesEnabled={false}
    />
  </View>;
}
