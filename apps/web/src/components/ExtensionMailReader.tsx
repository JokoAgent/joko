import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mailMessageFields, parseMailMessage, mailPreviewImages, resolveExtensionCardMedia, extensionCardInlineImages, type MailMessage } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { assertBrowserActionCurrent, type HttpLinkOpenOptions } from "../browser-action.js";
import type { Translator } from "./types.js";
import { ExtensionCardForm } from "./ExtensionCardForm.js";
import { Button, Modal, Spinner } from "./ui.js";

type OpenMail = (url: string, options?: HttpLinkOpenOptions) => Promise<boolean>;
export const ExtensionMailLinkContext = createContext<OpenMail | undefined>(undefined);
export function useExtensionMailLinkHandler(fallback: ((url: string, options?: HttpLinkOpenOptions) => void | Promise<void>) | undefined) {
  const preview = useContext(ExtensionMailLinkContext);
  const open = useCallback(async (url: string, options?: HttpLinkOpenOptions) => {
    if (await preview?.(url, options)) return;
    await fallback?.(url, options);
  }, [preview, fallback]);
  return fallback ? open : undefined;
}
function owner(controller: AppController): string {
  return JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin,
    controller.state.connectionState, controller.state.connectionGeneration, controller.state.navigationRevision, controller.state.route]);
}
export function ExtensionMailReaderProvider({ controller, sessionId, disabled, readOnly, t, children }: {
  readonly controller: AppController; readonly sessionId: string; readonly disabled?: boolean; readonly readOnly?: boolean; readonly t: Translator; readonly children: ReactNode;
}) {
  const current = useRef(controller); current.current = controller;
  const key = owner(controller), lifetime = useRef(new AbortController()), sequence = useRef(0);
  const api = useMemo(() => disabled || controller.state.sessionAccess?.role === "guest" ? undefined : controller.extensionCardApi?.(), [key, sessionId, disabled]);
  const [view, setView] = useState<{ url: string; loading: boolean; message?: MailMessage; media?: Record<string, string>; error?: string }>();
  useEffect(() => { const abort = new AbortController(); lifetime.current = abort; sequence.current++; setView(undefined); return () => { abort.abort(); sequence.current++; }; }, [key, sessionId, disabled]);
  const assertCurrent = () => { lifetime.current.signal.throwIfAborted(); if (owner(current.current) !== key) throw new Error("Mail connection changed."); };
  const load = async (url: string, options?: HttpLinkOpenOptions) => {
    if (!api) return;
    const request = ++sequence.current;
    const valid = () => { assertCurrent(); if (request !== sequence.current) throw new Error("Mail view changed."); if (options?.action) assertBrowserActionCurrent(options.action); };
    try {
      valid(); setView({ url, loading: true });
      const result = await api.previewMail({ sessionId, url, read: true, opened: !readOnly }, { signal: lifetime.current.signal }); valid();
      const message = result.messageJson ? parseMailMessage(JSON.parse(result.messageJson)) : null;
      setView({ url, loading: false, ...(message ? { message } : { error: result.error === "MAIL_PROVIDER_AMBIGUOUS" ? t("extensionCards.mailAmbiguous") : t("extensionCards.mailFailed") }) });
      if (message && result.extensionId) {
        const uris = mailPreviewImages({ attachmentItems: JSON.stringify(message.attachments) }).map(image => image.url);
        const media = await resolveExtensionCardMedia(uris, async uri => (await api.readMedia({ sessionId, extensionId: result.extensionId, uri }, { signal: lifetime.current.signal })).dataUrl, lifetime.current.signal);
        valid(); setView({ url, loading: false, message, media });
      }
    } catch { if (!lifetime.current.signal.aborted && request === sequence.current && owner(current.current) === key) setView({ url, loading: false, error: t("extensionCards.mailFailed") }); }
  };
  const open: OpenMail = async (url, options) => {
    if (!api || options?.forceExternal || !url.startsWith("https://")) return false;
    const attempt = ++sequence.current;
    assertCurrent(); if (options?.action) assertBrowserActionCurrent(options.action);
    const result = await api.previewMail({ sessionId, url, read: false }, { signal: lifetime.current.signal });
    assertCurrent(); if (options?.action) assertBrowserActionCurrent(options.action);
    if (attempt !== sequence.current) return true;
    if (!result.supported) return false;
    void load(url, options); return true;
  };
  const close = () => { sequence.current++; setView(undefined); };
  const labels: Record<string, string> = { to: t("extensionCards.mail.to"), cc: t("extensionCards.mail.cc"), bcc: t("extensionCards.mail.bcc"), subject: t("extensionCards.mail.subject") };
  const fields = view?.message ? mailMessageFields(view.message, name => labels[name] ?? name) : [];
  return <ExtensionMailLinkContext.Provider value={open}>{children}
    <Modal open={Boolean(view)} title={view?.message?.subject || t("extensionCards.mailPreview")} size="large" showClose closeLabel={t("common.close")} onClose={close} className="extension-card__expanded">
      {view?.loading && <Spinner />}
      {view?.error && <div role="alert"><p>{view.error}</p><Button onClick={() => { if (view) void load(view.url); }}>{t("common.retry")}</Button></div>}
      {view?.message && <>
        <p className="extension-card__mail-meta">{view.message.from}<br />{view.message.date}</p>
        {(view.message.markReadFailed || view.message.conversationUnavailable) && <p className="extension-card__caption">{t("extensionCards.mailPartial")}</p>}
        <ExtensionCardForm fields={fields} values={Object.fromEntries(fields.map(field => [field.name, field.value]))} images={extensionCardInlineImages(mailPreviewImages({ attachmentItems: JSON.stringify(view.message.attachments) }), view.media ?? {})} disabled expanded t={t} onChange={() => {}} />
        {view.message.conversation && <details className="extension-card__mail-thread"><summary>{t("extensionCards.mailThread", { count: view.message.conversation.messages.length })}</summary>
          {view.message.conversation.messages.map(message => <button type="button" key={message.messageId} disabled={message.messageId === view.message?.messageId}
            onClick={() => void load(message.url)}><strong>{message.from}</strong><span>{message.date}</span><span>{message.subject}</span><small>{message.snippet}</small></button>)}
        </details>}
      </>}
      {view && <div className="modal__actions"><Button onClick={() => { const url = view.url; assertCurrent(); void current.current.openHttpLink(url, { forceExternal: true, sessionId }).catch(() => { if (owner(current.current) === key) setView(previous => previous ? { ...previous, error: t("extensionCards.mailFailed") } : previous); }); }}>{t("extensionCards.mailOriginal")}</Button></div>}
    </Modal>
  </ExtensionMailLinkContext.Provider>;
}
