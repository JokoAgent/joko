import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackendDescriptor } from "@joko/core";
import { OperationalStore, RevisionConflictError } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { ModelFavoriteSettings, type ModelFavoriteConfiguration } from "./model-favorite-settings.js";

const stores: OperationalStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ModelFavoriteSettings", () => {
  it("persists the one-time seed decision and exact configurations across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-model-favorites-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const { store, settings } = setup(path);
    expect(settings.snapshot()).toEqual({ favorites: [], seeded: false, revision: 0n });

    store.transaction(() => settings.mutate({ kind: "seed", item: favorite() }, 0n));
    const seeded = settings.snapshot();
    expect(seeded).toMatchObject({ favorites: [favorite()], seeded: true });
    store.transaction(() => settings.mutate({ kind: "remove", favoriteId: "favorite-a" }, seeded.revision));
    const removed = settings.snapshot();
    expect(removed).toMatchObject({ favorites: [], seeded: true });
    expect(removed.revision).toBeGreaterThan(seeded.revision);

    store.close();
    const reopenedStore = new OperationalStore(path);
    stores.push(reopenedStore);
    const reopened = new ModelFavoriteSettings(reopenedStore);
    expect(reopened.snapshot()).toEqual(removed);
    expect(() => reopenedStore.transaction(() => reopened.mutate({ kind: "seed", item: favorite() }, removed.revision)))
      .toThrow("already considered");
  });

  it("uses whole-setting CAS and rejects duplicate configurations without changing state", () => {
    const { store, settings } = setup();
    store.transaction(() => settings.mutate({ kind: "add", item: favorite() }, 0n));
    const first = settings.snapshot();
    expect(() => store.transaction(() => settings.mutate({
      kind: "add", item: { ...favorite(), favoriteId: "favorite-b" }
    }, first.revision))).toThrow("same model favorite configuration");
    expect(settings.snapshot()).toEqual(first);
    expect(() => store.transaction(() => settings.mutate({
      kind: "replace", item: { ...favorite(), effortId: "high", fastMode: true }
    }, 0n))).toThrow(RevisionConflictError);
    expect(settings.snapshot()).toEqual(first);
    expect(() => store.transaction(() => settings.mutate({
      kind: "replace", item: { ...favorite(), modelId: "model-b", effortId: undefined }
    }, first.revision))).toThrow("route identity cannot change");
    expect(settings.snapshot()).toEqual(first);

    store.transaction(() => settings.mutate({
      kind: "replace", item: { ...favorite(), effortId: "high", fastMode: true }
    }, first.revision));
    expect(settings.snapshot().favorites).toEqual([{ ...favorite(), effortId: "high", fastMode: true }]);
  });

  it("validates current route, effort and Fast support and rolls back atomically", () => {
    const { store, settings } = setup();
    expect(() => store.transaction(() => settings.mutate({
      kind: "add", item: { ...favorite(), effortId: "extreme" }
    }, 0n))).toThrow("effort");
    expect(() => store.transaction(() => settings.mutate({
      kind: "add", item: { ...favorite(), modelId: "model-b", effortId: undefined, fastMode: true }
    }, 0n))).toThrow("Fast Mode");
    expect(settings.snapshot()).toEqual({ favorites: [], seeded: false, revision: 0n });

    expect(() => store.transaction(() => {
      settings.mutate({ kind: "add", item: favorite() }, 0n);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(settings.snapshot()).toEqual({ favorites: [], seeded: false, revision: 0n });

    store.setSetting("service", "orchestrator", "settings.backend.backend-a", { enabled: false });
    expect(() => store.transaction(() => settings.mutate({ kind: "add", item: favorite() }, 0n)))
      .toThrow("disabled");
  });

  it("fails closed on malformed current-v1 durable data", () => {
    const { store, settings } = setup();
    store.setSetting("service", "orchestrator", "settings.model_favorites", {
      format: 1,
      seeded: false,
      favorites: [{ ...favorite(), privateValue: "secret" }]
    });
    expect(() => settings.snapshot()).toThrow("invalid");
    expect(() => settings.mutate({ kind: "add", item: favorite("favorite-b") }, store.health().revision))
      .toThrow("invalid");
  });
});

function setup(path = ":memory:") {
  const store = new OperationalStore(path);
  stores.push(store);
  store.upsertBackend(backend());
  return { store, settings: new ModelFavoriteSettings(store) };
}

function favorite(favoriteId = "favorite-a"): ModelFavoriteConfiguration {
  return {
    favoriteId,
    backendId: "backend-a",
    providerId: "provider-a",
    modelId: "model-a",
    effortId: "low",
    fastMode: false
  };
}

function backend(): BackendDescriptor {
  return {
    id: "backend-a",
    adapterKind: "fixture",
    instanceGeneration: 1,
    displayName: "Backend A",
    version: "test",
    health: "healthy",
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    providers: [{
      providerId: "provider-a",
      displayName: "Provider A",
      api: "openai-responses",
      authenticationState: "authenticated",
      loginMethods: [],
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: false,
      supportsModelRefresh: false
    }],
    models: [
      {
        providerId: "provider-a", modelId: "model-a", displayName: "Model A", api: "openai-responses",
        contextWindow: 8192, maxOutputTokens: 1024, supportsImages: false, supportsFastMode: true,
        thinkingLevels: ["low", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      },
      {
        providerId: "provider-a", modelId: "model-b", displayName: "Model B", api: "openai-responses",
        contextWindow: 8192, maxOutputTokens: 1024, supportsImages: false,
        thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ],
    tools: [],
    diagnostics: []
  };
}
