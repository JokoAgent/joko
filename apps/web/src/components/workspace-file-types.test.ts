import { describe, expect, it } from "vitest";

import { isWorkspaceMarkdownPath } from "./workspace-file-types.js";

describe("workspace file type predicates", () => {
  it("accepts every supported Markdown extension and rejects lookalikes", () => {
    for (const path of ["a.md", "a.markdown", "a.mdown", "a.mkd", "a.mdx", "nested/A.MARKDOWN"]) {
      expect(isWorkspaceMarkdownPath(path)).toBe(true);
    }
    for (const path of ["a.md.txt", "markdown", ".md", "a.svg"]) {
      expect(isWorkspaceMarkdownPath(path)).toBe(false);
    }
  });
});
