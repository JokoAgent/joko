import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  GamepadInputEngine, readGamepadPreferences, subscribeGamepadPreferences,
  type GamepadAction, type GamepadDeviceInfo, type GamepadInputEffect
} from "./gamepad-input.js";
import { isStartupUpdateInteractionBlocked } from "./startup-update-interaction.js";
import { currentGamepadTaskRoot, dispatchGamepadOwnedAction, isGamepadOwnedAction } from "./gamepad-actions.js";

export type GamepadClientStatus = "disabled" | "waiting" | "connected" | "unsupported" | "denied" | "error";
export interface GamepadClientSnapshot {
  readonly status: GamepadClientStatus;
  readonly devices: readonly GamepadDeviceInfo[];
}
const clients = new WeakMap<Window, GamepadClient>();

/** One sampler per Document; settings observes the same input used by the application. */
export class GamepadClient {
  private readonly engine = new GamepadInputEngine();
  private snapshot: GamepadClientSnapshot = { status: "disabled", devices: [] };
  private readonly listeners = new Set<() => void>();
  private frame: number | undefined;
  private emit: ((effect: GamepadInputEffect) => void) | undefined;
  private composing = false;
  private stopped = true;
  constructor(private readonly host: Window) {}
  getSnapshot = (): GamepadClientSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  reset = (): void => { for (const effect of this.engine.reset()) this.deliver(effect); };
  private deliver(effect: GamepadInputEffect): boolean {
    try { this.emit?.(effect); return true; } catch { return false; }
  }
  private publish(next: GamepadClientSnapshot): void {
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) { try { listener(); } catch { /* An observer cannot own the sampler. */ } }
  }
  start(emit: (effect: GamepadInputEffect) => void): () => void {
    if (!this.stopped) throw new Error("The document already owns a gamepad sampler.");
    this.emit = emit;
    this.stopped = false;
    this.composing = false;
    const tick = (now: number): void => {
      if (this.stopped) return;
      this.sample(now);
      if (!this.stopped) this.frame = this.host.requestAnimationFrame(tick);
    };
    const cancel = (): void => this.reset();
    const compose = (): void => { this.composing = true; cancel(); };
    const composed = (): void => { this.composing = false; cancel(); };
    const changed = subscribeGamepadPreferences(() => { cancel(); this.sample(this.host.performance.now()); }, this.host);
    this.host.addEventListener("blur", cancel);
    this.host.addEventListener("pagehide", cancel);
    this.host.addEventListener("gamepaddisconnected", cancel);
    this.host.document.addEventListener("visibilitychange", cancel);
    this.host.document.addEventListener("compositionstart", compose, true);
    this.host.document.addEventListener("compositionend", composed, true);
    this.sample(this.host.performance.now());
    this.frame = this.host.requestAnimationFrame(tick);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.stopped = true;
      this.composing = false;
      if (this.frame !== undefined) this.host.cancelAnimationFrame(this.frame);
      this.reset(); this.emit = undefined;
      changed();
      this.host.removeEventListener("blur", cancel);
      this.host.removeEventListener("pagehide", cancel);
      this.host.removeEventListener("gamepaddisconnected", cancel);
      this.host.document.removeEventListener("visibilitychange", cancel);
      this.host.document.removeEventListener("compositionstart", compose, true);
      this.host.document.removeEventListener("compositionend", composed, true);
    };
  }
  sample(now: number): void {
    const doc = this.host.document;
    let storage: Storage;
    try { storage = this.host.localStorage; }
    catch { this.reset(); this.publish({ status: "error", devices: [] }); return; }
    try {
      const preference = readGamepadPreferences(storage);
      if (preference.error !== undefined) {
        this.reset(); this.publish({ status: "error", devices: [] }); return;
      }
      if (typeof this.host.navigator.getGamepads !== "function") {
        this.reset(); this.publish({ status: "unsupported", devices: [] }); return;
      }
      const result = this.engine.sample({
        pads: Array.from(this.host.navigator.getGamepads()).filter((pad): pad is Gamepad => pad !== null),
        preferences: preference.preferences, now,
        active: doc.visibilityState === "visible" && doc.hasFocus() && !this.composing
          && doc.body.dataset.appShortcutRecording !== "1" && !isStartupUpdateInteractionBlocked(),
        preview: doc.querySelector("[data-gamepad-preview]") !== null
      });
      for (const effect of result.effects) {
        if (!this.deliver(effect)) { this.reset(); this.publish({ status: "error", devices: result.devices }); return; }
      }
      this.publish({
        devices: result.devices,
        status: !preference.preferences.enabled ? "disabled" : result.devices.length === 0 ? "waiting"
          : result.devices.some((device) => device.supported) ? "connected" : "unsupported"
      });
    } catch (error) {
      this.reset();
      this.publish({ status: error !== null && typeof error === "object" && "name" in error && error.name === "SecurityError" ? "denied" : "error", devices: [] });
    }
  }
}

export function gamepadClient(host: Window = window): GamepadClient {
  let client = clients.get(host);
  if (client === undefined) { client = new GamepadClient(host); clients.set(host, client); }
  return client;
}
export function useGamepadSnapshot(): GamepadClientSnapshot {
  const client = gamepadClient();
  const [snapshot, setSnapshot] = useState(client.getSnapshot);
  useEffect(() => client.subscribe(() => setSnapshot(client.getSnapshot())), [client]);
  return snapshot;
}

export const GAMEPAD_VOICE_EVENT = "joko:gamepad-voice";
export const GAMEPAD_SKILL_EVENT = "joko:gamepad-skill";
export const GAMEPAD_PANEL_EVENT = "joko:gamepad-panel";
export const GAMEPAD_SCROLL_EVENT = "joko:gamepad-scroll";
type VoicePhase = "press" | "release" | "cancel";

/** Holds the exact voice target until release, including after focus or route changes. */
export function createGamepadDomInput(doc: Document, action: (action: GamepadAction) => void): (effect: GamepadInputEffect) => void {
  let voiceTarget: Element | undefined;
  let scrollTarget: Element | null | undefined;
  const voice = (phase: VoicePhase): void => {
    voiceTarget?.dispatchEvent(new CustomEvent(GAMEPAD_VOICE_EVENT, { detail: phase }));
    if (phase !== "press") voiceTarget = undefined;
  };
  const scroll = (x: number, y: number, discrete = false): void => {
    if (x === 0 && y === 0) { scrollTarget = undefined; return; }
    if (doc.body.classList.contains("modal-open")) { scrollTarget = null; return; }
    const root = currentGamepadTaskRoot(doc);
    const timeline = root?.querySelector<HTMLElement>("[data-timeline-session-id]");
    if (!discrete) {
      if (scrollTarget === undefined) scrollTarget = timeline ?? null;
      if (scrollTarget !== timeline || scrollTarget?.isConnected !== true) { scrollTarget = null; return; }
    }
    timeline?.dispatchEvent(new CustomEvent(GAMEPAD_SCROLL_EVENT, { detail: { x, y } }));
  };
  return (effect) => {
    if (effect.kind === "scroll") { scroll(effect.x, effect.y); return; }
    if (effect.kind === "skill") {
      if (doc.body.classList.contains("modal-open")) return;
      const root = currentGamepadTaskRoot(doc);
      root?.querySelector("[data-gamepad-skill]")?.dispatchEvent(new CustomEvent(GAMEPAD_SKILL_EVENT, { detail: effect.binding }));
      return;
    }
    if (effect.action === "voice") {
      if (effect.phase !== "press") { voice(effect.phase); return; }
      if (doc.body.classList.contains("modal-open")) return;
      const root = currentGamepadTaskRoot(doc);
      voiceTarget = root?.querySelector("[data-gamepad-voice]") ?? undefined;
      voice("press"); return;
    }
    if (effect.phase !== "press") return;
    if (isGamepadOwnedAction(effect.action)) { dispatchGamepadOwnedAction(doc, effect.action); return; }
    const focused = doc.activeElement;
    if (focused?.closest("[hidden], [inert], [aria-hidden='true']") !== null && focused !== null) return;
    if (effect.action === "back") {
      focused?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      return;
    }
    if (effect.action === "activate") {
      if (focused instanceof HTMLElement && focused.matches("button:not(:disabled), [role='button']:not([aria-disabled='true'])")) focused.click();
      return;
    }
    if (doc.body.classList.contains("modal-open")) return;
    if (effect.action === "focus-composer") {
      currentGamepadTaskRoot(doc)?.querySelector<HTMLElement>("[data-composer-editor='true']")?.focus(); return;
    }
    if (effect.action === "scroll-up" || effect.action === "scroll-down") {
      scroll(0, effect.action === "scroll-up" ? -240 : 240, true); return;
    }
    if (effect.action === "previous-panel" || effect.action === "next-panel") {
      doc.defaultView?.dispatchEvent(new CustomEvent(GAMEPAD_PANEL_EVENT, { detail: effect.action === "previous-panel" ? -1 : 1 })); return;
    }
    action(effect.action);
  };
}

export function useGamepadInput(ownerKey: string, onAction: (action: GamepadAction) => void): void {
  const actionRef = useRef(onAction); actionRef.current = onAction;
  useEffect(() => gamepadClient().start(createGamepadDomInput(document, (action) => actionRef.current(action))), []);
  useLayoutEffect(() => { gamepadClient().reset(); }, [ownerKey]);
}

export function useGamepadVoiceInput(root: HTMLElement | undefined, scope: object, options: {
  readonly enabled: boolean; readonly isActive: () => boolean;
  readonly getCaptureIdentity: () => object | undefined;
  readonly start: () => boolean; readonly finish: () => Promise<unknown>; readonly cancel: () => void;
}): void {
  const current = useRef(options); current.current = options;
  useLayoutEffect(() => {
    if (root === undefined) return;
    let owned: { readonly origin: typeof options; readonly capture: object } | undefined;
    root.dataset.gamepadVoice = "true";
    const cancel = (): void => {
      const press = owned; owned = undefined;
      if (press !== undefined && press.origin.getCaptureIdentity() === press.capture) press.origin.cancel();
    };
    const receive = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      if (event.detail === "press" && owned === undefined && current.current.enabled && !current.current.isActive()) {
        const origin = current.current;
        if (origin.start()) {
          const capture = origin.getCaptureIdentity();
          if (capture !== undefined) owned = { origin, capture };
        }
      } else if (event.detail === "release" && owned !== undefined) {
        const press = owned; owned = undefined;
        if (press.origin.getCaptureIdentity() !== press.capture) return;
        void press.origin.finish().catch(() => {
          if (press.origin.getCaptureIdentity() === press.capture) press.origin.cancel();
        });
      } else if (event.detail === "cancel") cancel();
    };
    root.addEventListener(GAMEPAD_VOICE_EVENT, receive);
    return () => { cancel(); delete root.dataset.gamepadVoice; root.removeEventListener(GAMEPAD_VOICE_EVENT, receive); };
  }, [root, scope, options.enabled]);
}
