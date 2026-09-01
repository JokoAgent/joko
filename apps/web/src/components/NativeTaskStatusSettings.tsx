import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { MonitorUp, RotateCcw, Volume2 } from "lucide-react";
import type { Translator } from "./types.js";
import { IconButton, CheckboxControl, SelectControl, SwitchControl } from "./ui.js";

export function NativeTaskStatusSettings({ t, showHeading = true }: { readonly t: Translator; readonly showHeading?: boolean }): JSX.Element | null {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const supported = desktop?.capabilities.includes("native.taskStatus") === true;
  const [settings, setSettings] = useState<JokoDesktopNativeTaskStatusSettings>();
  const [displays, setDisplays] = useState<readonly JokoDesktopNativeTaskStatusDisplay[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    if (!supported || desktop === undefined) return;
    const generation = ++loadGenerationRef.current;
    void Promise.all([
      desktop.nativeTaskStatus.getSettings(),
      desktop.nativeTaskStatus.getDisplays()
    ]).then(([nextSettings, nextDisplays]) => {
      if (loadGenerationRef.current !== generation) return;
      setSettings(nextSettings);
      setDisplays(nextDisplays);
      setError(undefined);
    }).catch(() => {
      if (loadGenerationRef.current === generation) setError(t("settings.nativeTaskStatus.loadFailed"));
    });
    const unsubscribe = desktop.nativeTaskStatus.onSettingsChanged((next) => {
      if (loadGenerationRef.current === generation) setSettings(next);
    });
    return () => {
      loadGenerationRef.current += 1;
      unsubscribe();
    };
  }, [desktop, supported, t]);

  const save = useCallback((next: JokoDesktopNativeTaskStatusSettings): void => {
    if (desktop === undefined || saving) return;
    setSaving(true);
    setError(undefined);
    void desktop.nativeTaskStatus.setSettings(next).then(setSettings).catch(() => {
      setError(t("settings.nativeTaskStatus.saveFailed"));
    }).finally(() => setSaving(false));
  }, [desktop, saving, t]);

  const selectCustomSound = useCallback((event: NativeSoundEvent): void => {
    if (desktop === undefined || settings === undefined || saving) return;
    setError(undefined);
    void desktop.nativeTaskStatus.selectSoundFile().then((selection) => {
      if (selection.path === null || selection.name === null) return;
      save({
        ...settings,
        sounds: { ...settings.sounds, sounds: { ...settings.sounds.sounds, [event]: { type: "custom", path: selection.path, name: selection.name } } }
      });
    }).catch(() => setError(t("settings.nativeTaskStatus.selectSoundFailed")));
  }, [desktop, save, saving, settings, t]);

  if (!supported) return null;
  const selectedDisplayId = settings?.display.mode === "display" ? settings.display.displayId : undefined;
  const selectedDisplay = selectedDisplayId === undefined ? "all" : String(selectedDisplayId);
  const selectedDisplayAvailable = selectedDisplayId === undefined ||
    displays.some((display) => display.id === selectedDisplayId);
  return <section className="settings-card native-task-status-settings" aria-labelledby={showHeading ? "native-task-status-title" : undefined} aria-label={showHeading ? undefined : t("settings.nativeTaskStatus.title")}>
    {showHeading && <header className="settings-card__heading">
      <MonitorUp aria-hidden="true" />
      <div><h3 id="native-task-status-title">{t("settings.nativeTaskStatus.title")}</h3><p>{t("settings.nativeTaskStatus.body")}</p></div>
    </header>}
    {error !== undefined && <p className="settings-inline-error" role="alert">{error}</p>}
    {settings !== undefined && <>
      <div className="setting-row"><div><strong>{t("settings.nativeTaskStatus.enabled")}</strong><span>{t("settings.nativeTaskStatus.enabledBody")}</span></div><SwitchControl checked={settings.enabled} disabled={saving} onChange={(event) => save({ ...settings, enabled: event.target.checked })} /></div>
      <div className="setting-row"><div><strong>{t("settings.nativeTaskStatus.display")}</strong></div><SelectControl value={selectedDisplay} disabled={saving} onChange={(event) => save({ ...settings, display: nativeTaskStatusDisplayTarget(event.target.value, displays) })}>
        <option value="all">{t("settings.nativeTaskStatus.allDisplays")}</option>
        {!selectedDisplayAvailable && settings.display.mode === "display" && <option value={settings.display.displayId}>{t("settings.nativeTaskStatus.unavailableDisplay", { id: settings.display.displayId })}</option>}
        {displays.map((display) => <option value={display.id} key={display.id}>{display.name}{display.primary ? ` · ${t("settings.nativeTaskStatus.primary")}` : ""}</option>)}
      </SelectControl></div>
      <div className="setting-row"><div><strong>{t("settings.nativeTaskStatus.layout")}</strong></div><SelectControl value={settings.layout} disabled={saving} onChange={(event) => save({ ...settings, layout: event.target.value === "compact" ? "compact" : "normal" })}><option value="compact">{t("settings.nativeTaskStatus.layoutCompact")}</option><option value="normal">{t("settings.nativeTaskStatus.layoutNormal")}</option></SelectControl></div>
      <div className="setting-row setting-row--stacked native-task-status-sound-setting"><div className="native-task-status-sound-heading"><div><strong>{t("settings.nativeTaskStatus.sounds")}</strong><span>{t("settings.nativeTaskStatus.soundsBody")}</span></div><div className="native-task-status-sound-actions"><IconButton label={t("settings.restoreDefault")} disabled={saving || sameSoundSettings(settings.sounds, DEFAULT_SOUND_SETTINGS)} disabledReason={saving ? t("common.working") : t("settings.restoreDefault")} onClick={() => save({ ...settings, sounds: DEFAULT_SOUND_SETTINGS })}><RotateCcw aria-hidden="true" /></IconButton><SwitchControl checked={settings.sounds.enabled} disabled={saving} onChange={(input) => save({ ...settings, sounds: { ...settings.sounds, enabled: input.target.checked } })} /></div></div>
        {settings.sounds.enabled && <div className="native-task-status-sounds">{SOUND_EVENTS.map((event) => {
          const sound = settings.sounds.sounds[event];
          const value = sound.type === "builtin" ? sound.id : CUSTOM_SOUND_VALUE;
          return <div className="native-task-status-sound-row" key={event}><label htmlFor={`native-task-status-sound-${event}`}>{t(soundEventLabel(event))}</label><SelectControl id={`native-task-status-sound-${event}`} value={value} disabled={saving} onChange={(input) => {
            if (input.target.value === CUSTOM_SOUND_VALUE) { selectCustomSound(event); return; }
            save({ ...settings, sounds: { ...settings.sounds, sounds: { ...settings.sounds.sounds, [event]: { type: "builtin", id: input.target.value as NativeSoundId } } } });
          }}>{SOUND_OPTIONS.map((option) => <option key={option} value={option}>{t(soundOptionLabel(option))}</option>)}<option value={CUSTOM_SOUND_VALUE}>{sound.type === "custom" ? t("settings.nativeTaskStatus.soundCustomSelected", { name: sound.name }) : t("settings.nativeTaskStatus.soundCustom")}</option></SelectControl><IconButton disabled={sound.type === "builtin" && sound.id === "none"} disabledReason={sound.type === "builtin" && sound.id === "none" ? t("common.unavailable") : undefined} label={t("settings.nativeTaskStatus.previewSound", { event: t(soundEventLabel(event)) })} onClick={() => { if (desktop !== undefined) void desktop.nativeTaskStatus.previewSound(sound).catch(() => setError(t("settings.nativeTaskStatus.previewSoundFailed"))); }}><Volume2 aria-hidden="true" /></IconButton></div>;
        })}</div>}
      </div>
    </>}
  </section>;
}

function nativeTaskStatusDisplayTarget(
  value: string,
  displays: readonly JokoDesktopNativeTaskStatusDisplay[]
): JokoDesktopNativeTaskStatusSettings["display"] {
  if (value === "all") return { mode: "all" };
  const displayId = Number(value);
  const displayIndex = displays.findIndex((display) => display.id === displayId);
  const display = displays[displayIndex];
  if (display === undefined) return { mode: "display", displayId };
  return {
    mode: "display",
    displayId,
    displayName: display.name,
    displayIndex,
    displayBounds: display.bounds
  };
}

type NativeSoundEvent = keyof JokoDesktopNativeTaskStatusSettings["sounds"]["sounds"];
type NativeSoundId = Extract<JokoDesktopNativeTaskStatusSoundChoice, { readonly type: "builtin" }>["id"];
const CUSTOM_SOUND_VALUE = "custom";
const SOUND_EVENTS = ["start", "attention", "complete", "error", "select"] as const;
const SOUND_OPTIONS = ["none", "startup-chime", "ring-chime", "item-found", "gem-collect", "item-fanfare", "victory-fanfare", "error-buzz", "secret-chime"] as const;
const DEFAULT_SOUND_SETTINGS: JokoDesktopNativeTaskStatusSettings["sounds"] = {
  enabled: true,
  sounds: {
    start: { type: "builtin", id: "startup-chime" }, attention: { type: "builtin", id: "secret-chime" },
    complete: { type: "builtin", id: "gem-collect" }, error: { type: "builtin", id: "error-buzz" },
    select: { type: "builtin", id: "none" }
  }
};

function soundEventLabel(event: NativeSoundEvent): `settings.nativeTaskStatus.soundEvent.${NativeSoundEvent}` { return `settings.nativeTaskStatus.soundEvent.${event}`; }
function soundOptionLabel(id: NativeSoundId): `settings.nativeTaskStatus.soundOption.${NativeSoundId}` { return `settings.nativeTaskStatus.soundOption.${id}`; }
function sameSoundSettings(left: JokoDesktopNativeTaskStatusSettings["sounds"], right: JokoDesktopNativeTaskStatusSettings["sounds"]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
