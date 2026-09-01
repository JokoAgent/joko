const ACTIVATION_WINDOW_MS = 120;
const RELEASE_GUARD_MS = 300;
const STORAGE_KEY = "joko.window.activationClick.v1";
const PREFERENCE_EVENT = "joko:window-activation-click-preference";

export type ActivationClickEventKind =
  | "blur"
  | "focus"
  | "pointerdown"
  | "mousedown"
  | "pointerup"
  | "mouseup"
  | "click";

export interface ActivationClickState {
  readonly handle: (kind: ActivationClickEventKind, nowMs: number) => boolean;
}

export function createActivationClickState(): ActivationClickState {
  let wasBlurred = false;
  let armedAt: number | undefined;
  let heldDown = false;
  let releaseGuardUntil: number | undefined;

  return Object.freeze({
    handle: (kind: ActivationClickEventKind, nowMs: number): boolean => {
      if (armedAt !== undefined && nowMs - armedAt > ACTIVATION_WINDOW_MS) armedAt = undefined;
      if (!heldDown && releaseGuardUntil !== undefined && nowMs > releaseGuardUntil) {
        releaseGuardUntil = undefined;
      }
      if (kind === "blur") {
        wasBlurred = true;
        armedAt = undefined;
        heldDown = false;
        releaseGuardUntil = undefined;
        return false;
      }
      if (kind === "focus") {
        if (wasBlurred) armedAt = nowMs;
        wasBlurred = false;
        return false;
      }
      if (kind === "pointerdown" || kind === "mousedown") {
        if (armedAt !== undefined) {
          heldDown = true;
          armedAt = undefined;
          releaseGuardUntil = undefined;
          return true;
        }
        if (heldDown && kind === "mousedown") return true;
        heldDown = false;
        releaseGuardUntil = undefined;
        return false;
      }
      if (kind === "pointerup" || kind === "mouseup") {
        if (heldDown) {
          heldDown = false;
          releaseGuardUntil = nowMs + RELEASE_GUARD_MS;
          return true;
        }
        return releaseGuardUntil !== undefined;
      }
      if (heldDown || releaseGuardUntil !== undefined) {
        heldDown = false;
        releaseGuardUntil = undefined;
        return true;
      }
      return false;
    }
  });
}

export interface ActivationClickInstallTarget {
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly platform: string;
  readonly now: () => number;
  readonly isEnabled: () => boolean;
}

const PRIMARY_MOUSE_EVENT_KINDS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click"
] as const;

export function installActivationClickGuard(target: ActivationClickInstallTarget): () => void {
  if (target.platform !== "win32") return () => undefined;
  const state = createActivationClickState();
  const registered: Array<{ readonly kind: string; readonly listener: EventListener; readonly capture: boolean }> = [];
  const add = (kind: string, listener: EventListener, capture: boolean): void => {
    target.window.addEventListener(kind, listener, capture);
    registered.push({ kind, listener, capture });
  };
  add("focus", () => {
    if (target.isEnabled()) state.handle("focus", target.now());
  }, false);
  add("blur", () => {
    if (target.isEnabled()) state.handle("blur", target.now());
  }, false);
  for (const kind of PRIMARY_MOUSE_EVENT_KINDS) {
    add(kind, (event) => {
      if ((event as MouseEvent).button !== 0 || !target.isEnabled()) return;
      if (!state.handle(kind, target.now())) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    }, true);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const item of registered) {
      target.window.removeEventListener(item.kind, item.listener, item.capture);
    }
  };
}

export function readActivationClickPreference(storage: Pick<Storage, "getItem"> = window.localStorage): boolean {
  try {
    return storage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeActivationClickPreference(
  enabled: boolean,
  targetWindow: Pick<Window, "localStorage" | "dispatchEvent"> = window
): void {
  try {
    targetWindow.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // The in-memory event still updates the current renderer when storage is blocked.
  }
  targetWindow.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: enabled }));
}

export function subscribeActivationClickPreference(
  listener: (enabled: boolean) => void,
  targetWindow: Pick<Window, "addEventListener" | "removeEventListener" | "localStorage"> = window
): () => void {
  const changed = (event: Event): void => {
    if (event instanceof CustomEvent && event.type === PREFERENCE_EVENT && typeof event.detail === "boolean") {
      listener(event.detail);
      return;
    }
    if (event instanceof StorageEvent && event.key !== STORAGE_KEY) return;
    listener(readActivationClickPreference(targetWindow.localStorage));
  };
  targetWindow.addEventListener(PREFERENCE_EVENT, changed);
  targetWindow.addEventListener("storage", changed);
  return () => {
    targetWindow.removeEventListener(PREFERENCE_EVENT, changed);
    targetWindow.removeEventListener("storage", changed);
  };
}

export function connectDesktopActivationClickPreference(
  desktop: JokoDesktopApi | undefined = window.jokoDesktop,
  targetWindow: Window = window
): () => void {
  if (desktop === undefined || !desktop.capabilities.includes("window.activationClick")) return () => undefined;
  const apply = (settings: { readonly swallowActivationClick: boolean }): void => {
    writeActivationClickPreference(settings.swallowActivationClick, targetWindow);
  };
  const unsubscribe = desktop.windowInteraction.onChanged(apply);
  void desktop.windowInteraction.get().then(apply).catch(() => undefined);
  return unsubscribe;
}

export function installCurrentWindowActivationClickGuard(targetWindow: Window = window): () => void {
  return installActivationClickGuard({
    window: targetWindow,
    platform: window.jokoDesktop?.platform ?? "",
    now: () => performance.now(),
    isEnabled: () => readActivationClickPreference(window.localStorage)
  });
}
