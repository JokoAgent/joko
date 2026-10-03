import {
  DEDICATED_HARDWARE_TASK_SLOT_COUNT,
  type DedicatedHardwareAutoDim,
  type DedicatedHardwarePhysicalKey,
  type DedicatedHardwareSettings
} from "./settings.js";

export const DEDICATED_HARDWARE_WINDOW_REVEAL_MS = 2_000;

export enum DedicatedHardwareLightingEffect {
  Off = 0,
  Solid = 1,
  Snake = 2,
  Rainbow = 3,
  Breath = 4,
  Gradient = 5,
  ShallowBreath = 6
}

export interface DedicatedHardwareLightingActivity {
  readonly phase: "running" | "needs-interaction" | "completed" | "error" | null;
  readonly attention: boolean;
}

export interface DedicatedHardwareLightingSide {
  readonly effect: DedicatedHardwareLightingEffect;
  readonly brightness: number;
  readonly speed: number;
  readonly magic: number;
  readonly color: number;
}

export interface DedicatedHardwareThreadLighting {
  readonly id: number;
  readonly color: number;
  readonly brightness: number;
  readonly effect: DedicatedHardwareLightingEffect;
  readonly speed: number;
  readonly syncKeysLighting: boolean;
  readonly syncAmbientLighting: boolean;
}

export interface DedicatedHardwareLightingFrame {
  readonly ambient: DedicatedHardwareLightingSide;
  readonly keys: DedicatedHardwareLightingSide;
  readonly threads: readonly DedicatedHardwareThreadLighting[];
}

type LightingPhase = NonNullable<DedicatedHardwareLightingActivity["phase"]>;

const COLORS = {
  running: 0x4c6fff,
  "needs-interaction": 0xffa000,
  completed: 0x35c759,
  error: 0xff453a,
  brand: 0xff9800
} as const;

const OFF_SIDE: DedicatedHardwareLightingSide = Object.freeze({
  effect: DedicatedHardwareLightingEffect.Off,
  brightness: 0,
  speed: 0,
  magic: 0,
  color: 0
});

const PHASE_PRIORITY: Readonly<Record<LightingPhase, number>> = {
  "needs-interaction": 4,
  error: 3,
  running: 2,
  completed: 1
};

/** Slot order is the same explicit assignment used by the task keys. */
export function createDedicatedHardwareLightingFrame(
  taskSlots: readonly (DedicatedHardwareLightingActivity | null)[]
): DedicatedHardwareLightingFrame {
  if (taskSlots.length !== DEDICATED_HARDWARE_TASK_SLOT_COUNT) {
    throw new TypeError("Dedicated hardware lighting requires six task slots.");
  }
  const slots = taskSlots.map((activity) =>
    activity !== null && activity.phase !== null && (
      activity.phase === "running" || activity.phase === "needs-interaction" || activity.attention
    ) ? activity.phase : null
  );
  const aggregate = slots.reduce<LightingPhase | null>((current, phase) => {
    if (phase === null) return current;
    return current === null || PHASE_PRIORITY[phase] > PHASE_PRIORITY[current] ? phase : current;
  }, null);

  return {
    ambient: aggregate === null ? { ...OFF_SIDE } : ambientForPhase(aggregate),
    keys: aggregate === null ? { ...OFF_SIDE } : keysForPhase(aggregate),
    threads: slots.map((phase, id) => threadForPhase(id, phase))
  };
}

/** The shared key zone must not illuminate demoted AG keys or extra ACT tasks. */
export function shouldMuteDedicatedHardwareKeyZone(taskKeys: readonly DedicatedHardwarePhysicalKey[]): boolean {
  return taskKeys.length > DEDICATED_HARDWARE_TASK_SLOT_COUNT ||
    (["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"] as const).some((key) => !taskKeys.includes(key));
}

export function muteDedicatedHardwareKeyZone(frame: DedicatedHardwareLightingFrame): DedicatedHardwareLightingFrame {
  return { ...frame, keys: { ...OFF_SIDE } };
}

export function applyDedicatedHardwareLightingBrightness(
  frame: DedicatedHardwareLightingFrame,
  brightnessPercent: number
): DedicatedHardwareLightingFrame {
  if (!Number.isFinite(brightnessPercent)) throw new TypeError("Dedicated hardware brightness must be finite.");
  const factor = Math.max(0, Math.min(100, brightnessPercent)) / 100;
  return {
    ambient: { ...frame.ambient, brightness: frame.ambient.brightness * factor },
    keys: { ...frame.keys, brightness: frame.keys.brightness * factor },
    threads: frame.threads.map((thread) => ({ ...thread, brightness: thread.brightness * factor }))
  };
}

export function createDedicatedHardwareOffFrame(): DedicatedHardwareLightingFrame {
  return {
    ambient: { ...OFF_SIDE },
    keys: { ...OFF_SIDE },
    threads: Array.from({ length: DEDICATED_HARDWARE_TASK_SLOT_COUNT }, (_, id) => threadForPhase(id, null))
  };
}

export function createDedicatedHardwareWindowRevealFrame(): DedicatedHardwareLightingFrame {
  return {
    ambient: side(DedicatedHardwareLightingEffect.Snake, 0.78, 0.55, COLORS.brand),
    keys: side(DedicatedHardwareLightingEffect.Breath, 0.34, 0.55, COLORS.brand),
    threads: Array.from({ length: DEDICATED_HARDWARE_TASK_SLOT_COUNT }, (_, id) => ({
      id,
      color: COLORS.brand,
      brightness: 0.72,
      effect: DedicatedHardwareLightingEffect.Breath,
      speed: 0.55,
      syncKeysLighting: false,
      syncAmbientLighting: false
    }))
  };
}

/** Preview and input subscriptions are independent of lighting state. */
export function computeDedicatedHardwareLightingFrame(options: {
  readonly settings: DedicatedHardwareSettings;
  readonly taskSlots: readonly (DedicatedHardwareLightingActivity | null)[];
  readonly dimmed: boolean;
  readonly windowReveal: boolean;
}): DedicatedHardwareLightingFrame {
  if (!options.settings.enabled || options.dimmed) return createDedicatedHardwareOffFrame();
  let frame = createDedicatedHardwareLightingFrame(options.taskSlots);
  if (shouldMuteDedicatedHardwareKeyZone(options.settings.layout.taskKeys)) frame = muteDedicatedHardwareKeyZone(frame);
  if (options.windowReveal) frame = createDedicatedHardwareWindowRevealFrame();
  return applyDedicatedHardwareLightingBrightness(frame, options.settings.lighting.brightnessPercent);
}

export function isDedicatedHardwareLightingFrameOff(frame: DedicatedHardwareLightingFrame): boolean {
  return frame.ambient.brightness === 0 && frame.keys.brightness === 0 &&
    frame.threads.every((thread) => thread.brightness === 0);
}

export function dedicatedHardwareAutoDimMs(value: DedicatedHardwareAutoDim): number | null {
  switch (value) {
    case "off": return null;
    case "30-seconds": return 30_000;
    case "1-minute": return 60_000;
    case "3-minutes": return 180_000;
    case "10-minutes": return 600_000;
    case "30-minutes": return 1_800_000;
    case "1-hour": return 3_600_000;
  }
}

function ambientForPhase(phase: LightingPhase): DedicatedHardwareLightingSide {
  switch (phase) {
    case "running": return side(DedicatedHardwareLightingEffect.Snake, 0.7, 0.4, COLORS.running);
    case "needs-interaction": return side(DedicatedHardwareLightingEffect.Breath, 0.95, 0.35, COLORS[phase]);
    case "completed": return side(DedicatedHardwareLightingEffect.Solid, 0.7, 0, COLORS.completed);
    case "error": return side(DedicatedHardwareLightingEffect.Breath, 1, 0.45, COLORS.error);
  }
}

function keysForPhase(phase: LightingPhase): DedicatedHardwareLightingSide {
  const effect = phase === "error" ? DedicatedHardwareLightingEffect.Breath : DedicatedHardwareLightingEffect.Solid;
  const brightness = phase === "needs-interaction" || phase === "error" ? 0.28 : 0.16;
  return side(effect, brightness, phase === "error" ? 0.45 : 0, COLORS[phase]);
}

function threadForPhase(id: number, phase: LightingPhase | null): DedicatedHardwareThreadLighting {
  if (phase === null) return {
    id,
    color: 0,
    brightness: 0,
    effect: DedicatedHardwareLightingEffect.Off,
    speed: 0,
    syncKeysLighting: false,
    syncAmbientLighting: false
  };
  const animated = phase === "running" || phase === "needs-interaction" || phase === "error";
  return {
    id,
    color: COLORS[phase],
    brightness: 0.8,
    effect: animated ? DedicatedHardwareLightingEffect.Breath : DedicatedHardwareLightingEffect.Solid,
    speed: animated ? 0.35 : 0,
    syncKeysLighting: false,
    syncAmbientLighting: false
  };
}

function side(
  effect: DedicatedHardwareLightingEffect,
  brightness: number,
  speed: number,
  color: number
): DedicatedHardwareLightingSide {
  return { effect, brightness, speed, magic: 0, color };
}
