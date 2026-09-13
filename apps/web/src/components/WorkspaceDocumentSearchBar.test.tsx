import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceDocumentSearchBar } from "./WorkspaceDocumentSearchBar.js";

const labels = {
  search: "Find in file",
  placeholder: "Find",
  previous: "Previous match",
  next: "Next match",
  close: "Close find",
  truncated: "Results are truncated"
};

describe("WorkspaceDocumentSearchBar", () => {
  it("renders the stable document-search hook, count, and keyboard actions", () => {
    const markup = renderToStaticMarkup(<WorkspaceDocumentSearchBar
      query="needle"
      total={12}
      activeIndex={2}
      truncated
      labels={labels}
      onChange={vi.fn()}
      onPrevious={vi.fn()}
      onNext={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(markup).toContain("role=\"search\"");
    expect(markup).toContain("3/12+");
    expect(markup).toContain("Previous match");
    expect(markup).toContain("Next match");
    expect(markup).toContain("Close find");
  });

  it("disables navigation for zero matches without disabling close", () => {
    const markup = renderToStaticMarkup(<WorkspaceDocumentSearchBar
      query="missing"
      total={0}
      activeIndex={0}
      labels={labels}
      onChange={vi.fn()}
      onPrevious={vi.fn()}
      onNext={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(markup).toContain("0/0");
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
  });
});
