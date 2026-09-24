import { createHash, randomUUID } from "node:crypto";

export class SimulatorScreenMapError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "STALE_UI_SNAPSHOT", message: string) { super(message); }
}

export interface SimulatorScreenElement {
  readonly elementId: string;
  readonly role: string;
  readonly label: string | null;
  readonly value: string | null;
  readonly enabled: boolean | null;
  readonly visible: boolean | null;
  readonly frame: { readonly x: number; readonly y: number;
    readonly width: number; readonly height: number } | null;
}

export interface SimulatorScreenMap {
  readonly snapshotId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly interactionEpoch: number;
  readonly capturedAt: string;
  readonly truncated: boolean;
  readonly elements: readonly SimulatorScreenElement[];
}

export interface SimulatorAccessibilityViolation {
  readonly code: "missing-label" | "missing-frame" | "invalid-frame";
  readonly elementId: string;
  readonly role: string;
  readonly label: string | null;
  readonly message: string;
}

export interface SimulatorAccessibilityAudit {
  readonly snapshotId: string;
  readonly generation: number;
  readonly checkedElements: number;
  readonly violationCount: number;
  readonly truncated: boolean;
  readonly violations: readonly SimulatorAccessibilityViolation[];
}

export interface SimulatorScreenMapDiff {
  readonly baselineSnapshotId: string;
  readonly currentSnapshotId: string;
  readonly baselineGeneration: number;
  readonly currentGeneration: number;
  readonly added: readonly SimulatorScreenElement[];
  readonly removed: readonly SimulatorScreenElement[];
  readonly changed: readonly { readonly elementId: string;
    readonly before: SimulatorScreenElement; readonly after: SimulatorScreenElement }[];
  readonly unchangedCount: number;
  readonly truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, limit = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function frame(value: unknown): SimulatorScreenElement["frame"] {
  const candidate = record(value);
  if (!candidate) return null;
  const x = finite(candidate["x"]);
  const y = finite(candidate["y"]);
  const width = finite(candidate["width"]);
  const height = finite(candidate["height"]);
  return x === null || y === null || width === null || height === null
    ? null : { x, y, width, height };
}

function positiveBound(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/** Accessibility-first projection; raw driver metadata never enters the public map. */
export function normalizeSimulatorScreenMap(input: {
  readonly instanceId: string;
  readonly generation: number;
  readonly interactionEpoch: number;
  readonly capturedAt: string;
  readonly tree: unknown;
  readonly maxElements?: number;
}): SimulatorScreenMap {
  const maxElements = input.maxElements ?? 1_500;
  if (!positiveBound(maxElements, 1_500) || !positiveBound(input.generation, Number.MAX_SAFE_INTEGER)
    || !Number.isSafeInteger(input.interactionEpoch) || input.interactionEpoch < 0
    || input.instanceId.length < 1 || input.instanceId.length > 128) {
    throw new SimulatorScreenMapError("INVALID_ARGUMENT", "Simulator screen-map bounds are invalid.");
  }
  const elements: SimulatorScreenElement[] = [];
  const maxNodes = maxElements * 4;
  const queue: { value: unknown; path: string; depth: number }[] = [
    { value: input.tree, path: "0", depth: 0 }
  ];
  let head = 0;
  let truncated = false;
  while (head < queue.length && elements.length < maxElements && head < maxNodes) {
    const entry = queue[head++]!;
    if (Array.isArray(entry.value)) {
      if (entry.depth >= 64) { truncated = true; continue; }
      const room = maxNodes - queue.length;
      const count = Math.min(entry.value.length, room);
      truncated ||= count < entry.value.length;
      for (let index = 0; index < count; index += 1) {
        queue.push({ value: entry.value[index], path: `${entry.path}.${index}`, depth: entry.depth + 1 });
      }
      continue;
    }
    const node = record(entry.value);
    if (!node) continue;
    const role = text(node["type"], 128) ?? text(node["role"], 128)
      ?? text(node["class"], 128) ?? "element";
    const label = text(node["label"]) ?? text(node["name"]) ?? text(node["identifier"]);
    const value = text(node["value"]);
    const nodeFrame = frame(node["rect"]) ?? frame(node["frame"]);
    if (label || value || nodeFrame) {
      const elementId = createHash("sha256")
        .update(`${entry.path}\0${role}\0${label ?? ""}\0${JSON.stringify(nodeFrame)}`)
        .digest("hex").slice(0, 20);
      elements.push({ elementId, role, label, value,
        enabled: typeof node["enabled"] === "boolean" ? node["enabled"] : null,
        visible: typeof node["visible"] === "boolean" ? node["visible"] : null,
        frame: nodeFrame });
    }
    const children = node["children"] ?? node["elements"];
    if (Array.isArray(children)) {
      if (entry.depth >= 64) { truncated = true; continue; }
      const room = maxNodes - queue.length;
      const count = Math.min(children.length, room);
      truncated ||= count < children.length;
      for (let index = 0; index < count; index += 1) {
        queue.push({ value: children[index], path: `${entry.path}.${index}`, depth: entry.depth + 1 });
      }
    }
  }
  return { snapshotId: randomUUID(), instanceId: input.instanceId, generation: input.generation,
    interactionEpoch: input.interactionEpoch, capturedAt: input.capturedAt,
    truncated: truncated || head < queue.length, elements };
}

const INTERACTIVE_ROLE = /button|cell|checkbox|link|menuitem|picker|radio|slider|stepper|switch|tab|textfield|text field/iu;

export function auditSimulatorScreenMap(screenMap: SimulatorScreenMap,
  maxViolations = 200): SimulatorAccessibilityAudit {
  if (!positiveBound(maxViolations, 500)) {
    throw new SimulatorScreenMapError("INVALID_ARGUMENT", "Simulator audit bound is invalid.");
  }
  const violations: SimulatorAccessibilityViolation[] = [];
  for (const element of screenMap.elements) {
    if (element.visible === false || !INTERACTIVE_ROLE.test(element.role)) continue;
    if (!element.label && !element.value) {
      violations.push({ code: "missing-label", elementId: element.elementId, role: element.role,
        label: element.label, message: "Interactive element has no accessible label or value." });
    }
    if (!element.frame) {
      violations.push({ code: "missing-frame", elementId: element.elementId, role: element.role,
        label: element.label, message: "Interactive element has no usable accessibility frame." });
    } else if (element.frame.width <= 0 || element.frame.height <= 0) {
      violations.push({ code: "invalid-frame", elementId: element.elementId, role: element.role,
        label: element.label, message: "Interactive element has a non-positive accessibility frame." });
    }
  }
  return { snapshotId: screenMap.snapshotId, generation: screenMap.generation,
    checkedElements: screenMap.elements.length, violationCount: violations.length,
    truncated: violations.length > maxViolations, violations: violations.slice(0, maxViolations) };
}

export function diffSimulatorScreenMaps(baseline: SimulatorScreenMap, current: SimulatorScreenMap,
  maxChanges = 200): SimulatorScreenMapDiff {
  if (!positiveBound(maxChanges, 500) || baseline.instanceId !== current.instanceId
    || baseline.generation !== current.generation) {
    throw new SimulatorScreenMapError("INVALID_ARGUMENT", "Simulator screen-map comparison is invalid.");
  }
  const beforeById = new Map(baseline.elements.map(element => [element.elementId, element]));
  const afterById = new Map(current.elements.map(element => [element.elementId, element]));
  const added: SimulatorScreenElement[] = [];
  const removed: SimulatorScreenElement[] = [];
  const changed: { elementId: string; before: SimulatorScreenElement; after: SimulatorScreenElement }[] = [];
  let unchangedCount = 0;
  for (const [elementId, before] of beforeById) {
    const after = afterById.get(elementId);
    if (!after) removed.push(before);
    else if (JSON.stringify(before) === JSON.stringify(after)) unchangedCount += 1;
    else changed.push({ elementId, before, after });
  }
  for (const [elementId, after] of afterById) {
    if (!beforeById.has(elementId)) added.push(after);
  }
  let remaining = maxChanges;
  const boundedAdded = added.slice(0, remaining);
  remaining -= boundedAdded.length;
  const boundedRemoved = removed.slice(0, remaining);
  remaining -= boundedRemoved.length;
  const boundedChanged = changed.slice(0, remaining);
  return { baselineSnapshotId: baseline.snapshotId, currentSnapshotId: current.snapshotId,
    baselineGeneration: baseline.generation, currentGeneration: current.generation,
    added: boundedAdded, removed: boundedRemoved, changed: boundedChanged, unchangedCount,
    truncated: added.length + removed.length + changed.length > maxChanges };
}

interface ScreenMapState { readonly interactionEpoch: number; readonly current: SimulatorScreenMap | null }

/** Process-local snapshots are invalidated on interaction, route retirement or restart. */
export class SimulatorScreenMapStore {
  readonly #state = new Map<string, ScreenMapState>();

  #remember(instanceId: string, state: ScreenMapState): void {
    this.#state.delete(instanceId);
    this.#state.set(instanceId, state);
    if (this.#state.size > 128) this.#state.delete(this.#state.keys().next().value!);
  }

  current(instanceId: string): SimulatorScreenMap | null { return this.#state.get(instanceId)?.current ?? null; }
  currentEpoch(instanceId: string): number { return this.#state.get(instanceId)?.interactionEpoch ?? 0; }

  capture(input: { readonly instanceId: string; readonly generation: number;
    readonly capturedAt: string; readonly tree: unknown }): SimulatorScreenMap {
    const interactionEpoch = this.currentEpoch(input.instanceId);
    const current = normalizeSimulatorScreenMap({ ...input, interactionEpoch });
    this.#remember(input.instanceId, { interactionEpoch, current });
    return current;
  }

  requireCurrent(input: { readonly instanceId: string; readonly generation: number;
    readonly snapshotId: string }): SimulatorScreenMap {
    const current = this.current(input.instanceId);
    if (!current || current.snapshotId !== input.snapshotId || current.generation !== input.generation) {
      throw new SimulatorScreenMapError("STALE_UI_SNAPSHOT", "The UI changed. Read a new screen map.");
    }
    return current;
  }

  invalidate(instanceId: string): number {
    const next = this.currentEpoch(instanceId) + 1;
    this.#remember(instanceId, { interactionEpoch: next, current: null });
    return next;
  }

  clear(instanceId: string): void { this.#state.delete(instanceId); }
}
