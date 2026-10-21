import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Linking, Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { requireNativeViewManager } from "expo-modules-core";
import { mcpAppFrameUrlAllowed } from "@joko/contracts";
import native from "../modules/joko-mcp-app-surface/src/JokoMcpAppSurfaceModule";
import type { MobileMcpAppApi } from "./mobile-mcp-app-api";
import { MobileMcpAppView } from "./mobile-mcp-app-view";

export const mobileMcpAppAvailable = native?.appHostAvailable === true;
type SurfaceProps = import("react-native").ViewProps & { readonly surfaceId: string };
const Host = mobileMcpAppAvailable ? requireNativeViewManager<SurfaceProps>("JokoMcpAppSurface", "AppHost") : null;
export const MobileMcpAppSlot = mobileMcpAppAvailable ? requireNativeViewManager<SurfaceProps>("JokoMcpAppSurface", "AppSlot") : null;
const Context = createContext<{ readonly foreground: boolean; readonly ownerKey: string;
  open(sessionId: string, cardId: string, context: Record<string, unknown>): MobileMcpAppView | undefined } | null>(null);
export const useMobileMcpAppViews = () => useContext(Context);

/** A persistent native host supplies inline slots without recreating the WebView on route unmount. */
export function MobileMcpAppViewsProvider({ children, ownerKey, bind }: { readonly children: ReactNode; readonly ownerKey: string;
  readonly bind: (sessionId: string) => MobileMcpAppApi | undefined }) {
  const views = useRef(new Set<MobileMcpAppView>()), mounted = useRef(true), source = useRef(bind); source.current = bind;
  const [, refresh] = useState(0), [foreground, setForeground] = useState(AppState.currentState === "active");
  const changed = useCallback(() => { if (mounted.current) refresh(n => n + 1); }, []);
  const open = useCallback((sessionId: string, cardId: string, context: Record<string, unknown>) => {
    const api = source.current(sessionId); if (!api || !mobileMcpAppAvailable) return undefined;
    const view = new MobileMcpAppView(api, sessionId, cardId, changed, () => { views.current.delete(view); changed(); }, async url => {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("MCP_APP_INVALID_LINK");
      await Linking.openURL(parsed.href);
    });
    views.current.add(view); changed(); void view.open(context); return view;
  }, [changed]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", state => {
      const active = state === "active"; if (!active) for (const view of views.current) void view.close(); setForeground(active);
    });
    return () => { mounted.current = false; subscription.remove(); for (const view of views.current) void view.close(); };
  }, []);
  useEffect(() => () => { for (const view of views.current) void view.close(); }, [ownerKey]);
  const value = useMemo(() => ({ foreground, ownerKey, open }), [foreground, ownerKey, open]);
  return <Context.Provider value={value}><View style={styles.root}>{children}
    {Host && [...views.current].map(view => <Host key={view.id} surfaceId={view.id} pointerEvents="none" accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" style={{ position: "absolute", left: -100_000, top: 0, width: view.width, height: view.state.height }}>
      <NativeView view={view} />
    </Host>)}
  </View></Context.Provider>;
}
function NativeView({ view }: { readonly view: MobileMcpAppView }) {
  const bind = useCallback((webview: WebView | null) => { view.inject = webview ? script => webview.injectJavaScript(script) : undefined; }, [view]);
  const { nativeDocument, document } = view;
  if (!nativeDocument || !document) return null;
  return <WebView ref={bind} source={nativeDocument.source} style={{ height: view.state.height, backgroundColor: "transparent" }}
    originWhitelist={["*"]} allowFileAccess={false} allowUniversalAccessFromFileURLs={false}
    sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} incognito={Platform.OS === "ios"} cacheEnabled={false} domStorageEnabled
    javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows allowsInlineMediaPlayback={false} mediaPlaybackRequiresUserAction
    onShouldStartLoadWithRequest={request => nativeDocument.documentUrls.slice(0, 2).includes(request.url)
      || request.isTopFrame !== true && (nativeDocument.documentUrls.includes(request.url) || mcpAppFrameUrlAllowed(request.url, document.frameDomains))}
    onMessage={event => view.receive(event.nativeEvent.data)} onError={() => view.fail()}
    onContentProcessDidTerminate={() => view.fail()} onRenderProcessGone={() => view.fail()} />;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
