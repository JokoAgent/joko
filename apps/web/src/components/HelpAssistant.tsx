import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { ArrowUpRight, CircleHelp, ThumbsDown, X } from "lucide-react";
import type { AppController } from "../controller.js";
import type { HelpFeedbackDraftView, Locale } from "../model.js";
import { HelpThread, type HelpThreadMessage } from "../help-thread.js";
import { randomUuid } from "../web-crypto.js";
import { TimelineMarkdownDocument } from "./TimelineMarkdownDocument.js";
import type { SettingsSection } from "./SettingsPage.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Spinner } from "./ui.js";
import "./HelpAssistant.css";

const DESTINATIONS = new Set<SettingsSection>(["general", "personalization", "providers", "voice", "import", "connections", "messaging", "tools", "about"]);

export function HelpAssistant({ controller, locale, t, onNavigate }: {
  readonly controller: AppController; readonly locale: Locale; readonly t: Translator;
  readonly onNavigate: (section: SettingsSection) => void;
}): JSX.Element {
  const owner = JSON.stringify([controller.state.activeProfile?.deviceId, controller.state.activeProfile?.serverId, controller.state.activeProfile?.origin]);
  const connection = JSON.stringify([owner, controller.state.activeProfile?.id]);
  return <HelpAssistantOwned key={connection} {...{ controller, locale, t, onNavigate, owner }} />;
}

function HelpAssistantOwned({ controller, locale, t, onNavigate, owner }: {
  readonly controller: AppController; readonly locale: Locale; readonly t: Translator; readonly owner: string;
  readonly onNavigate: (section: SettingsSection) => void;
}): JSX.Element {
  const thread = useMemo(() => { let storage: Storage | undefined; try { storage = window.localStorage; } catch { /* memory only */ }
    return new HelpThread(owner, storage); }, [owner]);
  const state = useSyncExternalStore(thread.subscribe, thread.snapshot, thread.snapshot);
  const [open, setOpen] = useState(() => helpRequested()), [value, setValue] = useState("");
  const [width, setWidth] = useState(() => { try { const n = Number(localStorage.getItem("joko.help-panel.width")); return n >= 320 && n <= 840 ? n : 520; } catch { return 520; } });
  const scroll = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const connected = controller.state.ready && controller.state.connectionState === "connected";
  useEffect(() => {
    const show = (): void => setOpen(true);
    window.addEventListener("joko:open-help", show);
    return () => window.removeEventListener("joko:open-help", show);
  }, []);
  useEffect(() => {
    if (!open || !helpRequested()) return;
    const [path, query] = window.location.hash.split("?");
    const parameters = new URLSearchParams(query); parameters.delete("help");
    window.history.replaceState(window.history.state, "", `${path}${parameters.size === 0 ? "" : `?${parameters}`}`);
  }, [open]);
  useLayoutEffect(() => { if (!connected) thread.retire(); return () => thread.retire(); }, [thread, connected]);
  useLayoutEffect(() => { if (open) input.current?.focus(); }, [open]);
  useLayoutEffect(() => { if (scroll.current !== null) scroll.current.scrollTop = scroll.current.scrollHeight; }, [state, open]);
  useEffect(() => { try { localStorage.setItem("joko.help-panel.width", String(width)); } catch { /* optional preference */ } }, [width]);
  const close = (): void => { setOpen(false); trigger.current?.focus(); };
  const send = (): void => { if (!connected || state.pending || !value.trim()) return; const question = value; setValue(""); void thread.ask(controller, question, locale); };
  return <>
    <button ref={trigger} type="button" className="button help-assistant-trigger" aria-expanded={open} aria-controls="settings-help-panel" onClick={() => setOpen(!open)}><CircleHelp aria-hidden="true" />{t("help.open")}</button>
    {open && <aside id="settings-help-panel" className="help-assistant" style={{ width: `${width}px` }} aria-label={t("help.title")} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <div role="separator" tabIndex={0} aria-label={t("help.resize")} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={840} aria-valuenow={width}
        className="help-assistant-resize" onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((old) => Math.max(320, Math.min(840, old + (event.key === "ArrowLeft" ? 20 : -20)))); } }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(320, Math.min(840, window.innerWidth - event.clientX))); }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <header><h2>{t("help.title")}</h2>{state.messages.length > 0 && <Button onClick={() => { thread.reset(); input.current?.focus(); }}>{t("help.reset")}</Button>}<IconButton label={t("common.close")} onClick={close}><X aria-hidden="true" /></IconButton></header>
      <div ref={scroll} className="help-assistant-thread" role="log" aria-label={t("help.conversation")} aria-live="polite">
        {state.messages.length === 0 && <div className="help-assistant-empty"><strong>{t("help.emptyTitle")}</strong><p>{t("help.emptyHint")}</p></div>}
        {state.messages.map((message, index) => <div key={message.id} className={`help-assistant-message help-assistant-message--${message.role}`}>
          {message.role === "user" ? <p>{message.content}</p> : <>
            {message.content.trim() ? <div className="help-assistant-markdown"><TimelineMarkdownDocument skipHtml urlTransform={() => ""}>{message.content}</TimelineMarkdownDocument></div> : <p>{t("help.noAnswer")}</p>}
            {message.settingsSection !== undefined && DESTINATIONS.has(message.settingsSection as SettingsSection) && <Button onClick={() => onNavigate(message.settingsSection as SettingsSection)}><ArrowUpRight aria-hidden="true" />{t("help.openSettings", { section: t(sectionTitle(message.settingsSection)) })}</Button>}
            {message.content.trim() && <small>{t("help.aiHint")}</small>}
            {state.messages[index - 1]?.role === "user" && <HelpFeedback key={message.id} {...{ message, thread, controller, locale, t }} question={state.messages[index - 1]!.content} connected={connected} />}
          </>}
        </div>)}
        {state.pending && <p role="status"><Spinner />{t("help.pending")}</p>}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); send(); }}><input ref={input} value={value} maxLength={16_000} aria-label={t("help.question")} placeholder={t("help.placeholder")} disabled={state.pending || !connected} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} /><Button tone="primary" disabled={!connected || state.pending || !value.trim()} type="submit">{t("help.send")}</Button></form>
      {!connected && <p className="help-assistant-offline" role="status">{t("help.connect")}</p>}
    </aside>}
  </>;
}

function HelpFeedback({ message, question, thread, controller, connected, locale, t }: {
  readonly message: HelpThreadMessage; readonly question: string; readonly thread: HelpThread; readonly controller: AppController;
  readonly connected: boolean; readonly locale: Locale; readonly t: Translator;
}): JSX.Element {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [title, setTitle] = useState(message.feedbackAttempt?.title ?? t("help.feedbackDefaultTitle", { question: question.trim().replace(/\s+/gu, " ").slice(0, 80) }));
  const [body, setBody] = useState(message.feedbackAttempt?.body ?? t("help.feedbackDefaultBody", { question, answer: message.content || t("help.noAnswer") }));
  const pending = useRef(false), epoch = useRef(0);
  useEffect(() => () => { epoch.current += 1; }, []);
  const save = async (): Promise<void> => {
    if (pending.current || !connected || !title.trim() || !body.trim()) return;
    const incarnation = epoch.current;
    pending.current = true; setBusy(true); setFailed(false);
    const draft: HelpFeedbackDraftView = message.feedbackAttempt ?? { requestId: randomUuid(), question, answer: message.content, title, body, locale };
    thread.markFeedback(message.id, { feedbackAttempt: draft });
    try { const draftId = await controller.createHelpFeedbackDraft(draft); if (epoch.current === incarnation) thread.markFeedback(message.id, { feedbackDraftId: draftId }); }
    catch { if (epoch.current === incarnation) setFailed(true); }
    finally { pending.current = false; if (epoch.current === incarnation) setBusy(false); }
  };
  if (message.feedbackDraftId !== undefined) return <p className="help-feedback-recorded" role="status">{t("help.feedbackRecorded")}</p>;
  if (!editing) return <Button tone="ghost" onClick={() => setEditing(true)}><ThumbsDown aria-hidden="true" />{t("help.feedback")}</Button>;
  return <div className="help-feedback"><label>{t("help.feedbackTitle")}<input value={title} maxLength={200} disabled={busy || message.feedbackAttempt !== undefined} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>{t("help.feedbackBody")}<textarea value={body} maxLength={24_000} disabled={busy || message.feedbackAttempt !== undefined} onChange={(event) => setBody(event.target.value)} /></label>
    <small>{t("help.feedbackLocal")}</small>{failed && <p role="alert">{t("help.feedbackFailed")}</p>}
    <div><Button disabled={busy} onClick={() => setEditing(false)}>{t("common.cancel")}</Button><Button disabled={busy || !connected || !title.trim() || !body.trim()} onClick={() => { void save(); }}>{busy ? <Spinner /> : undefined}{t("common.save")}</Button></div>
  </div>;
}

function sectionTitle(section: string): "settings.general" | "settings.personalization" | "settings.providers" | "settings.voiceInput" | "portable.importTitle" | "settings.connections" | "settings.messaging" | "settings.toolPolicies.nav" | "settings.about" {
  switch (section) {
    case "personalization": return "settings.personalization"; case "providers": return "settings.providers"; case "voice": return "settings.voiceInput";
    case "import": return "portable.importTitle"; case "connections": return "settings.connections"; case "messaging": return "settings.messaging";
    case "tools": return "settings.toolPolicies.nav"; case "about": return "settings.about"; default: return "settings.general";
  }
}

function helpRequested(): boolean { return new URLSearchParams(window.location.hash.split("?")[1]).get("help") === "1"; }
