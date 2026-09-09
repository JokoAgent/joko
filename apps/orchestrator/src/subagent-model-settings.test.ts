import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { BackendModelAccessUpdateSchema } from "@joko/contracts";
import type { BackendDescriptor } from "@joko/core";
import { OperationalStore, RevisionConflictError } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { writeBackendModelAccess } from "./backend-model-access.js";
import {
  SUBAGENT_DEFAULT_MODEL_CAPABILITY,
  SubagentModelSettings,
  subagentModelSettingKey,
  type SubagentModelSelection
} from "./subagent-model-settings.js";

const stores: OperationalStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SubagentModelSettings", () => {
  it("uses capability-owned rows and a native default without writing initial settings", () => {
    const { store, settings } = setup();
    store.upsertBackend(backend({ id: "backend-other", capabilities: new Map() }));
    expect(settings.snapshot()).toEqual([{
      backendId: "backend-a", available: true, unavailableReason: "", revision: 0n
    }]);
    expect(settings.resolve("backend-a", "provider-a")).toBeUndefined();
    expect(store.listSettings()).toEqual([]);
    expect(() => settings.replace("backend-other", selection(), 0n)).toThrow(RangeError);
    expect(() => settings.replace("missing", undefined, 0n)).toThrow(RangeError);
  });

  it("persists only the choice, rolls back with its operation, and keeps reset CAS after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-subagent-settings-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const { store, settings } = setup(path);
    store.transaction(() => settings.replace("backend-a", selection(), 0n));
    const saved = settings.snapshot()[0]!;
    expect(store.getSetting("service", "orchestrator", subagentModelSettingKey("backend-a")).value)
      .toEqual({ format: 1, model: selection() });
    expect(() => store.transaction(() => {
      settings.replace("backend-a", selection("model-b"), saved.revision);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(settings.snapshot()[0]).toEqual(saved);
    store.transaction(() => settings.replace("backend-a", undefined, saved.revision));
    const reset = settings.snapshot()[0]!;
    expect(reset.model).toBeUndefined();
    expect(reset.revision).toBeGreaterThan(saved.revision);
    expect(store.getSetting("service", "orchestrator", subagentModelSettingKey("backend-a")).value)
      .toEqual({ format: 1, model: null });
    store.close();
    const reopenedStore = new OperationalStore(path);
    stores.push(reopenedStore);
    const reopened = new SubagentModelSettings({ store: reopenedStore });
    expect(reopened.snapshot()[0]).toEqual(reset);
    expect(() => reopenedStore.transaction(() => reopened.replace("backend-a", selection(), 0n)))
      .toThrow(RevisionConflictError);
    expect(() => reopened.replace("backend-a", selection(), saved.revision)).toThrow(RevisionConflictError);
    reopenedStore.transaction(() => reopened.replace("backend-a", selection("model-b"), reset.revision));
    expect(reopened.resolve("backend-a", "provider-a")).toBe("model-b");
  });

  it("resolves each new runtime against the parent's current copy regardless of selection source", () => {
    const { store, settings } = setup();
    settings.replace("backend-a", selection(), 0n);
    expect(settings.resolve("backend-a", "provider-b")).toBe("model-a");
    const captured = settings.resolve("backend-a", "provider-b");
    disable(store, "provider-b", "model-a");
    expect(settings.resolve("backend-a", "provider-b")).toBeUndefined();
    expect(settings.resolve("backend-a", "provider-a")).toBe("model-a");
    expect(captured).toBe("model-a");
    disable(store, "provider-b", "model-a", true);
    disable(store, "provider-a");
    expect(settings.snapshot()[0]).toMatchObject({ model: selection(), available: false });
    expect(settings.resolve("backend-a", "provider-b")).toBe("model-a");
    expect(settings.resolve("backend-a", "provider-a")).toBeUndefined();
    expect(settings.resolve("backend-a", "unrelated-provider")).toBeUndefined();
    store.upsertBackend(backend({ models: backend().models.filter((model) => model.providerId === "provider-b") }));
    expect(settings.resolve("backend-a", "provider-b")).toBe("model-a");
    expect(settings.snapshot()[0]?.unavailableReason).toContain("native subagent default");
  });

  it.each([
    ["capability withdrawn", { capabilities: new Map() }],
    ["runtime unavailable", { health: "unavailable" }],
    ["runtime uninstalled", { installationState: "not_installed" }],
    ["backend signed out", { authenticationState: "signed_out" }],
    ["provider expired", { providers: backend().providers!.map((provider) => ({ ...provider, authenticationState: "expired" as const })) }],
    ["provider missing", { providers: [] }],
    ["models missing", { models: [] }],
    ["ambiguous model", { models: [...backend().models, backend().models[0]!] }]
  ] satisfies readonly (readonly [string, Partial<BackendDescriptor>])[])(
    "keeps saved identities visible and rejects dispatch and new selection when %s", (_name, patch) => {
      const { store, settings } = setup();
      settings.replace("backend-a", selection(), 0n);
      const revision = settings.snapshot()[0]!.revision;
      store.upsertBackend(backend(patch));
      expect(settings.snapshot()[0]).toMatchObject({ backendId: "backend-a", model: selection(), available: false, revision });
      expect(settings.resolve("backend-a", "provider-a")).toBeUndefined();
      expect(() => settings.replace("backend-a", selection(), revision)).toThrow(RangeError);
      settings.replace("backend-a", undefined, revision);
      expect(settings.snapshot()[0]?.model).toBeUndefined();
    }
  );

  it("checks current routing and backend enablement during save and resolve", () => {
    const { store, settings } = setup();
    disable(store, "provider-a", "model-a");
    expect(() => settings.replace("backend-a", selection(), 0n)).toThrow("disabled");
    settings.replace("backend-a", selection("model-b"), 0n);
    store.setSetting("service", "orchestrator", "settings.backend.backend-a", { enabled: false });
    const saved = settings.snapshot()[0]!;
    expect(saved).toMatchObject({ available: false, model: selection("model-b") });
    expect(settings.resolve("backend-a", "provider-a")).toBeUndefined();
    expect(() => settings.replace("backend-a", selection("model-b"), saved.revision)).toThrow("disabled");
    settings.replace("backend-a", undefined, saved.revision);
  });

  it("rejects malformed choices and does not expose or route partial malformed stored values", () => {
    const { store, settings } = setup();
    for (const model of [null, {}, { ...selection(), extra: true }, selection(" leading-space"), { ...selection(), providerId: "" }]) {
      expect(() => settings.replace("backend-a", model as SubagentModelSelection, 0n)).toThrow(RangeError);
    }
    expect(() => settings.replace(" backend-a", selection(), 0n)).toThrow(RangeError);
    for (const invalid of [
      { format: 1, model: { ...selection(), privateValue: "private-secret" } },
      { format: 1, model: selection(), privateValue: "private-secret" },
      { format: 1, model: { providerId: "provider-a" } },
      { format: 1 }
    ]) {
      store.setSetting("service", "orchestrator", subagentModelSettingKey("backend-a"), invalid);
      const snapshot = settings.snapshot()[0]!;
      expect(snapshot).toMatchObject({ available: false });
      expect(snapshot.model).toBeUndefined();
      expect(snapshot.unavailableReason).toContain("settings are invalid");
      expect(settings.resolve("backend-a", "provider-a")).toBeUndefined();
      expect(JSON.stringify(snapshot, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value))
        .not.toContain("private-secret");
      settings.replace("backend-a", undefined, snapshot.revision);
      expect(settings.snapshot()[0]).toMatchObject({ available: true });
    }
  });

  it("retains a saved unavailable backend row until it can be explicitly reset", () => {
    const { store, settings } = setup();
    const record = store.setSetting("service", "orchestrator", subagentModelSettingKey("backend-absent"), {
      format: 1, model: selection()
    });
    expect(settings.snapshot().find((row) => row.backendId === "backend-absent"))
      .toMatchObject({ model: selection(), available: false, revision: record.revision });
    expect(settings.resolve("backend-absent", "provider-a")).toBeUndefined();
    settings.replace("backend-absent", undefined, record.revision);
    expect(settings.snapshot().find((row) => row.backendId === "backend-absent"))
      .toMatchObject({ available: false });
  });
});

function setup(path = ":memory:") {
  const store = new OperationalStore(path);
  stores.push(store);
  store.upsertBackend(backend());
  return { store, settings: new SubagentModelSettings({ store }) };
}

function selection(modelId = "model-a"): SubagentModelSelection {
  return { providerId: "provider-a", modelId };
}

function backend(patch: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    id: "backend-a", adapterKind: "fixture", instanceGeneration: 1, displayName: "Backend A", version: "test",
    health: "healthy", installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map([[SUBAGENT_DEFAULT_MODEL_CAPABILITY, { key: SUBAGENT_DEFAULT_MODEL_CAPABILITY, supported: true }]]),
    providers: ["provider-a", "provider-b"].map((providerId) => ({
      providerId, displayName: providerId, api: "anthropic-messages", authenticationState: "authenticated",
      loginMethods: [], supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false
    })),
    models: ["provider-a", "provider-b"].flatMap((providerId) => ["model-a", "model-b"].map((modelId) => ({
      providerId, modelId, displayName: modelId, api: "anthropic-messages", contextWindow: 8192,
      maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))),
    tools: [], diagnostics: [], ...patch
  };
}

function disable(store: OperationalStore, providerId: string, modelId?: string, enabled = false): void {
  writeBackendModelAccess(store, "backend-a", create(BackendModelAccessUpdateSchema, {
    providerId, ...(modelId === undefined ? {} : { modelId }), enabled
  }));
}
