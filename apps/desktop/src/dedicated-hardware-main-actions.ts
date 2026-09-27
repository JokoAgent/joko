import {
  DedicatedHardwareActionRouter,
  type DedicatedHardwareCancellationReason,
  type DedicatedHardwareHeldCancellation,
  type DedicatedHardwareRouteTarget
} from "./dedicated-hardware-action/router.js";
import type { DedicatedHardwareActionEvent } from "./dedicated-hardware-action/actions.js";
import {
  isDedicatedHardwareVoiceRoutedEvent,
  type DedicatedHardwareRoutedActionEvent,
  type DedicatedHardwareVoiceRoutedEvent
} from "./dedicated-hardware-action/routed-actions.js";
import type { SystemFrontmostInputController } from "./dedicated-hardware-action/system-frontmost-input.js";
import type { DedicatedHardwareModelId } from "./dedicated-hardware/settings.js";

export interface DedicatedHardwareSystemVoiceController {
  readonly handle: (event: DedicatedHardwareVoiceRoutedEvent) => boolean;
  readonly cancel: () => void;
}

export interface DedicatedHardwareMainActionRuntime<TWindow> {
  readonly handle: (model: DedicatedHardwareModelId, event: DedicatedHardwareActionEvent) => boolean;
  readonly cancelAll: (reason: DedicatedHardwareCancellationReason) => void;
  readonly retireWindow: (window: TWindow) => void;
}

/**
 * Delivers already parsed physical actions. Only one physical source may own a
 * held gesture at once; releases remain bound to the admitted model and route.
 */
export function createDedicatedHardwareMainActionRuntime<TWindow>(options: {
  readonly router: DedicatedHardwareActionRouter<TWindow>;
  readonly sendWindow: (window: TWindow, event: DedicatedHardwareRoutedActionEvent) => boolean;
  readonly systemInput?: SystemFrontmostInputController;
  readonly systemVoice: DedicatedHardwareSystemVoiceController;
}): DedicatedHardwareMainActionRuntime<TWindow> {
  let voiceModel: DedicatedHardwareModelId | undefined;
  let scrollModel: DedicatedHardwareModelId | undefined;

  const deliver = (
    target: DedicatedHardwareRouteTarget<TWindow>,
    event: DedicatedHardwareRoutedActionEvent
  ): boolean => {
    if (target.kind === "window") {
      try { return options.sendWindow(target.window, event); } catch { return false; }
    }
    if (target.capability === "voice") {
      if (!isDedicatedHardwareVoiceRoutedEvent(event)) return false;
      try { return options.systemVoice.handle(event); } catch { return false; }
    }
    if (isDedicatedHardwareVoiceRoutedEvent(event)) return false;
    try { return options.systemInput?.handle(event) === true; } catch { return false; }
  };

  const dispatchCancellation = (cancellation: DedicatedHardwareHeldCancellation<TWindow>): void => {
    deliver(cancellation.target, cancellation.event);
  };

  const releaseSource = (event: DedicatedHardwareActionEvent): void => {
    if (event.kind === "scroll") {
      if (event.phase === "release" || event.phase === "cancel") scrollModel = undefined;
      return;
    }
    if (event.action.kind === "voice" && (event.phase === "release" || event.phase === "cancel")) {
      if (!options.router.heldGestures().voice) voiceModel = undefined;
    }
  };

  const releaseUnheldSources = (): void => {
    const held = options.router.heldGestures();
    if (!held.voice) voiceModel = undefined;
    if (!held.scroll) scrollModel = undefined;
  };

  const runtime: DedicatedHardwareMainActionRuntime<TWindow> = {
    handle: (model, event) => {
      if (event.kind === "scroll") {
        if (event.phase === "press" && scrollModel !== undefined && scrollModel !== model) return false;
        if (event.phase !== "press" && scrollModel !== model) return false;
      } else if (event.action.kind === "voice") {
        if (event.phase === "press" && voiceModel !== undefined && voiceModel !== model) return false;
        if (event.phase !== "press" && voiceModel !== model) return false;
      }
      const route = options.router.route(event);
      if (route.kind === "drop") {
        releaseSource(event);
        return false;
      }
      const delivered = deliver(route.target, route.event);
      if (!delivered) {
        const owner = route.target.kind === "window" ? route.target.window : undefined;
        for (const cancellation of options.router.cancelHeld("capability-changed", owner)) {
          dispatchCancellation(cancellation);
        }
        // A failed toggle-finish press can retire the router's held voice even
        // though the physical event is not a release. Synchronize source
        // ownership with the router after every delivery-failure cancellation
        // so another model cannot remain locked out by a stale local owner.
        releaseUnheldSources();
        return false;
      }
      if (event.kind === "scroll" && event.phase === "press") scrollModel = model;
      if (event.kind === "button" && event.action.kind === "voice" && event.phase === "press") voiceModel = model;
      releaseSource(event);
      return true;
    },
    cancelAll: (reason) => {
      for (const cancellation of options.router.cancelHeld(reason)) dispatchCancellation(cancellation);
      voiceModel = undefined;
      scrollModel = undefined;
      options.systemInput?.cancel();
      options.systemVoice.cancel();
    },
    retireWindow: (window) => {
      for (const cancellation of options.router.retireWindow(window)) dispatchCancellation(cancellation);
      releaseUnheldSources();
    }
  };
  return Object.freeze(runtime);
}
