import { describe, expect, it } from "vitest";

import {
  buildFirstObjectiveDirective,
  buildObjectiveContinuationDirective
} from "./objective-directive.js";

describe("Objective directives", () => {
  it("includes clarification and refinement only on the first turn", () => {
    const first = buildFirstObjectiveDirective("Finish the report", { maximumTurns: 4 });
    expect(first).toContain("Finish the report");
    expect(first).toContain("turn budget is 4");
    expect(first).toContain("refined_objective");

    const continuation = buildObjectiveContinuationDirective("Finish the report", "drafted outline");
    expect(continuation).toContain("drafted outline");
    expect(continuation).not.toContain("refined_objective");
  });
});
