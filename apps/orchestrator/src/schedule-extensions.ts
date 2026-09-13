import type { ScheduleScriptCapability } from "./schedule-script-runner.js";

export interface SchedulePreRunHookConfiguration {
  readonly command: string;
  readonly filePath: string;
  readonly timeoutMs?: number;
}

export interface ScheduleScriptExecutionConfiguration {
  readonly command: string;
  readonly timeoutMs?: number;
  readonly capabilities: readonly ScheduleScriptCapability[];
}

export interface ScheduleWorktreeConfiguration {
  readonly useWorktree: boolean;
  readonly sourceRef?: string;
  readonly refreshRemote: boolean;
}

export interface ScheduleExtensionSnapshot {
  readonly format: 1;
  readonly silentWhenIdle: boolean;
  readonly notify: { readonly desktop: boolean };
  readonly executionMode: "agent" | "script";
  readonly scriptConfig?: ScheduleScriptExecutionConfiguration;
  readonly expireAt?: number;
  readonly preRunHook?: SchedulePreRunHookConfiguration;
}

export function scheduleExtensionSnapshot(value: unknown): ScheduleExtensionSnapshot {
  if (!isRecord(value) || value["scheduler"] === undefined) {
    throw new Error("Stored Schedule extensions are invalid.");
  }
  const scheduler = value["scheduler"];
  if (!isRecord(scheduler) || scheduler["format"] !== 1) throw new Error("Stored Schedule extensions are invalid.");
  const silentWhenIdle = scheduler["silentWhenIdle"];
  const notify = scheduler["notify"];
  if (typeof silentWhenIdle !== "boolean" || !isRecord(notify) || typeof notify["desktop"] !== "boolean") {
    throw new Error("Stored Schedule notification extensions are invalid.");
  }
  const expireAt = scheduler["expireAt"];
  if (expireAt !== undefined && (!Number.isSafeInteger(expireAt) || (expireAt as number) < 0)) {
    throw new Error("Stored Schedule expiration is invalid.");
  }
  const preRunHook = scheduler["preRunHook"] === undefined
    ? undefined
    : schedulePreRunHookConfiguration(scheduler["preRunHook"]);
  const executionMode = scheduler["executionMode"];
  if (executionMode !== "agent" && executionMode !== "script") {
    throw new Error("Stored Schedule execution mode is invalid.");
  }
  const scriptConfig = scheduler["scriptConfig"] === undefined
    ? undefined
    : scheduleScriptExecutionConfiguration(scheduler["scriptConfig"]);
  if ((executionMode === "script") !== (scriptConfig !== undefined)) {
    throw new Error("Stored Schedule script execution configuration is invalid.");
  }
  return {
    format: 1,
    silentWhenIdle,
    notify: { desktop: notify["desktop"] as boolean },
    executionMode,
    ...(scriptConfig === undefined ? {} : { scriptConfig }),
    ...(expireAt === undefined ? {} : { expireAt: expireAt as number }),
    ...(preRunHook === undefined ? {} : { preRunHook })
  };
}

export function withScheduleExtensionSnapshot(
  value: unknown,
  extension: ScheduleExtensionSnapshot
): Readonly<Record<string, unknown>> {
  const base = isRecord(value) ? { ...value } : {};
  return {
    ...base,
    scheduler: {
      format: 1,
      silentWhenIdle: extension.silentWhenIdle,
      notify: { desktop: extension.notify.desktop },
      executionMode: extension.executionMode,
      ...(extension.scriptConfig === undefined ? {} : {
        scriptConfig: {
          command: extension.scriptConfig.command,
          capabilities: [...extension.scriptConfig.capabilities],
          ...(extension.scriptConfig.timeoutMs === undefined ? {} : { timeoutMs: extension.scriptConfig.timeoutMs })
        }
      }),
      ...(extension.expireAt === undefined ? {} : { expireAt: extension.expireAt }),
      ...(extension.preRunHook === undefined ? {} : { preRunHook: { ...extension.preRunHook } })
    }
  };
}

export function defaultScheduleExtensionSnapshot(): ScheduleExtensionSnapshot {
  return {
    format: 1,
    silentWhenIdle: false,
    notify: { desktop: true },
    executionMode: "agent"
  };
}

export function defaultScheduleWorktreeConfiguration(): ScheduleWorktreeConfiguration {
  return { useWorktree: false, refreshRemote: false };
}

/** Reads the public, capability-neutral isolated-workspace fields stored at
 * the root of a Schedule execution snapshot. Invalid combinations fail closed
 * so malformed or tool-authored records cannot silently run in the Target base. */
export function scheduleWorktreeConfiguration(value: unknown): ScheduleWorktreeConfiguration {
  if (!isRecord(value)) throw new Error("Stored Schedule isolated workspace configuration is invalid.");
  const record = value;
  const useWorktree = record["useWorktree"];
  const refreshRemote = record["refreshWorktreeRemote"];
  const sourceRef = record["worktreeSourceRef"];
  if (typeof useWorktree !== "boolean" || typeof refreshRemote !== "boolean") {
    throw new Error("Stored Schedule isolated workspace configuration is invalid.");
  }
  if (sourceRef !== undefined && (
    typeof sourceRef !== "string" || sourceRef.trim() !== sourceRef || sourceRef.length === 0 ||
    sourceRef.length > 1_024 || /[\p{Cc}\u2028\u2029]/u.test(sourceRef)
  )) {
    throw new Error("Stored Schedule isolated workspace source is invalid.");
  }
  if (!useWorktree && (sourceRef !== undefined || refreshRemote)) {
    throw new Error("Stored Schedule isolated workspace options require isolation to be enabled.");
  }
  return {
    useWorktree,
    ...(sourceRef === undefined ? {} : { sourceRef }),
    refreshRemote
  };
}

function scheduleScriptExecutionConfiguration(value: unknown): ScheduleScriptExecutionConfiguration {
  if (!isRecord(value)) throw new Error("Stored Schedule script execution configuration is invalid.");
  const command = boundedString(value["command"], 32_768);
  const timeoutMs = value["timeoutMs"];
  const capabilities = value["capabilities"];
  if (
    command === undefined ||
    (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0)) ||
    !Array.isArray(capabilities) || capabilities.some((capability) => capability !== "sessions.dispatch") ||
    new Set(capabilities).size !== capabilities.length
  ) throw new Error("Stored Schedule script execution configuration is invalid.");
  return {
    command,
    capabilities: capabilities as ScheduleScriptCapability[],
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number })
  };
}

function schedulePreRunHookConfiguration(value: unknown): SchedulePreRunHookConfiguration {
  if (!isRecord(value)) throw new Error("Stored Schedule pre-run hook is invalid.");
  const command = boundedString(value["command"], 32_768);
  const filePath = boundedString(value["filePath"], 4_096);
  const timeoutMs = value["timeoutMs"];
  if (
    command === undefined || filePath === undefined ||
    (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0))
  ) throw new Error("Stored Schedule pre-run hook is invalid.");
  return {
    command,
    filePath,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number })
  };
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum && !value.includes("\0")
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
