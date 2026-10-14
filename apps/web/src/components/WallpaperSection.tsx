import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, JSX, KeyboardEvent } from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import type { MessageKey, translate } from "../i18n.js";
import { useWallpaperSettings } from "../wallpaper-settings.js";
import { Button, Spinner } from "./ui.js";

export function WallpaperSection({ t }: { readonly t: (key: MessageKey, values?: Parameters<typeof translate>[2]) => string }): JSX.Element {
  const { state, reload, setMode, setMaskOpacity, importImage, removeImage, reset } = useWallpaperSettings();
  const settings = state.settings;
  const disabled = !state.available || state.loading || state.busy || settings === undefined;
  const image = settings?.customImage;
  const optionsRef = useRef<HTMLDivElement>(null);
  const restoreSelectionFocus = useRef(false);
  useLayoutEffect(() => {
    if (disabled || !restoreSelectionFocus.current) return;
    restoreSelectionFocus.current = false;
    optionsRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [disabled, settings?.mode]);
  const choose = (mode: "none" | "custom"): void => {
    if (!disabled && settings?.mode !== mode) void setMode(mode);
  };
  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const mode = event.key === "Home" ? "none" : event.key === "End" ? "custom"
      : ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
        ? settings?.mode === "custom" ? "none" : "custom" : undefined;
    if (mode === undefined) return;
    event.preventDefault();
    restoreSelectionFocus.current = true;
    choose(mode);
  };
  return <section className="settings-card wallpaper-settings" aria-label={t("settings.wallpaper.title")} aria-busy={state.loading || state.busy}>
    <div className="wallpaper-settings__heading">
      <div><strong>{t("settings.wallpaper.title")}</strong><p className="muted">{t("settings.wallpaper.body")}</p></div>
      <Button disabled={disabled || (settings?.mode === "none" && settings.maskOpacity === 0.2)} onClick={() => void reset()}><RotateCcw aria-hidden="true" />{t("settings.wallpaper.reset")}</Button>
    </div>
    {!state.available && <p className="muted" role="status">{t("settings.wallpaper.unavailable")}</p>}
    {state.loading && state.available && <p className="wallpaper-settings__pending" role="status"><Spinner />{t("common.loading")}</p>}
    {state.busy && <p className="wallpaper-settings__pending" role="status"><Spinner />{t("common.working")}</p>}
    <div ref={optionsRef} className="wallpaper-settings__options" role="radiogroup" aria-label={t("settings.wallpaper.title")}>
      {(["none", "custom"] as const).map((mode) => <button
        type="button" key={mode} role="radio" aria-checked={(settings?.mode ?? "none") === mode}
        tabIndex={(settings?.mode ?? "none") === mode ? 0 : -1} disabled={disabled}
        onClick={() => choose(mode)} onKeyDown={moveSelection}
      >
        <span className="wallpaper-settings__preview" style={mode === "custom" && image != null ? { backgroundImage: `url("${image.url}")` } as CSSProperties : undefined}>
          {mode === "none" ? t("settings.wallpaper.none") : image == null ? <ImagePlus aria-hidden="true" /> : null}
        </span>
        <strong>{t(mode === "none" ? "settings.wallpaper.none" : "settings.wallpaper.custom")}</strong>
      </button>)}
    </div>
    <div className="wallpaper-settings__actions">
      <Button disabled={disabled} onClick={() => void importImage()}><ImagePlus aria-hidden="true" />{t(image == null ? "settings.wallpaper.choose" : "settings.wallpaper.replace")}</Button>
      {image != null && <Button disabled={disabled} onClick={() => void removeImage()}>{t("settings.wallpaper.remove")}</Button>}
      <p className="muted">{t("settings.wallpaper.hint")}</p>
    </div>
    <label className="wallpaper-settings__mask">
      <span>{t("settings.wallpaper.mask")}</span>
      <input type="range" min={0} max={0.6} step={0.05} value={settings?.maskOpacity ?? 0.2}
        disabled={!state.available || state.loading || settings === undefined || (state.busy && state.operation !== "set")}
        onChange={(event) => void setMaskOpacity(Number(event.currentTarget.value))} />
      <output>{Math.round((settings?.maskOpacity ?? 0.2) * 100)}%</output>
    </label>
    {state.error !== undefined && <div className="wallpaper-settings__error" role="alert"><p>{t(state.error === "load" ? "settings.wallpaper.loadFailed" : "settings.wallpaper.saveFailed")}</p><Button disabled={state.busy} onClick={() => void reload()}>{t("common.retry")}</Button></div>}
  </section>;
}
