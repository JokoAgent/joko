import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAV_SECTION_IDS,
  activeRemoteConnections,
  availableSettingsSectionFromHash,
  logoutCurrentClient,
  logoutEligibleRemoteConnections,
  settingsSectionFromHash,
  settingsSubsectionFromHash
} from "./components/SettingsPage.js";
import type { RemoteConnectionView } from "./model.js";

describe("settings section navigation", () => {
  it("deep-links only the compact first-level information architecture", () => {
    expect(SETTINGS_NAV_SECTION_IDS).toEqual([
      "general", "personalization", "providers", "voice", "shortcuts", "taskStatus", "import",
      "connections", "tools", "automation", "about"
    ]);
    for (const section of SETTINGS_NAV_SECTION_IDS) {
      expect(settingsSectionFromHash(`#/settings/${section}`)).toBe(section);
    }
    expect(settingsSectionFromHash("#/settings")).toBe("general");
    expect(settingsSectionFromHash("#/settings/unknown")).toBe("general");
    expect(settingsSectionFromHash("#/tools/browser")).toBe("general");
    for (const removedFirstLevelSection of [
      "appearance", "backends", "credentials", "policy", "remoteHosts", "mcp", "pi", "diagnostics"
    ]) expect(settingsSectionFromHash(`#/settings/${removedFirstLevelSection}`)).toBe("general");
    expect(availableSettingsSectionFromHash("#/settings/taskStatus", false)).toBe("general");
    expect(availableSettingsSectionFromHash("#/settings/taskStatus", true)).toBe("taskStatus");
  });

  it("keeps merged capabilities directly addressable as canonical subsections", () => {
    for (const [parent, child] of [
      ["general", "appearance"],
      ["general", "policy"],
      ["general", "pi"],
      ["about", "backends"],
      ["providers", "credentials"],
      ["connections", "remoteHosts"],
      ["tools", "mcp"],
      ["about", "diagnostics"],
      ["about", "runtime"]
    ] as const) {
      const hash = `#/settings/${parent}/${child}`;
      expect(settingsSectionFromHash(hash)).toBe(parent);
      expect(settingsSubsectionFromHash(hash)).toBe(child);
    }
    expect(settingsSubsectionFromHash("#/settings/general/credentials")).toBeUndefined();
    expect(settingsSubsectionFromHash("#/settings/general/unknown")).toBeUndefined();
    expect(settingsSubsectionFromHash("#/settings/general/appearance/extra")).toBeUndefined();
  });

});

describe("remote connection actions", () => {
  it("keeps revoked connection history out of active controls", () => {
    const connections: RemoteConnectionView[] = [
      { id: "revoked-one", deviceId: "desktop", name: "Desktop local instance", state: "revoked" },
      { id: "active", deviceId: "desktop", name: "Desktop local instance", state: "connected" },
      { id: "revoked-two", deviceId: "desktop", name: "Desktop local instance", state: "revoked" }
    ];
    expect(activeRemoteConnections(connections)).toEqual([connections[1]]);
    expect(logoutEligibleRemoteConnections(connections, "active")).toEqual([]);
    expect(logoutEligibleRemoteConnections(connections, "current-elsewhere")).toEqual([connections[1]]);
  });

  it("delegates current logout to the controller's managed lifecycle", async () => {
    const calls: string[] = [];
    await logoutCurrentClient({ logoutProfile: async (id) => { calls.push(`logout-profile:${id}`); } }, "current");
    expect(calls).toEqual(["logout-profile:current"]);
  });

  it("surfaces controller logout failure without attempting a second cleanup path", async () => {
    const calls: string[] = [];
    await expect(logoutCurrentClient({
      logoutProfile: async (id) => {
        calls.push(`logout-profile:${id}`);
        throw new Error("offline");
      }
    }, "current")).rejects.toThrow("offline");
    expect(calls).toEqual(["logout-profile:current"]);
  });
});
