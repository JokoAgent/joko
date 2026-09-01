import { describe, expect, it } from "vitest";
import { TOOL_PAYLOAD_DIFF_SCAN_LIMIT, toolPayloadDiffFiles } from "./tool-payload.js";

describe("tool payload diff discovery", () => {
  it("separates every file in a unified diff", () => {
    const files = toolPayloadDiffFiles([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      "+created"
    ].join("\n"));

    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]?.text).toContain("-old\n+new");
    expect(files[1]?.text).toContain("+created");
  });

  it("discovers structured old/new edits and patch envelopes", () => {
    const structured = toolPayloadDiffFiles(JSON.stringify({ changes: [
      { file_path: "src/a.ts", old_string: "before", new_string: "after" },
      { path: "src/b.ts", patch: "@@ -1 +1 @@\n-x\n+y" }
    ] }));
    expect(structured.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(structured[0]?.text).toBe("--- old\nbefore\n+++ new\nafter");

    const envelope = toolPayloadDiffFiles("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+new\n*** End Patch");
    expect(envelope.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("bounds structured discovery for very large opaque payloads", () => {
    const text = JSON.stringify({ path: "large.txt", patch: "x".repeat(1_048_576) });
    expect(text.length).toBeGreaterThan(1_048_576);
    expect(toolPayloadDiffFiles(text)).toEqual([]);

    const oversizedDiff = `diff --git a/a.ts b/a.ts\n${"x".repeat(TOOL_PAYLOAD_DIFF_SCAN_LIMIT)}`;
    expect(toolPayloadDiffFiles(oversizedDiff)).toEqual([]);
  });
});
