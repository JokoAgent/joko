import { McpAppOperation, type McpAppCard as Card, type McpAppServiceOperateResponse } from "@joko/contracts";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppController } from "../controller.js";
import type { McpAppApi } from "../model.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, Spinner } from "./ui.js";
import "./mcp-app-card.css";

const UI_OWNER_ID = randomUuid();

interface Actions {
  readonly api?: McpAppApi;
  readonly bind?: () => McpAppApi | undefined;
  readonly ownerKey: string;
  readonly uiOwnerId: string;
  readonly readOnly: boolean;
  readonly openLink?: (url: string) => Promise<void>;
}
const Context = createContext<Actions>({ ownerKey: "", uiOwnerId: UI_OWNER_ID, readOnly: true });
function ownerFor(controller: AppController): string {
  return JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId,
    controller.state.activeProfile?.origin, controller.state.connectionState, String(controller.state.snapshot.generation)]);
}
export function McpAppTimelineProvider({ controller, children }: { readonly controller: AppController; readonly children: ReactNode }) {
  const current = useRef(controller); current.current = controller;
  const ownerKey = ownerFor(controller), readOnly = controller.state.sessionAccess?.role === "guest";
  const value = useMemo<Actions>(() => ({ ownerKey, uiOwnerId: UI_OWNER_ID, readOnly,
    bind: () => readOnly || current.current.state.connectionState !== "connected" || ownerFor(current.current) !== ownerKey
      ? undefined : current.current.mcpAppApi(),
    openLink: async url => {
      if (ownerFor(current.current) !== ownerKey) throw new Error("Application connection changed.");
      await current.current.openHttpLink(url);
    }
  }), [ownerKey, readOnly]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Only the isolated proxy owns App transport. Public UI receives a URL and display state. */
export function McpAppCard({ card, locale, t }: { readonly card: Card; readonly locale: string; readonly t: Translator }) {
  const actions = useContext(Context);
  const bound = useMemo(() => ({ ...actions, api: actions.bind?.() }), [actions]);
  return <ApplicationCard key={`${actions.ownerKey}:${card.cardId}`} card={card} locale={locale} t={t} actions={bound} />;
}

function contextFor(locale: string, element: HTMLElement) {
  const root = element.ownerDocument.documentElement, style = getComputedStyle(root);
  const variable = (name: string) => style.getPropertyValue(name).trim();
  return { theme: root.dataset.theme === "dark" || root.classList.contains("dark") ? "dark" : "light", locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: window.jokoDesktop ? "desktop" : "web", userAgent: "Joko",
    deviceCapabilities: { touch: navigator.maxTouchPoints > 0, hover: matchMedia("(hover: hover)").matches },
    containerDimensions: { width: Math.round(element.clientWidth), maxHeight: 1200 },
    styles: { variables: { "--color-background-primary": variable("--surface"), "--color-background-secondary": variable("--surface-raised"),
      "--color-background-tertiary": variable("--surface-hover"), "--color-text-primary": variable("--text"),
      "--color-text-secondary": variable("--text-soft"), "--color-text-tertiary": variable("--text-faint"),
      "--color-border-primary": variable("--line"), "--color-border-secondary": variable("--line"),
      "--color-text-danger": variable("--red"), "--color-text-warning": variable("--amber"),
      "--font-sans": style.fontFamily, "--font-mono": variable("--font-mono"), "--border-radius-md": "8px" } } };
}

function ApplicationCard({ card, locale, t, actions }: { readonly card: Card; readonly locale: string; readonly t: Translator; readonly actions: Actions }) {
  const container = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef({ locale, actions }); latest.current = { locale, actions };
  const [visible, setVisible] = useState(false), [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true), [height, setHeight] = useState(320), [fullscreen, setFullscreen] = useState(false);
  const [border, setBorder] = useState(true);
  const view = useRef<{ readonly api: McpAppApi; readonly document: McpAppServiceOperateResponse; readonly uiOwnerId: string } | undefined>(undefined);
  useEffect(() => {
    const root = container.current;
    if (root === null) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "160px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = container.current, api = actions.api;
    if (element === null || api === undefined || !visible) return;
    let disposed = false, closing = false, frame: HTMLIFrameElement | undefined, opened: McpAppServiceOperateResponse | undefined;
    let closePromise: Promise<unknown> | undefined;
    const uiOwnerId = actions.uiOwnerId, openId = randomUuid(), abort = new AbortController();
    let timeout: number | undefined;
    setLoading(true); setFailed(false);
    const operate = (operation: McpAppOperation, extra: { viewId?: string; contextJson?: string; displayMode?: string } = {}) =>
      api.operate({ sessionId: card.sessionId, cardId: card.cardId, uiOwnerId, openId, operation, ...extra });
    const close = () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      view.current = undefined;
      closePromise = (opened === undefined ? operate(McpAppOperation.CANCEL_OPEN)
        : operate(McpAppOperation.TEARDOWN, { viewId: opened.viewId })).catch(() => undefined);
      if (frame !== undefined) {
        // Atomic reparenting retains the live Chromium frame for bounded teardown.
        frame.style.cssText = "position:fixed;width:1px;height:1px;visibility:hidden;pointer-events:none";
        const body = element.ownerDocument.body as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
        if (frame.isConnected) {
          try { body.moveBefore?.(frame, null); } catch { /* A detached ancestor can no longer retain its browsing context. */ }
        }
        void closePromise.finally(() => frame?.remove());
      }
      return closePromise;
    };
    const fail = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (!disposed && !closing) { setFailed(true); setLoading(false); setFullscreen(false); }
      void close();
    };
    const onMessage = (event: MessageEvent) => {
      if (disposed || closing || frame === undefined || event.source !== frame.contentWindow || event.data === null || typeof event.data !== "object") return;
      const message = event.data as { method?: string; type?: string; id?: string; url?: string; params?: { height?: number; displayMode?: string } };
      if (message.type === "joko:mcp-app-link" && typeof message.id === "string" && typeof message.url === "string") {
        const id = message.id, url = message.url;
        void Promise.resolve().then(() => {
          if (latest.current.actions.openLink === undefined) throw new Error("Link opening is unavailable.");
          return latest.current.actions.openLink(url);
        }).then(() => {
          if (!disposed && !closing) frame?.contentWindow?.postMessage({ type: "joko:mcp-app-link-result", id, success: true }, "*");
        }, () => { if (!disposed && !closing) frame?.contentWindow?.postMessage({ type: "joko:mcp-app-link-result", id, success: false }, "*"); });
      }
      if (message.method === "ui/notifications/initialized") { if (timeout !== undefined) window.clearTimeout(timeout); setLoading(false); }
      if (message.method === "ui/notifications/size-changed" && typeof message.params?.height === "number" && Number.isFinite(message.params.height))
        setHeight(Math.max(80, Math.min(1200, Math.ceil(message.params.height))));
      if (message.method === "ui/notifications/host-context-changed") {
        if (message.params?.displayMode === "fullscreen") setFullscreen(true);
        if (message.params?.displayMode === "inline") setFullscreen(false);
      }
      if (message.method === "ui/notifications/sandbox-escape" && opened !== undefined)
        void operate(McpAppOperation.DISPLAY_MODE, { viewId: opened.viewId, displayMode: "inline" }).catch(fail);
      if (message.method === "ui/notifications/sandbox-failed") fail();
    };
    window.addEventListener("message", onMessage);
    timeout = window.setTimeout(fail, 135_000);
    void api.operate({ sessionId: card.sessionId, cardId: card.cardId, uiOwnerId, openId, operation: McpAppOperation.OPEN,
      contextJson: JSON.stringify(contextFor(latest.current.locale, element)) }, abort.signal).then(async document => {
      opened = document;
      if (disposed || closing) { await operate(McpAppOperation.TEARDOWN, { viewId: document.viewId }); return; }
      const url = new URL(document.proxyUrl);
      const nativeSurface = window.jokoDesktop?.mcpApps !== undefined && url.protocol === "joko-mcp-app:";
      if ((!nativeSurface && !["https:", "http:"].includes(url.protocol)) || url.username || url.password) throw new Error("Invalid application surface.");
      view.current = { api, document, uiOwnerId };
      setBorder(document.prefersBorder);
      frame = element.ownerDocument.createElement("iframe");
      frame.title = card.title || t("mcpApps.app"); frame.className = "mcp-app-card__frame";
      frame.setAttribute("sandbox", nativeSurface ? "allow-scripts allow-same-origin" : "allow-scripts");
      frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.src = document.proxyUrl; element.appendChild(frame);
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(fail, 45_000);
    }).catch(fail);
    let updateFrame: number | undefined;
    const update = () => {
      if (updateFrame !== undefined || closing) return;
      updateFrame = requestAnimationFrame(() => { updateFrame = undefined;
        if (!disposed && !closing && opened !== undefined) void operate(McpAppOperation.CONTEXT,
          { viewId: opened.viewId, contextJson: JSON.stringify(contextFor(latest.current.locale, element)) }).catch(fail);
      });
    };
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(element.ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const sizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    sizeObserver?.observe(element);
    return () => {
      disposed = true; abort.abort(); if (timeout !== undefined) window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage); themeObserver.disconnect(); sizeObserver?.disconnect();
      if (updateFrame !== undefined) cancelAnimationFrame(updateFrame);
      void close();
    };
  }, [actions.api, actions.ownerKey, actions.uiOwnerId, attempt, card.cardId, card.sessionId, visible]);
  useEffect(() => {
    const current = view.current, element = container.current;
    if (current !== undefined && element !== null) void current.api.operate({ sessionId: card.sessionId, uiOwnerId: current.uiOwnerId,
      operation: McpAppOperation.CONTEXT, viewId: current.document.viewId, contextJson: JSON.stringify(contextFor(locale, element)) }).catch(() => undefined);
  }, [locale, card.sessionId]);
  useLayoutEffect(() => {
    if (!fullscreen || dialog.current === null || typeof dialog.current.showModal !== "function") return;
    const node = dialog.current, previous = node.ownerDocument.activeElement;
    node.close(); node.showModal(); node.querySelector<HTMLButtonElement>("[data-collapse]")?.focus();
    return () => { node.close(); node.setAttribute("open", ""); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [fullscreen]);
  const displayMode = (mode: string) => {
    const current = view.current;
    if (current !== undefined) void current.api.operate({ sessionId: card.sessionId, uiOwnerId: current.uiOwnerId,
      operation: McpAppOperation.DISPLAY_MODE, viewId: current.document.viewId, displayMode: mode }).catch(() => setFailed(true));
  };
  return <dialog ref={dialog} open className={`mcp-app-card${border ? " mcp-app-card--border" : ""}${fullscreen ? " is-fullscreen" : ""}`}
    role={fullscreen ? "dialog" : "region"} aria-modal={fullscreen || undefined} aria-label={card.title || t("mcpApps.app")}
    onCancel={event => { event.preventDefault(); displayMode("inline"); }}>
    <header><strong>{card.title || t("mcpApps.app")}</strong>{actions.api && loading && visible && !failed && <Spinner />}
      {actions.api && !loading && !failed && <Button data-collapse={fullscreen || undefined} tone="ghost" onClick={() => displayMode(fullscreen ? "inline" : "fullscreen")}>{t(fullscreen ? "mcpApps.collapse" : "mcpApps.expand")}</Button>}
      {failed && <Button tone="ghost" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</Button>}</header>
    {failed && <p role="alert">{t("mcpApps.failed")}</p>}
    {(failed || actions.api === undefined) && card.text && <p className="mcp-app-card__fallback">{card.text}</p>}
    {actions.api === undefined && <p>{t(actions.readOnly ? "mcpApps.readOnly" : "mcpApps.unavailable")}</p>}
    <div ref={container} className="mcp-app-card__surface" style={{ height: failed || actions.api === undefined ? 0 : fullscreen ? undefined : height }} />
  </dialog>;
}
