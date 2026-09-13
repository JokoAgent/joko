import { describe, expect, it } from "vitest";
import type { BackendView, CapabilityView } from "../model.js";
import {
  advertisedPermissionModes,
  advertisedQueueDeliveryModes,
  permissionChangeSupported,
  planModeSupported
} from "./backend-control-capabilities.js";

describe("Backend control capabilities", () => {
  it("fails closed when a supported permission capability omits its option catalog", () => {
    const candidate = backend({
      "permission.modes": capability(),
      "permission.change": capability()
    });

    expect(advertisedPermissionModes(candidate)).toEqual([]);
    expect(permissionChangeSupported(candidate)).toBe(false);
  });

  it("uses the manifest rather than Backend identity for permission and plan controls", () => {
    const capabilities = {
      "permission.modes": capability(["auto", "future-mode", "ask"]),
      "permission.change": capability(),
      plan_mode: capability()
    };
    const first = backend(capabilities, "backend-one");
    const second = backend(capabilities, "backend-two");

    expect(advertisedPermissionModes(first)).toEqual(["ask", "auto"]);
    expect(advertisedPermissionModes(second)).toEqual(["ask", "auto"]);
    expect(permissionChangeSupported(first)).toBe(true);
    expect(permissionChangeSupported(second)).toBe(true);
    expect(planModeSupported(first)).toBe(true);
    expect(planModeSupported(second)).toBe(true);
  });

  it("does not infer plan mode from a permission option", () => {
    const candidate = backend({
      "permission.modes": capability(["ask", "planMode"]),
      "permission.change": capability()
    });

    expect(planModeSupported(candidate)).toBe(false);
  });

  it("advertises only queue delivery modes supported by the manifest", () => {
    expect(advertisedQueueDeliveryModes(backend({
      "input.text": capability(),
      "turn.follow_up": capability(),
      "turn.steer": { ...capability(), supported: false }
    }))).toEqual(["prompt", "followUp"]);
    expect(advertisedQueueDeliveryModes(backend({}))).toEqual([]);
  });
});

function backend(
  capabilities: Readonly<Record<string, CapabilityView>>,
  id = "backend"
): BackendView {
  return {
    id,
    name: id,
    version: "1",
    health: "healthy",
    capabilities: new Map(Object.entries(capabilities))
  };
}

function capability(options: readonly string[] = []): CapabilityView {
  return { name: "capability", supported: true, options };
}
