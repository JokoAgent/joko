import type { JSX } from "react";
import type { Translator } from "./types.js";
import { CheckboxControl } from "./ui.js";

export function ModelSpeedControl({ value, supportsFast, supportsUltrafast, disabled = false, onChange, t, locale, className }: {
  readonly value: boolean | "ultrafast";
  readonly supportsFast: boolean;
  readonly supportsUltrafast?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: boolean | "ultrafast") => void;
  readonly t?: Translator;
  readonly locale?: string;
  readonly className?: string;
}): JSX.Element {
  const zh = locale?.startsWith("zh") === true;
  const text = { speed: t?.("controls.speed") ?? (zh ? "速度" : "Speed"), standard: t?.("controls.standard") ?? (zh ? "标准" : "Standard"),
    fast: t?.("controls.fast") ?? (zh ? "快速" : "Fast"), ultrafast: t?.("controls.ultrafast") ?? (zh ? "极速" : "Ultrafast") };
  return supportsUltrafast || value === "ultrafast" ? <label className={className}><span>{text.speed}</span>
    <select aria-label={text.speed} disabled={disabled}
      value={value === "ultrafast" ? "ultrafast" : value ? "fast" : "standard"}
      onChange={event => onChange(event.target.value === "ultrafast" ? "ultrafast" : event.target.value === "fast")}>
      <option value="standard">{text.standard}</option>
      {supportsFast && <option value="fast">{text.fast}</option>}
      <option value="ultrafast" disabled={!supportsUltrafast}>{text.ultrafast}</option>
    </select>
  </label> : <label className={className}><CheckboxControl checked={value === true} disabled={disabled || !supportsFast && value === false}
    onChange={event => onChange(event.target.checked)} /><span>{text.fast}</span></label>;
}
