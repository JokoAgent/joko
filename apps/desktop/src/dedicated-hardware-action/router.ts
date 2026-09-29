import type { DedicatedHardwareActionEvent } from "./actions.js";
import type {
  DedicatedHardwareRoutedActionEvent,
  DedicatedHardwareVoiceActivationKind,
  DedicatedHardwareVoiceReleaseKind,
  DedicatedHardwareVoiceRoutedEvent
} from "./routed-actions.js";

export type SystemFrontmostInputCapability = "voice" | "return" | "scroll";
export type SystemFrontmostCapabilityState =
  | "available"
  | "unsupported"
  | "permission-denied"
  | "unknown";

export interface DedicatedHardwareSystemFrontmostCapabilities {
  readonly voice: SystemFrontmostCapabilityState;
  readonly return: SystemFrontmostCapabilityState;
  readonly scroll: SystemFrontmostCapabilityState;
}

export type DedicatedHardwareRouteTarget<TWindow> =
  | { readonly kind: "window"; readonly window: TWindow }
  | {
    readonly kind: "system-frontmost";
    readonly capability: SystemFrontmostInputCapability;
  };

export type DedicatedHardwareRouteDropReason =
  | "inactive-phase"
  | "duplicate-press"
  | "missing-press"
  | "primary-window-unavailable"
  | "focused-window-unavailable"
  | "system-capability-unavailable"
  | "held-owner-retired"
  | "activation-identity-exhausted";

export type DedicatedHardwareRoute<TWindow> =
  | {
    readonly kind: "route";
    readonly target: DedicatedHardwareRouteTarget<TWindow>;
    readonly event: DedicatedHardwareRoutedActionEvent;
  }
  | {
    readonly kind: "drop";
    readonly reason: DedicatedHardwareRouteDropReason;
    readonly event: DedicatedHardwareActionEvent;
  };

export type DedicatedHardwareCancellationReason =
  | "disabled"
  | "disconnected"
  | "layout-changed"
  | "preview-entered"
  | "suspended"
  | "host-crashed"
  | "window-retired"
  | "owner-changed"
  | "capability-changed";

export interface DedicatedHardwareHeldCancellation<TWindow> {
  readonly gesture: "voice" | "scroll";
  readonly reason: DedicatedHardwareCancellationReason;
  /** The original owner is retained only for a best-effort cancellation; it is never re-resolved. */
  readonly target: DedicatedHardwareRouteTarget<TWindow>;
  readonly event: DedicatedHardwareRoutedActionEvent;
}

export interface DedicatedHardwareActionRouterDependencies<TWindow> {
  /** Focused window in this Joko process, or null while another application is frontmost. */
  readonly getFocusedWindow: () => TWindow | null;
  readonly getPrimaryWindow: () => TWindow | null;
  /** Must accept only exact trusted Joko main/task windows. */
  readonly isJokoActionWindow: (window: TWindow) => boolean;
  /** Loading, destroyed, or otherwise unready windows must return false. */
  readonly isWindowReady: (window: TWindow) => boolean;
  readonly getSystemFrontmostCapabilities: () => DedicatedHardwareSystemFrontmostCapabilities;
}

type HeldTarget<TWindow> = DedicatedHardwareRouteTarget<TWindow>;
interface VoiceRouteOwner<TWindow> {
  readonly target: HeldTarget<TWindow>;
  readonly ownerActivationId: string;
  activation: {
    readonly activationId: string;
    readonly activationKind: DedicatedHardwareVoiceActivationKind;
    readonly pressedAt: number;
  } | undefined;
}
type FocusedWindowResolution<TWindow> =
  | { readonly kind: "ready"; readonly window: TWindow }
  | { readonly kind: "outside-application" }
  | { readonly kind: "blocked" };

const TASK_SWITCH_COMMANDS = new Set(["previous-task", "next-task"]);
const MAX_VOICE_ACTIVATION_ID = (10n ** 64n) - 1n;

/**
 * Resolves actions without importing Electron. Focus is sampled only for a new
 * activation. Voice and continuous scroll retain that exact owner until their
 * release or an explicit lifecycle cancellation. Voice duration is classified
 * exactly once here; renderer and native consumers execute the routed result.
 */
export class DedicatedHardwareActionRouter<TWindow> {
  readonly #dependencies: DedicatedHardwareActionRouterDependencies<TWindow>;
  readonly #now: () => number;
  readonly #voiceHoldDelayMs: number;
  #nextVoiceActivationId = 0n;
  #voiceOwner: VoiceRouteOwner<TWindow> | undefined;
  #scrollTarget: HeldTarget<TWindow> | undefined;

  constructor(
    dependencies: DedicatedHardwareActionRouterDependencies<TWindow>,
    options: Readonly<{ now?: () => number; voiceHoldDelayMs?: number }> = {}
  ) {
    const voiceHoldDelayMs = options.voiceHoldDelayMs ?? 450;
    if (!Number.isFinite(voiceHoldDelayMs) || voiceHoldDelayMs < 0) {
      throw new TypeError("Dedicated hardware voice hold delay is invalid.");
    }
    this.#dependencies = dependencies;
    this.#now = options.now ?? Date.now;
    this.#voiceHoldDelayMs = voiceHoldDelayMs;
  }

  route(event: DedicatedHardwareActionEvent): DedicatedHardwareRoute<TWindow> {
    if (event.kind === "scroll") return this.#routeScroll(event);
    if (event.action.kind === "voice") return this.#routeVoice(event);

    if (event.phase !== "press") return drop(event, "inactive-phase");
    if (event.action.kind === "task"
      || (event.action.kind === "command" && TASK_SWITCH_COMMANDS.has(event.action.command))) {
      // Task navigation is owned by the primary window, but it is never a
      // global action. A trusted Joko window must still own focus at press.
      if (this.#focusedWindowResolution().kind !== "ready") {
        return drop(event, "focused-window-unavailable");
      }
      const primary = this.#primaryWindow();
      return primary === null
        ? drop(event, "primary-window-unavailable")
        : routed(nonVoiceEvent(event), { kind: "window", window: primary });
    }

    const focused = this.#focusedWindowResolution();
    if (focused.kind === "ready") return routed(nonVoiceEvent(event), { kind: "window", window: focused.window });

    if (focused.kind === "outside-application"
      && event.action.kind === "command"
      && event.action.command === "submit") {
      return this.#systemCapability("return") === "available"
        ? routed(nonVoiceEvent(event), { kind: "system-frontmost", capability: "return" })
        : drop(event, "system-capability-unavailable");
    }

    // Skills, composer text, fixed links, and all other commands are renderer-only.
    return drop(event, "focused-window-unavailable");
  }

  cancelHeld(
    reason: DedicatedHardwareCancellationReason,
    ownerWindow?: TWindow
  ): readonly DedicatedHardwareHeldCancellation<TWindow>[] {
    const cancellations: DedicatedHardwareHeldCancellation<TWindow>[] = [];
    if (this.#voiceOwner !== undefined && targetMatchesWindow(this.#voiceOwner.target, ownerWindow)) {
      const voiceOwner = this.#voiceOwner;
      const target = voiceOwner.target;
      this.#voiceOwner = undefined;
      cancellations.push(Object.freeze({
        gesture: "voice",
        reason,
        target,
        event: voiceCancellationEvent(voiceOwner)
      }));
    }
    if (this.#scrollTarget !== undefined && targetMatchesWindow(this.#scrollTarget, ownerWindow)) {
      const target = this.#scrollTarget;
      this.#scrollTarget = undefined;
      cancellations.push(Object.freeze({
        gesture: "scroll",
        reason,
        target,
        event: scrollEndEvent("cancel")
      }));
    }
    return Object.freeze(cancellations);
  }

  retireWindow(window: TWindow): readonly DedicatedHardwareHeldCancellation<TWindow>[] {
    return this.cancelHeld("window-retired", window);
  }

  heldGestures(): Readonly<{ voice: boolean; scroll: boolean }> {
    return Object.freeze({
      voice: this.#voiceOwner !== undefined,
      scroll: this.#scrollTarget !== undefined
    });
  }

  #routeVoice(event: Extract<DedicatedHardwareActionEvent, { kind: "button" }>): DedicatedHardwareRoute<TWindow> {
    if (event.phase === "press") {
      const existing = this.#voiceOwner;
      if (existing !== undefined) {
        if (existing.activation !== undefined) return drop(event, "duplicate-press");
        if (existing.target.kind === "window" && !this.#usableWindow(existing.target.window)) {
          this.#voiceOwner = undefined;
          return drop(event, "held-owner-retired");
        }
        const activationId = this.#newVoiceActivationId();
        if (activationId === undefined) return drop(event, "activation-identity-exhausted");
        existing.activation = {
          activationId,
          activationKind: "toggle-finish",
          pressedAt: this.#safeNow()
        };
        return routed(voicePressEvent(existing), existing.target);
      }
      const resolution = this.#newHeldTarget("voice");
      if (resolution.target === undefined) return drop(event, resolution.reason);
      const activationId = this.#newVoiceActivationId();
      if (activationId === undefined) return drop(event, "activation-identity-exhausted");
      this.#voiceOwner = {
        target: resolution.target,
        ownerActivationId: activationId,
        activation: {
          activationId,
          activationKind: "start",
          pressedAt: this.#safeNow()
        }
      };
      return routed(voicePressEvent(this.#voiceOwner), resolution.target);
    }
    const owner = this.#voiceOwner;
    const activation = owner?.activation;
    if (owner === undefined || activation === undefined) return drop(event, "missing-press");
    const target = owner.target;
    if (target.kind === "window" && !this.#usableWindow(target.window)) {
      this.#voiceOwner = undefined;
      return drop(event, "held-owner-retired");
    }
    const releaseKind: DedicatedHardwareVoiceReleaseKind = event.phase === "cancel"
      ? "cancel"
      : Math.max(0, this.#safeNow() - activation.pressedAt) >= this.#voiceHoldDelayMs ? "hold" : "tap";
    owner.activation = undefined;
    if (releaseKind !== "tap" || activation.activationKind === "toggle-finish") this.#voiceOwner = undefined;
    return routed(voiceCompletionEvent(owner, activation, releaseKind), target);
  }

  #routeScroll(event: Extract<DedicatedHardwareActionEvent, { kind: "scroll" }>): DedicatedHardwareRoute<TWindow> {
    if (event.phase === "press") {
      if (this.#scrollTarget !== undefined) return drop(event, "duplicate-press");
      const resolution = this.#newHeldTarget("scroll");
      if (resolution.target === undefined) return drop(event, resolution.reason);
      this.#scrollTarget = resolution.target;
      return routed(event, resolution.target);
    }
    if (event.phase === "move") {
      const target = this.#scrollTarget;
      if (target === undefined) return drop(event, "missing-press");
      if (target.kind === "window" && !this.#usableWindow(target.window)) {
        this.#scrollTarget = undefined;
        return drop(event, "held-owner-retired");
      }
      return routed(event, target);
    }
    const target = this.#scrollTarget;
    if (target === undefined) return drop(event, "missing-press");
    this.#scrollTarget = undefined;
    return this.#completeHeld(event, target);
  }

  #completeHeld(
    event: Extract<DedicatedHardwareActionEvent, { readonly kind: "scroll" }>,
    target: HeldTarget<TWindow>
  ): DedicatedHardwareRoute<TWindow> {
    if (target.kind === "window" && !this.#usableWindow(target.window)) {
      return drop(event, "held-owner-retired");
    }
    // Completion is sent to an already-admitted system owner even if a later
    // permission snapshot is unavailable; dropping it could leave a hold live.
    return routed(event, target);
  }

  #newHeldTarget(capability: "voice" | "scroll"): {
    readonly target?: HeldTarget<TWindow>;
    readonly reason: "focused-window-unavailable" | "system-capability-unavailable";
  } {
    const focused = this.#focusedWindowResolution();
    if (focused.kind === "ready") {
      return {
        target: Object.freeze({ kind: "window", window: focused.window }),
        reason: "focused-window-unavailable"
      };
    }
    if (focused.kind === "blocked") return { reason: "focused-window-unavailable" };
    return this.#systemCapability(capability) === "available"
      ? {
        target: Object.freeze({ kind: "system-frontmost", capability }),
        reason: "system-capability-unavailable"
      }
      : { reason: "system-capability-unavailable" };
  }

  #focusedWindowResolution(): FocusedWindowResolution<TWindow> {
    try {
      const focused = this.#dependencies.getFocusedWindow();
      if (focused === null) return { kind: "outside-application" };
      if (!this.#dependencies.isJokoActionWindow(focused)
        || !this.#dependencies.isWindowReady(focused)) return { kind: "blocked" };
      return { kind: "ready", window: focused };
    } catch {
      return { kind: "blocked" };
    }
  }

  #primaryWindow(): TWindow | null {
    try {
      const primary = this.#dependencies.getPrimaryWindow();
      return primary !== null && this.#usableWindow(primary) ? primary : null;
    } catch {
      return null;
    }
  }

  #usableWindow(window: TWindow): boolean {
    try {
      return this.#dependencies.isJokoActionWindow(window)
        && this.#dependencies.isWindowReady(window);
    } catch {
      return false;
    }
  }

  #systemCapability(capability: SystemFrontmostInputCapability): SystemFrontmostCapabilityState {
    try {
      const capabilities = this.#dependencies.getSystemFrontmostCapabilities();
      return capabilities[capability];
    } catch {
      return "unknown";
    }
  }

  #safeNow(): number {
    const value = this.#now();
    return Number.isFinite(value) ? value : 0;
  }

  #newVoiceActivationId(): string | undefined {
    if (this.#nextVoiceActivationId >= MAX_VOICE_ACTIVATION_ID) return undefined;
    this.#nextVoiceActivationId += 1n;
    return this.#nextVoiceActivationId.toString(10);
  }
}

function routed<TWindow>(
  event: DedicatedHardwareRoutedActionEvent,
  target: DedicatedHardwareRouteTarget<TWindow>
): DedicatedHardwareRoute<TWindow> {
  return Object.freeze({ kind: "route", target: Object.freeze(target), event });
}

function drop<TWindow>(
  event: DedicatedHardwareActionEvent,
  reason: DedicatedHardwareRouteDropReason
): DedicatedHardwareRoute<TWindow> {
  return Object.freeze({ kind: "drop", reason, event });
}

function targetMatchesWindow<TWindow>(
  target: DedicatedHardwareRouteTarget<TWindow>,
  ownerWindow: TWindow | undefined
): boolean {
  return ownerWindow === undefined || (target.kind === "window" && Object.is(target.window, ownerWindow));
}

function scrollEndEvent(
  phase: "release" | "cancel"
): Extract<DedicatedHardwareActionEvent, { readonly kind: "scroll" }> {
  return Object.freeze({ kind: "scroll", phase });
}

function nonVoiceEvent(
  event: Extract<DedicatedHardwareActionEvent, { readonly kind: "button" }>
): DedicatedHardwareRoutedActionEvent {
  if (event.action.kind === "voice") throw new TypeError("Voice input requires a routed activation.");
  return event as DedicatedHardwareRoutedActionEvent;
}

function voicePressEvent<TWindow>(owner: VoiceRouteOwner<TWindow>): DedicatedHardwareVoiceRoutedEvent {
  const activation = owner.activation;
  if (activation === undefined) throw new TypeError("Voice press activation is missing.");
  return Object.freeze({
    kind: "button",
    phase: "press",
    action: Object.freeze({ kind: "voice" }),
    activationId: activation.activationId,
    ownerActivationId: owner.ownerActivationId,
    activationKind: activation.activationKind,
    releaseKind: null
  });
}

function voiceCompletionEvent<TWindow>(
  owner: VoiceRouteOwner<TWindow>,
  activation: NonNullable<VoiceRouteOwner<TWindow>["activation"]>,
  releaseKind: DedicatedHardwareVoiceReleaseKind
): DedicatedHardwareVoiceRoutedEvent {
  const shared = {
    kind: "button" as const,
    action: Object.freeze({ kind: "voice" as const }),
    activationId: activation.activationId,
    ownerActivationId: owner.ownerActivationId,
    activationKind: activation.activationKind
  };
  return releaseKind === "cancel"
    ? Object.freeze({ ...shared, phase: "cancel", releaseKind })
    : Object.freeze({ ...shared, phase: "release", releaseKind });
}

function voiceCancellationEvent<TWindow>(owner: VoiceRouteOwner<TWindow>): DedicatedHardwareVoiceRoutedEvent {
  const activation = owner.activation ?? {
    activationId: owner.ownerActivationId,
    activationKind: "start" as const,
    pressedAt: 0
  };
  return voiceCompletionEvent(owner, activation, "cancel");
}
