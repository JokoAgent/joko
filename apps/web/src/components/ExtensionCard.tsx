import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mergeExtensionCardFormValues, omitExtensionCardFormPreview, readExtensionCardForm, readExtensionCardFormChange, extensionCardFormValuesToEntries,
  readMailCard, trackExtensionCardFormDelivery, releaseExtensionCardFormDelivery, type ExtensionCard as Card } from "@joko/contracts";
import { ExtensionAuthorizationPhase, EXTENSION_OAUTH_CARD_ACTION } from "@joko/contracts";
import { resolveExtensionCardMedia, extensionCardPosterMedia, extensionCardInlineImages, mailPreviewImages } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ExtensionCardApi } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, Spinner } from "./ui.js";
import { ExtensionCardForm } from "./ExtensionCardForm.js";
import "./extension-card.css";
import { ExtensionMailLinkContext } from "./ExtensionMailReader.js";
import { ExtensionCardAudioHost } from "./extension-card-audio.js";
import { ExtensionCardMediaPreview } from "./ExtensionCardMediaPreview.js";
import { extensionCardGalleryImages, type ExtensionCardGalleryImage } from "./extension-card-gallery.js";

interface Actions { readonly ownerKey: string; readonly readOnly: boolean; readonly bind?: () => ExtensionCardApi | undefined; readonly openLink?: (url: string) => Promise<void>; readonly gallery?: () => readonly ExtensionCardGalleryImage[] }
const Context = createContext<Actions>({ ownerKey: "", readOnly: true });
function ownerFor(controller: AppController): string {
  return JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin,
    controller.state.connectionGeneration, controller.state.connectionState, controller.state.navigationRevision, controller.state.route]);
}
export function ExtensionCardTimelineProvider({ controller, readOnly = false, cards, children }: {
  readonly controller: AppController; readonly readOnly?: boolean; readonly cards?: readonly Card[]; readonly children: ReactNode;
}) {
  const current = useRef(controller); current.current = controller;
  const previewMail = useContext(ExtensionMailLinkContext);
  const previewCurrent = useRef(previewMail); previewCurrent.current = previewMail;
  const galleryImages = useMemo(() => extensionCardGalleryImages(cards ?? []), [cards]);
  const galleryCurrent = useRef(galleryImages); galleryCurrent.current = galleryImages;
  const ownerKey = ownerFor(controller), restricted = readOnly || controller.state.sessionAccess?.role === "guest";
  const actions = useMemo<Actions>(() => ({ ownerKey, readOnly: restricted,
    gallery: () => galleryCurrent.current,
    bind: () => restricted || ownerFor(current.current) !== ownerKey || current.current.state.connectionState !== "connected" ? undefined : current.current.extensionCardApi(),
    openLink: async url => { if (ownerFor(current.current) !== ownerKey) throw new Error("Extension connection changed."); if (!await previewCurrent.current?.(url)) await current.current.openHttpLink(url); }
  }), [ownerKey, restricted]);
  return <Context.Provider value={actions}>{children}</Context.Provider>;
}
export function ExtensionCard({ card, t }: { readonly card: Card; readonly t: Translator }) {
  const actions = useContext(Context), api = useMemo(() => actions.bind?.(), [actions]);
  return <CardBody key={`${actions.ownerKey}:${card.cardId}:${actions.readOnly}:${Boolean(api)}`} card={card} actions={actions} api={api} t={t} />;
}
function CardBody({ card, actions, api, t }: { card: Card; actions: Actions; api: ExtensionCardApi | undefined; t: Translator }) {
  const root = useRef<HTMLElement>(null), lifetime = useRef(new AbortController()), tail = useRef(Promise.resolve(true));
  const authorizationOperation = useRef<AbortController | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<{ html: string; animatedHtml: string; working: boolean; interactive: boolean; hostAuthorization: boolean; authorizationPhase: ExtensionAuthorizationPhase; authorizationClientConfigured: boolean }>();
  const [visible, setVisible] = useState(false), [attempt, retry] = useState(0), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false);
  const [link, setLink] = useState<string>(), [prompt, setPrompt] = useState<{ action: string; placeholder: string; value: string }>();
  const [retryAttachment, setRetryAttachment] = useState<{ file: File; inline: boolean }>();
  const [attachmentFailed, setAttachmentFailed] = useState(false);
  const [preview, setPreview] = useState<{ uri: string; gallery: { cardId: string; uri: string }[]; index: number }>();
  const [media, setMedia] = useState<Record<string, string>>({}), mediaCache = useRef<Record<string, string>>({});
  const html = snapshot?.html ?? card.html, fields = useMemo(() => readExtensionCardForm(html) ?? [], [html]);
  const incoming = Object.fromEntries(fields.map(field => [field.name, field.value]));
  const [model, setModel] = useState({ base: incoming, values: incoming });
  if (JSON.stringify(model.base) !== JSON.stringify(incoming)) setModel({ base: incoming, values: mergeExtensionCardFormValues(model.values, model.base, incoming) });
  const values = useRef(model.values); values.current = model.values;
  const current = useRef({ html, fields, api }); current.current = { html, fields, api };
  const scope = api?.formScope(card.sessionId), deliveryKey = card.cardId, attachmentDeliveryKey = `${card.cardId}:attachment`;
  const mail = useMemo(() => readMailCard(html), [html]), canAct = Boolean(api && snapshot?.interactive && !actions.readOnly && (!snapshot.hostAuthorization || api.canAuthorizeAccount));
  const inlineImages = useMemo(() => extensionCardInlineImages([...(mail?.images ?? []), ...mailPreviewImages(model.values)], media), [mail, model.values.attachmentItems, media]);
  const readOnly = !canAct || Boolean(mail && (mail.supersededBy || !["draft", "syncing", "error"].includes(mail.state)));
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    return () => { abort.abort(); if (scope) { releaseExtensionCardFormDelivery(scope, deliveryKey); releaseExtensionCardFormDelivery(scope, attachmentDeliveryKey); } };
  }, [scope, deliveryKey]);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "160px" });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!api || !visible || actions.readOnly) return;
    const abort = new AbortController();
    void api.get({ sessionId: card.sessionId, cardId: card.cardId }, { signal: abort.signal }).then(async result => {
      if (!abort.signal.aborted && result.card?.cardId === card.cardId && result.card.sessionId === card.sessionId) {
        setSnapshot({ html: result.card.html, animatedHtml: result.animatedHtml, working: result.working, interactive: result.interactive, hostAuthorization: result.hostAuthorization, authorizationPhase: result.authorizationPhase, authorizationClientConfigured: result.authorizationClientConfigured }); setFailed(false);
        const resolved = await resolveExtensionCardMedia(result.mediaUris ?? [], async uri => (await api.readMedia({ sessionId: card.sessionId, cardId: card.cardId, uri }, { signal: abort.signal })).dataUrl, abort.signal, mediaCache.current);
        if (!abort.signal.aborted) { mediaCache.current = resolved; setMedia(resolved); }
      }
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [api, visible, card, attempt, actions.readOnly]);
  useEffect(() => {
    if (!visible || !snapshot?.working || !api || actions.readOnly) return;
    const timer = setTimeout(() => retry(value => value + 1), 2000); return () => clearTimeout(timer);
  }, [api, visible, snapshot, attempt, actions.readOnly]);
  const save = (next: Record<string, string>): void => {
    values.current = next; setModel(previous => ({ ...previous, values: next }));
    const actionId = readExtensionCardFormChange(current.current.html);
    if (!api || !scope || !actionId || readOnly) return;
    const delivery = tail.current.catch(() => false).then(async () => {
      lifetime.current.signal.throwIfAborted();
      try {
        const response = await api.dispatch({ sessionId: card.sessionId, cardId: card.cardId, actionId, formValues: extensionCardFormValuesToEntries(next), change: true }, { signal: lifetime.current.signal });
        if (!response.accepted) throw new Error("Card edit unavailable.");
        setFailed(false); return true;
      } catch { if (!lifetime.current.signal.aborted) setFailed(true); return false; }
    });
    tail.current = delivery; trackExtensionCardFormDelivery(scope, deliveryKey, delivery);
  };
  const act = async (actionId: string, promptText = ""): Promise<void> => {
    if (!api || !canAct || busy) return;
    setBusy(true);
    const operation = new AbortController();
    if (snapshot?.hostAuthorization) authorizationOperation.current = operation;
    try {
      if (!await tail.current) throw new Error("Card edits are pending.");
      lifetime.current.signal.throwIfAborted();
      const response = await api.dispatch({ sessionId: card.sessionId, cardId: card.cardId, actionId, prompt: promptText,
        ...(fields.length ? { formValues: extensionCardFormValuesToEntries(values.current) } : {}) }, { signal: AbortSignal.any([lifetime.current.signal, operation.signal]) });
      if (!response.accepted) throw new Error("Card action unavailable.");
      if (!lifetime.current.signal.aborted) { setFailed(false); retry(value => value + 1); }
    } catch { if (!lifetime.current.signal.aborted) setFailed(true); }
    finally { authorizationOperation.current = undefined; if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const attach = (file: File, inline: boolean): void => {
    if (!api || !scope || !mail || readOnly || busy) return;
    setBusy(true); setRetryAttachment({ file, inline }); setAttachmentFailed(false);
    const previous = tail.current;
    const delivery = (async () => {
      try {
        if (!await previous) throw new Error("Card edits are pending.");
        const uploadId = await api.uploadAttachment(card.sessionId, card.cardId, file, inline, lifetime.current.signal);
        lifetime.current.signal.throwIfAborted();
        const response = await api.dispatch({ sessionId: card.sessionId, cardId: card.cardId, uploadId, actionId: `mail:${inline ? "image" : "attach"}:${mail.key}`, formValues: extensionCardFormValuesToEntries(values.current) }, { signal: lifetime.current.signal });
        if (!response.accepted) throw new Error("Mail attachment unavailable.");
        if (!lifetime.current.signal.aborted) { releaseExtensionCardFormDelivery(scope, deliveryKey); setRetryAttachment(undefined); setAttachmentFailed(false); setFailed(false); retry(value => value + 1); } return true;
      } catch { if (!lifetime.current.signal.aborted) setAttachmentFailed(true); return false; }
      finally { if (!lifetime.current.signal.aborted) setBusy(false); }
    })();
    tail.current = delivery; trackExtensionCardFormDelivery(scope, attachmentDeliveryKey, delivery);
  };
  const click = (element: HTMLElement): void => {
    if (!canAct || busy) return;
    const actionId = element.getAttribute("data-joko-action"), url = element.getAttribute("data-joko-link");
    if (actionId) {
      const placeholder = element.getAttribute("data-joko-prompt");
      if (placeholder !== null) setPrompt({ action: actionId, placeholder, value: "" }); else void act(actionId);
    } else if (url) setLink(url);
  };
  const content = <>
    {fields.length > 0 && <ExtensionCardForm fields={fields} values={model.values} images={inlineImages} onAttachment={attach} disabled={readOnly || busy} expanded={expanded} t={t} onChange={save} />}
    {snapshot?.hostAuthorization ? <div className="extension-card__host-authorization"><p>{t(snapshot.authorizationClientConfigured ? "extensions.oauth.waitingBody" : "extensions.oauth.clientRequired")}</p>
      {snapshot.authorizationPhase !== ExtensionAuthorizationPhase.COMPLETE && <Button tone="primary" disabled={!canAct || busy || !snapshot.authorizationClientConfigured} onClick={() => { void act(EXTENSION_OAUTH_CARD_ACTION); }}>{t("extensions.oauth.connect")}</Button>}
    </div> : <Poster html={extensionCardPosterMedia(snapshot?.working && snapshot.animatedHtml ? snapshot.animatedHtml : html, media)} form={fields.length > 0} height={card.height}
      title={card.extensionName} disabled={!canAct || busy} onClick={click} api={api} card={card} t={t} onMedia={(uri, gallery, imageIndex) => {
        const registered = actions.gallery?.().filter(image => image.sessionId === card.sessionId) ?? [];
        const index = uri.endsWith(".glb") ? -1 : registered.findIndex(image => image.cardId === card.cardId && image.imageIndex === imageIndex);
        setPreview({ uri, gallery: index < 0 ? gallery.map(uri => ({ cardId: card.cardId, uri })) : registered, index: index < 0 ? Math.max(0, imageIndex) : index });
      }} />}
  </>;
  return <article ref={root} className="extension-result-card" aria-busy={busy || snapshot?.working}>
    <header><strong>{card.extensionName}</strong>{(busy || snapshot?.working) && <Spinner />}
      {fields.length > 0 && <button type="button" onClick={() => setExpanded(true)}>{t("extensionCards.expand")}</button>}
    </header>
    {!api && <p className="extension-card__caption">{actions.readOnly ? t("extensionCards.readOnly") : t("extensionCards.unavailable")}</p>}
    {snapshot?.hostAuthorization && (snapshot.authorizationPhase === ExtensionAuthorizationPhase.COMPLETE ? <p role="status">{t("extensions.oauth.connected")}</p>
      : !api?.canAuthorizeAccount ? <p>{t("extensions.oauth.desktopRequired")}</p> : null)}
    {snapshot?.hostAuthorization && busy && <Button onClick={() => authorizationOperation.current?.abort()}>{t("common.cancel")}</Button>}
    {(failed || attachmentFailed) && <div className="extension-card__failure" role="alert"><span>{t("extensionCards.failed")}</span>
      <Button disabled={busy} onClick={() => { if (attachmentFailed && retryAttachment) { tail.current = Promise.resolve(true); attach(retryAttachment.file, retryAttachment.inline); } else if (readExtensionCardFormChange(html) && !readOnly) save(values.current); else retry(value => value + 1); }}>{t("common.retry")}</Button></div>}
    {attachmentFailed && retryAttachment && <Button disabled={busy} onClick={() => { if (scope) releaseExtensionCardFormDelivery(scope, attachmentDeliveryKey); setRetryAttachment(undefined); setAttachmentFailed(false); }}>{t("common.cancel")}</Button>}
    {!expanded && content}
    {preview && api && <ExtensionCardMediaPreview key={preview.uri} api={api} sessionId={card.sessionId} cardId={card.cardId} initial={preview.uri} sources={preview.gallery} initialIndex={preview.index} ownerKey={actions.ownerKey} t={t} onClose={() => setPreview(undefined)} />}
    <Modal open={expanded} size="large" title={t("extensionCards.mailPreview")} showClose closeLabel={t("common.close")} onClose={() => setExpanded(false)} className="extension-card__expanded">{content}</Modal>
    <Modal open={Boolean(link)} title={t("extensionCards.openLink")} description={link} size="small" showClose onClose={() => setLink(undefined)}>
      <div className="modal__actions"><Button onClick={() => setLink(undefined)}>{t("common.cancel")}</Button><Button tone="primary" onClick={() => {
        const url = link; setLink(undefined);
        if (!url || !api) return;
        void api.authorizeLink({ sessionId: card.sessionId, cardId: card.cardId, url }, { signal: lifetime.current.signal })
          .then(async result => { lifetime.current.signal.throwIfAborted(); if (!result.authorized) throw new Error("Link unavailable."); await actions.openLink?.(url); })
          .catch(() => { if (!lifetime.current.signal.aborted) setFailed(true); });
      }}>{t("common.confirm")}</Button></div>
    </Modal>
    <Modal open={Boolean(prompt)} title={t("extensionCards.prompt")} size="small" showClose onClose={() => setPrompt(undefined)}>
      <form onSubmit={event => { event.preventDefault(); if (!prompt) return; const captured = prompt; setPrompt(undefined); void act(captured.action, captured.value); }}>
        <textarea className="extension-card__prompt" autoFocus maxLength={2000} aria-label={t("extensionCards.prompt")} placeholder={prompt?.placeholder} value={prompt?.value ?? ""} onChange={event => setPrompt(previous => previous ? { ...previous, value: event.target.value } : previous)} />
        <div className="modal__actions"><Button onClick={() => setPrompt(undefined)}>{t("common.cancel")}</Button><Button tone="primary" type="submit">{t("common.confirm")}</Button></div>
      </form>
    </Modal>
  </article>;
}
function Poster({ html, form, height, title, disabled, onClick, api, card, t, onMedia }: { html: string; form: boolean; height: number; title: string; disabled: boolean; onClick(element: HTMLElement): void;
  api?: ExtensionCardApi; card: Card; t: Translator; onMedia(uri: string, gallery: string[], imageIndex: number): void }) {
  const frame = useRef<HTMLIFrameElement>(null), cleanup = useRef<() => void>(() => {}), current = useRef({ disabled, onClick, onMedia }); current.current = { disabled, onClick, onMedia };
  const audio = useMemo(() => api?.loadMedia ? new ExtensionCardAudioHost((uri, signal) => api.loadMedia(card.sessionId, card.cardId, uri, signal), () => !current.current.disabled) : undefined, [api, card.sessionId, card.cardId]);
  useEffect(() => () => audio?.dispose(), [audio]);
  useEffect(() => { if (disabled) audio?.pause(); }, [disabled, audio]);
  useEffect(() => () => cleanup.current(), []);
  const content = useMemo(() => form ? omitExtensionCardFormPreview(html) : html, [html, form]);
  const doc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;min-width:0;background:transparent;color:var(--text);font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box}img{max-width:100%;height:auto}button{font:inherit;min-height:36px;padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}[data-joko-action],[data-joko-link]{cursor:pointer}</style>${content}`;
  useEffect(() => {
    const document = frame.current?.contentDocument;
    document?.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (disabled) button.setAttribute("data-host-disabled", "true"); else button.removeAttribute("data-host-disabled"); });
  }, [disabled]);
  return <iframe ref={frame} className="extension-card__poster" title={title} sandbox="allow-same-origin" srcDoc={doc} style={{ height: Math.min(900, Math.max(120, height)) }}
    onLoad={() => {
      const element = frame.current, document = element?.contentDocument;
      if (!element || !document) return;
      cleanup.current();
      const paint = () => {
        const host = getComputedStyle(window.document.documentElement);
        for (const name of ["--text", "--text-soft", "--text-faint", "--surface", "--surface-raised", "--surface-hover", "--line", "--accent", "--accent-ink", "--accent-hover", "--red", "--green"]) document.documentElement.style.setProperty(name, host.getPropertyValue(name));
        document.documentElement.style.colorScheme = window.document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      };
      const fit = () => { element.style.height = "0px"; element.style.height = `${Math.min(900, Math.max(form ? 44 : 120, document.documentElement.scrollHeight, document.body.scrollHeight))}px`; };
      const click = (event: Event) => {
        event.preventDefault();
        const target = event.target as Element | null, control = target?.closest<HTMLElement>("[data-joko-action], [data-joko-link]");
        if (!event.isTrusted || current.current.disabled) return;
        if (control) { if (!control.hasAttribute("disabled") && control.getAttribute("aria-disabled") !== "true") current.current.onClick(control); return; }
        const image = target?.closest<HTMLImageElement>("img[data-joko-image]");
        const uri = image?.getAttribute("data-joko-model") || image?.getAttribute("data-joko-image");
        if (uri && api) {
          const images = [...document.querySelectorAll<HTMLImageElement>("img[data-joko-image]")].filter(node => !node.closest("[data-joko-action],[data-joko-link]") && !node.hasAttribute("data-joko-model"));
          element.blur(); current.current.onMedia(uri, uri.endsWith(".glb") ? [uri] : images.map(node => node.getAttribute("data-joko-image")!), images.indexOf(image!));
        }
      };
      for (const control of document.querySelectorAll<HTMLElement>("[data-joko-action], [data-joko-link], img[data-joko-image]")) {
        if (control.tagName !== "BUTTON") { control.tabIndex = 0; control.setAttribute("role", "button"); }
      }
      document.addEventListener("click", click);
      document.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && (event.target as Element | null)?.tagName !== "BUTTON") click(event); });
      document.addEventListener("submit", event => event.preventDefault()); document.addEventListener("load", fit, true);
      const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit); resize?.observe(document.body);
      const theme = new MutationObserver(paint); theme.observe(window.document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      const unbindAudio = audio?.bind(document, t);
      paint(); fit(); cleanup.current = () => { unbindAudio?.(); resize?.disconnect(); theme.disconnect(); };
    }} />;
}
