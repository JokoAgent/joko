import { useEffect, useState, type JSX } from "react";
import { Gamepad2 } from "lucide-react";
import {
  GAMEPAD_ACTIONS, GAMEPAD_DIRECTIONS, createDefaultGamepadPreferences,
  readGamepadPreferences, saveGamepadPreferences, subscribeGamepadPreferences,
  type GamepadAction, type GamepadPreferences, type GamepadStickPreference
} from "../gamepad-input.js";
import { gamepadClient, useGamepadSnapshot } from "../gamepad-client.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, SelectControl, SwitchControl, cx } from "./ui.js";
import "./gamepad-settings.css";

const BUTTON_NAMES = ["south", "east", "west", "north", "leftShoulder", "rightShoulder", "leftTrigger", "rightTrigger", "select", "start", "leftClick", "rightClick", "up", "down", "left", "right", "home"] as const;

export function GamepadSettings({ t }: { readonly t: Translator }): JSX.Element {
  const [stored, setStored] = useState(readGamepadPreferences);
  const [notice, setNotice] = useState<"saved" | "reset" | undefined>();
  const [failed, setFailed] = useState(false);
  const snapshot = useGamepadSnapshot();
  useEffect(() => subscribeGamepadPreferences((next) => { setStored(next); setNotice(undefined); }), []);
  useEffect(() => { gamepadClient().reset(); return () => gamepadClient().reset(); }, []);
  const settings = stored.preferences;
  const save = (next: GamepadPreferences, reset = false): void => {
    setNotice(undefined); setFailed(false);
    try {
      saveGamepadPreferences(next);
      setStored({ preferences: next }); setNotice(reset ? "reset" : "saved");
    } catch { setFailed(true); }
  };
  const bind = (index: number, value: GamepadAction): void => {
    const buttons = [...settings.buttons]; buttons[index] = value;
    save({ ...settings, buttons });
  };
  const stick = (key: "leftStick" | "rightStick", value: GamepadStickPreference): void => save({ ...settings, [key]: value });
  const choices = (voice: boolean): readonly { value: GamepadAction; label: string }[] => GAMEPAD_ACTIONS
    .filter((action) => voice || action !== "voice")
    .map((action) => ({ value: action, label: t(`settings.gamepad.action.${action}`) }));
  const pressed = (index: number): boolean => snapshot.devices.some((device) => device.supported && device.buttons[index]);
  const disabled = stored.error !== undefined;

  return <section className="settings-card gamepad-settings" data-gamepad-preview="true" aria-labelledby="gamepad-heading">
    <div className="gamepad-settings__heading"><div><h2 id="gamepad-heading"><Gamepad2 aria-hidden="true" />{t("settings.gamepad.title")}</h2><p className="muted">{t("settings.gamepad.body")}</p></div>
      <SwitchControl aria-label={t("settings.gamepad.enable")} checked={settings.enabled} disabled={disabled} onChange={(event) => save({ ...settings, enabled: event.target.checked })} />
    </div>
    <p role="status" aria-live="polite">{t(`settings.gamepad.status.${snapshot.status}`)}</p>
    <p className="muted">{t("settings.gamepad.preview")}</p>
    {stored.error !== undefined && <ErrorBanner message={t(`settings.gamepad.storage.${stored.error}`)} />}
    {failed && <ErrorBanner message={t("settings.gamepad.saveFailed")} />}
    <div className="gamepad-settings__feedback" role="status" aria-live="polite">{notice === undefined ? "" : t(`settings.gamepad.${notice}`)}</div>
    <div className="gamepad-settings__devices">
      {snapshot.devices.length === 0 ? <p className="muted">{t("settings.gamepad.noDevice")}</p> : snapshot.devices.map((device) => <p key={device.index}>
        <strong>{device.id}</strong><span>{t(device.supported ? "settings.gamepad.standard" : "settings.gamepad.nonstandard")}</span>
      </p>)}
    </div>
    <div className="gamepad-settings__actions">
      <Button tone="ghost" onClick={() => { gamepadClient().reset(); gamepadClient().sample(performance.now()); setStored(readGamepadPreferences()); }}>{t("settings.gamepad.refresh")}</Button>
      <Button tone="ghost" onClick={() => save({ ...createDefaultGamepadPreferences(), enabled: settings.enabled }, true)}>{t("settings.gamepad.restore")}</Button>
    </div>
    <h3>{t("settings.gamepad.buttons")}</h3>
    <div className="gamepad-settings__bindings">
      {BUTTON_NAMES.map((name, index) => <div key={name} className={cx("gamepad-settings__binding", pressed(index) && "is-pressed")}>
        <span><small>{index + 1}</small>{t(`settings.gamepad.button.${name}`)}</span>
        <SelectControl aria-label={t("settings.gamepad.binding", { name: t(`settings.gamepad.button.${name}`) })} disabled={disabled}
          value={settings.buttons[index] ?? "none"} onChange={(event) => bind(index, event.target.value as GamepadAction)}>{choices(true).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</SelectControl>
      </div>)}
    </div>
    <div className="gamepad-settings__sticks">
      {(["leftStick", "rightStick"] as const).map((key, index) => {
        const value = settings[key];
        const axes = snapshot.devices.find((device) => device.supported)?.axes;
        const x = axes?.[index * 2] ?? 0;
        const y = axes?.[index * 2 + 1] ?? 0;
        return <section key={key} aria-labelledby={`gamepad-${key}`}>
          <h3 id={`gamepad-${key}`}>{t(`settings.gamepad.${key}`)}</h3>
          <div className="gamepad-settings__stick-preview" aria-hidden="true"><span style={{ transform: `translate(${x * 26}px, ${y * 26}px)` }} /></div>
          <SelectControl aria-label={t("settings.gamepad.stickMode", { name: t(`settings.gamepad.${key}`) })} disabled={disabled} value={value.mode}
            onChange={(event) => stick(key, { ...value, mode: event.target.value as GamepadStickPreference["mode"] })}>{(["commands", "scroll", "disabled"] as const).map((mode) => <option key={mode} value={mode}>{t(`settings.gamepad.mode.${mode}`)}</option>)}</SelectControl>
          {value.mode === "commands" && GAMEPAD_DIRECTIONS.map((direction) => <div className="gamepad-settings__binding" key={direction}>
            <span>{t(`settings.gamepad.button.${direction}`)}</span>
            <SelectControl aria-label={t("settings.gamepad.binding", { name: `${t(`settings.gamepad.${key}`)} · ${t(`settings.gamepad.button.${direction}`)}` })}
              disabled={disabled} value={value.directions[direction]}
              onChange={(event) => stick(key, { ...value, directions: { ...value.directions, [direction]: event.target.value as GamepadAction } })}>{choices(false).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</SelectControl>
          </div>)}
        </section>;
      })}
    </div>
  </section>;
}
