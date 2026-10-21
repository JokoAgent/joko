import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { mailPreviewImages, extensionCardFormValuesToEntries,
  mergeExtensionCardFormValues, omitExtensionCardFormPreview, readExtensionCardForm, readExtensionCardFormChange, readMailCard,
  trackExtensionCardFormDelivery, releaseExtensionCardFormDelivery, type ExtensionCard } from "@joko/contracts";
import { resolveExtensionCardMedia, extensionCardPosterMedia, extensionCardInlineImages } from "@joko/contracts";
import type { MobileExtensionCardApi } from "./mobile-extension-card-api";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileExtensionCardMessages } from "./mobile-extension-card-messages";
import { MobileExtensionCardFields } from "./MobileExtensionCardForm";
import { useMobileMailLink } from "./MobileExtensionMailReader";
import { MobileMediaPlayer } from "./MobileMediaPlayer";
import { mobileMessage } from "./mobile-messages";
import { extensionCardAudioUris } from "@joko/contracts";

interface Host { readonly ownerKey: string; readonly bind: (sessionId: string) => MobileExtensionCardApi | undefined; readonly audioOwner?: string; readonly playAudio?: (key: string) => void }
const Context = createContext<Host>({ ownerKey: "", bind: () => undefined });
export function MobileExtensionCardsProvider({ ownerKey, bind, children }: Host & { readonly children: ReactNode }) {
  const current = useRef(bind); current.current = bind;
  const [audioOwner, playAudio] = useState<string>();
  const host = useMemo(() => ({ ownerKey, bind: (sessionId: string) => current.current(sessionId), audioOwner, playAudio }), [ownerKey, audioOwner]);
  return <Context.Provider value={host}>{children}</Context.Provider>;
}
type Colors = MobileInteractionSheetColors & { readonly dark: boolean };
interface Props { readonly card: ExtensionCard; readonly colors: Colors; readonly locale: MobileSupportedLocale; readonly enabled: boolean; readonly readOnly: boolean }
export function MobileExtensionCard(props: Props) {
  const host = useContext(Context);
  return <CardBody key={`${host.ownerKey}:${props.card.cardId}:${props.enabled}:${props.readOnly}`} {...props} host={host} />;
}
function CardBody({ card, colors, locale, enabled, readOnly: restricted, host }: Props & { host: Host }) {
  const previewMail = useMobileMailLink();
  const api = useMemo(() => enabled && !restricted ? host.bind(card.sessionId) : undefined, [host, card.sessionId, enabled, restricted]);
  const copy = mobileExtensionCardMessages(locale), lifetime = useRef(new AbortController()), tail = useRef(Promise.resolve(true));
  const [foreground, setForeground] = useState(AppState.currentState === "active"), [attempt, retry] = useState(0), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<{ html: string; animatedHtml: string; working: boolean; interactive: boolean; hostAuthorization: boolean }>();
  const [prompt, setPrompt] = useState<{ action: string; placeholder: string; value: string }>();
  const [retryAttachment, setRetryAttachment] = useState<boolean>();
  const [attachmentFailed, setAttachmentFailed] = useState(false);
  const [media, setMedia] = useState<Record<string, string>>({}), mediaCache = useRef<Record<string, string>>({});
  const html = snapshot?.html ?? card.html, fields = useMemo(() => readExtensionCardForm(html) ?? [], [html]), incoming = Object.fromEntries(fields.map(field => [field.name, field.value]));
  const [model, setModel] = useState({ base: incoming, values: incoming });
  if (JSON.stringify(model.base) !== JSON.stringify(incoming)) setModel({ base: incoming, values: mergeExtensionCardFormValues(model.values, model.base, incoming) });
  const values = useRef(model.values); values.current = model.values;
  const scope = api?.formScope(card.sessionId), mail = useMemo(() => readMailCard(html), [html]), canAct = enabled && foreground && !restricted && Boolean(api && snapshot?.interactive && !snapshot.hostAuthorization), attachmentDeliveryKey = `${card.cardId}:attachment`;
  const inlineImages = useMemo(() => extensionCardInlineImages([...(mail?.images ?? []), ...mailPreviewImages(model.values)], media), [mail, model.values.attachmentItems, media]);
  const readOnly = !canAct || Boolean(mail && (mail.supersededBy || !["draft", "syncing", "error"].includes(mail.state)));
  useEffect(() => { const listener = AppState.addEventListener("change", state => setForeground(state === "active")); return () => listener.remove(); }, []);
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    return () => { abort.abort(); if (scope) { releaseExtensionCardFormDelivery(scope, card.cardId); releaseExtensionCardFormDelivery(scope, attachmentDeliveryKey); } };
  }, [scope, card.cardId]);
  useEffect(() => {
    if (!api || !foreground) return;
    const abort = new AbortController();
    void api.get({ sessionId: card.sessionId, cardId: card.cardId }, { signal: abort.signal }).then(async result => {
      if (!abort.signal.aborted && result.card?.cardId === card.cardId && result.card.sessionId === card.sessionId) {
        setSnapshot({ html: result.card.html, animatedHtml: result.animatedHtml, working: result.working, interactive: result.interactive, hostAuthorization: result.hostAuthorization }); setFailed(false);
        const resolved = await resolveExtensionCardMedia(result.mediaUris ?? [], async uri => (await api.readMedia({ sessionId: card.sessionId, cardId: card.cardId, uri }, { signal: abort.signal })).dataUrl, abort.signal, mediaCache.current);
        if (!abort.signal.aborted) { mediaCache.current = resolved; setMedia(resolved); }
      }
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [api, foreground, card, attempt]);
  useEffect(() => {
    if (!foreground || !snapshot?.working || !api) return;
    const timer = setTimeout(() => retry(value => value + 1), 2000); return () => clearTimeout(timer);
  }, [api, foreground, snapshot, attempt]);
  const save = (next: Record<string, string>) => {
    values.current = next; setModel(previous => ({ ...previous, values: next }));
    const actionId = readExtensionCardFormChange(html);
    if (!api || !scope || !actionId || readOnly || AppState.currentState !== "active") return;
    const delivery = tail.current.catch(() => false).then(async () => {
      try {
        lifetime.current.signal.throwIfAborted();
        const response = await api.dispatch({ sessionId: card.sessionId, cardId: card.cardId, actionId, formValues: extensionCardFormValuesToEntries(next), change: true }, { signal: lifetime.current.signal });
        if (!response.accepted) throw new Error("Card edit unavailable.");
        setFailed(false); return true;
      } catch { if (!lifetime.current.signal.aborted) setFailed(true); return false; }
    });
    tail.current = delivery; trackExtensionCardFormDelivery(scope, card.cardId, delivery);
  };
  const act = async (actionId: string, text = "") => {
    if (!api || !canAct || busy || AppState.currentState !== "active") return;
    setBusy(true);
    try {
      if (!await tail.current) throw new Error("Card edits are pending.");
      lifetime.current.signal.throwIfAborted();
      const response = await api.dispatch({ sessionId: card.sessionId, cardId: card.cardId, actionId, prompt: text, ...(fields.length ? { formValues: extensionCardFormValuesToEntries(values.current) } : {}) }, { signal: lifetime.current.signal });
      if (!response.accepted) throw new Error("Card action unavailable.");
      if (!lifetime.current.signal.aborted) { setFailed(false); retry(value => value + 1); }
    } catch { if (!lifetime.current.signal.aborted) setFailed(true); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const attach = (inline: boolean) => {
    if (!api?.pickAttachment || !scope || !mail || readOnly || busy || AppState.currentState !== "active") return;
    setBusy(true); setRetryAttachment(inline); setAttachmentFailed(false); const previous = tail.current;
    const delivery = (async () => {
      try {
        if (!await previous) throw new Error("Card edits are pending.");
        const uploadId = await api.pickAttachment!(card.cardId, inline, lifetime.current.signal); lifetime.current.signal.throwIfAborted();
        if (uploadId) {
          if (AppState.currentState !== "active") throw new Error("Mail attachment view is not active.");
          const response = await api.dispatch({ sessionId: card.sessionId, cardId: card.cardId, uploadId, actionId: `mail:${inline ? "image" : "attach"}:${mail.key}`, formValues: extensionCardFormValuesToEntries(values.current) }, { signal: lifetime.current.signal });
          if (!response.accepted) throw new Error("Mail attachment unavailable.");
        }
        if (!lifetime.current.signal.aborted) { if (uploadId) releaseExtensionCardFormDelivery(scope, card.cardId); setRetryAttachment(undefined); setAttachmentFailed(false); setFailed(false); retry(value => value + 1); } return true;
      } catch { if (!lifetime.current.signal.aborted) setAttachmentFailed(true); return false; }
      finally { if (!lifetime.current.signal.aborted) setBusy(false); }
    })();
    tail.current = delivery; trackExtensionCardFormDelivery(scope, attachmentDeliveryKey, delivery);
  };
  const openLink = (url: string) => Alert.alert(copy.openLink, url, [{ text: copy.cancel, style: "cancel" }, { text: copy.confirm, onPress: () => {
    if (!api || !canAct || AppState.currentState !== "active") return;
    void api.authorizeLink({ sessionId: card.sessionId, cardId: card.cardId, url }, { signal: lifetime.current.signal }).then(async result => {
      lifetime.current.signal.throwIfAborted(); if (!result.authorized || AppState.currentState !== "active") throw new Error("Link unavailable.");
      if (!await previewMail?.(url)) { lifetime.current.signal.throwIfAborted(); if (AppState.currentState === "active") await Linking.openURL(url); }
    }).catch(() => { if (!lifetime.current.signal.aborted) setFailed(true); });
  } }]);
  const content = <>
    {fields.length > 0 && <MobileExtensionCardFields fields={fields} values={model.values} colors={colors} copy={copy} disabled={readOnly || busy} onChange={save} foreground={foreground} images={inlineImages} onAttachment={api?.pickAttachment ? attach : undefined} />}
    {foreground && <Poster html={extensionCardPosterMedia(fields.length ? omitExtensionCardFormPreview(html) : snapshot?.working && snapshot.animatedHtml ? snapshot.animatedHtml : html, media)} colors={colors} height={card.height} disabled={!canAct || busy} audioLabel={mobileMessage(locale, "preview.mediaPlay")}
      onAction={(action, placeholder) => { if (!canAct) return; if (placeholder !== undefined) setPrompt({ action, placeholder, value: "" }); else void act(action); }} onLink={url => { if (canAct) openLink(url); }}
      onMedia={uri => { if (!api || !canAct) return; if (/\.(mp3|wav|m4a)$/u.test(uri)) host.playAudio?.(`${card.cardId}:${uri}`); else void api.previewMedia?.(card.cardId, uri).catch(() => setFailed(true)); }} />}
    {canAct && api?.prepareAudio && extensionCardAudioUris(html).map(uri => host.audioOwner === `${card.cardId}:${uri}` ? <CardAudio key={uri} api={api} cardId={card.cardId} uri={uri} colors={colors} locale={locale} /> : null)}
  </>;
  return <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <View style={styles.header}><Text style={[styles.title, { color: colors.muted }]}>{card.extensionName}</Text>
      {(busy || snapshot?.working) && <ActivityIndicator color={colors.accent} size="small" />}
      {fields.length > 0 && <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} style={styles.control}><Text style={{ color: colors.muted }}>{copy.expand}</Text></Pressable>}
    </View>
    {!api && <Text style={[styles.notice, { color: colors.muted }]}>{copy.readOnly}</Text>}
    {snapshot?.hostAuthorization && <Text style={[styles.notice, { color: colors.muted }]}>{locale === "zh-CN" ? "请在 Joko 电脑端连接此账户。" : "Open Joko Desktop to connect this account."}</Text>}
    {(failed || attachmentFailed) && <View style={styles.failure}><Text accessibilityRole="alert" style={[styles.failureText, { color: colors.negative }]}>{copy.failed}</Text>
      <Pressable accessibilityRole="button" disabled={busy} style={styles.control} onPress={() => { if (attachmentFailed && retryAttachment !== undefined) { tail.current = Promise.resolve(true); attach(retryAttachment); } else if (readExtensionCardFormChange(html) && !readOnly) save(values.current); else retry(value => value + 1); }}><Text style={{ color: colors.accent }}>{copy.retry}</Text></Pressable>
      {attachmentFailed && <Pressable accessibilityRole="button" disabled={busy} style={styles.control} onPress={() => { if (scope) releaseExtensionCardFormDelivery(scope, attachmentDeliveryKey); setRetryAttachment(undefined); setAttachmentFailed(false); }}><Text style={{ color: colors.muted }}>{copy.cancel}</Text></Pressable>}
    </View>}
    {!expanded && content}
    <Modal visible={expanded} presentationStyle="pageSheet" onRequestClose={() => setExpanded(false)}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}><View style={styles.header}><Text style={[styles.title, { color: colors.ink }]}>{copy.preview}</Text>
        <Pressable accessibilityRole="button" style={styles.control} onPress={() => setExpanded(false)}><Text style={{ color: colors.accent }}>{copy.close}</Text></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled">{content}</ScrollView>
      </SafeAreaView>
    </Modal>
    <Modal visible={Boolean(prompt)} presentationStyle="pageSheet" onRequestClose={() => setPrompt(undefined)}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}><View style={styles.header}><Text style={[styles.title, { color: colors.ink }]}>{copy.prompt}</Text>
        <Pressable accessibilityRole="button" style={styles.control} onPress={() => setPrompt(undefined)}><Text style={{ color: colors.accent }}>{copy.cancel}</Text></Pressable></View>
        <TextInput autoFocus multiline maxLength={2000} accessibilityLabel={copy.prompt} placeholder={prompt?.placeholder} placeholderTextColor={colors.muted}
          value={prompt?.value ?? ""} style={[styles.prompt, { color: colors.ink, borderColor: colors.border }]} onChangeText={value => setPrompt(previous => previous ? { ...previous, value } : previous)} />
        <Pressable accessibilityRole="button" style={styles.control} onPress={() => { const captured = prompt; setPrompt(undefined); if (captured) void act(captured.action, captured.value); }}><Text style={{ color: colors.accent }}>{copy.confirm}</Text></Pressable>
      </SafeAreaView>
    </Modal>
  </View>;
}
let nextDocument = 0;
function Poster({ html, colors, height, disabled, onAction, onLink, onMedia, audioLabel }: { html: string; colors: Colors; height: number; disabled: boolean;
  onAction(action: string, placeholder?: string): void; onLink(url: string): void; onMedia(uri: string): void; audioLabel: string }) {
  const id = useMemo(() => ++nextDocument, [html, colors.ink, colors.muted, colors.border, colors.surface]), settled = useRef(false), [measured, setMeasured] = useState(height);
  const alive = useRef(false); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const source = useMemo(() => ({ baseUrl: "about:blank", html: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent;color:${colors.ink};font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}:root{--text:${colors.ink};--text-soft:${colors.muted};--line:${colors.border};--surface:${colors.surface};--accent:${colors.accent};--accent-ink:${colors.dark ? colors.background : colors.ink}}*{box-sizing:border-box}img{max-width:100%;height:auto}button{font:inherit;min-height:44px!important;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}</style>${html}` }), [id, colors]);
  const lastSource = useRef(source); if (lastSource.current !== source) { lastSource.current = source; settled.current = false; }
  const script = `(function(){var id=${JSON.stringify(id)};document.querySelectorAll('div[data-joko-audio]').forEach(function(slot){var b=document.createElement('button');b.type='button';b.textContent=${JSON.stringify(audioLabel)};b.setAttribute('data-joko-media',slot.getAttribute('data-joko-audio'));slot.replaceChildren(b)});document.querySelectorAll('[data-joko-action],[data-joko-link],img[data-joko-image]').forEach(function(el){if(el.tagName!=='BUTTON'){el.tabIndex=0;el.setAttribute('role','button')}});function activate(e){e.preventDefault();if(!e.isTrusted)return;var el=e.target.closest('[data-joko-action],[data-joko-link]');if(el){if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true')return;window.ReactNativeWebView.postMessage(JSON.stringify({type:'action',id:id,action:el.getAttribute('data-joko-action'),prompt:el.getAttribute('data-joko-prompt'),link:el.getAttribute('data-joko-link')}));return}el=e.target.closest('[data-joko-media],img[data-joko-image]');if(el)window.ReactNativeWebView.postMessage(JSON.stringify({type:'media',id:id,uri:el.getAttribute('data-joko-media')||el.getAttribute('data-joko-model')||el.getAttribute('data-joko-image')}))}document.addEventListener('click',activate);document.addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&e.target.tagName!=='BUTTON')activate(e)});function fit(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'height',id:id,height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)}))}if(window.ResizeObserver)new ResizeObserver(fit).observe(document.body);fit()})();true;`;
  return <WebView key={id} source={source} originWhitelist={["*"]} style={{ height: Math.min(900, Math.max(44, measured)), backgroundColor: colors.surface }}
    javaScriptEnabled injectedJavaScript={script} onShouldStartLoadWithRequest={request => !settled.current && request.url === "about:blank"}
    onLoadEnd={() => { settled.current = true; }} scrollEnabled={measured >= 900} javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
    allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} mediaCapturePermissionGrantType="deny"
    sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} domStorageEnabled={false} incognito cacheEnabled={false}
    onMessage={event => {
      if (!alive.current || event.nativeEvent.data.length > 4096) return;
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.id !== id) return;
        if (data.type === "height" && typeof data.height === "number" && Number.isFinite(data.height)) setMeasured(Math.min(900, Math.max(44, Math.ceil(data.height))));
        if (disabled || AppState.currentState !== "active") return;
        if (data.type === "media" && typeof data.uri === "string" && /^joko-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp|glb|mp3|wav|m4a)$/u.test(data.uri)) { onMedia(data.uri); return; }
        if (data.type !== "action") return;
        if (typeof data.action === "string" && /^[A-Za-z0-9_:-]{1,128}$/u.test(data.action)) onAction(data.action, typeof data.prompt === "string" ? data.prompt.slice(0, 128) : undefined);
        else if (typeof data.link === "string" && data.link.length <= 2048) onLink(data.link);
      } catch { /* Untrusted or stale documents cannot dispatch. */ }
    }} />;
}
function CardAudio({ api, cardId, uri, colors, locale }: { api: MobileExtensionCardApi; cardId: string; uri: string; colors: Colors; locale: MobileSupportedLocale }) {
  const [source, setSource] = useState<Awaited<ReturnType<NonNullable<MobileExtensionCardApi["prepareAudio"]>>>>(), [failed, setFailed] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let source: Awaited<ReturnType<NonNullable<MobileExtensionCardApi["prepareAudio"]>>> | undefined;
    setSource(undefined); setFailed(false);
    void api.prepareAudio!(cardId, uri, abort.signal).then(value => { source = value; if (abort.signal.aborted) void value.release(); else setSource(value); }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); if (source) void source.release(); };
  }, [api, cardId, uri, attempt]);
  return source ? <MobileMediaPlayer background={colors.background} border={colors.border} ink={colors.ink} instanceId={source.instanceId} kind="audio" locale={locale} mediaType={source.mediaType} surface={colors.surface} title={mobileMessage(locale, "preview.audioTitle")} uri={source.uri} />
    : failed ? <Pressable accessibilityRole="button" style={styles.control} onPress={() => retry(value => value + 1)}><Text style={{ color: colors.accent }}>{mobileExtensionCardMessages(locale).retry}</Text></Pressable> : <ActivityIndicator color={colors.accent} />;
}
const styles = StyleSheet.create({ fill: { flex: 1 }, card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden", marginVertical: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingHorizontal: 16, paddingVertical: 4 }, title: { flex: 1, fontSize: 13, fontWeight: "500" },
  control: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", alignSelf: "flex-end" }, notice: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },
  failure: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 }, failureText: { flex: 1, fontSize: 12, lineHeight: 18 },
  prompt: { minHeight: 160, margin: 16, padding: 12, borderWidth: 1, borderRadius: 8, fontSize: 16, textAlignVertical: "top" }
});
