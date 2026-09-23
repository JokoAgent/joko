// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultGamepadPreferences, GAMEPAD_PREFERENCES_KEY, GamepadInputEngine,
  parseGamepadPreferences, readGamepadPreferences, saveGamepadPreferences, subscribeGamepadPreferences,
  type GamepadAction, type GamepadInputSample, type GamepadPreferences, type GamepadSample
} from "./gamepad-input.js";

afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

function preferences(): GamepadPreferences { return { ...createDefaultGamepadPreferences(), enabled: true }; }
function pad(options: { index?: number; id?: string; down?: number[]; axes?: number[]; values?: Record<number, number> } = {}): GamepadSample {
  return {
    index: options.index ?? 0, id: options.id ?? "Standard controller", mapping: "standard", connected: true,
    buttons: Array.from({ length: 17 }, (_, index) => {
      const value = options.values?.[index] ?? (options.down?.includes(index) ? 1 : 0);
      return { value, pressed: value >= 0.5, touched: value > 0 };
    }),
    axes: options.axes ?? [0, 0, 0, 0]
  };
}
function sampler(engine = new GamepadInputEngine()) {
  let now = 0;
  const saved = preferences();
  return {
    engine,
    sample(pads: GamepadSample[] = [pad()], patch: Partial<GamepadInputSample> = {}) {
      now += 16;
      return engine.sample({ pads, preferences: saved, active: true, preview: false, now, ...patch });
    }
  };
}
const voice = (phase: "press" | "release" | "cancel") => ({ kind: "action", action: "voice", phase });

describe("gamepad preference authority", () => {
  it("accepts bounded skill identities and emits a single skill press after a neutral sample", () => {
    const binding = { kind: "skill" as const, serverId: "server-one", resourceId: "resource-skill", name: "Review" };
    const current = { ...preferences(), buttons: preferences().buttons.map((value, index) => index === 0 ? binding : value) };
    expect(parseGamepadPreferences(current)).toEqual(current);
    expect(parseGamepadPreferences({ ...current, buttons: current.buttons.map((value, index) => index === 0 ? { ...binding, name: "" } : value) })).toBeUndefined();
    const { sample } = sampler();
    expect(sample([pad({ down: [0] })], { preferences: current }).effects).toEqual([]);
    sample([pad()], { preferences: current });
    expect(sample([pad({ down: [0] })], { preferences: current }).effects).toEqual([{ kind: "skill", binding }]);
    expect(sample([pad({ down: [0] })], { preferences: current }).effects).toEqual([]);
    expect(sample([pad()], { preferences: current }).effects).toEqual([]);
    const oversized = { ...current, buttons: Array(17).fill({ ...binding, name: "x".repeat(512) }) };
    expect(() => saveGamepadPreferences(oversized)).toThrow("storage limit");
    expect(window.localStorage.getItem(GAMEPAD_PREFERENCES_KEY)).toBeNull();
  });
  it("accepts the complete current shape and rejects malformed settings without repairing persisted content", () => {
    const current = preferences();
    expect(parseGamepadPreferences(current)).toEqual(current);
    const invalid = [
      { ...current, version: 2 }, { ...current, enabled: 1 }, { ...current, extra: true },
      { ...current, buttons: current.buttons.slice(1) }, { ...current, buttons: [...current.buttons, "none"] },
      { ...current, buttons: current.buttons.map((action, index) => index === 0 ? "arbitrary-command" : action) },
      { ...current, buttons: Array(17) }, { ...current, rightStick: undefined },
      { ...current, leftStick: { ...current.leftStick, mode: "unknown" } },
      { ...current, leftStick: { ...current.leftStick, directions: { ...current.leftStick.directions, up: "voice" } } },
      { ...current, leftStick: { ...current.leftStick, directions: { ...current.leftStick.directions, extra: "none" } } }
    ];
    for (const value of invalid) {
      window.localStorage.setItem(GAMEPAD_PREFERENCES_KEY, JSON.stringify(value));
      const stored = window.localStorage.getItem(GAMEPAD_PREFERENCES_KEY);
      expect(readGamepadPreferences()).toMatchObject({ preferences: { enabled: false }, error: "invalid" });
      expect(window.localStorage.getItem(GAMEPAD_PREFERENCES_KEY)).toBe(stored);
    }
    window.localStorage.setItem(GAMEPAD_PREFERENCES_KEY, "{");
    expect(readGamepadPreferences().error).toBe("invalid");
    window.localStorage.setItem(GAMEPAD_PREFERENCES_KEY, " ".repeat(8_193));
    expect(readGamepadPreferences().error).toBe("invalid");
  });

  it("publishes only committed settings, restores defaults explicitly, and releases storage subscriptions", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGamepadPreferences(listener);
    const current = preferences();
    saveGamepadPreferences(current);
    expect(listener).toHaveBeenLastCalledWith({ preferences: current });
    expect(readGamepadPreferences()).toEqual({ preferences: current });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    expect(() => saveGamepadPreferences(createDefaultGamepadPreferences())).toThrow("Storage full");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readGamepadPreferences().preferences.enabled).toBe(true);
    write.mockRestore();
    const modified = { ...current, buttons: current.buttons.map((): GamepadAction => "none") };
    saveGamepadPreferences(modified);
    saveGamepadPreferences({ ...createDefaultGamepadPreferences(), enabled: modified.enabled });
    expect(readGamepadPreferences()).toEqual({ preferences: current });
    unsubscribe(); listener.mockClear();
    saveGamepadPreferences(createDefaultGamepadPreferences());
    expect(listener).not.toHaveBeenCalled();
  });

  it("hot reads relevant storage changes and reports denied reads as disabled", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGamepadPreferences(listener);
    window.localStorage.setItem(GAMEPAD_PREFERENCES_KEY, JSON.stringify(preferences()));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", storageArea: window.localStorage }));
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: GAMEPAD_PREFERENCES_KEY, storageArea: window.localStorage }));
    expect(listener).toHaveBeenLastCalledWith({ preferences: preferences() });
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: window.localStorage }));
    expect(listener).toHaveBeenLastCalledWith({ preferences: createDefaultGamepadPreferences() });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Denied"); });
    window.dispatchEvent(new StorageEvent("storage", { key: GAMEPAD_PREFERENCES_KEY }));
    expect(listener).toHaveBeenLastCalledWith({ preferences: createDefaultGamepadPreferences(), error: "unavailable" });
    unsubscribe();
  });
});

describe("gamepad input ownership", () => {
  it("maps the default B button to history back and accepts a saved forward binding", () => {
    const defaultLayout = createDefaultGamepadPreferences();
    expect(defaultLayout.buttons[1]).toBe("navigate-back");
    const layout = { ...defaultLayout, enabled: true, buttons: defaultLayout.buttons.map((binding, index) => index === 3 ? "navigate-forward" as const : binding) };
    saveGamepadPreferences(layout);
    expect(readGamepadPreferences().preferences.buttons[3]).toBe("navigate-forward");
    const { sample } = sampler();
    expect(sample([pad({ down: [1, 3] })], { preferences: layout }).effects).toEqual([]);
    sample([pad()], { preferences: layout });
    expect(sample([pad({ down: [1, 3] })], { preferences: layout }).effects).toEqual([
      { kind: "action", action: "navigate-back", phase: "press" },
      { kind: "action", action: "navigate-forward", phase: "press" }
    ]);
    expect(sample([pad({ down: [1, 3] })], { preferences: layout }).effects).toEqual([]);
  });
  it("maps the standard home button to schedule management after a neutral sample", () => {
    expect(createDefaultGamepadPreferences().buttons[16]).toBe("open-schedules");
    const { sample } = sampler();
    expect(sample([pad({ down: [16] })]).effects).toEqual([]);
    sample();
    expect(sample([pad({ down: [16] })]).effects).toEqual([{ kind: "action", action: "open-schedules", phase: "press" }]);
    expect(sample([pad({ down: [16] })]).effects).toEqual([]);
  });
  it("requires neutral input after initial connection and dispatches each button edge once", () => {
    const { sample } = sampler();
    expect(sample([pad({ down: [0] })]).effects).toEqual([]);
    expect(sample([pad({ down: [0] })]).effects).toEqual([]);
    expect(sample().effects).toEqual([]);
    expect(sample([pad({ down: [0] })]).effects).toEqual([{ kind: "action", action: "submit", phase: "press" }]);
    expect(sample([pad({ down: [0] })]).effects).toEqual([]);
    expect(sample().effects).toEqual([{ kind: "action", action: "submit", phase: "release" }]);
  });

  it("aggregates voice holds across physical buttons and devices, with trigger hysteresis", () => {
    const { sample } = sampler();
    sample([pad(), pad({ index: 1 })]);
    expect(sample([pad({ values: { 6: 0.54 } }), pad({ index: 1 })]).effects).toEqual([]);
    expect(sample([pad({ values: { 6: 0.6 } }), pad({ index: 1 })]).effects).toEqual([voice("press")]);
    expect(sample([pad({ values: { 6: 0.45 }, down: [7] }), pad({ index: 1, down: [6] })]).effects).toEqual([]);
    expect(sample([pad({ index: 1, down: [6] })]).effects).toEqual([]);
    expect(sample([pad({ index: 1, values: { 6: 0.39 } })]).effects).toEqual([voice("release")]);
    expect(sample([pad({ index: 1, down: [7] })]).effects).toEqual([voice("press")]);
    expect(sample([]).effects).toEqual([voice("cancel")]);
  });

  it.each(["blur", "preview", "disabled", "layout", "disconnect", "identity", "clock"])("cancels an owned voice on %s and requires a new neutral sample", (reason) => {
    const { sample } = sampler();
    sample(); sample([pad({ down: [6] })]);
    const changedPreferences = preferences();
    const patch: Partial<GamepadInputSample> = reason === "blur" ? { active: false }
      : reason === "preview" ? { preview: true }
      : reason === "disabled" ? { preferences: { ...changedPreferences, enabled: false } }
      : reason === "layout" ? { preferences: { ...changedPreferences, buttons: changedPreferences.buttons.map((value, index) => index === 0 ? "none" : value) } }
      : reason === "clock" ? { now: NaN } : {};
    const pads = reason === "disconnect" ? [] : [pad({ down: [6], ...(reason === "identity" ? { id: "Replacement controller" } : {}) })];
    expect(sample(pads, patch).effects).toEqual([voice("cancel")]);
    expect(sample([pad({ down: [6] })]).effects).toEqual([]);
    sample();
    expect(sample([pad({ down: [6] })]).effects).toEqual([voice("press")]);
  });

  it("releases independent command edges while voice remains owned and cancels only once on disposal", () => {
    const { sample, engine } = sampler();
    sample();
    expect(sample([pad({ down: [0, 6, 7] })]).effects).toEqual([{ kind: "action", action: "submit", phase: "press" }, voice("press")]);
    expect(sample([pad({ down: [6, 7] })]).effects).toEqual([{ kind: "action", action: "submit", phase: "release" }]);
    expect(engine.reset()).toEqual([voice("cancel")]);
    expect(engine.reset()).toEqual([]);
  });

  it("keeps device preview live without dispatch and marks nonstandard or invalid frames unsupported", () => {
    const { sample } = sampler();
    const previewPad = pad({ down: [0], axes: [0, 0, 0.8, 0.5] });
    const result = sample([previewPad], { preview: true });
    expect(result.effects).toEqual([]);
    expect(result.devices[0]).toMatchObject({ supported: true, axes: [0, 0, 0.8, 0.5] });
    expect(result.devices[0]?.buttons[0]).toBe(true);
    for (const invalid of [
      { ...pad(), mapping: "" as const }, { ...pad(), axes: [0, 0, NaN, 0] },
      { ...pad(), axes: [0, 0, 2, 0] }, { ...pad(), axes: Array<number>(4) },
      { ...pad(), buttons: [] }, { ...pad(), buttons: Array<GamepadButton>(17) }
    ]) {
      const state = sample([invalid]);
      expect(state.devices[0]?.supported).toBe(false);
      expect(state.effects).toEqual([]);
    }
  });

  it("dispatches discrete stick directions and bounds continuous scroll time and deadzone", () => {
    const { sample } = sampler();
    expect(sample([pad({ axes: [0, -1, 0, 1] })]).effects).toEqual([]);
    sample();
    expect(sample([pad({ axes: [0, -1, 0, 0] })]).effects).toEqual([{ kind: "action", action: "previous-task", phase: "press" }]);
    expect(sample([pad({ axes: [0, -1, 0, 0] })]).effects).toEqual([]);
    expect(sample([pad({ axes: [0, 1, 0, 0] })]).effects).toEqual([
      { kind: "action", action: "previous-task", phase: "release" },
      { kind: "action", action: "next-task", phase: "press" }
    ]);
    sample();
    expect(sample([pad({ axes: [0, 0, 0, 0.2] })]).effects).toEqual([]);
    expect(sample([pad({ axes: [0, 0, 0, 1] })]).effects).toEqual([{ kind: "scroll", x: 0, y: 14.4 }]);
    expect(sample([pad({ axes: [0, 0, 0, 1] })], { now: 10_000 }).effects).toEqual([{ kind: "scroll", x: 0, y: 45 }]);
    expect(sample().effects).toEqual([{ kind: "scroll", x: 0, y: 0 }]);
    sample([pad({ axes: [0, 0, 0, 1] })]);
    expect(sample([pad({ axes: [0, 0, 0, 1] })], { active: false }).effects).toEqual([{ kind: "scroll", x: 0, y: 0 }]);
  });
});
