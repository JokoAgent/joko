import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { applyMailInlineEdits, mailInlineDocument, validMailImageUrl, type MailInlineImage } from "@joko/contracts";
import { followMailPreviewTheme } from "./mail-preview-appearance.js";

/** Only plain text from host-created source spans can alter the outgoing HTML. */
export function ExtensionMailPreview({ value, images = [], disabled, expanded, title, onChange }: {
  readonly value: string; readonly images?: MailInlineImage[]; readonly disabled: boolean; readonly expanded: boolean;
  readonly title: string; readonly onChange?: (html: string, text: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null), cleanup = useRef<() => void>(() => {});
  const model = useRef({ source: value, emitted: value, received: value, edits: {} as Record<string, string>, revision: 0 });
  if (model.current.received !== value) {
    if (value !== model.current.emitted) model.current = { source: value, emitted: value, received: value, edits: {}, revision: model.current.revision + 1 };
    else model.current.received = value;
  }
  const current = useRef({ disabled, onChange, images }); current.current = { disabled, onChange, images };
  const revision = model.current.revision;
  const html = useMemo(() => mailInlineDocument(model.current.source, images), [revision]);
  useEffect(() => () => cleanup.current(), []);
  useLayoutEffect(() => { if (frame.current) frame.current.style.visibility = "hidden"; }, [revision]);
  const fit = () => {
    const el = frame.current, doc = el?.contentDocument;
    if (!el || !doc?.body) return;
    el.style.height = "0px";
    const height = Math.ceil(Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, doc.body.getBoundingClientRect().bottom)) + 12;
    el.style.height = `${Math.max(80, Math.min(expanded ? 1200 : 440, height))}px`;
  };
  const refresh = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    for (const element of doc.querySelectorAll<HTMLElement>("[data-joko-mail-run]")) {
      element.contentEditable = current.current.onChange && !current.current.disabled ? "plaintext-only" : "false";
      element.spellcheck = true;
    }
    for (const element of doc.querySelectorAll<HTMLImageElement>("img[data-joko-mail-cid]")) {
      const image = current.current.images.find(item => item.cid === element.getAttribute("data-joko-mail-cid"));
      if (image && validMailImageUrl(image.url)) element.src = image.url;
    }
  };
  useEffect(refresh, [disabled, Boolean(onChange), JSON.stringify(images)]);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = -1;
    const observer = new ResizeObserver(entries => { const next = entries[0]?.contentRect.width; if (next !== width) { width = next ?? -1; fit(); } });
    observer.observe(element); return () => observer.disconnect();
  }, [expanded]);
  return <iframe ref={frame} className="extension-card__mail" title={title} sandbox="allow-same-origin" srcDoc={html} aria-busy="true"
    style={{ height: 120, visibility: "hidden" }} onLoad={() => {
      const element = frame.current, doc = element?.contentDocument;
      if (!element || !doc) return;
      cleanup.current();
      const stopTheme = followMailPreviewTheme(doc, document), loaded = model.current;
      let composing = false;
      const update = (event: Event) => {
        if (!event.isTrusted || composing || loaded !== model.current || current.current.disabled || !current.current.onChange) return;
        const target = event.target as Element | null;
        const span = target?.closest<HTMLElement>("[data-joko-mail-run]");
        if (!span) return;
        const id = span.getAttribute("data-joko-mail-run")!;
        const edits = { ...loaded.edits, [id]: span.innerText ?? span.textContent ?? "" }, next = applyMailInlineEdits(loaded.source, edits);
        if (!next) return;
        loaded.edits = edits; loaded.emitted = next.html; current.current.onChange(next.html, next.text); fit();
      };
      doc.addEventListener("compositionstart", () => { composing = true; });
      doc.addEventListener("compositionend", event => { composing = false; update(event); });
      doc.addEventListener("input", update);
      doc.addEventListener("click", event => { if ((event.target as Element | null)?.closest("a")) event.preventDefault(); });
      doc.addEventListener("drop", event => event.preventDefault());
      doc.addEventListener("paste", event => { event.preventDefault(); if (event.isTrusted && !current.current.disabled && current.current.onChange) doc.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? ""); });
      doc.addEventListener("load", fit, true);
      const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
      observer?.observe(doc.body);
      cleanup.current = () => { observer?.disconnect(); stopTheme(); };
      refresh(); fit(); element.style.visibility = "visible"; element.setAttribute("aria-busy", "false");
    }} />;
}
