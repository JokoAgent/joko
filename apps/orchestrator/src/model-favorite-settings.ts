import type { BackendDescriptor } from "@joko/core";
import { RevisionConflictError, type OperationalStore } from "@joko/store";

import { modelRoutingEnabled } from "./backend-model-access.js";

const SETTING_KEY = "settings.model_favorites";
const MAXIMUM_FAVORITES = 512;

export interface ModelFavoriteConfiguration {
  readonly favoriteId: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effortId?: string;
  readonly fastMode: boolean;
}

export interface ModelFavoriteSettingsSnapshot {
  readonly favorites: readonly ModelFavoriteConfiguration[];
  readonly seeded: boolean;
  readonly revision: bigint;
}

export type ModelFavoriteMutation =
  | { readonly kind: "add"; readonly item: ModelFavoriteConfiguration }
  | { readonly kind: "replace"; readonly item: ModelFavoriteConfiguration }
  | { readonly kind: "remove"; readonly favoriteId: string }
  | { readonly kind: "seed"; readonly item: ModelFavoriteConfiguration };

interface StoredModelFavoriteConfiguration {
  readonly favoriteId: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effortId: string | null;
  readonly fastMode: boolean;
}

interface StoredModelFavoriteSettings {
  readonly format: 1;
  readonly seeded: boolean;
  readonly favorites: readonly StoredModelFavoriteConfiguration[];
}

/** Node-owned model-picker favorites. Mutations run inside the authenticated Operation transaction. */
export class ModelFavoriteSettings {
  readonly #store: OperationalStore;

  constructor(store: OperationalStore) {
    this.#store = store;
  }

  snapshot(): ModelFavoriteSettingsSnapshot {
    const setting = this.#store.findSetting<unknown>("service", "orchestrator", SETTING_KEY);
    if (setting === undefined) return { favorites: [], seeded: false, revision: 0n };
    const stored = readStored(setting.value);
    if (stored === undefined) throw new RangeError("Model favorite settings are invalid.");
    return {
      favorites: stored.favorites.map(publicFavorite),
      seeded: stored.seeded,
      revision: setting.revision
    };
  }

  mutate(mutation: ModelFavoriteMutation, expectedRevision: bigint): void {
    const setting = this.#store.findSetting<unknown>("service", "orchestrator", SETTING_KEY);
    const revision = setting?.revision ?? 0n;
    if (revision !== expectedRevision) {
      throw new RevisionConflictError("Model favorite settings", SETTING_KEY, expectedRevision, revision);
    }
    const current = setting === undefined
      ? { format: 1 as const, seeded: false, favorites: [] }
      : readStored(setting.value);
    if (current === undefined) throw new RangeError("Model favorite settings are invalid.");

    let favorites = [...current.favorites];
    let seeded = current.seeded;
    switch (mutation.kind) {
      case "add": {
        if (favorites.length >= MAXIMUM_FAVORITES) throw new RangeError("Too many model favorites are saved.");
        const item = this.#validatedStored(mutation.item);
        if (favorites.some((candidate) => candidate.favoriteId === item.favoriteId)) {
          throw new RangeError("Model favorite identity already exists.");
        }
        if (favorites.some((candidate) => sameConfiguration(candidate, item))) {
          throw new RangeError("The same model favorite configuration is already saved.");
        }
        favorites.push(item);
        break;
      }
      case "replace": {
        const item = this.#validatedStored(mutation.item);
        const index = favorites.findIndex((candidate) => candidate.favoriteId === item.favoriteId);
        if (index < 0) throw new RangeError("Model favorite no longer exists.");
        const previous = favorites[index]!;
        if (previous.backendId !== item.backendId || previous.providerId !== item.providerId
          || previous.modelId !== item.modelId) {
          throw new RangeError("Model favorite route identity cannot change.");
        }
        if (favorites.some((candidate, candidateIndex) => candidateIndex !== index && sameConfiguration(candidate, item))) {
          throw new RangeError("The same model favorite configuration is already saved.");
        }
        favorites[index] = item;
        break;
      }
      case "remove": {
        const favoriteId = requiredId(mutation.favoriteId, 128, "Model favorite identity");
        const index = favorites.findIndex((candidate) => candidate.favoriteId === favoriteId);
        if (index < 0) throw new RangeError("Model favorite no longer exists.");
        favorites.splice(index, 1);
        break;
      }
      case "seed": {
        if (seeded) throw new RangeError("The default model favorite was already considered.");
        const item = this.#validatedStored(mutation.item);
        if (favorites.length === 0) favorites.push(item);
        seeded = true;
        break;
      }
    }
    this.#store.setSetting("service", "orchestrator", SETTING_KEY, {
      format: 1,
      seeded,
      favorites
    } satisfies StoredModelFavoriteSettings);
  }

  #validatedStored(input: ModelFavoriteConfiguration): StoredModelFavoriteConfiguration {
    const favoriteId = requiredId(input.favoriteId, 128, "Model favorite identity");
    const backendId = requiredId(input.backendId, 128, "Backend identity");
    const providerId = requiredId(input.providerId, 128, "Provider identity");
    const modelId = requiredId(input.modelId, 256, "Model identity");
    const effortId = input.effortId === undefined
      ? null
      : requiredId(input.effortId, 128, "Model effort identity");
    if (typeof input.fastMode !== "boolean") throw new RangeError("Model favorite Fast Mode is invalid.");
    const backend = this.#store.listBackends().find(({ descriptor }) => descriptor.id === backendId)?.descriptor;
    const reason = this.#routeUnavailableReason(backend, providerId, modelId, effortId, input.fastMode);
    if (reason !== "") throw new RangeError(reason);
    return { favoriteId, backendId, providerId, modelId, effortId, fastMode: input.fastMode };
  }

  #routeUnavailableReason(
    backend: BackendDescriptor | undefined,
    providerId: string,
    modelId: string,
    effortId: string | null,
    fastMode: boolean
  ): string {
    if (backend === undefined) return "Backend is no longer available.";
    if (this.#store.findSetting<{ readonly enabled?: boolean }>(
      "service", "orchestrator", `settings.backend.${backend.id}`
    )?.value.enabled === false) return "Backend is disabled.";
    if (backend.health === "unavailable"
      || (backend.installationState !== "installed" && backend.installationState !== "update_available")) {
      return "Backend runtime is unavailable.";
    }
    const models = backend.models.filter((model) => model.providerId === providerId && model.modelId === modelId);
    if (models.length !== 1) return "Model is no longer uniquely available in the Backend catalog.";
    const providers = backend.providers?.filter((provider) => provider.providerId === providerId);
    if (providers !== undefined && providers.length !== 1) return "Model Provider is no longer uniquely available.";
    const authenticationState = providers?.[0]?.authenticationState ?? backend.authenticationState;
    if (authenticationState !== "authenticated" && authenticationState !== "not_required") {
      return "Model Provider authentication is unavailable.";
    }
    if (!modelRoutingEnabled(this.#store, backend.id, providerId, modelId)) return "Model route is disabled.";
    const model = models[0]!;
    if (effortId !== null && !model.thinkingLevels.includes(effortId)) {
      return "Model effort is no longer available.";
    }
    if (fastMode && model.supportsFastMode !== true) return "Fast Mode is not supported by this model.";
    return "";
  }
}

function publicFavorite(item: StoredModelFavoriteConfiguration): ModelFavoriteConfiguration {
  return {
    favoriteId: item.favoriteId,
    backendId: item.backendId,
    providerId: item.providerId,
    modelId: item.modelId,
    ...(item.effortId === null ? {} : { effortId: item.effortId }),
    fastMode: item.fastMode
  };
}

function readStored(value: unknown): StoredModelFavoriteSettings | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "favorites,format,seeded"
    || value["format"] !== 1 || typeof value["seeded"] !== "boolean"
    || !Array.isArray(value["favorites"]) || value["favorites"].length > MAXIMUM_FAVORITES) return undefined;
  const favorites: StoredModelFavoriteConfiguration[] = [];
  const ids = new Set<string>();
  for (const candidate of value["favorites"]) {
    const item = readFavorite(candidate);
    if (item === undefined || ids.has(item.favoriteId)
      || favorites.some((existing) => sameConfiguration(existing, item))) return undefined;
    ids.add(item.favoriteId);
    favorites.push(item);
  }
  return { format: 1, seeded: value["seeded"], favorites };
}

function readFavorite(value: unknown): StoredModelFavoriteConfiguration | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "backendId,effortId,fastMode,favoriteId,modelId,providerId"
    || !validId(value["favoriteId"], 128) || !validId(value["backendId"], 128)
    || !validId(value["providerId"], 128) || !validId(value["modelId"], 256)
    || (value["effortId"] !== null && !validId(value["effortId"], 128))
    || typeof value["fastMode"] !== "boolean") return undefined;
  return {
    favoriteId: value["favoriteId"],
    backendId: value["backendId"],
    providerId: value["providerId"],
    modelId: value["modelId"],
    effortId: value["effortId"],
    fastMode: value["fastMode"]
  };
}

function sameConfiguration(left: StoredModelFavoriteConfiguration, right: StoredModelFavoriteConfiguration): boolean {
  return left.backendId === right.backendId && left.providerId === right.providerId
    && left.modelId === right.modelId && left.effortId === right.effortId && left.fastMode === right.fastMode;
}

function requiredId(value: unknown, maximum: number, label: string): string {
  if (!validId(value, maximum)) throw new RangeError(`${label} is invalid.`);
  return value;
}

function validId(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
