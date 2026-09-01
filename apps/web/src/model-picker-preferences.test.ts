// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addModelFavorite,
  isModelVisible,
  modelPreferenceOwnerId,
  providerPreferenceKey,
  readModelConfiguration,
  readModelPickerLayout,
  readModelPickerOwnerPreferences,
  removeModelFavorite,
  resetModelPickerPreferencesForTests,
  seedModelFavorite,
  setModelConfiguration,
  setModelPickerLayout,
  setModelVisible,
  setProviderDisplayOrder,
  updateModelFavorite
} from "./model-picker-preferences.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetModelPickerPreferencesForTests();
});

describe("model picker owner preferences", () => {
  it("persists Provider order per verified owner while retaining hidden slots", () => {
    const [first, hidden, second, added] = ["first", "hidden", "second", "new"].map((id) => providerPreferenceKey("backend", id));
    setProviderDisplayOrder("owner-a", [first!, hidden!, second!]);
    setProviderDisplayOrder("owner-a", [second!, first!]);
    setProviderDisplayOrder("owner-a", [added!, second!, first!]);

    expect(readModelPickerOwnerPreferences("owner-a").providerOrder)
      .toEqual([added, hidden, second, first]);
    expect(readModelPickerOwnerPreferences("owner-b").providerOrder).toEqual([]);
  });

  it("rejects malformed Provider reorder requests and malformed stored owner records", () => {
    const first = providerPreferenceKey("backend", "first");
    setProviderDisplayOrder("owner-a", [first, first]);
    expect(readModelPickerOwnerPreferences("owner-a").providerOrder).toEqual([]);

    window.localStorage.setItem("joko:model-picker-owner:v1:owner-a", JSON.stringify({
      version: 1,
      favorites: [],
      visibility: {},
      configurations: {},
      providerOrder: ["first", "", "first", "bad\n", "second"],
      seeded: false
    }));
    expect(readModelPickerOwnerPreferences("owner-a").providerOrder).toEqual([]);

    window.localStorage.setItem("joko:model-picker-owner:v1:owner-a", JSON.stringify({
      version: 2,
      favorites: [],
      visibility: {},
      configurations: {},
      providerOrder: [],
      seeded: false
    }));
    expect(readModelPickerOwnerPreferences("owner-a").providerOrder).toEqual([]);
  });

  it("partitions sparse visibility overrides by verified service owner", () => {
    expect(modelPreferenceOwnerId(" service-a ")).toBe("service-a");
    expect(modelPreferenceOwnerId(undefined)).toBeUndefined();
    expect(modelPreferenceOwnerId("")).toBeUndefined();

    setModelVisible("service-a", "backend-a", "provider", "model", false);
    const ownerA = readModelPickerOwnerPreferences("service-a");
    expect(isModelVisible(ownerA, "backend-a", "provider", "model")).toBe(false);
    expect(isModelVisible(ownerA, "backend-b", "provider", "model")).toBe(true);
    expect(isModelVisible(readModelPickerOwnerPreferences("service-b"), "backend-a", "provider", "model")).toBe(true);

    setModelVisible("service-a", "backend-a", "provider", "model", true);
    expect(readModelPickerOwnerPreferences("service-a").visibility).toEqual({});
  });

  it("stores favorites as independent configuration copies and deduplicates exact copies", () => {
    const first = addModelFavorite("service-a", {
      backendId: "backend",
      providerId: "provider",
      modelId: "reasoner",
      effort: "high"
    })!;
    const duplicate = addModelFavorite("service-a", {
      backendId: "backend",
      providerId: "provider",
      modelId: "reasoner",
      effort: "high"
    });
    const fast = addModelFavorite("service-a", {
      backendId: "backend",
      providerId: "provider",
      modelId: "reasoner",
      effort: "high",
      fast: true
    })!;

    expect(duplicate?.uid).toBe(first.uid);
    expect(readModelPickerOwnerPreferences("service-a").favorites).toEqual([first, fast]);
    updateModelFavorite("service-a", first.uid, { effort: "low", fast: true });
    expect(readModelPickerOwnerPreferences("service-a").favorites[0]).toMatchObject({
      uid: first.uid,
      effort: "low",
      fast: true
    });
    removeModelFavorite("service-a", fast.uid);
    expect(readModelPickerOwnerPreferences("service-a").favorites.map((item) => item.uid)).toEqual([first.uid]);
  });

  it("remembers non-selected row effort and Fast presets per service owner", () => {
    setModelConfiguration("service-a", "backend-a", "provider", "reasoner", { effort: "high", fast: true });
    expect(readModelConfiguration(readModelPickerOwnerPreferences("service-a"), "backend-a", "provider", "reasoner")).toEqual({
      effort: "high",
      fast: true
    });
    expect(readModelConfiguration(readModelPickerOwnerPreferences("service-a"), "backend-b", "provider", "reasoner")).toBeUndefined();
    expect(readModelConfiguration(readModelPickerOwnerPreferences("service-b"), "backend-a", "provider", "reasoner")).toBeUndefined();

    setModelConfiguration("service-a", "backend-a", "provider", "reasoner", {});
    expect(readModelPickerOwnerPreferences("service-a").configurations).toEqual({});
  });

  it("seeds once and never resurrects a recommendation after explicit removal", () => {
    const seeded = seedModelFavorite("service-a", { backendId: "backend", providerId: "provider", modelId: "default" })!;
    removeModelFavorite("service-a", seeded.uid);
    expect(readModelPickerOwnerPreferences("service-a")).toMatchObject({ favorites: [], seeded: true });
    expect(seedModelFavorite("service-a", { backendId: "backend", providerId: "provider", modelId: "default" })).toBeUndefined();
    expect(readModelPickerOwnerPreferences("service-a").favorites).toEqual([]);
  });

  it("reasserts a recent operation after a late cross-window overwrite", async () => {
    const favorite = addModelFavorite("service-a", { backendId: "backend", providerId: "provider", modelId: "model" })!;
    const storageKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .find((key) => key?.startsWith("joko:model-picker-owner:v1:"))!;
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      favorites: [],
      visibility: {},
      configurations: {},
      providerOrder: [],
      seeded: false
    }));
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey, storageArea: localStorage }));
    await Promise.resolve();
    expect(readModelPickerOwnerPreferences("service-a").favorites.map((item) => item.uid)).toContain(favorite.uid);
  });

  it("persists the three selector layouts with the original layout as default", () => {
    expect(readModelPickerLayout()).toBe("original");
    setModelPickerLayout("classic");
    expect(readModelPickerLayout()).toBe("classic");
    setModelPickerLayout("badge");
    expect(readModelPickerLayout()).toBe("badge");
    setModelPickerLayout("original");
    expect(readModelPickerLayout()).toBe("original");
  });

  it("keeps the current interaction usable when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked"); });

    setModelConfiguration("service-a", "backend", "provider", "model", { effort: "high", fast: true });
    expect(readModelConfiguration(readModelPickerOwnerPreferences("service-a"), "backend", "provider", "model")).toEqual({ effort: "high", fast: true });
    setModelPickerLayout("badge");
    expect(readModelPickerLayout()).toBe("badge");
  });
});
