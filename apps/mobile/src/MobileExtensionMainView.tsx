import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { base64Encode } from "@bufbuild/protobuf/wire";
import {
  allowMobileExtensionMainViewNavigation,
  mobileExtensionKey,
  sameMobileExtensionMainViewSurface,
  type MobileExtension,
  type MobileExtensionMainViewSurface,
  type MobileExtensionResourceKind,
  type MobileExtensionTransport
} from "./mobile-extensions";
import { MobileExtensionLibraryBridge, mobileExtensionLibraryBootstrap } from "./mobile-extension-library-bridge";
import { MobileExtensionSettingsBridge, mobileExtensionSettingsBootstrap } from "./mobile-extension-settings";
import { MobileExtensionDirectoryPicker, type MobileExtensionDirectoryRequest } from "./MobileExtensionDirectoryPicker";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { allowExtensionDocumentNavigation, prepareExtensionMainViewDocument, type PreparedExtensionMainViewDocument } from "./mobile-extension-main-view-document";
import { MOBILE_EXTENSION_RESOURCE_MAXIMUM_BYTES, MOBILE_EXTENSION_STYLE_MAXIMUM_BYTES } from "./mobile-extension-main-view-resource";

type SurfaceState =
  | { readonly phase: "opening" }
  | { readonly phase: "ready"; readonly surface: MobileExtensionMainViewSurface; readonly document: PreparedExtensionMainViewDocument; readonly logicalUrl: string }
  | { readonly phase: "error" | "revoked" };

export function MobileExtensionMainView({ colors, extension, locale, onBack, transport, settings = false, onOpenLibrary }: {
  readonly colors: MobilePartnersColors;
  readonly extension: MobileExtension;
  readonly locale: MobileSupportedLocale;
  readonly onBack: () => void;
  readonly transport: MobileExtensionTransport;
  readonly settings?: boolean;
  readonly onOpenLibrary?: () => void;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const openLibraryRef = useRef(onOpenLibrary); openLibraryRef.current = onOpenLibrary;
  const leaseTransport = useRef<MobileExtensionTransport | undefined>(undefined);
  const surfaceRef = useRef<MobileExtensionMainViewSurface | undefined>(undefined);
  const documentRef = useRef<PreparedExtensionMainViewDocument | undefined>(undefined);
  const occurrence = useRef<symbol | undefined>(undefined);
  const openingAbort = useRef<AbortController | undefined>(undefined);
  const reloadAbort = useRef<AbortController | undefined>(undefined);
  const webRef = useRef<WebView>(null);
  const bridgeRef = useRef<MobileExtensionLibraryBridge | undefined>(undefined);
  const settingsBridge = useRef<MobileExtensionSettingsBridge | undefined>(undefined);
  const authorizing = useRef<symbol | undefined>(undefined);
  const directoryOwner = useRef<MobileExtensionDirectoryRequest | undefined>(undefined), directorySequence = useRef(0);
  const [directory, setDirectory] = useState<MobileExtensionDirectoryRequest>();
  const frameOwner = useRef<{ readonly id: string; readonly url: string; started: boolean; resources: Set<AbortController> } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [frameRevision, setFrameRevision] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [state, setState] = useState<SurfaceState>({ phase: "opening" });

  const release = useCallback((surface: MobileExtensionMainViewSurface | undefined): void => {
    directoryOwner.current?.finish(undefined);
    bridgeRef.current?.dispose();
    bridgeRef.current = undefined;
    settingsBridge.current?.dispose(); settingsBridge.current = undefined;
    authorizing.current = undefined;
    for (const request of frameOwner.current?.resources ?? []) request.abort();
    frameOwner.current = undefined;
    const document = documentRef.current; documentRef.current = undefined;
    void document?.close().catch(() => undefined);
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
    openingAbort.current = controller;
    setFrameLoaded(false);
    setReloading(false);
    setState({ phase: "opening" });
    const cleanup = () => {
      controller.abort();
      if (openingAbort.current === controller) openingAbort.current = undefined;
      reloadAbort.current?.abort();
      if (occurrence.current === request) occurrence.current = undefined;
      release(surfaceRef.current);
    };
    if (settings && AppState.currentState !== "active") {
      controller.abort(); occurrence.current = undefined; setState({ phase: "revoked" });
      return cleanup;
    }
    const opening = settings ? currentTransport.openSettings?.(extension, controller.signal)
      ?? Promise.reject(new Error("Plugin author settings are unavailable.")) : currentTransport.openMainView(extension, controller.signal);
    void opening.then(async (surface) => {
      if (controller.signal.aborted || occurrence.current !== request
        || transportRef.current.ownerKey !== currentTransport.ownerKey) {
        void currentTransport.closeMainView(surface).catch(() => undefined);
        return;
      }
      leaseTransport.current = currentTransport;
      surfaceRef.current = surface;
      const resource = await currentTransport.readMainViewResource(surface, surface.url, "document", controller.signal);
      const entry = decodeURIComponent(new URL(surface.url).pathname.split("/").at(-1)!);
      const document = await prepareExtensionMainViewDocument(resource, entry, surface.url, controller.signal);
      if (controller.signal.aborted || occurrence.current !== request || surfaceRef.current !== surface
        || transportRef.current.ownerKey !== currentTransport.ownerKey) {
        await document.close().catch(() => undefined);
        return;
      }
      documentRef.current = document;
      setState({ phase: "ready", surface, document, logicalUrl: surface.url });
    }).catch(() => {
      if (!controller.signal.aborted && occurrence.current === request
        && transportRef.current.ownerKey === currentTransport.ownerKey) { release(surfaceRef.current); setState({ phase: "error" }); }
    });
    return cleanup;
  }, [attempt, extension.extensionId, extension.revision, release, settings, transport.ownerKey]);

  const revoke = useCallback((surface: MobileExtensionMainViewSurface, phase: "error" | "revoked") => {
    if (surfaceRef.current?.surfaceId !== surface.surfaceId) return;
    occurrence.current = undefined;
    openingAbort.current?.abort();
    reloadAbort.current?.abort();
    setFrameLoaded(false);
    setReloading(false);
    release(surface);
    setState({ phase });
  }, [release]);

  useEffect(() => {
    if (!settings) return;
    const listener = AppState.addEventListener("change", value => {
      const surface = surfaceRef.current;
      if (value === "active" || authorizing.current) return;
      openingAbort.current?.abort();
      if (surface) revoke(surface, "revoked");
      else {
        occurrence.current = undefined; reloadAbort.current?.abort(); release(undefined);
        setFrameLoaded(false); setReloading(false); setState({ phase: "revoked" });
      }
    });
    return () => listener.remove();
  }, [release, revoke, settings]);

  useEffect(() => {
    if (state.phase !== "ready") return undefined;
    const expected = state.surface;
    const currentTransport = leaseTransport.current;
    if (currentTransport === undefined) return undefined;
    let probing = false;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (settings && authorizing.current && AppState.currentState !== "active") return;
      if (probing || surfaceRef.current?.surfaceId !== expected.surfaceId) return;
      probing = true;
      void currentTransport.probeMainView(expected, controller.signal).then((current) => {
        if (!sameMobileExtensionMainViewSurface(expected, current)) throw new Error("Extension main view changed.");
      }).catch(() => {
        if (!controller.signal.aborted && !(settings && authorizing.current)) revoke(expected, "revoked");
      }).finally(() => { probing = false; });
    }, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [revoke, settings, state]);

  const reload = (destination?: string): void => {
    if (state.phase !== "ready" || reloading) return;
    const expected = state.surface;
    const currentTransport = leaseTransport.current;
    if (currentTransport === undefined) return;
    const logicalUrl = destination ?? state.logicalUrl;
    if (!allowMobileExtensionMainViewNavigation(expected, logicalUrl)) return;
    bridgeRef.current?.dispose();
    bridgeRef.current = undefined;
    settingsBridge.current?.dispose(); settingsBridge.current = undefined;
    for (const request of frameOwner.current?.resources ?? []) request.abort();
    frameOwner.current = undefined;
    const previousDocument = documentRef.current; documentRef.current = undefined;
    void previousDocument?.close().catch(() => undefined);
    reloadAbort.current?.abort();
    const controller = new AbortController();
    reloadAbort.current = controller;
    setReloading(true);
    void currentTransport.probeMainView(expected, controller.signal).then(async (current) => {
      if (controller.signal.aborted || surfaceRef.current?.surfaceId !== expected.surfaceId) return;
      if (!sameMobileExtensionMainViewSurface(expected, current)) throw new Error("Extension main view changed.");
      const resource = await currentTransport.readMainViewResource(expected, logicalUrl, "document", controller.signal);
      const root = expected.url.slice(0, expected.url.lastIndexOf("/") + 1);
      const target = new URL(logicalUrl); target.hash = "";
      const entry = target.href.slice(root.length).split("/").map(decodeURIComponent).join("/");
      const document = await prepareExtensionMainViewDocument(resource, entry, logicalUrl, controller.signal);
      if (controller.signal.aborted || surfaceRef.current?.surfaceId !== expected.surfaceId
        || transportRef.current.ownerKey !== currentTransport.ownerKey) { await document.close().catch(() => undefined); return; }
      documentRef.current = document;
      setState({ phase: "ready", surface: expected, document, logicalUrl });
      setFrameLoaded(false);
      setFrameRevision((value) => value + 1);
    }).catch(() => {
      if (!controller.signal.aborted) revoke(expected, "revoked");
    }).finally(() => {
      if (reloadAbort.current === controller) reloadAbort.current = undefined;
      if (!controller.signal.aborted) setReloading(false);
    });
  };

  const title = settings ? extension.settings?.title ?? mobileMessage(locale, "extension.settings") : state.phase === "ready"
    ? state.surface.title ?? extension.mainView?.title ?? extension.name
    : extension.mainView?.title ?? extension.name;
  const readySurface = state.phase === "ready" ? state.surface : undefined;
  const readyDocument = state.phase === "ready" ? state.document : undefined;
  const logicalUrl = state.phase === "ready" ? state.logicalUrl : undefined;
  const frame = useMemo(() => readySurface === undefined || readyDocument === undefined ? undefined : {
    id: `${readySurface.surfaceId}:${frameRevision}`, url: readyDocument.documentUrl, started: false,
    resources: new Set<AbortController>(), resourceQueue: Promise.resolve(), resourceBytes: 0, resourceIds: new Set<string>()
  }, [readySurface, readyDocument, frameRevision]);
  // The marker also fences native callbacks delivered after a remount.
  if (!reloading) frameOwner.current = frame;
  const extensionKey = mobileExtensionKey(extension);
  useEffect(() => {
    const owner = leaseTransport.current;
    if (settings || frame === undefined || readySurface === undefined || extension.library === undefined || owner === undefined) return undefined;
    const bridge = new MobileExtensionLibraryBridge({
      extension, surface: readySurface, frameId: frame.id, transport: owner, documentUrl: frame.url,
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
  }, [extensionKey, frame, readySurface, settings, transport.ownerKey]);
  useEffect(() => {
    const owner = leaseTransport.current;
    if (!settings || !frame || !readySurface || readySurface.purpose !== "settings" || !owner?.callSettings) return;
    const current = () => frameOwner.current === frame && surfaceRef.current?.surfaceId === readySurface.surfaceId
      && transportRef.current.ownerKey === owner.ownerKey;
    const bridge = new MobileExtensionSettingsBridge({ surface: readySurface, frameId: frame.id, documentUrl: frame.url, transport: owner,
      current, foreground: () => AppState.currentState === "active", send: message => {
        if (!webRef.current) throw new Error("Settings document retired."); webRef.current.postMessage(message);
      }, host: {
        locale,
        chooseDirectory: (choice, signal) => new Promise<string | undefined>((resolve, reject) => {
          signal.throwIfAborted();
          if (!current() || AppState.currentState !== "active" || directoryOwner.current
            || choice.initialPage.picker?.extensionId !== readySurface.extensionId) { reject(new Error("Plugin directory selection is unavailable.")); return; }
          let settled = false;
          const cancel = () => pending.finish(undefined);
          const pending: MobileExtensionDirectoryRequest = { id: `${readySurface.surfaceId}:directory:${++directorySequence.current}`, choice, signal, current,
            finish: entryId => {
              if (settled) return; settled = true; signal.removeEventListener("abort", cancel);
              if (directoryOwner.current === pending) { directoryOwner.current = undefined; setDirectory(undefined); }
              resolve(!signal.aborted && current() && AppState.currentState === "active" ? entryId : undefined);
            } };
          directoryOwner.current = pending; signal.addEventListener("abort", cancel, { once: true }); setDirectory(pending);
        }),
        confirm: (title, body, signal) => new Promise<boolean>(resolve => {
          let settled = false;
          const finish = (accepted: boolean) => {
            if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
            resolve(accepted && !signal.aborted && current() && AppState.currentState === "active");
          };
          const cancel = () => finish(false), timer = setTimeout(cancel, 60_000);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted || !current()) { cancel(); return; }
          Alert.alert(title, body, [{ text: mobileMessage(locale, "common.cancel"), style: "cancel", onPress: cancel },
            { text: mobileMessage(locale, "extension.settingsConfirm"), onPress: () => finish(true) }], { cancelable: true, onDismiss: cancel });
        }),
        authorize: async (authorization, expiresAt, signal) => {
          signal.throwIfAborted();
          if (!current() || AppState.currentState !== "active") throw new Error("Plugin settings owner changed.");
          const authorizationOwner = Symbol("extension-settings-authorization");
          authorizing.current = authorizationOwner;
          try {
            const driver = await import("./mobile-extension-oauth");
            return await driver.authorizeMobileExtensionAccount(authorization, expiresAt, signal, () => {
              signal.throwIfAborted(); if (!current()) throw new Error("Plugin settings owner changed.");
            });
          } finally {
            if (authorizing.current === authorizationOwner) {
              authorizing.current = undefined;
              if (current() && AppState.currentState !== "active") revoke(readySurface, "revoked");
            }
          }
        },
        openLibrary: async signal => { signal.throwIfAborted(); if (!current() || !openLibraryRef.current) throw new Error("Plugin Library is unavailable."); openLibraryRef.current(); }
      } });
    settingsBridge.current = bridge;
    return () => { bridge.dispose(); if (settingsBridge.current === bridge) settingsBridge.current = undefined; };
  }, [extensionKey, frame, locale, readySurface, revoke, settings, transport.ownerKey]);
  const currentFrame = (): boolean => frame !== undefined && frameOwner.current === frame
    && surfaceRef.current?.surfaceId === readySurface?.surfaceId;
  const receiveResource = (data: string, documentUrl: string): boolean => {
    if (data.length > 24 * 1024 * 1024) return false;
    let message: unknown;
    try { message = JSON.parse(data); } catch { return false; }
    if (message === null || typeof message !== "object" || (message as { type?: unknown }).type !== "joko:extension-resource") return false;
    if (!currentFrame() || frame === undefined || readySurface === undefined || readyDocument === undefined || reloading) return true;
    try { const source = new URL(documentUrl); source.hash = ""; if (source.href !== frame.url) return true; }
    catch { return true; }
    const value = message as Record<string, unknown>;
    if (value.version !== 1 || value.documentId !== readyDocument.documentId || typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.id)
      || !["media", "navigate", "script", "module", "style", "style-text"].includes(value.kind as string) || typeof value.url !== "string" || value.url.length > 4096
      || !allowMobileExtensionMainViewNavigation(readySurface, value.url) || frame.resourceIds.has(value.id)) return true;
    const reply = (result: { ok: boolean; dataUrl?: string }): void => {
      if (currentFrame()) webRef.current?.postMessage(JSON.stringify({ type: "joko:extension-resource-result", version: 1,
        documentId: readyDocument.documentId, id: value.id, ...result }));
    };
    if (value.kind === "style-text" ? typeof value.text !== "string" || new TextEncoder().encode(value.text).byteLength > MOBILE_EXTENSION_STYLE_MAXIMUM_BYTES : value.text !== undefined) { reply({ ok: false }); return true; }
    if (frame.resourceIds.size >= 4096 || frame.resources.size >= 64) { reply({ ok: false }); return true; }
    frame.resourceIds.add(value.id);
    if (value.kind === "navigate") { reload(value.url); return true; }
    const owner = leaseTransport.current;
    if (owner === undefined) return true;
    const request = new AbortController(); frame.resources.add(request);
    const requestedUrl = value.url;
    const kind = value.kind as MobileExtensionResourceKind;
    const text = value.kind === "style-text" ? value.text as string : undefined;
    frame.resourceQueue = frame.resourceQueue.then(async () => {
      request.signal.throwIfAborted();
      if (!currentFrame()) return;
      const resource = await owner.readMainViewResource(readySurface, requestedUrl, kind, request.signal, text);
      request.signal.throwIfAborted();
      if (!currentFrame()) return;
      frame.resourceBytes += resource.bytes.byteLength;
      const permittedMime = kind === "media" ? /^(?:image|audio|video)\/[a-z0-9.+-]+$/u.test(resource.mimeType)
        : kind === "style" || kind === "style-text" ? resource.mimeType === "text/css" : ["text/javascript", "application/javascript"].includes(resource.mimeType);
      if (frame.resourceBytes > MOBILE_EXTENSION_RESOURCE_MAXIMUM_BYTES || !permittedMime) throw new Error("Extension resource exceeded its document budget.");
      reply({ ok: true, dataUrl: `data:${resource.mimeType};base64,${base64Encode(resource.bytes)}` });
    }).catch(() => { if (!request.signal.aborted) reply({ ok: false }); }).finally(() => { frame.resources.delete(request); });
    return true;
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
        accessibilityState={{ disabled: reloading }} disabled={reloading} onPress={() => reload()}
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
        : readySurface && readyDocument && <View style={styles.frame}>
          {!frameLoaded && <View style={styles.overlay} pointerEvents="none">
            <Status colors={colors} loading text={mobileMessage(locale,
              reloading ? "extension.mainViewReloading" : "extension.mainViewLoadingContent")} />
          </View>}
          <WebView ref={webRef} key={frame?.id} source={{ uri: readyDocument.source.uri + new URL(logicalUrl!).hash }}
            originWhitelist={["*"]} style={[styles.frame, { backgroundColor: colors.background }]}
            scrollEnabled javaScriptEnabled javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
            allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
            mediaCapturePermissionGrantType="deny" sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
            domStorageEnabled={false} incognito={Platform.OS === "ios"} cacheEnabled={false} mixedContentMode="never"
            injectedJavaScriptBeforeContentLoaded={`globalThis[Symbol.for('joko.extension.surface.base')]=${JSON.stringify(logicalUrl)};${settings && frame ? mobileExtensionSettingsBootstrap(frame.id, readySurface.surfaceId) : extension.library && frame ? mobileExtensionLibraryBootstrap(frame.id, readySurface.surfaceId) : "true;"}`}
            injectedJavaScript={`globalThis[Symbol.for('joko.extension.surface.base')]=${JSON.stringify(logicalUrl)};${settings && frame ? mobileExtensionSettingsBootstrap(frame.id, readySurface.surfaceId) : extension.library && frame ? mobileExtensionLibraryBootstrap(frame.id, readySurface.surfaceId) : "true;"}`}
            injectedJavaScriptBeforeContentLoadedForMainFrameOnly injectedJavaScriptForMainFrameOnly
            onMessage={(event) => {
              if (!currentFrame()) return;
              if (!receiveResource(event.nativeEvent.data, event.nativeEvent.url)) {
                if (settings) settingsBridge.current?.receive(event.nativeEvent.data, event.nativeEvent.url);
                else if (extension.library) bridgeRef.current?.receive(event.nativeEvent.data, event.nativeEvent.url);
              }
            }}
            onShouldStartLoadWithRequest={(request) => {
              if (!currentFrame() || request.isTopFrame === false) return false;
              let destination: URL;
              try { destination = new URL(request.url); } catch { return false; }
              const current = new URL(frame!.url);
              if (allowExtensionDocumentNavigation(readyDocument, request.url)) {
                if (destination.pathname !== current.pathname || destination.hash !== current.hash || !frame!.started) return true;
                reload(); return false;
              }
              let logical = request.url;
              if (destination.origin === current.origin) {
                const root = readySurface.url.slice(0, readySurface.url.lastIndexOf("/") + 1);
                logical = new URL(destination.pathname.slice(1) + destination.hash, root).href;
              }
              if (allowMobileExtensionMainViewNavigation(readySurface, logical)) reload(logical);
              return false;
            }}
            onLoadStart={(event) => { if (currentFrame() && (!event?.nativeEvent?.url || new URL(event.nativeEvent.url).pathname === new URL(frame!.url).pathname)) frame!.started = true; }}
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
    {directory && <MobileExtensionDirectoryPicker request={directory} colors={colors} locale={locale} />}
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
