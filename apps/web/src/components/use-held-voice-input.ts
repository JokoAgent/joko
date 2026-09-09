import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { matchesVoiceInputShortcut, releasesVoiceInputShortcut, type VoiceInputShortcutPreference } from "../voice-input-preferences.js";
import { selectControlOwnsEscape } from "./ui.js";

interface HeldVoiceOptions {
  readonly scope: object;
  readonly root: HTMLElement | undefined;
  readonly sendTarget: HTMLButtonElement | undefined;
  readonly canSend: boolean;
  readonly enabled: boolean;
  readonly phase: string | undefined;
  readonly shortcut: VoiceInputShortcutPreference;
  readonly nativeShortcut: boolean;
  readonly isActive: () => boolean;
  readonly start: () => boolean;
  readonly finish: () => Promise<unknown>;
  readonly cancel: () => void;
  readonly onSend: (event?: KeyboardEvent) => void;
  readonly isSendKey: (event: KeyboardEvent) => boolean;
}
interface Press {
  readonly scope: object;
  readonly pointer?: { readonly id: number; readonly node: HTMLButtonElement };
  readonly shortcut?: VoiceInputShortcutPreference;
  timer?: number;
  held: boolean;
  point?: { readonly x: number; readonly y: number };
}

/** Pointer and keyboard gestures share one explicit press owner; release never sends implicitly. */
export function useHeldVoiceInput(options: HeldVoiceOptions) {
  const latest = useRef(options); latest.current = options;
  const ownerDocument = options.root?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  const activeScope = useRef<object | undefined>(undefined);
  const pressRef = useRef<Press | undefined>(undefined);
  const pointerAttemptRef = useRef<number | undefined>(undefined);
  const suppressedRef = useRef(false);
  const suppressTimer = useRef<number | undefined>(undefined);
  const [held, setHeld] = useState(false);
  const [sendTargetActive, setSendTargetActive] = useState(false);
  const live = useCallback(() => activeScope.current === options.scope && options.root?.isConnected === true
    && options.root.ownerDocument === ownerDocument && ownerWindow != null && !ownerWindow.closed, [options.scope, options.root, ownerDocument, ownerWindow]);
  const targetAt = useCallback((point: Press["point"]): boolean => {
    const target = latest.current.sendTarget;
    if (point === undefined || !live() || !latest.current.canSend || target === undefined || !target.isConnected
      || target.ownerDocument !== ownerDocument || target.disabled || target.getAttribute("aria-disabled") === "true") return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && point.x >= rect.left - 10 && point.x <= rect.right + 10
      && point.y >= rect.top - 10 && point.y <= rect.bottom + 10;
  }, [live, ownerDocument]);
  const suppressClick = useCallback(() => {
    if (ownerWindow == null) return;
    suppressedRef.current = true;
    if (suppressTimer.current !== undefined) ownerWindow.clearTimeout(suppressTimer.current);
    suppressTimer.current = ownerWindow.setTimeout(() => { suppressTimer.current = undefined; suppressedRef.current = false; }, 250);
  }, [ownerWindow]);
  const clearPress = useCallback((): Press | undefined => {
    const press = pressRef.current;
    pressRef.current = undefined;
    if (press?.timer !== undefined) ownerWindow?.clearTimeout(press.timer);
    if (press?.pointer !== undefined && press.pointer.node.hasPointerCapture?.(press.pointer.id)) press.pointer.node.releasePointerCapture(press.pointer.id);
    setHeld(false); setSendTargetActive(false);
    return press;
  }, [ownerWindow]);
  const updateTarget = useCallback(() => {
    const press = pressRef.current;
    setSendTargetActive(press?.held === true && targetAt(press.point));
  }, [targetAt]);
  const begin = useCallback((press: Press, delay: number): void => {
    if (ownerWindow == null) return;
    pressRef.current = press;
    press.timer = ownerWindow.setTimeout(() => {
      if (pressRef.current !== press || !live() || !latest.current.isActive()) return;
      press.timer = undefined; press.held = true; setHeld(true); updateTarget();
    }, delay);
  }, [live, ownerWindow, updateTarget]);
  useLayoutEffect(() => {
    activeScope.current = options.scope;
    return () => {
      activeScope.current = undefined; clearPress();
      pointerAttemptRef.current = undefined;
      if (suppressTimer.current !== undefined) ownerWindow?.clearTimeout(suppressTimer.current);
      suppressTimer.current = undefined; suppressedRef.current = false;
    };
  }, [options.scope, clearPress, ownerWindow]);
  useEffect(() => {
    if (options.phase === "starting" || options.phase === "listening") return;
    clearPress();
  }, [options.phase, clearPress]);
  useLayoutEffect(updateTarget, [options.canSend, options.sendTarget, updateTarget]);
  useEffect(() => {
    if (ownerWindow == null || ownerDocument === undefined) return;
    const resize = typeof ownerWindow.ResizeObserver === "function" ? new ownerWindow.ResizeObserver(updateTarget) : undefined;
    if (options.sendTarget !== undefined) resize?.observe(options.sendTarget);
    ownerWindow.addEventListener("resize", updateTarget);
    ownerDocument.addEventListener("scroll", updateTarget, true);
    ownerWindow.visualViewport?.addEventListener("resize", updateTarget);
    ownerWindow.visualViewport?.addEventListener("scroll", updateTarget);
    return () => {
      resize?.disconnect(); ownerWindow.removeEventListener("resize", updateTarget); ownerDocument.removeEventListener("scroll", updateTarget, true);
      ownerWindow.visualViewport?.removeEventListener("resize", updateTarget); ownerWindow.visualViewport?.removeEventListener("scroll", updateTarget);
    };
  }, [ownerDocument, ownerWindow, options.sendTarget, updateTarget]);
  useEffect(() => {
    if (ownerWindow == null || ownerDocument === undefined) return;
    const ownsTarget = (event: KeyboardEvent): boolean => {
      if (!(event.target instanceof ownerWindow.Element)) return false;
      const modal = event.target.closest('[aria-modal="true"], [data-morph-side], .queue-strip__editor, [role="listbox"]');
      if (modal !== null || selectControlOwnsEscape(event, ownerDocument)) return false;
      return latest.current.root?.contains(event.target) === true;
    };
    const down = (event: KeyboardEvent): void => {
      if (!live() || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || !ownsTarget(event)) return;
      const value = latest.current;
      if (event.key === "Escape" && (value.isActive() || value.phase === "error")) {
        event.preventDefault(); event.stopPropagation(); clearPress(); value.cancel(); return;
      }
      if (value.isActive() && value.canSend && value.isSendKey(event)) {
        event.preventDefault(); event.stopPropagation(); clearPress(); value.onSend(event); return;
      }
      if (value.nativeShortcut || !value.enabled || !matchesVoiceInputShortcut(event, value.shortcut)) return;
      event.preventDefault(); event.stopPropagation();
      if (pressRef.current !== undefined) return;
      if (value.isActive()) { if (value.phase === "starting" || value.phase === "listening") void value.finish(); return; }
      if (!value.start()) return;
      begin({ scope: value.scope, shortcut: value.shortcut, held: false }, 450);
    };
    const up = (event: KeyboardEvent): void => {
      const press = pressRef.current;
      if (!live() || press?.shortcut === undefined || !releasesVoiceInputShortcut(event, press.shortcut)) return;
      event.preventDefault(); event.stopPropagation(); clearPress();
      if (press.held) void latest.current.finish();
    };
    const blur = (): void => {
      const press = clearPress();
      if (press === undefined) return;
      suppressClick();
      if (latest.current.phase === "starting") latest.current.cancel(); else void latest.current.finish();
    };
    const hide = (): void => { clearPress(); pointerAttemptRef.current = undefined; suppressedRef.current = false; };
    ownerWindow.addEventListener("keydown", down, true); ownerWindow.addEventListener("keyup", up, true);
    ownerWindow.addEventListener("blur", blur); ownerWindow.addEventListener("pagehide", hide);
    return () => {
      ownerWindow.removeEventListener("keydown", down, true); ownerWindow.removeEventListener("keyup", up, true);
      ownerWindow.removeEventListener("blur", blur); ownerWindow.removeEventListener("pagehide", hide);
    };
  }, [ownerDocument, ownerWindow, live, clearPress, begin, suppressClick]);
  const abortPointer = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (pressRef.current?.pointer?.id !== event.pointerId) return;
    if (pointerAttemptRef.current === event.pointerId) { pointerAttemptRef.current = undefined; suppressClick(); }
    clearPress(); suppressClick(); latest.current.cancel();
  };
  return { held, sendTargetActive, buttonProps: {
    onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
      const value = latest.current;
      if (event.button !== 0 || !live() || !value.enabled || pressRef.current !== undefined || value.isActive()) return;
      event.preventDefault();
      pointerAttemptRef.current = event.pointerId;
      if (!value.start()) { suppressClick(); return; }
      const press: Press = { scope: value.scope, pointer: { id: event.pointerId, node: event.currentTarget }, held: false, point: { x: event.clientX, y: event.clientY } };
      begin(press, event.pointerType === "touch" ? 320 : 450);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
      const press = pressRef.current;
      if (press?.pointer?.id !== event.pointerId) return;
      press.point = { x: event.clientX, y: event.clientY }; updateTarget();
    },
    onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
      if (pointerAttemptRef.current === event.pointerId) { pointerAttemptRef.current = undefined; suppressClick(); }
      const press = pressRef.current;
      if (press?.pointer?.id !== event.pointerId) return;
      press.point = { x: event.clientX, y: event.clientY };
      const send = press.held && targetAt(press.point);
      clearPress(); suppressClick();
      if (!press.held) return;
      if (send) latest.current.onSend(); else void latest.current.finish();
    },
    onPointerCancel: abortPointer,
    onLostPointerCapture: abortPointer,
    onClick(event: ReactMouseEvent<HTMLButtonElement>) {
      if (event.detail !== 0 && (suppressedRef.current || pointerAttemptRef.current !== undefined)) { suppressedRef.current = false; pointerAttemptRef.current = undefined; return; }
      if (!live() || !latest.current.enabled) return;
      if (latest.current.isActive()) { if (latest.current.phase === "starting" || latest.current.phase === "listening") void latest.current.finish(); }
      else latest.current.start();
    }
  } };
}
