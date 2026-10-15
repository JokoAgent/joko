import { describe, expect, it } from "vitest";
import { developmentCommandProgress } from "./command-progress.js";

describe("personal command progress publication", () => {
  it("publishes recognized tool counters without exposing command output or fabricating an install percentage", () => {
    expect(developmentCommandProgress("Receiving objects:  42% (42/100)" )).toEqual({ stage: "Receiving objects", percent: 42 });
    expect(developmentCommandProgress("\u001b[32mProgress: resolved 42, reused 31, downloaded 11, added 17\u001b[0m")).toEqual({
      stage: "dependency-progress", dependencyProgress: { resolved: 42, reused: 31, downloaded: 11, added: 17 }
    });
    expect(developmentCommandProgress("token=https://private.invalid/?credential=secret")).toBeUndefined();
    expect(developmentCommandProgress("Progress: resolved 42, reused 31, downloaded 11, added 17 token=secret")).toBeUndefined();
    expect(developmentCommandProgress("Receiving objects: 101%")).toBeUndefined();
    expect(developmentCommandProgress("Progress: resolved 99999999999999999, reused 0, downloaded 0, added 0")).toBeUndefined();
  });
});
