import { describe, expect, it, vi } from "vitest";

import {
  applyNewProcessPriority,
  recommendedToolchainThreads,
  toolchainThreadEnvironment
} from "./process-policy.js";

describe("runtime process policy", () => {
  it("computes half or quarter core caps and never overwrites user values", () => {
    expect(recommendedToolchainThreads("low", 9)).toBe(5);
    expect(recommendedToolchainThreads("lowest", 9)).toBe(3);
    expect(toolchainThreadEnvironment(
      { capToolchainThreads: true, processPriority: "low" },
      { VITEST_MAX_FORKS: "9", MAKEFLAGS: "--jobs=7" },
      { availableParallelism: 8, platform: "linux" }
    )).toEqual({ VITEST_MAX_THREADS: "4", CARGO_BUILD_JOBS: "4" });
  });

  it("treats existing Windows environment keys case-insensitively", () => {
    expect(toolchainThreadEnvironment(
      { capToolchainThreads: true, processPriority: "lowest" },
      { vitest_max_forks: "6" },
      { availableParallelism: 8, platform: "win32" }
    )).toEqual({ VITEST_MAX_THREADS: "2", CARGO_BUILD_JOBS: "2" });
  });

  it("applies lowering only to a newly spawned process and does not claim normal is a restoration", async () => {
    const setPriority = vi.fn();
    await expect(applyNewProcessPriority(42, "low", { setPriority, platform: "linux" })).resolves.toMatchObject({
      application: "applied",
      appliesToNewProcessesOnly: true
    });
    expect(setPriority).toHaveBeenCalledOnce();
    setPriority.mockClear();
    await expect(applyNewProcessPriority(42, "normal", { setPriority, platform: "linux" })).resolves.toEqual({
      requested: "normal",
      application: "not_requested",
      appliesToNewProcessesOnly: true,
      backgroundPolicyApplied: false
    });
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("reports permission refusal truthfully", async () => {
    await expect(applyNewProcessPriority(42, "lowest", {
      platform: "linux",
      setPriority() { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }
    })).resolves.toMatchObject({ application: "permission_denied" });
  });
});
