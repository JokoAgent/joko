import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from "react";
import { Platform, StyleSheet, Text, View, type AccessibilityValue, type StyleProp, type ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import { useVideoPlayer, VideoView, type VideoPlayerStatus } from "expo-video";
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
  uri,
  networkSource = false
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
  readonly networkSource?: boolean;
}) {
  const baseUrl = networkSource ? "about:blank" : uri.slice(0, uri.lastIndexOf("/") + 1);
  const webViewRef = useRef<MobileMediaWebViewHandle | null>(null);
  const pauseNativeRef = useRef<(() => void) | undefined>(undefined);
  const mountedRef = useRef(true);
  const statusRef = useRef(onStatusChange);
  const mediaOwnerKey = JSON.stringify([instanceId, uri, kind, mediaType, networkSource]);
  const positionRef = useRef<{ ownerKey: string; currentTime: number | null; duration: number | null }>({
    ownerKey: mediaOwnerKey, currentTime: null, duration: null
  });
  if (positionRef.current.ownerKey !== mediaOwnerKey) {
    positionRef.current = { ownerKey: mediaOwnerKey, currentTime: null, duration: null };
  }
  const [playerStatus, setPlayerStatus] = useState<MobileMediaPlayerStatus>();
  const [failedNativeOwner, setFailedNativeOwner] = useState<string>();
  const useNativeVideo = kind === "video" && !networkSource && uri.startsWith("file://") && failedNativeOwner !== mediaOwnerKey;
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
    pauseNativeRef.current?.();
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
    ownerKey: [mediaOwnerKey, locale, background, surface, ink, title].join("\u0000"),
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

  const handleStatus = useCallback((status: MobileMediaPlayerStatus) => {
    if (!mountedRef.current || !resource.ownsRenderer(resource.rendererToken)) return;
    if (positionRef.current.ownerKey === mediaOwnerKey && status.currentTime !== null) {
      positionRef.current = { ownerKey: mediaOwnerKey, currentTime: status.currentTime, duration: status.duration };
    }
    if (status.state === "ready") resource.onRendererReady(resource.rendererToken);
    publishStatus(status);
  }, [mediaOwnerKey, publishStatus, resource]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const status = parseMobileMediaPlayerStatus(event.nativeEvent.data, instanceId);
    if (status) handleStatus(status);
  }, [handleStatus, instanceId]);

  useEffect(() => {
    if (resource.phase !== "suspended" && resource.phase !== "recovering") return;
    publishStatus({
      type: "joko-media-player/status",
      instanceId,
      state: resource.phase,
      currentTime: positionRef.current.currentTime,
      duration: positionRef.current.duration,
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
  // Capture the position only when creating a renderer; status updates must not reload its HTML.
  const source = useMemo(() => resource.rendererMounted && !useNativeVideo ? ({
    html: buildMobileMediaPlayerHtml({
      instanceId, kind, locale, mediaType, title, uri, background, surface, ink, networkSource,
      initialTime: positionRef.current.currentTime ?? 0
    }),
    baseUrl
  }) : undefined, [background, baseUrl, ink, instanceId, kind, locale, mediaType, networkSource, resource.rendererGeneration, resource.rendererMounted, surface, title, uri, useNativeVideo]);
  const playerLabel = mobileMessage(locale, "preview.mediaLabel", {
    kind: mobileMessage(locale, kind === "video" ? "preview.video" : "preview.audio"), title
  });

  return <View style={style}>
    {!useNativeVideo && <MobilePreviewControlBar accessibilityLabel={mobileMessage(locale, "preview.mediaControls")}
      background={surface} border={border}>
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale,
        playing ? "preview.mediaPause" : "preview.mediaPlay")}
        disabled={!controllable} ink={ink}
        label={mobileMessage(locale, playing ? "preview.mediaPause" : "preview.mediaPlay")}
        onPress={() => sendCommand(playing ? "pause" : "play")} selected={playing} surface={background} />
      <MobilePreviewControlButton accessibilityLabel={mobileMessage(locale, "preview.mediaRestart")}
        disabled={!controllable} ink={ink} label={mobileMessage(locale, "preview.mediaRestart")}
        onPress={() => sendCommand("reset")} surface={background} />
    </MobilePreviewControlBar>}
    {resource.rendererMounted ? useNativeVideo ? <NativeVideo
      key={`${instanceId}:${resource.rendererGeneration}`} uri={uri} instanceId={instanceId} label={playerLabel}
      initialTime={positionRef.current.currentTime ?? 0} pauseRef={pauseNativeRef} onStatus={handleStatus}
      onError={() => { if (mountedRef.current && resource.ownsRenderer(resource.rendererToken)) setFailedNativeOwner(mediaOwnerKey); }}
    /> : <MediaWebView
      key={`${instanceId}:${resource.rendererGeneration}`}
      ref={attachWebView}
      accessibilityLabel={playerLabel}
      accessibilityState={{ busy: playerStatus?.state === "waiting" || resource.phase === "recovering",
        disabled: playerStatus?.state === "error" }}
      accessibilityValue={accessibilityValue}
      allowFileAccess={!networkSource}
      allowFileAccessFromFileURLs={false}
      allowingReadAccessToURL={networkSource ? undefined : baseUrl}
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
      originWhitelist={networkSource ? ["about:blank"] : ["about:blank", "file://*"]}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      sharedCookiesEnabled={false}
      source={source}
      style={{ backgroundColor: "transparent", flex: 1 }}
      thirdPartyCookiesEnabled={false}
    /> : <View accessible accessibilityRole="text" accessibilityLabel={releasedLabel}
      accessibilityState={{ busy: resource.phase === "recovering", disabled: resource.phase !== "recovering" }}
      style={[styles.placeholder, { backgroundColor: background }]}>
      <Text style={[styles.placeholderText, { color: ink }]}>{releasedLabel}</Text>
    </View>}
  </View>;
}

function NativeVideo({ uri, label, instanceId, initialTime, pauseRef, onStatus, onError }: {
  readonly uri: string;
  readonly label: string;
  readonly instanceId: string;
  readonly initialTime: number;
  readonly pauseRef: React.RefObject<(() => void) | undefined>;
  readonly onStatus: (status: MobileMediaPlayerStatus) => void;
  readonly onError: () => void;
}) {
  const player = useVideoPlayer(uri, instance => {
    instance.loop = false;
    instance.timeUpdateEventInterval = 0.5;
    if (Platform.OS === "ios") instance.allowsExternalPlayback = false;
  });
  const callbacks = useRef({ onStatus, onError });
  callbacks.current = { onStatus, onError };
  const initial = useRef(initialTime);

  useLayoutEffect(() => {
    let alive = true, ready = false, ended = false;
    const numberOrNull = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null;
    const emit = (state: MobileMediaPlayerStatus["state"]): void => {
      if (!alive) return;
      callbacks.current.onStatus({ type: "joko-media-player/status", instanceId, state,
        currentTime: ready ? numberOrNull(player.currentTime) : null,
        duration: ready && player.duration > 0 ? numberOrNull(player.duration) : null, error: null });
    };
    const statusChanged = (status: VideoPlayerStatus): void => {
      if (!alive) return;
      if (status === "error") { callbacks.current.onError(); return; }
      if (status === "loading") { emit("waiting"); return; }
      if (status !== "readyToPlay" || ready) return;
      ready = true;
      if (initial.current > 0) player.currentTime = player.duration > 0 ? Math.min(initial.current, player.duration) : initial.current;
      emit("ready");
    };
    const pause = (): void => { try { player.pause(); } catch { /* The native player may already be disposed. */ } };
    const subscriptions = [
      player.addListener("statusChange", ({ status }) => statusChanged(status)),
      player.addListener("playingChange", ({ isPlaying }) => {
        if (isPlaying) ended = false;
        if (ready) emit(isPlaying ? "playing" : ended ? "ended" : "paused");
      }),
      player.addListener("timeUpdate", () => { if (ready) emit(player.playing ? "playing" : ended ? "ended" : "paused"); }),
      player.addListener("playToEnd", () => { ended = true; emit("ended"); })
    ];
    pauseRef.current = pause;
    statusChanged(player.status);
    return () => {
      alive = false;
      if (pauseRef.current === pause) pauseRef.current = undefined;
      for (const subscription of subscriptions) subscription.remove();
      pause();
    };
  }, [instanceId, pauseRef, player]);

  return <VideoView player={player} nativeControls accessibilityLabel={label} contentFit="contain"
    allowsPictureInPicture={false} fullscreenOptions={{ enable: true }} style={styles.nativeVideo} />;
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
  nativeVideo: { flex: 1, minHeight: 160, width: "100%" },
  placeholder: { flex: 1, minHeight: 160, alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderText: { fontSize: 14, lineHeight: 20, textAlign: "center" }
});
