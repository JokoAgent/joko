import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { timelineExportScale, timelineMathToLatex } from "./TimelineCopyAsImageBlock.js";
import { StreamingMarkdown } from "./Timeline.js";
import { isLooseTimelineInlineMath, normalizeTimelineMathDelimiters } from "./timeline-markdown-math.js";
import { repairTimelineMermaidSource } from "./timeline-mermaid-autofix.js";
import type { Translator } from "./types.js";

describe("timeline Markdown behavior", () => {
  it("normalizes parenthesized and display LaTeX delimiters", () => {
    expect(normalizeTimelineMathDelimiters("Energy \\(E=mc^2\\)."))
      .toBe("Energy $E=mc^2$.");
    expect(normalizeTimelineMathDelimiters("Before\\[x^2\\]After"))
      .toBe("Before\n\n$$\nx^2\n$$\n\nAfter");
  });

  it("preserves code fences, inline code, links, empty and unfinished delimiters", () => {
    const input = [
      "`\\(code\\)` and \\(math\\)",
      "[target](./run\\(1\\).md)",
      "\\(\\) \\(unfinished",
      "```md",
      "\\[raw\\]",
      "```"
    ].join("\n");
    expect(normalizeTimelineMathDelimiters(input)).toBe([
      "`\\(code\\)` and $math$",
      "[target](./run\\(1\\).md)",
      "\\(\\) \\(unfinished",
      "```md",
      "\\[raw\\]",
      "```"
    ].join("\n"));
  });

  it("rejects remark-math's loose currency and cross-code pairings", () => {
    expect(isLooseTimelineInlineMath("$5 and $", "1")).toBe(true);
    expect(isLooseTimelineInlineMath("$ x $", " ")).toBe(true);
    expect(isLooseTimelineInlineMath("$`code`$", " ")).toBe(true);
    expect(isLooseTimelineInlineMath("$E=mc^2$", ".")).toBe(false);
  });

  it("renders accepted formulas through KaTeX while leaving currency prose literal", () => {
    const t = ((key: string) => key) as Translator;
    const html = renderToStaticMarkup(createElement(StreamingMarkdown, {
      text: "Formula \\(E=mc^2\\); prices range from $5 and $10.",
      streaming: false,
      t
    }));
    expect(html).toContain('class="katex"');
    expect(html).toContain("prices range from $5 and $10.");
  });

  it("retries only deterministic Mermaid repairs without changing quoted labels", () => {
    expect(repairTimelineMermaidSource("flowchart TD\n// note\nsubgraph G[Title]\nA[x:y] → B"))
      .toBe("flowchart TD\n%% note\nsubgraph G [Title]\nA[\"x:y\"] --> B");
    expect(repairTimelineMermaidSource("sequenceDiagram\nA->>B: label → stays"))
      .toBe("sequenceDiagram\nA->>B: label → stays");
  });

  it("bounds copy-as-image output by edge and total pixel budgets", () => {
    expect(timelineExportScale(400, 200)).toBe(2);
    expect(timelineExportScale(8_192, 256)).toBeLessThanOrEqual(.5);
    expect(8_000 * 8_000 * timelineExportScale(8_000, 8_000) ** 2).toBeLessThanOrEqual(4_096 ** 2);
    expect(timelineExportScale(0, 10)).toBe(1);
  });

  it("recovers KaTeX source for the text/plain clipboard representation", () => {
    const node = {
      querySelector: () => ({ textContent: "  E=mc^2  " })
    } as unknown as HTMLElement;
    expect(timelineMathToLatex(node)).toBe("$$\nE=mc^2\n$$");
  });
});
