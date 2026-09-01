import { redactSecrets, type RuntimeCommand } from "@joko/core";

export const SESSION_RUNTIME_COMMANDS_SETTING_KEY = "runtime.commands.observation";

const MAX_COMMANDS = 4_096;
const MAX_NAME_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_PATH_LENGTH = 4_096;

export interface MaterializedRuntimeCommands {
  readonly format: 1;
  readonly generation: number;
  readonly observedAt: number;
  readonly commands: readonly RuntimeCommand[];
}

/**
 * Runtime catalogs are untrusted Backend output. Persist one bounded,
 * redacted, deterministically ordered observation so array equality is exact
 * and independent of upstream enumeration order.
 */
export function normalizeRuntimeCommands(value: readonly RuntimeCommand[]): readonly RuntimeCommand[] {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) {
    throw new Error(`Runtime command catalog must contain at most ${MAX_COMMANDS} commands.`);
  }
  const commands = value.map((candidate, index) => normalizeRuntimeCommand(candidate, index));
  commands.sort(compareRuntimeCommands);

  const deduplicated = new Map<string, RuntimeCommand>();
  for (const command of commands) {
    const identity = runtimeCommandIdentity(command);
    if (!deduplicated.has(identity)) deduplicated.set(identity, command);
  }
  return [...deduplicated.values()];
}

export function materializedRuntimeCommands(value: unknown): MaterializedRuntimeCommands | undefined {
  if (!isRecord(value) || value["format"] !== 1) return undefined;
  const generation = value["generation"];
  const observedAt = value["observedAt"];
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) return undefined;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt < 0) return undefined;
  if (!Array.isArray(value["commands"])) return undefined;
  try {
    return {
      format: 1,
      generation: generation as number,
      observedAt,
      commands: normalizeRuntimeCommands(value["commands"] as RuntimeCommand[])
    };
  } catch {
    return undefined;
  }
}

export function runtimeCommandsObservation(
  generation: number,
  commands: readonly RuntimeCommand[],
  observedAt = Date.now()
): MaterializedRuntimeCommands {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Runtime command generation is invalid.");
  if (!Number.isFinite(observedAt) || observedAt < 0) throw new Error("Runtime command observation time is invalid.");
  return { format: 1, generation, observedAt, commands: normalizeRuntimeCommands(commands) };
}

export function sameRuntimeCommands(
  left: readonly RuntimeCommand[],
  right: readonly RuntimeCommand[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((command, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      command.name === candidate.name &&
      command.description === candidate.description &&
      command.source === candidate.source &&
      command.path === candidate.path &&
      command.loaded === candidate.loaded;
  });
}

function normalizeRuntimeCommand(value: RuntimeCommand, index: number): RuntimeCommand {
  if (!isRecord(value)) throw new Error(`Runtime command ${index} is not an object.`);
  const name = safeText(value["name"], MAX_NAME_LENGTH).trim();
  if (name === "" || name.startsWith("/") || /\s/u.test(name)) {
    throw new Error(`Runtime command ${index} has an invalid invocation name.`);
  }
  const source = value["source"];
  if (source !== "extension" && source !== "prompt" && source !== "skill") {
    throw new Error(`Runtime command ${index} has an invalid source.`);
  }
  if (typeof value["loaded"] !== "boolean") throw new Error(`Runtime command ${index} has an invalid loaded state.`);
  const description = safeText(value["description"], MAX_DESCRIPTION_LENGTH).trim();
  const path = value["path"] === undefined ? undefined : safeText(value["path"], MAX_PATH_LENGTH).trim();
  return {
    name,
    description,
    source,
    ...(path === undefined || path === "" ? {} : { path }),
    loaded: value["loaded"]
  };
}

function safeText(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error("Runtime command text is invalid.");
  return redactSecrets(value).slice(0, maximum);
}

function runtimeCommandIdentity(command: RuntimeCommand): string {
  return `${command.source}\0${command.name}\0${command.path ?? ""}`;
}

function compareRuntimeCommands(left: RuntimeCommand, right: RuntimeCommand): number {
  const identity = compareText(runtimeCommandIdentity(left), runtimeCommandIdentity(right));
  if (identity !== 0) return identity;
  if (left.loaded !== right.loaded) return left.loaded ? -1 : 1;
  return compareText(left.description, right.description);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
