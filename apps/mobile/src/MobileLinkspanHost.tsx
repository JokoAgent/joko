import { useEffect, useRef, useState, useSyncExternalStore, type ForwardRefExoticComponent, type RefAttributes } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import { mobileLinkspanRuntime, type MobileLinkspanBackend, type MobileLinkspanSurface } from './mobile-linkspan-runtime';
import { resumeMobileIrohNative, suspendMobileIrohNative } from './mobile-iroh-native';
import { resumeMobileHttpConnectNative, suspendMobileHttpConnectNative } from './mobile-http-connect-native';
import { linkspanRuntimeAssets, linkspanWebRtcRuntimeAssets } from './linkspan-runtime-assets';

interface Handle { injectJavaScript(script: string): void }
const RuntimeWebView = WebView as unknown as ForwardRefExoticComponent<WebViewProps & RefAttributes<Handle>>;
const baseUrl = 'https://joko-linkspan.invalid';
const modules = (kind: MobileLinkspanBackend): readonly [number, number, number] => {
  if (kind === 'webrtc') throw new Error('The WebRTC runtime has no WASM assets.');
  const selected = linkspanRuntimeAssets[kind];
  if (selected === undefined) throw new Error('This relay runtime was not selected for this app build.');
  return selected;
};
const json = (value: unknown): string => JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

/** Mounts only after a selected SDK path requests a stream. It contains no app UI. */
export function MobileLinkspanHost() {
  const surfaces = useSyncExternalStore(mobileLinkspanRuntime.subscribe, mobileLinkspanRuntime.snapshot);
  useEffect(() => {
    const update = (state: string) => { if (state === 'active') { mobileLinkspanRuntime.resume(); resumeMobileIrohNative(); resumeMobileHttpConnectNative(); } else { mobileLinkspanRuntime.suspend(); suspendMobileIrohNative(); suspendMobileHttpConnectNative(); } };
    update(AppState.currentState);
    const subscription = AppState.addEventListener('change', update);
    return () => { subscription.remove(); mobileLinkspanRuntime.suspend(); suspendMobileIrohNative(); suspendMobileHttpConnectNative(); };
  }, []);
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.host}>
    {surfaces.map(surface => <SelectedRuntime key={surface.occurrence} surface={surface} />)}
  </View>;
}

function SelectedRuntime({ surface }: { readonly surface: MobileLinkspanSurface }) {
  const view = useRef<Handle | null>(null), [html, setHtml] = useState<string>();
  useEffect(() => {
    let current = true;
    const [scriptId, wasmId, noticesId] = surface.kind === 'webrtc'
      ? [linkspanWebRtcRuntimeAssets?.[0], undefined, linkspanWebRtcRuntimeAssets?.[1]] : modules(surface.kind);
    if (scriptId === undefined) { mobileLinkspanRuntime.fail(surface, 'This WebRTC runtime was not selected for this app build.'); return; }
    void Promise.all([import('expo-asset'), import('expo-file-system')]).then(async ([{ Asset }, { File }]) => {
      const [scriptAsset, wasmAsset] = await Promise.all([Asset.fromModule(scriptId).downloadAsync(),
        wasmId === undefined ? undefined : Asset.fromModule(wasmId).downloadAsync(), noticesId === undefined ? undefined : Asset.fromModule(noticesId).downloadAsync()]);
      if (!scriptAsset.localUri || wasmAsset !== undefined && !wasmAsset.localUri) throw new Error('The trusted connection runtime asset is unavailable.');
      const scriptFile = new File(scriptAsset.localUri), wasmFile = wasmAsset?.localUri == null ? undefined : new File(wasmAsset.localUri);
      if (scriptFile.size > 16_777_216 || (wasmFile?.size ?? 0) > 67_108_864) throw new Error('The trusted connection runtime asset exceeds its budget.');
      const [script, wasm] = await Promise.all([scriptFile.text(), wasmFile?.base64()]);
      if (current) setHtml(runtimeHtml(script, wasm));
    }).catch(() => { if (current) mobileLinkspanRuntime.fail(surface, 'The trusted connection runtime could not be loaded.'); });
    return () => { current = false; view.current?.injectJavaScript('globalThis.jokoLinkspan?.dispose();true;'); };
  }, [surface]);
  const receive = (event: WebViewMessageEvent) => {
    const raw = event.nativeEvent.data;
    if (raw.length > 1_048_576) { mobileLinkspanRuntime.fail(surface); return; }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { mobileLinkspanRuntime.fail(surface); return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const value = data as Record<string, unknown>;
    if (value['type'] === 'ready') {
      const renderer = view.current;
      if (renderer === null) { mobileLinkspanRuntime.fail(surface); return; }
      mobileLinkspanRuntime.ready(surface, (id, request) => renderer.injectJavaScript(`globalThis.jokoLinkspanRequest(${id},${json(request)});true;`),
        () => renderer.injectJavaScript('globalThis.jokoLinkspan?.dispose();true;'));
    } else if (value['type'] === 'failure') mobileLinkspanRuntime.fail(surface);
    else if (value['type'] === 'result' && Number.isSafeInteger(value['id']) && typeof value['success'] === 'boolean') {
      mobileLinkspanRuntime.settle(surface, value['id'] as number, value['success'], value['result'], value['code']);
    }
  };
  if (html === undefined) return null;
  return <RuntimeWebView ref={view} source={{ html, baseUrl }} onMessage={receive}
    originWhitelist={[baseUrl, 'about:blank']} onShouldStartLoadWithRequest={request => [baseUrl, `${baseUrl}/`, 'about:blank'].includes(request.url)}
    onError={() => mobileLinkspanRuntime.fail(surface)} onContentProcessDidTerminate={() => mobileLinkspanRuntime.fail(surface)}
    onRenderProcessGone={() => { mobileLinkspanRuntime.fail(surface); return true; }}
    javaScriptEnabled domStorageEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
    allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
    setSupportMultipleWindows={false} mixedContentMode="never" scrollEnabled={false} style={styles.runtime} />;
}

function runtimeHtml(script: string, wasm?: string): string {
  const source = script.replace(/<\/script/giu, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src https: wss: ws://127.0.0.1:* ws://localhost:* ws://[::1]:*; script-src 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob:;"></head><body><script>${source}</script><script>
const post=value=>window.ReactNativeWebView.postMessage(JSON.stringify(value));
const bytes=${wasm === undefined ? 'undefined' : `Uint8Array.from(atob(${json(wasm)}),value=>value.charCodeAt(0))`};
globalThis.jokoLinkspanStart(bytes).then(host=>{
globalThis.jokoLinkspan=host;
globalThis.jokoLinkspanRequest=(id,message)=>Promise.resolve().then(()=>host.request(message)).then(result=>post({type:'result',id,success:true,result}),error=>{const codes=['invalid_argument','cancelled','deadline_exceeded','closed','transport_error','identity_mismatch','authentication_failed','protocol_error','resource_exhausted','unavailable','outcome_unknown'];post({type:'result',id,success:false,code:codes.includes(error?.code)?error.code:'transport_error'});});
post({type:'ready'});
},()=>post({type:'failure'}));
</script></body></html>`;
}

const styles = StyleSheet.create({ host: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }, runtime: { width: 1, height: 1 } });
