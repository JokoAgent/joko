import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

import type { AppShortcutOverrides } from "../app-shortcuts.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

import "./desktop-page-search-bar.css";

interface DesktopPageSearchBarProps {
  readonly overrides: AppShortcutOverrides;
  readonly t: Translator;
}

/** Desktop-only native page search. Browsers keep their built-in find surface. */
export function DesktopPageSearchBar({ overrides, t }: DesktopPageSearchBarProps): JSX.Element | null {
  const api = typeof window === "undefined" || window.jokoDesktop?.capabilities.includes("page.search") !== true
    ? undefined
    : window.jokoDesktop.pageSearch;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestTokenRef = useRef(0);
  const activeRequestTokenRef = useRef(0);

  const nextRequestToken = useCallback((): number => {
    requestTokenRef.current = requestTokenRef.current >= Number.MAX_SAFE_INTEGER
      ? 1
      : requestTokenRef.current + 1;
    activeRequestTokenRef.current = requestTokenRef.current;
    return requestTokenRef.current;
  }, []);

  useEffect(() => api?.onResult((result) => {
    if (result.requestToken !== activeRequestTokenRef.current) return;
    setMatches(result.matches);
    setActiveMatch(result.activeMatchOrdinal);
    setFailed(false);
  }), [api]);

  const stop = useCallback((): void => {
    nextRequestToken();
    void api?.stop("clearSelection").catch(() => undefined);
  }, [api, nextRequestToken]);

  const close = useCallback((): void => {
    stop();
    setOpen(false);
    setQuery("");
    setMatches(0);
    setActiveMatch(0);
    setFailed(false);
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnFocus?.isConnected === true) {
      window.requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }));
    }
  }, [stop]);

  const run = useCallback((text: string, forward: boolean, findNext: boolean): void => {
    if (api === undefined) return;
    if (text === "") {
      stop();
      setMatches(0);
      setActiveMatch(0);
      setFailed(false);
      return;
    }
    const requestToken = nextRequestToken();
    setFailed(false);
    void api.start({ text, forward, findNext, requestToken }).catch(() => {
      if (activeRequestTokenRef.current !== requestToken) return;
      setMatches(0);
      setActiveMatch(0);
      setFailed(true);
    });
  }, [api, nextRequestToken, stop]);

  useAppShortcut("find-in-page", overrides, () => {
    if (api === undefined || localPageSearchOwnsShortcut(document)) return false;
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

  useEffect(() => () => {
    nextRequestToken();
    void api?.stop("clearSelection").catch(() => undefined);
  }, [api, nextRequestToken]);

  if (!open || api === undefined) return null;
  const unavailable = query === "" || matches === 0 || failed;
  const count = query === "" ? "" : matches === 0 ? "0/0" : `${activeMatch}/${matches}`;

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing || query === "") return;
    event.preventDefault();
    event.stopPropagation();
    run(query, !event.shiftKey, true);
  };

  return <div className="desktop-page-search-bar" role="search" aria-label={t("pageSearch.dialog")}>
    <input
      ref={inputRef}
      type="text"
      value={query}
      aria-label={t("pageSearch.dialog")}
      placeholder={t("pageSearch.placeholder")}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value;
        setQuery(next);
        run(next, true, false);
      }}
      onKeyDown={onInputKeyDown}
    />
    <span className="desktop-page-search-bar__count" aria-live="polite">
      {failed ? t("pageSearch.unavailable") : count}
    </span>
    <IconButton label={t("pageSearch.previous")} disabled={unavailable} onClick={() => run(query, false, true)}><ChevronUp aria-hidden="true" /></IconButton>
    <IconButton label={t("pageSearch.next")} disabled={unavailable} onClick={() => run(query, true, true)}><ChevronDown aria-hidden="true" /></IconButton>
    <IconButton label={t("pageSearch.close")} onClick={close}><X aria-hidden="true" /></IconButton>
  </div>;
}

export function localPageSearchOwnsShortcut(ownerDocument: Document): boolean {
  return [...ownerDocument.querySelectorAll("[data-local-page-search-owner='true']")]
    .some((owner) => owner.closest("[inert], [aria-hidden='true']") === null);
}
