import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_RESOURCE_SETTINGS,
  DEFAULT_COLLABORATION_SETTINGS,
  RuntimeGovernanceSettingsError,
  agentResourcePreset,
  validateAgentResourceSettings,
  validateCollaborationSettings
} from "./settings.js";

describe("runtime governance settings", () => {
  it("rejects invalid writes instead of silently changing intent", () => {
    expect(() => validateAgentResourceSettings({
      maxConcurrentCommands: -1,
      processPriority: "normal",
      capToolchainThreads: false
    })).toThrow(RuntimeGovernanceSettingsError);
    expect(() => validateCollaborationSettings({
      workerSoftLimit: 8,
      workerHardLimit: 7,
      workerIdleReleaseMinutes: 0
    })).toThrow(/workerHardLimit/u);
    expect(() => validateAgentResourceSettings({
      maxConcurrentCommands: 0,
      processPriority: "normal",
      capToolchainThreads: false,
      extra: true
    } as never)).toThrow(/current exact shape/u);
  });

  it("matches the three resource presets", () => {
    expect(agentResourcePreset("full", 12)).toEqual(DEFAULT_AGENT_RESOURCE_SETTINGS);
    expect(agentResourcePreset("balanced", 12)).toEqual({
      maxConcurrentCommands: 6,
      processPriority: "low",
      capToolchainThreads: true
    });
    expect(agentResourcePreset("background", 12)).toEqual({
      maxConcurrentCommands: 2,
      processPriority: "lowest",
      capToolchainThreads: true
    });
  });
});
