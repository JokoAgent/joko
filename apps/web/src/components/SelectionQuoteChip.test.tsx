import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectionQuoteChip } from "./SelectionQuoteChip.js";

describe("selected-text quote chip accessibility", () => {
  it("renders sent quote text as inert escaped content", () => {
    const markup = renderToStaticMarkup(<SelectionQuoteChip quote={{ kind: "message", text: '<script>alert("x")</script>\nnext' }} />);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<button");
  });

  it("uses an inert single-line chip without a close button in the composer", () => {
    const markup = renderToStaticMarkup(<SelectionQuoteChip quote={{ kind: "message", text: "selected text" }} selected />);
    expect(markup).toContain('aria-label="selected text"');
    expect(markup).toContain("selected text");
    expect(markup).not.toContain("<button");
  });

  it("shows a file basename and closed line range in the single-line chip", () => {
    const markup = renderToStaticMarkup(<SelectionQuoteChip quote={{
      kind: "file",
      text: "  selected source",
      sourcePath: "src/features/example.ts",
      startLine: 12,
      endLine: 18
    }} />);
    expect(markup).toContain("example.ts:L12-L18 · selected source");
    expect(markup).not.toContain("src/features/example.ts");
  });
});
