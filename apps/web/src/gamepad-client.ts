import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  GamepadInputEngine, readGamepadPreferences, subscribeGamepadPreferences,
  type GamepadAction, type GamepadDeviceInfo, type GamepadInputEffect
} from "./gamepad-input.js";
import {
  nativeGamepadSamples, parseNativeGamepadSnapshot,
  type NativeGamepadBridge, type NativeGamepadClientState, type NativeGamepadSnapshot
} from "./native-gamepad.js";
import { isStartupUpdateInteractionBlocked } from "./startup-update-interaction.js";
import { currentGamepadTaskRoot, dispatchGamepadOwnedAction, isGamepadInspectorAction, isGamepadOwnedAction } from "./gamepad-actions.js";
import { dispatchAppInputFocusedCommand } from "./app-input-owners.js";

export type GamepadClientStatus = "disabled" | "waiting" | "connected" | "unsupported" | "denied" | "error";
export interface GamepadClientSnapshot {
  readonly status: GamepadClientStatus;
  readonly devices: readonly GamepadDeviceInfo[];
  readonly nativeFallback?: "unavailable" | "error";
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
  private generation = 0;
  private pageActive = true;
  private inputSource: "native" | "browser" | undefined;
  private nativeSnapshot: NativeGamepadSnapshot | undefined;
  private nativeFallback: "unavailable" | "error" | undefined;
  private nativeInterest: string | undefined;
  private nativeInterestState: NativeGamepadClientState | undefined;
  private nativeInterestFailed = false;
  private nativeInterestPending = false;
  private nativeInterestRetryAt = 0;
  private nativeInterestRetryDelay = 250;
  private nativeInterestRetryTimer: number | undefined;
  private nativeInterestRequest = 0;
  private nativeUnsubscribe: (() => void) | undefined;
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
  private hasNativeCapability(): boolean {
    return this.host.jokoDesktop?.capabilities.includes("hardware.nativeGamepad") === true;
  }
  private nativeBridge(): NativeGamepadBridge | undefined {
    return this.hasNativeCapability() ? this.host.jokoDesktop?.nativeGamepad : undefined;
  }
  private selectInputSource(source: "native" | "browser"): void {
    if (this.inputSource === source) return;
    this.reset();
    this.inputSource = source;
  }
  private failNative(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.nativeFallback = "error";
    this.sample(this.host.performance.now());
  }
  private acceptNative(value: unknown, generation: number): boolean {
    const parsed = parseNativeGamepadSnapshot(value);
    if (this.stopped || generation !== this.generation) return parsed !== undefined;
    if (parsed === undefined) { this.failNative(generation); return false; }
    if (this.nativeSnapshot !== undefined && parsed.revision < this.nativeSnapshot.revision) return true;
    this.nativeSnapshot = parsed;
    this.nativeFallback = parsed.status === "unavailable" || parsed.status === "error" ? parsed.status : undefined;
    this.sample(this.host.performance.now());
    return true;
  }
  private invokeNative(request: () => Promise<unknown>, generation: number): void {
    try {
      void Promise.resolve(request()).then((value) => this.acceptNative(value, generation), () => this.failNative(generation));
    } catch { this.failNative(generation); }
  }
  private clearNativeInterestRetry(): void {
    if (this.nativeInterestRetryTimer === undefined) return;
    this.host.clearTimeout(this.nativeInterestRetryTimer);
    this.nativeInterestRetryTimer = undefined;
  }
  private setNativeClientState(state: NativeGamepadClientState, generation: number, force = false): void {
    const bridge = this.nativeBridge();
    if (bridge === undefined) return;
    const identity = `${state.enabled ? 1 : 0}:${state.preview ? 1 : 0}`;
    const now = this.host.performance.now();
    if (!force && identity === this.nativeInterest
      && (this.nativeInterestPending || !this.nativeInterestFailed || now < this.nativeInterestRetryAt)) return;
    if (identity !== this.nativeInterest) {
      this.clearNativeInterestRetry();
      this.nativeInterestFailed = false;
      this.nativeInterestRetryDelay = 250;
    } else if (force) {
      this.clearNativeInterestRetry();
    }
    this.nativeInterest = identity;
    this.nativeInterestState = state;
    this.nativeInterestPending = true;
    const request = ++this.nativeInterestRequest;
    let response: Promise<unknown>;
    try { response = bridge.setClientState(state); }
    catch { this.nativeClientStateFailed(identity, generation, request); return; }
    void Promise.resolve(response).then((value) => {
      if (!this.stopped && generation === this.generation && this.nativeInterest === identity && this.nativeInterestRequest === request) {
        this.clearNativeInterestRetry();
        this.nativeInterestPending = false;
        this.nativeInterestFailed = false;
        this.nativeInterestRetryAt = 0;
        this.nativeInterestRetryDelay = 250;
      }
      if (!this.acceptNative(value, generation)) { this.nativeClientStateFailed(identity, generation, request); return; }
      if (!this.stopped && generation === this.generation && this.nativeInterest === identity && this.nativeInterestRequest === request) {
        this.sample(this.host.performance.now());
      }
    }, () => this.nativeClientStateFailed(identity, generation, request));
  }
  private nativeClientStateFailed(identity: string, generation: number, request: number): void {
    if (this.stopped || generation !== this.generation || this.nativeInterest !== identity || this.nativeInterestRequest !== request) return;
    this.nativeInterestPending = false;
    this.nativeInterestFailed = true;
    const delay = this.nativeInterestRetryDelay;
    this.nativeInterestRetryAt = this.host.performance.now() + delay;
    this.nativeInterestRetryDelay = Math.min(4_000, this.nativeInterestRetryDelay * 2);
    this.clearNativeInterestRetry();
    this.nativeInterestRetryTimer = this.host.setTimeout(() => {
      this.nativeInterestRetryTimer = undefined;
      if (this.stopped || generation !== this.generation || this.nativeInterest !== identity || !this.nativeInterestFailed) return;
      const desired = this.nativeInterestState;
      if (desired !== undefined) this.setNativeClientState(desired, generation, true);
    }, delay);
    this.failNative(generation);
  }
  async probe(): Promise<void> {
    this.reset();
    const bridge = this.nativeBridge();
    if (bridge === undefined) { this.sample(this.host.performance.now()); return; }
    const generation = this.generation;
    try {
      const value = await bridge.probe();
      const retryInterest = this.nativeInterestFailed;
      if (retryInterest) this.clearNativeInterestRetry();
      this.nativeInterestRetryAt = 0;
      if (this.acceptNative(value, generation) && retryInterest && this.nativeInterestFailed) this.sample(this.host.performance.now());
    }
    catch { this.failNative(generation); }
  }
  start(emit: (effect: GamepadInputEffect) => void): () => void {
    if (!this.stopped) throw new Error("The document already owns a gamepad sampler.");
    this.emit = emit;
    this.stopped = false;
    this.composing = false;
    this.pageActive = true;
    this.inputSource = undefined;
    this.nativeSnapshot = undefined;
    this.nativeFallback = this.hasNativeCapability() && this.nativeBridge() === undefined ? "error" : undefined;
    this.nativeInterest = undefined;
    this.nativeInterestState = undefined;
    this.nativeInterestFailed = false;
    this.nativeInterestPending = false;
    this.nativeInterestRetryAt = 0;
    this.nativeInterestRetryDelay = 250;
    this.clearNativeInterestRetry();
    const generation = ++this.generation;
    const tick = (now: number): void => {
      if (this.stopped) return;
      this.sample(now);
      if (!this.stopped) this.frame = this.host.requestAnimationFrame(tick);
    };
    const cancel = (): void => this.reset();
    const compose = (): void => { this.composing = true; cancel(); };
    const composed = (): void => { this.composing = false; cancel(); };
    const hidden = (): void => {
      this.pageActive = false;
      cancel();
      this.setNativeClientState({ version: 1, enabled: false, preview: false }, generation, true);
    };
    const shown = (): void => { this.pageActive = true; this.sample(this.host.performance.now()); };
    const changed = subscribeGamepadPreferences(() => { cancel(); this.sample(this.host.performance.now()); }, this.host);
    const bridge = this.nativeBridge();
    if (bridge !== undefined) {
      try { this.nativeUnsubscribe = bridge.onSnapshot((value) => this.acceptNative(value, generation)); }
      catch { this.failNative(generation); }
      this.invokeNative(() => bridge.getSnapshot(), generation);
    }
    this.host.addEventListener("blur", cancel);
    this.host.addEventListener("pagehide", hidden);
    this.host.addEventListener("pageshow", shown);
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
      this.setNativeClientState({ version: 1, enabled: false, preview: false }, generation, true);
      this.stopped = true;
      this.generation += 1;
      this.clearNativeInterestRetry();
      this.composing = false;
      if (this.frame !== undefined) this.host.cancelAnimationFrame(this.frame);
      this.reset(); this.emit = undefined;
      try { this.nativeUnsubscribe?.(); } catch { /* A bridge listener cannot retain this Document. */ }
      this.nativeUnsubscribe = undefined;
      changed();
      this.host.removeEventListener("blur", cancel);
      this.host.removeEventListener("pagehide", hidden);
      this.host.removeEventListener("pageshow", shown);
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
    catch {
      this.setNativeClientState({ version: 1, enabled: false, preview: false }, this.generation);
      this.reset(); this.publish({ status: "error", devices: [], ...(this.nativeFallback === undefined ? {} : { nativeFallback: this.nativeFallback }) }); return;
    }
    try {
      const preference = readGamepadPreferences(storage);
      if (preference.error !== undefined) {
        this.setNativeClientState({ version: 1, enabled: false, preview: false }, this.generation);
        this.reset(); this.publish({ status: "error", devices: [], ...(this.nativeFallback === undefined ? {} : { nativeFallback: this.nativeFallback }) }); return;
      }
      const preview = doc.querySelector("[data-gamepad-preview]") !== null;
      this.setNativeClientState({
        version: 1,
        enabled: this.pageActive && preference.preferences.enabled,
        preview: this.pageActive && preview
      }, this.generation);
      const bridge = this.nativeBridge();
      const nativeFallback = this.hasNativeCapability()
        ? (this.nativeInterestFailed ? "error" : this.nativeFallback ?? (bridge === undefined ? "error" : undefined))
        : undefined;
      const useNative = bridge !== undefined && nativeFallback === undefined;
      this.selectInputSource(useNative ? "native" : "browser");
      if (!useNative && typeof this.host.navigator.getGamepads !== "function") {
        this.reset(); this.publish({ status: "unsupported", devices: [], ...(nativeFallback === undefined ? {} : { nativeFallback }) }); return;
      }
      const pads = useNative
        ? this.nativeSnapshot === undefined ? [] : nativeGamepadSamples(this.nativeSnapshot)
        : Array.from(this.host.navigator.getGamepads()).filter((pad): pad is Gamepad => pad !== null);
      const result = this.engine.sample({
        pads,
        preferences: preference.preferences, now,
        active: this.pageActive && doc.visibilityState === "visible" && doc.hasFocus() && !this.composing
          && doc.body.dataset.appShortcutRecording !== "1" && !isStartupUpdateInteractionBlocked(),
        preview
      });
      for (const effect of result.effects) {
        if (!this.deliver(effect)) {
          this.reset(); this.publish({ status: "error", devices: result.devices, ...(nativeFallback === undefined ? {} : { nativeFallback }) }); return;
        }
      }
      this.publish({
        devices: result.devices,
        status: !preference.preferences.enabled ? "disabled" : result.devices.length === 0 ? "waiting"
          : result.devices.some((device) => device.supported) ? "connected" : "unsupported",
        ...(nativeFallback === undefined ? {} : { nativeFallback })
      });
    } catch (error) {
      this.reset();
      this.publish({
        status: error !== null && typeof error === "object" && "name" in error && error.name === "SecurityError" ? "denied" : "error",
        devices: [], ...(this.nativeFallback === undefined ? {} : { nativeFallback: this.nativeFallback })
      });
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
      dispatchAppInputFocusedCommand(doc, "back");
      return;
    }
    if (effect.action === "activate") {
      dispatchAppInputFocusedCommand(doc, "activate");
      return;
    }
    if (doc.body.classList.contains("modal-open")) return;
    if ((effect.action === "open-skills" || effect.action === "open-schedules" || effect.action === "open-folder" || effect.action === "feedback" || effect.action === "navigate-back"
      || effect.action === "navigate-forward" || effect.action === "toggle-fullscreen" || isGamepadInspectorAction(effect.action)) && (doc.body.dataset.appShortcutRecording === "1"
      || doc.querySelector("[role='listbox']") !== null
      || focused !== null && (focused.matches("iframe, webview, object, embed")
        || focused.closest("[data-gamepad-preview], [data-message-rewind-preview], [role='dialog'], [role='menu'], [role='listbox']") !== null))) return;
    if (effect.action === "feedback" && (doc.defaultView === null || doc.defaultView.top !== doc.defaultView)) return;
    if ((effect.action === "navigate-back" || effect.action === "navigate-forward" || effect.action === "toggle-fullscreen" || effect.action === "open-folder" || effect.action === "feedback")
      && (doc.visibilityState !== "visible" || !doc.hasFocus() || doc.querySelector("[data-gamepad-preview]") !== null)) return;
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
