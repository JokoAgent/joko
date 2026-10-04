import { describe, expect, it } from "vitest";
import { parseToolFileChangeSet } from "./tool-file-change.js";

describe("tool file-change display identity", () => {
  it("preserves ordered multi-file actions and both sides of a move", () => {
    expect(parseToolFileChangeSet("file_change", JSON.stringify({ changes: [
      { path: "src/new.ts", kind: { type: "add" }, diff: "+new" },
      { path: "src/gone.ts", kind: { type: "delete" }, diff: "-gone" },
      { path: "src/edit.ts", kind: { type: "update" }, diff: "-old\n+new" },
      { path: "src/old.ts", kind: { type: "update", movePath: "src/moved.ts" }, diff: "rename" }
    ] }))).toEqual({ changes: [
      { id: '[0,"src/new.ts",""]', action: "created", path: "src/new.ts", diff: "+new" },
      { id: '[1,"src/gone.ts",""]', action: "deleted", path: "src/gone.ts", diff: "-gone" },
      { id: '[2,"src/edit.ts",""]', action: "updated", path: "src/edit.ts", diff: "-old\n+new" },
      { id: '[3,"src/old.ts","src/moved.ts"]', action: "moved", path: "src/old.ts", movePath: "src/moved.ts", diff: "rename" }
    ] });
  });

  it("fails the whole set closed for another tool, malformed JSON, or one invalid member", () => {
    const payload = JSON.stringify({ changes: [
      { path: "src/ok.ts", kind: { type: "update" }, diff: "+ok" },
      { path: "", kind: { type: "update" }, diff: "+hidden" }
    ] });
    expect(parseToolFileChangeSet("other", payload)).toBeUndefined();
    expect(parseToolFileChangeSet("file_change", "{broken")).toBeUndefined();
    expect(parseToolFileChangeSet("file_change", payload)).toBeUndefined();
  });
});
