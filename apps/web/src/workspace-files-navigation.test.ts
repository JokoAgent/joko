import { describe, expect, it } from "vitest";
import {
  parseWorkspaceFilesHash,
  workspaceFilesHash
} from "./workspace-files-navigation.js";
import { appRouteHash, routeFromHash } from "./controller.js";

describe("workspace files navigation", () => {
  it("round trips a session, selected file, and one-shot search anchor", () => {
    const hash = workspaceFilesHash({
      sessionId: "task / 一",
      file: "src/a b.ts",
      search: "needle + value",
      line: 42
    });
    expect(hash).toBe("#/files/task%20%2F%20%E4%B8%80?file=src%2Fa+b.ts&search=needle+%2B+value&line=42");
    expect(parseWorkspaceFilesHash(hash)).toEqual({
      sessionId: "task / 一",
      file: "src/a b.ts",
      search: "needle + value",
      line: 42
    });
    expect(routeFromHash(hash)).toEqual({
      kind: "files",
      sessionId: "task / 一",
      file: "src/a b.ts",
      search: "needle + value",
      line: 42
    });
    expect(appRouteHash({
      kind: "files",
      sessionId: "task / 一",
      file: "src/a b.ts",
      search: "needle + value",
      line: 42
    })).toBe(hash);
  });

  it("does not accept missing sessions or malformed line anchors", () => {
    expect(parseWorkspaceFilesHash("#/files")) .toBeUndefined();
    expect(parseWorkspaceFilesHash("#/tasks/session")) .toBeUndefined();
    expect(parseWorkspaceFilesHash("#/files/session?line=0")).toEqual({ sessionId: "session" });
    expect(parseWorkspaceFilesHash("#/files/session?line=1.5")).toEqual({ sessionId: "session" });
  });
});
