import type {
  DesktopGlobalVoiceShortcut,
  DesktopGlobalVoiceShortcutPreference,
  DesktopGlobalVoiceShortcutResult
} from "./channels.js";
import type {
  DesktopGlobalShortcutRegistration,
  PreparedDesktopGlobalShortcutReplacement
} from "./global-voice-shortcut.js";
import type {
  NativeVoiceShortcutRegistration,
  NativeVoiceShortcutStartResult
} from "./native-voice-shortcut.js";

export interface DesktopGlobalVoiceShortcutBindingOptions {
  readonly platform: NodeJS.Platform;
  readonly nativeRegistration: NativeVoiceShortcutRegistration;
  readonly electronRegistration: DesktopGlobalShortcutRegistration;
  readonly nativeTargetAvailable: (
    shortcut: DesktopGlobalVoiceShortcut,
    platform: NodeJS.Platform
  ) => boolean;
  readonly nativeReservationAccelerator: (
    shortcut: DesktopGlobalVoiceShortcut,
    platform: NodeJS.Platform
  ) => string | undefined;
  readonly electronAccelerator: (shortcut: DesktopGlobalVoiceShortcut) => string | undefined;
  readonly onElectronTrigger: () => void;
  readonly onNativeReservationTrigger: () => void;
}

export interface DesktopGlobalVoiceShortcutDesiredSnapshot {
  readonly revision: number;
  readonly shortcut: DesktopGlobalVoiceShortcutPreference;
}

export type DesktopGlobalVoiceShortcutRecoveryResult =
  | "registered"
  | "permission"
  | "failed"
  | "superseded";

/** Serializes complete native/Electron binding transactions and their desired state. */
export class DesktopGlobalVoiceShortcutBinding {
  readonly #options: DesktopGlobalVoiceShortcutBindingOptions;
  #desired: DesktopGlobalVoiceShortcutPreference = "disabled";
  #desiredRevision = 0;
  #bindingGeneration = 0;
  #lifecycleGeneration = 0;
  readonly #suspensions = new Set<string>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: DesktopGlobalVoiceShortcutBindingOptions) {
    this.#options = options;
  }

  desiredSnapshot(): DesktopGlobalVoiceShortcutDesiredSnapshot {
    return { revision: this.#desiredRevision, shortcut: this.#desired };
  }

  register(shortcut: DesktopGlobalVoiceShortcutPreference): Promise<DesktopGlobalVoiceShortcutResult> {
    return this.#enqueue(async (isCurrent) => {
      if (!isCurrent()) return unsupportedResult();
      const bindingGeneration = ++this.#bindingGeneration;
      const result = await this.#apply(shortcut, bindingGeneration);
      if (!isCurrent() || bindingGeneration !== this.#bindingGeneration) return unsupportedResult();
      if (result.accepted) {
        this.#commitDesired(shortcut);
      } else if (result.reason === "permission") {
        this.#clearRegistrations();
        this.#commitDesired(shortcut);
      }
      if (this.#suspensions.size > 0) this.#clearRegistrations();
      return result;
    });
  }

  /** Temporarily releases the complete binding without changing the desired preference. */
  suspend(owner: string): Promise<void> {
    this.#suspensions.add(owner);
    return this.#enqueue(async (isCurrent) => {
      if (!isCurrent() || this.#suspensions.size === 0) return;
      this.#bindingGeneration += 1;
      this.#clearRegistrations();
    });
  }

  /** Restores the latest desired preference after the last suspension is released. */
  resume(owner: string): Promise<DesktopGlobalVoiceShortcutRecoveryResult> {
    if (!this.#suspensions.delete(owner)) return Promise.resolve("superseded");
    return this.#enqueue(async (isCurrent) => {
      if (!isCurrent() || this.#suspensions.size > 0) return "superseded";
      const desiredRevision = this.#desiredRevision;
      const bindingGeneration = ++this.#bindingGeneration;
      const result = await this.#apply(this.#desired, bindingGeneration);
      if (!isCurrent() || this.#suspensions.size > 0
        || bindingGeneration !== this.#bindingGeneration
        || desiredRevision !== this.#desiredRevision) {
        if (this.#suspensions.size > 0) this.#clearRegistrations();
        return "superseded";
      }
      if (result.accepted) return "registered";
      if (result.reason === "permission") this.#clearRegistrations();
      return result.reason === "permission" ? "permission" : "failed";
    });
  }

  recover(
    shortcut: DesktopGlobalVoiceShortcut,
    revision: number,
    canApply: () => boolean
  ): Promise<DesktopGlobalVoiceShortcutRecoveryResult> {
    return this.#enqueue(async (isCurrent) => {
      if (!isCurrent() || this.#suspensions.size > 0
        || !canApply() || !this.#matchesDesired(shortcut, revision)) return "superseded";
      const bindingGeneration = ++this.#bindingGeneration;
      const result = await this.#apply(shortcut, bindingGeneration);
      if (!isCurrent() || bindingGeneration !== this.#bindingGeneration
        || this.#suspensions.size > 0 || !this.#matchesDesired(shortcut, revision)) {
        if (this.#suspensions.size > 0) this.#clearRegistrations();
        return "superseded";
      }
      if (result.accepted) return "registered";
      return result.reason === "permission" ? "permission" : "failed";
    });
  }

  clear(): void {
    this.#lifecycleGeneration += 1;
    this.#bindingGeneration += 1;
    this.#suspensions.clear();
    this.#commitDesired("disabled");
    this.#clearRegistrations();
  }

  invalidateNativeBinding(): boolean {
    if (this.#options.nativeRegistration.current() === undefined) return false;
    this.#bindingGeneration += 1;
    this.#options.nativeRegistration.invalidate();
    this.#options.electronRegistration.clear();
    return true;
  }

  async #apply(
    shortcut: DesktopGlobalVoiceShortcutPreference,
    bindingGeneration: number
  ): Promise<DesktopGlobalVoiceShortcutResult> {
    if (bindingGeneration !== this.#bindingGeneration) return unsupportedResult();
    if (shortcut === "disabled") {
      this.#clearRegistrations();
      return { accepted: true, activation: "toggle" };
    }

    if (this.#options.nativeTargetAvailable(shortcut, this.#options.platform)) {
      let reservation: PreparedDesktopGlobalShortcutReplacement | undefined | false;
      try {
        reservation = this.#prepareNativeReservation(shortcut);
      } catch {
        return unsupportedResult();
      }
      if (reservation === false) return { accepted: false, reason: "in-use" };
      let result: NativeVoiceShortcutStartResult;
      try {
        result = await this.#options.nativeRegistration.replace(shortcut);
      } catch {
        reservation?.rollback();
        return unsupportedResult();
      }
      if (bindingGeneration !== this.#bindingGeneration) {
        reservation?.rollback();
        return unsupportedResult();
      }
      if (!result.ok) {
        reservation?.rollback();
        if (result.restorationFailed === true) this.#clearRegistrations();
        return { accepted: false, reason: result.reason };
      }
      if (reservation === undefined) this.#options.electronRegistration.clear();
      else reservation.commit();
      return { accepted: true, activation: "hold" };
    }

    const accelerator = this.#options.electronAccelerator(shortcut);
    if (accelerator === undefined) return unsupportedResult();
    if (!this.#options.electronRegistration.replace(accelerator, this.#options.onElectronTrigger)) {
      return { accepted: false, reason: "in-use" };
    }
    this.#options.nativeRegistration.clear();
    return { accepted: true, activation: "toggle" };
  }

  #prepareNativeReservation(
    shortcut: DesktopGlobalVoiceShortcut
  ): PreparedDesktopGlobalShortcutReplacement | undefined | false {
    const accelerator = this.#options.nativeReservationAccelerator(shortcut, this.#options.platform);
    if (accelerator === undefined) return undefined;
    return this.#options.electronRegistration.prepareReplacement(
      accelerator,
      this.#options.onNativeReservationTrigger
    ) ?? false;
  }

  #clearRegistrations(): void {
    this.#options.electronRegistration.clear();
    this.#options.nativeRegistration.clear();
  }

  #commitDesired(shortcut: DesktopGlobalVoiceShortcutPreference): void {
    this.#desired = shortcut;
    this.#desiredRevision += 1;
  }

  #matchesDesired(shortcut: DesktopGlobalVoiceShortcut, revision: number): boolean {
    return revision === this.#desiredRevision
      && this.#desired !== "disabled"
      && shortcutsEqual(this.#desired, shortcut);
  }

  #enqueue<T>(operation: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    const lifecycleGeneration = this.#lifecycleGeneration;
    const execute = (): Promise<T> => operation(() => lifecycleGeneration === this.#lifecycleGeneration);
    const result = this.#mutationTail.then(execute, execute);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function unsupportedResult(): DesktopGlobalVoiceShortcutResult {
  return { accepted: false, reason: "unsupported" };
}

function shortcutsEqual(left: DesktopGlobalVoiceShortcut, right: DesktopGlobalVoiceShortcut): boolean {
  return left.code === right.code
    && left.meta === right.meta
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift
    && left.fn === right.fn;
}
