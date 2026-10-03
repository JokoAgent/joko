import {
  DEDICATED_HARDWARE_WINDOW_REVEAL_MS,
  applyDedicatedHardwareLightingBrightness,
  computeDedicatedHardwareLightingFrame,
  createDedicatedHardwareLightingFrame,
  dedicatedHardwareAutoDimMs,
  isDedicatedHardwareLightingFrameOff,
  muteDedicatedHardwareKeyZone,
  shouldMuteDedicatedHardwareKeyZone,
  type DedicatedHardwareLightingFrame
} from "./lighting-frame.js";
import type { DedicatedHardwareLightingState } from "./protocol.js";
import { cloneDedicatedHardwareSettings, type DedicatedHardwareSettings } from "./settings.js";

export interface DedicatedHardwareLightingRuntime {
  readonly update: (settings: DedicatedHardwareSettings, state: DedicatedHardwareLightingState) => void;
  readonly physicalActivity: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly close: () => void;
}

interface PendingFrame {
  readonly frame: DedicatedHardwareLightingFrame;
  readonly signature: string;
  readonly force: bigint;
}

interface LightingOperation extends PendingFrame {
  readonly generation: number;
  readonly abort: AbortController;
  completion: Promise<void>;
}

/** One runtime belongs to one currently owned device connection. */
export function createDedicatedHardwareLightingRuntime(options: {
  readonly apply: (frame: DedicatedHardwareLightingFrame, signal: AbortSignal) => Promise<void>;
  readonly onApplyFailure?: (error: unknown) => void;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}): DedicatedHardwareLightingRuntime {
  const setTimer = options.setTimer ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  let settings: DedicatedHardwareSettings | undefined;
  let state: DedicatedHardwareLightingState | undefined;
  let base: DedicatedHardwareLightingFrame | undefined;
  let baseSignature: string | undefined;
  let settingsSignature: string | undefined;
  let paused = false;
  let closed = false;
  let dimmed = false;
  let revealActive = false;
  let dimTimer: unknown;
  let revealTimer: unknown;
  let dimTimerGeneration = 0;
  let revealTimerGeneration = 0;
  let generation = 0;
  let force = 0n;
  let desired: PendingFrame | undefined;
  let successful: Pick<PendingFrame, "signature" | "force"> | undefined;
  let failed: Pick<PendingFrame, "signature" | "force"> | undefined;
  let operation: LightingOperation | undefined;

  const clearDim = (): void => {
    dimTimerGeneration += 1;
    if (dimTimer !== undefined) clearTimer(dimTimer);
    dimTimer = undefined;
  };

  const clearReveal = (): void => {
    revealTimerGeneration += 1;
    if (revealTimer !== undefined) clearTimer(revealTimer);
    revealTimer = undefined;
    revealActive = false;
  };

  const pump = (): void => {
    if (closed || paused || operation !== undefined || desired === undefined) return;
    if (successful?.signature === desired.signature && successful.force >= desired.force) return;
    if (failed?.signature === desired.signature && failed.force >= desired.force) return;
    const current: LightingOperation = {
      ...desired, generation, abort: new AbortController(), completion: Promise.resolve()
    };
    operation = current;
    current.completion = Promise.resolve().then(async () => {
      try {
        if (closed || paused || current.generation !== generation || current.abort.signal.aborted) return;
        await options.apply(current.frame, current.abort.signal);
        if (!closed && !paused && current.generation === generation && !current.abort.signal.aborted) {
          successful = { signature: current.signature, force: current.force };
          failed = undefined;
        }
      } catch (error) {
        if (!closed && !paused && current.generation === generation && !current.abort.signal.aborted) {
          failed = { signature: current.signature, force: current.force };
          try { options.onApplyFailure?.(error); } catch { /* Reporting cannot retire input or cause retries. */ }
        }
      } finally {
        if (operation === current) operation = undefined;
        if (current.generation === generation) pump();
      }
    });
  };

  const publish = (): void => {
    if (closed || paused || settings === undefined || state === undefined) return;
    const frame = computeDedicatedHardwareLightingFrame({ settings, taskSlots: state.taskSlots, dimmed, windowReveal: revealActive });
    desired = { frame, signature: JSON.stringify(frame), force };
    pump();
  };

  const resetDim = (): void => {
    clearDim();
    if (closed || paused || settings === undefined || !settings.enabled || base === undefined) return;
    const delay = dedicatedHardwareAutoDimMs(settings.lighting.autoDim);
    if (delay === null || isDedicatedHardwareLightingFrameOff(
      applyDedicatedHardwareLightingBrightness(base, settings.lighting.brightnessPercent)
    )) return;
    const timerGeneration = dimTimerGeneration;
    const ownerGeneration = generation;
    dimTimer = setTimer(() => {
      if (closed || paused || ownerGeneration !== generation || timerGeneration !== dimTimerGeneration) return;
      dimTimer = undefined;
      dimmed = true;
      publish();
    }, delay);
  };

  const startReveal = (): void => {
    clearReveal();
    dimmed = false;
    revealActive = true;
    force += 1n;
    failed = undefined;
    const timerGeneration = revealTimerGeneration;
    const ownerGeneration = generation;
    revealTimer = setTimer(() => {
      if (closed || paused || ownerGeneration !== generation || timerGeneration !== revealTimerGeneration) return;
      revealTimer = undefined;
      revealActive = false;
      publish();
    }, DEDICATED_HARDWARE_WINDOW_REVEAL_MS);
    resetDim();
  };

  return {
    update: (nextSettings, nextState) => {
      if (closed) return;
      const previousState = state;
      const copyActivity = (activity: DedicatedHardwareLightingState["taskSlots"][number]) =>
        activity === null ? null : { phase: activity.phase, attention: activity.attention };
      settings = cloneDedicatedHardwareSettings(nextSettings);
      state = {
        version: 1,
        primaryVisible: nextState.primaryVisible,
        revealOccurrence: nextState.revealOccurrence,
        taskSlots: [
          copyActivity(nextState.taskSlots[0]), copyActivity(nextState.taskSlots[1]),
          copyActivity(nextState.taskSlots[2]), copyActivity(nextState.taskSlots[3]),
          copyActivity(nextState.taskSlots[4]), copyActivity(nextState.taskSlots[5])
        ]
      };
      const projected = createDedicatedHardwareLightingFrame(state.taskSlots);
      base = shouldMuteDedicatedHardwareKeyZone(settings.layout.taskKeys) ? muteDedicatedHardwareKeyZone(projected) : projected;
      const nextBaseSignature = JSON.stringify(base);
      const nextSettingsSignature = JSON.stringify({ enabled: settings.enabled, lighting: settings.lighting, taskKeys: settings.layout.taskKeys });
      const baseChanged = nextBaseSignature !== baseSignature;
      const settingsChanged = nextSettingsSignature !== settingsSignature;
      baseSignature = nextBaseSignature;
      settingsSignature = nextSettingsSignature;
      if (settingsChanged || !state.primaryVisible) clearReveal();
      if (paused) return;
      if (!settings.enabled) {
        clearDim();
        clearReveal();
        dimmed = false;
      } else {
        if (baseChanged || settingsChanged) {
          dimmed = false;
          failed = undefined;
          resetDim();
        }
        if (state.primaryVisible && state.revealOccurrence !== "0" &&
            previousState?.revealOccurrence !== state.revealOccurrence) startReveal();
      }
      publish();
    },
    physicalActivity: () => {
      if (closed || paused || settings?.enabled !== true || state === undefined) return;
      dimmed = false;
      failed = undefined;
      clearReveal();
      resetDim();
      publish();
    },
    pause: () => {
      if (closed || paused) return;
      paused = true;
      generation += 1;
      clearDim();
      clearReveal();
      desired = undefined;
      operation?.abort.abort();
    },
    resume: () => {
      if (closed || !paused) return;
      paused = false;
      generation += 1;
      dimmed = false;
      failed = undefined;
      force += 1n;
      resetDim();
      publish();
      const ownerGeneration = generation;
      const retired = operation;
      if (retired !== undefined) {
        void retired.completion.then(() => {
          if (!closed && !paused && ownerGeneration === generation) pump();
        });
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      generation += 1;
      clearDim();
      clearReveal();
      desired = undefined;
      settings = undefined;
      state = undefined;
      base = undefined;
      operation?.abort.abort();
    }
  };
}
