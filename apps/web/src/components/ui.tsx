import type { ButtonHTMLAttributes, HTMLAttributes, JSX, PropsWithChildren, ReactNode, Ref, RefObject } from "react";
import { Children, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import { translate } from "../i18n.js";
import type { Locale } from "../model.js";

export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export const TOOLTIP_DELAY_MS = 500;

export function IconButton({
  label,
  tip,
  disabledReason,
  buttonRef,
  className,
  disabled,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly label: string;
  readonly tip?: string;
  readonly disabledReason?: string;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  const tooltip = useVisibleTooltip(disabled ? disabledReason ?? tip ?? label : tip ?? label);
  const button = <button
    ref={(element) => {
      assignRef(buttonRef, element);
      if (!(disabled && disabledReason !== undefined)) tooltip.anchorRef.current = element;
    }}
    type="button"
    className={cx("icon-button", className)}
    aria-label={label}
    aria-describedby={tooltip.visible ? tooltip.id : undefined}
    disabled={disabled}
    onPointerEnter={(event) => { tooltip.show(); onPointerEnter?.(event); }}
    onPointerLeave={(event) => { tooltip.hide(); onPointerLeave?.(event); }}
    onFocus={(event) => { tooltip.show(); onFocus?.(event); }}
    onBlur={(event) => { tooltip.hide(); onBlur?.(event); }}
    onKeyDown={(event) => { if (event.key === "Escape") tooltip.hide(); onKeyDown?.(event); }}
    {...props}
  />;
  if (disabled && disabledReason !== undefined) return <>
    <span
      ref={tooltip.anchorRef as RefObject<HTMLSpanElement | null>}
      className="tip-anchor tip-anchor--disabled"
      role="group"
      tabIndex={0}
      aria-label={`${label}: ${disabledReason}`}
      aria-describedby={tooltip.visible ? tooltip.id : undefined}
      onPointerEnter={tooltip.show}
      onPointerLeave={tooltip.hide}
      onFocus={tooltip.show}
      onBlur={tooltip.hide}
      onKeyDown={(event) => { if (event.key === "Escape") tooltip.hide(); }}
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

export function Tip({ text, children, side = "top", className, focusable = false, delay = TOOLTIP_DELAY_MS, mono = false, preformatted = false }: PropsWithChildren<{
  readonly text: string | undefined;
  readonly side?: TooltipSide;
  readonly className?: string;
  readonly focusable?: boolean;
  readonly delay?: number;
  readonly mono?: boolean;
  readonly preformatted?: boolean;
}>): JSX.Element {
  const tooltip = useVisibleTooltip(text, side, delay, mono, preformatted);
  return <>
    <span
      ref={tooltip.anchorRef as RefObject<HTMLSpanElement | null>}
      className={cx("tip-anchor", focusable && "tip-anchor--focusable", className)}
      role={focusable ? "group" : undefined}
      tabIndex={focusable && text !== undefined ? 0 : undefined}
      aria-label={focusable ? text : undefined}
      aria-describedby={tooltip.visible ? tooltip.id : undefined}
      onPointerEnter={tooltip.show}
      onPointerLeave={tooltip.hide}
      onFocusCapture={tooltip.show}
      onBlurCapture={tooltip.hide}
      onKeyDownCapture={(event) => { if (event.key === "Escape") tooltip.hide(); }}
    >{children}</span>
    {tooltip.bubble}
  </>;
}

export function TipSummary({ label, tip, summaryRef, children, onPointerEnter, onPointerLeave, onFocus, onBlur, onKeyDown, ...props }: PropsWithChildren<HTMLAttributes<HTMLElement> & {
  readonly label: string;
  readonly tip?: string;
  readonly summaryRef?: Ref<HTMLElement>;
}>): JSX.Element {
  const tooltip = useVisibleTooltip(tip ?? label);
  return <>
    <summary
      ref={(element) => {
        tooltip.anchorRef.current = element;
        assignRef(summaryRef, element);
      }}
      aria-label={label}
      aria-describedby={tooltip.visible ? tooltip.id : undefined}
      onPointerEnter={(event) => { tooltip.show(); onPointerEnter?.(event); }}
      onPointerLeave={(event) => { tooltip.hide(); onPointerLeave?.(event); }}
      onFocus={(event) => { tooltip.show(); onFocus?.(event); }}
      onBlur={(event) => { tooltip.hide(); onBlur?.(event); }}
      onKeyDown={(event) => { if (event.key === "Escape") tooltip.hide(); onKeyDown?.(event); }}
      {...props}
    >{children}</summary>
    {tooltip.bubble}
  </>;
}

type TooltipSide = "top" | "right" | "bottom" | "left";

function useVisibleTooltip(text: string | undefined, side: TooltipSide = "top", delay = TOOLTIP_DELAY_MS, mono = false, preformatted = false): {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly id: string;
  readonly visible: boolean;
  readonly show: () => void;
  readonly hide: () => void;
  readonly bubble: JSX.Element | null;
} {
  const anchorRef = useRef<HTMLElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement>();
  const timerRef = useRef<number | undefined>(undefined);
  const clearTimer = (): void => {
    if (timerRef.current === undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };
  const hide = (): void => {
    clearTimer();
    setVisible(false);
  };
  const show = (): void => {
    if (text === undefined || text.trim().length === 0 || visible || timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      setVisible(true);
    }, delay);
  };
  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (text !== undefined && text.trim().length > 0) return;
    hide();
  }, [text]);
  useLayoutEffect(() => {
    if (!visible) {
      setPlacement(undefined);
      return;
    }
    let frame: number | undefined;
    const update = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const bubbleRect = bubbleRef.current?.getBoundingClientRect();
      const next = resolveTooltipPlacement(
        rect,
        { width: bubbleRect?.width ?? 0, height: bubbleRect?.height ?? 0 },
        side,
        window.innerWidth,
        window.innerHeight
      );
      setPlacement((current) => current !== undefined
        && current.side === next.side
        && Math.abs(current.left - next.left) < .5
        && Math.abs(current.top - next.top) < .5
        ? current
        : next);
    };
    update();
    frame = window.requestAnimationFrame?.(update);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (anchorRef.current !== null) observer?.observe(anchorRef.current);
    if (bubbleRef.current !== null) observer?.observe(bubbleRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame?.(frame);
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [side, visible, text]);
  const bubble = visible && placement !== undefined && typeof document !== "undefined"
    ? createPortal(<span ref={bubbleRef} id={id} className={cx("shared-tooltip", `shared-tooltip--${placement.side}`, mono && "shared-tooltip--mono", preformatted && "shared-tooltip--preformatted")} role="tooltip" style={{ left: placement.left, top: placement.top }}>{text}</span>, document.body)
    : null;
  return { anchorRef, id, visible, show, hide, bubble };
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
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "defaultValue" | "onChange" | "value"> & {
  readonly children: ReactNode;
  readonly value?: string | number;
  readonly required?: boolean;
  readonly onChange?: (event: SelectControlChangeEvent) => void;
}): JSX.Element {
  const options = useMemo(() => collectSelectControlOptions(children), [children]);
  const normalizedValue = value === undefined ? "" : String(value);
  const selectedIndex = options.findIndex((option) => option.value === normalizedValue);
  const selected = options[selectedIndex];
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState<SelectControlPosition>();
  const typeaheadRef = useRef({ text: "", at: 0 });

  const firstEnabled = (): number => options.findIndex((option) => !option.disabled);
  const lastEnabled = (): number => {
    for (let index = options.length - 1; index >= 0; index -= 1) if (!options[index]?.disabled) return index;
    return -1;
  };
  const show = (direction: 1 | -1 = 1): void => {
    if (disabled || options.length === 0) return;
    const fallback = direction === 1 ? firstEnabled() : lastEnabled();
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : fallback);
    setOpen(true);
  };
  const choose = (index: number): void => {
    const option = options[index];
    if (option === undefined || option.disabled) return;
    setOpen(false);
    setActiveIndex(index);
    triggerRef.current?.focus();
    if (option.value === normalizedValue) return;
    onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } });
  };
  const move = (direction: 1 | -1): void => {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let offset = 0; offset < options.length; offset += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };
  const typeahead = (key: string): void => {
    const now = Date.now();
    const previous = now - typeaheadRef.current.at < 700 ? typeaheadRef.current.text : "";
    const text = `${previous}${key}`.toLocaleLowerCase();
    typeaheadRef.current = { text, at: now };
    const start = Math.max(activeIndex, -1);
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (start + offset) % options.length;
      const option = options[index];
      if (option !== undefined && !option.disabled && option.labelText.toLocaleLowerCase().startsWith(text)) {
        setActiveIndex(index);
        if (!open) choose(index);
        return;
      }
    }
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [normalizedValue, open, selectedIndex]);
  useEffect(() => {
    if (!open) return;
    const closeForOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeForOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeForOutsidePointer, true);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const padding = 8;
      const gap = 6;
      const desiredHeight = Math.min(280, Math.max(72, options.length * 36 + 8));
      const below = window.innerHeight - rect.bottom - gap - padding;
      const above = rect.top - gap - padding;
      const placement = below >= Math.min(desiredHeight, 160) || below >= above ? "below" : "above";
      const maxHeight = Math.max(72, Math.min(desiredHeight, placement === "below" ? below : above));
      const width = Math.min(Math.max(rect.width, 176), Math.max(176, window.innerWidth - padding * 2));
      const left = Math.min(Math.max(padding, rect.left), Math.max(padding, window.innerWidth - width - padding));
      const top = placement === "below" ? rect.bottom + gap : Math.max(padding, rect.top - gap - maxHeight);
      setPosition({ left, top, width, maxHeight, placement });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (triggerRef.current !== null) observer?.observe(triggerRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, options.length]);
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId, open]);

  const popup = open && typeof document !== "undefined" ? createPortal(
    <div
      ref={listRef}
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
            onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            {option.value === normalizedValue && <Check aria-hidden="true" />}
          </div>
        </div>
      ))}
    </div>,
    document.body
  ) : null;

  return <>
    <button
      ref={triggerRef}
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
        if (!event.defaultPrevented) open ? setOpen(false) : show();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          open ? move(1) : show(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          open ? move(-1) : show(-1);
        } else if (event.key === "Home" && open) {
          event.preventDefault();
          setActiveIndex(firstEnabled());
        } else if (event.key === "End" && open) {
          event.preventDefault();
          setActiveIndex(lastEnabled());
        } else if ((event.key === "Enter" || event.key === " ") && open) {
          event.preventDefault();
          choose(activeIndex);
        } else if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
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

export function Modal({ open, title, description, children, onClose, closeLabel = currentMessage("common.close"), headerLeading, headerTrailing, size = "medium", className, showClose = false, dismissOnBackdrop = true, dialogRole = "dialog", initialFocus, restoreFocusFallback }: PropsWithChildren<{
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
  readonly restoreFocusFallback?: () => HTMLElement | null;
}>): JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  const restoreFocusFallbackRef = useRef(restoreFocusFallback);
  restoreFocusFallbackRef.current = restoreFocusFallback;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const ownerDocument = dialog?.ownerDocument ?? document;
    const elementConstructor = ownerDocument.defaultView?.HTMLElement;
    restoreFocusRef.current = elementConstructor !== undefined && ownerDocument.activeElement instanceof elementConstructor && ownerDocument.activeElement !== ownerDocument.body
      ? ownerDocument.activeElement
      : null;
    const preferred = initialFocusRef.current?.();
    const active = elementConstructor !== undefined && ownerDocument.activeElement instanceof elementConstructor
      ? ownerDocument.activeElement
      : null;
    const body = dialog?.querySelector<HTMLElement>(".modal__body");
    const destructiveCancel = dialog?.querySelector(".button--danger") === null
      ? null
      : dialog?.querySelector<HTMLElement>(".modal__actions .button:not(.button--danger):not([disabled])");
    const headerBack = dialog?.querySelector<HTMLElement>(".modal__header-leading button:not([disabled])");
    const focusable = preferred !== undefined && preferred !== null && dialog?.contains(preferred) === true
      ? preferred
      : destructiveCancel !== null
        ? destructiveCancel
        : headerBack !== null
          ? headerBack
          : active !== null && dialog?.contains(active) === true && active.matches(FOCUSABLE)
            ? active
            : body?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (focusable ?? dialog)?.focus();
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const elements = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
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
    ownerDocument.body.classList.add("modal-open");
    return () => {
      ownerDocument.removeEventListener("keydown", handleKey);
      ownerDocument.body.classList.remove("modal-open");
      const previous = restoreFocusRef.current;
      const target = previous?.isConnected === true ? previous : restoreFocusFallbackRef.current?.();
      target?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
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
          {showClose && <IconButton label={closeLabel} onClick={onClose}><X aria-hidden="true" /></IconButton>}
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function currentMessage(key: Parameters<typeof translate>[1]): string {
  const lang = typeof document === "undefined" ? "en" : document.documentElement.lang;
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
