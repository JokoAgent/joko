import type { BackendDescriptor } from "@joko/core";
import { RevisionConflictError, type OperationalStore } from "@joko/store";

import { modelRoutingEnabled } from "./backend-model-access.js";

export const SUBAGENT_DEFAULT_MODEL_CAPABILITY = "subagents.default_model";
const SETTING_PREFIX = "settings.subagent_model.";
const NATIVE_DEFAULT_FALLBACK = "New runtimes use the native subagent default when their parent route cannot use the selected model.";

export interface SubagentModelSelection {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SubagentModelSettingsSnapshot {
  readonly backendId: string;
  readonly model?: SubagentModelSelection;
  readonly available: boolean;
  readonly unavailableReason: string;
  readonly revision: bigint;
}

interface StoredSubagentModelSettings {
  readonly format: 1;
  readonly model: SubagentModelSelection | null;
}

export function subagentModelSettingKey(backendId: string): string {
  return `${SETTING_PREFIX}${requiredId(backendId, 128)}`;
}

/** Owns model choices only; the Adapter keeps ownership of the parent's credentials. */
export class SubagentModelSettings {
  readonly #store: OperationalStore;

  constructor(options: { readonly store: OperationalStore }) {
    this.#store = options.store;
  }

  snapshot(): readonly SubagentModelSettingsSnapshot[] {
    const backends = new Map(this.#store.listBackends().map(({ descriptor }) => [descriptor.id, descriptor]));
    const ids = new Set([...backends.values()]
      .filter((backend) => backend.capabilities.get(SUBAGENT_DEFAULT_MODEL_CAPABILITY)?.supported === true)
      .map((backend) => backend.id));
    for (const setting of this.#store.listSettings("service", "orchestrator")) {
      if (setting.key.startsWith(SETTING_PREFIX)) ids.add(requiredId(setting.key.slice(SETTING_PREFIX.length), 128));
    }
    return [...ids].sort((left, right) => left.localeCompare(right, "en")).map((backendId) => {
      const stored = this.#store.findSetting<unknown>("service", "orchestrator", subagentModelSettingKey(backendId));
      const decoded = stored === undefined ? { format: 1 as const, model: null } : readStored(stored.value);
      const model = decoded?.model ?? undefined;
      const backend = backends.get(backendId);
      const reason = decoded === undefined ? "Subagent model settings are invalid."
        : this.#backendUnavailableReason(backendId, backend)
          || (model === undefined ? "" : this.#modelUnavailableReason(backend!, model));
      return {
        backendId,
        ...(model === undefined ? {} : { model }),
        available: reason === "",
        unavailableReason: reason === "" ? "" : `${reason} ${NATIVE_DEFAULT_FALLBACK}`,
        revision: stored?.revision ?? 0n
      };
    });
  }

  /** Run synchronously inside the authenticated operation's Store transaction. */
  replace(backendId: string, model: SubagentModelSelection | undefined, expectedRevision: bigint): void {
    const key = subagentModelSettingKey(backendId);
    const stored = this.#store.findSetting<unknown>("service", "orchestrator", key);
    const revision = stored?.revision ?? 0n;
    if (expectedRevision !== revision) {
      throw new RevisionConflictError("Subagent model settings", key, expectedRevision, revision);
    }
    const next = model === undefined ? null : readSelection(model);
    if (next === undefined) throw new RangeError("Subagent model choice is invalid.");
    const backend = this.#store.listBackends().find(({ descriptor }) => descriptor.id === backendId)?.descriptor;
    if (next !== null) {
      const reason = this.#backendUnavailableReason(backendId, backend)
        || this.#modelUnavailableReason(backend!, next);
      if (reason !== "") throw new RangeError(reason);
    } else if (stored === undefined && backend?.capabilities.get(SUBAGENT_DEFAULT_MODEL_CAPABILITY)?.supported !== true) {
      throw new RangeError("Backend does not support a subagent default model.");
    }
    // A durable null retains the revision after reset and prevents revision-zero ABA.
    this.#store.setSetting("service", "orchestrator", key, { format: 1, model: next } satisfies StoredSubagentModelSettings);
  }

  /** Capture once when creating a Query; undefined delegates to the native default. */
  resolve(backendId: string, parentProviderId: string): string | undefined {
    const stored = this.#store.findSetting<unknown>("service", "orchestrator", subagentModelSettingKey(backendId));
    const model = stored === undefined ? undefined : readStored(stored.value)?.model;
    if (model === undefined || model === null || !validId(parentProviderId, 128)) return undefined;
    const backend = this.#store.listBackends().find(({ descriptor }) => descriptor.id === backendId)?.descriptor;
    if (this.#backendUnavailableReason(backendId, backend) !== "") return undefined;
    // The saved Provider identifies the selection source, never the dispatch credential route.
    const parentCopy = { providerId: parentProviderId, modelId: model.modelId };
    return this.#modelUnavailableReason(backend!, parentCopy) === "" ? model.modelId : undefined;
  }

  #backendUnavailableReason(backendId: string, backend: BackendDescriptor | undefined): string {
    if (backend === undefined) return "Backend is no longer available.";
    if (backend.capabilities.get(SUBAGENT_DEFAULT_MODEL_CAPABILITY)?.supported !== true) {
      return "Backend does not support a subagent default model.";
    }
    if (this.#store.findSetting<{ readonly enabled?: boolean }>(
      "service", "orchestrator", `settings.backend.${backendId}`
    )?.value.enabled === false) return "Backend is disabled.";
    if (backend.health === "unavailable"
      || (backend.installationState !== "installed" && backend.installationState !== "update_available")) {
      return "Backend runtime is unavailable.";
    }
    if (backend.authenticationState !== "authenticated" && backend.authenticationState !== "not_required") {
      return "Backend authentication is unavailable.";
    }
    return "";
  }

  #modelUnavailableReason(backend: BackendDescriptor, model: SubagentModelSelection): string {
    const candidates = backend.models.filter((candidate) => candidate.providerId === model.providerId && candidate.modelId === model.modelId);
    if (candidates.length !== 1) return "Model is no longer uniquely available in the Backend catalog.";
    const providers = backend.providers?.filter((provider) => provider.providerId === model.providerId);
    if (providers !== undefined && providers.length !== 1) return "Model Provider is no longer uniquely available.";
    const authenticationState = providers?.[0]?.authenticationState ?? backend.authenticationState;
    if (authenticationState !== "authenticated" && authenticationState !== "not_required") {
      return "Model Provider authentication is unavailable.";
    }
    if (!modelRoutingEnabled(this.#store, backend.id, model.providerId, model.modelId)) return "Model route is disabled.";
    return "";
  }
}

function readStored(value: unknown): StoredSubagentModelSettings | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value["format"] !== 1 || !("model" in value)) return undefined;
  if (value["model"] === null) return { format: 1, model: null };
  const model = readSelection(value["model"]);
  return model === undefined ? undefined : { format: 1, model };
}

function readSelection(value: unknown): SubagentModelSelection | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2
    || !validId(value["providerId"], 128) || !validId(value["modelId"], 256)) return undefined;
  return { providerId: value["providerId"], modelId: value["modelId"] };
}

function requiredId(value: unknown, maximum: number): string {
  if (!validId(value, maximum)) throw new RangeError("Subagent model identity is invalid.");
  return value;
}

function validId(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
