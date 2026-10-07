import { describe, expect, it } from "vitest";

import { parseObjectiveVerdict } from "./objective-verdict.js";

describe("parseObjectiveVerdict", () => {
  it("returns the last valid fenced verdict", () => {
    expect(parseObjectiveVerdict([
      '```json\n{"goal_status":"continue","reason":"earlier"}\n```',
      '```json\n{"goal_status":"complete","reason":"done"}\n```'
    ].join("\n"))).toEqual({ status: "complete", reason: "done" });
  });

  it("accepts a bare verdict and a non-empty refinement", () => {
    expect(parseObjectiveVerdict(
      'result {"goal_status":"continue","reason":"clear","refined_objective":"Ship the report"}'
    )).toEqual({ status: "continue", reason: "clear", refinedObjective: "Ship the report" });
  });

  it("does not infer an invalid or missing verdict", () => {
    expect(parseObjectiveVerdict('```json\n{"goal_status":"done","reason":"x"}\n```')).toBeUndefined();
    expect(parseObjectiveVerdict("Everything is finished.")).toBeUndefined();
  });
});
