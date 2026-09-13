import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type JSX
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ExternalLink,
  Ellipsis,
  Link as LinkIcon,
  Lock,
  MessageSquarePlus,
  RotateCw,
  Unlock,
  X
} from "lucide-react";
import type { Translator } from "./types.js";
import { parseBrowserOmnibox } from "./browser-omnibox.js";
import { IconButton } from "./ui.js";

export interface BrowserChromeHandle {
  focusOmnibox(): void;
}

export interface BrowserChromeProps {
  readonly url: string;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly externalUrl?: string;
  readonly copied: boolean;
  readonly commentSupported?: boolean;
  readonly commentActive?: boolean;
  readonly t: Translator;
  readonly onNavigate: (url: string) => void;
  readonly onCommand: (command: "back" | "forward" | "reload" | "stop") => void;
  readonly onCapture: () => void;
  readonly onCopyLink: () => void;
  readonly onComment?: () => void;
  readonly onOverlayOpenChange?: (open: boolean) => void;
}

export const BrowserChrome = forwardRef<BrowserChromeHandle, BrowserChromeProps>(function BrowserChrome({
  url,
  enabled,
  loading,
  canGoBack,
  canGoForward,
  externalUrl,
  copied,
  commentSupported = true,
  commentActive = false,
  t,
  onNavigate,
  onCommand,
  onCapture,
  onCopyLink,
  onComment,
  onOverlayOpenChange
}, ref): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const suppressBlurRef = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const updateMoreOpen = useCallback((open: boolean): void => {
    setMoreOpen(open);
    onOverlayOpenChange?.(open);
  }, [onOverlayOpenChange]);

  useEffect(() => {
    if (!moreOpen) return;
    const ownerDocument = moreRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && moreRef.current?.contains(event.target) === true) return;
      updateMoreOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      updateMoreOpen(false);
      moreTriggerRef.current?.focus();
    };
    ownerDocument.addEventListener("pointerdown", close);
    ownerDocument.addEventListener("keydown", escape);
    return () => {
      ownerDocument.removeEventListener("pointerdown", close);
      ownerDocument.removeEventListener("keydown", escape);
    };
  }, [moreOpen, updateMoreOpen]);

  const menuItems = useCallback((): HTMLElement[] => Array.from(
    moreRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
  ), []);

  const openMoreAndFocus = useCallback((edge: "first" | "last"): void => {
    updateMoreOpen(true);
    window.requestAnimationFrame(() => {
      const items = menuItems();
      (edge === "first" ? items[0] : items.at(-1))?.focus();
    });
  }, [menuItems, updateMoreOpen]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(event.target as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(current + 1 + items.length) % items.length];
    else if (event.key === "ArrowUp") next = items[(current - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Tab") updateMoreOpen(false);
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  const beginEdit = useCallback((): void => {
    if (!enabled) return;
    suppressBlurRef.current = false;
    setValue(url);
    setEditing(true);
  }, [enabled, url]);

  useImperativeHandle(ref, () => ({ focusOmnibox: beginEdit }), [beginEdit]);
  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const submit = useCallback((rawValue: string, ctrlEnter = false): void => {
    onNavigate(parseBrowserOmnibox(rawValue, { ctrlEnter }));
    setEditing(false);
  }, [onNavigate]);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      suppressBlurRef.current = true;
      submit(event.currentTarget.value, event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      suppressBlurRef.current = true;
      setEditing(false);
    }
  };

  const validLink = url !== "" && url !== "about:blank";
  const secure = url.startsWith("https://");
  return <div className="browser-chrome">
    <ChromeButton label={canGoBack ? t("browser.goBack") : t("browser.goBackUnavailable")} disabled={!enabled || !canGoBack} onClick={() => onCommand("back")}><ArrowLeft /></ChromeButton>
    <ChromeButton label={canGoForward ? t("browser.goForward") : t("browser.goForwardUnavailable")} disabled={!enabled || !canGoForward} onClick={() => onCommand("forward")}><ArrowRight /></ChromeButton>
    <ChromeButton label={loading ? t("browser.stop") : t("browser.reload")} disabled={!enabled} busy={loading} onClick={() => onCommand(loading ? "stop" : "reload")}>
      {loading ? <><span className="browser-chrome__spinner"><RotateCw /></span><span className="browser-chrome__reduced"><X /></span></> : <RotateCw />}
    </ChromeButton>
    <div className={`browser-chrome__omnibox${editing ? " is-editing" : ""}${!enabled ? " is-disabled" : ""}`}>
      {secure ? <Lock aria-hidden="true" /> : <Unlock aria-hidden="true" />}
      {editing ? <input
        ref={inputRef}
        value={value}
        aria-label={t("browser.address")}
        placeholder={t("browser.addressPlaceholder")}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={onInputKeyDown}
        onBlur={(event) => {
          if (suppressBlurRef.current) {
            suppressBlurRef.current = false;
            return;
          }
          submit(event.currentTarget.value);
        }}
      /> : <button type="button" disabled={!enabled} title={enabled ? url : t("browser.takeoverRequiredForChrome")} onClick={beginEdit}>{validLink ? url : t("browser.newTab")}</button>}
    </div>
    <ChromeButton label={t("browser.capture")} onClick={onCapture}><Camera /></ChromeButton>
    {commentSupported && onComment !== undefined && <ChromeButton active={commentActive} label={t(commentActive ? "browser.exitCommentMode" : "browser.comment")} onClick={onComment}><MessageSquarePlus /></ChromeButton>}
    <div className="browser-chrome__more" ref={moreRef}>
      <IconButton
        buttonRef={moreTriggerRef}
        label={t("browser.moreTools")}
        className={`browser-chrome__button${moreOpen ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onClick={() => moreOpen ? updateMoreOpen(false) : openMoreAndFocus("first")}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMoreAndFocus(event.key === "ArrowDown" ? "first" : "last");
        }}
      ><Ellipsis aria-hidden="true" /></IconButton>
      {moreOpen && <div className="browser-chrome__menu" role="menu" aria-label={t("browser.moreTools")} onKeyDown={onMenuKeyDown}>
        {externalUrl === undefined
          ? <button type="button" role="menuitem" disabled><ExternalLink aria-hidden="true" /><span>{t("browser.external")}</span></button>
          : <a href={externalUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={() => updateMoreOpen(false)}><ExternalLink aria-hidden="true" /><span>{t("browser.external")}</span></a>}
        <button type="button" role="menuitem" disabled={!validLink} onClick={() => { onCopyLink(); updateMoreOpen(false); }}>{copied ? <Check aria-hidden="true" /> : <LinkIcon aria-hidden="true" />}<span>{copied ? t("browser.linkCopied") : t("browser.copyLink")}</span></button>
      </div>}
    </div>
  </div>;
});

function ChromeButton({ label, disabled = false, active = false, busy = false, onClick, children }: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly onClick: () => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return <IconButton
    className={`browser-chrome__button${active ? " is-active" : ""}`}
    label={label}
    disabled={disabled}
    disabledReason={disabled ? label : undefined}
    aria-busy={busy || undefined}
    onClick={onClick}
  >{children}</IconButton>;
}
