import { describe, expect, it } from "vitest";
import { projectCodexFileChanges } from "./file-change.js";

const sanitize = (value: string, limit: number): string => value.slice(0, limit);

describe("Codex file-change projection", () => {
  it("preserves ordered add, delete, update, and move identities with exact diffs", () => {
    const projected = projectCodexFileChanges([
      { path: "src/new.ts", kind: { type: "add" }, diff: "+new" },
      { path: "src/gone.ts", kind: { type: "delete" }, diff: "-gone" },
      { path: "src/edit.ts", kind: { type: "update" }, diff: "-old\n+new" },
      { path: "src/old.ts", kind: { type: "update", move_path: "src/moved.ts" }, diff: "" },
      { path: "src/one.ts", kind: { type: "update", movePath: "src/two.ts" }, diff: "rename" }
    ], sanitize);

    expect(JSON.parse(projected?.input ?? "null")).toEqual({ changes: [
      { path: "src/new.ts", kind: { type: "add" }, diff: "+new" },
      { path: "src/gone.ts", kind: { type: "delete" }, diff: "-gone" },
      { path: "src/edit.ts", kind: { type: "update" }, diff: "-old\n+new" },
      { path: "src/old.ts", kind: { type: "update", movePath: "src/moved.ts" }, diff: "" },
      { path: "src/one.ts", kind: { type: "update", movePath: "src/two.ts" }, diff: "rename" }
    ] });
    expect(projected?.summary).toBe([
      "add: src/new.ts",
      "delete: src/gone.ts",
      "update: src/edit.ts",
      "move: src/old.ts -> src/moved.ts",
      "move: src/one.ts -> src/two.ts"
    ].join("\n"));
  });

  it("rejects the whole structured projection when any identity is malformed or the payload is oversized", () => {
    expect(projectCodexFileChanges([
      { path: "src/ok.ts", kind: { type: "update" }, diff: "+ok" },
      { path: "", kind: { type: "update" }, diff: "+hidden" }
    ], sanitize)).toBeUndefined();
    expect(projectCodexFileChanges([
      { path: "src/old.ts", kind: { type: "update", move_path: 7 }, diff: "" }
    ], sanitize)).toBeUndefined();
    expect(projectCodexFileChanges([
      { path: "src/large.ts", kind: { type: "update" }, diff: "x".repeat(1_048_577) }
    ], sanitize)).toBeUndefined();
  });
});
