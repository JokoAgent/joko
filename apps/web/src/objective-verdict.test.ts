import { describe, expect, it } from "vitest";

import { stripObjectiveVerdict } from "./objective-verdict.js";

describe("Objective verdict presentation", () => {
  it("removes only complete trailing current-v1 verdict blocks", () => {
    expect(stripObjectiveVerdict("Finished.\n```json\n{\"goal_status\":\"complete\",\"reason\":\"done\"}\n```"))
      .toBe("Finished.");
    expect(stripObjectiveVerdict("Keep going\n{\"goal_status\":\"continue\"}"))
      .toBe("Keep going");
    expect(stripObjectiveVerdict("Before {\"goal_status\":\"example\"} after"))
      .toBe("Before {\"goal_status\":\"example\"} after");
    expect(stripObjectiveVerdict("Streaming\n{\"goal_status\":\"continue\""))
      .toBe("Streaming\n{\"goal_status\":\"continue\"");
  });

  it("does not add a legacy Objective setup reader", () => {
    const legacy = "Visible\n{\"goal_setup\":{\"maximum_turns\":20}}";
    expect(stripObjectiveVerdict(legacy)).toBe(legacy);
  });
});
