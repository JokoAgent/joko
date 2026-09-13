import type { BackendView } from "../model.js";
import { describe, expect, it } from "vitest";

import { resourceKindsForBackend, backendSupportsResourceDiscovery } from "../resource-capabilities.js";
import { backendPermissionModes } from "./SettingsPage.js";
import { planModeSupported } from "./backend-control-capabilities.js";

describe("Backend settings capabilities", () => {
  it("offers only permission modes advertised by the selected Backend", () => {
    const first = backend("first", ["ask", "auto"]);
    const second = backend("second", ["ask", "auto"]);

    expect(backendPermissionModes(first, "ask")).toEqual(["ask", "auto"]);
    expect(backendPermissionModes(second, "ask")).toEqual(["ask", "auto"]);
    expect(backendPermissionModes(first, "bypassPermissions")).toEqual([
      "bypassPermissions",
      "ask",
      "auto"
    ]);
  });

  it("keeps an unsupported persisted value visible but does not invent supported modes", () => {
    const value = backend("limited", ["planMode"], false);

    expect(backendPermissionModes(value, "auto")).toEqual(["auto"]);
    expect(planModeSupported(value)).toBe(false);
  });

  it("requires the dedicated Plan capability and rejects permission-option aliases", () => {
    expect(planModeSupported(backend("combined", ["ask", "planMode"]))).toBe(false);
    const base = backend("dedicated", ["ask"]);
    const dedicated: BackendView = {
      ...base,
      capabilities: new Map([...base.capabilities, ["plan_mode", capability([], true)]])
    };
    expect(planModeSupported(dedicated)).toBe(true);
  });

  it("offers only the managed resource kinds advertised by each Backend", () => {
    expect(resourceKindsForBackend(resourceBackend("claude", ["skill", "prompt"]))).toEqual([
      "skill",
      "prompt"
    ]);
    expect(resourceKindsForBackend(resourceBackend("pi", ["extension", "skill", "prompt", "package"]))).toEqual([
      "extension",
      "skill",
      "prompt",
      "package"
    ]);
    expect(resourceKindsForBackend(resourceBackend("empty", []))).toEqual([]);
    expect(resourceKindsForBackend(resourceBackend("disabled", ["skill"], false))).toEqual([]);
    expect(backendSupportsResourceDiscovery(resourceBackend("claude", ["skill", "prompt"]))).toBe(true);
    expect(backendSupportsResourceDiscovery(resourceBackend("unknown", ["theme-alias"]))).toBe(false);
  });
});

function backend(id: string, modes: readonly string[], supported = true): BackendView {
  return {
    id,
    name: id,
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["permission.modes", capability(modes, supported)]
    ])
  };
}

function capability(options: readonly string[], supported: boolean) {
  return {
    name: "fixture",
    supported,
    options
  } satisfies BackendView["capabilities"] extends ReadonlyMap<string, infer Value> ? Value : never;
}

function resourceBackend(id: string, kinds: readonly string[], supported = true): BackendView {
  return {
    id,
    name: id,
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["runtime.resources", capability(kinds, supported)]
    ])
  };
}
