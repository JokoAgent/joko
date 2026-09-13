import { Check, ChevronDown, Hand, ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";

import type { PermissionMode } from "../model.js";
import { MorphPopover } from "./MorphPopover.js";
import type { Translator } from "./types.js";
import { Tip, cx } from "./ui.js";

export function PermissionSelector({
  value,
  modes,
  onChange,
  t,
  disabled = false,
  disabledReason,
  className,
  side = "top"
}: {
  readonly value: PermissionMode;
  readonly modes: readonly PermissionMode[];
  readonly onChange: (mode: PermissionMode) => void;
  readonly t: Translator;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly className?: string;
  readonly side?: "top" | "bottom";
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [focusedMode, setFocusedMode] = useState<PermissionMode>(value);
  const optionRefs = useRef(new Map<PermissionMode, HTMLButtonElement>());
  const selected = modes.includes(value) ? value : modes[0] ?? value;
  const SelectedIcon = permissionIcon(selected);

  useEffect(() => {
    if (!open) return;
    setFocusedMode(selected);
  }, [open, selected]);
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const focusMode = (mode: PermissionMode): void => {
    setFocusedMode(mode);
    window.requestAnimationFrame(() => optionRefs.current.get(mode)?.focus({ preventScroll: true }));
  };
  const handleListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || modes.length === 0) return;
    const currentIndex = Math.max(0, modes.indexOf(focusedMode));
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % modes.length;
    else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + modes.length) % modes.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = modes.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = modes[nextIndex];
    if (next !== undefined) focusMode(next);
  };

  const triggerLabel = permissionLabel(selected, t);
  const triggerHelp = disabled ? disabledReason ?? permissionHelp(selected, t) : permissionHelp(selected, t);
  const trigger = <Tip text={triggerHelp} focusable={disabled}>
    <button
      type="button"
      className={cx("permission-selector__trigger", selected === "auto" && "is-auto", selected === "bypassPermissions" && "is-danger")}
      disabled={disabled || modes.length === 0}
      aria-label={`${t("controls.permission")}: ${triggerLabel}`}
      aria-haspopup="listbox"
      aria-expanded={open && !disabled}
      onClick={() => setOpen((current) => !current)}
    >
      <SelectedIcon aria-hidden="true" />
      <span>{triggerLabel}</span>
      <ChevronDown aria-hidden="true" />
    </button>
  </Tip>;

  return <MorphPopover
    open={open && !disabled}
    onOpenChange={setOpen}
    label={t("controls.permission")}
    trigger={trigger}
    panelWidth={300}
    side={side}
    align="end"
    className={cx("permission-selector", className)}
    panelClassName="permission-selector__panel"
    initialFocus={() => optionRefs.current.get(selected) ?? null}
  >
    <div className="permission-selector__list" role="listbox" aria-label={t("controls.permission")} onKeyDown={handleListKey}>
      {modes.map((mode) => {
        const Icon = permissionIcon(mode);
        const active = mode === selected;
        return <button
          ref={(element) => { if (element === null) optionRefs.current.delete(mode); else optionRefs.current.set(mode, element); }}
          type="button"
          role="option"
          aria-selected={active}
          data-morph-autofocus={active ? "" : undefined}
          tabIndex={focusedMode === mode ? 0 : -1}
          className={cx(mode === "auto" && "is-auto", mode === "bypassPermissions" && "is-danger", active && "is-selected")}
          key={mode}
          onFocus={() => setFocusedMode(mode)}
          onClick={() => { onChange(mode); setOpen(false); }}
        >
          <Icon aria-hidden="true" />
          <span><strong>{permissionLabel(mode, t)}</strong><small>{permissionHelp(mode, t)}</small></span>
          {active && <Check aria-hidden="true" />}
        </button>;
      })}
    </div>
  </MorphPopover>;
}

export function permissionLabel(mode: PermissionMode, t: Translator): string {
  if (mode === "auto") return t("permission.auto");
  if (mode === "bypassPermissions") return t("permission.full");
  return t("permission.ask");
}

function permissionHelp(mode: PermissionMode, t: Translator): string {
  if (mode === "auto") return t("permission.autoHelp");
  if (mode === "bypassPermissions") return t("permission.fullHelp");
  return t("permission.askHelp");
}

function permissionIcon(mode: PermissionMode): LucideIcon {
  if (mode === "auto") return ShieldCheck;
  if (mode === "bypassPermissions") return ShieldAlert;
  return Hand;
}
