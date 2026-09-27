import type {
  DedicatedHardwareAction,
  DedicatedHardwareActionEvent
} from "../dedicated-hardware-action/actions.js";
import {
  DEDICATED_HARDWARE_MODEL_IDS,
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  cloneDedicatedHardwareSettings,
  isDedicatedHardwareModelId,
  parseDedicatedHardwareBinding,
  type DedicatedHardwareBinding,
  type DedicatedHardwareDirection,
  type DedicatedHardwareKeyMerge,
  type DedicatedHardwareModelId,
  type DedicatedHardwarePhysicalKey,
  type DedicatedHardwareSettings
} from "./settings.js";
import type { DedicatedHardwareInputEvent } from "./protocol.js";
import type {
  DedicatedHardwareSelectedTaskSlot,
  DedicatedHardwareTaskSlotSelection
} from "./task-catalog.js";

export const DEDICATED_HARDWARE_STICK_DEAD_ZONE = 0.5;
export const DEDICATED_HARDWARE_STICK_SILENCE_TIMEOUT_MS = 10_000;
export const DEDICATED_HARDWARE_ENCODER_LONG_PRESS_MS = 500;
export const DEDICATED_HARDWARE_TASK_DOUBLE_TAP_MS = 350;

export interface DedicatedHardwareInputModel {
  readonly settings: DedicatedHardwareSettings;
  readonly taskSlots: DedicatedHardwareTaskSlotSelection;
}

export interface DedicatedHardwareInputController {
  readonly updateModel: (model: DedicatedHardwareModelId, value: DedicatedHardwareInputModel) => void;
  readonly setPreview: (model: DedicatedHardwareModelId, enabled: boolean) => void;
  readonly handleInput: (model: DedicatedHardwareModelId, input: DedicatedHardwareInputEvent) => void;
  readonly cancelModel: (model: DedicatedHardwareModelId, reason?: string) => void;
  readonly cancelAll: () => void;
}

interface ModelRuntime {
  value: DedicatedHardwareInputModel;
  signature: string;
  preview: boolean;
  downKeys: Set<DedicatedHardwarePhysicalKey>;
  blockedKeys: Set<DedicatedHardwarePhysicalKey>;
  mergeWinners: Map<DedicatedHardwarePhysicalKey, DedicatedHardwarePhysicalKey>;
  activeButtons: Map<string, DedicatedHardwareAction>;
  stickDirection: DedicatedHardwareDirection | undefined;
  stickNeedsCenter: boolean;
  scrolling: boolean;
  scrollDirection: "up" | "down" | undefined;
  scrollTimer: unknown;
  encoderPressed: boolean;
  encoderBlocked: boolean;
  encoderLongFired: boolean;
  encoderTimer: unknown;
  pendingTaskTap: { readonly slot: number; readonly sessionId: string; readonly at: number } | undefined;
}

export function createDedicatedHardwareInputController(options: {
  readonly emitAction: (model: DedicatedHardwareModelId, event: DedicatedHardwareActionEvent) => void;
  readonly emitPreview?: (model: DedicatedHardwareModelId, input: DedicatedHardwareInputEvent) => void;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}): DedicatedHardwareInputController {
  const setTimer = options.setTimer ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const now = options.now ?? Date.now;
  const runtimes = new Map<DedicatedHardwareModelId, ModelRuntime>();

  const emit = (model: DedicatedHardwareModelId, event: DedicatedHardwareActionEvent): boolean => {
    try {
      options.emitAction(model, event);
      return true;
    } catch {
      return false;
    }
  };

  const stopScroll = (model: DedicatedHardwareModelId, runtime: ModelRuntime, phase: "release" | "cancel"): void => {
    if (runtime.scrollTimer !== undefined) {
      clearTimer(runtime.scrollTimer);
      runtime.scrollTimer = undefined;
    }
    if (runtime.scrolling) emit(model, { kind: "scroll", phase });
    runtime.scrolling = false;
    runtime.scrollDirection = undefined;
  };

  const cancelRuntime = (model: DedicatedHardwareModelId, runtime: ModelRuntime): void => {
    for (const action of runtime.activeButtons.values()) {
      emit(model, { kind: "button", phase: "cancel", action });
    }
    runtime.activeButtons.clear();
    stopScroll(model, runtime, "cancel");
    if (runtime.encoderTimer !== undefined) {
      clearTimer(runtime.encoderTimer);
      runtime.encoderTimer = undefined;
    }
    for (const key of runtime.downKeys) runtime.blockedKeys.add(key);
    runtime.mergeWinners.clear();
    runtime.stickDirection = undefined;
    runtime.stickNeedsCenter = true;
    runtime.encoderBlocked ||= runtime.encoderPressed;
    runtime.encoderLongFired = false;
    runtime.pendingTaskTap = undefined;
  };

  const releaseButton = (model: DedicatedHardwareModelId, runtime: ModelRuntime, control: string): void => {
    const action = runtime.activeButtons.get(control);
    if (action === undefined) return;
    runtime.activeButtons.delete(control);
    emit(model, { kind: "button", phase: "release", action });
  };

  const pressButton = (
    model: DedicatedHardwareModelId,
    runtime: ModelRuntime,
    control: string,
    action: DedicatedHardwareAction | undefined
  ): void => {
    if (action === undefined || runtime.activeButtons.has(control)) return;
    if (emit(model, { kind: "button", phase: "press", action })) runtime.activeButtons.set(control, action);
  };

  const emitOneShot = (
    model: DedicatedHardwareModelId,
    binding: DedicatedHardwareBinding | DedicatedHardwareAction | undefined
  ): void => {
    const action = binding === undefined ? undefined : actionFromBinding(binding);
    if (action !== undefined) emit(model, { kind: "button", phase: "press", action });
  };

  const armScrollWatchdog = (model: DedicatedHardwareModelId, runtime: ModelRuntime): void => {
    if (runtime.scrollTimer !== undefined) clearTimer(runtime.scrollTimer);
    runtime.scrollTimer = setTimer(() => {
      runtime.scrollTimer = undefined;
      runtime.stickDirection = undefined;
      runtime.stickNeedsCenter = true;
      if (runtime.scrolling) {
        emit(model, { kind: "scroll", phase: "cancel" });
        runtime.scrolling = false;
        runtime.scrollDirection = undefined;
      }
    }, DEDICATED_HARDWARE_STICK_SILENCE_TIMEOUT_MS);
  };

  const handleKey = (
    model: DedicatedHardwareModelId,
    runtime: ModelRuntime,
    input: Extract<DedicatedHardwareInputEvent, { kind: "key" }>
  ): void => {
    const merge = mergeForKey(runtime.value.settings.layout.merges, input.key);
    if (input.pressed) {
      if (runtime.downKeys.has(input.key)) return;
      runtime.downKeys.add(input.key);
      if (runtime.blockedKeys.has(input.key)) return;
      let logicalKey = input.key;
      let control = `key:${input.key}`;
      if (merge !== undefined) {
        const winner = runtime.mergeWinners.get(merge.origin);
        if (winner !== undefined) return;
        runtime.mergeWinners.set(merge.origin, input.key);
        logicalKey = merge.origin;
        control = `merge:${merge.origin}`;
      }
      const taskIndex = runtime.value.settings.layout.taskKeys.indexOf(logicalKey);
      if (taskIndex >= 0) {
        let action = actionForTaskSlot(runtime.value.taskSlots, taskIndex);
        if (action?.kind === "task") {
          const sampledAt = safeNow(now);
          const previous = runtime.pendingTaskTap;
          const doubleTap = !runtime.value.settings.singleTapTaskKeys
            && previous?.slot === taskIndex
            && previous.sessionId === action.sessionId
            && sampledAt - previous.at >= 0
            && sampledAt - previous.at <= DEDICATED_HARDWARE_TASK_DOUBLE_TAP_MS;
          runtime.pendingTaskTap = runtime.value.settings.singleTapTaskKeys || doubleTap
            ? undefined
            : { slot: taskIndex, sessionId: action.sessionId, at: sampledAt };
          action = { ...action, focusWindow: runtime.value.settings.singleTapTaskKeys || doubleTap };
        } else {
          runtime.pendingTaskTap = undefined;
        }
        pressButton(model, runtime, control, action);
        return;
      }
      pressButton(
        model,
        runtime,
        control,
        actionFromBinding(runtime.value.settings.layout.keys[logicalKey].binding)
      );
      return;
    }

    runtime.downKeys.delete(input.key);
    runtime.blockedKeys.delete(input.key);
    if (merge !== undefined) {
      if (runtime.mergeWinners.get(merge.origin) !== input.key) return;
      runtime.mergeWinners.delete(merge.origin);
      releaseButton(model, runtime, `merge:${merge.origin}`);
      return;
    }
    releaseButton(model, runtime, `key:${input.key}`);
  };

  const handleStick = (
    model: DedicatedHardwareModelId,
    runtime: ModelRuntime,
    input: Extract<DedicatedHardwareInputEvent, { kind: "stick" }>
  ): void => {
    const direction = dominantDirection(input.x, input.y);
    if (direction === undefined) {
      runtime.stickNeedsCenter = false;
      runtime.stickDirection = undefined;
      stopScroll(model, runtime, "release");
      return;
    }
    if (runtime.stickNeedsCenter) return;
    const binding = runtime.value.settings.layout.stick[direction];
    const scrollDirection = binding.kind === "command" && binding.command === "scroll-up" ? "up"
      : binding.kind === "command" && binding.command === "scroll-down" ? "down"
        : undefined;
    const distance = Math.max(Math.abs(input.x), Math.abs(input.y));
    if (scrollDirection !== undefined) {
      if (runtime.scrolling && runtime.scrollDirection !== scrollDirection) stopScroll(model, runtime, "release");
      const phase = runtime.scrolling ? "move" : "press";
      if (emit(model, { kind: "scroll", phase, direction: scrollDirection, distance })) {
        runtime.scrolling = true;
        runtime.scrollDirection = scrollDirection;
        runtime.stickDirection = direction;
        armScrollWatchdog(model, runtime);
      }
      return;
    }
    stopScroll(model, runtime, "release");
    if (runtime.stickDirection === direction) return;
    runtime.stickDirection = direction;
    emitOneShot(model, binding);
  };

  const handleEncoder = (
    model: DedicatedHardwareModelId,
    runtime: ModelRuntime,
    input: Extract<DedicatedHardwareInputEvent, { kind: "encoder" }>
  ): void => {
    if (input.delta !== 0) {
      const side = input.delta < 0 ? "left" : "right";
      const binding = encoderTurnBinding(runtime.value.settings, side);
      emitOneShot(model, binding);
    }
    if (input.pressed === runtime.encoderPressed) return;
    runtime.encoderPressed = input.pressed;
    if (input.pressed) {
      if (runtime.encoderBlocked) return;
      runtime.encoderLongFired = false;
      if (runtime.encoderTimer !== undefined) clearTimer(runtime.encoderTimer);
      runtime.encoderTimer = setTimer(() => {
        runtime.encoderTimer = undefined;
        if (!runtime.encoderPressed || runtime.encoderBlocked) return;
        runtime.encoderLongFired = true;
        emitOneShot(model, encoderPressBinding(runtime.value.settings, "longPress"));
      }, DEDICATED_HARDWARE_ENCODER_LONG_PRESS_MS);
      return;
    }
    if (runtime.encoderTimer !== undefined) {
      clearTimer(runtime.encoderTimer);
      runtime.encoderTimer = undefined;
    }
    if (runtime.encoderBlocked) {
      runtime.encoderBlocked = false;
      runtime.encoderLongFired = false;
      return;
    }
    if (!runtime.encoderLongFired) emitOneShot(model, encoderPressBinding(runtime.value.settings, "click"));
    runtime.encoderLongFired = false;
  };

  const controller: DedicatedHardwareInputController = {
    updateModel: (model, value) => {
      assertModel(model);
      const canonical: DedicatedHardwareInputModel = {
        settings: cloneDedicatedHardwareSettings(value.settings),
        taskSlots: cloneTaskSlotSelection(value.taskSlots)
      };
      const signature = JSON.stringify(canonical);
      const existing = runtimes.get(model);
      if (existing !== undefined && existing.signature === signature) {
        existing.value = canonical;
        return;
      }
      if (existing !== undefined) cancelRuntime(model, existing);
      const runtime: ModelRuntime = existing ?? {
        value: canonical,
        signature,
        preview: false,
        downKeys: new Set(),
        blockedKeys: new Set(),
        mergeWinners: new Map(),
        activeButtons: new Map(),
        stickDirection: undefined,
        stickNeedsCenter: true,
        scrolling: false,
        scrollDirection: undefined,
        scrollTimer: undefined,
        encoderPressed: false,
        encoderBlocked: false,
        encoderLongFired: false,
        encoderTimer: undefined,
        pendingTaskTap: undefined
      };
      runtime.value = canonical;
      runtime.signature = signature;
      runtime.stickNeedsCenter = true;
      runtimes.set(model, runtime);
      if (!canonical.settings.enabled) cancelRuntime(model, runtime);
    },
    setPreview: (model, enabled) => {
      assertModel(model);
      if (typeof enabled !== "boolean") throw new TypeError("Dedicated hardware preview must be boolean.");
      const runtime = runtimes.get(model);
      if (runtime === undefined || runtime.preview === enabled) return;
      cancelRuntime(model, runtime);
      runtime.preview = enabled;
    },
    handleInput: (model, input) => {
      assertModel(model);
      if (!isInput(input)) return;
      const runtime = runtimes.get(model);
      if (runtime === undefined) return;
      if (runtime.preview) {
        trackPreviewNeutral(runtime, input);
        try { options.emitPreview?.(model, cloneInput(input)); } catch { /* Preview cannot own input. */ }
        return;
      }
      if (!runtime.value.settings.enabled) return;
      if (input.kind === "key") handleKey(model, runtime, input);
      if (input.kind === "stick") handleStick(model, runtime, input);
      if (input.kind === "encoder") handleEncoder(model, runtime, input);
    },
    cancelModel: (model) => {
      assertModel(model);
      const runtime = runtimes.get(model);
      if (runtime !== undefined) cancelRuntime(model, runtime);
    },
    cancelAll: () => {
      for (const [model, runtime] of runtimes) cancelRuntime(model, runtime);
    }
  };
  return Object.freeze(controller);
}

function actionFromBinding(binding: DedicatedHardwareBinding | DedicatedHardwareAction): DedicatedHardwareAction | undefined {
  if (binding.kind === "none") return undefined;
  if (binding.kind === "command") return { kind: "command", command: binding.command };
  if (binding.kind === "voice") return { kind: "voice" };
  if (binding.kind === "skill") {
    return { kind: "skill", serverId: binding.serverId, resourceId: binding.resourceId, name: binding.name };
  }
  if (binding.kind === "composer-text") return { kind: "composer-text", text: binding.text };
  if (binding.kind === "fixed-link") return { kind: "fixed-link", linkId: binding.linkId };
  return binding;
}

function actionForTaskSlot(
  selection: DedicatedHardwareTaskSlotSelection,
  index: number
): DedicatedHardwareAction | undefined {
  const slot = selection.slots[index];
  if (slot === undefined) return { kind: "command", command: "new-task" };
  if (slot.binding !== null) {
    return slot.binding.kind === "none"
      ? { kind: "command", command: "new-task" }
      : actionFromBinding(slot.binding);
  }
  if (slot.sessionId === null || slot.sessionGeneration === null || slot.targetId === null) {
    return { kind: "command", command: "new-task" };
  }
  return {
    kind: "task",
    profileId: selection.profileId,
    serverId: selection.serverId,
    connectionGeneration: selection.connectionGeneration,
    snapshotRevision: selection.snapshotRevision,
    sessionId: slot.sessionId,
    sessionGeneration: slot.sessionGeneration,
    targetId: slot.targetId,
    focusWindow: true
  };
}

function safeNow(now: () => number): number {
  const value = now();
  return Number.isFinite(value) ? value : 0;
}

function encoderTurnBinding(
  settings: DedicatedHardwareSettings,
  side: "left" | "right"
): DedicatedHardwareBinding {
  if (settings.layout.encoderMode === "custom") return settings.layout.encoder[side];
  if (settings.layout.encoderMode === "session-switch") {
    return { kind: "command", command: side === "left" ? "previous-task" : "next-task" };
  }
  if (settings.layout.encoderMode === "reasoning") {
    return { kind: "command", command: side === "left" ? "effort-decrease" : "effort-increase" };
  }
  if (settings.layout.encoderMode === "conversation-scroll") {
    return { kind: "command", command: side === "left" ? "scroll-up" : "scroll-down" };
  }
  return { kind: "command", command: side === "left" ? "previous-panel" : "next-panel" };
}

function encoderPressBinding(
  settings: DedicatedHardwareSettings,
  input: "click" | "longPress"
): DedicatedHardwareBinding {
  if (settings.layout.encoderMode === "custom") return settings.layout.encoder[input];
  if (input === "longPress") return { kind: "command", command: "open-settings" };
  if (settings.layout.encoderMode === "conversation-scroll") return { kind: "command", command: "scroll-bottom" };
  return { kind: "command", command: "activate" };
}

function dominantDirection(x: number, y: number): DedicatedHardwareDirection | undefined {
  const absoluteX = Math.abs(x);
  const absoluteY = Math.abs(y);
  if (Math.max(absoluteX, absoluteY) <= DEDICATED_HARDWARE_STICK_DEAD_ZONE) return undefined;
  if (absoluteY >= absoluteX) return y < 0 ? "up" : "down";
  return x < 0 ? "left" : "right";
}

function mergeForKey(
  merges: readonly DedicatedHardwareKeyMerge[],
  key: DedicatedHardwarePhysicalKey
): DedicatedHardwareKeyMerge | undefined {
  return merges.find((merge) => merge.origin === key || merge.cover === key);
}

function trackPreviewNeutral(runtime: ModelRuntime, input: DedicatedHardwareInputEvent): void {
  if (input.kind === "key") {
    if (input.pressed) {
      runtime.downKeys.add(input.key);
      runtime.blockedKeys.add(input.key);
    } else {
      runtime.downKeys.delete(input.key);
      runtime.blockedKeys.delete(input.key);
    }
  }
  if (input.kind === "stick" && dominantDirection(input.x, input.y) === undefined) runtime.stickNeedsCenter = false;
  if (input.kind === "stick" && dominantDirection(input.x, input.y) !== undefined) runtime.stickNeedsCenter = true;
  if (input.kind === "encoder") {
    runtime.encoderPressed = input.pressed;
    if (input.pressed) runtime.encoderBlocked = true;
    else runtime.encoderBlocked = false;
  }
}

function cloneTaskSlotSelection(value: DedicatedHardwareTaskSlotSelection): DedicatedHardwareTaskSlotSelection {
  if (!exact(value as unknown as Record<string, unknown>, [
    "version", "profileId", "serverId", "connectionGeneration", "snapshotRevision", "slots"
  ]) || value.version !== 1 || !bounded(value.profileId) || !bounded(value.serverId) ||
      !decimal(value.connectionGeneration) || !decimal(value.snapshotRevision) ||
      !Array.isArray(value.slots) || value.slots.length > 6) {
    throw new TypeError("Invalid dedicated hardware task-slot selection.");
  }
  const slots = value.slots.map((slot, index) => cloneTaskSlot(slot, index));
  return {
    version: 1,
    profileId: value.profileId,
    serverId: value.serverId,
    connectionGeneration: value.connectionGeneration,
    snapshotRevision: value.snapshotRevision,
    slots
  };
}

function cloneTaskSlot(slot: DedicatedHardwareSelectedTaskSlot, expected: number): DedicatedHardwareSelectedTaskSlot {
  if (!exact(slot as unknown as Record<string, unknown>, [
    "slot", "sessionId", "sessionGeneration", "targetId", "title", "binding"
  ]) || slot.slot !== expected || !(slot.title === null || boundedText(slot.title, 512, 2_048))) {
    throw new TypeError("Invalid dedicated hardware task slot.");
  }
  let binding: DedicatedHardwareBinding | null = null;
  if (slot.binding !== null) {
    const parsed = parseDedicatedHardwareBinding(slot.binding);
    if (parsed === undefined) throw new TypeError("Invalid dedicated hardware task binding.");
    binding = parsed;
  }
  if (slot.sessionId === null) {
    if (slot.sessionGeneration !== null || slot.targetId !== null) {
      throw new TypeError("Invalid empty dedicated hardware task slot.");
    }
  } else if (!bounded(slot.sessionId) || !decimal(slot.sessionGeneration) || !bounded(slot.targetId) || binding !== null) {
    throw new TypeError("Invalid dedicated hardware task identity.");
  }
  return {
    slot: expected,
    sessionId: slot.sessionId,
    sessionGeneration: slot.sessionGeneration,
    targetId: slot.targetId,
    title: slot.title,
    binding
  };
}

function isInput(value: unknown): value is DedicatedHardwareInputEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) return false;
  const input = value as Record<string, unknown>;
  if (input.kind === "key") return exact(input, ["kind", "key", "pressed"]) &&
    typeof input.key === "string" && (DEDICATED_HARDWARE_PHYSICAL_KEYS as readonly string[]).includes(input.key) &&
    typeof input.pressed === "boolean";
  if (input.kind === "stick") return exact(input, ["kind", "x", "y", "pressed"]) &&
    unit(input.x) && unit(input.y) && typeof input.pressed === "boolean";
  if (input.kind === "encoder") return exact(input, ["kind", "delta", "pressed"]) &&
    (input.delta === -1 || input.delta === 0 || input.delta === 1) && typeof input.pressed === "boolean";
  return false;
}

function cloneInput(input: DedicatedHardwareInputEvent): DedicatedHardwareInputEvent {
  return { ...input };
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function bounded(value: unknown): value is string {
  return boundedText(value, 512, 2_048) && value.length > 0;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) && value.length <= 64;
}

function assertModel(model: DedicatedHardwareModelId): void {
  if (!isDedicatedHardwareModelId(model) || !(DEDICATED_HARDWARE_MODEL_IDS as readonly string[]).includes(model)) {
    throw new TypeError("Unknown dedicated hardware model.");
  }
}

function boundedText(value: unknown, maximumCharacters: number, maximumBytes: number): value is string {
  return typeof value === "string" && value.length <= maximumCharacters && value.trim() === value &&
    !hasLoneSurrogate(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
