import { describe, expect, it } from "vitest";

import {
  SkillMutationCoordinator,
  skillInstallSlotMutationKey,
  skillResourceMutationKey
} from "./skill-mutation-coordinator.js";

describe("SkillMutationCoordinator", () => {
  it("fails fast for overlapping resource or install-slot ownership and releases idempotently", () => {
    const coordinator = new SkillMutationCoordinator();
    const resource = skillResourceMutationKey("resource-a");
    const slot = skillInstallSlotMutationKey({
      backendId: "backend-a",
      scope: "project",
      targetId: "target-a",
      parentKey: ".agents/skills",
      name: "Writer"
    });
    const first = coordinator.acquire([slot, resource]);
    expect(first).toBeDefined();
    expect(coordinator.acquire([resource])).toBeUndefined();
    expect(coordinator.acquire([slot.toUpperCase()])).toBeUndefined();
    expect(coordinator.acquire([skillResourceMutationKey("resource-b")])).toBeDefined();

    first!.release();
    first!.release();
    expect(() => first!.assertActive()).toThrow(/no longer active/i);
    expect(coordinator.acquire([resource, slot])).toBeDefined();
  });
});
