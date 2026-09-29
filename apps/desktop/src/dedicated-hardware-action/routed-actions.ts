import type {
  DedicatedHardwareAction,
  DedicatedHardwareActionEvent
} from "./actions.js";

export type DedicatedHardwareVoiceActivationKind = "start" | "toggle-finish";
export type DedicatedHardwareVoiceReleaseKind = "tap" | "hold" | "cancel";

export type DedicatedHardwareVoiceRoutedEvent =
  | {
    readonly kind: "button";
    readonly phase: "press";
    readonly action: Readonly<{ readonly kind: "voice" }>;
    /** Identifies this exact physical press and its matching completion. */
    readonly activationId: string;
    /** Identifies the first press whose exact renderer/native capture remains authoritative. */
    readonly ownerActivationId: string;
    readonly activationKind: DedicatedHardwareVoiceActivationKind;
    readonly releaseKind: null;
  }
  | {
    readonly kind: "button";
    readonly phase: "release";
    readonly action: Readonly<{ readonly kind: "voice" }>;
    readonly activationId: string;
    readonly ownerActivationId: string;
    readonly activationKind: DedicatedHardwareVoiceActivationKind;
    readonly releaseKind: "tap" | "hold";
  }
  | {
    readonly kind: "button";
    readonly phase: "cancel";
    readonly action: Readonly<{ readonly kind: "voice" }>;
    readonly activationId: string;
    readonly ownerActivationId: string;
    readonly activationKind: DedicatedHardwareVoiceActivationKind;
    readonly releaseKind: "cancel";
  };

type DedicatedHardwareNonVoiceAction = Exclude<DedicatedHardwareAction, { readonly kind: "voice" }>;
type DedicatedHardwareNonVoiceButtonEvent = {
  readonly kind: "button";
  readonly phase: "press" | "release" | "cancel";
  readonly action: DedicatedHardwareNonVoiceAction;
};
type DedicatedHardwareScrollEvent = Extract<DedicatedHardwareActionEvent, { readonly kind: "scroll" }>;

/**
 * Main-process output after focus ownership and voice activation timing have
 * been resolved. This is deliberately distinct from the raw utility-process
 * input event: only this shape may cross into a renderer.
 */
export type DedicatedHardwareRoutedActionEvent =
  | DedicatedHardwareNonVoiceButtonEvent
  | DedicatedHardwareScrollEvent
  | DedicatedHardwareVoiceRoutedEvent;

export function isDedicatedHardwareVoiceRoutedEvent(
  event: DedicatedHardwareRoutedActionEvent
): event is DedicatedHardwareVoiceRoutedEvent {
  return event.kind === "button" && event.action.kind === "voice";
}
