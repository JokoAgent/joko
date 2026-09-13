import {
  DEFAULT_AGENT_RESOURCE_SETTINGS,
  DEFAULT_COLLABORATION_SETTINGS,
  type AgentResourceSettings,
  type CollaborationSettings,
  validateAgentResourceSettings,
  validateCollaborationSettings
} from "@joko/runtime-governance";
import { DEFAULT_GIT_SAFETY_SETTINGS, type GitSafetySettings } from "@joko/git-safety";
import { RevisionConflictError, type OperationalStore, type SettingRecord } from "@joko/store";

const SCOPE_TYPE = "service" as const;
const DEFAULT_SCOPE_ID = "orchestrator";
export const AGENT_RESOURCE_SETTING_KEY = "settings.runtime.agent_resource";
export const COLLABORATION_SETTING_KEY = "settings.runtime.collaboration";
export const GIT_SAFETY_SETTING_KEY = "settings.runtime.git_safety";

interface StoredAgentResourceSettings extends AgentResourceSettings {
  readonly format: 1;
}

interface StoredCollaborationSettings extends CollaborationSettings {
  readonly format: 1;
}

interface StoredGitSafetySettings extends GitSafetySettings {
  readonly format: 1;
}

export interface GovernanceSettingSnapshot<T> {
  readonly value: T;
  readonly revision: bigint;
  readonly updatedAt: number;
}

export interface RuntimeGovernanceSnapshot {
  readonly agentResource: GovernanceSettingSnapshot<AgentResourceSettings>;
  readonly collaboration: GovernanceSettingSnapshot<CollaborationSettings>;
  readonly gitSafety: GovernanceSettingSnapshot<GitSafetySettings>;
}

export class RuntimeGovernanceSettingsRepository {
  readonly #store: OperationalStore;
  readonly #scopeId: string;
  readonly #now: () => number;

  constructor(options: {
    readonly store: OperationalStore;
    readonly scopeId?: string;
    readonly now?: () => number;
  }) {
    this.#store = options.store;
    this.#scopeId = boundedScopeId(options.scopeId ?? DEFAULT_SCOPE_ID);
    this.#now = options.now ?? Date.now;
    this.#initialize();
  }

  snapshot(): RuntimeGovernanceSnapshot {
    return {
      agentResource: this.agentResourceSnapshot(),
      collaboration: this.collaborationSnapshot(),
      gitSafety: this.gitSafetySnapshot()
    };
  }

  agentResource(): AgentResourceSettings {
    return this.agentResourceSnapshot().value;
  }

  collaboration(): CollaborationSettings {
    return this.collaborationSnapshot().value;
  }

  gitSafety(): GitSafetySettings {
    return this.gitSafetySnapshot().value;
  }

  agentResourceSnapshot(): GovernanceSettingSnapshot<AgentResourceSettings> {
    const record = this.#store.getSetting<unknown>(SCOPE_TYPE, this.#scopeId, AGENT_RESOURCE_SETTING_KEY);
    return snapshotOf(record, decodeAgentResource(record.value));
  }

  collaborationSnapshot(): GovernanceSettingSnapshot<CollaborationSettings> {
    const record = this.#store.getSetting<unknown>(SCOPE_TYPE, this.#scopeId, COLLABORATION_SETTING_KEY);
    return snapshotOf(record, decodeCollaboration(record.value));
  }

  gitSafetySnapshot(): GovernanceSettingSnapshot<GitSafetySettings> {
    const record = this.#store.getSetting<unknown>(SCOPE_TYPE, this.#scopeId, GIT_SAFETY_SETTING_KEY);
    return snapshotOf(record, decodeGitSafety(record.value));
  }

  updateAgentResource(
    patch: Partial<AgentResourceSettings>,
    expectedRevision?: bigint
  ): GovernanceSettingSnapshot<AgentResourceSettings> {
    assertPatch(patch, ["maxConcurrentCommands", "processPriority", "capToolchainThreads"]);
    const current = this.agentResourceSnapshot();
    assertRevision(AGENT_RESOURCE_SETTING_KEY, current.revision, expectedRevision);
    const next = validateAgentResourceSettings({ ...current.value, ...patch });
    if (sameAgentResource(current.value, next)) return current;
    const record = this.#store.setSetting<StoredAgentResourceSettings>(
      SCOPE_TYPE,
      this.#scopeId,
      AGENT_RESOURCE_SETTING_KEY,
      encodeAgentResource(next),
      this.#now()
    );
    return snapshotOf(record, next);
  }

  updateCollaboration(
    patch: Partial<CollaborationSettings>,
    expectedRevision?: bigint
  ): GovernanceSettingSnapshot<CollaborationSettings> {
    assertPatch(patch, ["workerSoftLimit", "workerHardLimit", "workerIdleReleaseMinutes"]);
    const current = this.collaborationSnapshot();
    assertRevision(COLLABORATION_SETTING_KEY, current.revision, expectedRevision);
    const next = validateCollaborationSettings({ ...current.value, ...patch });
    if (sameCollaboration(current.value, next)) return current;
    const record = this.#store.setSetting<StoredCollaborationSettings>(
      SCOPE_TYPE,
      this.#scopeId,
      COLLABORATION_SETTING_KEY,
      encodeCollaboration(next),
      this.#now()
    );
    return snapshotOf(record, next);
  }

  updateGitSafety(
    patch: Partial<GitSafetySettings>,
    expectedRevision?: bigint
  ): GovernanceSettingSnapshot<GitSafetySettings> {
    assertPatch(patch, ["autoSnapshotEnabled"]);
    const current = this.gitSafetySnapshot();
    assertRevision(GIT_SAFETY_SETTING_KEY, current.revision, expectedRevision);
    const next = validateGitSafetySettings({ ...current.value, ...patch });
    if (sameGitSafety(current.value, next)) return current;
    const record = this.#store.setSetting<StoredGitSafetySettings>(
      SCOPE_TYPE,
      this.#scopeId,
      GIT_SAFETY_SETTING_KEY,
      encodeGitSafety(next),
      this.#now()
    );
    return snapshotOf(record, next);
  }

  resetAgentResource(expectedRevision?: bigint): GovernanceSettingSnapshot<AgentResourceSettings> {
    return this.updateAgentResource(DEFAULT_AGENT_RESOURCE_SETTINGS, expectedRevision);
  }

  resetCollaboration(expectedRevision?: bigint): GovernanceSettingSnapshot<CollaborationSettings> {
    return this.updateCollaboration(DEFAULT_COLLABORATION_SETTINGS, expectedRevision);
  }

  resetGitSafety(expectedRevision?: bigint): GovernanceSettingSnapshot<GitSafetySettings> {
    return this.updateGitSafety(DEFAULT_GIT_SAFETY_SETTINGS, expectedRevision);
  }

  #initialize(): void {
    const agentResource = this.#store.findSetting<unknown>(SCOPE_TYPE, this.#scopeId, AGENT_RESOURCE_SETTING_KEY);
    const collaboration = this.#store.findSetting<unknown>(SCOPE_TYPE, this.#scopeId, COLLABORATION_SETTING_KEY);
    const gitSafety = this.#store.findSetting<unknown>(SCOPE_TYPE, this.#scopeId, GIT_SAFETY_SETTING_KEY);
    if (agentResource !== undefined) decodeAgentResource(agentResource.value);
    if (collaboration !== undefined) decodeCollaboration(collaboration.value);
    if (gitSafety !== undefined) decodeGitSafety(gitSafety.value);
    if (agentResource !== undefined && collaboration !== undefined && gitSafety !== undefined) return;
    this.#store.transaction((store) => {
      if (agentResource === undefined) {
        store.setSetting(
          SCOPE_TYPE,
          this.#scopeId,
          AGENT_RESOURCE_SETTING_KEY,
          encodeAgentResource(DEFAULT_AGENT_RESOURCE_SETTINGS),
          this.#now()
        );
      }
      if (collaboration === undefined) {
        store.setSetting(
          SCOPE_TYPE,
          this.#scopeId,
          COLLABORATION_SETTING_KEY,
          encodeCollaboration(DEFAULT_COLLABORATION_SETTINGS),
          this.#now()
        );
      }
      if (gitSafety === undefined) {
        store.setSetting(
          SCOPE_TYPE,
          this.#scopeId,
          GIT_SAFETY_SETTING_KEY,
          encodeGitSafety(DEFAULT_GIT_SAFETY_SETTINGS),
          this.#now()
        );
      }
    });
  }
}

function encodeAgentResource(value: AgentResourceSettings): StoredAgentResourceSettings {
  return { format: 1, ...value };
}

function encodeCollaboration(value: CollaborationSettings): StoredCollaborationSettings {
  return { format: 1, ...value };
}

function encodeGitSafety(value: GitSafetySettings): StoredGitSafetySettings {
  return { format: 1, ...value };
}

function decodeAgentResource(value: unknown): AgentResourceSettings {
  if (!isRecord(value) || value["format"] !== 1) throw new Error("Stored agent resource settings are invalid.");
  return validateAgentResourceSettings({
    maxConcurrentCommands: value["maxConcurrentCommands"],
    processPriority: value["processPriority"],
    capToolchainThreads: value["capToolchainThreads"]
  } as AgentResourceSettings);
}

function decodeCollaboration(value: unknown): CollaborationSettings {
  if (!isRecord(value) || value["format"] !== 1) throw new Error("Stored collaboration settings are invalid.");
  return validateCollaborationSettings({
    workerSoftLimit: value["workerSoftLimit"],
    workerHardLimit: value["workerHardLimit"],
    workerIdleReleaseMinutes: value["workerIdleReleaseMinutes"]
  } as CollaborationSettings);
}

function decodeGitSafety(value: unknown): GitSafetySettings {
  if (!isRecord(value) || value["format"] !== 1) throw new Error("Stored Git safety settings are invalid.");
  return validateGitSafetySettings({ autoSnapshotEnabled: value["autoSnapshotEnabled"] });
}

function sameAgentResource(left: AgentResourceSettings, right: AgentResourceSettings): boolean {
  return left.maxConcurrentCommands === right.maxConcurrentCommands
    && left.processPriority === right.processPriority
    && left.capToolchainThreads === right.capToolchainThreads;
}

function sameCollaboration(left: CollaborationSettings, right: CollaborationSettings): boolean {
  return left.workerSoftLimit === right.workerSoftLimit
    && left.workerHardLimit === right.workerHardLimit
    && left.workerIdleReleaseMinutes === right.workerIdleReleaseMinutes;
}

function sameGitSafety(left: GitSafetySettings, right: GitSafetySettings): boolean {
  return left.autoSnapshotEnabled === right.autoSnapshotEnabled;
}

function validateGitSafetySettings(value: unknown): GitSafetySettings {
  if (!isRecord(value) || typeof value["autoSnapshotEnabled"] !== "boolean") {
    throw new Error("Git safety auto-snapshot setting must be a boolean.");
  }
  return { autoSnapshotEnabled: value["autoSnapshotEnabled"] };
}

function snapshotOf<T>(record: SettingRecord<unknown>, value: T): GovernanceSettingSnapshot<T> {
  return { value, revision: record.revision, updatedAt: record.updatedAt };
}

function assertRevision(key: string, actual: bigint, expected: bigint | undefined): void {
  if (expected !== undefined && expected !== actual) throw new RevisionConflictError("Setting", key, expected, actual);
}

function assertPatch(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("A settings patch is required.");
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown runtime governance setting '${key}'.`);
  }
}

function boundedScopeId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("Runtime governance setting scope is invalid.");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
