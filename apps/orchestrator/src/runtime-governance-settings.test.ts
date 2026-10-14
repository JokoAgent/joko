import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore, RevisionConflictError, SCHEMA_VERSION } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_RESOURCE_SETTING_KEY,
  COLLABORATION_SETTING_KEY,
  GIT_SAFETY_SETTING_KEY,
  RuntimeGovernanceSettingsRepository
} from "./runtime-governance-settings.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RuntimeGovernanceSettingsRepository", () => {
  it("uses existing-git by default and fences every explicit mode and reset by revision", () => {
    const store = new OperationalStore(":memory:");
    try {
      const repository = new RuntimeGovernanceSettingsRepository({ store });
      const initial = repository.gitSafetySnapshot();
      expect(initial.value).toEqual({ mode: "existing-git" });
      const changed = repository.updateGitSafety({ mode: "all-projects" }, initial.revision);
      expect(repository.updateGitSafety({ mode: "all-projects" }, changed.revision).revision).toBe(changed.revision);
      expect(() => repository.updateGitSafety({ mode: "off" }, initial.revision)).toThrow(RevisionConflictError);
      expect(repository.resetGitSafety(changed.revision).value).toEqual({ mode: "existing-git" });
    } finally { store.close(); }
  });

  it.each([
    { format: 1, autoSnapshotEnabled: true },
    { format: 1, mode: "existing-git", autoSnapshotEnabled: false },
    { format: 1, mode: "unknown" },
    { format: 1 },
    { format: 1, mode: false }
  ])("rejects a stored Git policy outside the exact current v1 mode shape", value => {
    const store = new OperationalStore(":memory:");
    try {
      store.setSetting("service", "orchestrator", GIT_SAFETY_SETTING_KEY, value);
      expect(() => new RuntimeGovernanceSettingsRepository({ store })).toThrow(/Git safety/iu);
    } finally { store.close(); }
  });

  it("persists every governance setting group on the current schema across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-runtime-governance-"));
    directories.push(directory);
    const path = join(directory, "operations.sqlite");
    let store = new OperationalStore(path);
    let repository = new RuntimeGovernanceSettingsRepository({ store, now: () => 1_000 });
    expect(store.health().schemaVersion).toBe(SCHEMA_VERSION);
    repository.updateAgentResource({ maxConcurrentCommands: 7, processPriority: "low", capToolchainThreads: true });
    repository.updateCollaboration({ workerSoftLimit: 3, workerHardLimit: 6, workerIdleReleaseMinutes: 15 });
    repository.updateGitSafety({ mode: "all-projects" });
    store.close();

    store = new OperationalStore(path);
    repository = new RuntimeGovernanceSettingsRepository({ store, now: () => 2_000 });
    expect(repository.snapshot()).toMatchObject({
      agentResource: { value: { maxConcurrentCommands: 7, processPriority: "low", capToolchainThreads: true } },
      collaboration: { value: { workerSoftLimit: 3, workerHardLimit: 6, workerIdleReleaseMinutes: 15 } },
      gitSafety: { value: { mode: "all-projects" } }
    });
    expect(store.health().schemaVersion).toBe(SCHEMA_VERSION);
    store.close();
  });

  it("rejects pre-existing settings that do not have the current encoded shape", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-runtime-governance-invalid-"));
    directories.push(directory);
    const store = new OperationalStore(join(directory, "operations.sqlite"));
    store.setSetting("service", "orchestrator", AGENT_RESOURCE_SETTING_KEY, {
      maxConcurrentCommands: 8,
      processPriority: "normal",
      capToolchainThreads: true
    });
    expect(() => new RuntimeGovernanceSettingsRepository({ store }))
      .toThrow(/stored agent resource settings are invalid/iu);
    store.close();
  });

  it("enforces revision fencing and does not bump a no-op update", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-runtime-governance-cas-"));
    directories.push(directory);
    const store = new OperationalStore(join(directory, "operations.sqlite"));
    const repository = new RuntimeGovernanceSettingsRepository({ store });
    const initial = repository.agentResourceSnapshot();
    const unchanged = repository.updateAgentResource({}, initial.revision);
    expect(unchanged.revision).toBe(initial.revision);
    const changed = repository.updateAgentResource({ maxConcurrentCommands: 2 }, initial.revision);
    expect(changed.revision).toBeGreaterThan(initial.revision);
    expect(() => repository.updateAgentResource({ maxConcurrentCommands: 3 }, initial.revision))
      .toThrow(RevisionConflictError);
    store.close();
  });
});
