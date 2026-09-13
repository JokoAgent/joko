import { useEffect, useRef } from "react";

import {
  currentAppShortcutPlatform,
  effectiveAppShortcutCombos,
  matchesAppShortcutEvent,
  type AppShortcutId,
  type AppShortcutOverrides,
  type AppShortcutPlatform
} from "./app-shortcuts.js";
import { isStartupUpdateInteractionBlocked } from "./startup-update-interaction.js";

type AppShortcutHandler = (event: KeyboardEvent) => boolean;

interface AppShortcutListenerOptions {
  readonly getCombos: () => ReturnType<typeof effectiveAppShortcutCombos>;
  readonly getHandler: () => AppShortcutHandler;
  readonly isRecording?: () => boolean;
  readonly stopImmediate?: boolean;
}

/** Exported for deterministic hot-update and event-ownership tests. */
export function createAppShortcutKeydownListener(options: AppShortcutListenerOptions): (event: KeyboardEvent) => void {
  return (event) => {
    if (isStartupUpdateInteractionBlocked()) return;
    if (event.defaultPrevented || event.repeat || event.isComposing || options.isRecording?.() === true) return;
    if (!options.getCombos().some((combo) => matchesAppShortcutEvent(event, combo))) return;
    if (!options.getHandler()(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (options.stopImmediate === true) event.stopImmediatePropagation();
  };
}

export interface UseAppShortcutOptions {
  readonly enabled?: boolean;
  readonly stopImmediate?: boolean;
  readonly platform?: AppShortcutPlatform;
  readonly target?: Window | Document | null;
}

/**
 * Consume one registry shortcut during capture. The current handler and
 * effective combinations live in refs so preference changes take effect on
 * the next keydown without tearing down or reordering capture listeners.
 */
export function useAppShortcut(
  id: AppShortcutId,
  overrides: AppShortcutOverrides | undefined,
  handler: AppShortcutHandler,
  options: UseAppShortcutOptions = {}
): void {
  const { enabled = true, stopImmediate = false, target = null } = options;
  const platform = options.platform ?? currentAppShortcutPlatform();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const combosRef = useRef(effectiveAppShortcutCombos(id, overrides, platform));
  combosRef.current = effectiveAppShortcutCombos(id, overrides, platform);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const eventTarget = target ?? window;
    const listener = createAppShortcutKeydownListener({
      getCombos: () => combosRef.current,
      getHandler: () => handlerRef.current,
      isRecording: () => typeof document !== "undefined" && document.body.dataset.appShortcutRecording === "1",
      stopImmediate
    });
    eventTarget.addEventListener("keydown", listener as EventListener, true);
    return () => eventTarget.removeEventListener("keydown", listener as EventListener, true);
  }, [enabled, stopImmediate, target]);
}
