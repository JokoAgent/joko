import type {
  VoiceLeasePressResult,
  VoiceLeaseReleaseKind,
  VoiceLeaseSnapshot,
  VoicePressLease
} from "./voice-lease.js";
import type { DedicatedHardwareVoiceRoutedEvent } from "./routed-actions.js";
import type {
  SystemFrontmostInputRunner,
  SystemFrontmostInputTarget
} from "./system-frontmost-input.js";

export type SystemFrontmostVoiceSource = "shortcut" | "hardware";

export interface SystemFrontmostVoiceBackend {
  readonly snapshot: () => VoiceLeaseSnapshot<SystemFrontmostVoiceSource>;
  readonly press: () => VoiceLeasePressResult<SystemFrontmostVoiceSource>;
  readonly release: (
    lease: VoicePressLease<SystemFrontmostVoiceSource>,
    kind: VoiceLeaseReleaseKind
  ) => boolean;
  readonly cancelHardware: () => boolean;
}

export interface SystemFrontmostVoiceControllerOptions {
  readonly onFailure?: (error: unknown, phase: "capture" | "paste") => void;
}

interface CapturedRecordingTarget {
  readonly generation: number;
  readonly ownerActivationId: string;
  readonly target: SystemFrontmostInputTarget;
}

interface ActivePhysicalPress {
  readonly lease: VoicePressLease<SystemFrontmostVoiceSource>;
  readonly activationId: string;
  readonly ownerActivationId: string;
  readonly activationKind: "start" | "toggle-finish";
}

/**
 * Binds one hardware voice recording to the external application captured at
 * physical press. Capture is generation-fenced, releases never start late
 * work, and a shortcut-owned recording cannot be completed by hardware.
 */
export class SystemFrontmostVoiceController {
  readonly #runner: SystemFrontmostInputRunner;
  readonly #backend: SystemFrontmostVoiceBackend;
  readonly #onFailure: ((error: unknown, phase: "capture" | "paste") => void) | undefined;
  #activePress: ActivePhysicalPress | undefined;
  #recordingTarget: CapturedRecordingTarget | undefined;

  constructor(
    runner: SystemFrontmostInputRunner,
    backend: SystemFrontmostVoiceBackend,
    options: SystemFrontmostVoiceControllerOptions = {}
  ) {
    this.#runner = runner;
    this.#backend = backend;
    this.#onFailure = options.onFailure;
  }

  handle(event: DedicatedHardwareVoiceRoutedEvent): boolean {
    if (event.phase === "press") return this.#press(event);
    const press = this.#activePress;
    if (press === undefined) {
      const target = this.#recordingTarget;
      if (event.releaseKind !== "cancel"
        || target?.ownerActivationId !== event.ownerActivationId) return false;
      this.#recordingTarget = undefined;
      return this.#backend.cancelHardware();
    }
    if (press.activationId !== event.activationId
      || press.ownerActivationId !== event.ownerActivationId
      || press.activationKind !== event.activationKind) return false;
    this.#activePress = undefined;
    const released = this.#backend.release(press.lease, event.releaseKind);
    if (event.releaseKind === "cancel" || !released) {
      this.#recordingTarget = undefined;
      if (!released) this.#backend.cancelHardware();
    }
    return released;
  }

  cancel(): void {
    this.#activePress = undefined;
    this.#recordingTarget = undefined;
    this.#backend.cancelHardware();
  }

  /** Clears native identity only; the voice lease owner performs cancellation. */
  retire(): void {
    this.#activePress = undefined;
    this.#recordingTarget = undefined;
  }

  hasTargetForActiveRecording(): boolean {
    return this.#activeTarget() !== undefined;
  }

  async postPasteForActiveRecording(): Promise<boolean> {
    const target = this.#activeTarget();
    if (target === undefined) return false;
    try {
      await this.#runner.postPaste(target);
      return true;
    } catch (error) {
      this.#reportFailure(error, "paste");
      return false;
    }
  }

  #press(event: Extract<DedicatedHardwareVoiceRoutedEvent, { readonly phase: "press" }>): boolean {
    if (this.#activePress !== undefined) return false;
    const snapshot = this.#backend.snapshot();
    if (event.activationKind === "toggle-finish") {
      const target = this.#recordingTarget;
      if (event.ownerActivationId === event.activationId
        || (snapshot.state !== "starting" && snapshot.state !== "recording")
        || snapshot.source !== "hardware"
        || target?.generation !== snapshot.generation
        || target.ownerActivationId !== event.ownerActivationId) return false;
      const pressed = this.#backend.press();
      if (!pressed.accepted || pressed.effect !== "toggle-complete"
        || pressed.lease.recordingGeneration !== target.generation) return false;
      this.#activePress = Object.freeze({
        lease: pressed.lease,
        activationId: event.activationId,
        ownerActivationId: event.ownerActivationId,
        activationKind: event.activationKind
      });
      return true;
    }

    if (event.activationId !== event.ownerActivationId || snapshot.state !== "idle") return false;
    this.#recordingTarget = undefined;
    let target: SystemFrontmostInputTarget;
    try {
      target = this.#runner.captureTarget();
    } catch (error) {
      this.#reportFailure(error, "capture");
      return false;
    }
    if (this.#backend.snapshot().state !== "idle") return false;
    const pressed = this.#backend.press();
    if (!pressed.accepted || pressed.effect !== "start") return false;
    this.#activePress = Object.freeze({
      lease: pressed.lease,
      activationId: event.activationId,
      ownerActivationId: event.ownerActivationId,
      activationKind: event.activationKind
    });
    this.#recordingTarget = Object.freeze({
      generation: pressed.lease.recordingGeneration,
      ownerActivationId: event.ownerActivationId,
      target
    });
    return true;
  }

  #activeTarget(): SystemFrontmostInputTarget | undefined {
    const snapshot = this.#backend.snapshot();
    const captured = this.#recordingTarget;
    return snapshot.state !== "idle"
      && snapshot.state !== "uncertain"
      && snapshot.source === "hardware"
      && captured?.generation === snapshot.generation
      ? captured.target
      : undefined;
  }

  #reportFailure(error: unknown, phase: "capture" | "paste"): void {
    try {
      this.#onFailure?.(error, phase);
    } catch {
      // Failure reporting cannot retain or replay native input.
    }
  }
}
