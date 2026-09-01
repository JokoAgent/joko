import { describe, expect, it } from "vitest";

import type { SubagentRunView } from "../model.js";
import { buildSubagentTree, flattenSubagentTree } from "./subagent-tree.js";

const run = (id: string, parentSubagentRunId?: string, state: SubagentRunView["state"] = "completed", updatedAt = 1): SubagentRunView => ({
  id,
  sessionId: "session",
  ...(parentSubagentRunId === undefined ? {} : { parentSubagentRunId }),
  identityAliases: [],
  providerRunIds: [],
  state,
  title: id,
  capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true, stop: true, steer: true, followUp: true, resume: true, parentContext: "live" },
  startedAt: 1,
  updatedAt,
  revision: 1n
});

describe("delegated-run tree", () => {
  it("nests durable parent identities and keeps active runs first", () => {
    const tree = buildSubagentTree([
      run("old", undefined, "completed", 10),
      run("child", "root", "running", 20),
      run("root", undefined, "running", 15)
    ]);
    expect(tree.map((node) => node.run.id)).toEqual(["root", "old"]);
    expect(tree[0]?.children.map((node) => node.run.id)).toEqual(["child"]);
    expect(flattenSubagentTree(tree).map((node) => [node.run.id, node.depth])).toEqual([["root", 0], ["child", 1], ["old", 0]]);
  });

  it("renders malformed cycles once instead of losing the runs", () => {
    const flat = flattenSubagentTree(buildSubagentTree([run("a", "b"), run("b", "a")]));
    expect(new Set(flat.map((node) => node.run.id))).toEqual(new Set(["a", "b"]));
    expect(flat).toHaveLength(2);
  });

  it("builds and flattens deeply nested delegated runs without recursive stack growth", () => {
    const depth = 12_000;
    const runs = Array.from({ length: depth }, (_, index) => run(
      `run-${index}`,
      index === 0 ? undefined : `run-${index - 1}`,
      index === depth - 1 ? "running" : "completed",
      index
    ));
    const flat = flattenSubagentTree(buildSubagentTree(runs));
    expect(flat).toHaveLength(depth);
    expect(flat[0]?.run.id).toBe("run-0");
    expect(flat.at(-1)).toMatchObject({ run: { id: `run-${depth - 1}` }, depth: depth - 1 });
  });
});
