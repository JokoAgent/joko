export const MAX_CONCURRENT_COMMANDS = 64;
export const MAX_WORKERS = 20;
export const MAX_WORKER_IDLE_RELEASE_MINUTES = 120;

export type ManagedProcessPriority = "normal" | "low" | "lowest";
export type AgentResourcePreset = "full" | "balanced" | "background";

export interface AgentResourceSettings {
  readonly maxConcurrentCommands: number;
  readonly processPriority: ManagedProcessPriority;
  readonly capToolchainThreads: boolean;
}

export interface CollaborationSettings {
  readonly workerSoftLimit: number;
  readonly workerHardLimit: number;
  readonly workerIdleReleaseMinutes: number;
}

export const DEFAULT_AGENT_RESOURCE_SETTINGS: AgentResourceSettings = Object.freeze({
  maxConcurrentCommands: 0,
  processPriority: "normal",
  capToolchainThreads: false
});

export const DEFAULT_COLLABORATION_SETTINGS: CollaborationSettings = Object.freeze({
  workerSoftLimit: 5,
  workerHardLimit: 8,
  workerIdleReleaseMinutes: 0
});

export class RuntimeGovernanceSettingsError extends Error {
  readonly code = "RUNTIME_GOVERNANCE_SETTINGS_INVALID";

  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "RuntimeGovernanceSettingsError";
  }
}

export function validateAgentResourceSettings(value: AgentResourceSettings): AgentResourceSettings {
  if (!isRecord(value)) throw new RuntimeGovernanceSettingsError("agentResource", "Agent resource settings are required.");
  requireExactKeys(value, ["maxConcurrentCommands", "processPriority", "capToolchainThreads"], "agentResource");
  return {
    maxConcurrentCommands: requiredInteger(
      value.maxConcurrentCommands,
      "maxConcurrentCommands",
      0,
      MAX_CONCURRENT_COMMANDS
    ),
    processPriority: requiredProcessPriority(value.processPriority),
    capToolchainThreads: requiredBoolean(value.capToolchainThreads, "capToolchainThreads")
  };
}

export function validateCollaborationSettings(value: CollaborationSettings): CollaborationSettings {
  if (!isRecord(value)) throw new RuntimeGovernanceSettingsError("collaboration", "Collaboration settings are required.");
  requireExactKeys(value, ["workerSoftLimit", "workerHardLimit", "workerIdleReleaseMinutes"], "collaboration");
  const soft = requiredInteger(value.workerSoftLimit, "workerSoftLimit", 1, MAX_WORKERS);
  return {
    workerSoftLimit: soft,
    workerHardLimit: requiredInteger(value.workerHardLimit, "workerHardLimit", soft, MAX_WORKERS),
    workerIdleReleaseMinutes: requiredInteger(
      value.workerIdleReleaseMinutes,
      "workerIdleReleaseMinutes",
      0,
      MAX_WORKER_IDLE_RELEASE_MINUTES
    )
  };
}

export function agentResourcePreset(
  preset: AgentResourcePreset,
  availableParallelism: number
): AgentResourceSettings {
  const cores = Math.max(1, Math.floor(Number.isFinite(availableParallelism) ? availableParallelism : 1));
  switch (preset) {
    case "full":
      return { ...DEFAULT_AGENT_RESOURCE_SETTINGS };
    case "balanced":
      return {
        maxConcurrentCommands: Math.min(MAX_CONCURRENT_COMMANDS, Math.max(2, Math.ceil(cores / 2))),
        processPriority: "low",
        capToolchainThreads: true
      };
    case "background":
      return { maxConcurrentCommands: 2, processPriority: "lowest", capToolchainThreads: true };
  }
}

function requiredProcessPriority(value: unknown): ManagedProcessPriority {
  if (value === "normal" || value === "low" || value === "lowest") return value;
  throw new RuntimeGovernanceSettingsError("processPriority", "Process priority must be normal, low, or lowest.");
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RuntimeGovernanceSettingsError(field, `${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new RuntimeGovernanceSettingsError(field, `${field} must be a boolean.`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new RuntimeGovernanceSettingsError(field, `${field} settings must use the current exact shape.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
