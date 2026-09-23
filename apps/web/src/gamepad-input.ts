export const GAMEPAD_ACTIONS = [
  "none", "activate", "back", "navigate-back", "navigate-forward", "new-task", "toggle-sidebar", "focus-composer",
  "previous-task", "next-task", "previous-panel", "next-panel", "scroll-up", "scroll-down",
  "approve", "reject", "submit", "stop", "toggle-plan", "toggle-fast", "effort-increase", "effort-decrease",
  "toggle-pin", "archive-task", "fork-task", "copy-task-link", "copy-conversation-markdown", "add-attachments", "open-commands",
  "open-settings", "open-skills", "open-schedules", "toggle-inspector", "toggle-fullscreen", "open-terminal", "open-browser-tab", "toggle-review-tab", "scroll-bottom", "voice"
] as const;
export type GamepadAction = (typeof GAMEPAD_ACTIONS)[number];
export interface GamepadSkillBinding {
  readonly kind: "skill";
  readonly serverId: string;
  readonly resourceId: string;
  readonly name: string;
}
export type GamepadBinding = GamepadAction | GamepadSkillBinding;
export const GAMEPAD_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type GamepadDirection = (typeof GAMEPAD_DIRECTIONS)[number];
export interface GamepadStickPreference {
  readonly mode: "scroll" | "commands" | "disabled";
  readonly directions: Readonly<Record<GamepadDirection, GamepadBinding>>;
}
export interface GamepadPreferences {
  readonly version: 1;
  readonly enabled: boolean;
  /** Browser standard mapping: face, shoulders, triggers, menu, stick clicks, D-pad, home. */
  readonly buttons: readonly GamepadBinding[];
  readonly leftStick: GamepadStickPreference;
  readonly rightStick: GamepadStickPreference;
}

export function createDefaultGamepadPreferences(): GamepadPreferences {
  return {
    version: 1,
    enabled: false,
    buttons: [
      "submit", "navigate-back", "toggle-fast", "new-task", "effort-decrease", "effort-increase",
      "voice", "voice", "toggle-fullscreen", "open-settings", "focus-composer", "scroll-bottom",
      "scroll-up", "scroll-down", "toggle-sidebar", "toggle-inspector", "open-schedules"
    ],
    leftStick: { mode: "commands", directions: { up: "previous-task", down: "next-task", left: "toggle-sidebar", right: "toggle-inspector" } },
    rightStick: { mode: "scroll", directions: { up: "none", down: "none", left: "none", right: "none" } }
  };
}
export const DEFAULT_GAMEPAD_PREFERENCES = createDefaultGamepadPreferences();
export const GAMEPAD_PREFERENCES_KEY = "joko.gamepad.preferences.v1";
export const GAMEPAD_PREFERENCES_EVENT = "joko:gamepad-preferences";
const MAX_PREFERENCES_LENGTH = 8_192;

function recordHasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isAction(value: unknown): value is GamepadAction {
  return typeof value === "string" && (GAMEPAD_ACTIONS as readonly string[]).includes(value);
}
export function isGamepadSkillBinding(value: unknown): value is GamepadSkillBinding {
  return recordHasKeys(value, ["kind", "serverId", "resourceId", "name"])
    && value.kind === "skill"
    && [value.serverId, value.resourceId, value.name].every((part) => typeof part === "string"
      && part.trim() === part && part.length > 0 && part.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(part));
}
function isBinding(value: unknown): value is GamepadBinding {
  return isAction(value) || isGamepadSkillBinding(value);
}
function parseStick(value: unknown): GamepadStickPreference | undefined {
  if (!recordHasKeys(value, ["mode", "directions"]) || typeof value.mode !== "string" || !["scroll", "commands", "disabled"].includes(value.mode)
    || !recordHasKeys(value.directions, GAMEPAD_DIRECTIONS)) return undefined;
  const directions = value.directions;
  // Voice requires a physical button release; an analog direction cannot own it.
  if (!GAMEPAD_DIRECTIONS.every((direction) => isBinding(directions[direction]) && directions[direction] !== "voice")) return undefined;
  return {
    mode: value.mode as GamepadStickPreference["mode"],
    directions: Object.fromEntries(GAMEPAD_DIRECTIONS.map((direction) => [direction, directions[direction]])) as Record<GamepadDirection, GamepadBinding>
  };
}

/** Only the complete current shape is accepted; invalid data remains available for explicit reset. */
export function parseGamepadPreferences(value: unknown): GamepadPreferences | undefined {
  if (!recordHasKeys(value, ["version", "enabled", "buttons", "leftStick", "rightStick"])
    || value.version !== 1 || typeof value.enabled !== "boolean"
    || !Array.isArray(value.buttons) || value.buttons.length !== 17
    || !Array.from(value.buttons).every(isBinding)) return undefined;
  const leftStick = parseStick(value.leftStick);
  const rightStick = parseStick(value.rightStick);
  if (leftStick === undefined || rightStick === undefined) return undefined;
  return { version: 1, enabled: value.enabled, buttons: [...value.buttons], leftStick, rightStick };
}
export interface GamepadPreferencesRead {
  readonly preferences: GamepadPreferences;
  readonly error?: "invalid" | "unavailable";
}
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readGamepadPreferences(storage?: PreferenceStorage): GamepadPreferencesRead {
  let raw: string | null;
  try { raw = (storage ?? window.localStorage).getItem(GAMEPAD_PREFERENCES_KEY); }
  catch { return { preferences: createDefaultGamepadPreferences(), error: "unavailable" }; }
  if (raw === null) return { preferences: createDefaultGamepadPreferences() };
  try {
    const preferences = raw.length <= MAX_PREFERENCES_LENGTH ? parseGamepadPreferences(JSON.parse(raw)) : undefined;
    if (preferences !== undefined) return { preferences };
  } catch { /* Invalid persisted content is reported without changing it. */ }
  return { preferences: createDefaultGamepadPreferences(), error: "invalid" };
}

/** Publication follows successful storage so active input never adopts a failed save. */
export function saveGamepadPreferences(preferences: GamepadPreferences, storage?: PreferenceStorage): void {
  const parsed = parseGamepadPreferences(preferences);
  if (parsed === undefined) throw new Error("Invalid gamepad preferences.");
  const serialized = JSON.stringify(parsed);
  if (serialized.length > MAX_PREFERENCES_LENGTH) throw new Error("Gamepad preferences exceed the storage limit.");
  (storage ?? window.localStorage).setItem(GAMEPAD_PREFERENCES_KEY, serialized);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(GAMEPAD_PREFERENCES_EVENT));
}

export function subscribeGamepadPreferences(listener: (result: GamepadPreferencesRead) => void, ownerWindow: Window = window): () => void {
  const changed = (): void => {
    try { listener(readGamepadPreferences(ownerWindow.localStorage)); }
    catch { listener({ preferences: createDefaultGamepadPreferences(), error: "unavailable" }); }
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== GAMEPAD_PREFERENCES_KEY) return;
    try { if (event.storageArea !== null && event.storageArea !== ownerWindow.localStorage) return; }
    catch { changed(); return; }
    changed();
  };
  ownerWindow.addEventListener("storage", onStorage);
  ownerWindow.addEventListener(GAMEPAD_PREFERENCES_EVENT, changed);
  return () => {
    ownerWindow.removeEventListener("storage", onStorage);
    ownerWindow.removeEventListener(GAMEPAD_PREFERENCES_EVENT, changed);
  };
}

export type GamepadSample = Pick<Gamepad, "index" | "id" | "mapping" | "connected" | "buttons" | "axes">;
export interface GamepadDeviceInfo {
  readonly index: number;
  readonly id: string;
  readonly mapping: string;
  readonly supported: boolean;
  readonly buttons: readonly boolean[];
  readonly axes: readonly number[];
}
export type GamepadInputEffect =
  | { readonly kind: "action"; readonly action: Exclude<GamepadAction, "none">; readonly phase: "press" | "release" | "cancel" }
  | { readonly kind: "skill"; readonly binding: GamepadSkillBinding }
  /** CSS-pixel distance for this sample. A zero vector ends an active scroll. */
  | { readonly kind: "scroll"; readonly x: number; readonly y: number };
export interface GamepadInputSample {
  readonly pads: readonly GamepadSample[];
  readonly preferences: GamepadPreferences;
  readonly active: boolean;
  readonly preview: boolean;
  readonly now: number;
}
export interface GamepadInputResult {
  readonly effects: readonly GamepadInputEffect[];
  readonly devices: readonly GamepadDeviceInfo[];
}
interface PadState {
  readonly identity: string;
  readonly armed: boolean[];
  readonly down: boolean[];
  readonly sticksArmed: boolean[];
}
interface ActiveControl {
  readonly binding: Exclude<GamepadBinding, "none">;
  readonly identity: string;
}
const DEAD_ZONE = 0.25;
const STICK_PRESS = 0.55;
const MAX_SCROLL_SPEED = 900;

/** Holds are owned by their physical control and are admitted only after a neutral sample. */
export class GamepadInputEngine {
  private pads = new Map<number, PadState>();
  private controls = new Map<string, ActiveControl>();
  private signature: string | undefined;
  private lastTime: number | undefined;
  private scrolling = false;
  private admitted = false;

  reset(): GamepadInputEffect[] {
    const effects: GamepadInputEffect[] = [];
    let voiceCancelled = false;
    for (const control of this.controls.values()) {
      if (typeof control.binding !== "string") continue;
      if (control.binding === "voice" && voiceCancelled) continue;
      effects.push({ kind: "action", action: control.binding, phase: "cancel" });
      if (control.binding === "voice") voiceCancelled = true;
    }
    if (this.scrolling) effects.push({ kind: "scroll", x: 0, y: 0 });
    this.pads.clear(); this.controls.clear(); this.scrolling = false;
    this.lastTime = undefined; this.admitted = false;
    return effects;
  }

  sample(input: GamepadInputSample): GamepadInputResult {
    const devices = input.pads.filter((pad) => pad.connected && Number.isInteger(pad.index) && pad.index >= 0).slice(0, 16).map(deviceInfo);
    const signature = JSON.stringify(input.preferences);
    const active = input.active && !input.preview && input.preferences.enabled && Number.isFinite(input.now);
    const effects: GamepadInputEffect[] = [];
    if (signature !== this.signature || !active || !this.admitted) effects.push(...this.reset());
    this.signature = signature;
    if (!active) return { devices, effects };
    this.admitted = true;
    const elapsed = this.lastTime === undefined ? 0 : Math.max(0, Math.min(50, input.now - this.lastTime));
    this.lastTime = input.now;
    const nextControls = new Map<string, ActiveControl>();
    const liveIdentities = new Set<string>();
    const liveIndexes = new Set<number>();
    let velocity = { x: 0, y: 0 };

    for (const device of devices) {
      if (!device.supported || liveIndexes.has(device.index)) continue;
      liveIndexes.add(device.index);
      const identity = `${device.index}:${device.id}`;
      liveIdentities.add(identity);
      const previous = this.pads.get(device.index);
      const state: PadState = previous?.identity === identity ? previous : {
        identity, armed: Array<boolean>(17).fill(false), down: Array<boolean>(17).fill(false), sticksArmed: [false, false]
      };
      this.pads.set(device.index, state);
      const pad = input.pads.find((candidate) => candidate.index === device.index && candidate.id.slice(0, 512) === device.id)!;
      for (let index = 0; index < 17; index += 1) {
        const button = pad.buttons[index]!;
        const down = index === 6 || index === 7
          ? button.value >= (state.down[index] ? 0.4 : 0.55)
          : button.pressed || button.value >= 0.55;
        state.down[index] = down;
        if (!down) state.armed[index] = true;
        if (down && state.armed[index]) addControl(nextControls, `${identity}:button:${index}`, input.preferences.buttons[index]!, identity);
      }
      for (const [index, setting] of [input.preferences.leftStick, input.preferences.rightStick].entries()) {
        const x = device.axes[index * 2]!;
        const y = device.axes[index * 2 + 1]!;
        const magnitude = Math.hypot(x, y);
        if (magnitude <= DEAD_ZONE) state.sticksArmed[index] = true;
        if (!state.sticksArmed[index]) continue;
        if (setting.mode === "commands" && magnitude >= STICK_PRESS) {
          const direction: GamepadDirection = Math.abs(y) >= Math.abs(x) ? y < 0 ? "up" : "down" : x < 0 ? "left" : "right";
          addControl(nextControls, `${identity}:stick:${index}:${direction}`, setting.directions[direction], identity);
        } else if (setting.mode === "scroll" && magnitude > DEAD_ZONE) {
          const intensity = Math.min(1, (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE));
          const candidate = { x: x / magnitude * intensity, y: y / magnitude * intensity };
          if (Math.hypot(candidate.x, candidate.y) > Math.hypot(velocity.x, velocity.y)) velocity = candidate;
        }
      }
    }
    for (const index of this.pads.keys()) if (!liveIndexes.has(index)) this.pads.delete(index);
    let hadVoice = false;
    let hasVoice = false;
    let voiceInterrupted = false;
    for (const [key, old] of this.controls) {
      if (old.binding === "voice") {
        hadVoice = true;
        if (!liveIdentities.has(old.identity)) voiceInterrupted = true;
      } else if (!nextControls.has(key) && typeof old.binding === "string") {
        effects.push({ kind: "action", action: old.binding, phase: liveIdentities.has(old.identity) ? "release" : "cancel" });
      }
    }
    for (const [key, next] of nextControls) {
      if (next.binding === "voice") hasVoice = true;
      else if (!this.controls.has(key)) {
        if (typeof next.binding === "string") effects.push({ kind: "action", action: next.binding, phase: "press" });
        else effects.push({ kind: "skill", binding: next.binding });
      }
    }
    if (!hadVoice && hasVoice) effects.push({ kind: "action", action: "voice", phase: "press" });
    if (hadVoice && !hasVoice) effects.push({ kind: "action", action: "voice", phase: voiceInterrupted ? "cancel" : "release" });
    this.controls = nextControls;
    const scrolling = velocity.x !== 0 || velocity.y !== 0;
    if (scrolling) effects.push({ kind: "scroll", x: velocity.x * MAX_SCROLL_SPEED * elapsed / 1_000, y: velocity.y * MAX_SCROLL_SPEED * elapsed / 1_000 });
    else if (this.scrolling) effects.push({ kind: "scroll", x: 0, y: 0 });
    this.scrolling = scrolling;
    return { devices, effects };
  }
}

function addControl(controls: Map<string, ActiveControl>, key: string, binding: GamepadBinding, identity: string): void {
  if (binding !== "none") controls.set(key, { binding, identity });
}
function deviceInfo(pad: GamepadSample): GamepadDeviceInfo {
  const valid = pad.buttons.length >= 17 && pad.axes.length >= 4
    && Array.from(pad.buttons.slice(0, 17)).every((button) => button !== undefined && typeof button.pressed === "boolean" && Number.isFinite(button.value) && button.value >= 0 && button.value <= 1)
    && Array.from(pad.axes.slice(0, 4)).every((axis) => Number.isFinite(axis) && axis >= -1 && axis <= 1);
  return {
    index: pad.index, id: pad.id.slice(0, 512), mapping: pad.mapping,
    supported: pad.mapping === "standard" && valid,
    buttons: Array.from({ length: 17 }, (_, index) => pad.buttons[index]?.pressed === true || (pad.buttons[index]?.value ?? 0) >= 0.55),
    axes: Array.from({ length: 4 }, (_, index) => Number.isFinite(pad.axes[index]) ? Math.max(-1, Math.min(1, pad.axes[index]!)) : 0)
  };
}
