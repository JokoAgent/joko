import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { OperationalStore, SettingRecord } from "@joko/store";

import type { BridgeToolPolicyDeclaration } from "./mcp-router.js";
import { toProtoEntityVersion } from "./proto-mapper.js";

const USER_SCOPE_ID = "orchestrator";
const POLICY_SETTING_PREFIX = "settings.tool_policy.";
const SESSION_SNAPSHOT_KEY = "runtime.tool_policy.snapshot";

interface StoredPolicyOverride {
  readonly format: 1;
  readonly enabled: boolean;
}

interface StoredSessionPolicySnapshot {
  readonly format: 1;
  readonly targetId: string;
  readonly policies: Readonly<Record<string, boolean>>;
}

export class ToolPolicySettingsRepository {
  readonly #store: OperationalStore;
  readonly #catalog: () => readonly BridgeToolPolicyDeclaration[];
  readonly #now: () => number;

  constructor(options: {
    readonly store: OperationalStore;
    readonly catalog: () => readonly BridgeToolPolicyDeclaration[];
    readonly now?: () => number;
  }) {
    this.#store = options.store;
    this.#catalog = options.catalog;
    this.#now = options.now ?? Date.now;
  }

  snapshot(locale = "en"): readonly contract.ToolPolicySettings[] {
    const health = this.#store.health();
    const targets = this.#store.listTargets();
    return this.#declarations().map((declaration) => {
      const key = policySettingKey(declaration.id);
      const userRecord = this.#store.findSetting<unknown>("service", USER_SCOPE_ID, key);
      const userOverride = optionalOverride(userRecord);
      const userEffectiveEnabled = userOverride?.enabled ?? declaration.productDefaultEnabled;
      const userEffectiveSource = userOverride === undefined
        ? contract.ToolPolicyEffectiveSource.PRODUCT_DEFAULT
        : contract.ToolPolicyEffectiveSource.USER_DEFAULT;
      return create(contract.ToolPolicySettingsSchema, {
        toolProviderId: declaration.id,
        displayName: declaration.localizations?.[locale]?.displayName ?? declaration.displayName,
        description: declaration.localizations?.[locale]?.description ?? declaration.description,
        productDefaultEnabled: declaration.productDefaultEnabled,
        userEffectiveEnabled,
        userEffectiveSource,
        userOverride: userOverride === undefined
          ? undefined
          : create(contract.ToolPolicyOverrideSchema, { enabled: userOverride.enabled }),
        targetSettings: targets.map((target) => {
          const projectRecord = this.#store.findSetting<unknown>("target", target.descriptor.id, key);
          const projectOverride = optionalOverride(projectRecord);
          return create(contract.ToolPolicyTargetSettingsSchema, {
            targetId: target.descriptor.id,
            effectiveEnabled: projectOverride?.enabled ?? userEffectiveEnabled,
            effectiveSource: projectOverride === undefined
              ? userEffectiveSource
              : contract.ToolPolicyEffectiveSource.PROJECT_OVERRIDE,
            projectOverride: projectOverride === undefined
              ? undefined
              : create(contract.ToolPolicyOverrideSchema, { enabled: projectOverride.enabled }),
            version: toProtoEntityVersion(
              projectRecord?.revision ?? target.revision,
              0,
              projectRecord?.updatedAt ?? target.updatedAt
            )
          });
        }),
        version: toProtoEntityVersion(
          userRecord?.revision ?? health.revision,
          0,
          userRecord?.updatedAt ?? this.#now()
        )
      });
    });
  }

  apply(input: {
    readonly toolProviderId: string;
    readonly targetId?: string;
    readonly enabled?: boolean;
    readonly reset: boolean;
  }): void {
    const declaration = this.#declaration(input.toolProviderId);
    if (input.reset === (input.enabled !== undefined)) {
      throw new Error("Specify either a Tool policy value or reset, but not both.");
    }
    const key = policySettingKey(declaration.id);
    if (input.targetId === undefined) {
      if (input.reset) this.#store.deleteSetting("service", USER_SCOPE_ID, key);
      else this.#store.setSetting<StoredPolicyOverride>("service", USER_SCOPE_ID, key, encodeOverride(input.enabled!), this.#now());
      return;
    }

    this.#store.getTarget(input.targetId);
    if (input.reset) {
      this.#store.deleteSetting("target", input.targetId, key);
      return;
    }
    const userOverride = optionalOverride(this.#store.findSetting<unknown>("service", USER_SCOPE_ID, key));
    if (userOverride === undefined && input.enabled === declaration.productDefaultEnabled) {
      this.#store.deleteSetting("target", input.targetId, key);
      return;
    }
    this.#store.setSetting<StoredPolicyOverride>("target", input.targetId, key, encodeOverride(input.enabled!), this.#now());
  }

  /** Capture ordinary Tool availability once; later settings changes affect only new Sessions. */
  freezeSession(sessionId: string, targetId: string): Readonly<Record<string, boolean>> {
    const existing = this.#store.findSetting<unknown>("session", sessionId, SESSION_SNAPSHOT_KEY);
    if (existing !== undefined) return decodeSessionSnapshot(existing.value).policies;
    this.#store.getTarget(targetId);
    const policies = Object.fromEntries(this.#declarations().map((declaration) => [
      declaration.id,
      this.#effectiveForTarget(declaration, targetId)
    ]));
    const stored: StoredSessionPolicySnapshot = { format: 1, targetId, policies };
    this.#store.setSetting("session", sessionId, SESSION_SNAPSHOT_KEY, stored, this.#now());
    return stored.policies;
  }

  enabledForSession(sessionId: string, targetId: string, toolProviderId: string): boolean {
    this.#declaration(toolProviderId);
    const existing = this.#store.findSetting<unknown>("session", sessionId, SESSION_SNAPSHOT_KEY);
    const policies = existing === undefined
      ? this.freezeSession(sessionId, targetId)
      : decodeSessionSnapshot(existing.value).policies;
    return policies[toolProviderId] === true;
  }

  #effectiveForTarget(declaration: BridgeToolPolicyDeclaration, targetId: string): boolean {
    const key = policySettingKey(declaration.id);
    const projectOverride = optionalOverride(this.#store.findSetting<unknown>("target", targetId, key));
    if (projectOverride !== undefined) return projectOverride.enabled;
    const userOverride = optionalOverride(this.#store.findSetting<unknown>("service", USER_SCOPE_ID, key));
    return userOverride?.enabled ?? declaration.productDefaultEnabled;
  }

  #declarations(): readonly BridgeToolPolicyDeclaration[] {
    const declarations = this.#catalog();
    const ids = new Set<string>();
    for (const declaration of declarations) {
      validatePolicyId(declaration.id);
      if (ids.has(declaration.id)) throw new Error("Tool policy catalog contains a duplicate ID.");
      ids.add(declaration.id);
    }
    return declarations;
  }

  #declaration(id: string): BridgeToolPolicyDeclaration {
    validatePolicyId(id);
    const declaration = this.#declarations().find((candidate) => candidate.id === id);
    if (declaration === undefined) throw new Error("Tool policy is not available on this Orchestrator node.");
    return declaration;
  }
}

function policySettingKey(id: string): string {
  validatePolicyId(id);
  return `${POLICY_SETTING_PREFIX}${id}`;
}

function validatePolicyId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) throw new Error("Tool policy ID is invalid.");
}

function encodeOverride(enabled: boolean): StoredPolicyOverride {
  return { format: 1, enabled };
}

function optionalOverride(record: SettingRecord<unknown> | undefined): StoredPolicyOverride | undefined {
  return record === undefined ? undefined : decodeOverride(record.value);
}

function decodeOverride(value: unknown): StoredPolicyOverride {
  if (!isRecord(value) || value["format"] !== 1 || typeof value["enabled"] !== "boolean") {
    throw new Error("Stored Tool policy override is invalid.");
  }
  return { format: 1, enabled: value["enabled"] };
}

function decodeSessionSnapshot(value: unknown): StoredSessionPolicySnapshot {
  if (!isRecord(value) || value["format"] !== 1 || typeof value["targetId"] !== "string" || !isRecord(value["policies"])) {
    throw new Error("Stored Session Tool policy snapshot is invalid.");
  }
  const policies: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(value["policies"])) {
    validatePolicyId(id);
    if (typeof enabled !== "boolean") throw new Error("Stored Session Tool policy value is invalid.");
    policies[id] = enabled;
  }
  return { format: 1, targetId: value["targetId"], policies };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
