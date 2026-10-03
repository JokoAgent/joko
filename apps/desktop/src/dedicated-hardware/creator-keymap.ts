import { DEDICATED_HARDWARE_KEYMAP_MAX_BYTES } from "./keymap-controller.js";
import {
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  type DedicatedHardwarePhysicalKey
} from "./settings.js";

export interface CreatorKeymapContext {
  readonly profileIndex: number;
  readonly layerIndex: number;
}

const KEYMAP_ROWS: readonly (readonly DedicatedHardwarePhysicalKey[])[] = [
  ["AG00", "AG01"],
  ["AG02", "AG03", "AG04", "AG05"],
  ["ACT06", "ACT07", "ACT08", "ACT09"],
  ["ACT10", "ACT11", "ACT12"]
];
const AG_CODES = DEDICATED_HARDWARE_PHYSICAL_KEYS.slice(0, 6);
const ACT_CODES = DEDICATED_HARDWARE_PHYSICAL_KEYS.slice(6);
const ENCODERS = [["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]];
const JOYSTICK = { type: "VENDOR", sectors: [] };

interface ActiveLayer {
  readonly document: Record<string, unknown> & { profiles: unknown[] };
  readonly profile: Record<string, unknown> & { layers: unknown[] };
  readonly layer: Record<string, unknown>;
  readonly layout: Record<string, unknown>;
}

export function buildCreatorManagedKeymap(
  original: string,
  taskKeys: readonly DedicatedHardwarePhysicalKey[],
  context: CreatorKeymapContext
): string {
  const active = readActiveLayer(original, context);
  const task = validateTaskKeys(taskKeys);
  const selected = new Set(task);
  const command = DEDICATED_HARDWARE_PHYSICAL_KEYS.filter((key) => !selected.has(key));
  const assigned = new Map<DedicatedHardwarePhysicalKey, DedicatedHardwarePhysicalKey>();
  const litCount = Math.min(task.length, AG_CODES.length);
  for (let index = 0; index < litCount; index += 1) assigned.set(task[index]!, AG_CODES[index]!);
  const restCodes = [...ACT_CODES, ...AG_CODES.slice(litCount)];
  [...task.slice(litCount), ...command].forEach((physical, index) => {
    assigned.set(physical, restCodes[index]!);
  });
  const keymap = KEYMAP_ROWS.map((row) => row.map((physical) => `KV_OAI_${assigned.get(physical)!}`));
  const layout = {
    ...active.layout,
    encoders: ENCODERS.map((row) => [...row]),
    buttons: [],
    keymap,
    joystick: { ...JOYSTICK, sectors: [] }
  };
  if (same(active.layout.encoders, layout.encoders) && same(active.layout.buttons, layout.buttons) &&
      same(active.layout.keymap, layout.keymap) && managedJoystick(active.layout.joystick)) return original;
  const layers = [...active.profile.layers];
  layers[context.layerIndex - 1] = { ...active.layer, layout };
  const profiles = [...active.document.profiles];
  profiles[context.profileIndex] = { ...active.profile, layers };
  const contents = JSON.stringify({ ...active.document, profiles });
  assertBoundedContents(contents);
  return contents;
}

/** Wire codes become physical keys only after the caller confirms the written document. */
export function readCreatorManagedHidMapping(
  contents: string,
  context: CreatorKeymapContext
): ReadonlyMap<DedicatedHardwarePhysicalKey, DedicatedHardwarePhysicalKey> | undefined {
  let active: ActiveLayer;
  try { active = readActiveLayer(contents, context); } catch { return undefined; }
  if (!same(active.layout.encoders, ENCODERS) || !same(active.layout.buttons, []) ||
      !managedJoystick(active.layout.joystick) || !Array.isArray(active.layout.keymap) ||
      active.layout.keymap.length !== KEYMAP_ROWS.length) return undefined;
  const inverse = new Map<DedicatedHardwarePhysicalKey, DedicatedHardwarePhysicalKey>();
  for (let rowIndex = 0; rowIndex < KEYMAP_ROWS.length; rowIndex += 1) {
    const physicalRow = KEYMAP_ROWS[rowIndex]!;
    const wireRow = active.layout.keymap[rowIndex];
    if (!Array.isArray(wireRow) || wireRow.length !== physicalRow.length) return undefined;
    for (let column = 0; column < physicalRow.length; column += 1) {
      const code: unknown = wireRow[column];
      if (typeof code !== "string" || !code.startsWith("KV_OAI_")) return undefined;
      const wire = code.slice("KV_OAI_".length);
      if (!isPhysicalKey(wire) || inverse.has(wire)) return undefined;
      inverse.set(wire, physicalRow[column]!);
    }
  }
  return inverse.size === DEDICATED_HARDWARE_PHYSICAL_KEYS.length ? inverse : undefined;
}

function readActiveLayer(contents: string, context: CreatorKeymapContext): ActiveLayer {
  assertBoundedContents(contents);
  if (!record(context) || Object.keys(context).sort().join(",") !== "layerIndex,profileIndex" ||
      !Number.isSafeInteger(context.profileIndex) || context.profileIndex < 0 ||
      !Number.isSafeInteger(context.layerIndex) || context.layerIndex < 1) {
    throw new TypeError("Creator keymap requires an explicit active profile and layer.");
  }
  const document: unknown = JSON.parse(contents);
  if (!record(document) || !Array.isArray(document.profiles) || document.profiles.length === 0) {
    throw new TypeError("Creator keymap document is invalid.");
  }
  const profile: unknown = document.profiles[context.profileIndex];
  if (!record(profile) || !Array.isArray(profile.layers)) {
    throw new TypeError("Creator keymap active profile is unavailable.");
  }
  const layer: unknown = profile.layers[context.layerIndex - 1];
  if (!record(layer) || !record(layer.layout)) {
    throw new TypeError("Creator keymap active layer is unavailable.");
  }
  return {
    document: document as ActiveLayer["document"],
    profile: profile as ActiveLayer["profile"],
    layer,
    layout: layer.layout
  };
}

function validateTaskKeys(taskKeys: readonly DedicatedHardwarePhysicalKey[]): DedicatedHardwarePhysicalKey[] {
  if (!Array.isArray(taskKeys) || taskKeys.length > DEDICATED_HARDWARE_PHYSICAL_KEYS.length) {
    throw new TypeError("Creator task key selection is invalid.");
  }
  let previous = -1;
  for (const key of taskKeys) {
    if (!isPhysicalKey(key)) throw new TypeError("Creator task key selection is invalid.");
    const position = DEDICATED_HARDWARE_PHYSICAL_KEYS.indexOf(key);
    if (position <= previous) throw new TypeError("Creator task keys must be unique and in physical order.");
    previous = position;
  }
  return [...taskKeys];
}

function assertBoundedContents(contents: string): void {
  if (typeof contents !== "string" || contents.length === 0 ||
      contents.length > DEDICATED_HARDWARE_KEYMAP_MAX_BYTES ||
      new TextEncoder().encode(contents).byteLength > DEDICATED_HARDWARE_KEYMAP_MAX_BYTES) {
    throw new TypeError("Creator keymap document exceeds its size boundary.");
  }
}

function isPhysicalKey(value: string): value is DedicatedHardwarePhysicalKey {
  return (DEDICATED_HARDWARE_PHYSICAL_KEYS as readonly string[]).includes(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function managedJoystick(value: unknown): boolean {
  return record(value) && Object.keys(value).length === 2 && value.type === "VENDOR" &&
    Array.isArray(value.sectors) && value.sectors.length === 0;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
