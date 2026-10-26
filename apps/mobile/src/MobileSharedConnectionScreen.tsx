import { useEffect, useRef, useState, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { Alert, AppState, Platform, StyleSheet, Text } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import type { MobileClient, MobileState } from "./mobile-client";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileThemePreference } from "./mobile-theme-preference";
import { mobileMessage } from "./mobile-messages";
import { mobileConnectionMessages, projectMobileConnection } from "./mobile-connection-presentation";
import { mobileConnectionJson, parseMobileConnectionMessage, type MobileConnectionMessage } from "./mobile-connection-protocol";
import connectionRuntime from "./connection-runtime.connjs";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { mobileIrohNativeAvailable } from './mobile-iroh-native';
import { mobileHttpConnectNativeAvailable } from './mobile-http-connect-native';
import { linkspanRuntimeAssets, linkspanWebRtcRuntimeAssets } from './linkspan-runtime-assets';

interface ConnectionWebViewHandle { injectJavaScript(script: string): void }
const ConnectionWebView = WebView as unknown as ForwardRefExoticComponent<WebViewProps & RefAttributes<ConnectionWebViewHandle>>;
const connectionBaseUrl = "https://joko-connection.invalid";
let surfaceSequence = 0;

interface MobileSharedConnectionScreenProps {
  readonly client: MobileClient;
  readonly state: MobileState;
  readonly locale: MobileSupportedLocale;
  readonly dark: boolean;
  readonly defaultDeviceName: string;
  readonly onThemeChange: (theme: MobileThemePreference) => Promise<void>;
  readonly onBack?: () => void;
  readonly onConnected: () => void;
}

/** Native authority adapter; layout, controls and gestures run the Web page itself. */
export function MobileSharedConnectionScreen(props: MobileSharedConnectionScreenProps) {
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  const [surface, setSurface] = useState(() => `joko-connection-${++surfaceSequence}`);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [notice, setNotice] = useState("");
  const webView = useRef<ConnectionWebViewHandle | null>(null);
  const ready = useRef(false);
  const activeSurface = useRef(surface);
  const lastRequestId = useRef(0);
  const current = useRef(props);
  current.current = props;
  const projectedState = projectMobileConnection(props.state, props.locale, props.dark, props.defaultDeviceName, props.onBack !== undefined, foreground);
  const publicView = {
    instanceId: surface, locale: props.locale, dark: props.dark,
    state: { ...projectedState, capabilities: { ...projectedState.capabilities, irohNativeAvailable: mobileIrohNativeAvailable(),
      irohRelayAvailable: linkspanRuntimeAssets.iroh !== undefined, tailcatRelayAvailable: linkspanRuntimeAssets.tailcat !== undefined,
      webRtcAvailable: linkspanWebRtcRuntimeAssets !== undefined, httpConnectNativeAvailable: mobileHttpConnectNativeAvailable() } },
    messages: mobileConnectionMessages(props.locale)
  };
  const latestPublicView = useRef(publicView);
  latestPublicView.current = publicView;
  // One local document per renderer occurrence. Updates keep DOM drafts and artwork state.
  const initialHtml = useRef<{ surface: string; html: string } | null>(null);
  if (initialHtml.current?.surface !== surface) initialHtml.current = {
    surface,
    html: buildMobileConnectionHtml(publicView)
  };

  useEffect(() => {
    // A replacement ref is attached before the retired effect is cleaned up.
    // Close this occurrence's document, never whichever renderer is current.
    const renderer = webView.current;
    activeSurface.current = surface;
    ready.current = false;
    lastRequestId.current = 0;
    return () => {
      if (activeSurface.current === surface) activeSurface.current = "";
      ready.current = false;
      renderer?.injectJavaScript("window.jokoConnection?.close();true;");
    };
  }, [surface]);

  useEffect(() => {
    if (ready.current) webView.current?.injectJavaScript(`window.jokoConnection?.update(${mobileConnectionJson(publicView)});true;`);
  }, [props.state, props.locale, props.dark, props.defaultDeviceName, props.onBack, foreground, surface]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);

  const recover = () => {
    activeSurface.current = "";
    ready.current = false;
    setNotice(mobileMessage(current.current.locale, "connection.repair"));
    setSurface(`joko-connection-${++surfaceSequence}`);
  };
  const handleMessage = (event: WebViewMessageEvent) => {
    if (activeSurface.current !== surface) return;
    const message = parseMobileConnectionMessage(event.nativeEvent.data, surface);
    if (!message) return;
    if (message.type === "ready") {
      ready.current = true;
      setNotice("");
      webView.current?.injectJavaScript(`window.jokoConnection.update(${mobileConnectionJson(latestPublicView.current)});true;`);
      return;
    }
    if (!ready.current || message.id <= lastRequestId.current) return;
    lastRequestId.current = message.id;
    const settle = (success: boolean, error?: string, result?: unknown) => {
      if (activeSurface.current !== surface || !ready.current) return;
      webView.current?.injectJavaScript(`window.jokoConnection?.settle(${message.id},${success},${mobileConnectionJson(error)},${mobileConnectionJson(result)});true;`);
    };
    if (!foreground) { settle(false, mobileMessage(current.current.locale, "connection.repair")); return; }
    void executeConnectionAction(message, current.current).then(result => settle(true, undefined, result), (error: unknown) => {
      settle(false, error instanceof Error ? error.message : mobileMessage(current.current.locale, "connection.repair"));
    });
  };

  return <MobileKeyboardAvoidingView style={[styles.fill, { backgroundColor: props.dark ? "#17130e" : "#fef9ef" }]}
    keyboard={keyboard} consumedBottomInset={safeArea.bottom} behavior={Platform.OS === "android" ? "height" : undefined}>
    <SafeAreaView style={styles.fill}>
    {notice !== "" && <Text accessibilityRole="alert" style={[styles.notice, { color: props.dark ? "#f2f2f2" : "#0d0d0d" }]}>{notice}</Text>}
    <ConnectionWebView key={surface} ref={webView}
      source={{ html: initialHtml.current.html, baseUrl: connectionBaseUrl }}
      originWhitelist={[connectionBaseUrl, "about:blank"]}
      onShouldStartLoadWithRequest={(request: { readonly url: string }) => [connectionBaseUrl, `${connectionBaseUrl}/`, "about:blank"].includes(request.url)}
      onMessage={handleMessage}
      onError={recover}
      onContentProcessDidTerminate={recover}
      onRenderProcessGone={() => { recover(); return true; }}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
      bounces={false} javaScriptEnabled domStorageEnabled={false}
      sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} setSupportMultipleWindows={false}
      mixedContentMode="never" scrollEnabled keyboardDisplayRequiresUserAction
      hideKeyboardAccessoryView={false} textInteractionEnabled
      containerStyle={styles.fill} style={styles.fill}
    />
    </SafeAreaView>
  </MobileKeyboardAvoidingView>;
}

async function executeConnectionAction(message: Extract<MobileConnectionMessage, { type: "action" }>,
  props: MobileSharedConnectionScreenProps): Promise<void | { readonly publicKey: string }> {
  const { client, locale } = props;
  const args = message.args;
  const automatic = (index: number): boolean | undefined => (args[index] as { automatic?: boolean } | undefined)?.automatic;
  switch (message.name) {
    case "connect": {
      const profileId = args[0] as string;
      if (!client.state.saved.some((profile) => profile.profileId === profileId)) throw new Error(mobileMessage(locale, "connection.missingSaved"));
      await client.connectSaved(profileId, automatic(1));
      if (client.state.activeProfileId === profileId && client.state.status === "connected") props.onConnected();
      return;
    }
    case "pair":
      await client.pair(args[0] as string, args[1] as string, args[2] as string, automatic(3));
      if (client.state.status === "connected") props.onConnected();
      return;
    case "inspect": await client.inspect(args[0] as string); return;
    case "requestPairing": await client.requestPairing(args[0] as string, args[1] as string); return;
    case "trustEndpoint": await client.trustEndpoint(args[0] as string, args[1] as string, args[2] === true, args[3] == null ? undefined : args[3] as string, args[4] as import('@joko/connection-transport/trust').EndpointTransport | undefined); return;
    case 'createTailcatClient': return client.createTailcatClient(args[0] as string, args[1] as string, args[2] as import('@joko/connection-transport/trust').EndpointTransport);
    case 'createIrohClient': return args.length === 0 ? client.createIrohClient() : args.length === 1 ? client.createIrohClient(undefined, undefined, undefined, args[0] as 'native' | 'relay')
      : client.createIrohClient(args[0] as string, args[1] as string, args[2] as import('@joko/connection-transport/trust').EndpointTransport, args[3] as 'native' | 'relay' | undefined);
    case 'setProfileIrohMode': {
      if (args[1] === 'native' && !mobileIrohNativeAvailable()) throw new Error('Native iroh is unavailable in this app build or OS. Select relay mode explicitly.');
      if (args[1] === 'relay' && linkspanRuntimeAssets.iroh === undefined) throw new Error('The iroh relay runtime was not selected for this app build.');
      await client.setProfileIrohMode(args[0] as string, args[1] as 'native' | 'relay'); return;
    }
    case "setTheme": await props.onThemeChange(args[0] as MobileThemePreference); return;
    case "disconnect": client.cancel(); return;
    case "cancelPairing": await client.cancelPairing(); return;
    case "selectMode": client.setConnectionMode(args[0] === "pair" ? "add" : args[0] as "nearby" | "saved"); return;
    case "refreshDiscoveredNodes": await client.refreshNearby(); return;
    case "recheckSavedProfiles": await client.refreshSaved(); return;
    case "setAutomaticConnectionEnabled":
      if (args[0] === false) await client.disableAutomaticEntry();
      else await client.setAutomaticEntryForActive(true);
      return;
    case "cancelAutomaticConnectionAttempt": return;
    case "goBack": props.onBack?.(); return;
    case "retryManagedOrchestrator": throw new Error(mobileMessage(locale, "connection.repair"));
    case "forgetProfile": {
      const profile = client.state.saved.find((item) => item.profileId === args[0]);
      if (!profile) throw new Error(mobileMessage(locale, "connection.missingSaved"));
      const confirmed = await new Promise<boolean>((resolve) => Alert.alert(
        mobileMessage(locale, "connection.forgetTitle", { name: profile.displayName }), mobileMessage(locale, "connection.forgetBody"),
        [{ text: mobileMessage(locale, "common.keep"), style: "cancel", onPress: () => resolve(false) },
          { text: mobileMessage(locale, "common.forget"), style: "destructive", onPress: () => resolve(true) }],
        { cancelable: true, onDismiss: () => resolve(false) }));
      if (confirmed) await client.forgetConnection(profile.profileId);
    }
  }
}

export function buildMobileConnectionHtml(initial: unknown): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data:; font-src data:; media-src 'none'; frame-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>${connectionRuntime.css}</style></head><body><div id="root"></div>
<script>window.jokoConnectionInitial=${mobileConnectionJson(initial)};</script>
<script>${connectionRuntime.script}</script></body></html>`;
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 }, notice: { padding: 12 } });
