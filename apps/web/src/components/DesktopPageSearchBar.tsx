import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

import type { AppShortcutOverrides } from "../app-shortcuts.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";
import {
  clearDesktopPageHighlights, desktopPageElementVisible, findDesktopPageMatches,
  paintDesktopPageMatches, scrollDesktopPageMatch, type DesktopPageMatch
} from "./desktop-page-search.js";

import "./desktop-page-search-bar.css";

interface DesktopPageSearchBarProps {
  readonly overrides: AppShortcutOverrides;
  readonly t: Translator;
}

const DOM_REFRESH_DELAY_MS = 100;

/** Desktop renderer search owns highlights; ordinary browsers keep built-in Find. */
export function DesktopPageSearchBar({ overrides, t }: DesktopPageSearchBarProps): JSX.Element | null {
  const available = typeof window !== "undefined" && window.jokoDesktop?.capabilities.includes("page.search") === true;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const queryRef = useRef("");
  const searchedTextRef = useRef<string | undefined>(undefined);
  const resultRef = useRef<readonly DesktopPageMatch[]>([]);
  const activeIndexRef = useRef(-1);
  const documentsRef = useRef(new Set<Document>());
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const stop = useCallback((): void => {
    searchedTextRef.current = undefined;
    resultRef.current = [];
    activeIndexRef.current = -1;
    clearDesktopPageHighlights(documentsRef.current);
  }, []);

  const close = useCallback((): void => {
    stop();
    setOpen(false);
    setQuery("");
    queryRef.current = "";
    setMatches(0);
    setActiveMatch(0);
    setFailed(false);
    composingRef.current = false;
    setComposing(false);
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnFocus?.isConnected === true) window.requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }));
  }, [stop]);

  const run = useCallback((text: string, forward: boolean, findNext: boolean, refresh = false): void => {
    if (!available || composingRef.current) return;
    if (text === "") {
      stop();
      setMatches(0);
      setActiveMatch(0);
      setFailed(false);
      return;
    }
    if (!findNext && !refresh && searchedTextRef.current === text) return;
    const sameQuery = searchedTextRef.current === text;
    searchedTextRef.current = text;
    try {
      const previous = resultRef.current[activeIndexRef.current];
      const result = findDesktopPageMatches(document, text);
      let index = sameQuery && previous !== undefined
        ? result.matches.findIndex((match) => match.range.startContainer === previous.range.startContainer
          && match.range.startOffset === previous.range.startOffset && match.range.endContainer === previous.range.endContainer
          && match.range.endOffset === previous.range.endOffset)
        : -1;
      if (index < 0 && sameQuery) index = Math.min(activeIndexRef.current, result.matches.length - 1);
      if (findNext && index >= 0) index = (index + (forward ? 1 : -1) + result.matches.length) % result.matches.length;
      else if (index < 0 && result.matches.length > 0) index = forward ? 0 : result.matches.length - 1;
      clearDesktopPageHighlights(documentsRef.current);
      documentsRef.current = new Set(result.documents);
      if (!paintDesktopPageMatches(result.documents, result.matches, index)) throw new Error("Page highlighting is unavailable.");
      resultRef.current = result.matches;
      activeIndexRef.current = index;
      setMatches(result.matches.length);
      setActiveMatch(index + 1);
      setFailed(false);
      const selected = result.matches[index];
      if (!refresh && selected !== undefined) scrollDesktopPageMatch(selected);
    } catch {
      stop();
      setMatches(0);
      setActiveMatch(0);
      setFailed(true);
    }
  }, [available, stop]);

  useAppShortcut("find-in-page", overrides, () => {
    if (!available || localPageSearchOwnsShortcut(document)) return false;
    if (!open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    }
    window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return true;
  }, { stopImmediate: true });

  useEffect(() => {
    if (!open || !available) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const subscriptions = new Map<Document, () => void>();
    const refresh = (): void => {
      timer = undefined;
      if (disposed) return;
      run(queryRef.current, true, false, true);
      observeDocuments();
    };
    const schedule = (): void => {
      if (timer === undefined) timer = setTimeout(refresh, DOM_REFRESH_DELAY_MS);
    };
    const observeDocuments = (): void => {
      const documents = findDesktopPageMatches(document, "").documents;
      for (const [owner, unsubscribe] of subscriptions) {
        if (!documents.includes(owner)) { unsubscribe(); subscriptions.delete(owner); }
      }
      for (const owner of documents) {
        if (subscriptions.has(owner)) continue;
        const ignored = (target: Node): boolean => {
          const element = target.nodeType === 1 ? target as Element : target.parentElement;
          return element !== null && element.closest("[data-page-search-ignore]") !== null;
        };
        const observer = new MutationObserver((records) => {
          if (records.some((record) => !ignored(record.target))) schedule();
        });
        observer.observe(owner.body, { subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ["class", "style", "hidden", "open", "inert"] });
        const events = ["toggle", "load", "transitionend", "animationend"] as const;
        for (const name of events) owner.addEventListener(name, schedule, true);
        owner.defaultView?.addEventListener("resize", schedule);
        let frameStyle: HTMLStyleElement | undefined;
        if (owner !== document) {
          frameStyle = owner.createElement("style");
          const palette = window.getComputedStyle(document.documentElement);
          frameStyle.textContent = `::highlight(joko-page-search){background:${palette.getPropertyValue("--accent-soft")};color:${palette.getPropertyValue("--text")}}::highlight(joko-page-search-active){background:${palette.getPropertyValue("--accent")};color:${palette.getPropertyValue("--accent-contrast")}}`;
          owner.head?.append(frameStyle);
        }
        subscriptions.set(owner, () => {
          observer.disconnect();
          for (const name of events) owner.removeEventListener(name, schedule, true);
          owner.defaultView?.removeEventListener("resize", schedule);
          frameStyle?.remove();
        });
      }
    };
    observeDocuments();
    return () => {
      disposed = true;
      clearTimeout(timer);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      stop();
    };
  }, [available, open, run, stop]);

  if (!open || !available) return null;
  const unavailable = composing || query === "" || matches === 0 || failed;
  const count = query === "" ? "" : matches === 0 ? "0/0" : `${activeMatch}/${matches}`;
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Enter" || query === "") return;
    event.preventDefault();
    event.stopPropagation();
    run(query, !event.shiftKey, true);
  };

  return <div className="desktop-page-search-bar" role="search" aria-label={t("pageSearch.dialog")} data-page-search-ignore>
    <input ref={inputRef} type="text" value={query} aria-label={t("pageSearch.dialog")} placeholder={t("pageSearch.placeholder")} spellCheck={false}
      onCompositionStart={() => {
        composingRef.current = true;
        setComposing(true);
        stop();
        setMatches(0);
        setActiveMatch(0);
        setFailed(false);
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        setComposing(false);
        const next = event.currentTarget.value;
        queryRef.current = next;
        setQuery(next);
        run(next, true, false);
      }}
      onChange={(event) => {
        const next = event.target.value;
        queryRef.current = next;
        setQuery(next);
        run(next, true, false);
      }}
      onKeyDown={onInputKeyDown}
    />
    <span className="desktop-page-search-bar__count" aria-live="polite">{failed ? t("pageSearch.unavailable") : count}</span>
    <IconButton label={t("pageSearch.previous")} disabled={unavailable} onClick={() => run(query, false, true)}><ChevronUp aria-hidden="true" /></IconButton>
    <IconButton label={t("pageSearch.next")} disabled={unavailable} onClick={() => run(query, true, true)}><ChevronDown aria-hidden="true" /></IconButton>
    <IconButton label={t("pageSearch.close")} onClick={close}><X aria-hidden="true" /></IconButton>
  </div>;
}

export function localPageSearchOwnsShortcut(ownerDocument: Document): boolean {
  return [...ownerDocument.querySelectorAll("[data-local-page-search-owner='true']")]
    .some((owner) => desktopPageElementVisible(owner) && owner.closest("[aria-hidden='true']") === null);
}
