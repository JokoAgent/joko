import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { BackendModelAccessUpdateSchema } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  backendModelAccessSettingKey,
  modelRoutingEnabled,
  providerRoutingEnabled,
  readBackendModelAccess,
  writeBackendModelAccess
} from "./backend-model-access.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];

afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("Backend model access", () => {
  it("persists Provider and model disables independently and removes empty state", () => {
    const store = createStore();
    writeBackendModelAccess(store, "backend-a", create(BackendModelAccessUpdateSchema, {
      providerId: "provider-a",
      enabled: false
    }));
    writeBackendModelAccess(store, "backend-a", create(BackendModelAccessUpdateSchema, {
      providerId: "provider-b",
      modelId: "model-b",
      enabled: false
    }));

    expect(providerRoutingEnabled(store, "backend-a", "provider-a")).toBe(false);
    expect(modelRoutingEnabled(store, "backend-a", "provider-a", "model-a")).toBe(false);
    expect(modelRoutingEnabled(store, "backend-a", "provider-b", "model-b")).toBe(false);
    expect(readBackendModelAccess(store, "backend-a")).toMatchObject({
      disabledProviderIds: ["provider-a"],
      disabledModels: [{ providerId: "provider-b", modelId: "model-b" }]
    });

    writeBackendModelAccess(store, "backend-a", create(BackendModelAccessUpdateSchema, {
      providerId: "provider-a",
      enabled: true
    }));
    expect(providerRoutingEnabled(store, "backend-a", "provider-a")).toBe(true);
    expect(modelRoutingEnabled(store, "backend-a", "provider-b", "model-b")).toBe(false);

    writeBackendModelAccess(store, "backend-a", create(BackendModelAccessUpdateSchema, {
      providerId: "provider-b",
      modelId: "model-b",
      enabled: true
    }));
    expect(store.findSetting("service", "orchestrator", backendModelAccessSettingKey("backend-a"))).toBeUndefined();
  });

  it("keeps Backend namespaces isolated", () => {
    const store = createStore();
    writeBackendModelAccess(store, "backend-a", create(BackendModelAccessUpdateSchema, {
      providerId: "provider",
      enabled: false
    }));

    expect(providerRoutingEnabled(store, "backend-a", "provider")).toBe(false);
    expect(providerRoutingEnabled(store, "backend-b", "provider")).toBe(true);
  });
});

function createStore(): OperationalStore {
  const root = mkdtempSync(join(tmpdir(), "joko-model-access-"));
  let now = 1_000;
  const store = new OperationalStore(join(root, "operational.sqlite"), { now: () => ++now });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}
