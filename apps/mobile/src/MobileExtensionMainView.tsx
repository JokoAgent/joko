import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  allowMobileExtensionMainViewNavigation,
  mobileExtensionKey,
  sameMobileExtensionMainViewSurface,
  type MobileExtension,
  type MobileExtensionMainViewSurface,
  type MobileExtensionTransport
} from "./mobile-extensions";
import { MobileExtensionLibraryBridge, mobileExtensionLibraryBootstrap } from "./mobile-extension-library-bridge";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

type SurfaceState =
  | { readonly phase: "opening" }
  | { readonly phase: "ready"; readonly surface: MobileExtensionMainViewSurface }
  | { readonly phase: "error" | "revoked" };

export function MobileExtensionMainView({ colors, extension, locale, onBack, transport }: {
  readonly colors: MobilePartnersColors;
  readonly extension: MobileExtension;
  readonly locale: MobileSupportedLocale;
  readonly onBack: () => void;
  readonly transport: MobileExtensionTransport;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const leaseTransport = useRef<MobileExtensionTransport | undefined>(undefined);
  const surfaceRef = useRef<MobileExtensionMainViewSurface | undefined>(undefined);
  const occurrence = useRef<symbol | undefined>(undefined);
  const reloadAbort = useRef<AbortController | undefined>(undefined);
  const webRef = useRef<WebView>(null);
  const bridgeRef = useRef<MobileExtensionLibraryBridge | undefined>(undefined);
  const frameOwner = useRef<{ readonly id: string; readonly url: string; started: boolean } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [frameRevision, setFrameRevision] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | undefined>(undefined);
  const [reloading, setReloading] = useState(false);
  const [state, setState] = useState<SurfaceState>({ phase: "opening" });

  const release = useCallback((surface: MobileExtensionMainViewSurface | undefined): void => {
    bridgeRef.current?.dispose();
    bridgeRef.current = undefined;
    frameOwner.current = undefined;
    if (surface === undefined) return;
    if (surfaceRef.current?.surfaceId === surface.surfaceId) surfaceRef.current = undefined;
    const owner = leaseTransport.current;
    leaseTransport.current = undefined;
    void owner?.closeMainView(surface).catch(() => undefined);
  }, []);

  useEffect(() => {
    const currentTransport = transportRef.current;
    const controller = new AbortController();
    const request = Symbol("extension-main-view-open");
    occurrence.current = request;
    release(surfaceRef.current);
    setFrameLoaded(false);
    setFrameUrl(undefined);
    setReloading(false);
    setState({ phase: "opening" });
    void currentTransport.openMainView(extension, controller.signal).then((surface) => {
      if (controller.signal.aborted || occurrence.current !== request
        || transportRef.current.ownerKey !== currentTransport.ownerKey) {
        void currentTransport.closeMainView(surface).catch(() => undefined);
        return;
      }
      leaseTransport.current = currentTransport;
      surfaceRef.current = surface;
      setState({ phase: "ready", surface });
    }, () => {
      if (!controller.signal.aborted && occurrence.current === request
        && transportRef.current.ownerKey === currentTransport.ownerKey) setState({ phase: "error" });
    });
    return () => {
      controller.abort();
      reloadAbort.current?.abort();
      if (occurrence.current === request) occurrence.current = undefined;
      release(surfaceRef.current);
    };
  }, [attempt, extension.extensionId, extension.revision, release, transport.ownerKey]);

  const revoke = useCallback((surface: MobileExtensionMainViewSurface, phase: "error" | "revoked") => {
    if (surfaceRef.current?.surfaceId !== surface.surfaceId) return;
    occurrence.current = undefined;
    reloadAbort.current?.abort();
    setFrameLoaded(false);
    setReloading(false);
    release(surface);
    setState({ phase });
  }, [release]);

  useEffect(() => {
    if (state.phase !== "ready") return undefined;
    const expected = state.surface;
    const currentTransport = leaseTransport.current;
    if (currentTransport === undefined) return undefined;
    let probing = false;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (probing || surfaceRef.current?.surfaceId !== expected.surfaceId) return;
      probing = true;
      void currentTransport.probeMainView(expected, controller.signal).then((current) => {
        if (!sameMobileExtensionMainViewSurface(expected, current)) throw new Error("Extension main view changed.");
      }).catch(() => {
        if (!controller.signal.aborted) revoke(expected, "revoked");
      }).finally(() => { probing = false; });
    }, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [revoke, state]);

  const reload = (): void => {
    if (state.phase !== "ready" || reloading) return;
    const expected = state.surface;
    const currentTransport = leaseTransport.current;
    if (currentTransport === undefined) return;
    bridgeRef.current?.dispose();
    bridgeRef.current = undefined;
    frameOwner.current = undefined;
    reloadAbort.current?.abort();
    const controller = new AbortController();
    reloadAbort.current = controller;
    setReloading(true);
    void currentTransport.probeMainView(expected, controller.signal).then((current) => {
      if (controller.signal.aborted || surfaceRef.current?.surfaceId !== expected.surfaceId) return;
      if (!sameMobileExtensionMainViewSurface(expected, current)) throw new Error("Extension main view changed.");
      setFrameLoaded(false);
      setFrameRevision((value) => value + 1);
    }).catch(() => {
      if (!controller.signal.aborted) revoke(expected, "revoked");
    }).finally(() => {
      if (reloadAbort.current === controller) reloadAbort.current = undefined;
      if (!controller.signal.aborted) setReloading(false);
    });
  };

  const title = state.phase === "ready"
    ? state.surface.title ?? extension.mainView?.title ?? extension.name
    : extension.mainView?.title ?? extension.name;
  const readySurface = state.phase === "ready" ? state.surface : undefined;
  const frame = useMemo(() => readySurface === undefined ? undefined : {
    id: `${readySurface.surfaceId}:${frameRevision}`, url: frameUrl ?? readySurface.url, started: false
  }, [readySurface, frameRevision, frameUrl]);
  // The marker also fences native callbacks delivered after a remount.
  if (!reloading) frameOwner.current = frame;
  const extensionKey = mobileExtensionKey(extension);
  useEffect(() => {
    const owner = leaseTransport.current;
    if (frame === undefined || readySurface === undefined || extension.library === undefined || owner === undefined) return undefined;
    const bridge = new MobileExtensionLibraryBridge({
      extension, surface: readySurface, frameId: frame.id, transport: owner,
      current: () => frameOwner.current === frame && surfaceRef.current?.surfaceId === readySurface.surfaceId
        && transportRef.current.ownerKey === owner.ownerKey,
      send: (message) => {
        if (webRef.current === null) throw new Error("The Extension page is no longer mounted.");
        webRef.current.postMessage(message);
      }
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      if (bridgeRef.current === bridge) bridgeRef.current = undefined;
    };
  }, [extensionKey, frame, readySurface, transport.ownerKey]);
  const currentFrame = (): boolean => frame !== undefined && frameOwner.current === frame
    && surfaceRef.current?.surfaceId === readySurface?.surfaceId;
  const retireFrame = (): void => {
    bridgeRef.current?.dispose();
    bridgeRef.current = undefined;
    frameOwner.current = undefined;
    setFrameLoaded(false);
    setFrameRevision((value) => value + 1);
  };

  return <View style={[styles.root, { backgroundColor: colors.background }]} testID="extensions.mainView.surface">
    <View style={[styles.header, { borderColor: colors.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "extension.mainViewBack")}
        onPress={onBack} style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text style={[styles.actionText, { color: colors.ink }]}>{mobileMessage(locale, "common.back")}</Text>
      </Pressable>
      <View style={styles.grow}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{title}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.mainViewEyebrow")}</Text>
      </View>
      {state.phase === "ready" && <Pressable accessibilityRole="button"
        accessibilityLabel={mobileMessage(locale, "extension.mainViewReload")}
        accessibilityState={{ disabled: reloading }} disabled={reloading} onPress={reload}
        style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, reloading && styles.disabled]}>
        <Text style={[styles.actionText, { color: colors.ink }]}>{mobileMessage(locale, "common.refresh")}</Text>
      </Pressable>}
    </View>
    {state.phase === "opening"
      ? <Status colors={colors} loading text={mobileMessage(locale, "extension.mainViewOpening")} />
      : state.phase === "error" || state.phase === "revoked"
        ? <View style={styles.centered} accessibilityRole="alert">
          <Text style={[styles.body, styles.centeredText, { color: colors.negative }]}>{mobileMessage(locale,
            state.phase === "revoked" ? "extension.mainViewRevoked" : "extension.mainViewUnavailable")}</Text>
          <View style={styles.actionRow}>
            <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.retry")}
              onPress={() => setAttempt((value) => value + 1)}
              style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Text style={[styles.actionText, { color: colors.ink }]}>{mobileMessage(locale, "common.retry")}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "extension.mainViewBack")}
              onPress={onBack} style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Text style={[styles.actionText, { color: colors.ink }]}>{mobileMessage(locale, "common.back")}</Text>
            </Pressable>
          </View>
        </View>
        : readySurface && <View style={styles.frame}>
          {!frameLoaded && <View style={styles.overlay} pointerEvents="none">
            <Status colors={colors} loading text={mobileMessage(locale,
              reloading ? "extension.mainViewReloading" : "extension.mainViewLoadingContent")} />
          </View>}
          <WebView ref={webRef} key={frame?.id} source={{ uri: frame?.url ?? readySurface.url }}
            originWhitelist={[new URL(readySurface.url).origin]} style={[styles.frame, { backgroundColor: colors.background }]}
            scrollEnabled javaScriptEnabled javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
            allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
            mediaCapturePermissionGrantType="deny" sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
            domStorageEnabled={false} incognito cacheEnabled={false} mixedContentMode="never"
            injectedJavaScriptBeforeContentLoaded={extension.library && frame
              ? mobileExtensionLibraryBootstrap(frame.id, readySurface.surfaceId) : undefined}
            injectedJavaScript={extension.library && frame
              ? mobileExtensionLibraryBootstrap(frame.id, readySurface.surfaceId) : undefined}
            injectedJavaScriptBeforeContentLoadedForMainFrameOnly injectedJavaScriptForMainFrameOnly
            onMessage={extension.library ? (event) => {
              if (currentFrame()) bridgeRef.current?.receive(event.nativeEvent.data, event.nativeEvent.url);
            } : undefined}
            onShouldStartLoadWithRequest={(request) => {
              if (!currentFrame() || request.isTopFrame === false
                || !allowMobileExtensionMainViewNavigation(readySurface, request.url ?? "")) return false;
              const destination = new URL(request.url);
              const current = new URL(frame!.url);
              if (destination.pathname === current.pathname && destination.hash !== current.hash) return true;
              if (destination.pathname === current.pathname && !frame!.started) return true;
              retireFrame();
              setFrameUrl(request.url);
              return false;
            }}
            onLoadStart={() => { if (currentFrame()) frame!.started = true; }}
            onLoadEnd={() => {
              if (currentFrame()) {
                setFrameLoaded(true);
                setReloading(false);
              }
            }}
            onError={() => { if (currentFrame()) revoke(readySurface, "error"); }}
            onHttpError={() => { if (currentFrame()) revoke(readySurface, "revoked"); }}
            onContentProcessDidTerminate={() => { if (currentFrame()) revoke(readySurface, "revoked"); }}
            onRenderProcessGone={() => { if (currentFrame()) revoke(readySurface, "revoked"); }} />
        </View>}
  </View>;
}

function Status({ colors, loading, text }: {
  readonly colors: MobilePartnersColors;
  readonly loading: boolean;
  readonly text: string;
}) {
  return <View style={styles.centered} accessibilityRole={loading ? "progressbar" : undefined}>
    {loading && <ActivityIndicator color={colors.accent} />}
    <Text style={[styles.body, styles.centeredText, { color: colors.muted }]}>{text}</Text>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 },
  frame: { flex: 1, minHeight: 0 },
  header: { alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 12,
    minHeight: 64, padding: 12 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, fontWeight: "700" },
  caption: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 15, lineHeight: 21 },
  centered: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center", padding: 24 },
  centeredText: { maxWidth: 380, textAlign: "center" },
  action: { alignItems: "center", borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 12 },
  actionText: { fontSize: 14, fontWeight: "600" },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  disabled: { opacity: 0.45 },
  overlay: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0, zIndex: 1 }
});
