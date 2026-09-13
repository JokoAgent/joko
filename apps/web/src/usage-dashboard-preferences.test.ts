// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  readUsageDashboardPreference,
  resetUsageDashboardPreferencesForTests,
  setUsageDashboardCollapsed,
  setUsageDashboardEnabled
} from "./usage-dashboard-preferences.js";

beforeEach(() => resetUsageDashboardPreferencesForTests());

describe("usage dashboard preferences", () => {
  it("defaults enabled and expanded while isolating every owner", () => {
    expect(readUsageDashboardPreference("owner-a")).toEqual({ enabled: true, collapsed: false });

    setUsageDashboardCollapsed("owner-a", true);
    setUsageDashboardEnabled("owner-a", false);

    expect(readUsageDashboardPreference("owner-a")).toEqual({ enabled: false, collapsed: true });
    expect(readUsageDashboardPreference("owner-b")).toEqual({ enabled: true, collapsed: false });
  });

  it("survives an in-memory reset through the owner's local record", () => {
    setUsageDashboardCollapsed("owner-a", true);
    expect(window.localStorage.getItem("joko:usage-dashboard:v1:owner-a")).toContain('"collapsed":true');
    expect(readUsageDashboardPreference(undefined)).toEqual({ enabled: true, collapsed: false });

    window.localStorage.setItem("joko:usage-dashboard:v1:owner-b", JSON.stringify({ enabled: false }));
    expect(readUsageDashboardPreference("owner-b")).toEqual({ enabled: true, collapsed: false });
  });
});
