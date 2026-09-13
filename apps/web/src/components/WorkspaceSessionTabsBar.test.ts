import { describe, expect, it } from "vitest";
import { workspaceSessionTabNeighbor } from "./WorkspaceSessionTabsBar.js";

describe("workspaceSessionTabNeighbor", () => {
  const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }] as const;

  it("chooses a visible neighbor and rejects a lone or stale tab", () => {
    expect(workspaceSessionTabNeighbor(sessions, "b")).toBe("c");
    expect(workspaceSessionTabNeighbor(sessions, "c")).toBe("b");
    expect(workspaceSessionTabNeighbor([{ id: "only" }], "only")).toBeUndefined();
    expect(workspaceSessionTabNeighbor(sessions, "missing")).toBeUndefined();
  });
});
