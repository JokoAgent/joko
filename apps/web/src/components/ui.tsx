import type { ButtonHTMLAttributes, HTMLAttributes, JSX, PropsWithChildren, ReactNode, Ref } from "react";
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import { translate } from "../i18n.js";
import type { Locale } from "../model.js";

export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export const TOOLTIP_DELAY_MS = 500;
export const TOOLTIP_SKIP_DELAY_MS = 200;

interface TooltipGroup {
  readonly delay: number;
  readonly skipDelay: number;
  readonly warmUntil: WeakMap<Document, number>;
}

const TooltipGroupContext = createContext<TooltipGroup | undefined>(undefined);

export function TooltipProvider({ children, delay = TOOLTIP_DELAY_MS, skipDelay = TOOLTIP_SKIP_DELAY_MS }: PropsWithChildren<{
  readonly delay?: number;
  readonly skipDelay?: number;
}>): JSX.Element {
  const group = useMemo(() => ({ delay, skipDelay, warmUntil: new WeakMap<Document, number>() }), [delay, skipDelay]);
  return <TooltipGroupContext.Provider value={group}>{children}</TooltipGroupContext.Provider>;
}

export function IconButton({
  label,
  tip,
  tooltipOpen,
  disabledReason,
  buttonRef,
  className,
  disabled,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onKeyDown,
  onPointerDown,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly label: string;
  readonly tip?: string;
  readonly tooltipOpen?: boolean;
  readonly disabledReason?: string;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  const tooltip = useVisibleTooltip(disabled ? disabledReason ?? tip ?? label : tip ?? label, { open: tooltipOpen });
  const wrapped = disabled && disabledReason !== undefined;
  const setButton = useCallback((element: HTMLButtonElement | null): void => {
    assignRef(buttonRef, element);
    if (!wrapped) tooltip.setAnchor(element);
  }, [buttonRef, wrapped, tooltip.setAnchor]);
  const button = <button
    ref={setButton}
    type="button"
    className={cx("icon-button", className)}
    aria-label={label}
    aria-describedby={tooltip.visible ? tooltip.id : undefined}
    disabled={disabled}
    onPointerEnter={(event) => { if (event.pointerType !== "touch") tooltip.show("pointer"); onPointerEnter?.(event); }}
    onPointerLeave={(event) => { tooltip.hide(); onPointerLeave?.(event); }}
    onFocus={(event) => { tooltip.show("focus"); onFocus?.(event); }}
    onBlur={(event) => { tooltip.hide(); onBlur?.(event); }}
    onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === "Escape") tooltip.hide(); onKeyDown?.(event); }}
    onPointerDown={(event) => { tooltip.press(); onPointerDown?.(event); }}
    onClick={(event) => { tooltip.hide(); onClick?.(event); }}
    {...props}
  />;
  if (disabled && disabledReason !== undefined) return <>
    <span
      ref={tooltip.setAnchor}
      className="tip-anchor tip-anchor--disabled"
      role="group"
      tabIndex={0}
      aria-label={`${label}: ${disabledReason}`}
      aria-describedby={tooltip.visible ? tooltip.id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") tooltip.show("pointer"); }}
      onPointerLeave={tooltip.hide}
      onFocus={() => tooltip.show("focus")}
      onBlur={tooltip.hide}
      onPointerDown={tooltip.press}
      onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === "Escape") tooltip.hide(); }}
    >{button}</span>
    {tooltip.bubble}
  </>;
  return <>
    {button}
    {tooltip.bubble}
  </>;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref !== undefined && ref !== null) ref.current = value;
}

export function Tip({ text, children, side = "top", className, focusable = false, delay, mono = false, preformatted = false, tooltipOpen }: PropsWithChildren<{
  readonly text: string | undefined;
  readonly side?: TooltipSide;
  readonly className?: string;
  readonly focusable?: boolean;
  readonly delay?: number;
  readonly mono?: boolean;
  readonly preformatted?: boolean;
  readonly tooltipOpen?: boolean;
}>): JSX.Element {
  const tooltip = useVisibleTooltip(text, { side, delay, mono, preformatted, open: tooltipOpen });
  return <>
    <span
      ref={tooltip.setAnchor}
      className={cx("tip-anchor", focusable && "tip-anchor--focusable", className)}
      role={focusable ? "group" : undefined}
      tabIndex={focusable && text !== undefined ? 0 : undefined}
      aria-label={focusable ? text : undefined}
      aria-describedby={tooltip.visible ? tooltip.id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") tooltip.show("pointer"); }}
      onPointerLeave={tooltip.hide}
      onFocusCapture={() => tooltip.show("focus")}
      onBlurCapture={tooltip.hide}
      onPointerDownCapture={tooltip.press}
      onClickCapture={tooltip.hide}
      onKeyDownCapture={(event) => { if (!event.nativeEvent.isComposing && event.key === "Escape") tooltip.hide(); }}
    >{children}</span>
    {tooltip.bubble}
  </>;
}

export function TipSummary({ label, tip, tooltipOpen, summaryRef, children, onPointerEnter, onPointerLeave, onPointerDown, onClick, onFocus, onBlur, onKeyDown, ...props }: PropsWithChildren<HTMLAttributes<HTMLElement> & {
  readonly label: string;
  readonly tip?: string;
  readonly tooltipOpen?: boolean;
  readonly summaryRef?: Ref<HTMLElement>;
}>): JSX.Element {
  const tooltip = useVisibleTooltip(tip ?? label, { open: tooltipOpen });
  const setSummary = useCallback((element: HTMLElement | null): void => {
    tooltip.setAnchor(element);
    assignRef(summaryRef, element);
  }, [summaryRef, tooltip.setAnchor]);
  return <>
    <summary
      ref={setSummary}
      aria-label={label}
      aria-describedby={tooltip.visible ? tooltip.id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") tooltip.show("pointer"); onPointerEnter?.(event); }}
      onPointerLeave={(event) => { tooltip.hide(); onPointerLeave?.(event); }}
      onFocus={(event) => { tooltip.show("focus"); onFocus?.(event); }}
      onBlur={(event) => { tooltip.hide(); onBlur?.(event); }}
      onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === "Escape") tooltip.hide(); onKeyDown?.(event); }}
      onPointerDown={(event) => { tooltip.press(); onPointerDown?.(event); }}
      onClick={(event) => { tooltip.hide(); onClick?.(event); }}
      {...props}
    >{children}</summary>
    {tooltip.bubble}
  </>;
}

type TooltipSide = "top" | "right" | "bottom" | "left";

function useVisibleTooltip(text: string | undefined, { side = "top", delay, mono = false, preformatted = false, open }: {
  readonly side?: TooltipSide;
  readonly delay?: number;
  readonly mono?: boolean;
  readonly preformatted?: boolean;
  readonly open?: boolean;
}): {
  readonly setAnchor: (element: HTMLElement | null) => void;
  readonly id: string;
  readonly visible: boolean;
  readonly show: (reason: "pointer" | "focus") => void;
  readonly hide: () => void;
  readonly press: () => void;
  readonly bubble: JSX.Element | null;
} {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [bubbleNode, setBubbleNode] = useState<HTMLSpanElement | null>(null);
  const suppliedGroup = useContext(TooltipGroupContext);
  const ownGroup = useMemo<TooltipGroup>(() => ({ delay: TOOLTIP_DELAY_MS, skipDelay: TOOLTIP_SKIP_DELAY_MS, warmUntil: new WeakMap() }), []);
  const group = suppliedGroup ?? ownGroup;
  const scope = useMemo(() => anchor === null || anchor.ownerDocument.defaultView === null ? undefined : {
    anchor, document: anchor.ownerDocument, window: anchor.ownerDocument.defaultView, text, group
  }, [anchor, anchor?.ownerDocument, text, group]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const id = useId();
  const [automaticScope, setAutomaticScope] = useState<typeof scope>();
  const [hiddenScope, setHiddenScope] = useState<typeof scope>();
  const [placement, setPlacement] = useState<TooltipPlacement & { maxWidth: number; maxHeight: number }>();
  const timerRef = useRef<{ window: BrowserWindow; id: number | undefined } | undefined>(undefined);
  const controlRef = useRef(open);
  controlRef.current = open;
  const intentRef = useRef<"pointer" | "focus" | undefined>(undefined);
  const automaticVisibleRef = useRef(false);
  const pointerPressRef = useRef<(() => void) | undefined>(undefined);
  const live = (): boolean => scope !== undefined && currentScope.current === scope && scope.anchor.isConnected && scope.anchor.ownerDocument === scope.document && !scope.window.closed;
  const visible = live() && scope !== hiddenScope && text !== undefined && text.trim().length > 0 && (open === true || (open === undefined && automaticScope === scope));
  const clearTimer = (): void => {
    if (timerRef.current === undefined) return;
    if (timerRef.current.id !== undefined) timerRef.current.window.clearTimeout(timerRef.current.id);
    timerRef.current = undefined;
  };
  const hide = (): void => {
    if (automaticVisibleRef.current && scope !== undefined) group.warmUntil.set(scope.document, Date.now() + group.skipDelay);
    automaticVisibleRef.current = false;
    intentRef.current = undefined;
    clearTimer();
    setAutomaticScope(undefined);
  };
  const press = (): void => {
    hide();
    pointerPressRef.current?.();
    if (!live() || scope === undefined) return;
    const release = (): void => {
      scope.document.removeEventListener("pointerup", release, true);
      scope.document.removeEventListener("pointercancel", release, true);
      scope.window.removeEventListener("blur", release);
      if (pointerPressRef.current === release) pointerPressRef.current = undefined;
    };
    pointerPressRef.current = release;
    scope.document.addEventListener("pointerup", release, true);
    scope.document.addEventListener("pointercancel", release, true);
    scope.window.addEventListener("blur", release);
  };
  const show = (reason: "pointer" | "focus"): void => {
    if (reason === "focus" && pointerPressRef.current !== undefined) return;
    if (reason === "focus") clearTimer();
    intentRef.current = reason;
    if (!live() || scope === undefined || open !== undefined || text === undefined || text.trim().length === 0 || visible || timerRef.current !== undefined) return;
    setHiddenScope(undefined);
    const wait = reason === "focus" || (group.warmUntil.get(scope.document) ?? 0) > Date.now() ? 0 : delay ?? group.delay;
    const attempt = { window: scope.window, id: undefined as number | undefined };
    timerRef.current = attempt;
    const reveal = (): void => {
      if (timerRef.current !== attempt) return;
      timerRef.current = undefined;
      if (!live() || controlRef.current !== undefined) return;
      automaticVisibleRef.current = true;
      setAutomaticScope(scope);
    };
    if (wait <= 0) reveal();
    else attempt.id = scope.window.setTimeout(reveal, wait);
  };
  useLayoutEffect(() => {
    intentRef.current = undefined;
    automaticVisibleRef.current = false;
    setAutomaticScope(undefined);
    setHiddenScope(undefined);
    if (scope === undefined) return;
    const onPageHide = (): void => {
      hide();
      pointerPressRef.current?.();
      group.warmUntil.delete(scope.document);
      setHiddenScope(scope);
    };
    scope.window.addEventListener("pagehide", onPageHide);
    return () => {
      clearTimer();
      pointerPressRef.current?.();
      scope.window.removeEventListener("pagehide", onPageHide);
    };
  }, [scope]);
  useLayoutEffect(() => {
    clearTimer();
    automaticVisibleRef.current = false;
    setHiddenScope(undefined);
    setAutomaticScope(undefined);
    if (open === undefined && intentRef.current !== undefined) show(intentRef.current);
  }, [open, delay]);
  useLayoutEffect(() => {
    setPlacement(undefined);
    if (!visible || scope === undefined || bubbleNode === null) return;
    const update = (): void => {
      if (!live()) return;
      const viewport = surfaceViewport(scope.window);
      const maxWidth = Math.max(0, Math.min(420, viewport.width - 24));
      const maxHeight = Math.max(0, viewport.height - 16);
      bubbleNode.style.maxWidth = `${maxWidth}px`;
      bubbleNode.style.maxHeight = `${maxHeight}px`;
      const rect = scope.anchor.getBoundingClientRect();
      const local = { left: rect.left - viewport.left, right: rect.right - viewport.left, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top, width: rect.width, height: rect.height };
      const measured = bubbleNode.getBoundingClientRect();
      const point = resolveTooltipPlacement(local, measured, side, viewport.width, viewport.height);
      const next = { ...point, left: point.left + viewport.left, top: point.top + viewport.top, maxWidth, maxHeight };
      setPlacement((current) => current !== undefined
        && current.side === next.side
        && current.maxWidth === maxWidth && current.maxHeight === maxHeight
        && Math.abs(current.left - next.left) < .5
        && Math.abs(current.top - next.top) < .5
        ? current
        : next);
    };
    return observeSurface(scope.anchor, bubbleNode, update);
  }, [side, visible, scope, bubbleNode]);
  const bubble = visible && scope !== undefined
    ? createPortal(<span ref={setBubbleNode} id={id} className={cx("shared-tooltip", `shared-tooltip--${placement?.side ?? side}`, mono && "shared-tooltip--mono", preformatted && "shared-tooltip--preformatted")} role="tooltip" style={{ visibility: placement === undefined ? "hidden" : undefined, left: placement?.left, top: placement?.top, maxWidth: placement?.maxWidth, maxHeight: placement?.maxHeight, overflow: "hidden" }}>{text}</span>, scope.document.body)
    : null;
  return { setAnchor, id, visible, show, hide, press, bubble };
}

type BrowserWindow = NonNullable<Document["defaultView"]>;

function surfaceViewport(ownerWindow: BrowserWindow): { left: number; top: number; width: number; height: number } {
  const viewport = ownerWindow.visualViewport;
  return viewport === null || viewport === undefined
    ? { left: 0, top: 0, width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
    : { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height };
}

function observeSurface(anchor: HTMLElement, surface: HTMLElement, update: () => void): () => void {
  const ownerWindow = anchor.ownerDocument.defaultView;
  if (ownerWindow === null) return () => undefined;
  let alive = true;
  let frame: number | undefined;
  const schedule = (): void => {
    if (!alive || frame !== undefined) return;
    if (ownerWindow.requestAnimationFrame === undefined) { update(); return; }
    frame = ownerWindow.requestAnimationFrame(() => { frame = undefined; if (alive) update(); });
  };
  update();
  const observer = ownerWindow.ResizeObserver === undefined ? undefined : new ownerWindow.ResizeObserver(schedule);
  observer?.observe(anchor);
  observer?.observe(surface);
  ownerWindow.addEventListener("resize", schedule);
  ownerWindow.addEventListener("scroll", schedule, true);
  const viewport = ownerWindow.visualViewport;
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  return () => {
    alive = false;
    if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame);
    observer?.disconnect();
    ownerWindow.removeEventListener("resize", schedule);
    ownerWindow.removeEventListener("scroll", schedule, true);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
  };
}

interface TooltipPlacement {
  readonly side: TooltipSide;
  readonly left: number;
  readonly top: number;
}

export function resolveTooltipPlacement(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">,
  bubble: { readonly width: number; readonly height: number },
  requestedSide: TooltipSide,
  viewportWidth: number,
  viewportHeight: number,
  padding = 8,
  gap = 7
): TooltipPlacement {
  const available = {
    top: anchor.top - padding,
    right: viewportWidth - anchor.right - padding,
    bottom: viewportHeight - anchor.bottom - padding,
    left: anchor.left - padding
  };
  const opposite: Record<TooltipSide, TooltipSide> = { top: "bottom", right: "left", bottom: "top", left: "right" };
  const primarySize = requestedSide === "top" || requestedSide === "bottom" ? bubble.height : bubble.width;
  const alternate = opposite[requestedSide];
  const side = available[requestedSide] < primarySize + gap && available[alternate] > available[requestedSide]
    ? alternate
    : requestedSide;
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  if (side === "top") return {
    side,
    left: clampTooltipCoordinate(centerX, padding + bubble.width / 2, viewportWidth - padding - bubble.width / 2),
    top: clampTooltipCoordinate(anchor.top - gap, padding + bubble.height, viewportHeight - padding)
  };
  if (side === "bottom") return {
    side,
    left: clampTooltipCoordinate(centerX, padding + bubble.width / 2, viewportWidth - padding - bubble.width / 2),
    top: clampTooltipCoordinate(anchor.bottom + gap, padding, viewportHeight - padding - bubble.height)
  };
  if (side === "left") return {
    side,
    left: clampTooltipCoordinate(anchor.left - gap, padding + bubble.width, viewportWidth - padding),
    top: clampTooltipCoordinate(centerY, padding + bubble.height / 2, viewportHeight - padding - bubble.height / 2)
  };
  return {
    side,
    left: clampTooltipCoordinate(anchor.right + gap, padding, viewportWidth - padding - bubble.width),
    top: clampTooltipCoordinate(centerY, padding + bubble.height / 2, viewportHeight - padding - bubble.height / 2)
  };
}

function clampTooltipCoordinate(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return (minimum + maximum) / 2;
  return Math.min(Math.max(value, minimum), maximum);
}

export function Button({ tone = "secondary", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: "primary" | "secondary" | "ghost" | "danger" }): JSX.Element {
  return <button type="button" className={cx("button", `button--${tone}`, className)} {...props} />;
}

export function ModalBackButton({ label, controlRef, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string; readonly controlRef?: Ref<HTMLButtonElement> }): JSX.Element {
  return <button ref={controlRef} type="button" className={cx("modal-back-button", className)} aria-label={label} {...props}><ArrowLeft aria-hidden="true" /></button>;
}

export interface SelectControlChangeEvent {
  readonly target: { readonly value: string };
  readonly currentTarget: { readonly value: string };
}

interface SelectControlOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly labelText: string;
  readonly disabled: boolean;
  readonly group?: string;
}

interface SelectControlPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly placement: "above" | "below";
}

export function SelectControl({
  children,
  value,
  onChange,
  className,
  disabled = false,
  required = false,
  name,
  form,
  onClick,
  onKeyDown,
  onBlur,
  openRequestId,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "defaultValue" | "onChange" | "value"> & {
  readonly children: ReactNode;
  readonly value?: string | number;
  readonly required?: boolean;
  readonly onChange?: (event: SelectControlChangeEvent) => void;
  readonly openRequestId?: number;
}): JSX.Element {
  const options = useMemo(() => collectSelectControlOptions(children), [children]);
  const normalizedValue = value === undefined ? "" : String(value);
  const selectedIndex = options.findIndex((option) => option.value === normalizedValue);
  const selected = options[selectedIndex];
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const scope = useMemo(() => trigger === null || trigger.ownerDocument.defaultView === null ? undefined : {
    trigger, document: trigger.ownerDocument, window: trigger.ownerDocument.defaultView
  }, [trigger, trigger?.ownerDocument]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const listboxId = useId();
  const [openScope, setOpenScope] = useState<typeof scope>();
  const open = scope !== undefined && openScope === scope && !disabled && options.some((option) => !option.disabled);
  const [activeValue, setActiveValue] = useState<string | undefined>(selected?.value);
  const activeIndex = options.findIndex((option) => option.value === activeValue && !option.disabled);
  const [position, setPosition] = useState<SelectControlPosition>();
  const typeaheadRef = useRef({ text: "", at: 0 });
  const live = (): boolean => scope !== undefined && scopeRef.current === scope && scope.trigger.isConnected && scope.trigger.ownerDocument === scope.document && !scope.window.closed;
  const close = (): void => setOpenScope(undefined);

  const firstEnabled = (): number => options.findIndex((option) => !option.disabled);
  const lastEnabled = (): number => {
    for (let index = options.length - 1; index >= 0; index -= 1) if (!options[index]?.disabled) return index;
    return -1;
  };
  const show = (direction: 1 | -1 = 1): void => {
    if (disabled || !live() || firstEnabled() < 0) return;
    const fallback = direction === 1 ? firstEnabled() : lastEnabled();
    setActiveValue(options[selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : fallback]?.value);
    setOpenScope(scope);
  };
  const consumedOpenRequestRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (openRequestId === undefined || consumedOpenRequestRef.current === openRequestId
      || scope === undefined || disabled || firstEnabled() < 0 || !live()) return;
    consumedOpenRequestRef.current = openRequestId;
    show();
  }, [openRequestId, scope, disabled, options]);
  const choose = (index: number): void => {
    const option = options[index];
    if (!live() || disabled || option === undefined || option.disabled) return;
    close();
    setActiveValue(option.value);
    scope?.trigger.focus({ preventScroll: true });
    if (option.value === normalizedValue) return;
    onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } });
  };
  const move = (direction: 1 | -1): void => {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let offset = 0; offset < options.length; offset += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) {
        setActiveValue(options[next]?.value);
        return;
      }
    }
  };
  const typeahead = (key: string): void => {
    const now = Date.now();
    const previous = now - typeaheadRef.current.at < 700 ? typeaheadRef.current.text : "";
    const sequence = `${previous}${key}`.toLocaleLowerCase();
    const text = [...sequence].every((character) => character === sequence[0]) ? sequence[0] ?? "" : sequence;
    typeaheadRef.current = { text: sequence, at: now };
    const start = Math.max(activeIndex, -1);
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (start + offset) % options.length;
      const option = options[index];
      if (option !== undefined && !option.disabled && option.labelText.toLocaleLowerCase().startsWith(text)) {
        setActiveValue(option.value);
        if (!open) choose(index);
        return;
      }
    }
  };

  useLayoutEffect(() => {
    typeaheadRef.current = { text: "", at: 0 };
    close();
    if (scope === undefined) return;
    scope.window.addEventListener("pagehide", close);
    return () => scope.window.removeEventListener("pagehide", close);
  }, [scope]);
  useLayoutEffect(() => {
    if (!open) {
      setActiveValue(selected?.disabled ? undefined : selected?.value);
      if (disabled || firstEnabled() < 0) close();
    } else if (activeIndex < 0) {
      setActiveValue(selected !== undefined && !selected.disabled ? selected.value : options[firstEnabled()]?.value);
    }
  }, [normalizedValue, open, disabled, activeIndex, options]);
  useEffect(() => {
    if (!open || scope === undefined) return;
    const closeForOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof scope.window.Node) || scope.trigger.contains(target) || list?.contains(target)) return;
      close();
    };
    const closeForOutsideFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof scope.window.Node && !scope.trigger.contains(target) && !list?.contains(target)) close();
    };
    scope.document.addEventListener("pointerdown", closeForOutsidePointer, true);
    scope.document.addEventListener("focusin", closeForOutsideFocus, true);
    return () => {
      scope.document.removeEventListener("pointerdown", closeForOutsidePointer, true);
      scope.document.removeEventListener("focusin", closeForOutsideFocus, true);
    };
  }, [open, scope, list]);
  useLayoutEffect(() => {
    setPosition(undefined);
    if (!open) {
      return;
    }
    if (scope === undefined || list === null) return;
    const update = (): void => {
      if (!live()) return;
      const rect = scope.trigger.getBoundingClientRect();
      const viewport = surfaceViewport(scope.window);
      const padding = 8;
      const gap = 6;
      const desiredHeight = Math.min(280, Math.max(72, options.length * 36 + 8));
      const below = viewport.top + viewport.height - rect.bottom - gap - padding;
      const above = rect.top - viewport.top - gap - padding;
      const placement = below >= Math.min(desiredHeight, 160) || below >= above ? "below" : "above";
      const maxHeight = Math.max(0, Math.min(desiredHeight, viewport.height - padding * 2, placement === "below" ? below : above));
      const width = Math.max(0, Math.min(Math.max(rect.width, 176), viewport.width - padding * 2));
      const left = viewport.left + Math.min(Math.max(padding, rect.left - viewport.left), Math.max(padding, viewport.width - width - padding));
      const wantedTop = placement === "below" ? rect.bottom + gap : rect.top - gap - maxHeight;
      const top = Math.max(viewport.top + padding, Math.min(wantedTop, viewport.top + viewport.height - padding - maxHeight));
      setPosition((current) => current?.left === left && current.top === top && current.width === width && current.maxHeight === maxHeight && current.placement === placement
        ? current : { left, top, width, maxHeight, placement });
    };
    return observeSurface(scope.trigger, list, update);
  }, [open, options.length, scope, list]);
  useEffect(() => {
    if (!open || activeIndex < 0 || list === null) return;
    const option = list.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex];
    if (option === undefined) return;
    const bounds = option.getBoundingClientRect();
    const container = list.getBoundingClientRect();
    if (bounds.top < container.top) list.scrollTop += bounds.top - container.top;
    else if (bounds.bottom > container.bottom) list.scrollTop += bounds.bottom - container.bottom;
  }, [activeIndex, list, open]);

  const popup = open && scope !== undefined ? createPortal(
    <div
      ref={setList}
      id={listboxId}
      className={cx("select-control__listbox", position?.placement === "above" && "select-control__listbox--above")}
      role="listbox"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      style={position === undefined ? { visibility: "hidden" } : { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
    >
      {options.map((option, index) => (
        <div role="presentation" key={`${option.group ?? ""}:${option.value}:${index}`}>
          {option.group !== undefined && option.group !== options[index - 1]?.group && <div className="select-control__group" role="presentation">{option.group}</div>}
          <div
            id={`${listboxId}-option-${index}`}
            className={cx("select-control__option", index === activeIndex && "is-active", option.value === normalizedValue && "is-selected")}
            role="option"
            aria-selected={option.value === normalizedValue}
            aria-disabled={option.disabled || undefined}
            onPointerMove={() => { if (!option.disabled) setActiveValue(option.value); }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            {option.value === normalizedValue && <Check aria-hidden="true" />}
          </div>
        </div>
      ))}
    </div>,
    scope.document.body
  ) : null;

  return <>
    <button
      ref={setTrigger}
      data-select-control="true"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-required={required || undefined}
      className={cx("select-control", className)}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) open ? close() : show();
      }}
      onBlur={(event) => { if (!list?.contains(event.relatedTarget as Node | null)) close(); onBlur?.(event); }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          open ? move(1) : show(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          open ? move(-1) : show(-1);
        } else if (event.key === "Home" && open) {
          event.preventDefault();
          setActiveValue(options[firstEnabled()]?.value);
        } else if (event.key === "End" && open) {
          event.preventDefault();
          setActiveValue(options[lastEnabled()]?.value);
        } else if ((event.key === "Enter" || event.key === " ") && open) {
          event.preventDefault();
          choose(activeIndex);
        } else if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === "Tab" && open) {
          close();
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          typeahead(event.key);
        }
      }}
      {...props}
    >
      <span className={cx("select-control__value", selected === undefined && "is-placeholder")}>{selected?.label ?? ""}</span>
      <ChevronDown aria-hidden="true" />
    </button>
    <select
      className="select-control__native-bridge"
      aria-hidden="true"
      tabIndex={-1}
      value={normalizedValue}
      disabled={disabled}
      required={required}
      name={name}
      form={form}
      onChange={(event) => onChange?.({ target: { value: event.currentTarget.value }, currentTarget: { value: event.currentTarget.value } })}
    >{children}</select>
    {popup}
  </>;
}

/** Capture-phase dialog handlers defer to their focused child select. */
export function selectControlOwnsEscape(event: KeyboardEvent, ownerDocument: Document): boolean {
  if (event.key !== "Escape") return false;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) return false;
  const target = event.target instanceof ownerWindow.Element ? event.target : ownerDocument.activeElement;
  const trigger = target?.closest<HTMLElement>('[data-select-control="true"][aria-expanded="true"]');
  if (trigger?.ownerDocument !== ownerDocument) return false;
  const controls = trigger.getAttribute("aria-controls");
  const popup = controls === null ? null : ownerDocument.getElementById(controls);
  return popup?.isConnected === true && popup.getAttribute("role") === "listbox";
}

function collectSelectControlOptions(children: ReactNode, group?: string, inheritedDisabled = false): SelectControlOption[] {
  const options: SelectControlOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || typeof child.type !== "string") return;
    const props = child.props as { readonly children?: ReactNode; readonly value?: string | number; readonly label?: ReactNode; readonly disabled?: boolean };
    if (child.type === "optgroup") {
      const nextGroup = reactNodeText(props.label);
      options.push(...collectSelectControlOptions(props.children, nextGroup, inheritedDisabled || props.disabled === true));
      return;
    }
    if (child.type !== "option") return;
    const label = props.children ?? props.label ?? "";
    options.push({
      value: props.value === undefined ? reactNodeText(label) : String(props.value),
      label,
      labelText: reactNodeText(label),
      disabled: inheritedDisabled || props.disabled === true,
      group
    });
  });
  return options;
}

function reactNodeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(reactNodeText).join("");
  if (isValidElement(value)) return reactNodeText((value.props as { readonly children?: ReactNode }).children);
  return "";
}

export interface ChoiceControlChangeEvent {
  readonly target: { readonly checked: boolean; readonly value: string };
  readonly currentTarget: { readonly checked: boolean; readonly value: string };
}

type ChoiceControlProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onChange" | "type"> & {
  readonly checked: boolean;
  readonly controlRef?: Ref<HTMLButtonElement>;
  readonly indeterminate?: boolean;
  readonly onChange?: (event: ChoiceControlChangeEvent) => void;
  readonly readOnly?: boolean;
};

export function CheckboxControl(props: ChoiceControlProps): JSX.Element {
  return <ChoiceControl kind="checkbox" {...props} />;
}

export function RadioControl(props: ChoiceControlProps): JSX.Element {
  return <ChoiceControl kind="radio" {...props} />;
}

export function SwitchControl(props: ChoiceControlProps): JSX.Element {
  return <ChoiceControl kind="switch" {...props} />;
}

function ChoiceControl({ kind, checked, indeterminate = false, controlRef, onChange, className, disabled = false, readOnly = false, name, value, form, onClick, ...props }: ChoiceControlProps & { readonly kind: "checkbox" | "radio" | "switch" }): JSX.Element {
  const normalizedValue = value === undefined || Array.isArray(value) ? "on" : String(value);
  const emit = (next: boolean): void => onChange?.({ target: { checked: next, value: normalizedValue }, currentTarget: { checked: next, value: normalizedValue } });
  return <>
    <button
      ref={controlRef}
      type="button"
      role={kind}
      aria-checked={indeterminate ? "mixed" : checked}
      className={cx(kind === "switch" ? "switch" : "choice-control", kind !== "switch" && `choice-control--${kind}`, className)}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || readOnly || (kind === "radio" && checked)) return;
        emit(kind === "radio" ? true : !checked);
      }}
      {...props}
    >
      {kind === "checkbox" ? indeterminate ? <span className="choice-control__mixed" aria-hidden="true" /> : <Check aria-hidden="true" /> : kind === "radio" ? <span aria-hidden="true" /> : null}
    </button>
    <input
      className="choice-control__native-bridge"
      type={kind === "radio" ? "radio" : "checkbox"}
      aria-hidden="true"
      tabIndex={-1}
      checked={checked}
      disabled={disabled}
      readOnly={readOnly}
      name={name}
      value={normalizedValue}
      form={form}
      onChange={(event) => emit(event.currentTarget.checked)}
    />
  </>;
}

export function Spinner({ label = currentMessage("common.loading") }: { readonly label?: string }): JSX.Element {
  return <span className="spinner" role="status" aria-label={label}><LoaderCircle aria-hidden="true" /></span>;
}

export function AuthenticatedImage({ blobId, alt, getUrl, className, unavailableLabel = currentMessage("browser.screenshotUnavailable"), loadingLabel = currentMessage("browser.loadingScreenshot") }: {
  readonly blobId: string;
  readonly alt: string;
  readonly getUrl: (blobId: string) => Promise<string>;
  readonly className?: string;
  readonly unavailableLabel?: string;
  readonly loadingLabel?: string;
}): JSX.Element {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const getUrlRef = useRef(getUrl);
  getUrlRef.current = getUrl;
  useEffect(() => {
    let current = true;
    setUrl(undefined);
    setFailed(false);
    void getUrlRef.current(blobId).then((next) => {
      if (current) setUrl(next);
    }).catch(() => {
      if (current) setFailed(true);
    });
    return () => { current = false; };
  }, [blobId]);
  if (failed) return <span className="authenticated-image-state" role="alert">{unavailableLabel}</span>;
  if (url === undefined) return <span className="authenticated-image-state" role="status"><Spinner label={loadingLabel} /></span>;
  return <img className={className} src={url} alt={alt} />;
}

export function StatusDot({ state, label }: { readonly state: string; readonly label: string }): JSX.Element {
  return <span className={cx("status-dot", `status-dot--${statusTone(state)}`)} role="img" aria-label={label} title={label} />;
}

function statusTone(state: string): string {
  if (["healthy", "ready", "connected", "idle", "completed", "succeeded", "loaded"].includes(state)) return "success";
  if (["running", "starting", "connecting", "retrying", "recovering", "dispatching"].includes(state)) return "active";
  if (["waiting", "degraded", "offline", "accepted", "awaitingApproval"].includes(state)) return "warning";
  if (["error", "failed", "fatal", "unavailable", "disconnected", "crashed"].includes(state)) return "danger";
  return "muted";
}

export function Pill({ children, tone = "neutral", className, ...props }: PropsWithChildren<HTMLAttributes<HTMLSpanElement> & { readonly tone?: "neutral" | "success" | "warning" | "danger" | "accent" }>): JSX.Element {
  return <span className={cx("pill", `pill--${tone}`, className)} {...props}>{children}</span>;
}

export function EmptyState({ icon, title, body, action }: { readonly icon?: ReactNode; readonly title: string; readonly body: string; readonly action?: ReactNode }): JSX.Element {
  const titleId = useId();
  return (
    <section className="empty-state" aria-labelledby={titleId}>
      {icon !== undefined && <div className="empty-state__icon" aria-hidden="true">{icon}</div>}
      <h2 id={titleId}>{title}</h2>
      <p>{body}</p>
      {action !== undefined && <div className="empty-state__action">{action}</div>}
    </section>
  );
}

export function ErrorBanner({ message, onRetry, onClose, retryLabel = currentMessage("common.retry"), dismissLabel = currentMessage("common.dismiss") }: { readonly message: string; readonly onRetry?: () => void; readonly onClose?: () => void; readonly retryLabel?: string; readonly dismissLabel?: string }): JSX.Element {
  return (
    <div className="error-banner" role="alert">
      <AlertTriangle aria-hidden="true" />
      <span>{message}</span>
      {onRetry !== undefined && <Button tone="ghost" onClick={onRetry}>{retryLabel}</Button>}
      {onClose !== undefined && <IconButton label={dismissLabel} onClick={onClose}><X aria-hidden="true" /></IconButton>}
    </div>
  );
}

export function Modal({ open, title, description, children, onClose, closeLabel, headerLeading, headerTrailing, size = "medium", className, showClose = false, dismissOnBackdrop = true, dialogRole = "dialog", initialFocus, restoreFocus = true, restoreFocusFallback, ownerDocument: portalDocument }: PropsWithChildren<{
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly closeLabel?: string;
  readonly headerLeading?: ReactNode;
  readonly headerTrailing?: ReactNode;
  readonly size?: "small" | "medium" | "large";
  readonly className?: string;
  readonly showClose?: boolean;
  readonly dismissOnBackdrop?: boolean;
  readonly dialogRole?: "dialog" | "alertdialog";
  readonly initialFocus?: () => HTMLElement | null;
  readonly restoreFocus?: boolean;
  readonly restoreFocusFallback?: () => HTMLElement | null;
  readonly ownerDocument?: Document;
}>): JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
  const renderOwnerRef = useRef(portalDocument);
  renderOwnerRef.current = portalDocument;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  const restoreFocusFallbackRef = useRef(restoreFocusFallback);
  restoreFocusFallbackRef.current = restoreFocusFallback;
  const restoreFocusRef = useRef(restoreFocus);
  restoreFocusRef.current = restoreFocus;

  useLayoutEffect(() => {
    if (!open || dialog === null || (portalDocument !== undefined && dialog.ownerDocument !== portalDocument)) return;
    const ownerDocument = dialog.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const elementConstructor = ownerWindow.HTMLElement;
    const previousFocus = ownerDocument.activeElement instanceof elementConstructor && ownerDocument.activeElement !== ownerDocument.body
      ? ownerDocument.activeElement
      : null;
    const fallback = restoreFocusFallbackRef.current;
    let pageHidden = false;
    const onPageHide = (): void => { pageHidden = true; };
    const onPageShow = (): void => { pageHidden = false; };
    const preferred = initialFocusRef.current?.();
    const active = elementConstructor !== undefined && ownerDocument.activeElement instanceof elementConstructor
      ? ownerDocument.activeElement
      : null;
    const body = dialog?.querySelector<HTMLElement>(".modal__body");
    const destructiveCancel = dialog?.querySelector(".button--danger") === null
      ? null
      : dialog?.querySelector<HTMLElement>(".modal__actions .button:not(.button--danger):not([disabled])");
    const headerBack = dialog?.querySelector<HTMLElement>(".modal__header-leading button:not([disabled])");
    const eligible = (element: HTMLElement): boolean => !element.matches(":disabled") && element.tabIndex !== -1;
    const firstFocusable = (root: HTMLElement | null | undefined): HTMLElement | undefined =>
      [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(eligible);
    const focusable = preferred !== undefined && preferred !== null && dialog?.contains(preferred) === true && eligible(preferred)
      ? preferred
      : destructiveCancel !== null
        ? destructiveCancel
        : headerBack !== null
          ? headerBack
          : active !== null && dialog?.contains(active) === true && active.matches(FOCUSABLE) && eligible(active)
            ? active
            : firstFocusable(body) ?? firstFocusable(dialog);
    (focusable ?? dialog)?.focus();
    const handleKey = (event: KeyboardEvent): void => {
      if (pageHidden || event.defaultPrevented || event.isComposing || !modalOwnsKeyboardEvent(event, dialog) || selectControlOwnsEscape(event, ownerDocument)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const elements = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(eligible);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && ownerDocument.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && ownerDocument.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    ownerDocument.addEventListener("keydown", handleKey);
    ownerWindow.addEventListener("pagehide", onPageHide);
    ownerWindow.addEventListener("pageshow", onPageShow);
    const releaseLock = acquireModalLock(ownerDocument, dialog);
    return () => {
      ownerDocument.removeEventListener("keydown", handleKey);
      ownerWindow.removeEventListener("pagehide", onPageHide);
      ownerWindow.removeEventListener("pageshow", onPageShow);
      releaseLock();
      if (!restoreFocusRef.current || pageHidden || ownerWindow.closed || renderOwnerRef.current !== portalDocument) return;
      const activeElement = ownerDocument.activeElement;
      if (activeElement !== ownerDocument.body && activeElement !== null && !dialog.contains(activeElement)) return;
      const target = previousFocus?.isConnected === true ? previousFocus : fallback?.();
      if (target?.isConnected === true && target.ownerDocument === ownerDocument) target.focus({ preventScroll: true });
    };
  }, [open, dialog, portalDocument]);

  if (!open) return null;
  const content = (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}>
      <div
        ref={setDialog}
        className={cx("modal", `modal--${size}`, className)}
        role={dialogRole}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
      >
        <header className={cx("modal__header", headerLeading !== undefined && "modal__header--with-leading")}>
          {headerLeading !== undefined && <div className="modal__header-leading">{headerLeading}</div>}
          <div className="modal__header-copy">
            <h2 id={titleId}>{title}</h2>
            {description !== undefined && <p id={descriptionId}>{description}</p>}
          </div>
          {headerTrailing !== undefined && <div className="modal__header-trailing">{headerTrailing}</div>}
          {showClose && <IconButton label={closeLabel ?? currentMessage("common.close", portalDocument ?? dialog?.ownerDocument)} onClick={onClose}><X aria-hidden="true" /></IconButton>}
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
  return portalDocument === undefined ? content : createPortal(content, portalDocument.body);
}

const modalLocks = new WeakMap<Document, { readonly dialog: HTMLElement }[]>();

export function acquireModalLock(ownerDocument: Document, dialog: HTMLElement): () => void {
  const locks = modalLocks.get(ownerDocument) ?? [];
  const lock = { dialog };
  locks.push(lock);
  modalLocks.set(ownerDocument, locks);
  ownerDocument.body.classList.add("modal-open");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = locks.indexOf(lock);
    if (index >= 0) locks.splice(index, 1);
    if (locks.length > 0) return;
    modalLocks.delete(ownerDocument);
    const anotherModal = [...ownerDocument.querySelectorAll('[aria-modal="true"]')].some((element) => element !== dialog);
    if (!anotherModal) ownerDocument.body.classList.remove("modal-open");
  };
}

export function modalOwnsKeyboardEvent(event: KeyboardEvent, dialog: HTMLElement): boolean {
  const ownerDocument = dialog.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null || !dialog.isConnected) return false;
  const eventOwner = event.target instanceof ownerWindow.Element ? event.target.closest('[aria-modal="true"]') : null;
  const activeOwner = ownerDocument.activeElement?.closest('[aria-modal="true"]');
  const owner = eventOwner ?? activeOwner;
  if (owner !== null && owner !== undefined) return owner === dialog;
  const top = modalLocks.get(ownerDocument)?.filter((entry) => entry.dialog.isConnected).at(-1)?.dialog;
  const surfaces = ownerDocument.querySelectorAll('[aria-modal="true"]');
  return (top ?? surfaces.item(surfaces.length - 1)) === dialog;
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function currentMessage(key: Parameters<typeof translate>[1], ownerDocument?: Document): string {
  const lang = ownerDocument?.documentElement.lang ?? (typeof document === "undefined" ? "en" : document.documentElement.lang);
  const locale: Locale = lang === "zh-CN" || lang === "en-XA" ? lang : "en";
  return translate(locale, key);
}

export function SegmentedControl<T extends string>({ label, value, options, onChange }: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string; readonly disabled?: boolean }[];
  readonly onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={cx("segmented__item", value === option.value && "is-active")}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          key={option.value}
        >{option.label}</button>
      ))}
    </div>
  );
}

export function formatRelativeTime(timestamp: number, locale: string): string {
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale === "en-XA" ? "en" : locale, { numeric: "auto" });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second");
  const minutes = Math.round(deltaSeconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function formatDateTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en-XA" ? "en" : locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
