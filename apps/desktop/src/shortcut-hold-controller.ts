export type ShortcutHoldPhase = "start" | "tap" | "end";

export interface ShortcutHoldControllerOptions {
  readonly holdDelayMs?: number;
  readonly onTrigger: (phase: ShortcutHoldPhase) => void;
}

const DEFAULT_HOLD_DELAY_MS = 450;

/**
 * Converts a native target-key pressed stream into tap and hold phases.
 * Native listeners report whether the complete shortcut is pressed and,
 * separately, whether its target key remains physically down.
 */
export class ShortcutHoldController {
  readonly #holdDelayMs: number;
  readonly #onTrigger: (phase: ShortcutHoldPhase) => void;
  #pressed = false;
  #holdThresholdReached = false;
  #cancelledUntilRelease = false;
  #holdTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ShortcutHoldControllerOptions) {
    this.#holdDelayMs = options.holdDelayMs ?? DEFAULT_HOLD_DELAY_MS;
    this.#onTrigger = options.onTrigger;
  }

  /**
   * @param pressed Whether the exact configured shortcut is currently pressed.
   * @param targetDown Whether the target key itself is still physically down.
   * Pass `false, true` when another key breaks an active shortcut. The current
   * activation ends and remains fenced until the target key is truly released.
   */
  setPressed(pressed: boolean, targetDown = pressed): void {
    if (pressed) {
      if (this.#pressed || this.#cancelledUntilRelease) return;

      this.#pressed = true;
      this.#holdThresholdReached = false;
      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = undefined;
        if (this.#pressed) this.#holdThresholdReached = true;
      }, this.#holdDelayMs);
      this.#onTrigger("start");
      return;
    }

    if (this.#pressed) {
      this.#clearHoldTimer();
      this.#pressed = false;
      const wasHeld = this.#holdThresholdReached;
      this.#holdThresholdReached = false;

      if (targetDown) {
        this.#cancelledUntilRelease = true;
        this.#onTrigger("end");
        return;
      }

      this.#cancelledUntilRelease = false;
      this.#onTrigger(wasHeld ? "end" : "tap");
      return;
    }

    this.#cancelledUntilRelease = targetDown;
  }

  /** End an active activation and return the controller to an idle state. */
  releaseIfPressed(): void {
    this.#clearHoldTimer();
    const shouldEnd = this.#pressed;
    this.#pressed = false;
    this.#holdThresholdReached = false;
    this.#cancelledUntilRelease = false;
    if (shouldEnd) this.#onTrigger("end");
  }

  /** Clear all state without emitting a phase. */
  reset(): void {
    this.#clearHoldTimer();
    this.#pressed = false;
    this.#holdThresholdReached = false;
    this.#cancelledUntilRelease = false;
  }

  #clearHoldTimer(): void {
    if (this.#holdTimer === undefined) return;
    clearTimeout(this.#holdTimer);
    this.#holdTimer = undefined;
  }
}
