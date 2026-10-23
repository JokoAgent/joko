import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { BackendDescriptor, ProviderModel } from "@joko/core";
import { OperationalStore, ProviderGroupStore } from "@joko/store";
import { afterEach, expect, it } from "vitest";
import { ModelFavoriteSettings } from "./model-favorite-settings.js";
import { modelSourceCatalogModels, modelSourceFavoriteUnavailableReason, projectModelSource, type ModelSourceCatalogDependencies } from "./model-source-catalog.js";

const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const model = (id: string): ProviderModel => ({ providerId: "account", modelId: id, displayName: id, api: "test", contextWindow: 8000,
  maxOutputTokens: 1000, supportsImages: false, thinkingLevels: ["low", "high"], supportsFastMode: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const backend = (id: string): BackendDescriptor => ({ id, adapterKind: "native-fixture", displayName: id, instanceGeneration: 1,
  version: "test", health: "healthy", installationState: "installed", authenticationState: "not_required", capabilities: new Map(),
  providers: [{ providerId: "account", displayName: "Account", api: "test", authenticationState: "not_required", loginMethods: [],
    supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false }], models: [model("old")], tools: [], diagnostics: [] });
function fixture() {
  const store = new OperationalStore(":memory:"); stores.push(store); store.upsertBackend(backend("owner")); store.upsertBackend(backend("opaque-remote"));
  const groups = new ProviderGroupStore(store, "node"); let online = true;
  const dependencies: ModelSourceCatalogDependencies = { store,
    hostedAgentSources: { modelAvailable: id => id === "opaque-remote" ? online : undefined,
      groupCatalog: () => [{ backendId: "opaque-remote", source: { controllerDeviceId: "controller", targetDeviceId: "other-device", backendId: "original-runtime" },
        name: "Studio", available: online, catalog: create(contract.HostedAgentBackendCatalogSchema, { backendId: "original-runtime", nodeId: "original-node", nativeAdapterKind: "native-fixture",
          providers: [{ providerId: "account", displayName: "Account", connected: true, remoteInvocationEnabled: true }] }) }] },
    providerGroups: { store: groups, sharedProvider: (id, providerId) => groups.snapshot({ backendId: id, providerId }).config
      ? { models: online ? [model("remote-only")] : [], catalog: create(contract.HostedAgentBackendCatalogSchema), assertCurrent() {} } : undefined } };
  const favoriteSettings = new ModelFavoriteSettings(store, { models: backend => modelSourceCatalogModels(dependencies, backend),
    unavailableReason: (...args) => modelSourceFavoriteUnavailableReason(dependencies, ...args) });
  return { store, groups, dependencies, favoriteSettings, offline: () => { online = false; } };
}
it("projects authenticated source identity without interpreting an opaque Backend identifier", () => {
  const f = fixture(); const value = projectModelSource(f.dependencies, create(contract.ModelDescriptorSchema, { backendId: "opaque-remote", key: { providerId: "account", modelId: "old" }, available: true }));
  expect(value.source).toMatchObject({ kind: contract.ModelSourceKind.DEVICE, nodeId: "original-node", nodeName: "Studio", nativeAdapterKind: "native-fixture", grouped: false });
  expect(value.source).not.toHaveProperty("source"); f.offline(); expect(projectModelSource(f.dependencies, value).available).toBe(false);
});
it("offers one group source, replaces the anchor catalog with the live union, and retains grouped favorite copies", () => {
  const f = fixture();
  const item = { favoriteId: "remote-favorite", backendId: "opaque-remote", providerId: "account", modelId: "old", fastMode: false };
  f.store.transaction(() => f.favoriteSettings.mutate({ kind: "add", item }, 0n));
  f.groups.update({ backendId: "owner", providerId: "account" }, { strategy: "least_busy", autoSwitch: true, members: [
    { key: "remote-member", kind: "device", backendId: "opaque-remote", nativeBackendId: "original-runtime", nodeId: "original-node", providerId: "account", displayName: "Studio", capacity: 4, weight: 1, paused: false }
  ] }, 0n);
  const descriptor = create(contract.ModelDescriptorSchema, { backendId: "owner", key: { providerId: "account", modelId: "remote-only" }, available: false });
  expect(modelSourceCatalogModels(f.dependencies, backend("owner")).map(model => model.modelId)).toEqual(["remote-only"]);
  expect(projectModelSource(f.dependencies, descriptor)).toMatchObject({ available: true, source: { kind: contract.ModelSourceKind.GROUP, groupMemberCount: 1 } });
  expect(projectModelSource(f.dependencies, create(contract.ModelDescriptorSchema, { backendId: "opaque-remote", key: { providerId: "account", modelId: "old" }, available: true })).source?.grouped).toBe(true);
  expect(f.favoriteSettings.snapshot().favorites).toEqual([item]);
  expect(() => f.store.transaction(() => f.favoriteSettings.mutate({ kind: "replace", item: { ...item, fastMode: true } }, f.favoriteSettings.snapshot().revision))).toThrow("Provider group");
  f.store.upsertBackend({ ...backend("owner"), health: "unavailable", authenticationState: "signed_out" });
  f.store.transaction(() => f.favoriteSettings.mutate({ kind: "add", item: { ...item, favoriteId: "group-favorite", backendId: "owner", modelId: "remote-only" } }, f.favoriteSettings.snapshot().revision));
  f.offline(); expect(modelSourceCatalogModels(f.dependencies, backend("owner"))).toEqual([]);
  expect(projectModelSource(f.dependencies, descriptor).available).toBe(false);
  expect(f.favoriteSettings.snapshot().favorites).toHaveLength(2);
});
