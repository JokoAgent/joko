import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from "react";
import { StyleSheet, Text, View, type AccessibilityValue, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import {
  buildMobileMediaPlayerCommand,
  buildMobileMediaPlayerHtml,
  parseMobileMediaPlayerStatus,
  type MobileMediaPlayerStatus
} from "./mobile-media-player";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileMediaPreviewKind } from "./mobile-media-preview";
import { mobileMessage } from "./mobile-messages";
import { MobilePreviewControlBar, MobilePreviewControlButton } from "./MobilePreviewControls";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";

interface MobileMediaWebViewHandle {
  postMessage(value: string): void;
  stopLoading(): void;
}

const MediaWebView = WebView as unknown as ForwardRefExoticComponent<
  WebViewProps & RefAttributes<MobileMediaWebViewHandle>
>;

export function MobileMediaPlayer({
  background,
  border,
  ink,
  instanceId,
  kind,
  locale,
  mediaType,
  onStatusChange,
  style,
  surface,
  title,
  uri
}: {
  readonly background: string;
  readonly border: string;
  readonly ink: string;
  readonly instanceId: string;
  readonly kind: MobileMediaPreviewKind;
  readonly locale: MobileSupportedLocale;
  readonly mediaType: string;
  readonly onStatusChange?: (status: MobileMediaPlayerStatus) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly surface: string;
  readonly title: string;
  readonly uri: string;
}) {
  const baseUrl = uri.slice(0, uri.lastIndexOf("/") + 1);
  const webViewRef = useRef<MobileMediaWebViewHandle | null>(null);
  const mountedRef = useRef(true);
  const statusRef = useRef(onStatusChange);
  const [playerStatus, setPlayerStatus] = useState<MobileMediaPlayerStatus>();
  statusRef.current = onStatusChange;

  const publishStatus = useCallback((status: MobileMediaPlayerStatus) => {
    if (!mountedRef.current) return;
    setPlayerStatus(status);
    statusRef.current?.(status);
  }, []);

  const emitProcessFailure = useCallback((unavailable: boolean) => {
    publishStatus({
      type: "joko-media-player/status",
      instanceId,
      state: "error",
      currentTime: null,
      duration: null,
      error: mobileMessage(locale, unavailable
        ? "preview.resourcePressureUnavailable" : "preview.mediaFailure")
    });
  }, [instanceId, locale, publishStatus]);

  const stopPlaybackAndLoading = useCallback(() => {
    const handle = webViewRef.current;
    webViewRef.current = null;
    try { handle?.postMessage(buildMobileMediaPlayerCommand(instanceId, "pause")); } catch {}
    handle?.stopLoading();
  }, [instanceId]);

  const attachWebView = useCallback((handle: MobileMediaWebViewHandle | null) => {
    if (handle) webViewRef.current = handle;
    else stopPlaybackAndLoading();
  }, [stopPlaybackAndLoading]);

  const handleResourceFailure = useCallback((failure: "unavailable" | "recovery-exhausted") => {
    emitProcessFailure(failure === "unavailable");
  }, [emitProcessFailure]);

  const resource = useMobilePreviewResourceLifecycle({
    ownerKey: [instanceId, uri, locale, background, surface, ink, title, mediaType, kind].join("\u0000"),
    releaseRenderer: stopPlaybackAndLoading,
    reportFailure: handleResourceFailure
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPlaybackAndLoading();
    };
  }, [stopPlaybackAndLoading]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!mountedRef.current || !resource.ownsRenderer(resource.rendererToken)) return;
    const status = parseMobileMediaPlayerStatus(event.nativeEvent.data, instanceId);
    if (!status) return;
    if (status.state === "ready") resource.onRendererReady(resource.rendererToken);
    publishStatus(status);
  }, [instanceId, publishStatus, resource]);

  useEffect(() => {
    if (resource.phase !== "suspended" && resource.phase !== "recovering") return;
    publishStatus({
      type: "joko-media-player/status",
      instanceId,
      state: resource.phase,
      currentTime: null,
      duration: null,
      error: null
    });
  }, [instanceId, publishStatus, resource.phase]);

  const sendCommand = useCallback((command: "play" | "pause" | "reset") => {
    if (!resource.ownsRenderer(resource.rendererToken)) return;
    webViewRef.current?.postMessage(buildMobileMediaPlayerCommand(instanceId, command));
  }, [instanceId, resource]);

  const controllable = resource.phase === "active" && playerStatus !== undefined
    && playerStatus.state !== "error" && playerStatus.state !== "suspended"
    && playerStatus.state !== "recovering";
  const playing = playerStatus?.state === "playing" || playerStatus?.state === "waiting";
  const accessibilityValue = mediaAccessibilityValue(playerStatus);
  const releasedLabel = mobileMessage(locale, resource.phase === "recovering"
    ? "preview.status.mediaRecovering" : "preview.status.mediaSuspended");

  return <View style={style}>
    <MobilePreviewControlBar accessibilityLabel={mobileMessage(locale, "preview.mediaControls")}
      background={surface} border={border}>
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale,
        playing ? "preview.mediaPause" : "preview.mediaPlay")}
        disabled={!controllable} ink={ink}
        label={mobileMessage(locale, playing ? "preview.mediaPause" : "preview.mediaPlay")}
        onPress={() => sendCommand(playing ? "pause" : "play")} selected={playing} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.mediaRestart")}
        disabled={!controllable} ink={ink} label={mobileMessage(locale, "preview.mediaRestart")}
        onPress={() => sendCommand("reset")} surface={background} />
    </MobilePreviewControlBar>
    {resource.rendererMounted ? <MediaWebView
      key={`${instanceId}:${resource.rendererGeneration}`}
      ref={attachWebView}
      accessibilityLabel={mobileMessage(locale, "preview.mediaLabel", {
        kind: mobileMessage(locale, kind === "video" ? "preview.video" : "preview.audio"),
        title
      })}
      accessibilityState={{ busy: playerStatus?.state === "waiting" || resource.phase === "recovering",
        disabled: playerStatus?.state === "error" }}
      accessibilityValue={accessibilityValue}
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
      onContentProcessDidTerminate={() => resource.onRendererProcessLost(resource.rendererToken)}
      onMessage={handleMessage}
      onRenderProcessGone={() => resource.onRendererProcessLost(resource.rendererToken)}
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
          locale,
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
    /> : <View accessible accessibilityRole="text" accessibilityLabel={releasedLabel}
      accessibilityState={{ busy: resource.phase === "recovering", disabled: resource.phase !== "recovering" }}
      style={[styles.placeholder, { backgroundColor: background }]}>
      <Text style={[styles.placeholderText, { color: ink }]}>{releasedLabel}</Text>
    </View>}
  </View>;
}

function mediaAccessibilityValue(status: MobileMediaPlayerStatus | undefined): AccessibilityValue | undefined {
  if (!status || status.currentTime === null) return undefined;
  if (status.duration === null || status.duration < status.currentTime) {
    return { min: 0, now: Math.floor(status.currentTime) };
  }
  return {
    min: 0,
    now: Math.floor(status.currentTime),
    max: Math.max(1, Math.floor(status.duration))
  };
}

const styles = StyleSheet.create({
  placeholder: { flex: 1, minHeight: 160, alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderText: { fontSize: 14, lineHeight: 20, textAlign: "center" }
});
